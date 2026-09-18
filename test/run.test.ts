// End-to-end runs of the CLI, the way CI and the GitHub Action use it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";

const execFileAsync = promisify(execFile);
const REPO = path.join(import.meta.dirname, "..");
const EXAMPLES = path.join(REPO, "examples");
const BIN = path.join(REPO, "bin", "acb");
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function fixtureCopy(name: string, patchConfig?: (config: any) => void): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `acb-run-${name}-`));
  tempDirs.push(root);
  fs.cpSync(path.join(EXAMPLES, name), root, { recursive: true });
  fs.rmSync(path.join(root, ".acb"), { recursive: true, force: true });

  const configPath = path.join(root, "acb.config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  // node's test runner refuses to nest, so run the test file directly.
  if (name === "weather-dashboard") {
    config.validate = { commands: ["node test/weather.test.js"] };
  }
  patchConfig?.(config);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return root;
}

async function acb(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [BIN, ...args], {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const REPLAY = { ACB_PROVIDER: "replay", ACB_REPLAY_FILE: "replay/run.json" };

test("weather fixture: one command takes it from scan to a validated patch", async () => {
  const root = fixtureCopy("weather-dashboard");
  const { code, stdout } = await acb(["run", "--offline"], root, REPLAY);

  assert.equal(code, 2, "a change needing review exits 2");

  // Every stage reports, and says which kind of stage it was.
  assert.match(stdout, /\[deterministic\] scan: 1 integration\(s\), 2 call site\(s\)/);
  assert.match(stdout, /\[deterministic\] check: 4 new upstream change\(s\)/);
  assert.match(stdout, /\[deterministic\] impact: 1 candidate\(s\), 3 filtered out/);
  assert.match(stdout, /\[LLM replay \(recorded responses, not a live model\)\] impact:/);
  assert.match(stdout, /\[LLM [^\]]+\] migrate: http:api\.openweathermap\.org/);
  assert.match(stdout, /validated/);
  assert.match(stdout, /Nothing was merged/);

  const patches = fs.readdirSync(path.join(root, ".acb", "patches"));
  assert.equal(patches.length, 1);
  const patch = fs.readFileSync(path.join(root, ".acb", "patches", patches[0]), "utf8");
  assert.match(patch, /\+.*data\/3\.0\/onecall/);

  // The fixture itself is untouched: the migration happened in a copy.
  assert.match(fs.readFileSync(path.join(root, "src", "weather.js"), "utf8"), /2\.5\/onecall/);
  // And the throwaway workspace is cleaned up (the parent directory may remain).
  const workDir = path.join(root, ".acb", "work");
  assert.deepEqual(fs.existsSync(workDir) ? fs.readdirSync(workDir) : [], []);
});

test("a second run finds nothing and exits 0", async () => {
  const root = fixtureCopy("weather-dashboard");
  await acb(["run", "--offline"], root, REPLAY);

  const { code, stdout } = await acb(["run", "--offline"], root, REPLAY);
  assert.equal(code, 0);
  assert.match(stdout, /check: 0 new upstream change/);
  assert.match(stdout, /nothing new upstream, nothing to do/);
  // The scan was incremental the second time.
  assert.match(stdout, /0 file\(s\) parsed, 3 cached/);
});

test("--no-llm produces a report and runs nothing model-powered", async () => {
  const root = fixtureCopy("weather-dashboard");
  const { code, stdout } = await acb(["run", "--offline", "--no-llm"], root, {
    // A provider that would throw if it were ever called.
    ACB_PROVIDER: "replay",
    ACB_REPLAY_FILE: "replay/does-not-exist.json",
  });

  assert.equal(code, 2);
  // Not the impact model, and not a coding agent either: an agent is a model.
  assert.doesNotMatch(stdout, /\[LLM/);
  assert.doesNotMatch(stdout, /migrate:/);
  assert.match(stdout, /report-only/);
  const report = fs.readdirSync(path.join(root, ".acb", "reports"));
  const markdown = fs.readFileSync(
    path.join(root, ".acb", "reports", report.find((f) => f.endsWith(".md"))!),
    "utf8",
  );
  assert.match(markdown, /Analyzed by: deterministic prefilter only/);
  assert.match(markdown, /Filtered out before any model call/);
});

test("--no-migrate stops after the report", async () => {
  const root = fixtureCopy("weather-dashboard");
  const { code, stdout } = await acb(["run", "--offline", "--no-migrate"], root, REPLAY);

  assert.equal(code, 2);
  assert.match(stdout, /report-only/);
  assert.doesNotMatch(stdout, /migrate:/);
  assert.equal(fs.existsSync(path.join(root, ".acb", "patches")), false);
});

test("--dry-run-llm writes the prompts and sends nothing", async () => {
  const root = fixtureCopy("weather-dashboard");
  const { code, stdout } = await acb(["run", "--offline", "--dry-run-llm"], root, REPLAY);

  assert.equal(code, 0);
  assert.match(stdout, /prompt\(s\) written to/);
  const prompts = fs.readdirSync(path.join(root, ".acb", "egress"));
  assert.ok(prompts.length >= 1);
  const written = JSON.parse(
    fs.readFileSync(path.join(root, ".acb", "egress", prompts[0]), "utf8"),
  );
  assert.match(written.request.messages[0].content, /One Call API 2\.5 is retired/);
  assert.equal(fs.existsSync(path.join(root, ".acb", "patches")), false);
});

test("--json prints a machine-readable summary", async () => {
  const root = fixtureCopy("weather-dashboard");
  const { code, stdout } = await acb(["run", "--offline", "--json"], root, REPLAY);
  assert.equal(code, 2);

  const result = JSON.parse(stdout.slice(stdout.indexOf("{")));
  assert.equal(result.integrations, 1);
  assert.equal(result.newChanges, 4);
  assert.equal(result.relevant, 1);
  assert.equal(result.filteredOut, 3);
  assert.equal(result.results[0].status, "validated");
  assert.equal(result.exitCode, 2);
  assert.match(result.results[0].patchFile, /\.patch$/);
});

test("shipping fixture: the spec release is detected and migrated", async () => {
  const root = fixtureCopy("shipping-service", (config) => {
    config.sources["http:api.parcelio.test"] = [
      { type: "openapi", path: "upstream/openapi.v1.json" },
    ];
  });

  // Baseline: the provider's spec as it is today.
  const baseline = await acb(["check", "--offline"], root, REPLAY);
  assert.equal(baseline.code, 0);
  assert.match(baseline.stdout, /0 new upstream change/);

  // The provider ships a new version.
  const configPath = path.join(root, "acb.config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.sources["http:api.parcelio.test"] = [
    { type: "openapi", path: "upstream/openapi.v2.json" },
  ];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const { code, stdout } = await acb(["run", "--offline"], root, REPLAY);
  assert.equal(code, 2);
  assert.match(stdout, /check: 6 new upstream change/);
  assert.match(stdout, /impact: 3 candidate\(s\), 3 filtered out/);
  assert.match(stdout, /validated/);

  const patch = fs.readFileSync(
    path.join(root, ".acb", "patches", "http_api.parcelio.test.patch"),
    "utf8",
  );
  assert.match(patch, /v2\/tracking/);
  assert.match(patch, /carrier_code/);
  assert.match(patch, /estimated_delivery/);
  // One patch for the integration, not three for three entries.
  assert.deepEqual(fs.readdirSync(path.join(root, ".acb", "patches")), [
    "http_api.parcelio.test.patch",
  ]);
});

test("a failed migration is reported as such and still exits 2", async () => {
  const root = fixtureCopy("weather-dashboard", (config) => {
    // An agent that edits nothing at all.
    config.migrate = { agent: { type: "command", command: "true" }, maxAttempts: 1 };
  });

  const { code, stdout, stderr } = await acb(["run", "--offline"], root, REPLAY);
  assert.equal(code, 2);
  assert.match(stdout, /incomplete/);
  assert.match(stderr, /nothing was changed/);
});

test("a repository with no configured sources says so instead of failing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-run-bare-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "a.js"),
    'export const a = () => fetch("https://api.unknown.dev/v1/a");\n',
  );

  const { code, stdout, stderr } = await acb(["run", "--offline"], root);
  assert.equal(code, 0);
  assert.match(stdout, /scan: 1 integration/);
  assert.match(stderr, /no upstream source configured/);
});
