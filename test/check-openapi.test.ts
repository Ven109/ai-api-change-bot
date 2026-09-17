import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { checkUpstream } from "../src/check/index.ts";
import { canonicalizePath, diffSpecs, indexOperations, resolveRefs, serverBasePath } from "../src/check/openapi.ts";
import { scanRepo } from "../src/scan/index.ts";
import { emptyState } from "../src/state.ts";

const EXAMPLES = path.join(import.meta.dirname, "..", "examples");
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function spec(paths: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { openapi: "3.0.3", info: { title: "t", version: "1" }, paths, ...extra };
}

function diff(before: unknown, after: unknown) {
  return diffSpecs(before, after, { integrationId: "http:api.test", source: "openapi.json" });
}

function titles(entries: { title: string }[]): string[] {
  return entries.map((e) => e.title).sort();
}

test("removed operation", () => {
  const entries = diff(
    spec({ "/v1/a": { get: { summary: "Fetch a" } }, "/v1/b": { get: {} } }),
    spec({ "/v1/b": { get: {} } }),
  );
  assert.deepEqual(titles(entries), ["Operation removed: GET /v1/a"]);
  assert.deepEqual(entries[0].identifiers, [{ method: "GET", pathTemplate: "/v1/a" }]);
  assert.ok(entries[0].tags.includes("breaking"));
});

test("newly deprecated operation carries its sunset date", () => {
  const entries = diff(
    spec({ "/v1/a": { get: {} } }),
    spec({
      "/v1/a": {
        get: { deprecated: true, description: "Use /v2/a instead.", "x-sunset": "2027-01-15" },
      },
      "/v2/a": { get: { summary: "The replacement" } },
    }),
  );
  const deprecation = entries.find((e) => e.title.startsWith("Operation deprecated"));
  assert.ok(deprecation);
  assert.equal(deprecation.date, "2027-01-15");
  assert.ok(deprecation.tags.includes("deprecation"));
  assert.match(deprecation.body, /Sunset date: 2027-01-15/);
  // The replacement candidate is surfaced for the migration.
  assert.match(deprecation.body, /GET \/v2\/a/);
});

test("an already deprecated operation is not reported again", () => {
  const deprecated = spec({ "/v1/a": { get: { deprecated: true } } });
  assert.deepEqual(diff(deprecated, deprecated), []);
});

test("renamed parameter, recognized through the description", () => {
  const entries = diff(
    spec({
      "/v1/a": {
        get: {
          parameters: [{ name: "carrier", in: "query", description: "Carrier slug, e.g. dhl." }],
        },
      },
    }),
    spec({
      "/v1/a": {
        get: {
          parameters: [
            { name: "carrier_code", in: "query", description: "Carrier slug, e.g. dhl. Renamed from carrier." },
          ],
        },
      },
    }),
  );
  assert.deepEqual(titles(entries), ["Parameter renamed: carrier -> carrier_code (GET /v1/a)"]);
  assert.deepEqual(entries[0].identifiers, [
    { method: "GET", pathTemplate: "/v1/a", param: "carrier" },
    { method: "GET", pathTemplate: "/v1/a", param: "carrier_code" },
  ]);
});

test("removed parameter without a successor", () => {
  const entries = diff(
    spec({ "/v1/a": { get: { parameters: [{ name: "legacy", in: "query" }] } } }),
    spec({ "/v1/a": { get: { parameters: [] } } }),
  );
  assert.deepEqual(titles(entries), ["Parameter removed: legacy (GET /v1/a)"]);
});

test("parameter that became required", () => {
  const entries = diff(
    spec({ "/v1/a": { post: { parameters: [{ name: "reason", in: "query" }] } } }),
    spec({
      "/v1/a": { post: { parameters: [{ name: "reason", in: "query", required: true }] } },
    }),
  );
  assert.deepEqual(titles(entries), ["Parameter now required: reason (POST /v1/a)"]);
});

test("removed response property mentions the new fields", () => {
  const response = (properties: Record<string, unknown>) => ({
    "200": { content: { "application/json": { schema: { type: "object", properties } } } },
  });
  const entries = diff(
    spec({ "/v1/a": { get: { responses: response({ status: {}, eta: {} }) } } }),
    spec({ "/v1/a": { get: { responses: response({ status: {}, estimated_delivery: {} }) } } }),
  );
  assert.deepEqual(titles(entries), ["Response field removed: eta (GET /v1/a)"]);
  assert.match(entries[0].body, /estimated_delivery/);
  assert.ok(entries[0].identifiers.some((i) => i.field === "eta"));
});

test("added operation is informational, not breaking", () => {
  const entries = diff(spec({}), spec({ "/v2/new": { get: { summary: "Shiny" } } }));
  assert.deepEqual(titles(entries), ["Operation added: GET /v2/new"]);
  assert.deepEqual(entries[0].tags, ["new"]);
});

test("path parameter names do not matter for matching", () => {
  const before = spec({ "/v1/shipments/{id}": { get: {} } });
  const after = spec({ "/v1/shipments/{shipment_id}": { get: {} } });
  assert.deepEqual(diff(before, after), []);
  assert.equal(canonicalizePath("/v1/x/{a}/y/"), "/v1/x/{}/y");
});

test("server base paths and shared parameters are folded in", () => {
  const operations = indexOperations(
    spec(
      {
        "/things/{id}": {
          parameters: [{ name: "id", in: "path", required: true }],
          get: { parameters: [{ name: "expand", in: "query" }] },
        },
      },
      { servers: [{ url: "https://api.test/v3" }] },
    ),
  );
  const operation = operations.get("GET /v3/things/{}");
  assert.ok(operation, [...operations.keys()].join(", "));
  assert.equal(operation.path, "/v3/things/{id}");
  assert.deepEqual(operation.parameters.map((p) => p.name).sort(), ["expand", "id"]);
  assert.equal(serverBasePath(spec({}, { servers: [{ url: "/v2" }] })), "/v2");
  assert.equal(serverBasePath(spec({})), "");
});

test("local $refs are resolved", () => {
  const resolved = resolveRefs(
    {
      paths: { "/a": { get: { parameters: [{ $ref: "#/components/parameters/Page" }] } } },
      components: { parameters: { Page: { name: "page", in: "query", required: true } } },
    },
    {
      paths: { "/a": { get: { parameters: [{ $ref: "#/components/parameters/Page" }] } } },
      components: { parameters: { Page: { name: "page", in: "query", required: true } } },
    },
  ) as { paths: { "/a": { get: { parameters: { name: string }[] } } } };
  assert.equal(resolved.paths["/a"].get.parameters[0].name, "page");
});

test("identical specs produce no entries, and entry ids are stable", () => {
  const before = spec({ "/v1/a": { get: { parameters: [{ name: "x", in: "query" }] } } });
  const after = spec({ "/v1/a": { get: { parameters: [] } } });
  assert.deepEqual(diff(before, before), []);
  assert.equal(diff(before, after)[0].id, diff(before, after)[0].id);
  assert.equal(diff(before, after)[0].kind, "openapi");
});

test("the shipping fixture diff is exactly the expected release", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-check-"));
  tempDirs.push(root);
  fs.cpSync(path.join(EXAMPLES, "shipping-service"), root, { recursive: true });
  fs.rmSync(path.join(root, ".acb"), { recursive: true, force: true });

  const configPath = path.join(root, "acb.config.json");
  const asJson = JSON.parse(fs.readFileSync(configPath, "utf8"));

  // First run: the v1 spec becomes the baseline and reports nothing.
  asJson.sources["http:api.parcelio.test"] = [
    { type: "openapi", path: "upstream/openapi.v1.json" },
  ];
  fs.writeFileSync(configPath, JSON.stringify(asJson));
  const state = emptyState();
  const baselineConfig = loadConfig(root);
  const manifest = scanRepo(baselineConfig).manifest;
  const baseline = await checkUpstream(baselineConfig, manifest, state, {
    offline: true,
    baseline: false,
  });
  assert.deepEqual(baseline.entries, []);
  assert.equal(baseline.snapshotsWritten.length, 1);

  // Second run: the provider ships v2.
  asJson.sources["http:api.parcelio.test"] = [
    { type: "openapi", path: "upstream/openapi.v2.json" },
  ];
  fs.writeFileSync(configPath, JSON.stringify(asJson));
  const release = await checkUpstream(loadConfig(root), manifest, state, {
    offline: true,
    baseline: false,
  });

  assert.deepEqual(titles(release.entries), [
    "Operation added: GET /v2/rates",
    "Operation added: GET /v2/tracking/{tracking_number}",
    "Operation deprecated: GET /v1/shipments/{shipment_id}/track",
    "Parameter now required: reason (POST /v1/returns)",
    "Parameter renamed: carrier -> carrier_code (GET /v1/shipments/{shipment_id}/track)",
    "Response field removed: eta (GET /v1/shipments/{shipment_id}/track)",
  ]);

  // Every entry is recorded, so a prose source re-read would not repeat it.
  assert.equal(state.seen["http:api.parcelio.test"].length, 6);

  // Third run: nothing new. For specs the advanced snapshot is what dedupes,
  // so there is nothing left to diff at all.
  const repeat = await checkUpstream(loadConfig(root), manifest, state, {
    offline: true,
    baseline: false,
  });
  assert.deepEqual(repeat.entries, []);
});

test("an integration without configured sources is reported, not fatal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-check-nosrc-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "a.js"),
    'export const a = () => fetch("https://api.unknown.dev/v1/a");\n',
  );

  const config = loadConfig(root);
  const result = await checkUpstream(config, scanRepo(config).manifest, emptyState(), {
    offline: true,
    baseline: false,
  });
  assert.deepEqual(result.withoutSources, ["http:api.unknown.dev"]);
  assert.deepEqual(result.entries, []);
});
