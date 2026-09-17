// SDK integrations: dependencies the repository declares and actually imports.
//
// Secondary to the HTTP scanner. Dependabot already tells you a new version
// exists; what acb needs is which parts of the SDK this repo touches, so an
// upstream changelog entry can be matched against real usage.
//
// Detection stays generic. No provider is named anywhere in here: any declared
// dependency that gets imported counts, minus an obvious-tooling denylist that
// the user can override in config.

import fs from "node:fs";
import path from "node:path";
import type { CallSite, Integration } from "../types.ts";
import type { Language } from "./walk.ts";

export type DeclaredDependency = {
  /** `npm:<name>` or `pypi:<name>`. */
  id: string;
  ecosystem: "npm" | "pypi";
  name: string;
  version: string;
};

/**
 * Packages that are build tooling, test tooling or framework plumbing rather
 * than an integration with an external service. Kept short on purpose: a
 * wrong guess here silently drops a real integration, so anything unclear
 * stays in.
 */
const TOOLING = new Set([
  "typescript",
  "eslint",
  "prettier",
  "jest",
  "vitest",
  "mocha",
  "chai",
  "tap",
  "ava",
  "nyc",
  "c8",
  "webpack",
  "vite",
  "rollup",
  "esbuild",
  "babel",
  "tsx",
  "ts-node",
  "nodemon",
  "concurrently",
  "rimraf",
  "cross-env",
  "dotenv",
  "husky",
  "lint-staged",
  "black",
  "ruff",
  "flake8",
  "mypy",
  "pytest",
  "tox",
  "isort",
  "coverage",
  "setuptools",
  "wheel",
  "pip",
]);

function isTooling(name: string): boolean {
  if (TOOLING.has(name)) return true;
  if (name.startsWith("@types/")) return true;
  if (name.startsWith("eslint-") || name.startsWith("@eslint/")) return true;
  if (name.startsWith("babel-") || name.startsWith("@babel/")) return true;
  if (name.startsWith("pytest-")) return true;
  return false;
}

/** Runtime dependencies from package.json and requirements.txt. */
export function readDeclaredDependencies(root: string): DeclaredDependency[] {
  const declared: DeclaredDependency[] = [];

  const packageJsonPath = path.join(root, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        declared.push({
          id: `npm:${name}`,
          ecosystem: "npm",
          name,
          version: String(version),
        });
      }
    } catch {
      // a malformed package.json is the repo's problem, not a reason to fail
    }
  }

  const requirementsPath = path.join(root, "requirements.txt");
  if (fs.existsSync(requirementsPath)) {
    for (const line of fs.readFileSync(requirementsPath, "utf8").split("\n")) {
      const dependency = parseRequirement(line);
      if (dependency) declared.push(dependency);
    }
  }

  return declared.sort((a, b) => a.id.localeCompare(b.id));
}

export function parseRequirement(line: string): DeclaredDependency | undefined {
  const withoutComment = line.split("#")[0].trim();
  if (!withoutComment || withoutComment.startsWith("-")) return undefined;
  const match = withoutComment.match(/^([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*(.*)$/);
  if (!match) return undefined;
  const name = match[1];
  return {
    id: `pypi:${name}`,
    ecosystem: "pypi",
    name,
    version: match[3].trim() || "*",
  };
}

/** The local names a module is bound to in one file. */
export function importedBindings(
  source: string,
  language: Language,
  packageName: string,
): string[] {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bindings = new Set<string>();

  if (language === "python") {
    // The import name uses underscores where the distribution uses dashes.
    const moduleName = escaped.replace(/-/g, "[-_]");
    for (const match of source.matchAll(
      new RegExp(`^\\s*import\\s+${moduleName}(?:\\.\\w+)*(?:\\s+as\\s+(\\w+))?`, "gm"),
    )) {
      bindings.add(match[1] ?? packageName.replace(/-/g, "_"));
    }
    for (const match of source.matchAll(
      new RegExp(`^\\s*from\\s+${moduleName}[\\w.]*\\s+import\\s+([^\\n]+)`, "gm"),
    )) {
      for (const part of match[1].split(",")) {
        const alias = part.trim().match(/^([\w*]+)(?:\s+as\s+(\w+))?/);
        if (alias) bindings.add(alias[2] ?? alias[1]);
      }
    }
    return [...bindings].filter((name) => name !== "*");
  }

  // ESM default and namespace imports.
  for (const match of source.matchAll(
    new RegExp(`import\\s+(?:([\\w$]+)|\\*\\s+as\\s+([\\w$]+))\\s*(?:,\\s*\\{([^}]*)\\})?\\s*from\\s*["'\`]${escaped}(?:/[^"'\`]*)?["'\`]`, "g"),
  )) {
    if (match[1]) bindings.add(match[1]);
    if (match[2]) bindings.add(match[2]);
    if (match[3]) for (const name of namedBindings(match[3])) bindings.add(name);
  }
  // ESM named-only imports.
  for (const match of source.matchAll(
    new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["'\`]${escaped}(?:/[^"'\`]*)?["'\`]`, "g"),
  )) {
    for (const name of namedBindings(match[1])) bindings.add(name);
  }
  // CommonJS, including destructuring.
  for (const match of source.matchAll(
    new RegExp(`(?:const|let|var)\\s+(?:([\\w$]+)|\\{([^}]*)\\})\\s*=\\s*require\\(\\s*["'\`]${escaped}(?:/[^"'\`]*)?["'\`]`, "g"),
  )) {
    if (match[1]) bindings.add(match[1]);
    if (match[2]) for (const name of namedBindings(match[2])) bindings.add(name);
  }
  // Side-effect-only import: the package is used, we just cannot see how.
  if (
    bindings.size === 0 &&
    new RegExp(`(?:import|require\\()\\s*["'\`]${escaped}(?:/[^"'\`]*)?["'\`]`).test(source)
  ) {
    bindings.add(packageName);
  }

  return [...bindings];
}

/**
 * One level of aliasing: the client variable an SDK is usually used through.
 *
 *     import OpenAI from "openai";
 *     const client = new OpenAI();   // usage is on `client`, not `OpenAI`
 */
export function aliasBindings(source: string, bindings: string[]): string[] {
  const aliases = new Set<string>();
  for (const binding of bindings) {
    const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(?:(?:const|let|var)\\s+)?([\\w$]+)\\s*(?:=|:)\\s*(?:await\\s+)?(?:new\\s+)?${escaped}\\s*(?:\\(|\\.|;|$)`,
      "gm",
    );
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name !== binding && !bindings.includes(name)) aliases.add(name);
    }
  }
  return [...aliases];
}

function namedBindings(clause: string): string[] {
  return clause
    .split(",")
    .map((part) => {
      const match = part.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?/);
      return match ? (match[2] ?? match[1]) : "";
    })
    .filter(Boolean);
}

/**
 * Usage sites for a set of local bindings, recording the member chain so a
 * changelog entry about `charges.create` can be matched to real code.
 */
export function extractSdkCallSites(
  source: string,
  bindings: string[],
  file: string,
): CallSite[] {
  const sites: CallSite[] = [];
  const seen = new Set<string>();
  const lines = source.split("\n");

  for (const binding of bindings) {
    const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The binding followed by however much of a member chain is written there.
    const pattern = new RegExp(`\\b${escaped}((?:\\s*\\.\\s*[\\w$]+)*)`, "g");
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      const text = lines[line - 1] ?? "";
      if (isImportLine(text)) continue;

      const chain = match[1].replace(/\s+/g, "");
      const member = `${binding}${chain}`;
      const key = `${member}@${line}`;
      if (seen.has(key)) continue;
      seen.add(key);

      sites.push({ file, line, snippet: text.trim().slice(0, 300), member });
    }
  }

  return sites.sort((a, b) => a.line - b.line || (a.member ?? "").localeCompare(b.member ?? ""));
}

function isImportLine(text: string): boolean {
  return /^\s*(import\b|from\b.*\bimport\b|(?:const|let|var)\s+[^=]+=\s*require\()/.test(text);
}

export type SdkScanInput = {
  root: string;
  sources: Map<string, { language: Language; text: string }>;
  includeDeps: string[];
  excludeDeps: string[];
};

export function scanSdkIntegrations(input: SdkScanInput): Integration[] {
  const declared = readDeclaredDependencies(input.root);
  const integrations: Integration[] = [];

  for (const dependency of declared) {
    if (input.excludeDeps.includes(dependency.name)) continue;
    if (!input.includeDeps.includes(dependency.name) && isTooling(dependency.name)) continue;

    const callSites: CallSite[] = [];
    for (const [file, { language, text }] of input.sources) {
      const bindings = importedBindings(text, language, dependency.name);
      if (bindings.length === 0) continue;
      const withAliases = [...bindings, ...aliasBindings(text, bindings)];
      callSites.push(...extractSdkCallSites(text, withAliases, file));
    }

    // Declared but never imported: nothing for an upstream change to affect.
    if (callSites.length === 0) continue;

    integrations.push({
      id: dependency.id,
      kind: "sdk",
      package: dependency.name,
      declaredVersion: dependency.version,
      callSites,
    });
  }

  return integrations;
}
