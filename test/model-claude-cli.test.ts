import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { ClaudeCliProvider, createProvider, ModelError } from "../src/model/index.ts";
import { renderPrompt, stripNotices } from "../src/model/claude-cli.ts";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the `claude` binary, so these tests need no CLI and no login. */
function fakeClaude(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acb-cli-"));
  tempDirs.push(dir);
  const file = path.join(dir, "fake-claude");
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test("the prompt reaches the CLI on stdin and the answer comes back", async () => {
  // Echoes the prompt it was given, wrapped in JSON.
  const binary = fakeClaude('printf \'{"got":"\'; cat; printf \'"}\'');
  const provider = new ClaudeCliProvider({ binary });

  const response = await provider.chat({
    system: "You judge API changes.",
    messages: [{ role: "user", content: "Is this relevant?" }],
  });

  assert.match(response.text, /You judge API changes/);
  assert.match(response.text, /Is this relevant\?/);
  assert.equal(response.stopReason, "end_turn");
  assert.equal(provider.label, "claude-cli");
});

test("the model name is passed through when set", async () => {
  const binary = fakeClaude('echo "args: $*"');
  const provider = new ClaudeCliProvider({ binary, model: "opus" });
  const response = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.match(response.text, /--model opus/);
  assert.equal(provider.label, "claude-cli/opus");
});

test("it counts as remote, so local-only still refuses it", () => {
  // It reaches Anthropic; only the credential differs from the API provider.
  assert.equal(new ClaudeCliProvider().remote, true);
});

test("tool calls are refused loudly rather than silently dropped", async () => {
  const provider = new ClaudeCliProvider({ binary: fakeClaude("echo hi") });
  await assert.rejects(
    () =>
      provider.chat({
        messages: [{ role: "user", content: "go" }],
        tools: [{ name: "t", description: "d", inputSchema: {} }],
      }),
    (err: Error) => {
      assert.ok(err instanceof ModelError);
      assert.match(err.message, /cannot do tool calls/);
      return true;
    },
  );
});

test("a missing binary explains what to install", async () => {
  const provider = new ClaudeCliProvider({ binary: "/nonexistent/claude" });
  await assert.rejects(
    () => provider.chat({ messages: [{ role: "user", content: "hi" }] }),
    /Install the Claude Code CLI|could not run/,
  );
});

test("a failing CLI surfaces its exit code and stderr", async () => {
  const provider = new ClaudeCliProvider({
    binary: fakeClaude('echo "not logged in" >&2; exit 1'),
  });
  await assert.rejects(
    () => provider.chat({ messages: [{ role: "user", content: "hi" }] }),
    /exited with 1.*not logged in/s,
  );
});

test("a hanging CLI is stopped", async () => {
  const provider = new ClaudeCliProvider({ binary: fakeClaude("sleep 10"), timeoutMs: 300 });
  await assert.rejects(
    () => provider.chat({ messages: [{ role: "user", content: "hi" }] }),
    /timed out/,
  );
});

test("config selects it, and it needs no API key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-cli-cfg-"));
  tempDirs.push(root);
  fs.writeFileSync(
    path.join(root, "acb.config.json"),
    JSON.stringify({ model: { provider: "claude-cli", model: "opus" } }),
  );

  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const provider = createProvider(loadConfig(root));
    assert.equal(provider?.label, "claude-cli/opus");
  } finally {
    if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
  }
});

test("helpers: prompt flattening and notice stripping", () => {
  const prompt = renderPrompt({
    system: "S",
    messages: [
      { role: "user", content: "U" },
      { role: "assistant", content: "A" },
      { role: "tool", toolCallId: "t", content: "T" },
    ],
  });
  assert.match(prompt, /^S\n\n---\n\nU\n\n\(your previous answer\)\nA\n\n\(tool result\)\nT$/);

  assert.equal(stripNotices('[mcp-sdk] notice\n{"a":1}'), '{"a":1}');
  assert.equal(stripNotices('{"a":1}'), '{"a":1}');
  // Real prose before JSON is not a notice, so it survives for the extractor.
  assert.match(stripNotices('Here is the answer: {"a":1}'), /^Here is the answer/);
});
