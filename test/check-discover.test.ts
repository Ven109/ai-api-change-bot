import assert from "node:assert/strict";
import test from "node:test";
import {
  classify,
  discoverSources,
  relatedHosts,
  renderSuggestions,
} from "../src/check/discover.ts";
import { ReplayProvider } from "../src/model/index.ts";

/** Serves canned bodies by URL, 404s everything else, and records requests. */
function stubFetch(routes: Record<string, string>) {
  const requested: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const target = String(url);
    requested.push(target);
    const body = routes[target];
    if (body === undefined) {
      return { ok: false, status: 404, text: async () => "not found" } as Response;
    }
    return { ok: true, status: 200, text: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, requested };
}

const SPEC = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "t", version: "1" },
  paths: { "/v1/things": { get: {}, post: {} } },
});

const CHANGELOG_PAGE = `
<html><body><h1>Changelog</h1>
<h2>2026-08-01</h2><p>Deprecated the old tracking endpoint.</p>
<h2>2026-07-01</h2><p>Added a field.</p>
<h2>2026-06-01</h2><p>Breaking change to pagination.</p>
</body></html>`;

test("a published spec is found by probing and needs no model", async () => {
  const { fetchImpl, requested } = stubFetch({ "https://api.test/openapi.json": SPEC });

  const found = await discoverSources("http:api.test", { fetchImpl });
  assert.equal(found.length, 1);
  assert.equal(found[0].source.type, "openapi");
  assert.equal(found[0].source.url, "https://api.test/openapi.json");
  assert.equal(found[0].foundBy, "probe");
  assert.equal(found[0].confidence, 1);
  assert.match(found[0].evidence, /OpenAPI 3\.0\.3/);
  // It stopped at the first hit rather than probing everything.
  assert.equal(requested.length, 1);
});

test("a changelog page is found on a docs subdomain", async () => {
  const { fetchImpl } = stubFetch({ "https://docs.example.test/changelog": CHANGELOG_PAGE });

  const found = await discoverSources("http:api.example.test", { fetchImpl });
  assert.equal(found.length, 1);
  assert.equal(found[0].source.type, "changelog");
  assert.equal(found[0].source.url, "https://docs.example.test/changelog");
  assert.equal(found[0].source.format, "html");
  assert.match(found[0].evidence, /3 dated entries/);
});

test("model suggestions are fetched and checked, not trusted", async () => {
  const { fetchImpl, requested } = stubFetch({
    // Only one of the three suggestions is real.
    "https://cdn.test/spec/openapi.json": SPEC,
  });
  const provider = new ReplayProvider({
    responses: [
      {
        text: JSON.stringify({
          urls: [
            "https://invented.test/openapi.json",
            "https://cdn.test/spec/openapi.json",
            "https://also-invented.test/changelog",
          ],
        }),
      },
    ],
  });

  const found = await discoverSources("http:api.test", { fetchImpl, provider });
  assert.equal(found.length, 1, "only the URL that actually resolved survives");
  assert.equal(found[0].source.url, "https://cdn.test/spec/openapi.json");
  assert.equal(found[0].foundBy, "model");
  assert.ok(requested.includes("https://invented.test/openapi.json"), "it was checked");
});

test("a model that suggests nothing usable yields nothing", async () => {
  const { fetchImpl } = stubFetch({});
  const provider = new ReplayProvider({
    responses: [{ text: JSON.stringify({ urls: ["https://nope.test/openapi.json"] }) }],
  });

  assert.deepEqual(await discoverSources("http:api.test", { fetchImpl, provider }), []);
});

test("a malformed model answer is survivable", async () => {
  const { fetchImpl } = stubFetch({});
  const provider = new ReplayProvider({
    responses: [{ text: "I think it's probably at /openapi.json" }, { text: "still not JSON" }],
  });
  assert.deepEqual(await discoverSources("http:api.test", { fetchImpl, provider }), []);
});

test("classification demands real evidence", async () => {
  const cases: [string, string | undefined][] = [
    [SPEC, "openapi"],
    [CHANGELOG_PAGE, "changelog"],
    // A marketing page that says "changelog" but lists nothing.
    ["<html><body><h1>Our changelog is coming soon</h1></body></html>", undefined],
    // A spec-shaped document with no paths.
    ['{"openapi":"3.0.0","info":{}}', undefined],
    // Dated blog posts that are not about API changes.
    ["<p>2026-01-01</p><p>2026-02-01</p><p>2026-03-01</p>", undefined],
  ];

  for (const [body, expected] of cases) {
    const { fetchImpl } = stubFetch({ "https://x.test/p": body });
    const result = await classify("https://x.test/p", { fetchImpl });
    assert.equal(result?.kind, expected, body.slice(0, 40));
  }
});

test("unreachable URLs and non-HTTP integrations are handled", async () => {
  const failing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.equal(await classify("https://down.test/x", { fetchImpl: failing }), undefined);
  assert.deepEqual(await discoverSources("http:down.test", { fetchImpl: failing }), []);

  // SDK integrations resolve through the registry instead.
  assert.deepEqual(await discoverSources("npm:openai", {}), []);
});

test("--offline discovers nothing and touches no network", async () => {
  const { fetchImpl, requested } = stubFetch({ "https://api.test/openapi.json": SPEC });
  assert.deepEqual(await discoverSources("http:api.test", { fetchImpl, offline: true }), []);
  assert.deepEqual(requested, []);
});

test("host expansion covers the usual docs subdomains", () => {
  assert.deepEqual(relatedHosts("api.stripe.com"), [
    "api.stripe.com",
    "stripe.com",
    "docs.stripe.com",
    "developers.stripe.com",
    "developer.stripe.com",
  ]);
});

test("the rendered config fragment is valid and groups by integration", () => {
  const fragment = renderSuggestions([
    {
      integrationId: "http:api.test",
      source: { type: "openapi", url: "https://api.test/openapi.json" },
      foundBy: "probe",
      evidence: "e",
      confidence: 1,
    },
    {
      integrationId: "http:api.test",
      source: { type: "changelog", url: "https://docs.test/changelog", format: "html" },
      foundBy: "model",
      evidence: "e",
      confidence: 0.6,
    },
  ]);
  const parsed = JSON.parse(fragment);
  assert.equal(parsed.sources["http:api.test"].length, 2);
  assert.equal(parsed.sources["http:api.test"][0].type, "openapi");
});
