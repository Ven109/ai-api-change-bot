import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config.ts";
import {
  parseDeprecation,
  parseSunset,
  probeDeprecationHeaders,
} from "../src/check/headers.ts";
import type { Integration } from "../src/types.ts";

function integration(
  callSites: Integration["callSites"],
  host = "api.test",
): Integration {
  return { id: `http:${host}`, kind: "http", host, callSites };
}

function site(pathTemplate: string, method = "GET") {
  return { file: "src/a.js", line: 1, snippet: "", method, pathTemplate };
}

/** Serves response headers by URL, and records what was requested. */
function stubFetch(routes: Record<string, Record<string, string>>) {
  const requested: { url: string; method: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    requested.push({ url: String(url), method: String(init?.method ?? "GET") });
    const headers = new Headers(routes[String(url)] ?? {});
    return { ok: true, status: 200, headers } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, requested };
}

const config = parseConfig(undefined, "/repo");

test("header dates are parsed from both specifications' formats", () => {
  // RFC 9745: a structured Date, seconds since the epoch.
  assert.equal(parseDeprecation("@1688169599"), "2023-06-30");
  // Providers sometimes send an HTTP-date instead; accept it rather than lose it.
  assert.equal(parseDeprecation("Sat, 31 Dec 2026 23:59:59 GMT"), "2026-12-31");
  assert.equal(parseDeprecation(null), undefined);
  assert.equal(parseDeprecation("soon"), undefined);

  // RFC 8594: an HTTP-date.
  assert.equal(parseSunset("Sat, 31 Dec 2026 23:59:59 GMT"), "2026-12-31");
  assert.equal(parseSunset(null), undefined);
});

test("an endpoint announcing its own sunset becomes a change entry", async () => {
  const { fetchImpl, requested } = stubFetch({
    "https://api.test/v1/legacy": {
      deprecation: "@1688169599",
      sunset: "Sat, 31 Dec 2026 23:59:59 GMT",
      link: '<https://api.test/v2/modern>; rel="successor-version"',
    },
  });

  const { entries } = await probeDeprecationHeaders(
    integration([site("/v1/legacy")]),
    config,
    { fetchImpl },
  );

  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.match(entry.title, /announces its own deprecation: GET \/v1\/legacy/);
  assert.equal(entry.date, "2026-12-31", "the sunset date is what you plan against");
  assert.deepEqual(entry.tags.sort(), ["breaking", "deprecation", "sunset"]);
  assert.deepEqual(entry.identifiers, [{ method: "GET", pathTemplate: "/v1/legacy" }]);
  assert.match(entry.body, /Deprecation: 2023-06-30/);
  assert.match(entry.body, /points at: https:\/\/api\.test\/v2\/modern/);
  // Structured like a spec entry, because it is just as precise.
  assert.equal(entry.kind, "openapi");

  // Probing must never do more than look.
  assert.deepEqual(requested, [{ url: "https://api.test/v1/legacy", method: "HEAD" }]);
});

test("an endpoint with no such headers produces nothing", async () => {
  const { fetchImpl } = stubFetch({ "https://api.test/v1/fine": {} });
  const { entries } = await probeDeprecationHeaders(
    integration([site("/v1/fine")]),
    config,
    { fetchImpl },
  );
  assert.deepEqual(entries, []);
});

test("deprecation without a sunset date is still reported, less urgently", async () => {
  const { fetchImpl } = stubFetch({
    "https://api.test/v1/old": { deprecation: "@1688169599" },
  });
  const { entries } = await probeDeprecationHeaders(
    integration([site("/v1/old")]),
    config,
    { fetchImpl },
  );
  assert.deepEqual(entries[0].tags, ["deprecation"]);
  assert.equal(entries[0].date, "2023-06-30");
});

test("unsafe and unfillable call sites are skipped, not guessed at", async () => {
  const { fetchImpl, requested } = stubFetch({});
  const { entries, skipped } = await probeDeprecationHeaders(
    integration([
      site("/v1/things/{id}"), // a path parameter has no safe value
      site("/v1/things", "POST"), // probing a write endpoint is not acceptable
      site("/v1/things", "DELETE"),
    ]),
    config,
    { fetchImpl },
  );

  assert.deepEqual(entries, []);
  assert.deepEqual(requested, [], "nothing was requested at all");
  assert.deepEqual(
    skipped.map((entry) => entry.reason),
    [
      "path parameters cannot be filled in safely",
      "POST is not safe to probe",
      "DELETE is not safe to probe",
    ],
  );
});

test("the same URL is probed once, however many call sites reach it", async () => {
  const { fetchImpl, requested } = stubFetch({ "https://api.test/v1/x": {} });
  await probeDeprecationHeaders(
    integration([site("/v1/x"), site("/v1/x"), site("/v1/x")]),
    config,
    { fetchImpl },
  );
  assert.equal(requested.length, 1);
});

test("an unreachable host is recorded, not thrown", async () => {
  const fetchImpl = (async () => {
    throw new Error("ENOTFOUND");
  }) as unknown as typeof fetch;

  const { entries, skipped } = await probeDeprecationHeaders(
    integration([site("/v1/x")]),
    config,
    { fetchImpl },
  );
  assert.deepEqual(entries, []);
  assert.match(skipped[0].reason, /ENOTFOUND/);
});

test("--offline makes no requests", async () => {
  const { fetchImpl, requested } = stubFetch({
    "https://api.test/v1/x": { sunset: "Sat, 31 Dec 2026 23:59:59 GMT" },
  });
  const { entries } = await probeDeprecationHeaders(
    integration([site("/v1/x")]),
    config,
    { fetchImpl, offline: true },
  );
  assert.deepEqual(entries, []);
  assert.deepEqual(requested, []);
});

test("the config accepts a headers source with no url", () => {
  const parsed = parseConfig(
    { sources: { "http:api.test": [{ type: "headers" }] } },
    "/repo",
  );
  assert.equal(parsed.sources["http:api.test"][0].type, "headers");

  // The other source types still need somewhere to read from.
  assert.throws(
    () => parseConfig({ sources: { "http:api.test": [{ type: "openapi" }] } }, "/repo"),
    /needs either a url or a path/,
  );
});
