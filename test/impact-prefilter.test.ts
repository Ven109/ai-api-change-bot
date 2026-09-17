import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { checkUpstream } from "../src/check/index.ts";
import { analyzeImpact } from "../src/impact/index.ts";
import { prefilter } from "../src/impact/prefilter.ts";
import { scanRepo } from "../src/scan/index.ts";
import { emptyState } from "../src/state.ts";
import type { ChangeEntry, Manifest } from "../src/types.ts";

const EXAMPLES = path.join(import.meta.dirname, "..", "examples");
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function manifestWith(callSites: Manifest["integrations"][number]["callSites"]): Manifest {
  return {
    version: 1,
    generatedAt: "",
    files: {},
    specs: [],
    integrations: [{ id: "http:api.test", kind: "http", host: "api.test", callSites }],
  };
}

function entry(partial: Partial<ChangeEntry>): ChangeEntry {
  return {
    id: "e1",
    integrationId: "http:api.test",
    source: "s",
    kind: "openapi",
    title: "t",
    body: "b",
    tags: [],
    identifiers: [],
    ...partial,
  };
}

const SITE = {
  file: "src/a.js",
  line: 10,
  snippet: "fetch(url)",
  method: "GET",
  pathTemplate: "/v1/things/{id}",
  queryParams: ["expand"],
};

function run(entries: ChangeEntry[], manifest = manifestWith([SITE]), minScore = 0.4) {
  return prefilter({ manifest, entries, minScore });
}

test("a spec entry naming an operation the repo calls scores highest", () => {
  const { candidates } = run([
    entry({
      tags: ["breaking"],
      identifiers: [{ method: "GET", pathTemplate: "/v1/things/{thing_id}" }],
    }),
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].score, 1);
  assert.match(candidates[0].matches[0].reason, /calls GET \/v1\/things/);
});

test("a different method on the same path does not match", () => {
  const { candidates, unmatched } = run([
    entry({ identifiers: [{ method: "DELETE", pathTemplate: "/v1/things/{id}" }] }),
  ]);
  assert.deepEqual(candidates, []);
  assert.equal(unmatched.length, 1);
});

test("an operation the repo never calls does not match", () => {
  const { candidates } = run([
    entry({ tags: ["breaking"], identifiers: [{ method: "POST", pathTemplate: "/v1/returns" }] }),
  ]);
  assert.deepEqual(candidates, []);
});

test("prose naming a path scores lower than a spec diff", () => {
  const { candidates } = run([
    entry({ kind: "changelog", identifiers: [{ pathTemplate: "/v1/things/{id}" }] }),
  ]);
  assert.equal(candidates[0].score, 0.8);
});

test("prose with only a version segment still matches, at low confidence", () => {
  const { candidates } = run([
    entry({
      kind: "changelog",
      tags: ["deprecation"],
      identifiers: [{ pathTemplate: "/v1/something-else" }],
    }),
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].score, 0.6);
  assert.match(candidates[0].matches[0].reason, /version segment \/v1\//);
});

test("the version-segment rule does not apply to spec diffs", () => {
  const { candidates } = run([
    entry({ tags: ["breaking"], identifiers: [{ method: "POST", pathTemplate: "/v1/returns" }] }),
  ]);
  assert.deepEqual(candidates, []);
});

test("a query parameter the call site passes is evidence", () => {
  const { candidates } = run([
    entry({ kind: "changelog", identifiers: [{ param: "expand" }] }),
  ]);
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].matches[0].reason, /passes the `expand` parameter/);
});

test("an SDK member chain matches the usage site", () => {
  const manifest: Manifest = {
    version: 1,
    generatedAt: "",
    files: {},
    specs: [],
    integrations: [
      {
        id: "npm:openai",
        kind: "sdk",
        package: "openai",
        callSites: [
          { file: "src/x.js", line: 3, snippet: "", member: "client.chat.completions.create" },
        ],
      },
    ],
  };
  const { candidates } = prefilter({
    manifest,
    entries: [
      entry({
        integrationId: "npm:openai",
        kind: "changelog",
        identifiers: [{ token: "client.chat.completions.create" }],
      }),
    ],
    minScore: 0.4,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].score, 0.7);
});

test("breaking changes get a boost, pure announcements a penalty", () => {
  const identifiers = [{ method: "GET", pathTemplate: "/v1/things/{id}" }];
  const neutral = run([entry({ identifiers })]).candidates[0].score;
  const breaking = run([entry({ identifiers, tags: ["breaking"] })]).candidates[0].score;
  assert.ok(breaking >= neutral);

  const announcement = run([entry({ identifiers, tags: ["new"] })]);
  assert.equal(announcement.candidates[0].score, 0.65);

  // Below the threshold an announcement drops out entirely.
  const weak = run(
    [entry({ kind: "changelog", identifiers: [{ param: "expand" }], tags: ["new"] })],
    manifestWith([SITE]),
  );
  assert.deepEqual(weak.candidates, []);
});

test("the threshold is configurable", () => {
  const entries = [entry({ kind: "changelog", identifiers: [{ param: "expand" }] })];
  assert.equal(run(entries, manifestWith([SITE]), 0.9).candidates.length, 0);
  assert.equal(run(entries, manifestWith([SITE]), 0.4).candidates.length, 1);
});

test("an entry for an integration that is no longer in the manifest is dropped", () => {
  const { candidates, unmatched } = run([entry({ integrationId: "http:gone.test" })]);
  assert.deepEqual(candidates, []);
  assert.equal(unmatched.length, 1);
});

test("weather fixture: the retirement matches both call sites, decoys match nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-prefilter-w-"));
  tempDirs.push(root);
  fs.cpSync(path.join(EXAMPLES, "weather-dashboard"), root, { recursive: true });
  fs.rmSync(path.join(root, ".acb"), { recursive: true, force: true });

  const config = loadConfig(root);
  const manifest = scanRepo(config).manifest;
  const { entries } = await checkUpstream(config, manifest, emptyState(), {
    offline: true,
    baseline: false,
  });
  const result = await analyzeImpact(config, manifest, entries, { noLlm: true });

  assert.equal(result.items.length, 1);
  const [item] = result.items;
  assert.match(item.summary, /One Call API 2\.5 is retired/);
  assert.equal(item.risk, "high");
  assert.equal(item.analyzedBy, "deterministic");
  assert.deepEqual(
    item.affected.map((a) => `${a.file}:${a.line}`),
    ["src/alerts.js:20", "src/weather.js:23"],
  );

  assert.deepEqual(
    result.unmatched.map((e) => e.title),
    [
      "2026-08-12 — Air Pollution API: new hourly forecast endpoint",
      "2026-07-30 — Geocoding API: `limit` default lowered",
      "2026-05-02 — Current Weather API: `lang` accepts two more locales",
    ],
  );
});

test("shipping fixture: three relevant spec changes, decoys filtered out", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-prefilter-s-"));
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

  const result = await analyzeImpact(config, manifest, entries, { noLlm: true });

  assert.deepEqual(
    result.items.map((i) => i.summary).sort(),
    [
      "Operation deprecated: GET /v1/shipments/{shipment_id}/track",
      "Parameter renamed: carrier -> carrier_code (GET /v1/shipments/{shipment_id}/track)",
      "Response field removed: eta (GET /v1/shipments/{shipment_id}/track)",
    ],
  );

  // The decoys, and the new operation the repo does not call yet.
  assert.deepEqual(
    result.unmatched.map((e) => e.title).sort(),
    [
      "Operation added: GET /v2/rates",
      "Operation added: GET /v2/tracking/{tracking_number}",
      "Parameter now required: reason (POST /v1/returns)",
    ],
  );

  // The eta removal finds the field reads, including the one in the tests.
  const eta = result.items.find((i) => i.summary.includes("eta"));
  assert.deepEqual(
    eta?.affected.map((a) => a.file).sort(),
    ["shipping/client.py", "shipping/client.py", "shipping/notifications.py", "tests/test_client.py"],
  );

  // The deprecation entry points at its successor, which the migration needs.
  const deprecation = result.items.find((i) => i.summary.startsWith("Operation deprecated"));
  assert.match(deprecation?.whatChanged ?? "", /\/v2\/tracking\/\{tracking_number\}/);
});
