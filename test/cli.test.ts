// Exercises the CLI the way a user does: by running bin/acb.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";

const execFileAsync = promisify(execFile);
const BIN = path.join(import.meta.dirname, "..", "bin", "acb");

const tempDirs: string[] = [];

function tempRepo(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acb-cli-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function acb(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [BIN, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("acb --help lists the commands and exits 0", async () => {
  const { code, stdout } = await acb(["--help"]);
  assert.equal(code, 0);
  for (const command of ["scan", "check", "impact", "migrate", "run"]) {
    assert.match(stdout, new RegExp(`\\b${command}\\b`));
  }
});

test("per-command help explains the deterministic/LLM split", async () => {
  const { code, stdout } = await acb(["impact", "--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /\[deterministic\]/);
  assert.match(stdout, /\[LLM\]/);
});

test("acb config works without a config file", async () => {
  const root = tempRepo();
  const { code, stdout } = await acb(["config", "--cwd", root]);
  assert.equal(code, 0);
  assert.match(stdout, /deterministic-only mode/);
});

test("acb config --json prints the effective config", async () => {
  const root = tempRepo({
    "acb.config.json": JSON.stringify({ validate: { commands: ["node --test"] } }),
  });
  const { code, stdout } = await acb(["config", "--cwd", root, "--json"]);
  assert.equal(code, 0);
  const config = JSON.parse(stdout);
  assert.deepEqual(config.validate.commands, ["node --test"]);
});

test("a bad config exits 1 and names the field", async () => {
  const root = tempRepo({ "acb.config.json": JSON.stringify({ model: { provider: "nope" } }) });
  const { code, stderr } = await acb(["config", "--cwd", root]);
  assert.equal(code, 1);
  assert.match(stderr, /model\.provider/);
});

test("an unknown command exits 1", async () => {
  const { code, stderr } = await acb(["frobnicate"]);
  assert.equal(code, 1);
  assert.match(stderr, /unknown command/);
});
