// Extracting raw HTTP call sites from source text.
//
// This is the primary signal acb works from: for an integration reached over
// plain HTTP there is no package version to compare, so the only way to know
// whether an upstream change matters is to know which host, method, path and
// query parameters the repository actually uses.
//
// The prototype does this lexically rather than with a real parser: find the
// HTTP-ish call, take its argument text, substitute same-file base-URL
// constants, and stitch the string literals back together. It is approximate
// by design, and AIA-17 replaces it with tree-sitter queries once the
// evaluation harness says where the recall actually goes missing.

import type { CallSite } from "../types.ts";
import type { Language } from "./walk.ts";

export type HttpCallSite = CallSite & {
  host: string;
  method: string;
  pathTemplate: string;
  queryParams: string[];
};

const HTTP_VERBS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "request",
]);

/** How much text after the opening paren we are willing to consider. */
const MAX_ARGS_CHARS = 2000;

/** `const BASE = "https://api.example.com"` and friends, per file. */
export function collectBaseUrlConstants(
  source: string,
  language: Language,
): Map<string, string> {
  const constants = new Map<string, string>();
  const patterns =
    language === "python"
      ? [/^[ \t]*([A-Za-z_]\w*)(?:\s*:\s*[\w\[\], .]+)?\s*=\s*(["'])(https?:\/\/[^"'\s]+)\2/gm]
      : [
          /(?:const|let|var)\s+([\w$]+)(?:\s*:\s*[^=]+)?\s*=\s*(["'`])(https?:\/\/[^"'`\s]+)\2/g,
          // object literals and class fields: `baseUrl: "https://…"`
          /([\w$]+)\s*[:=]\s*(["'`])(https?:\/\/[^"'`\s]+)\2/g,
        ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const [, name, , url] = match;
      if (!constants.has(name)) constants.set(name, url.replace(/\/+$/, ""));
    }
  }
  return constants;
}

/**
 * Variables that hold a fully resolved URL, for the very common shape where
 * the URL is built a line or two above the request:
 *
 *     const url = `${BASE}/data/2.5/onecall?lat=${lat}`;
 *     const response = await fetch(url);
 */
export function collectUrlVariables(
  source: string,
  language: Language,
  constants: Map<string, string>,
): Map<string, string> {
  const variables = new Map<string, string>();
  const pattern =
    language === "python"
      ? /^[ \t]*([A-Za-z_]\w*)\s*=\s*([^\n]+(?:\n[ \t]+[^\n]+)*)/gm
      : /(?:const|let|var)\s+([\w$]+)(?:\s*:\s*[^=]+)?\s*=\s*([\s\S]*?);/g;

  for (const match of source.matchAll(pattern)) {
    const [, name, rhs] = match;
    if (constants.has(name) || variables.has(name)) continue;
    const resolved = resolveUrlExpression(rhs, mergeMaps(constants, variables), language);
    if (resolved) variables.set(name, resolved);
  }
  return variables;
}

function mergeMaps(a: Map<string, string>, b: Map<string, string>): Map<string, string> {
  return new Map([...a, ...b]);
}

/** Text between `(` at `openIndex` and its matching `)`, quote-aware. */
export function readCallArgs(source: string, openIndex: number): string {
  let depth = 0;
  let quote: string | undefined;
  const end = Math.min(source.length, openIndex + MAX_ARGS_CHARS);

  for (let i = openIndex; i < end; i++) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return source.slice(openIndex + 1, end);
}

/**
 * Turn the first URL-ish argument into a single string, resolving same-file
 * base-URL constants and joining concatenated literals. Interpolations are
 * left in place as `${…}` / `{…}` for the caller to normalize.
 */
export function resolveUrlExpression(
  argsText: string,
  constants: Map<string, string>,
  language: Language,
): string | undefined {
  let text = argsText;

  // `${BASE}` / `{BASE}` (f-strings) / a leading `BASE +` concatenation.
  for (const [name, url] of constants) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`\\$\\{\\s*${escaped}\\s*\\}`, "g"), url);
    if (language === "python") {
      text = text.replace(new RegExp(`\\{\\s*${escaped}\\s*\\}`, "g"), url);
    }
    text = text.replace(new RegExp(`(^|[(,=\\s])${escaped}\\s*\\+\\s*`, "g"), `$1"${url}" + `);
  }

  // `"a" + "b"` -> `"ab"`, so a split URL reads as one literal.
  let joined = text;
  for (let i = 0; i < 5; i++) {
    const next = joined.replace(/(["'`])\s*\+\s*(?:f\s*)?(["'`])/g, "");
    if (next === joined) break;
    joined = next;
  }

  const literal = firstStringLiteral(joined);
  if (literal === undefined) return undefined;
  if (!/^https?:\/\//i.test(literal)) return undefined;
  return literal;
}

/** Contents of the first string literal (including f-strings and templates). */
export function firstStringLiteral(text: string): string | undefined {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== '"' && char !== "'" && char !== "`") continue;
    let value = "";
    for (let j = i + 1; j < text.length; j++) {
      const inner = text[j];
      if (inner === "\\") {
        value += text[j + 1] ?? "";
        j++;
        continue;
      }
      if (inner === char) return value;
      value += inner;
    }
    return value;
  }
  return undefined;
}

/** `${order.id}` / `{shipment_id}` -> `{id}` / `{shipment_id}`. */
function normalizeInterpolations(path: string): string {
  return path
    .replace(/\$\{([^}]*)\}/g, (_match, expr: string) => `{${placeholderName(expr)}}`)
    .replace(/\{([^}]*)\}/g, (_match, expr: string) => `{${placeholderName(expr)}}`);
}

function placeholderName(expr: string): string {
  const identifiers = expr.match(/[A-Za-z_$][\w$]*/g);
  if (!identifiers || identifiers.length === 0) return "param";
  return identifiers[identifiers.length - 1];
}

export function normalizePathTemplate(pathname: string): string {
  const normalized = normalizeInterpolations(pathname);
  if (normalized.length > 1 && normalized.endsWith("/")) return normalized.slice(0, -1);
  return normalized || "/";
}

function isIgnorableHost(host: string, ignoreHosts: string[]): boolean {
  if (!host) return true;
  if (host.includes("{") || host.includes("$")) return true; // host itself is dynamic
  if (ignoreHosts.includes(host)) return true;
  if (!host.includes(".")) return true; // bare name: a service inside the cluster
  if (host.endsWith(".local") || host.endsWith(".localhost")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

function methodFromArgs(argsText: string, fallback: string): string {
  const explicit = argsText.match(/\bmethod\s*[:=]\s*(["'`])([A-Za-z]+)\1/);
  if (explicit) return explicit[2].toUpperCase();
  return fallback.toUpperCase();
}

function queryParamsFromArgs(argsText: string, language: Language): string[] {
  const names = new Set<string>();

  const paramsObject = argsText.match(/\bparams\s*[:=]\s*\{([\s\S]*?)\}/);
  if (paramsObject) {
    const body = paramsObject[1];
    const keyPattern = language === "python" ? /(["'])([\w.-]+)\1\s*:/g : /(["'`]?)([\w$]+)\1\s*:/g;
    for (const match of body.matchAll(keyPattern)) names.add(match[2]);
  }

  for (const match of argsText.matchAll(/searchParams\.(?:set|append)\(\s*(["'`])([\w.-]+)\1/g)) {
    names.add(match[2]);
  }

  return [...names];
}

function queryParamsFromUrl(query: string): string[] {
  const names: string[] = [];
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const name = pair.split("=")[0];
    if (name) names.push(normalizeInterpolations(name));
  }
  return names;
}

type Candidate = { index: number; openParen: number; method: string };

/**
 * Callees that look like they perform a request. Matching on the name rather
 * than a fixed list of libraries keeps wrappers and injected clients in scope
 * (`fetchImpl(url)`, `httpClient.request(...)`, `apiFetch(...)`), which is how
 * most real codebases call APIs.
 */
const REQUESTY_NAME = /fetch|request|http|axios|got|ky|urlopen|superagent|curl/i;

/** Calls that take a URL but are not requests. */
const NOT_A_REQUEST = new Set([
  "URL",
  "URLSearchParams",
  "log",
  "warn",
  "error",
  "info",
  "debug",
  "trace",
  "assert",
  "expect",
  "describe",
  "test",
  "it",
  "redirect",
  "push",
  "match",
  "replace",
  "startsWith",
  "endsWith",
  "includes",
]);

function findCandidates(source: string, _language: Language): Candidate[] {
  const candidates: Candidate[] = [];

  // Any call whose callee is either an HTTP verb member or a request-ish name.
  for (const match of source.matchAll(/([\w$\]).]*?)\.?\s*\b([\w$]+)\s*\(/g)) {
    const name = match[2];
    if (NOT_A_REQUEST.has(name)) continue;

    const lower = name.toLowerCase();
    const isVerb = HTTP_VERBS.has(lower);
    if (!isVerb && !REQUESTY_NAME.test(name)) continue;

    candidates.push({
      index: match.index + (match[1]?.length ?? 0),
      openParen: match.index + match[0].length - 1,
      method: isVerb && lower !== "request" ? lower : "get",
    });
  }

  return candidates.sort((a, b) => a.index - b.index);
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
}

function snippetAt(source: string, index: number, maxLines = 3): string {
  const lines = source.slice(index).split("\n").slice(0, maxLines);
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);
}

/** `fetch(url)` where `url` was built earlier in the same file. */
function urlFromVariableArgument(
  argsText: string,
  urlVariables: Map<string, string>,
): string | undefined {
  const firstArg = argsText.match(/^\s*([\w$.]+)\s*(?:,|$)/);
  if (!firstArg) return undefined;
  const name = firstArg[1];
  return urlVariables.get(name) ?? urlVariables.get(name.split(".").pop() ?? name);
}

export type ExtractOptions = {
  ignoreHosts: string[];
  /**
   * Base-URL constants declared elsewhere in the repository, used only as a
   * fallback. Sharing one `API_BASE_URL` across modules is common enough that
   * ignoring it would lose real call sites.
   */
  sharedConstants?: Map<string, string>;
};

export function extractHttpCallSites(
  source: string,
  language: Language,
  file: string,
  options: ExtractOptions,
): HttpCallSite[] {
  const constants = mergeMaps(
    options.sharedConstants ?? new Map(),
    collectBaseUrlConstants(source, language),
  );
  const urlVariables = collectUrlVariables(source, language, constants);
  const resolvable = mergeMaps(constants, urlVariables);
  const sites: HttpCallSite[] = [];
  const seen = new Set<string>();

  for (const candidate of findCandidates(source, language)) {
    const argsText = readCallArgs(source, candidate.openParen);
    const url =
      resolveUrlExpression(argsText, resolvable, language) ??
      urlFromVariableArgument(argsText, urlVariables);
    if (!url) continue;

    // `{…}` placeholders are not valid URL syntax everywhere, so parse a
    // sanitized copy and keep the original for the path template.
    let parsed: URL;
    try {
      parsed = new URL(url.replace(/\$\{[^}]*\}/g, "x").replace(/\{[^}]*\}/g, "x"));
    } catch {
      continue;
    }
    if (isIgnorableHost(parsed.hostname, options.ignoreHosts)) continue;

    const [rawPath = "", rawQuery = ""] = url.replace(/^https?:\/\/[^/?#]*/i, "").split("?");
    const pathTemplate = normalizePathTemplate(rawPath);
    const queryParams = [
      ...new Set([...queryParamsFromUrl(rawQuery), ...queryParamsFromArgs(argsText, language)]),
    ].sort();

    const method = methodFromArgs(argsText, candidate.method);
    const line = lineNumberAt(source, candidate.index);
    const key = `${method} ${parsed.hostname}${pathTemplate}@${line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    sites.push({
      file,
      line,
      snippet: snippetAt(source, candidate.index),
      method,
      host: parsed.hostname,
      pathTemplate,
      queryParams,
    });
  }

  return sites;
}
