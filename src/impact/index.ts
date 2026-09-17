// The `impact` stage: two clearly separated steps.
//
//   1. [deterministic] prefilter — match change identifiers against real call
//      sites. Entries that match nothing end here, cost nothing, and cause no
//      code to leave the machine.
//   2. [LLM] assessment — judge relevance and risk, and draft the migration.
//      Added in AIA-9; until then every candidate is reported from the
//      deterministic evidence alone.

import type { Config } from "../config.ts";
import type { Candidate, ChangeEntry, ImpactItem, Manifest, Risk } from "../types.ts";
import { prefilter } from "./prefilter.ts";

export type ImpactOptions = {
  /** Stop after the deterministic prefilter. */
  noLlm: boolean;
};

export type ImpactResult = {
  items: ImpactItem[];
  candidates: Candidate[];
  /** Entries the prefilter ruled out, for the report's audit trail. */
  unmatched: ChangeEntry[];
};

export async function analyzeImpact(
  config: Config,
  manifest: Manifest,
  entries: ChangeEntry[],
  _options: ImpactOptions,
): Promise<ImpactResult> {
  const { candidates, unmatched } = prefilter({
    manifest,
    entries,
    minScore: config.impact.minScore,
    root: config.root,
  });

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const items = candidates.map((candidate) =>
    deterministicItem(candidate, byId.get(candidate.entryId)!),
  );

  return { items, candidates, unmatched };
}

/**
 * What can be said without a model: this change names something this repo
 * uses, here is where, and here is how the provider tagged it. No migration
 * plan, because inventing one is exactly the part that needs judgement.
 */
export function deterministicItem(candidate: Candidate, entry: ChangeEntry): ImpactItem {
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
