// Rendering impact reports.
//
// The Markdown report is what a human reads (and what ends up in the pull
// request body), the JSON is what later stages and CI read. Both say which
// stage produced each conclusion, so a reader can tell a deterministic match
// from a model's judgement.

import type { ChangeEntry, ImpactItem } from "../types.ts";

export type ReportInput = {
  items: ImpactItem[];
  unmatched: ChangeEntry[];
  entries: ChangeEntry[];
  /** e.g. "deterministic prefilter only" or "anthropic/claude-opus-5". */
  analyzer: string;
  generatedAt?: string;
};

export function renderMarkdownReport(input: ReportInput): string {
  const lines: string[] = [];
  const relevant = input.items.filter((item) => item.relevant);
  const dismissed = input.items.filter((item) => !item.relevant);
  const byId = new Map(input.entries.map((entry) => [entry.id, entry]));

  lines.push("# API change impact report");
  lines.push("");
  lines.push(`Generated: ${input.generatedAt ?? new Date().toISOString()}`);
  lines.push(`Analyzed by: ${input.analyzer}`);
  lines.push("");

  if (relevant.length === 0) {
    lines.push("No upstream change affects this repository.");
  } else {
    lines.push("| Integration | Change | Risk | Deadline | Affected |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const item of relevant) {
      lines.push(
        `| ${item.integrationId} | ${escapeCell(item.summary)} | ${item.risk} | ` +
          `${item.deadline ?? "—"} | ${item.affected.length} location(s) |`,
      );
    }
  }
  lines.push("");

  for (const item of relevant) {
    const entry = byId.get(item.entryId);
    lines.push(`## ${item.summary}`);
    lines.push("");
    lines.push(`- Integration: \`${item.integrationId}\``);
    lines.push(`- Risk: **${item.risk}**${item.deadline ? ` (deadline ${item.deadline})` : ""}`);
    if (item.confidence !== undefined) lines.push(`- Confidence: ${item.confidence}`);
    lines.push(`- Determined by: ${item.analyzedBy}`);
    if (entry?.source) lines.push(`- Upstream source: ${entry.source}`);
    lines.push("");

    if (item.whatChanged) {
      lines.push("### What changed");
      lines.push("");
      lines.push(item.whatChanged.trim());
      lines.push("");
    }

    lines.push("### Where this repository is affected");
    lines.push("");
    for (const location of item.affected) {
      lines.push(`- \`${location.file}:${location.line}\` — ${location.reason}`);
    }
    lines.push("");

    if (item.migrationSteps.length) {
      lines.push("### Migration");
      lines.push("");
      for (const step of item.migrationSteps) lines.push(`1. ${step}`);
      lines.push("");
    }
    if (item.dependencyChanges.length) {
      lines.push("### Dependency changes");
      lines.push("");
      for (const change of item.dependencyChanges) lines.push(`- ${change}`);
      lines.push("");
    }
    if (item.validationHints.length) {
      lines.push("### How to validate");
      lines.push("");
      for (const hint of item.validationHints) lines.push(`- ${hint}`);
      lines.push("");
    }
  }

  if (dismissed.length) {
    lines.push("## Dismissed");
    lines.push("");
    lines.push("Matched the prefilter, then judged not to affect this repository.");
    lines.push("");
    for (const item of dismissed) {
      lines.push(`- ${item.summary} — ${item.dismissedReason ?? "no reason given"}`);
    }
    lines.push("");
  }

  if (input.unmatched.length) {
    lines.push("## Filtered out before any model call");
    lines.push("");
    lines.push(
      "These upstream changes name nothing this repository uses, so they were " +
        "dropped deterministically and no code or prompt was sent anywhere.",
    );
    lines.push("");
    for (const entry of input.unmatched) {
      lines.push(`- ${entry.title}${entry.tags.length ? ` [${entry.tags.join(", ")}]` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function reportFileName(generatedAt: string): string {
  return `${generatedAt.slice(0, 10)}-impact`;
}
