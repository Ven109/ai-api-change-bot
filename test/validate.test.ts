import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { checkUpstream } from "../src/check/index.ts";
import { analyzeImpact } from "../src/impact/index.ts";
import { scanRepo } from "../src/scan/index.ts";
import { emptyState } from "../src/state.ts";
import { formatFailures, validateMigration, validationSummary } from "../src/validate/index.ts";
import type { Candidate, ImpactItem } from "../src/types.ts";

const EXAMPLES = path.join(import.meta.dirname, "..", "examples");
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function weatherCopy(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-validate-"));
  tempDirs.push(root);
  fs.cpSync(path.join(EXAMPLES, "weather-dashboard"), root, { recursive: true });
  fs.rmSync(path.join(root, ".acb"), { recursive: true, force: true });

  // The fixture runs `node --test`, which node's own test runner refuses to
  // nest. Run the test file directly instead; it is the same assertions.
  const configPath = path.join(root, "acb.config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  raw.validate = { commands: ["node test/weather.test.js"] };
  fs.writeFileSync(configPath, JSON.stringify(raw));
  return root;
}

/** Scan, check and analyze a fixture so we have a real item + entry to validate. */
async function prepare(root: string): Promise<{ item: ImpactItem; candidate: Candidate }> {
  const config = loadConfig(root);
  const manifest = scanRepo(config).manifest;
  const { entries } = await checkUpstream(config, manifest, emptyState(), {
    offline: true,
    baseline: false,
  });
  const result = await analyzeImpact(config, manifest, entries, { noLlm: true });
  const item = result.items[0];
  const candidate = result.candidates.find((entry) => entry.entryId === item.entryId)!;
  return { item, candidate };
}

function migrate(root: string, files: string[]): void {
  for (const file of files) {
    const full = path.join(root, file);
    fs.writeFileSync(
      full,
      fs.readFileSync(full, "utf8").replaceAll("/data/2.5/onecall", "/data/3.0/onecall"),
    );
  }
}

test("a complete migration passes every check", async () => {
  const root = weatherCopy();
  const { item, candidate } = await prepare(root);
  migrate(root, ["src/weather.js", "src/alerts.js"]);

  const result = await validateMigration({
    config: loadConfig(root),
    workspace: root,
    items: [item],
    candidates: [candidate],
  });

  assert.equal(result.passed, true, JSON.stringify(result.checks, null, 2));
  assert.deepEqual(
    result.checks.map((check) => check.name),
    ["`node test/weather.test.js`", "residual usage", "HTTP contract"],
  );
  assert.match(validationSummary(result), /all 3 check\(s\) passed/);
  assert.equal(formatFailures(result), "");
});

test("a half-finished migration fails the residual-usage check with file:line", async () => {
  const root = weatherCopy();
  const { item, candidate } = await prepare(root);
  migrate(root, ["src/weather.js"]); // alerts.js left behind

  const result = await validateMigration({
    config: loadConfig(root),
    workspace: root,
    items: [item],
    candidates: [candidate],
  });

  assert.equal(result.passed, false);
  const residual = result.checks.find((check) => check.name === "residual usage")!;
  assert.equal(residual.passed, false);
  assert.match(residual.details, /src\/alerts\.js:20/);
  assert.doesNotMatch(residual.details, /src\/weather\.js:23/);
  assert.match(formatFailures(result), /residual usage failed/);
});

test("a migration that breaks the tests fails the repo check with its output", async () => {
  const root = weatherCopy();
  const { item, candidate } = await prepare(root);
  migrate(root, ["src/weather.js", "src/alerts.js"]);
  // Break the mapping the fixture's tests assert on.
  const weatherPath = path.join(root, "src", "weather.js");
  fs.writeFileSync(
    weatherPath,
    fs.readFileSync(weatherPath, "utf8").replace("feelsLike: data.current.feels_like", "feelsLike: 0"),
  );

  const result = await validateMigration({
    config: loadConfig(root),
    workspace: root,
    items: [item],
    candidates: [candidate],
  });

  assert.equal(result.passed, false);
  const repoCheck = result.checks.find((check) => check.name.includes("node test/"))!;
  assert.equal(repoCheck.passed, false);
  assert.match(repoCheck.details, /fail 1|not ok/);
  // The other checks still ran and still pass, so the report stays informative.
  assert.equal(result.checks.find((c) => c.name === "residual usage")?.passed, true);
});

test("no configured commands is reported, and the other checks still run", async () => {
  const root = weatherCopy();
  const { item, candidate } = await prepare(root);
  fs.writeFileSync(
    path.join(root, "acb.config.json"),
    JSON.stringify({
      sources: {
        "http:api.openweathermap.org": [
          { type: "changelog", path: "upstream/openweather-changelog.md" },
        ],
      },
    }),
  ); // no validate.commands at all
  migrate(root, ["src/weather.js", "src/alerts.js"]);

  const result = await validateMigration({
    config: loadConfig(root),
    workspace: root,
    items: [item],
    candidates: [candidate],
  });

  const repoCheck = result.checks.find((check) => check.name === "repo checks")!;
  assert.equal(repoCheck.passed, true);
  assert.match(repoCheck.details, /no validate\.commands configured/);
  assert.equal(result.checks.length, 3);
  assert.equal(result.passed, true);
});

test("a failing command is captured rather than thrown", async () => {
  const root = weatherCopy();
  const { item, candidate } = await prepare(root);
  fs.writeFileSync(
    path.join(root, "acb.config.json"),
    JSON.stringify({ validate: { commands: ["exit 3", "echo fine"] } }),
  );

  const result = await validateMigration({
    config: loadConfig(root),
    workspace: root,
    items: [item],
    candidates: [candidate],
  });

  assert.equal(result.checks[0].passed, false);
  assert.equal(result.checks[1].passed, true);
  assert.match(validationSummary(result), /failed/);
});

test("the shipping fixture's contract check is part of validation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-validate-ship-"));
  tempDirs.push(root);
  fs.cpSync(path.join(EXAMPLES, "shipping-service"), root, { recursive: true });
  fs.rmSync(path.join(root, ".acb"), { recursive: true, force: true });

  const configPath = path.join(root, "acb.config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const state = emptyState();
  raw.sources["http:api.parcelio.test"] = [{ type: "openapi", path: "upstream/openapi.v1.json" }];
  fs.writeFileSync(configPath, JSON.stringify(raw));
  const manifest = scanRepo(loadConfig(root)).manifest;
  await checkUpstream(loadConfig(root), manifest, state, { offline: true, baseline: false });

  raw.sources["http:api.parcelio.test"] = [{ type: "openapi", path: "upstream/openapi.v2.json" }];
  fs.writeFileSync(configPath, JSON.stringify(raw));
  const config = loadConfig(root);
  const { entries } = await checkUpstream(config, manifest, state, {
    offline: true,
    baseline: false,
  });
  const analysis = await analyzeImpact(config, manifest, entries, { noLlm: true });
  const item = analysis.items.find((entry) => entry.summary.includes("deprecated"))!;
  const candidate = analysis.candidates.find((entry) => entry.entryId === item.entryId)!;

  // Unmigrated: the contract check fails on the deprecated operation.
  const before = await validateMigration({
    config,
    workspace: root,
    items: [item],
    candidates: [candidate],
  });
  const contract = before.checks.find((check) => check.name === "HTTP contract")!;
  assert.equal(contract.passed, false);
  assert.match(contract.details, /deprecated upstream/);
});
