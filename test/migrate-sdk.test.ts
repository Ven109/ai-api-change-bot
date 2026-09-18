// The Agent SDK adapter and agent selection. The SDK itself is injected, so
// these run offline and without the package installed.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { explainSelection, selectAgent } from "../src/migrate/select.ts";
import { makePermissionCheck, runSdkAgent, type SdkQuery } from "../src/migrate/sdk-agent.ts";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acb-sdk-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.js"), "export const a = 1;\n");
  return dir;
}

/** A stand-in for the SDK's query(), yielding the message shapes it emits. */
function fakeQuery(messages: Record<string, unknown>[]): SdkQuery {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  });
}

test("tool calls and the final summary are captured", async () => {
  const dir = workspace();
  const result = await runSdkAgent({
    config: parseConfig(undefined, dir),
    workspaceDir: dir,
    brief: "# task",
    query: fakeQuery([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Looking at the call sites." },
            { type: "tool_use", name: "Read", input: { file_path: "src/a.js" } },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.js" } }],
        },
      },
      { type: "result", result: "Moved both call sites to /data/3.0/onecall." },
    ]),
  });

  assert.deepEqual(
    result.events.map((event) => `${event.name} ${event.detail}`),
    ["Read src/a.js", "Edit src/a.js"],
  );
  assert.match(result.summary, /Moved both call sites/);
  assert.equal(result.error, undefined);
  assert.equal(result.turns, 3);
});

test("an error result is reported rather than thrown", async () => {
  const dir = workspace();
  const result = await runSdkAgent({
    config: parseConfig(undefined, dir),
    workspaceDir: dir,
    brief: "# task",
    query: fakeQuery([{ type: "result", subtype: "error", result: "hit the turn limit" }]),
  });
  assert.match(result.error ?? "", /turn limit/);
});

test("a thrown error keeps whatever was collected", async () => {
  const dir = workspace();
  const query: SdkQuery = () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/a.js" } }] },
      };
      throw new Error("transport closed");
    },
  });

  const result = await runSdkAgent({
    config: parseConfig(undefined, dir),
    workspaceDir: dir,
    brief: "# task",
    query,
  });
  assert.equal(result.events.length, 1);
  assert.match(result.error ?? "", /transport closed/);
});

test("the permission hook confines the agent to the workspace", async () => {
  const dir = workspace();
  const config = parseConfig({ privacy: { excludePaths: ["secrets"] } }, dir);
  const check = makePermissionCheck(config, dir);

  const allowed = await check("Edit", { file_path: "src/a.js" });
  assert.equal(allowed.behavior, "allow");

  for (const [file, why] of [
    ["../outside.js", /outside the migration workspace/],
    ["/etc/passwd", /outside the migration workspace/],
    [".env", /excludePaths/],
    ["secrets/prod.json", /excludePaths/],
    ["node_modules/x/index.js", /outside the scanned tree/],
  ] as [string, RegExp][]) {
    const decision = await check("Read", { file_path: file });
    assert.equal(decision.behavior, "deny", file);
    assert.match(decision.behavior === "deny" ? decision.message : "", why, file);
  }
});

test("tools that reach outside the migration are denied", async () => {
  const dir = workspace();
  const check = makePermissionCheck(parseConfig(undefined, dir), dir);

  for (const tool of ["Bash", "WebFetch", "WebSearch", "Task"]) {
    const decision = await check(tool, {});
    assert.equal(decision.behavior, "deny", tool);
    assert.match(decision.behavior === "deny" ? decision.message : "", new RegExp(tool));
  }

  // An edit inside the workspace is allowed, and the input is passed through
  // unchanged — the SDK requires it back on an allow decision.
  const allowed = await check("Write", { file_path: "src/new.js", content: "x" });
  assert.deepEqual(allowed, {
    behavior: "allow",
    updatedInput: { file_path: "src/new.js", content: "x" },
  });
});

test("explicit configuration always wins over detection", async () => {
  const dir = workspace();

  const builtin = await selectAgent(parseConfig({ migrate: { agent: { type: "builtin" } } }, dir));
  assert.equal(builtin.kind, "builtin");

  const sdk = await selectAgent(parseConfig({ migrate: { agent: { type: "sdk" } } }, dir));
  assert.equal(sdk.kind, "sdk");

  const command = await selectAgent(
    parseConfig(
      { migrate: { agent: { type: "command", command: "my-agent --go", promptVia: "stdin" } } },
      dir,
    ),
  );
  assert.equal(command.kind, "command");
  assert.equal(command.kind === "command" && command.command, "my-agent --go");
  assert.equal(command.kind === "command" && command.promptVia, "stdin");
});

test("auto picks a real agent on this machine, and says so", async () => {
  const dir = workspace();
  const selected = await selectAgent(parseConfig(undefined, dir));

  // Whatever is installed here, auto must never silently choose our own loop
  // when a real agent exists, and must always explain the choice.
  assert.ok(["sdk", "command", "builtin"].includes(selected.kind));
  const explanation = explainSelection(selected);
  assert.match(explanation, /^agent: /);
  if (selected.kind === "builtin") {
    assert.match(explanation, /claude-agent-sdk|claude\/codex\/aider/);
  } else {
    assert.match(explanation, /auto-detected|command:/);
  }
});

test("auto does not pick the SDK when nothing can authenticate", async () => {
  const dir = workspace();
  const key = process.env.ANTHROPIC_API_KEY;
  const realPath = process.env.PATH;
  delete process.env.ANTHROPIC_API_KEY;
  // An empty PATH means no claude/codex/aider binary is reachable.
  process.env.PATH = "";
  try {
    const selected = await selectAgent(parseConfig(undefined, dir));
    // Installed-but-unusable must not win: CI installs the optional SDK and
    // has no credentials, and picking it there broke every migration.
    assert.equal(selected.kind, "builtin");
  } finally {
    process.env.PATH = realPath;
    if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
  }
});

test("the config rejects an unknown agent type", () => {
  assert.throws(
    () => parseConfig({ migrate: { agent: { type: "magic" } } }, "/repo"),
    /"auto", "sdk", "builtin" or "command"/,
  );
});
