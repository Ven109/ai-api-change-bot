// The migration brief.
//
// This is the artifact acb really produces: a precise, self-contained task
// description assembled from the upstream changes and the deterministic
// matcher's evidence. The built-in agent reads it, an external agent
// (AIA-25) reads the same text from ACB_TASK.md, and a human can read it too.
//
// One brief covers every change to the same integration, because that is one
// migration in practice: a deprecated operation, its renamed parameter and
// its removed response field are three upstream entries and a single edit.

import type { Candidate, ChangeEntry, ImpactItem } from "../types.ts";

export type BriefInput = {
  integrationId: string;
  items: ImpactItem[];
  entries?: ChangeEntry[];
  candidates?: Candidate[];
};

export function buildBrief(input: BriefInput): string {
  const { items, integrationId } = input;
  const entryById = new Map((input.entries ?? []).map((entry) => [entry.id, entry]));
  const candidateByEntry = new Map(
    (input.candidates ?? []).map((candidate) => [candidate.entryId, candidate]),
  );
  const lines: string[] = [];

  const deadlines = items.map((item) => item.deadline).filter(Boolean) as string[];
  const highestRisk = items.some((item) => item.risk === "high")
    ? "high"
    : items.some((item) => item.risk === "medium")
      ? "medium"
      : "low";

  lines.push(`# Migration task: ${integrationId}`);
  lines.push("");
  lines.push(`- ${items.length} upstream change(s) affect this repository`);
  lines.push(`- Highest risk: ${highestRisk}`);
  if (deadlines.length) lines.push(`- Earliest deadline: ${deadlines.sort()[0]}`);
  lines.push(`- Assessed by: ${items[0]?.analyzedBy ?? "unknown"}`);
  lines.push("");
  lines.push(
    "Complete all of the changes below in one pass: they concern the same integration, " +
      "and often the same lines.",
  );
  lines.push("");

  items.forEach((item, index) => {
    const entry = entryById.get(item.entryId);
    const candidate = candidateByEntry.get(item.entryId);

    lines.push(`## Change ${index + 1}: ${item.summary}`);
    lines.push("");
    lines.push(`Risk: ${item.risk}${item.deadline ? `, deadline ${item.deadline}` : ""}`);
    if (entry?.source) lines.push(`Upstream source: ${entry.source}`);
    lines.push("");

    const description = (item.whatChanged ?? entry?.body ?? "").trim();
    if (description) {
      lines.push("### What changed");
      lines.push("");
      lines.push(description);
      lines.push("");
    }

    if (entry?.body && entry.body.trim() !== description) {
      lines.push("### Provider's own words");
      lines.push("");
      lines.push("```");
      lines.push(`${entry.title}\n\n${entry.body.slice(0, 3000)}`);
      lines.push("```");
      lines.push("");
    }

    const locations = item.affected.length ? item.affected : (candidate?.matches ?? []);
    if (locations.length) {
      lines.push("### Where this repository is affected");
      lines.push("");
      for (const location of locations) {
        lines.push(`- \`${location.file}:${location.line}\` — ${location.reason}`);
      }
      lines.push("");
    }

    if (item.migrationSteps.length) {
      lines.push("### Plan");
      lines.push("");
      item.migrationSteps.forEach((step, stepIndex) => lines.push(`${stepIndex + 1}. ${step}`));
      lines.push("");
    }

    if (item.dependencyChanges.length) {
      lines.push("### Dependency or configuration changes");
      lines.push("");
      for (const change of item.dependencyChanges) lines.push(`- ${change}`);
      lines.push("");
    }

    if (item.validationHints.length) {
      lines.push("### What validation will look for");
      lines.push("");
      for (const hint of item.validationHints) lines.push(`- ${hint}`);
      lines.push("");
    }
  });

  lines.push("## Definition of done");
  lines.push("");
  lines.push(
    "- The old usage is gone from the code, including tests and mocks that encode it.",
  );
  lines.push("- The repository's own checks pass.");
  lines.push("- The calls match the provider's current API description.");
  lines.push("- The diff contains nothing unrelated to these changes.");
  lines.push("");
  lines.push(
    "The file:line references are a starting point, not necessarily the full list: " +
      "search for the same calls elsewhere.",
  );
  lines.push("");

  return lines.join("\n");
}
