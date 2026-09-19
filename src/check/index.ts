// The `check` stage: what changed upstream since last time?
//
// Deterministic end to end. For each integration in the manifest it loads the
// configured sources, turns them into normalized change entries, and reports
// only the ones this repository has not seen before.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { ChangeEntry, Manifest } from "../types.ts";
import { debug, warn } from "../log.ts";
import { acbPaths, type AcbState } from "../state.ts";
import { parseChangelog } from "./changelog.ts";
import { explainSkipped, probeDeprecationHeaders } from "./headers.ts";
import { diffSpecs } from "./openapi.ts";
import { fetchSdkChanges, resolveSource, type ResolvedSource } from "./registry.ts";
import { loadSource, snapshotName } from "./sources.ts";

export type CheckOptions = {
  offline: boolean;
  /** Injected in tests so the registry lookups need no network. */
  fetchImpl?: typeof fetch;
  /** Record everything as seen without reporting it: first-run setup. */
  baseline: boolean;
  /** Ignore entries older than this ISO date. */
  since?: string;
};

export type CheckResult = {
  entries: ChangeEntry[];
  /** Entries suppressed because they were already reported. */
  alreadySeen: number;
  /** Integrations that have no upstream source configured yet. */
  withoutSources: string[];
  /** Spec snapshots written during this run. */
  snapshotsWritten: string[];
};

export async function checkUpstream(
  config: Config,
  manifest: Manifest,
  state: AcbState,
  options: CheckOptions,
): Promise<CheckResult> {
  const paths = acbPaths(config.root);
  const result: CheckResult = {
    entries: [],
    alreadySeen: 0,
    withoutSources: [],
    snapshotsWritten: [],
  };

  for (const integration of manifest.integrations) {
    const sources = config.sources[integration.id] ?? [];

    // A package tells us where to look, so no configuration is needed.
    if (sources.length === 0 && integration.kind === "sdk") {
      const entries = await checkSdkIntegration(integration.id, integration.declaredVersion, {
        state,
        options,
      });
      if (entries === undefined) result.withoutSources.push(integration.id);
      else result.entries.push(...entries);
      continue;
    }

    if (sources.length === 0) {
      result.withoutSources.push(integration.id);
      continue;
    }

    for (const spec of sources) {
      const loaded = await loadSource(spec, { root: config.root, offline: options.offline });
      if (!loaded) continue;

      if (spec.type === "headers") {
        // The API itself is the source: no spec, no changelog, no docs site.
        const probe = await probeDeprecationHeaders(integration, config, {
          offline: options.offline,
          fetchImpl: options.fetchImpl,
        });
        explainSkipped(probe, integration.id);
        result.entries.push(...probe.entries);
        continue;
      }

      if (spec.type === "changelog") {
        const entries = parseChangelog(loaded.text, {
          integrationId: integration.id,
          source: loaded.origin,
          format: spec.format,
        });
        debug(`${integration.id}: ${entries.length} entr(ies) in ${loaded.origin}`);
        result.entries.push(...entries);
        continue;
      }

      if (spec.type === "openapi") {
        const snapshotPath = path.join(paths.specs, snapshotName(integration.id, loaded.origin));
        let parsed: unknown;
        try {
          parsed = JSON.parse(loaded.text);
        } catch (err) {
          // YAML support is AIA-17 territory; say so plainly rather than guess.
          warn(
            `${loaded.origin} is not JSON (${(err as Error).message}). ` +
              `YAML specs are not supported yet; convert it to JSON for now.`,
          );
          continue;
        }

        const previous = readSnapshot(snapshotPath);
        if (previous === undefined) {
          writeSnapshot(snapshotPath, loaded.text);
          result.snapshotsWritten.push(snapshotPath);
          debug(`${integration.id}: recorded first spec snapshot, nothing to compare yet`);
          continue;
        }

        const entries = diffSpecs(previous, parsed, {
          integrationId: integration.id,
          source: loaded.origin,
        });
        result.entries.push(...entries);
        // The snapshot only moves forward once the entries are recorded as
        // seen, so an interrupted run does not silently skip a release.
        writeSnapshot(snapshotPath, loaded.text);
        result.snapshotsWritten.push(snapshotPath);
      }
    }
  }

  const seenByIntegration = state.seen;
  const unseen: ChangeEntry[] = [];
  for (const entry of result.entries) {
    const seen = seenByIntegration[entry.integrationId] ?? [];
    if (seen.includes(entry.id)) {
      result.alreadySeen++;
      continue;
    }
    if (options.since && entry.date && entry.date < options.since) continue;
    unseen.push(entry);
  }
  result.entries = unseen;

  for (const entry of unseen) {
    const seen = seenByIntegration[entry.integrationId] ?? [];
    seen.push(entry.id);
    seenByIntegration[entry.integrationId] = seen.sort();
  }
  state.lastRunAt = new Date().toISOString();

  if (options.baseline) result.entries = [];
  return result;
}

/**
 * Resolve and read an SDK integration's upstream sources. Returns undefined
 * when nothing could be resolved, so the caller can report it as unconfigured.
 */
async function checkSdkIntegration(
  integrationId: string,
  declaredVersion: string | undefined,
  context: { state: AcbState; options: CheckOptions },
): Promise<ChangeEntry[] | undefined> {
  const { state, options } = context;
  const registryOptions = {
    offline: options.offline,
    fetchImpl: options.fetchImpl,
    githubToken: process.env.GITHUB_TOKEN,
  };

  const cache = (state.resolvedSources ?? {}) as Record<string, ResolvedSource>;
  let source = cache[integrationId];
  const declared = declaredVersion;

  // Re-resolve when the declared version moved: the comparison baseline moved.
  if (!source || source.fromVersion !== cleanVersionOf(declared)) {
    const resolved = await resolveSource(integrationId, declared, registryOptions);
    if (!resolved) return undefined;
    source = resolved;
    state.resolvedSources = { ...cache, [integrationId]: resolved };
  } else {
    debug(`${integrationId}: using the cached source ${source.url}`);
  }

  return fetchSdkChanges(integrationId, source, registryOptions);
}

function cleanVersionOf(range: string | undefined): string | undefined {
  const match = range?.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match?.[0];
}

function readSnapshot(file: string): unknown | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeSnapshot(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith("\n") ? text : text + "\n");
}
