// The `impact` stage: two clearly separated steps.
//
//   1. [deterministic] prefilter — match change identifiers against real call
//      sites. Entries that match nothing end here, cost nothing, and cause no
//      code to leave the machine.
//   2. [LLM] assessment — judge relevance and risk, and draft the migration.
//      Runs only for candidates, and only if a model is configured.

import type { Config } from "../config.ts";
import { debug, warn } from "../log.ts";
import { DryRunError } from "../model/egress.ts";
import type { ModelProvider } from "../model/index.ts";
import type { Candidate, ChangeEntry, ImpactItem, Manifest, Risk } from "../types.ts";
import { assessCandidate } from "./assess.ts";
import { prefilter } from "./prefilter.ts";

export type ImpactOptions = {
  /** Stop after the deterministic prefilter, whatever the config says. */
  noLlm?: boolean;
  provider?: ModelProvider;
};

export type ImpactResult = {
  items: ImpactItem[];
  candidates: Candidate[];
  /** Entries the prefilter ruled out, for the report's audit trail. */
  unmatched: ChangeEntry[];
  /** What produced the items, for the report header. */
  analyzer: string;
  /** Set when a dry run wrote prompts instead of sending them. */
  dryRunFile?: string;
  dryRunFiles?: string[];
};

export async function analyzeImpact(
  config: Config,
  manifest: Manifest,
  entries: ChangeEntry[],
  options: ImpactOptions = {},
): Promise<ImpactResult> {
  const { candidates, unmatched } = prefilter({
    manifest,
    entries,
    minScore: config.impact.minScore,
    root: config.root,
  });

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const provider = options.noLlm ? undefined : options.provider;

  if (!provider) {
    return {
      items: candidates.map((candidate) =>
        deterministicItem(candidate, byId.get(candidate.entryId)!),
      ),
      candidates,
      unmatched,
      analyzer: "deterministic prefilter only",
    };
  }

  const items: ImpactItem[] = [];
  const dryRunFiles: string[] = [];
  for (const candidate of candidates) {
    const entry = byId.get(candidate.entryId)!;
    try {
      items.push(
        await assessCandidate({
          config,
          manifest,
          provider,
          entry,
          candidate,
          related: relatedEntries(entry, entries),
        }),
      );
    } catch (err) {
      if (err instanceof DryRunError) {
        // Keep going: the point of a dry run is to see every prompt that
        // would be sent, not just the first one.
        dryRunFiles.push(err.file);
        continue;
      }
      // One failed assessment should not lose the rest of the run; fall back
      // to what the matcher established, and say so.
      warn(`could not assess "${entry.title}": ${(err as Error).message}`);
      items.push(deterministicItem(candidate, entry));
    }
  }

  if (dryRunFiles.length > 0) {
    return {
      items: [],
      candidates,
      unmatched,
      analyzer: `${provider.label} (dry run, nothing sent)`,
      dryRunFile: dryRunFiles[0],
      dryRunFiles,
    };
  }

  return { items, candidates, unmatched, analyzer: provider.label };
}

/** Entries from the same source that may explain the change (migration guides). */
function relatedEntries(entry: ChangeEntry, entries: ChangeEntry[]): ChangeEntry[] {
  return entries.filter(
    (other) =>
      other.id !== entry.id &&
      other.integrationId === entry.integrationId &&
      other.source === entry.source &&
      sharesIdentifier(entry, other),
  );
}

function sharesIdentifier(a: ChangeEntry, b: ChangeEntry): boolean {
  const paths = new Set(a.identifiers.map((i) => i.pathTemplate).filter(Boolean));
  return b.identifiers.some((i) => i.pathTemplate && paths.has(i.pathTemplate));
}

/**
 * What can be said without a model: this change names something this repo
 * uses, here is where, and here is how the provider tagged it. No migration
 * plan, because inventing one is exactly the part that needs judgement.
 */
export function deterministicItem(candidate: Candidate, entry: ChangeEntry): ImpactItem {
  debug(`no model: reporting "${entry.title}" from the matcher's evidence alone`);
  return {
    id: `${entry.integrationId.replace(/[^\w.-]/g, "_")}-${entry.id}`,
    entryId: entry.id,
    integrationId: entry.integrationId,
    relevant: true,
    confidence: candidate.score,
    risk: riskFromTags(entry.tags),
    deadline: entry.date && entry.tags.includes("sunset") ? entry.date : undefined,
    summary: entry.title,
    whatChanged: entry.body.slice(0, 2000),
    affected: candidate.matches,
    migrationSteps: [],
    dependencyChanges: [],
    validationHints: [],
    analyzedBy: "deterministic",
  };
}

export function riskFromTags(tags: string[]): Risk {
  if (tags.includes("breaking") || tags.includes("removal")) return "high";
  if (tags.includes("deprecation") || tags.includes("sunset")) return "medium";
  return "low";
}
