// The isolated copy a migration happens in.
//
// acb never edits the user's working tree. It copies the repository into
// .acb/work/<id>, commits that copy to a throwaway git repo, lets the agent
// work there, and turns the result into a patch. The copy-and-init approach is
// used even when the source repository is itself git: it keeps one code path,
// and it includes uncommitted work, which a `git worktree` would silently
// leave behind.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.ts";
import { debug } from "../log.ts";
import { isIgnored } from "../scan/walk.ts";
import { acbPaths } from "../state.ts";

const execFileAsync = promisify(execFile);

export type Workspace = {
  /** Absolute path of the copy. */
  dir: string;
  /** Files copied, repo-relative. */
  files: string[];
};

/** Files that exist only for the agent and must not appear in the patch. */
export const AGENT_FILES = ["ACB_TASK.md"];

export async function createWorkspace(config: Config, id: string): Promise<Workspace> {
  const dir = path.join(acbPaths(config.root).work, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const files = copyTree(config, dir);
  debug(`workspace ${dir}: ${files.length} file(s)`);

  // A throwaway git repo is the simplest way to get an exact patch later.
  await git(dir, ["init", "-q", "-b", "acb-base"]);
  // Running the repository's checks produces build artefacts (bytecode caches,
  // coverage output). They must never reach the patch, and the repository's own
  // ignore rules may not cover them, so exclude them here.
  writeWorkspaceExcludes(config, dir);
  await git(dir, ["config", "user.email", "acb@localhost"]);
  await git(dir, ["config", "user.name", "acb"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "--no-gpg-sign", "-m", "baseline"]);

  return { dir, files };
}

/** .git/info/exclude keeps generated files out of the patch, repo-side rules or not. */
function writeWorkspaceExcludes(config: Config, dir: string): void {
  const patterns = [
    ...config.ignore.filter((pattern) => pattern !== ".git"),
    ...AGENT_FILES,
    "__pycache__/",
    "*.pyc",
    ".pytest_cache/",
    ".ruff_cache/",
    ".mypy_cache/",
    "*.log",
    ".coverage",
    "coverage/",
  ];
  const file = path.join(dir, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, patterns.join("\n") + "\n");
}

function copyTree(config: Config, destination: string): string[] {
  const copied: string[] = [];
  const ignore = [...config.ignore, ".git"];

  const visit = (relativeDir: string): void => {
    const absolute = path.join(config.root, relativeDir);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relative = path.join(relativeDir, entry.name);
      if (isIgnored(relative, ignore)) continue;
      if (entry.isSymbolicLink()) continue; // never follow links out of the tree
      const target = path.join(destination, relative);
      if (entry.isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        visit(relative);
      } else if (entry.isFile()) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(config.root, relative), target);
        copied.push(relative);
      }
    }
  };

  visit("");
  return copied.sort();
}

/** The migration as a patch that applies to the original repository. */
export async function diffWorkspace(workspace: Workspace): Promise<string> {
  // Agent scratch files are staged-then-removed so they never reach the patch.
  for (const file of AGENT_FILES) {
    const full = path.join(workspace.dir, file);
    if (fs.existsSync(full)) fs.rmSync(full);
  }
  await git(workspace.dir, ["add", "-A"]);
  const { stdout } = await git(workspace.dir, [
    "diff",
    "--cached",
    "--no-color",
    "--no-ext-diff",
  ]);
  return stdout;
}

export async function changedFiles(workspace: Workspace): Promise<string[]> {
  await git(workspace.dir, ["add", "-A"]);
  const { stdout } = await git(workspace.dir, ["diff", "--cached", "--name-only"]);
  return stdout.split("\n").filter(Boolean);
}

export function removeWorkspace(workspace: Workspace): void {
  fs.rmSync(workspace.dir, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 });
}
