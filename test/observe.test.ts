// End-to-end behaviour of `acb observe`: what it calls, what it refuses to
// call, what it writes, and what the report says. The network is injected, so
// these run offline and deterministically.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { driftToChangeEntries, observe, renderObserve } from "../src/observe/index.ts";
import { plannedProbes, resolveAuth } from "../src/observe/probe.ts";
import type { Manifest } from "../src/types.ts";

/** Probing is opt-in, so tests must opt in explicitly like a real user does. */
function observeConfig(root: string, spec: Record<string, unknown> = {}) {
  const config = loadConfig(root);
  config.observe = { "api.example.com": spec };
  return config;
}

function tempRepo(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-observe-"));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

function manifestFor(root: string, callSites: { method: string; pathTemplate: string }[]): Manifest {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    files: {},
    specs: [],
    integrations: [
      {
        id: "http:api.example.com",
        kind: "http",
        host: "api.example.com",
        callSites: callSites.map((site, index) => ({
          file: "src/app.ts",
          line: index + 1,
          snippet: `fetch("${site.pathTemplate}")`,
          ...site,
        })),
      },
    ],
  };
}

/** A fetch that always answers with the given JSON. */
function respondWith(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("only safe, concrete GET endpoints are probed", () => {
  const manifest = manifestFor("", [
    { method: "GET", pathTemplate: "/v1/status" },
    { method: "POST", pathTemplate: "/v1/charges" },
    { method: "GET", pathTemplate: "/v1/users/{id}" },
  ]);

  const { probes, skipped } = plannedProbes(manifest.integrations[0], {});

  assert.deepEqual(
    probes.map((probe) => probe.url),
    ["https://api.example.com/v1/status"],
  );
  assert.match(
    skipped.find((entry) => entry.path === "/v1/charges")!.reason,
    /not safe to repeat/,
    "a probe runs unattended against production; never guess at a mutating verb",
  );
  assert.match(skipped.find((entry) => entry.path === "/v1/users/{id}")!.reason, /templated/);
});

test("an explicit path overrides the templated-path refusal", () => {
  const manifest = manifestFor("", [{ method: "GET", pathTemplate: "/v1/users/{id}" }]);
  const { probes } = plannedProbes(manifest.integrations[0], { paths: ["/v1/users/u_123"] });

  assert.deepEqual(
    probes.map((probe) => probe.url),
    ["https://api.example.com/v1/users/u_123"],
    "listing a concrete path is the developer saying 'this one is safe'",
  );
});

test("credentials come from the environment, and say so when missing", () => {
  delete process.env.ACB_TEST_TOKEN;
  const missing = resolveAuth({
    auth: { header: "Authorization", value: "Bearer ${ACB_TEST_TOKEN}" },
  });
  assert.ok(missing && "error" in missing);
  assert.match(missing.error, /ACB_TEST_TOKEN/, "name the variable, do not just fail");

  process.env.ACB_TEST_TOKEN = "secret-value";
  const resolved = resolveAuth({
    auth: { header: "Authorization", value: "Bearer ${ACB_TEST_TOKEN}" },
  });
  assert.deepEqual(resolved, { header: "Authorization", value: "Bearer secret-value" });
  delete process.env.ACB_TEST_TOKEN;
});

test("recording writes a profile that holds no response values", async () => {
  const root = tempRepo();
  const config = observeConfig(root);
  const manifest = manifestFor(root, [{ method: "GET", pathTemplate: "/v1/me" }]);

  const result = await observe({
    config,
    manifest,
    fetchImpl: respondWith({ id: "usr_secret_1", email: "someone@example.com", verified: true }),
  });

  assert.equal(result.recorded.length, 1);
  const written = fs.readFileSync(
    path.join(root, ".acb", "observations", fs.readdirSync(path.join(root, ".acb", "observations"))[0]),
    "utf8",
  );
  assert.ok(written.includes('"email"'), "field names are the contract");
  assert.equal(
    written.includes("someone@example.com"),
    false,
    "values must never reach disk — this file gets committed",
  );
  assert.equal(written.includes("usr_secret_1"), false);
});

test("a check against an unchanged API reports nothing", async () => {
  const root = tempRepo();
  const config = observeConfig(root);
  const manifest = manifestFor(root, [{ method: "GET", pathTemplate: "/v1/me" }]);
  const body = { id: "usr_1", email: "a@b.com", plan: { name: "pro" } };

  await observe({ config, manifest, fetchImpl: respondWith(body) });
  const check = await observe({
    config,
    manifest,
    check: true,
    // Different values, same contract. This is the everyday case and it must
    // be silent, or nobody keeps the tool installed.
    fetchImpl: respondWith({ id: "usr_9", email: "z@y.com", plan: { name: "free" } }),
  });

  assert.deepEqual(check.findings, []);
  assert.equal(check.actionRequired, false);
  assert.match(renderObserve(check), /No drift/);
});

test("a drifted field that this repo reads demands action and names the line", async () => {
  const root = tempRepo({
    "src/billing.ts": [
      "export function renew(sub) {",
      "  return new Date(sub.current_period_end * 1000);",
      "}",
    ].join("\n"),
  });
  const config = observeConfig(root);
  const manifest = manifestFor(root, [{ method: "GET", pathTemplate: "/v1/sub" }]);
  manifest.files = { "src/billing.ts": "hash" };

  await observe({
    config,
    manifest,
    fetchImpl: respondWith({ id: "sub_1", current_period_end: 1743465600, status: "active" }),
  });
  const check = await observe({
    config,
    manifest,
    check: true,
    fetchImpl: respondWith({ id: "sub_1", status: "active" }),
  });

  const finding = check.findings.find((entry) => entry.path_ === "current_period_end")!;
  assert.equal(finding.kind, "field_removed");
  assert.deepEqual(finding.readAt, [{ file: "src/billing.ts", line: 2 }]);
  assert.equal(check.actionRequired, true, "it is read here, so it gates CI");

  const report = renderObserve(check);
  assert.match(report, /src\/billing\.ts:2/);
  assert.match(report, /acb impact/, "the report says what to do next");
});

test("a drift in a field nothing reads does not gate the build", async () => {
  const root = tempRepo();
  const config = observeConfig(root);
  const manifest = manifestFor(root, [{ method: "GET", pathTemplate: "/v1/sub" }]);

  await observe({
    config,
    manifest,
    fetchImpl: respondWith({ id: "sub_1", internal_flag: "x", status: "active" }),
  });
  const check = await observe({
    config,
    manifest,
    check: true,
    fetchImpl: respondWith({ id: "sub_1", status: "active" }),
  });

  assert.equal(check.findings.length, 1);
  assert.equal(check.actionRequired, false, "nothing here reads it, so it is informational");
  assert.match(renderObserve(check), /nothing in this repository reads it/);
});

test("checking without a baseline explains itself instead of failing", async () => {
  const root = tempRepo();
  const config = observeConfig(root);
  const manifest = manifestFor(root, [{ method: "GET", pathTemplate: "/v1/me" }]);

  const check = await observe({
    config,
    manifest,
    check: true,
    fetchImpl: respondWith({ id: 1 }),
  });

  assert.equal(check.findings.length, 0);
  assert.match(check.skipped[0].reason, /run `acb observe` first/);
});

test("--dry-run calls nothing at all", async () => {
  const root = tempRepo();
  const config = observeConfig(root);
  const manifest = manifestFor(root, [{ method: "GET", pathTemplate: "/v1/me" }]);

  let called = false;
  const result = await observe({
    config,
    manifest,
    dryRun: true,
    fetchImpl: (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch,
  });

  assert.equal(called, false, "a dry run that makes a request is not a dry run");
  assert.equal(result.recorded.length, 0);
  assert.match(result.skipped[0].reason, /dry run/);
});

test("a non-JSON response is reported, not silently profiled as empty", async () => {
  const root = tempRepo();
  const config = observeConfig(root);
  const manifest = manifestFor(root, [{ method: "GET", pathTemplate: "/v1/me" }]);

  const result = await observe({
    config,
    manifest,
    fetchImpl: (async () =>
      new Response("<html>login</html>", { status: 200 })) as unknown as typeof fetch,
  });

  assert.equal(result.recorded.length, 0);
  assert.match(result.skipped[0].reason, /not JSON/);
});

test("drift becomes an ordinary change entry, so the existing pipeline works", async () => {
  const root = tempRepo({ "src/billing.ts": "sub.current_period_end;\n" });
  const config = observeConfig(root);
  const manifest = manifestFor(root, [{ method: "GET", pathTemplate: "/v1/sub" }]);
  manifest.files = { "src/billing.ts": "hash" };

  await observe({
    config,
    manifest,
    fetchImpl: respondWith({ id: "sub_1", current_period_end: 1, status: "active" }),
  });
  const check = await observe({
    config,
    manifest,
    check: true,
    fetchImpl: respondWith({ id: "sub_1", status: "active", items: { data: [{ current_period_end: 1 }] } }),
  });

  const [entry] = driftToChangeEntries(check, new Date("2026-09-19T00:00:00Z"));
  assert.equal(entry.kind, "openapi", "exact identifiers, so the prefilter may search for fields");
  assert.equal(entry.source, "observed");
  assert.deepEqual(entry.tags, ["breaking", "observed"]);
  assert.deepEqual(entry.identifiers, [
    { method: "GET", pathTemplate: "/v1/sub", field: "current_period_end" },
  ]);
  assert.match(entry.body, /not announced anywhere/);
  assert.match(entry.body, /may be the new home/, "the agent is told where the field went");

  // Re-observing the same drift must not invent a new entry every run.
  const again = driftToChangeEntries(check, new Date("2027-01-01T00:00:00Z"));
  assert.equal(again[0].id, entry.id, "entry ids are content-addressed, not time-based");
});

test("one entry per endpoint, not one per field", async () => {
  const root = tempRepo();
  const config = observeConfig(root);
  const manifest = manifestFor(root, [{ method: "GET", pathTemplate: "/v1/sub" }]);

  await observe({
    config,
    manifest,
    fetchImpl: respondWith({ keep: 1, a: "x", b: "y", c: "z" }),
  });
  const check = await observe({
    config,
    manifest,
    check: true,
    fetchImpl: respondWith({ keep: 1, a: null, b: "", c: 5 }),
  });

  const entries = driftToChangeEntries(check);
  assert.equal(entries.length, 1, "three overlapping patches for one change is a worse outcome");
  assert.equal(entries[0].identifiers.length, 3, "but the agent still sees every affected field");
});

test("an API that was never opted into is not called at all", async () => {
  // Some APIs bill per request. Discovering a host in the code is not consent
  // to start sending it traffic every day.
  const root = tempRepo();
  const config = loadConfig(root);
  const manifest = manifestFor(root, [{ method: "GET", pathTemplate: "/v1/me" }]);

  let called = false;
  const result = await observe({
    config,
    manifest,
    fetchImpl: (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch,
  });

  assert.equal(called, false, "an unlisted host must never be contacted");
  assert.equal(result.recorded.length, 0);
  assert.match(result.skipped[0].reason, /not listed under "observe"/);
});

test("a run cannot exceed its request budget", async () => {
  const root = tempRepo();
  const config = observeConfig(root, {
    paths: ["/a", "/b", "/c", "/d"],
    samples: 3,
  });
  const manifest = manifestFor(root, [{ method: "GET", pathTemplate: "/a" }]);

  let calls = 0;
  const result = await observe({
    config,
    manifest,
    maxRequests: 6,
    fetchImpl: (async () => {
      calls++;
      return new Response(JSON.stringify({ id: 1 }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });

  assert.equal(calls, 6, "the ceiling is a hard stop, not a target");
  assert.equal(result.recorded.length, 2);
  assert.match(result.skipped.at(-1)!.reason, /request budget reached/);
});
