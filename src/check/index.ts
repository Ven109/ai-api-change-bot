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
import { diffSpecs } from "./openapi.ts";
import { loadSource, snapshotName } from "./sources.ts";

export type CheckOptions = {
  offline: boolean;
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
    if (sources.length === 0) {
      result.withoutSources.push(integration.id);
      continue;
    }

    for (const spec of sources) {
      const loaded = await loadSource(spec, { root: config.root, offline: options.offline });
      if (!loaded) continue;

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
