import assert from "node:assert/strict";
import test from "node:test";
import {
  collectBaseUrlConstants,
  collectUrlVariables,
  extractHttpCallSites,
  normalizePathTemplate,
  readCallArgs,
  resolveUrlExpression,
} from "../src/scan/http.ts";
import { DEFAULT_IGNORE_HOSTS } from "../src/config.ts";
import { isIgnored, languageOf } from "../src/scan/walk.ts";
import type { Language } from "../src/scan/walk.ts";

function sites(source: string, language: Language = "js") {
  return extractHttpCallSites(source, language, "src/example." + (language === "js" ? "js" : "py"), {
    ignoreHosts: DEFAULT_IGNORE_HOSTS,
  });
}

test("plain fetch with a literal URL", () => {
  const found = sites(`const r = await fetch("https://api.stripe.com/v1/charges");`);
  assert.equal(found.length, 1);
  assert.deepEqual(
    { method: found[0].method, host: found[0].host, path: found[0].pathTemplate },
    { method: "GET", host: "api.stripe.com", path: "/v1/charges" },
  );
});

test("fetch with an explicit method in the options object", () => {
  const found = sites(`
    await fetch("https://api.stripe.com/v1/charges", {
      method: "POST",
      body: JSON.stringify({ amount: 100 }),
    });
  `);
  assert.equal(found[0].method, "POST");
});

test("base-URL constant plus template string", () => {
  const found = sites(`
    const BASE_URL = "https://api.example.dev";
    const r = await fetch(\`\${BASE_URL}/v2/users/\${userId}\`);
  `);
  assert.equal(found.length, 1);
  assert.equal(found[0].host, "api.example.dev");
  assert.equal(found[0].pathTemplate, "/v2/users/{userId}");
});

test("URL assembled into a variable before the request", () => {
  const found = sites(`
    const API = "https://api.example.dev";
    const url = \`\${API}/v1/search?q=\${term}&limit=10\`;
    const response = await fetch(url);
  `);
  assert.equal(found.length, 1);
  assert.equal(found[0].pathTemplate, "/v1/search");
  assert.deepEqual(found[0].queryParams, ["limit", "q"]);
});

test("string concatenation across lines", () => {
  const found = sites(`
    const BASE = "https://api.example.dev";
    const r = await fetch(BASE +
      "/v1/orders");
  `);
  assert.equal(found.length, 1);
  assert.equal(found[0].pathTemplate, "/v1/orders");
});

test("axios verb methods", () => {
  const found = sites(`
    await axios.post("https://api.example.dev/v1/tokens", payload);
    await axios.delete("https://api.example.dev/v1/tokens/abc");
  `);
  assert.deepEqual(
    found.map((s) => `${s.method} ${s.pathTemplate}`),
    ["POST /v1/tokens", "DELETE /v1/tokens/abc"],
  );
});

test("axios called with a config object", () => {
  const found = sites(`
    await axios({ url: "https://api.example.dev/v1/refunds", method: "PUT" });
  `);
  assert.equal(found.length, 1);
  assert.equal(found[0].method, "PUT");
});

test("an injected fetch wrapper is still a call site", () => {
  const found = sites(`
    export async function load(fetchImpl = fetch) {
      return fetchImpl("https://api.example.dev/v1/status");
    }
  `);
  assert.equal(found.length, 1);
  assert.equal(found[0].pathTemplate, "/v1/status");
});

test("query parameters from a params object", () => {
  const found = sites(`
    await axios.get("https://api.example.dev/v1/search", {
      params: { q: term, page: 2 },
    });
  `);
  assert.deepEqual(found[0].queryParams, ["page", "q"]);
});

test("query parameters set through searchParams", () => {
  const found = sites(`
    const u = "https://api.example.dev/v1/search";
    const r = await fetch(u + "?" + p.searchParams.set("cursor", c));
  `);
  assert.ok(found.length >= 1);
  assert.ok(found.some((s) => s.queryParams.includes("cursor")));
});

test("python requests with an f-string and params", () => {
  const found = sites(
    `
BASE_URL = "https://api.parcelio.test"

def track(shipment_id, carrier):
    return requests.get(
        f"{BASE_URL}/v1/shipments/{shipment_id}/track",
        params={"carrier": carrier},
        timeout=10,
    )
`,
    "python",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].method, "GET");
  assert.equal(found[0].pathTemplate, "/v1/shipments/{shipment_id}/track");
  assert.deepEqual(found[0].queryParams, ["carrier"]);
});

test("python httpx and a session object", () => {
  const found = sites(
    `
import httpx
resp = httpx.post("https://api.example.dev/v1/events", json=payload)
other = session.get("https://api.example.dev/v1/me")
`,
    "python",
  );
  assert.deepEqual(
    found.map((s) => `${s.method} ${s.pathTemplate}`).sort(),
    ["GET /v1/me", "POST /v1/events"],
  );
});

test("python receiver that is itself a call", () => {
  const found = sites(
    `
BASE_URL = "https://api.parcelio.test"
resp = _http(http).get(f"{BASE_URL}/v1/labels")
`,
    "python",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].pathTemplate, "/v1/labels");
});

test("local, private and relative hosts are not integrations", () => {
  const found = sites(`
    await fetch("http://localhost:3000/api/internal");
    await fetch("http://127.0.0.1:8080/health");
    await fetch("http://10.0.0.5/metrics");
    await fetch("http://payments.local/v1/charges");
    await fetch("/api/relative");
    await fetch(\`\${process.env.SELF_URL}/api/self\`);
  `);
  assert.deepEqual(found, []);
});

test("non-request calls that merely mention a URL are ignored", () => {
  const found = sites(`
    console.log("https://api.example.dev/v1/things");
    const u = new URL("https://api.example.dev/v1/things");
    assert.equal(x, "https://api.example.dev/v1/things");
  `);
  assert.deepEqual(found, []);
});

test("extraction is stable and ordered by position", () => {
  const source = `
    const BASE = "https://api.example.dev";
    await fetch(\`\${BASE}/b\`);
    await fetch(\`\${BASE}/a\`);
  `;
  const first = sites(source);
  const second = sites(source);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((s) => s.pathTemplate),
    ["/b", "/a"],
  );
});

test("helpers behave as documented", () => {
  assert.equal(readCallArgs('f("a(b)", 2)', 1), '"a(b)", 2');
  assert.equal(normalizePathTemplate("/v1/x/${order.id}/"), "/v1/x/{id}");
  assert.equal(normalizePathTemplate(""), "/");

  const constants = collectBaseUrlConstants('const A = "https://x.dev/";', "js");
  assert.equal(constants.get("A"), "https://x.dev");

  const vars = collectUrlVariables('const u = `${A}/p`;', "js", constants);
  assert.equal(vars.get("u"), "https://x.dev/p");

  assert.equal(resolveUrlExpression('"/relative"', constants, "js"), undefined);
  assert.equal(languageOf("a/b.py"), "python");
  assert.equal(languageOf("a/b.tsx"), "js");
  assert.equal(languageOf("a/b.md"), undefined);
  assert.equal(isIgnored("node_modules/x/y.js", ["node_modules"]), true);
  assert.equal(isIgnored("src/y.min.js", ["*.min.js"]), true);
  assert.equal(isIgnored("src/y.js", ["node_modules"]), false);
});
