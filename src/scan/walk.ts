// Finding the files worth parsing. Deliberately boring: a recursive walk with
// an ignore list, a size cap and an extension allowlist.

import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".py",
]);

const SPEC_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);

/** Files bigger than this are almost always generated or vendored. */
const MAX_FILE_BYTES = 1_000_000;

export type Language = "js" | "python";

export function languageOf(file: string): Language | undefined {
  const ext = path.extname(file);
  if (ext === ".py") return "python";
  if (SOURCE_EXTENSIONS.has(ext)) return "js";
  return undefined;
}

/**
 * Ignore matching, kept to the shapes that actually show up in config: a plain
 * directory or file name, a `*.ext` suffix glob, a `.env.*` prefix glob, and a
 * path prefix.
 */
export function isIgnored(relativePath: string, patterns: string[]): boolean {
  const segments = relativePath.split(path.sep);
  return patterns.some((pattern) => {
    if (pattern.startsWith("*")) {
      const suffix = pattern.slice(1);
      return segments.some((segment) => segment.endsWith(suffix));
    }
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return segments.some((segment) => segment.startsWith(prefix));
    }
    if (pattern.includes("/")) {
      const normalized = pattern.replace(/^\.\//, "").replace(/\/$/, "");
      return relativePath === normalized || relativePath.startsWith(normalized + path.sep);
    }
    return segments.includes(pattern);
  });
}

export type WalkResult = {
  /** Source files to parse for API usage, repo-relative. */
  sourceFiles: string[];
  /** Candidate OpenAPI/Swagger documents, repo-relative. */
  specFiles: string[];
};

export function walkRepo(root: string, ignore: string[]): WalkResult {
  const sourceFiles: string[] = [];
  const specFiles: string[] = [];

  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: not worth failing a scan over
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (isIgnored(relative, ignore)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name);
      const isSource = SOURCE_EXTENSIONS.has(ext);
      const isSpecCandidate = SPEC_EXTENSIONS.has(ext);
      if (!isSource && !isSpecCandidate) continue;

      let size = 0;
      try {
        size = fs.statSync(absolute).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;

      if (isSource) sourceFiles.push(relative);
      else if (isSpecCandidate && looksLikeApiSpec(absolute)) specFiles.push(relative);
    }
  };

  visit(root);
  sourceFiles.sort();
  specFiles.sort();
  return { sourceFiles, specFiles };
}

/** Cheap sniff for an OpenAPI/Swagger document: only the head of the file. */
export function looksLikeApiSpec(absolutePath: string): boolean {
  let head: string;
  try {
    const fd = fs.openSync(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytes).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  return /"(openapi|swagger)"\s*:/.test(head) || /^\s*(openapi|swagger)\s*:/m.test(head);
}
