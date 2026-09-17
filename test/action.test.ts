// The action and the example workflow are configuration, so the useful test is
// that they stay consistent with the CLI they wrap.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO = path.join(import.meta.dirname, "..");
const action = fs.readFileSync(path.join(REPO, "action.yml"), "utf8");
const workflow = fs.readFileSync(path.join(REPO, "examples", "github-workflow.yml"), "utf8");
const ci = fs.readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");

test("the action runs the CLI itself, so local and CI behaviour match", () => {
  assert.match(action, /bin\/acb" run/);
  assert.match(action, /node-version: "22"/);
  // Inputs the README documents.
  for (const input of ["provider", "model", "base-url", "api-key", "args", "pull-request"]) {
    assert.match(action, new RegExp(`^  ${input}:`, "m"), input);
  }
  // Env names must match what the providers actually read.
  assert.match(action, /ACB_PROVIDER:/);
  assert.match(action, /ANTHROPIC_API_KEY:/);
  assert.match(action, /OPENAI_API_KEY:/);
});

test("the action treats exit 2 as a result, not a failure", () => {
  assert.match(action, /if \[ "\$code" = "1" \]; then exit 1; fi/);
  assert.match(action, /GITHUB_STEP_SUMMARY/);
  assert.match(action, /exit-code=/);
});

test("the action persists the state that makes runs incremental", () => {
  assert.match(action, /actions\/cache@v4/);
  assert.match(action, /\.acb/);
  // The trade-off is documented where someone will read it.
  assert.match(action, /commit \.acb\/ instead/i);
});

test("the example workflow has the permissions it needs and nothing more", () => {
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /permissions: write-all/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /secrets\.ANTHROPIC_API_KEY/);
  // A key-free way to try it is offered.
  assert.match(workflow, /provider: replay/);
});

test("acb's own CI runs the offline demo and the fixture suites", () => {
  assert.match(ci, /npm test/);
  assert.match(ci, /npm run typecheck/);
  assert.match(ci, /npm run demo/);
  assert.match(ci, /python3 -m unittest/);
  assert.doesNotMatch(ci, /ANTHROPIC_API_KEY/, "CI must not need a key");
});
