// Layout of the .acb/ state directory, plus small JSON helpers.
//
//   .acb/manifest.json   what this repo integrates with (commit it)
//   .acb/state.json      which upstream changes we have already seen (commit it)
//   .acb/changes.json    the change entries the last `check` reported
//   .acb/specs/          snapshots of upstream OpenAPI specs (commit them)
//   .acb/reports/        impact reports and agent transcripts
//   .acb/patches/        generated patches
//   .acb/egress/         --dry-run-llm prompt dumps
//   .acb/observations/   recorded field profiles per endpoint (commit them)
//   .acb/work/           throwaway migration workspaces (do not commit)

import fs from "node:fs";
import path from "node:path";
import { ACB_DIR } from "./config.ts";

export type AcbPaths = {
  dir: string;
  manifest: string;
  state: string;
  changes: string;
  specs: string;
  reports: string;
  patches: string;
  egress: string;
  observations: string;
  work: string;
};

export function acbPaths(root: string): AcbPaths {
  const dir = path.join(root, ACB_DIR);
  return {
    dir,
    manifest: path.join(dir, "manifest.json"),
    state: path.join(dir, "state.json"),
    changes: path.join(dir, "changes.json"),
    specs: path.join(dir, "specs"),
    reports: path.join(dir, "reports"),
    patches: path.join(dir, "patches"),
    egress: path.join(dir, "egress"),
    observations: path.join(dir, "observations"),
    work: path.join(dir, "work"),
  };
}

/** State persisted between runs: what we have already reported on. */
export type AcbState = {
  version: 1;
  /** integrationId -> change entry ids already emitted. */
  seen: Record<string, string[]>;
  /** integrationId -> resolved source descriptors, cached. */
  resolvedSources?: Record<string, unknown>;
  lastRunAt?: string;
};

export function emptyState(): AcbState {
  return { version: 1, seen: {} };
}

export function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/** Write pretty JSON with a trailing newline, creating parent dirs as needed. */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function readState(root: string): AcbState {
  return readJson<AcbState>(acbPaths(root).state, emptyState());
}

export function writeState(root: string, state: AcbState): void {
  writeJson(acbPaths(root).state, state);
}

/** Write a text file, creating parent directories as needed. */
export function writeFile(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents.endsWith("\n") ? contents : contents + "\n");
}
