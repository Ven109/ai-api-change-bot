// The model-powered half of `impact`.
//
// The prefilter already decided that a change names something this repository
// uses. What a model adds is judgement: does it *really* matter here, how
// risky is it, and what would the migration actually be. This is also the part
// that makes acb generic — no provider-specific rules, just the upstream text
// plus the matched code.
//
// Only matched snippets are sent, never whole files, and everything goes
// through the egress guard.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { debug, warn } from "../log.ts";
import { chatJson, type ModelProvider } from "../model/index.ts";
import type { Candidate, ChangeEntry, ImpactItem, Manifest, Risk } from "../types.ts";

/** Lines of context around a matched line. Enough to see the call, not the file. */
const CONTEXT_LINES = 15;
const MAX_LOCATIONS = 8;
const MAX_BODY_CHARS = 6000;

const SYSTEM_PROMPT = `You are a senior engineer reviewing whether an upstream API change affects a specific repository.

You are given one upstream change (from a provider's OpenAPI diff or changelog) and the exact code locations a deterministic matcher found for it. Decide whether this repository is really affected, and if so, what the migration is.

Rules:
- Judge only from the evidence given. If the change does not actually affect the shown code, say so plainly: a false alarm dismissed with a reason is a good answer.
- Only reference files and line numbers that appear in the evidence.
- Migration steps are concrete instructions for an engineer or coding agent editing this repository: which call, which file, what it becomes. No generic advice.
- Mention a deadline only if the upstream text gives one.
- Reply with one JSON object and nothing else.

JSON shape:
{
  "relevant": boolean,
  "confidence": number between 0 and 1,
  "risk": "low" | "medium" | "high",
  "deadline": "YYYY-MM-DD" or null,
  "summary": "one line, what this means for this repository",
  "whatChanged": "2-4 sentences on the upstream change itself",
  "affected": [{"file": "...", "line": 0, "reason": "..."}],
  "migrationSteps": ["..."],
  "dependencyChanges": ["..."],
  "validationHints": ["..."],
  "dismissedReason": "only when relevant is false"
}`;

type RawAssessment = {
  relevant?: boolean;
  confidence?: number;
  risk?: string;
  deadline?: string | null;
  summary?: string;
  whatChanged?: string;
  affected?: { file?: string; line?: number; reason?: string }[];
  migrationSteps?: unknown[];
  dependencyChanges?: unknown[];
  validationHints?: unknown[];
  dismissedReason?: string;
};

export type AssessInput = {
  config: Config;
  manifest: Manifest;
  provider: ModelProvider;
  entry: ChangeEntry;
  candidate: Candidate;
  /** Other entries from the same source, e.g. a migration guide section. */
  related?: ChangeEntry[];
};

export async function assessCandidate(input: AssessInput): Promise<ImpactItem> {
  const { entry, candidate, provider } = input;
  const prompt = buildPrompt(input);

  const raw = await chatJson<RawAssessment>(
    provider,
    { system: SYSTEM_PROMPT, messages: [{ role: "user", content: prompt }] },
    { requiredKeys: ["relevant", "risk", "summary"] },
  );

  return toImpactItem(raw, input);
}

export function buildPrompt(input: AssessInput): string {
  const { entry, candidate, config, related } = input;
  const parts: string[] = [];

  parts.push(`# Integration\n\n${entry.integrationId}`);

  parts.push(
    `# Upstream change\n\n` +
      `Source: ${entry.source}\n` +
      `Kind: ${entry.kind === "openapi" ? "OpenAPI specification diff" : "changelog / release notes"}\n` +
      (entry.date ? `Date: ${entry.date}\n` : "") +
      (entry.version ? `Version: ${entry.version}\n` : "") +
      (entry.tags.length ? `Tagged: ${entry.tags.join(", ")}\n` : "") +
      `\n## ${entry.title}\n\n${entry.body.slice(0, MAX_BODY_CHARS)}`,
  );

  if (related?.length) {
    parts.push(
      `# Other entries from the same source (context)\n\n` +
        related
          .slice(0, 3)
          .map((other) => `## ${other.title}\n\n${other.body.slice(0, 1200)}`)
          .join("\n\n"),
    );
  }

  parts.push(
    `# Where the matcher found this repository using it\n\n` +
      candidate.matches
        .slice(0, MAX_LOCATIONS)
        .map((match) => `- ${match.file}:${match.line} — ${match.reason}`)
        .join("\n"),
  );

  const snippets = collectSnippets(config.root, candidate);
  if (snippets.length) {
    parts.push(`# Code at those locations\n\n${snippets.join("\n\n")}`);
  }

  parts.push(
    `# Question\n\nDoes this change affect this repository, and what is the migration? ` +
      `Reply with the JSON object only.`,
  );

  return parts.join("\n\n");
}

/** Matched lines with a little context, merged per file. Never whole files. */
export function collectSnippets(root: string, candidate: Candidate): string[] {
  const byFile = new Map<string, number[]>();
  for (const match of candidate.matches.slice(0, MAX_LOCATIONS)) {
    const lines = byFile.get(match.file) ?? [];
    lines.push(match.line);
    byFile.set(match.file, lines);
  }

  const snippets: string[] = [];
  for (const [file, lines] of byFile) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    const allLines = text.split("\n");
    for (const range of mergeRanges(lines, allLines.length)) {
      const body = allLines
        .slice(range.start - 1, range.end)
        .map((line, index) => `${range.start + index}| ${line}`)
        .join("\n");
      snippets.push(`## ${file}:${range.start}-${range.end}\n\n\`\`\`\n${body}\n\`\`\``);
    }
  }
  return snippets;
}

function mergeRanges(lines: number[], fileLength: number): { start: number; end: number }[] {
  const ranges = [...new Set(lines)]
    .sort((a, b) => a - b)
    .map((line) => ({
      start: Math.max(1, line - CONTEXT_LINES),
      end: Math.min(fileLength, line + CONTEXT_LINES),
    }));

  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function toImpactItem(raw: RawAssessment, input: AssessInput): ImpactItem {
  const { entry, candidate, manifest, config, provider } = input;

  const affected = filterHallucinations(raw.affected ?? [], candidate, manifest, config.root);
  // A model that judged the change relevant but named no location still leaves
  // the matcher's evidence, which is real.
  const locations = affected.length > 0 ? affected : candidate.matches;

  return {
    id: `${entry.integrationId.replace(/[^\w.-]/g, "_")}-${entry.id}`,
    entryId: entry.id,
    integrationId: entry.integrationId,
    relevant: raw.relevant !== false,
    confidence: clampConfidence(raw.confidence) ?? candidate.score,
    risk: normalizeRisk(raw.risk),
    deadline: normalizeDate(raw.deadline) ?? undefined,
    summary: raw.summary?.trim() || entry.title,
    whatChanged: raw.whatChanged?.trim() || entry.body.slice(0, 2000),
    affected: raw.relevant === false ? [] : locations,
    migrationSteps: toStringArray(raw.migrationSteps),
    dependencyChanges: toStringArray(raw.dependencyChanges),
    validationHints: toStringArray(raw.validationHints),
    analyzedBy: provider.label,
    dismissedReason:
      raw.relevant === false ? raw.dismissedReason?.trim() || "judged not relevant" : undefined,
  };
}

/**
 * Keep only locations that exist: a file the repository actually has, and a
 * line inside it. A plausible-looking but invented `file:line` in a report
 * costs a reviewer more than it saves.
 */
function filterHallucinations(
  affected: { file?: string; line?: number; reason?: string }[],
  candidate: Candidate,
  manifest: Manifest,
  root: string,
): { file: string; line: number; reason: string }[] {
  const knownFiles = new Set(Object.keys(manifest.files));
  const kept: { file: string; line: number; reason: string }[] = [];
  let dropped = 0;

  for (const location of affected) {
    const file = location.file?.replace(/^\.\//, "");
    const line = Number(location.line);
    if (!file || !Number.isFinite(line) || line < 1) {
      dropped++;
      continue;
    }
    if (!knownFiles.has(file)) {
      dropped++;
      continue;
    }
    if (line > countLines(root, file)) {
      dropped++;
      continue;
    }
    kept.push({
      file,
      line,
      reason: location.reason?.trim() || "named by the model",
    });
  }

  if (dropped > 0) {
    warn(`dropped ${dropped} location(s) the model named that do not exist in this repository`);
  }
  // Fall back to the matcher's evidence rather than an empty list.
  return kept.length > 0 ? kept : [];
}

const lineCounts = new Map<string, number>();

function countLines(root: string, file: string): number {
  const key = path.join(root, file);
  const cached = lineCounts.get(key);
  if (cached !== undefined) return cached;
  let count = 0;
  try {
    count = fs.readFileSync(key, "utf8").split("\n").length;
  } catch {
    count = 0;
  }
  lineCounts.set(key, count);
  return count;
}

function normalizeRisk(risk: unknown): Risk {
  const value = String(risk ?? "").toLowerCase();
  if (value === "high" || value === "critical") return "high";
  if (value === "medium" || value === "moderate") return "medium";
  if (value === "low" || value === "none") return "low";
  debug(`unrecognized risk "${risk}", treating it as medium`);
  return "medium";
}

function clampConfidence(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.max(0, Math.min(1, number));
}

function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0];
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}
