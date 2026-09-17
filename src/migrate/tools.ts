// The tools the migration agent may use.
//
// Deliberately small and deliberately boring. Everything resolves inside the
// workspace copy, `..` and absolute paths are rejected, symlinks out of the
// tree are rejected, and the paths in privacy.excludePaths (plus .env files)
// are invisible. There is no general shell: the only commands that ever run
// are the ones the user configured for validation.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { isExcludedPath } from "../model/egress.ts";
import type { ToolSchema } from "../model/provider.ts";
import { isIgnored } from "../scan/walk.ts";
import type { ValidationResult } from "../types.ts";

export class ToolError extends Error {}

export type ToolContext = {
  config: Config;
  workspaceDir: string;
  /** Runs the deterministic validation and returns its result. */
  validate: () => Promise<ValidationResult>;
};

export type ToolOutcome = {
  content: string;
  /** Set by `finish`, which ends the loop. */
  finished?: boolean;
  isError?: boolean;
};

const MAX_READ_BYTES = 120_000;
const MAX_LIST = 400;
const MAX_SEARCH_HITS = 80;

export const AGENT_TOOLS: ToolSchema[] = [
  {
    name: "list_files",
    description:
      "List files in the repository. Optionally filter by a substring or a *.ext suffix.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: 'e.g. "src/" or "*.py"' },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a file, optionally a line range. Lines are 1-based and inclusive.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "search",
    description:
      "Search the repository with a JavaScript regular expression. Returns file:line matches.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        filter: { type: "string", description: "restrict to paths containing this" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "replace_in_file",
    description:
      "Replace an exact string in a file. The old string must appear exactly once, so include " +
      "enough surrounding text to be unambiguous. This is the preferred way to edit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old: { type: "string" },
        new: { type: "string" },
      },
      required: ["path", "old", "new"],
    },
  },
  {
    name: "write_file",
    description:
      "Write a file in full, creating it if needed. Prefer replace_in_file for edits to " +
      "existing files.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, contents: { type: "string" } },
      required: ["path", "contents"],
    },
  },
  {
    name: "run_validation",
    description:
      "Run the repository's configured checks, the residual-usage check and the HTTP contract " +
      "check, and return the result. Use this to confirm your work.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "finish",
    description:
      "Finish the migration. Call this once validation passes, or to explain why you cannot " +
      "complete it.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "what you changed, and why" },
        incomplete: { type: "boolean", description: "true if you could not finish" },
      },
      required: ["summary"],
    },
  },
];

/** Resolve a model-supplied path inside the workspace, or refuse. */
export function resolveInWorkspace(context: ToolContext, candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new ToolError("path must be a non-empty string");
  }
  if (path.isAbsolute(candidate)) {
    throw new ToolError(`absolute paths are not allowed: ${candidate}`);
  }

  const relative = path.normalize(candidate);
  if (relative.startsWith("..") || relative.split(path.sep).includes("..")) {
    throw new ToolError(`path escapes the workspace: ${candidate}`);
  }
  if (isExcludedPath(relative, context.config.privacy.excludePaths)) {
    throw new ToolError(`${relative} is excluded by privacy.excludePaths`);
  }
  if (isIgnored(relative, context.config.ignore)) {
    throw new ToolError(`${relative} is outside the scanned tree`);
  }

  const absolute = path.resolve(context.workspaceDir, relative);
  const root = path.resolve(context.workspaceDir);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new ToolError(`path escapes the workspace: ${candidate}`);
  }
  // A symlink could point anywhere; the real path has to stay inside too.
  if (fs.existsSync(absolute)) {
    const real = fs.realpathSync(absolute);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new ToolError(`path escapes the workspace through a link: ${candidate}`);
    }
  }
  return absolute;
}

export async function runTool(
  context: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "list_files":
        return { content: listFiles(context, input.filter) };
      case "read_file":
        return { content: readFile(context, input) };
      case "search":
        return { content: search(context, input) };
      case "replace_in_file":
        return { content: replaceInFile(context, input) };
      case "write_file":
        return { content: writeFile(context, input) };
      case "run_validation": {
        const result = await context.validate();
        return { content: renderValidation(result) };
      }
      case "finish":
        return {
          content: String(input.summary ?? ""),
          finished: true,
        };
      default:
        return { content: `unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    // Tool errors are information for the model, not crashes.
    return { content: (err as Error).message, isError: true };
  }
}

function walkFiles(context: ToolContext): string[] {
  const files: string[] = [];
  const visit = (relativeDir: string): void => {
    const absolute = path.join(context.workspaceDir, relativeDir);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relative = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (isIgnored(relative, [...context.config.ignore, ".git"])) continue;
      if (isExcludedPath(relative, context.config.privacy.excludePaths)) continue;
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  visit("");
  return files.sort();
}

function matchesFilter(file: string, filter: unknown): boolean {
  if (typeof filter !== "string" || filter === "") return true;
  if (filter.startsWith("*")) return file.endsWith(filter.slice(1));
  return file.includes(filter);
}

function listFiles(context: ToolContext, filter: unknown): string {
  const files = walkFiles(context).filter((file) => matchesFilter(file, filter));
  const shown = files.slice(0, MAX_LIST);
  const suffix = files.length > shown.length ? `\n… ${files.length - shown.length} more` : "";
  return shown.join("\n") + suffix || "(no files)";
}

function readFile(context: ToolContext, input: Record<string, unknown>): string {
  const file = resolveInWorkspace(context, input.path);
  if (!fs.existsSync(file)) throw new ToolError(`${input.path} does not exist`);
  const text = fs.readFileSync(file, "utf8");

  const start = Number(input.startLine ?? 1);
  const end = Number(input.endLine ?? Number.MAX_SAFE_INTEGER);
  const lines = text.split("\n");
  const from = Math.max(1, Number.isFinite(start) ? start : 1);
  const to = Math.min(lines.length, Number.isFinite(end) ? end : lines.length);

  const body = lines
    .slice(from - 1, to)
    .map((line, index) => `${from + index}| ${line}`)
    .join("\n");
  return body.slice(0, MAX_READ_BYTES);
}

function search(context: ToolContext, input: Record<string, unknown>): string {
  let pattern: RegExp;
  try {
    pattern = new RegExp(String(input.pattern), "g");
  } catch (err) {
    throw new ToolError(`invalid regular expression: ${(err as Error).message}`);
  }

  const hits: string[] = [];
  for (const file of walkFiles(context)) {
    if (!matchesFilter(file, input.filter)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(context.workspaceDir, file), "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((line, index) => {
      pattern.lastIndex = 0;
      if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 200)}`);
    });
    if (hits.length >= MAX_SEARCH_HITS) break;
  }
  return hits.length ? hits.slice(0, MAX_SEARCH_HITS).join("\n") : "(no matches)";
}

function replaceInFile(context: ToolContext, input: Record<string, unknown>): string {
  const file = resolveInWorkspace(context, input.path);
  if (!fs.existsSync(file)) throw new ToolError(`${input.path} does not exist`);
  const oldText = String(input.old ?? "");
  const newText = String(input.new ?? "");
  if (oldText === "") throw new ToolError("old must not be empty");

  const text = fs.readFileSync(file, "utf8");
  const occurrences = text.split(oldText).length - 1;
  if (occurrences === 0) {
    throw new ToolError(
      `that exact text is not in ${input.path}. Read the file and copy the text verbatim.`,
    );
  }
  if (occurrences > 1) {
    throw new ToolError(
      `that text appears ${occurrences} times in ${input.path}. Include more surrounding ` +
        `context so it is unique.`,
    );
  }

  fs.writeFileSync(file, text.replace(oldText, newText));
  return `replaced 1 occurrence in ${input.path}`;
}

function writeFile(context: ToolContext, input: Record<string, unknown>): string {
  const file = resolveInWorkspace(context, input.path);
  const contents = String(input.contents ?? "");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, contents);
  return `${existed ? "wrote" : "created"} ${input.path} (${contents.length} characters)`;
}

export function renderValidation(result: ValidationResult): string {
  const lines = [result.passed ? "VALIDATION PASSED" : "VALIDATION FAILED", ""];
  for (const check of result.checks) {
    lines.push(`## ${check.name}: ${check.passed ? "passed" : "FAILED"}`);
    lines.push(check.details.trim().slice(0, 4000));
    lines.push("");
  }
  return lines.join("\n");
}
