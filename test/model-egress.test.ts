import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig, parseConfig } from "../src/config.ts";
import {
  DryRunError,
  EgressGuard,
  guard,
  isExcludedPath,
  redactSecrets,
} from "../src/model/egress.ts";
import { AnthropicProvider, ModelError, ReplayProvider } from "../src/model/index.ts";
import { acbPaths } from "../src/state.ts";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acb-egress-"));
  tempDirs.push(dir);
  return dir;
}

function replay(text = "{}") {
  return new ReplayProvider({ responses: [{ text }] });
}

test("secret values are redacted, their names are not", () => {
  const cases: [string, RegExp][] = [
    ['const key = "sk-abcdef1234567890";', /sk-abcdef/],
    ['ANTHROPIC_API_KEY=sk-ant-api03-averylongsecretvalue', /sk-ant-api03/],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", /Bearer eyJ/],
    ['{"api_key": "9f8e7d6c5b4a3210"}', /9f8e7d6c/],
    ["?appid=0123456789abcdef0123456789abcdef", /0123456789abcdef/],
    ["AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", /AKIAIOSFODNN7/],
    ["token: ghp_0123456789abcdefghijklmnopqrstuvwx", /ghp_0123/],
  ];

  for (const [input, secret] of cases) {
    const { text, count } = redactSecrets(input);
    assert.ok(count > 0, `expected a redaction in: ${input}`);
    assert.doesNotMatch(text, secret, `secret survived in: ${text}`);
    assert.match(text, /\[REDACTED\]/);
  }

  // The surrounding code and the key's name survive, so the model still has
  // enough context to migrate the call.
  const { text } = redactSecrets('const url = `${BASE}/onecall?appid=${apiKey}&lat=1`;');
  assert.match(text, /BASE.*onecall/);

  const untouched = redactSecrets("plain source with no secrets");
  assert.equal(untouched.count, 0);
  assert.equal(untouched.text, "plain source with no secrets");
});

test("the guard redacts what it forwards and counts it", async () => {
  const inner = replay('{"ok":true}');
  const guarded = new EgressGuard(inner, { config: parseConfig(undefined, tempRoot()) });

  await guarded.chat({
    system: "migrate",
    messages: [{ role: "user", content: 'key = "sk-abcdef1234567890"' }],
  });

  assert.equal(guarded.stats.requests, 1);
  // At least one: a quoted `key = "sk-…"` trips both the sk- rule and the
  // name/value rule, and double-redacting is the safe direction.
  assert.ok(guarded.stats.redactions >= 1);
  assert.ok(guarded.stats.charactersSent > 0);
  assert.match(guarded.summary(), /1 request\(s\)/);
});

test("--dry-run-llm writes the prompt and sends nothing", async () => {
  const root = tempRoot();
  const inner = replay();
  const guarded = new EgressGuard(inner, {
    config: parseConfig(undefined, root),
    dryRun: true,
  });

  await assert.rejects(
    () => guarded.chat({ messages: [{ role: "user", content: "hello" }] }),
    (err: Error) => {
      assert.ok(err instanceof DryRunError);
      const written = JSON.parse(fs.readFileSync(err.file, "utf8"));
      assert.equal(written.request.messages[0].content, "hello");
      return true;
    },
  );

  // Nothing was consumed from the recording: the request never went anywhere.
  const stillAvailable = await inner.chat({ messages: [{ role: "user", content: "hello" }] });
  assert.equal(stillAvailable.text, "{}");
  assert.match(guarded.summary(), /Dry run/);
  assert.ok(fs.existsSync(acbPaths(root).egress));
});

test("local-only refuses a remote provider, with advice", () => {
  const config = parseConfig({ privacy: { mode: "local-only" } }, tempRoot());
  assert.throws(
    () => new EgressGuard(new AnthropicProvider(), { config }),
    (err: Error) => {
      assert.ok(err instanceof ModelError);
      assert.match(err.message, /local-only/);
      assert.match(err.message, /localhost:11434/);
      return true;
    },
  );

  // A local or replay provider is fine under the same policy.
  assert.ok(new EgressGuard(replay(), { config }));
});

test("guard() is a no-op without a provider", () => {
  assert.equal(guard(undefined, { config: parseConfig(undefined, tempRoot()) }), undefined);
});

test("excluded paths cover the configured list and dotenv files", () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, "acb.config.json"), JSON.stringify({
    privacy: { excludePaths: ["secrets", "*.pem"] },
  }));
  const { privacy } = loadConfig(root);

  for (const excluded of [".env", ".env.local", "secrets/prod.json", "certs/key.pem"]) {
    assert.equal(isExcludedPath(excluded, privacy.excludePaths), true, excluded);
  }
  for (const allowed of ["src/weather.js", "README.md", "tests/test_client.py"]) {
    assert.equal(isExcludedPath(allowed, privacy.excludePaths), false, allowed);
  }
});
