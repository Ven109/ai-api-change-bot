// Both HTTP adapters are driven through the same tool-call round trip against
// recorded payloads, so the suite needs no network and no API key.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import {
  AnthropicProvider,
  ModelError,
  OpenAiProvider,
  ReplayProvider,
  chatJson,
  createProvider,
  extractJson,
  isLocalBaseUrl,
  type ChatRequest,
  type Message,
} from "../src/model/index.ts";
import { toAnthropicMessages } from "../src/model/anthropic.ts";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acb-model-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

/** Captures requests and replies with queued payloads. */
function recordedFetch(payloads: unknown[]) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const payload = payloads.shift() ?? {};
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const TOOL_ROUND_TRIP: ChatRequest = {
  system: "You migrate API calls.",
  messages: [
    { role: "user", content: "Fix the endpoint." },
    {
      role: "assistant",
      content: "Let me look.",
      toolCalls: [{ id: "call_1", name: "read_file", input: { path: "src/a.js" } }],
    },
    { role: "tool", toolCallId: "call_1", content: "file contents" },
  ],
  tools: [
    {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
};

test("anthropic: request shape, tool calls and usage", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const { fetchImpl, requests } = recordedFetch([
    {
      content: [
        { type: "text", text: "Replacing it." },
        { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "src/b.js" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 120, output_tokens: 30 },
    },
  ]);

  try {
    const provider = new AnthropicProvider({ fetchImpl });
    assert.equal(provider.label, "anthropic/claude-opus-5");
    assert.equal(provider.remote, true);

    const response = await provider.chat(TOOL_ROUND_TRIP);
    assert.equal(response.text, "Replacing it.");
    assert.deepEqual(response.toolCalls, [
      { id: "toolu_1", name: "read_file", input: { path: "src/b.js" } },
    ]);
    assert.equal(response.stopReason, "tool_use");
    assert.deepEqual(provider.usage, { inputTokens: 120, outputTokens: 30 });

    const [request] = requests;
    assert.match(request.url, /\/v1\/messages$/);
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(request.headers["x-api-key"], "test-key");
    assert.equal(request.body.system, "You migrate API calls.");
    assert.equal(request.body.tools[0].input_schema.type, "object");
    // Current Claude models reject sampling parameters, so they are never sent.
    assert.equal("temperature" in request.body, false);
    assert.equal("thinking" in request.body, false);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("anthropic: tool results become tool_result blocks in a user message", () => {
  const messages = toAnthropicMessages(TOOL_ROUND_TRIP.messages);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(messages[1].content[1].type, "tool_use");
  assert.equal(messages[2].content[0].type, "tool_result");

  // Parallel tool results share one user message.
  const parallel: Message[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", name: "t", input: {} },
        { id: "b", name: "t", input: {} },
      ],
    },
    { role: "tool", toolCallId: "a", content: "ra" },
    { role: "tool", toolCallId: "b", content: "rb", isError: true },
  ];
  const mapped = toAnthropicMessages(parallel);
  assert.equal(mapped.length, 3);
  assert.equal(mapped[2].content.length, 2);
  assert.equal((mapped[2].content[1] as { is_error?: boolean }).is_error, true);
});

test("openai-compatible: same round trip, function-call shape", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  const { fetchImpl, requests } = recordedFetch([
    {
      choices: [
        {
          message: {
            content: "Replacing it.",
            tool_calls: [
              {
                id: "call_2",
                function: { name: "read_file", arguments: '{"path":"src/b.js"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    },
  ]);

  try {
    const provider = new OpenAiProvider({ model: "gpt-4o", fetchImpl });
    const response = await provider.chat(TOOL_ROUND_TRIP);
    assert.equal(response.text, "Replacing it.");
    assert.deepEqual(response.toolCalls, [
      { id: "call_2", name: "read_file", input: { path: "src/b.js" } },
    ]);
    assert.deepEqual(provider.usage, { inputTokens: 100, outputTokens: 20 });

    const [request] = requests;
    assert.match(request.url, /\/chat\/completions$/);
    assert.equal(request.headers.authorization, "Bearer test-key");
    assert.deepEqual(
      request.body.messages.map((m: { role: string }) => m.role),
      ["system", "user", "assistant", "tool"],
    );
    assert.equal(request.body.tools[0].type, "function");
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("openai-compatible: a malformed tool call does not throw", async () => {
  process.env.OPENAI_API_KEY = "k";
  const { fetchImpl } = recordedFetch([
    {
      choices: [
        {
          message: { tool_calls: [{ id: "c", function: { name: "t", arguments: "{trunc" } }] },
          finish_reason: "tool_calls",
        },
      ],
    },
  ]);
  try {
    const response = await new OpenAiProvider({ fetchImpl }).chat({ messages: [] });
    assert.deepEqual(response.toolCalls[0].input, {});
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("a local endpoint needs no API key and is not remote", async () => {
  const { fetchImpl, requests } = recordedFetch([{ choices: [{ message: { content: "hi" } }] }]);
  const provider = new OpenAiProvider({
    model: "qwen3-coder",
    baseUrl: "http://localhost:11434/v1",
    fetchImpl,
  });
  assert.equal(provider.remote, false);
  await provider.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(requests[0].headers.authorization, undefined);

  assert.equal(isLocalBaseUrl("http://127.0.0.1:8000/v1"), true);
  assert.equal(isLocalBaseUrl("https://api.openai.com/v1"), false);
});

test("a missing API key names the environment variable", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const { fetchImpl } = recordedFetch([{}]);
  await assert.rejects(
    () => new AnthropicProvider({ fetchImpl }).chat({ messages: [] }),
    (err: Error) => {
      assert.ok(err instanceof ModelError);
      assert.match(err.message, /ANTHROPIC_API_KEY/);
      return true;
    },
  );
});

test("an HTTP error is reported with its status", async () => {
  process.env.OPENAI_API_KEY = "k";
  const fetchImpl = (async () =>
    ({ ok: false, status: 429, text: async () => "slow down" }) as Response) as typeof fetch;
  try {
    await assert.rejects(
      () => new OpenAiProvider({ fetchImpl }).chat({ messages: [] }),
      /429 slow down/,
    );
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("the replay provider matches recordings and says it is not a model", async () => {
  const provider = new ReplayProvider({
    responses: [
      { when: ["migrate"], text: '{"ok":true}' },
      { toolCalls: [{ name: "write_file", input: { path: "a.js", contents: "x" } }] },
    ],
  });
  assert.match(provider.label, /not a live model/);
  assert.equal(provider.remote, false);

  const first = await provider.chat({ messages: [{ role: "user", content: "please migrate" }] });
  assert.equal(first.text, '{"ok":true}');

  const second = await provider.chat({ messages: [{ role: "user", content: "next" }] });
  assert.equal(second.toolCalls[0].name, "write_file");
  assert.equal(second.stopReason, "tool_use");

  await assert.rejects(
    () => provider.chat({ messages: [{ role: "user", content: "third" }] }),
    /no recorded response left/,
  );
});

test("createProvider follows config and env overrides", () => {
  const root = tempDir({
    "acb.config.json": JSON.stringify({ model: { provider: "none" } }),
    "replay.json": JSON.stringify({ responses: [{ text: "{}" }] }),
  });

  assert.equal(createProvider(loadConfig(root)), undefined);

  const anthropicRoot = tempDir({
    "acb.config.json": JSON.stringify({
      model: { provider: "anthropic", model: "claude-sonnet-5" },
    }),
  });
  assert.equal(createProvider(loadConfig(anthropicRoot))?.label, "anthropic/claude-sonnet-5");

  process.env.ACB_PROVIDER = "replay";
  process.env.ACB_REPLAY_FILE = "replay.json";
  try {
    assert.match(createProvider(loadConfig(root))!.label, /replay/);
  } finally {
    delete process.env.ACB_PROVIDER;
    delete process.env.ACB_REPLAY_FILE;
  }
});

test("chatJson extracts JSON, retries once, then gives up", async () => {
  const fenced = new ReplayProvider({
    responses: [{ text: 'Sure!\n```json\n{"relevant": true}\n```' }],
  });
  assert.deepEqual(await chatJson(fenced, { messages: [] }, { requiredKeys: ["relevant"] }), {
    relevant: true,
  });

  const retried = new ReplayProvider({
    responses: [{ text: "no json here" }, { text: '{"relevant": false}' }],
  });
  assert.deepEqual(await chatJson(retried, { messages: [] }), { relevant: false });

  const hopeless = new ReplayProvider({ responses: [{ text: "nope" }, { text: "still nope" }] });
  await assert.rejects(() => chatJson(hopeless, { messages: [] }), /did not return JSON/);

  const missingKey = new ReplayProvider({
    responses: [{ text: '{"a":1}' }, { text: '{"a":1}' }],
  });
  await assert.rejects(
    () => chatJson(missingKey, { messages: [] }, { requiredKeys: ["risk"] }),
    /missing the "risk" field/,
  );
});

test("extractJson handles prose, fences and arrays", () => {
  assert.deepEqual(extractJson('prefix {"a": 1} suffix'), { a: 1 });
  assert.deepEqual(extractJson('```\n[{"a": "}"}]\n```'), [{ a: "}" }]);
  assert.throws(() => extractJson("nothing here"), /did not return JSON/);
});
