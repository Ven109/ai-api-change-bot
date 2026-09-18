import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { CONFIG_FILENAME, ConfigError, loadConfig, parseConfig } from "../src/config.ts";
import { acbPaths } from "../src/state.ts";
import { parseArgs } from "../src/cli.ts";
import { EXIT_ACTION_REQUIRED, EXIT_ERROR, EXIT_OK } from "../src/log.ts";

const tempDirs: string[] = [];

function tempRepo(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acb-config-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("a repo with no config file gets deterministic-only defaults", () => {
  const root = tempRepo();
  const config = loadConfig(root);
  assert.equal(config.model.provider, "none");
  assert.equal(config.configPath, undefined);
  assert.equal(config.impact.minScore, 0.4);
  // "auto" means: use a real coding agent if this machine has one.
  assert.equal(config.migrate.agent.type, "auto");
  assert.deepEqual(config.validate.commands, []);
  assert.ok(config.ignore.includes("node_modules"));
  assert.ok(config.ignoreHosts.includes("localhost"));
});

test("loading does not create the state directory", () => {
  const root = tempRepo();
  loadConfig(root);
  assert.equal(fs.existsSync(acbPaths(root).dir), false);
});

test("config file values override the defaults", () => {
  const root = tempRepo({
    [CONFIG_FILENAME]: JSON.stringify({
      model: { provider: "anthropic", model: "claude-opus-5", maxTokens: 8000 },
      sources: {
        "http:api.example.test": [
          { type: "openapi", url: "https://api.example.test/openapi.json" },
          { type: "changelog", path: "upstream/changelog.md", format: "markdown" },
        ],
      },
      validate: { commands: ["node --test"] },
      ignore: ["fixtures"],
    }),
  });
  const config = loadConfig(root);
  assert.equal(config.model.provider, "anthropic");
  assert.equal(config.model.model, "claude-opus-5");
  assert.equal(config.model.maxTokens, 8000);
  assert.equal(config.sources["http:api.example.test"].length, 2);
  assert.deepEqual(config.validate.commands, ["node --test"]);
  // User ignores extend the defaults rather than replacing them.
  assert.ok(config.ignore.includes("fixtures"));
  assert.ok(config.ignore.includes("node_modules"));
});

test("an invalid config names the offending field", () => {
  const cases: [unknown, RegExp][] = [
    [{ model: { provider: "gpt" } }, /model\.provider/],
    [{ model: { maxTokens: "lots" } }, /model\.maxTokens/],
    [{ sources: { "http:x": [{ type: "openapi" }] } }, /needs either a url or a path/],
    [{ sources: { "http:x": [{ type: "wat", url: "u" }] } }, /\.type/],
    [{ validate: { commands: "npm test" } }, /validate\.commands/],
    [{ migrate: { agent: { type: "command" } } }, /migrate\.agent\.command/],
    [{ privacy: { mode: "yolo" } }, /privacy\.mode/],
    [{ modle: {} }, /unknown config key: modle/],
  ];
  for (const [raw, pattern] of cases) {
    assert.throws(() => parseConfig(raw, "/tmp/repo"), (err: Error) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError for ${JSON.stringify(raw)}`);
      assert.match(err.message, pattern);
      return true;
    });
  }
});

test("malformed JSON is reported as a config error", () => {
  const root = tempRepo({ [CONFIG_FILENAME]: "{ not json" });
  assert.throws(() => loadConfig(root), (err: Error) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /not valid JSON/);
    return true;
  });
});

test("ACB_PROVIDER and ACB_MODEL override the config file", () => {
  const root = tempRepo({
    [CONFIG_FILENAME]: JSON.stringify({ model: { provider: "anthropic", model: "a" } }),
  });
  process.env.ACB_PROVIDER = "replay";
  process.env.ACB_MODEL = "recorded";
  try {
    const config = loadConfig(root);
    assert.equal(config.model.provider, "replay");
    assert.equal(config.model.model, "recorded");
  } finally {
    delete process.env.ACB_PROVIDER;
    delete process.env.ACB_MODEL;
  }
});

test("argument parsing handles global options and flags", () => {
  const args = parseArgs(["impact", "--cwd", "/repo", "--no-llm", "--json", "--verbose"]);
  assert.equal(args.command, "impact");
  assert.equal(args.cwd, "/repo");
  assert.ok(args.flags.has("no-llm"));
  assert.equal(args.json, true);
  assert.equal(args.verbose, true);
});

test("an option missing its value is a usage error", () => {
  assert.throws(() => parseArgs(["scan", "--cwd"]), /--cwd needs a value/);
});

test("exit codes are the documented ones", () => {
  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_ERROR, 1);
  assert.equal(EXIT_ACTION_REQUIRED, 2);
});
