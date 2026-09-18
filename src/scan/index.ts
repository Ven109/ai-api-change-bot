// Turning a repository into a manifest of the external APIs it uses.
//
// Fully deterministic: no model is involved at any point in this stage.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { CallSite, Integration, Manifest } from "../types.ts";
import { debug } from "../log.ts";
import { collectBaseUrlConstants, extractHttpCallSites } from "./http.ts";
import { languageOf, walkRepo } from "./walk.ts";

export type ScanResult = {
  manifest: Manifest;
  filesParsed: number;
};

export function scanRepo(config: Config): ScanResult {
  const { sourceFiles, specFiles } = walkRepo(config.root, config.ignore);
  const integrations = new Map<string, Integration>();
  let filesParsed = 0;

  const sources = new Map<string, { language: "js" | "python"; text: string }>();
  for (const file of sourceFiles) {
    const language = languageOf(file);
    if (!language) continue;
    try {
      sources.set(file, {
        language,
        text: fs.readFileSync(path.join(config.root, file), "utf8"),
      });
    } catch {
      // unreadable file: skip it rather than fail the scan
    }
  }

  const sharedConstants = collectSharedConstants(sources);

  for (const [file, { language, text: source }] of sources) {
    filesParsed++;

    const sites = extractHttpCallSites(source, language, file, {
      ignoreHosts: config.ignoreHosts,
      sharedConstants,
    });
    for (const site of sites) {
      const id = `http:${site.host}`;
      let integration = integrations.get(id);
      if (!integration) {
        integration = { id, kind: "http", host: site.host, callSites: [] };
        integrations.set(id, integration);
      }
      const { host: _host, ...callSite } = site;
      integration.callSites.push(callSite as CallSite);
    }
    if (sites.length) debug(`${file}: ${sites.length} HTTP call site(s)`);
  }

  return {
    manifest: {
      version: 1,
      generatedAt: new Date().toISOString(),
      files: {},
      integrations: sortIntegrations([...integrations.values()]),
      specs: specFiles,
    },
    filesParsed,
  };
}

/**
 * Base-URL constants visible across the repository. A shared `API_BASE_URL`
 * imported by several modules is common, and treating each file in isolation
 * would silently drop those call sites. Names that resolve to more than one
 * URL are dropped: guessing there would be worse than missing them.
 */
function collectSharedConstants(
  sources: Map<string, { language: "js" | "python"; text: string }>,
): Map<string, string> {
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
        (a.pathTemplate ?? "").localeCompare(b.pathTemplate ?? ""),
    );
  }
  return integrations.sort((a, b) => a.id.localeCompare(b.id));
}

export function countCallSites(manifest: Manifest): number {
  return manifest.integrations.reduce((total, i) => total + i.callSites.length, 0);
}
