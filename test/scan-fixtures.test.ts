// Scans the demo fixtures, which is where the acceptance criteria live.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { countCallSites, scanRepo } from "../src/scan/index.ts";

const EXAMPLES = path.join(import.meta.dirname, "..", "examples");

test("weather-dashboard: both One Call sites, with query parameters", () => {
  const { manifest } = scanRepo(loadConfig(path.join(EXAMPLES, "weather-dashboard")));

  assert.deepEqual(
    manifest.integrations.map((i) => i.id),
    ["http:api.openweathermap.org"],
  );
  const [integration] = manifest.integrations;
  assert.equal(integration.kind, "http");
  assert.equal(countCallSites(manifest), 2);

  assert.deepEqual(
    integration.callSites.map((s) => `${s.method} ${s.pathTemplate} ${s.file}`),
    [
      "GET /data/2.5/onecall src/alerts.js",
      "GET /data/2.5/onecall src/weather.js",
    ],
  );

  const forecast = integration.callSites.find((s) => s.file === "src/weather.js");
  assert.deepEqual(forecast?.queryParams, ["appid", "exclude", "lat", "lon", "units"]);
  assert.ok(forecast?.snippet.includes("fetchImpl"));
  assert.ok((forecast?.line ?? 0) > 0);
});

test("shipping-service: three call sites and both spec files", () => {
  const { manifest } = scanRepo(loadConfig(path.join(EXAMPLES, "shipping-service")));

  assert.deepEqual(
    manifest.integrations.map((i) => i.id),
    ["http:api.parcelio.test"],
  );
  assert.deepEqual(
    manifest.integrations[0].callSites.map((s) => `${s.method} ${s.pathTemplate}`),
    [
      "GET /v1/shipments/{shipment_id}",
      "GET /v1/shipments/{shipment_id}/track",
      "POST /v1/labels",
    ],
  );

  const track = manifest.integrations[0].callSites[1];
  assert.deepEqual(track.queryParams, ["carrier"]);

  assert.deepEqual(manifest.specs, [
    "upstream/openapi.v1.json",
    "upstream/openapi.v2.json",
  ]);
});

test("scanning twice gives the same manifest", () => {
  const config = loadConfig(path.join(EXAMPLES, "shipping-service"));
  const first = scanRepo(config).manifest;
  const second = scanRepo(config).manifest;
  first.generatedAt = second.generatedAt = "";
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("the fixtures' own test files are not mistaken for integrations", () => {
  const { manifest } = scanRepo(loadConfig(path.join(EXAMPLES, "weather-dashboard")));
  for (const integration of manifest.integrations) {
    for (const site of integration.callSites) {
      assert.ok(!site.file.startsWith("test/"), `unexpected call site in ${site.file}`);
    }
  }
});
