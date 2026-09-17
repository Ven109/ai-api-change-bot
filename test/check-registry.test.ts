// Registry resolution, driven by recorded HTTP payloads so nothing here
// touches the network.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { checkUpstream } from "../src/check/index.ts";
import {
  cleanVersion,
  fetchSdkChanges,
  githubSlug,
  isNewer,
  resolveSource,
} from "../src/check/registry.ts";
import { scanRepo } from "../src/scan/index.ts";
import { emptyState } from "../src/state.ts";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Serves canned responses by URL substring, and records what was requested. */
function stubFetch(routes: Record<string, unknown>) {
  const requested: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const target = String(url);
    requested.push(target);
    const match = Object.keys(routes).find((key) => target.includes(key));
    if (!match) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    const payload = routes[match];
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, requested };
}

test("version helpers", () => {
  assert.equal(cleanVersion("^4.20.0"), "4.20.0");
  assert.equal(cleanVersion("==7.1.0"), "7.1.0");
  assert.equal(cleanVersion(">=2.0"), "2.0");
  assert.equal(cleanVersion(undefined), undefined);

  assert.equal(isNewer("4.21.0", "4.20.0"), true);
  assert.equal(isNewer("4.20.0", "4.20.0"), false);
  assert.equal(isNewer("5.0.0", "4.99.9"), true);
  assert.equal(isNewer("4.2.0", "4.10.0"), false, "4.10 is newer than 4.2");
  assert.equal(isNewer("1.0.0", undefined), true);

  assert.equal(githubSlug("git+https://github.com/openai/openai-node.git"), "openai/openai-node");
  assert.equal(githubSlug("https://github.com/stripe/stripe-python/issues"), "stripe/stripe-python");
  assert.equal(githubSlug("https://example.com/x"), undefined);
});

test("an npm package resolves to its GitHub releases", async () => {
  const { fetchImpl, requested } = stubFetch({
    "registry.npmjs.org": {
      "dist-tags": { latest: "4.30.0" },
      repository: { url: "git+https://github.com/openai/openai-node.git" },
    },
  });

  const source = await resolveSource("npm:openai", "^4.20.0", { offline: false, fetchImpl });
  assert.ok(source);
  assert.equal(source.repository, "openai/openai-node");
  assert.equal(source.fromVersion, "4.20.0");
  assert.equal(source.latestVersion, "4.30.0");
  assert.match(source.url, /api\.github\.com\/repos\/openai\/openai-node\/releases/);
  assert.equal(requested.length, 1);
});

test("a PyPI package resolves through project_urls", async () => {
  const { fetchImpl } = stubFetch({
    "pypi.org": {
      info: {
        version: "8.0.0",
        project_urls: { Homepage: "https://stripe.com", Source: "https://github.com/stripe/stripe-python" },
      },
    },
  });

  const source = await resolveSource("pypi:stripe", "==7.1.0", { offline: false, fetchImpl });
  assert.equal(source?.repository, "stripe/stripe-python");
  assert.equal(source?.fromVersion, "7.1.0");
});

test("only releases newer than the declared version become entries", async () => {
  const { fetchImpl } = stubFetch({
    "/releases": [
      {
        tag_name: "v5.0.0",
        name: "v5.0.0",
        body: "Breaking: `client.chat.completions.create` now returns a stream by default.",
        published_at: "2026-08-01T00:00:00Z",
      },
      { tag_name: "v4.21.0", name: "v4.21.0", body: "Added a helper.", published_at: "2026-07-01T00:00:00Z" },
      { tag_name: "v4.20.0", name: "v4.20.0", body: "The version we are on.", published_at: "2026-06-01T00:00:00Z" },
    ],
  });

  const entries = await fetchSdkChanges(
    "npm:openai",
    { kind: "github-releases", url: "https://api.github.com/x/releases", fromVersion: "4.20.0", repository: "openai/openai-node" },
    { offline: false, fetchImpl },
  );

  assert.deepEqual(entries.map((entry) => entry.version), ["5.0.0", "4.21.0"]);
  assert.equal(entries[0].date, "2026-08-01");
  assert.ok(entries[0].tags.includes("breaking"));
  assert.ok(
    entries[0].identifiers.some((id) => id.token === "client.chat.completions.create"),
    "the member chain becomes a matchable identifier",
  );
});

test("a project with no releases falls back to its changelog file", async () => {
  const { fetchImpl, requested } = stubFetch({
    "/releases": [],
    "CHANGELOG.md": "# Changelog\n\n## 5.0.0\n\nRemoved `Charge.create`.\n\n## 4.0.0\n\nOld.\n",
  });

  const entries = await fetchSdkChanges(
    "pypi:stripe",
    { kind: "github-releases", url: "https://api.github.com/x/releases", fromVersion: "4.5.0", repository: "stripe/stripe-python" },
    { offline: false, fetchImpl },
  );

  assert.deepEqual(entries.map((entry) => entry.version), ["5.0.0"]);
  assert.ok(requested.some((url) => url.includes("raw.githubusercontent.com")));
});

test("rate limiting is a warning, not a failure", async () => {
  const fetchImpl = (async () => ({
    ok: false,
    status: 403,
    json: async () => ({}),
    text: async () => "rate limited",
  })) as unknown as typeof fetch;

  const source = await resolveSource("npm:openai", "^1.0.0", { offline: false, fetchImpl });
  assert.equal(source, undefined);
});

test("--offline resolves nothing and reports the integration as unconfigured", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-registry-"));
  tempDirs.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { openai: "^4.20.0" } }),
  );
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "a.js"),
    'import OpenAI from "openai";\nconst client = new OpenAI();\nexport const go = () => client.chat.completions.create({});\n',
  );

  const config = loadConfig(root);
  const manifest = scanRepo(config).manifest;
  const result = await checkUpstream(config, manifest, emptyState(), {
    offline: true,
    baseline: false,
  });
  assert.deepEqual(result.withoutSources, ["npm:openai"]);
});

test("an SDK dependency needs no configuration, and the source is cached", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-registry-auto-"));
  tempDirs.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { openai: "^4.20.0" } }),
  );
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "a.js"),
    'import OpenAI from "openai";\nconst client = new OpenAI();\nexport const go = () => client.chat.completions.create({});\n',
  );

  const { fetchImpl, requested } = stubFetch({
    "registry.npmjs.org": {
      "dist-tags": { latest: "5.0.0" },
      repository: { url: "https://github.com/openai/openai-node" },
    },
    "/releases": [
      {
        tag_name: "v5.0.0",
        name: "v5.0.0",
        body: "Breaking: `client.chat.completions.create` moved.",
        published_at: "2026-08-01T00:00:00Z",
      },
    ],
  });

  const config = loadConfig(root);
  const manifest = scanRepo(config).manifest;
  const state = emptyState();

  const first = await checkUpstream(config, manifest, state, {
    offline: false,
    baseline: false,
    fetchImpl,
  });
  assert.deepEqual(first.withoutSources, []);
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].integrationId, "npm:openai");
  assert.ok(state.resolvedSources?.["npm:openai"], "the resolved source is cached in state");

  // Second run: the registry is not consulted again, and the entry is not
  // reported twice.
  const registryCalls = requested.filter((url) => url.includes("registry.npmjs.org")).length;
  const second = await checkUpstream(config, manifest, state, {
    offline: false,
    baseline: false,
    fetchImpl,
  });
  assert.deepEqual(second.entries, []);
  assert.equal(
    requested.filter((url) => url.includes("registry.npmjs.org")).length,
    registryCalls,
    "the cached source is reused",
  );
});
