// The README is the product for an open-source prototype, so it gets the same
// treatment as code: a test that stops it drifting from the implementation.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.ts";
import { DEFAULT_ANTHROPIC_MODEL } from "../src/model/anthropic.ts";

const REPO = path.join(import.meta.dirname, "..");
const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");

test("every command is documented", () => {
  const cli = fs.readFileSync(path.join(REPO, "src", "cli.ts"), "utf8");
  // The commands the dispatcher actually handles.
  const commands = [...cli.matchAll(/^\s*case "([a-z]+)":/gm)].map((match) => match[1]);
  assert.ok(commands.length >= 6, commands.join(", "));

  for (const command of commands) {
    if (command === "version" || command === "help") continue;
    assert.match(readme, new RegExp(`acb ${command}\\b`), `README should document acb ${command}`);
  }
});

test("every top-level config key is documented", () => {
  const config = parseConfig(undefined, "/repo");
  for (const key of Object.keys(config)) {
    if (["root", "configPath"].includes(key)) continue; // derived, not user-set
    assert.match(readme, new RegExp(`\\b${key}\\b`), `README should mention "${key}"`);
  }
});

test("every model provider is documented", () => {
  for (const provider of ["anthropic", "openai", "replay", "none"]) {
    assert.match(readme, new RegExp(`\`${provider}\``), provider);
  }
  // The current default model, so the docs cannot claim an old one.
  assert.match(readme, new RegExp(DEFAULT_ANTHROPIC_MODEL));
});

test("the deterministic/LLM boundary is spelled out", () => {
  assert.match(readme, /\[deterministic\]/);
  assert.match(readme, /--no-llm/);
  assert.match(readme, /--dry-run-llm/);
  assert.match(readme, /local-only/);
  assert.match(readme, /excludePaths/);
  assert.match(readme, /never merged|cannot merge/i);
});

test("the quickstart and the limitations are both there", () => {
  assert.match(readme, /npm run demo/);
  assert.match(readme, /## Limitations, honestly/);
  // Claims that would be wrong if the code changed.
  assert.match(readme, /no required runtime dependencies/);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined, "README promises no required runtime dependencies");
  // The agent SDK must stay optional: acb has to install and run without it.
  assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}), [
    "@anthropic-ai/claude-agent-sdk",
  ]);
});
