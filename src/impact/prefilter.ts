// The deterministic prefilter: which upstream changes touch this repository?
//
// This is the most important stage for cost and for privacy. Most upstream
// changes are irrelevant to any given repo, and matching identifiers against
// real call sites decides that without a model. An entry with no match stops
// here: no tokens are spent on it and none of the repository's code is sent
// anywhere. Only the survivors go to the LLM stage (AIA-9).

import fs from "node:fs";
import path from "node:path";
import { canonicalizePath } from "../check/openapi.ts";
import type { Candidate, ChangeEntry, Integration, Manifest } from "../types.ts";

export type PrefilterInput = {
  manifest: Manifest;
  entries: ChangeEntry[];
  minScore: number;
  /** Repository root, for the field/token search. Omit to skip that search. */
  root?: string;
};

export type PrefilterResult = {
  candidates: Candidate[];
  /** Entries that matched nothing, kept for the report's audit trail. */
  unmatched: ChangeEntry[];
};

/** Scores per evidence type. Highest wins; a few of them stack a little. */
const SCORE = {
  /** Spec diff: the identifiers are exact by construction. */
  specOperation: 1,
  /** Prose: the entry names a path this repo calls. */
  prosePath: 0.8,
  /** SDK member chain named in the entry and used here. */
  member: 0.7,
  /** The entry names a query parameter this call site passes. */
  param: 0.5,
  /** Same host, same API version segment (e.g. /2.5/). */
  versionSegment: 0.5,
  /** A response field or symbol the entry names appears in the code. */
  fieldUsage: 0.5,
};

const TAG_BONUS = 0.1;
const NEW_ONLY_PENALTY = 0.35;

export function prefilter(input: PrefilterInput): PrefilterResult {
  const byId = new Map(input.manifest.integrations.map((i) => [i.id, i]));
  const candidates: Candidate[] = [];
  const unmatched: ChangeEntry[] = [];

  for (const entry of input.entries) {
    const integration = byId.get(entry.integrationId);
    if (!integration) {
      unmatched.push(entry);
      continue;
    }

    const matched = matchEntry(entry, integration, input);
    const score = adjustForTags(matched.score, entry.tags);

    if (matched.matches.length === 0 || score < input.minScore) {
      unmatched.push(entry);
      continue;
    }

    candidates.push({
      entryId: entry.id,
      integrationId: entry.integrationId,
      score: Math.round(Math.min(score, 1) * 100) / 100,
      matches: matched.matches,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId));
  return { candidates, unmatched };
}

/** Breaking news counts a little more; a pure announcement counts less. */
function adjustForTags(score: number, tags: string[]): number {
  if (score === 0) return 0;
  const onlyNew = tags.length > 0 && tags.every((tag) => tag === "new");
  if (onlyNew) return score - NEW_ONLY_PENALTY;
  if (tags.some((tag) => tag === "breaking" || tag === "deprecation" || tag === "sunset")) {
    return score + TAG_BONUS;
  }
  return score;
}

type Matched = { score: number; matches: { file: string; line: number; reason: string }[] };

function matchEntry(
  entry: ChangeEntry,
  integration: Integration,
  input: PrefilterInput,
): Matched {
  const best = new Map<string, { file: string; line: number; reason: string; score: number }>();
  const record = (
    site: { file: string; line: number },
    reason: string,
    score: number,
  ): void => {
    const key = `${site.file}:${site.line}`;
    const existing = best.get(key);
    if (existing && existing.score >= score) return;
    best.set(key, { file: site.file, line: site.line, reason, score });
  };

  const paths = entry.identifiers.filter((i) => i.pathTemplate).map((i) => i);
  const params = new Set(entry.identifiers.map((i) => i.param).filter(Boolean) as string[]);
  const tokens = new Set(entry.identifiers.map((i) => i.token).filter(Boolean) as string[]);
  const fields = new Set(entry.identifiers.map((i) => i.field).filter(Boolean) as string[]);

  const pathScore = entry.kind === "openapi" ? SCORE.specOperation : SCORE.prosePath;
  let pathMatched = false;

  for (const site of integration.callSites) {
    if (integration.kind === "http" && site.pathTemplate) {
      const sitePath = canonicalizePath(site.pathTemplate);

      for (const identifier of paths) {
        const entryPath = canonicalizePath(identifier.pathTemplate ?? "");
        if (!pathsEqual(sitePath, entryPath)) continue;
        if (identifier.method && site.method && identifier.method !== site.method) continue;

        pathMatched = true;
        record(
          site,
          `calls ${site.method ?? "GET"} ${site.pathTemplate}, named in "${entry.title}"`,
          pathScore,
        );
      }

      // Same API, same version segment: a version-wide retirement hits this
      // call site even when the entry never spells the full path out. Prose
      // only — a spec diff already names the exact operation, so applying
      // this to spec entries would flag every v1 endpoint in the repo.
      if (!pathMatched && entry.kind === "changelog") {
        for (const segment of versionSegments(sitePath)) {
          const mentioned = paths.some((identifier) =>
            (identifier.pathTemplate ?? "").includes(segment),
          );
          if (mentioned) {
            record(
              site,
              `uses API version segment ${segment} of ${site.pathTemplate}`,
              SCORE.versionSegment,
            );
          }
        }
      }

      for (const param of site.queryParams ?? []) {
        if (params.has(param)) {
          record(site, `passes the \`${param}\` parameter`, SCORE.param);
        }
      }
    }

    if (integration.kind === "sdk" && site.member) {
      if (tokens.has(site.member) || tokens.has(stripCall(site.member))) {
        record(site, `uses \`${site.member}\`, named in the entry`, SCORE.member);
      } else if (
        [...tokens].some((token) => site.member === token || site.member?.endsWith(`.${token}`))
      ) {
        record(site, `uses \`${site.member}\``, SCORE.member);
      }
    }
  }

  // Response fields: worth searching once the entry is known to concern this
  // repository, and only for spec diffs, where a field name is exact. In prose
  // any backticked word is a field candidate, and searching for those produces
  // noise rather than evidence.
  if (pathMatched && input.root && entry.kind === "openapi" && (fields.size || tokens.size)) {
    for (const hit of searchForSymbols(input.root, input.manifest, [...fields, ...tokens])) {
      record(hit, `reads \`${hit.symbol}\`, which the entry mentions`, SCORE.fieldUsage);
    }
  }

  const matches = [...best.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
  );
  return {
    score: matches.reduce((highest, match) => Math.max(highest, match.score), 0),
    matches: matches.map(({ file, line, reason }) => ({ file, line, reason })),
  };
}

function pathsEqual(sitePath: string, entryPath: string): boolean {
  if (!sitePath || !entryPath) return false;
  if (sitePath === entryPath) return true;
  // A changelog often omits the mount prefix ("/onecall" for "/data/2.5/onecall")
  // or adds one the code builds elsewhere. Require a full trailing segment
  // match so /v1/orders does not match /v1/orders/items.
  return sitePath.endsWith(entryPath) || entryPath.endsWith(sitePath);
}

/** `/data/2.5/onecall` -> ["/2.5/", "/data/"] style version hints. */
function versionSegments(pathTemplate: string): string[] {
  const segments: string[] = [];
  for (const match of pathTemplate.matchAll(/\/(v?\d+(?:\.\d+)?)(?=\/|$)/g)) {
    segments.push(`/${match[1]}/`);
  }
  return segments;
}

function stripCall(member: string): string {
  return member.replace(/\(\)$/, "");
}

type SymbolHit = { file: string; line: number; symbol: string };

/**
 * Where a response field or symbol shows up in the repository's own code.
 * Deliberately narrow: only the files the manifest already knows about, and
 * only the shapes that actually read a field.
 */
function searchForSymbols(
  root: string,
  manifest: Manifest,
  symbols: string[],
): SymbolHit[] {
  const hits: SymbolHit[] = [];
  const interesting = symbols.filter((symbol) => /^[\w.$-]{3,}$/.test(symbol));
  if (interesting.length === 0) return hits;

  for (const file of Object.keys(manifest.files)) {
    if (!/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|py)$/.test(file)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (const symbol of interesting) {
      const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // `x.field`, `x["field"]`, `x['field']`, `field=` in a call.
      const pattern = new RegExp(
        `(?:\\.${escaped}\\b|\\[\\s*["']${escaped}["']\\s*\\]|\\b${escaped}\\s*=[^=])`,
      );
      lines.forEach((line, index) => {
        if (pattern.test(line)) hits.push({ file, line: index + 1, symbol });
      });
    }
  }

  return hits.slice(0, 20);
}
