import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig, parseConfig } from "../src/config.ts";
import { checkUpstream } from "../src/check/index.ts";
import { analyzeImpact } from "../src/impact/index.ts";
import { buildPrompt, collectSnippets } from "../src/impact/assess.ts";
import { renderMarkdownReport } from "../src/impact/report.ts";
import { ReplayProvider } from "../src/model/index.ts";
import { EgressGuard } from "../src/model/egress.ts";
import { scanRepo } from "../src/scan/index.ts";
import { emptyState } from "../src/state.ts";
import type { Candidate, ChangeEntry, Manifest } from "../src/types.ts";

const EXAMPLES = path.join(import.meta.dirname, "..", "examples");
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function fixtureCopy(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `acb-assess-${name}-`));
  tempDirs.push(root);
  fs.cpSync(path.join(EXAMPLES, name), root, { recursive: true });
  fs.rmSync(path.join(root, ".acb"), { recursive: true, force: true });
  return root;
}

function replayFrom(root: string) {
  return ReplayProvider.fromFile(path.join(root, "replay", "impact.json"));
}

test("weather fixture: recorded assessment becomes a full impact item", async () => {
  const root = fixtureCopy("weather-dashboard");
  const config = loadConfig(root);
  const manifest = scanRepo(config).manifest;
  const { entries } = await checkUpstream(config, manifest, emptyState(), {
    offline: true,
    baseline: false,
  });

  const provider = replayFrom(root);
  const result = await analyzeImpact(config, manifest, entries, { provider });

  assert.equal(result.items.length, 1);
  const [item] = result.items;
  assert.equal(item.relevant, true);
  assert.equal(item.risk, "high");
  assert.equal(item.deadline, "2026-11-30", "the sunset date comes from the upstream text");
  assert.ok(item.migrationSteps.length >= 2, "a plan, not just a warning");
  assert.ok(
    item.migrationSteps.join(" ").includes("/data/3.0/onecall"),
    "the plan names the replacement endpoint",
  );
  assert.ok(item.validationHints.length >= 1);
  assert.match(item.analyzedBy, /replay/);

  // Every location the model named exists in this repository.
  const files = new Set(Object.keys(manifest.files));
  for (const location of item.affected) {
    assert.ok(files.has(location.file), `${location.file} should be a real file`);
    const lines = fs.readFileSync(path.join(root, location.file), "utf8").split("\n").length;
    assert.ok(location.line >= 1 && location.line <= lines);
  }
  assert.deepEqual(
    [...new Set(item.affected.map((a) => a.file))].sort(),
    ["src/alerts.js", "src/weather.js"],
  );
});

test("shipping fixture: three recorded assessments, decoys never sent", async () => {
  const root = fixtureCopy("shipping-service");
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

  const provider = new EgressGuard(replayFrom(root), { config });
  const result = await analyzeImpact(config, manifest, entries, { provider });

  assert.equal(result.items.length, 3);
  for (const item of result.items) {
    assert.equal(item.relevant, true);
    assert.ok(item.migrationSteps.length >= 1, `${item.summary} should carry a plan`);
  }
  // The renamed parameter and the removed field both point at the tracking code.
  assert.ok(
    result.items.every((item) =>
      item.affected.some((a) => a.file.startsWith("shipping/")),
    ),
  );
  // Three requests: one per candidate, none for the three filtered-out entries.
  assert.equal(provider.stats.requests, 3);
  assert.equal(result.unmatched.length, 3);
});

test("a location the model invented is dropped", async () => {
  const root = fixtureCopy("weather-dashboard");
  const config = loadConfig(root);
  const manifest = scanRepo(config).manifest;
  const { entries } = await checkUpstream(config, manifest, emptyState(), {
    offline: true,
    baseline: false,
  });

  const provider = new ReplayProvider({
    responses: [
      {
        text: JSON.stringify({
          relevant: true,
          risk: "high",
          summary: "Retired endpoint in use",
          affected: [
            { file: "src/weather.js", line: 23, reason: "real" },
            { file: "src/does-not-exist.js", line: 4, reason: "invented file" },
            { file: "src/weather.js", line: 99999, reason: "invented line" },
          ],
          migrationSteps: ["Move to /data/3.0/onecall"],
        }),
      },
    ],
  });

  const result = await analyzeImpact(config, manifest, entries, { provider });
  assert.deepEqual(result.items[0].affected, [
    { file: "src/weather.js", line: 23, reason: "real" },
  ]);
});

test("a dismissed candidate is reported with its reason and no locations", async () => {
  const root = fixtureCopy("weather-dashboard");
  const config = loadConfig(root);
  const manifest = scanRepo(config).manifest;
  const { entries } = await checkUpstream(config, manifest, emptyState(), {
    offline: true,
    baseline: false,
  });

  const provider = new ReplayProvider({
    responses: [
      {
        text: JSON.stringify({
          relevant: false,
          risk: "low",
          summary: "Not applicable here",
          dismissedReason: "this repository only uses the forecast block, which is unchanged",
        }),
      },
    ],
  });

  const result = await analyzeImpact(config, manifest, entries, { provider });
  const [item] = result.items;
  assert.equal(item.relevant, false);
  assert.match(item.dismissedReason ?? "", /forecast block/);
  assert.deepEqual(item.affected, []);

  const markdown = renderMarkdownReport({
    items: result.items,
    unmatched: result.unmatched,
    entries,
    analyzer: "test",
  });
  assert.match(markdown, /## Dismissed/);
  assert.match(markdown, /forecast block/);
  assert.match(markdown, /No upstream change affects this repository/);
});

test("--no-llm keeps the deterministic evidence and calls no model", async () => {
  const root = fixtureCopy("weather-dashboard");
  const config = loadConfig(root);
  const manifest = scanRepo(config).manifest;
  const { entries } = await checkUpstream(config, manifest, emptyState(), {
    offline: true,
    baseline: false,
  });

  const provider = new EgressGuard(replayFrom(root), { config });
  const result = await analyzeImpact(config, manifest, entries, { provider, noLlm: true });

  assert.equal(provider.stats.requests, 0, "no model call may happen with --no-llm");
  assert.equal(result.analyzer, "deterministic prefilter only");
  assert.equal(result.items[0].analyzedBy, "deterministic");
  assert.deepEqual(result.items[0].migrationSteps, []);
});

test("nothing is sent when nothing matched", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-assess-nomatch-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "a.js"),
    'export const a = () => fetch("https://api.test/v1/kept");\n',
  );
  fs.writeFileSync(
    path.join(root, "upstream.md"),
    "## 2026-01-01 — Unrelated\n\n`GET /v1/other` was removed.\n",
  );
  fs.writeFileSync(
    path.join(root, "acb.config.json"),
    JSON.stringify({
      sources: { "http:api.test": [{ type: "changelog", path: "upstream.md" }] },
    }),
  );

  const config = loadConfig(root);
  const manifest = scanRepo(config).manifest;
  const { entries } = await checkUpstream(config, manifest, emptyState(), {
    offline: true,
    baseline: false,
  });
  assert.equal(entries.length, 1);

  const provider = new EgressGuard(new ReplayProvider({ responses: [] }), { config });
  const result = await analyzeImpact(config, manifest, entries, { provider });
  assert.equal(provider.stats.requests, 0);
  assert.deepEqual(result.items, []);
  assert.equal(result.unmatched.length, 1);
});

test("a model failure falls back to the matcher's evidence", async () => {
  const root = fixtureCopy("weather-dashboard");
  const config = loadConfig(root);
  const manifest = scanRepo(config).manifest;
  const { entries } = await checkUpstream(config, manifest, emptyState(), {
    offline: true,
    baseline: false,
  });

  // An empty recording makes every call fail.
  const result = await analyzeImpact(config, manifest, entries, {
    provider: new ReplayProvider({ responses: [] }),
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].analyzedBy, "deterministic");
  assert.equal(result.items[0].relevant, true);
});

test("prompts carry snippets, not whole files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-assess-snip-"));
  tempDirs.push(root);
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
  lines[99] = 'await fetch("https://api.test/v1/things");';
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "big.js"), lines.join("\n"));

  const candidate: Candidate = {
    entryId: "e1",
    integrationId: "http:api.test",
    score: 1,
    matches: [{ file: "src/big.js", line: 100, reason: "calls it" }],
  };

  const snippets = collectSnippets(root, candidate);
  assert.equal(snippets.length, 1);
  assert.match(snippets[0], /src\/big\.js:85-115/);
  assert.match(snippets[0], /100\| await fetch/);
  assert.doesNotMatch(snippets[0], /line 1$/m, "the whole file must not be included");

  const entry: ChangeEntry = {
    id: "e1",
    integrationId: "http:api.test",
    source: "spec.json",
    kind: "openapi",
    title: "Operation removed: GET /v1/things",
    body: "It is gone.",
    tags: ["breaking"],
    identifiers: [{ method: "GET", pathTemplate: "/v1/things" }],
  };
  const manifest: Manifest = {
    version: 1,
    generatedAt: "",
    files: { "src/big.js": "h" },
    specs: [],
    integrations: [],
  };

  const prompt = buildPrompt({
    config: parseConfig(undefined, root),
    manifest,
    provider: new ReplayProvider({ responses: [] }),
    entry,
    candidate,
  });
  assert.match(prompt, /# Upstream change/);
  assert.match(prompt, /Operation removed: GET \/v1\/things/);
  assert.match(prompt, /src\/big\.js:100 — calls it/);
  assert.match(prompt, /# Code at those locations/);
  assert.match(prompt, /Reply with the JSON object only/);
});
