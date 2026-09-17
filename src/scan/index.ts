// Turning a repository into a manifest of the external APIs it uses.
//
// Fully deterministic: no model is involved at any point in this stage.
//
// Scans are incremental. The manifest records a hash per file, and a later run
// only reparses what changed, which is what makes a scheduled run on a large
// repository cheap. Two things force a full reparse, because they can change
// the meaning of files that did not themselves change: a different set of
// repo-wide base-URL constants, and an edited dependency manifest.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { CallSite, Integration, Manifest } from "../types.ts";
import { debug } from "../log.ts";
import { collectBaseUrlConstants, extractHttpCallSites } from "./http.ts";
import { DEPENDENCY_MANIFESTS, scanSdkIntegrations } from "./sdk.ts";
import { languageOf, walkRepo, type Language } from "./walk.ts";

export type ScanOptions = {
  /** Previous manifest, for incremental reuse. */
  previous?: Manifest;
  /** Ignore the cache and reparse everything. */
  full?: boolean;
};

export type ScanResult = {
  manifest: Manifest;
  filesParsed: number;
  filesReused: number;
  /** Set when something forced a full reparse; useful in --verbose output. */
  fullReason?: string;
};

type SourceFile = { language: Language; text: string; hash: string };

export function scanRepo(config: Config, options: ScanOptions = {}): ScanResult {
  const { sourceFiles, specFiles } = walkRepo(config.root, config.ignore);
  const previous = options.previous;

  const sources = new Map<string, SourceFile>();
  for (const file of sourceFiles) {
    const language = languageOf(file);
    if (!language) continue;
    try {
      const text = fs.readFileSync(path.join(config.root, file), "utf8");
      sources.set(file, { language, text, hash: sha256(text) });
    } catch {
      // unreadable file: skip it rather than fail the whole scan
    }
  }

  const files: Record<string, string> = {};
  for (const [file, { hash }] of sources) files[file] = hash;
  for (const manifestFile of DEPENDENCY_MANIFESTS) {
    const absolute = path.join(config.root, manifestFile);
    if (fs.existsSync(absolute)) {
      files[manifestFile] = sha256(fs.readFileSync(absolute, "utf8"));
    }
  }

  const sharedConstants = collectSharedConstants(sources);
  const constantsHash = sha256(
    [...sharedConstants].sort(([a], [b]) => a.localeCompare(b)).join("\n"),
  );

  const fullReason = decideFullReparse({ options, previous, files, constantsHash });
  const changed = (file: string): boolean =>
    fullReason !== undefined || previous?.files[file] !== files[file];

  const cache = previous ? callSitesByFile(previous) : new Map<string, CachedFile>();
  const integrations = new Map<string, Integration>();
  let filesParsed = 0;
  let filesReused = 0;

  // Raw HTTP call sites: the primary signal.
  for (const [file, source] of sources) {
    if (!changed(file)) {
      const cached = cache.get(file);
      filesReused++;
      for (const { integrationId, host, site } of cached?.http ?? []) {
        addCallSite(integrations, integrationId, { kind: "http", host }, site);
      }
      continue;
    }

    filesParsed++;
    const sites = extractHttpCallSites(source.text, source.language, file, {
      ignoreHosts: config.ignoreHosts,
      sharedConstants,
    });
    for (const site of sites) {
      const { host, ...callSite } = site;
      addCallSite(integrations, `http:${host}`, { kind: "http", host }, callSite as CallSite);
    }
    if (sites.length) debug(`${file}: ${sites.length} HTTP call site(s)`);
  }

  // SDK usage: secondary, and only reparsed for files that changed.
  const sdkSources = new Map<string, { language: Language; text: string }>();
  for (const [file, source] of sources) {
    if (changed(file)) sdkSources.set(file, { language: source.language, text: source.text });
  }
  const sdkIntegrations = scanSdkIntegrations({
    root: config.root,
    sources: sdkSources,
    includeDeps: config.includeDeps,
    excludeDeps: config.excludeDeps,
    declaredOnly: true,
  });
  for (const integration of sdkIntegrations) {
    for (const site of integration.callSites) {
      addCallSite(
        integrations,
        integration.id,
        {
          kind: "sdk",
          package: integration.package,
          declaredVersion: integration.declaredVersion,
        },
        site,
      );
    }
  }
  // Reuse SDK usage from unchanged files, but only for dependencies that are
  // still declared and still wanted.
  const declaredSdkIds = new Set(sdkIntegrations.map((i) => i.id));
  for (const [file, cached] of cache) {
    if (!sources.has(file) || changed(file)) continue;
    for (const { integrationId, meta, site } of cached.sdk) {
      if (!declaredSdkIds.has(integrationId)) continue;
      addCallSite(integrations, integrationId, meta, site);
    }
  }

  // An integration with no call sites left (its last usage was deleted) is
  // dropped rather than kept as an empty shell.
  for (const [id, integration] of integrations) {
    if (integration.callSites.length === 0) integrations.delete(id);
  }

  return {
    manifest: {
      version: 1,
      generatedAt: new Date().toISOString(),
      files: sortRecord(files),
      integrations: sortIntegrations([...integrations.values()]),
      specs: specFiles,
      sharedConstantsHash: constantsHash,
    },
    filesParsed,
    filesReused,
    fullReason,
  };
}

function decideFullReparse(input: {
  options: ScanOptions;
  previous?: Manifest;
  files: Record<string, string>;
  constantsHash: string;
}): string | undefined {
  const { options, previous, files, constantsHash } = input;
  if (options.full) return "--full requested";
  if (!previous) return "no previous manifest";
  if (previous.version !== 1) return "manifest written by another version";
  if (previous.sharedConstantsHash !== constantsHash) {
    return "repo-wide base URL constants changed";
  }
  for (const manifestFile of DEPENDENCY_MANIFESTS) {
    if (previous.files[manifestFile] !== files[manifestFile]) {
      return `${manifestFile} changed`;
    }
  }
  return undefined;
}

type IntegrationMeta = Pick<Integration, "kind" | "host" | "package" | "declaredVersion">;

function addCallSite(
  integrations: Map<string, Integration>,
  id: string,
  meta: IntegrationMeta,
  site: CallSite,
): void {
  let integration = integrations.get(id);
  if (!integration) {
    integration = { id, ...meta, callSites: [] };
    integrations.set(id, integration);
  }
  const duplicate = integration.callSites.some(
    (existing) =>
      existing.file === site.file &&
      existing.line === site.line &&
      existing.method === site.method &&
      existing.pathTemplate === site.pathTemplate &&
      existing.member === site.member,
  );
  if (!duplicate) integration.callSites.push(site);
}

type CachedFile = {
  http: { integrationId: string; host: string; site: CallSite }[];
  sdk: { integrationId: string; meta: IntegrationMeta; site: CallSite }[];
};

/** Index a previous manifest by file, so unchanged files can be reused. */
function callSitesByFile(manifest: Manifest): Map<string, CachedFile> {
  const byFile = new Map<string, CachedFile>();
  for (const integration of manifest.integrations) {
    for (const site of integration.callSites) {
      const entry = byFile.get(site.file) ?? { http: [], sdk: [] };
      if (integration.kind === "http") {
        entry.http.push({
          integrationId: integration.id,
          host: integration.host ?? "",
          site,
        });
      } else {
        entry.sdk.push({
          integrationId: integration.id,
          meta: {
            kind: "sdk",
            package: integration.package,
            declaredVersion: integration.declaredVersion,
          },
          site,
        });
      }
      byFile.set(site.file, entry);
    }
  }
  return byFile;
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Base-URL constants visible across the repository. A shared `API_BASE_URL`
 * imported by several modules is common, and treating each file in isolation
 * would silently drop those call sites. Names that resolve to more than one
 * URL are dropped: guessing there would be worse than missing them.
 */
function collectSharedConstants(sources: Map<string, SourceFile>): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const { language, text } of sources.values()) {
    for (const [name, url] of collectBaseUrlConstants(text, language)) {
      const urls = seen.get(name) ?? new Set<string>();
      urls.add(url);
      seen.set(name, urls);
    }
  }

  const shared = new Map<string, string>();
  for (const [name, urls] of seen) {
    if (urls.size === 1) shared.set(name, [...urls][0]);
  }
  return shared;
}

/** Stable ordering, so a manifest diff only shows real changes. */
export function sortIntegrations(integrations: Integration[]): Integration[] {
  for (const integration of integrations) {
    integration.callSites.sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        (a.method ?? "").localeCompare(b.method ?? "") ||
        (a.pathTemplate ?? "").localeCompare(b.pathTemplate ?? "") ||
        (a.member ?? "").localeCompare(b.member ?? ""),
    );
  }
  return integrations.sort((a, b) => a.id.localeCompare(b.id));
}

export function countCallSites(manifest: Manifest): number {
  return manifest.integrations.reduce((total, i) => total + i.callSites.length, 0);
}
