import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { indexOperations } from "../src/check/openapi.ts";
import { scanRepo } from "../src/scan/index.ts";
import { checkContracts, contractSummary, findOperation } from "../src/validate/contract.ts";

const EXAMPLES = path.join(import.meta.dirname, "..", "examples");
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function shippingCopy(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-contract-"));
  tempDirs.push(root);
  fs.cpSync(path.join(EXAMPLES, "shipping-service"), root, { recursive: true });
  fs.rmSync(path.join(root, ".acb"), { recursive: true, force: true });

  // Point the source at the new spec, as it would be after the release.
  const configPath = path.join(root, "acb.config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  raw.sources["http:api.parcelio.test"] = [{ type: "openapi", path: "upstream/openapi.v2.json" }];
  fs.writeFileSync(configPath, JSON.stringify(raw));
  return root;
}

function check(root: string) {
  const config = loadConfig(root);
  return checkContracts({ config, manifest: scanRepo(config).manifest });
}

test("shipping fixture before migration: deprecated endpoint and unknown parameter", () => {
  const result = check(shippingCopy());
  const errors = result.problems.filter((p) => p.severity === "error");

  assert.equal(errors.length, 2, JSON.stringify(result.problems, null, 2));
  assert.ok(errors.every((error) => error.file === "shipping/client.py"));
  assert.ok(
    errors.some((e) => /is deprecated upstream \(sunset 2027-01-15\)/.test(e.message)),
    "the deprecated track operation",
  );
  assert.ok(
    errors.some((e) => /`carrier`, which the provider does not define/.test(e.message)),
    "the renamed query parameter",
  );
  // The unchanged operations produce nothing.
  assert.equal(
    result.problems.some((p) => p.message.includes("/v1/labels")),
    false,
  );
  assert.deepEqual(result.checked, [
    { integrationId: "http:api.parcelio.test", callSites: 3 },
  ]);
});

test("shipping fixture after a correct migration: no errors", () => {
  const root = shippingCopy();
  const clientPath = path.join(root, "shipping", "client.py");
  const migrated = fs
    .readFileSync(clientPath, "utf8")
    .replace(
      'f"{BASE_URL}/v1/shipments/{shipment_id}/track"',
      'f"{BASE_URL}/v2/tracking/{shipment_id}"',
    )
    .replace('params={"carrier": carrier}', 'params={"carrier_code": carrier}');
  fs.writeFileSync(clientPath, migrated);

  const result = check(root);
  assert.deepEqual(
    result.problems.filter((p) => p.severity === "error"),
    [],
    JSON.stringify(result.problems, null, 2),
  );
});

test("a half-finished migration is still caught", () => {
  const root = shippingCopy();
  const clientPath = path.join(root, "shipping", "client.py");
  // Endpoint moved, parameter forgotten.
  fs.writeFileSync(
    clientPath,
    fs
      .readFileSync(clientPath, "utf8")
      .replace(
        'f"{BASE_URL}/v1/shipments/{shipment_id}/track"',
        'f"{BASE_URL}/v2/tracking/{shipment_id}"',
      ),
  );

  const errors = check(root).problems.filter((p) => p.severity === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /`carrier`, which the provider does not define/);
});

test("a required parameter that is not visibly passed is a warning, not an error", () => {
  const root = shippingCopy();
  const clientPath = path.join(root, "shipping", "client.py");
  fs.writeFileSync(
    clientPath,
    fs
      .readFileSync(clientPath, "utf8")
      .replace(
        'f"{BASE_URL}/v1/shipments/{shipment_id}/track"',
        'f"{BASE_URL}/v2/tracking/{shipment_id}"',
      )
      .replace('params={"carrier": carrier},', ""),
  );

  const result = check(root);
  assert.deepEqual(result.problems.filter((p) => p.severity === "error"), []);
  const warnings = result.problems.filter((p) => p.severity === "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /required query parameter `carrier_code`/);
  assert.match(warnings[0].message, /may be added dynamically/);
});

test("an unknown operation says which methods that path does have", () => {
  const root = shippingCopy();
  const clientPath = path.join(root, "shipping", "client.py");
  fs.writeFileSync(
    clientPath,
    fs.readFileSync(clientPath, "utf8").replace('.post(\n        f"{BASE_URL}/v1/labels"', '.get(\n        f"{BASE_URL}/v1/labels"'),
  );

  const errors = check(root).problems.filter((p) => p.severity === "error");
  const unknown = errors.find((e) => e.message.includes("/v1/labels"));
  assert.ok(unknown, JSON.stringify(errors, null, 2));
  assert.match(unknown.message, /is not in the provider's API description/);
  assert.match(unknown.message, /That path exists for: POST/);
});

test("integrations without a spec are skipped, not failed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-contract-nospec-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "a.js"),
    'export const a = () => fetch("https://api.nospec.dev/v1/a");\n',
  );

  const result = check(root);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.skipped, ["http:api.nospec.dev"]);
  assert.equal(contractSummary(result), "no integration with a spec, contract check skipped");
});

test("dynamic query parameter names are not reported", () => {
  const root = shippingCopy();
  const clientPath = path.join(root, "shipping", "client.py");
  fs.writeFileSync(
    clientPath,
    fs
      .readFileSync(clientPath, "utf8")
      .replace(
        'f"{BASE_URL}/v1/shipments/{shipment_id}/track"',
        'f"{BASE_URL}/v2/tracking/{shipment_id}?{extra_key}={extra_value}"',
      )
      .replace('params={"carrier": carrier}', 'params={"carrier_code": carrier}'),
  );

  const errors = check(root).problems.filter((p) => p.severity === "error");
  assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));
});

test("operation matching tolerates a prefix the spec omits", () => {
  const operations = indexOperations({
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    paths: { "/v2/tracking/{tracking_number}": { get: {} } },
  });

  assert.ok(findOperation(operations, "GET", "/v2/tracking/{id}"));
  assert.ok(findOperation(operations, "GET", "/gateway/v2/tracking/{id}"));
  assert.equal(findOperation(operations, "POST", "/v2/tracking/{id}"), undefined);
  assert.equal(findOperation(operations, "GET", "/v2/other/{id}"), undefined);
});
