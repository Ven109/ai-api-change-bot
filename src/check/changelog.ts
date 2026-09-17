// Prose upstream sources: changelog pages, release notes, deprecation notices,
// migration guides.
//
// Most API changes are announced in prose, and plenty of providers publish no
// machine-readable spec at all, so this is the generic path. What happens here
// is still fully deterministic: fetch, split into entries, extract candidate
// identifiers, and remember what we have already reported. Judging what an
// entry *means* is the model's job (AIA-9) and happens later, only for entries
// that actually match this repository.

import type { ChangeEntry, ChangeIdentifier } from "../types.ts";
import { sha256 } from "../scan/index.ts";

export type ParsedEntry = {
  title: string;
  body: string;
  date?: string;
  version?: string;
};

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Reduce an HTML page to text, keeping headings as markdown so splitting works. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|nav|footer|header)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<h1\b[^>]*>/gi, "\n\n# ")
    .replace(/<h2\b[^>]*>/gi, "\n\n## ")
    .replace(/<h3\b[^>]*>/gi, "\n\n### ")
    .replace(/<\/h[1-3]>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(p|div|tr|br)\b[^>]*>/gi, "\n")
    .replace(/<code\b[^>]*>/gi, "`")
    .replace(/<\/code>/gi, "`")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split a changelog into entries.
 *
 * Markdown headings are the usual structure. Providers who publish a flat list
 * of dated lines get one entry per dated block instead, which is better than
 * treating a whole page as a single change.
 */
export function splitEntries(text: string): ParsedEntry[] {
  const lines = text.split("\n");
  const entries: ParsedEntry[] = [];
  let current: { title: string; body: string[] } | undefined;

  // Prefer the deepest heading level that appears more than once: that is the
  // level individual releases are listed at.
  const counts = new Map<number, number>();
  for (const line of lines) {
    const match = line.match(/^(#{1,4})\s+\S/);
    if (match) counts.set(match[1].length, (counts.get(match[1].length) ?? 0) + 1);
  }
  let entryLevel = 0;
  let best = 0;
  for (const [level, count] of [...counts].sort((a, b) => b[0] - a[0])) {
    if (count > best || (count === best && level > entryLevel)) {
      best = count;
      entryLevel = level;
    }
  }

  for (const line of lines) {
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      if (level === entryLevel) {
        // A new release or announcement.
        if (current) entries.push(finishEntry(current));
        current = { title: heading[2].trim(), body: [] };
        continue;
      }
      if (level < entryLevel) {
        // A page title or a grouping header such as a year: not a change in
        // itself, and it ends whatever entry came before it.
        if (current) entries.push(finishEntry(current));
        current = undefined;
        continue;
      }
      // A deeper heading belongs to the entry it sits in.
    }
    if (current) current.body.push(line);
  }
  if (current) entries.push(finishEntry(current));

  if (entries.length > 0) return entries.filter((entry) => entry.title || entry.body);

  // No headings at all: fall back to dated blocks.
  return splitDatedBlocks(lines);
}

function splitDatedBlocks(lines: string[]): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let current: { title: string; body: string[] } | undefined;
  for (const line of lines) {
    if (findDate(line) && line.trim()) {
      if (current) entries.push(finishEntry(current));
      current = { title: line.trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) entries.push(finishEntry(current));
  return entries;
}

function finishEntry(raw: { title: string; body: string[] }): ParsedEntry {
  const body = raw.body.join("\n").trim();
  return {
    title: raw.title,
    body,
    date: findDate(raw.title) ?? findDate(body.slice(0, 400)),
    version: findVersion(raw.title),
  };
}

export function findDate(text: string): string | undefined {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const long = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i,
  );
  if (long) {
    const month = String(MONTHS.indexOf(long[1].toLowerCase()) + 1).padStart(2, "0");
    return `${long[3]}-${month}-${long[2].padStart(2, "0")}`;
  }

  const dayFirst = text.match(
    /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i,
  );
  if (dayFirst) {
    const month = String(MONTHS.indexOf(dayFirst[2].toLowerCase()) + 1).padStart(2, "0");
    return `${dayFirst[3]}-${month}-${dayFirst[1].padStart(2, "0")}`;
  }
  return undefined;
}

export function findVersion(text: string): string | undefined {
  const match = text.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)\b/);
  return match?.[1];
}

const TAG_PATTERNS: [string, RegExp][] = [
  ["breaking", /\bbreaking(?:\s+change)?\b|\bincompatible\b|\bmigrat(?:e|ion)\b/i],
  ["deprecation", /\bdeprecat(?:ed|ion|ing)\b|\blegacy\b/i],
  ["sunset", /\bsunset\b|\bretire(?:d|ment|s)?\b|\bshut\s*down\b|\bend[- ]of[- ]life\b|\bwill stop\b|\bno longer (?:be )?(?:served|available|supported)\b/i],
  ["removal", /\bremoved?\b|\bdeleted\b|\bgone\b|\b410\b/i],
  ["new", /\badded\b|\bnew\b|\bintroduc(?:ed|ing)\b|\bnow (?:accepts|supports|returns)\b/i],
];

export function tagsFor(entry: ParsedEntry): string[] {
  const text = `${entry.title}\n${entry.body}`;
  const tags = TAG_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
  // A pure announcement should not look like a breaking change.
  if (tags.includes("new") && tags.length > 1) {
    return tags.filter((tag) => tag !== "new");
  }
  return tags;
}

const NOISE_TOKENS = new Set([
  "true",
  "false",
  "null",
  "none",
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "json",
  "http",
  "https",
  "api",
]);

/**
 * Candidate identifiers an entry talks about: endpoint paths, methods,
 * parameter names, member chains. These are what the prefilter matches
 * against real call sites, so precision matters more than volume.
 */
export function extractIdentifiers(text: string): ChangeIdentifier[] {
  const identifiers: ChangeIdentifier[] = [];
  const seen = new Set<string>();

  const push = (identifier: ChangeIdentifier): void => {
    const key = JSON.stringify(identifier);
    if (seen.has(key)) return;
    seen.add(key);
    identifiers.push(identifier);
  };

  // `GET /v1/things` and `POST https://host/v1/things`
  for (const match of text.matchAll(
    /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(?:https?:\/\/[^\s`"')]+)?(\/[\w{}\-./]*)/g,
  )) {
    push({ method: match[1], pathTemplate: normalizePath(match[2]) });
  }

  // Any endpoint-looking path, whether or not a method is spelled out.
  for (const match of text.matchAll(/(?:https?:\/\/[^\s`"')]+)?(\/(?:[\w{}\-.]+\/){1,6}[\w{}\-.]*)/g)) {
    const candidate = normalizePath(match[1]);
    if (candidate.length > 2) push({ pathTemplate: candidate });
  }

  // Backticked tokens: member chains, parameter and field names.
  for (const match of text.matchAll(/`([^`\n]{1,80})`/g)) {
    const token = match[1].trim();
    if (!token) continue;

    if (/^\/[\w{}\-./]*$/.test(token)) {
      push({ pathTemplate: normalizePath(token) });
      continue;
    }
    // A full URL, which is how migration tables usually spell endpoints out.
    if (/^https?:\/\//i.test(token)) {
      const withoutOrigin = token.replace(/^https?:\/\/[^/]+/i, "");
      if (withoutOrigin.startsWith("/")) push({ pathTemplate: normalizePath(withoutOrigin) });
      continue;
    }
    const methodPath = token.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i);
    if (methodPath) {
      push({
        method: methodPath[1].toUpperCase(),
        pathTemplate: normalizePath(methodPath[2].replace(/^https?:\/\/[^/]+/, "")),
      });
      continue;
    }
    if (/^[\w$]+(\.[\w$]+)+(\(\))?$/.test(token)) {
      push({ token: token.replace(/\(\)$/, "") });
      continue;
    }
    const assignment = token.match(/^([\w-]+)=/);
    if (assignment) {
      push({ param: assignment[1] });
      continue;
    }
    if (/^[\w-]{2,}$/.test(token) && !NOISE_TOKENS.has(token.toLowerCase())) {
      // Could be a parameter, a response field or a symbol; the prefilter
      // tries it against all three.
      push({ param: token });
      push({ field: token });
      push({ token });
    }
  }

  return identifiers;
}

function normalizePath(path: string): string {
  const withoutQuery = path.split("?")[0].replace(/[.,;:]+$/, "");
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) return withoutQuery.slice(0, -1);
  return withoutQuery;
}

export type ChangelogParseOptions = {
  integrationId: string;
  source: string;
  format?: "markdown" | "html" | "text";
};

export function parseChangelog(
  text: string,
  options: ChangelogParseOptions,
): ChangeEntry[] {
  const looksLikeHtml = /<(html|body|div|h[1-3]|p)\b/i.test(text.slice(0, 2000));
  const plain = options.format === "html" || (options.format === undefined && looksLikeHtml)
    ? htmlToText(text)
    : text;

  return splitEntries(plain)
    .filter((entry) => entry.body.trim().length > 0 || entry.title.trim().length > 0)
    .map((entry) => ({
      id: sha256(`${options.integrationId}|${entry.title}|${entry.body}`).slice(0, 16),
      integrationId: options.integrationId,
      source: options.source,
      kind: "changelog" as const,
      title: entry.title,
      body: entry.body,
      date: entry.date,
      version: entry.version,
      tags: tagsFor(entry),
      identifiers: extractIdentifiers(`${entry.title}\n${entry.body}`),
    }));
}
