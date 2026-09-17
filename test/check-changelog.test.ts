import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { checkUpstream } from "../src/check/index.ts";
import {
  extractIdentifiers,
  findDate,
  findVersion,
  htmlToText,
  parseChangelog,
  splitEntries,
  tagsFor,
} from "../src/check/changelog.ts";
import { scanRepo } from "../src/scan/index.ts";
import { emptyState } from "../src/state.ts";

const EXAMPLES = path.join(import.meta.dirname, "..", "examples");
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function parse(text: string, format?: "markdown" | "html" | "text") {
  return parseChangelog(text, { integrationId: "http:api.test", source: "changelog.md", format });
}

test("markdown is split at the release heading level", () => {
  const entries = splitEntries(`# Changelog

Intro text that is not a release.

## 2026-06-01 — First

Body one.

### Details

More about one.

## 2026-05-01 — Second

Body two.
`);
  assert.deepEqual(
    entries.map((e) => e.title),
    ["2026-06-01 — First", "2026-05-01 — Second"],
  );
  // A deeper heading stays inside the entry it belongs to.
  assert.match(entries[0].body, /More about one/);
});

test("a flat dated list still yields one entry per change", () => {
  const entries = splitEntries(`2026-06-01: the tracking endpoint is deprecated
Use the new one instead.
2026-05-01: added a rates endpoint
Nothing else changed.
`);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].date, "2026-06-01");
});

test("dates and versions are read from titles and bodies", () => {
  assert.equal(findDate("## 2026-06-15 — retired"), "2026-06-15");
  assert.equal(findDate("Released June 15, 2026"), "2026-06-15");
  assert.equal(findDate("Released 15 June 2026"), "2026-06-15");
  assert.equal(findDate("no date here"), undefined);
  assert.equal(findVersion("## v4.2.1 (2026-06-15)"), "4.2.1");
  assert.equal(findVersion("## One Call API 3.0"), "3.0");
});

test("tags come from the wording, and announcements stay announcements", () => {
  assert.deepEqual(
    tagsFor({ title: "Endpoint retired", body: "It will stop serving traffic; migrate now." }).sort(),
    ["breaking", "sunset"],
  );
  assert.deepEqual(tagsFor({ title: "New locales added", body: "Now accepts eu." }), ["new"]);
  assert.ok(
    tagsFor({ title: "x", body: "This field is deprecated." }).includes("deprecation"),
  );
});

test("identifiers cover methods, paths, parameters and member chains", () => {
  const identifiers = extractIdentifiers(
    "`GET /v1/shipments/{id}/track` is deprecated. Use `https://api.test/v2/tracking/{tracking_number}` " +
      "and pass `carrier_code=dhl`. The `eta` field is gone. In the SDK, `client.shipments.track()` moved.",
  );
  const paths = new Set(identifiers.map((i) => i.pathTemplate).filter(Boolean));
  assert.ok(paths.has("/v1/shipments/{id}/track"));
  assert.ok(paths.has("/v2/tracking/{tracking_number}"));
  assert.ok(identifiers.some((i) => i.method === "GET"));
  assert.ok(identifiers.some((i) => i.param === "carrier_code"));
  assert.ok(identifiers.some((i) => i.field === "eta"));
  assert.ok(identifiers.some((i) => i.token === "client.shipments.track"));
});

test("noise words do not become identifiers", () => {
  const identifiers = extractIdentifiers("Returns `true` for `json` responses over `https`.");
  assert.deepEqual(identifiers, []);
});

test("html pages are reduced to text and still split", () => {
  const html = `<html><head><style>h2 { color: red }</style></head><body>
    <nav>menu</nav>
    <h1>API changelog</h1>
    <h2>2026-06-15 — One Call 2.5 retired</h2>
    <p>Use <code>/data/3.0/onecall</code> instead.</p>
    <h2>2026-05-02 — New locales</h2>
    <p>Nothing to do.</p>
  </body></html>`;

  const text = htmlToText(html);
  assert.ok(!text.includes("color: red"), "style contents should be gone");
  assert.ok(!text.includes("menu"), "nav should be gone");

  const entries = parse(html, "html");
  assert.deepEqual(
    entries.map((e) => e.title),
    ["2026-06-15 — One Call 2.5 retired", "2026-05-02 — New locales"],
  );
  assert.ok(
    entries[0].identifiers.some((i) => i.pathTemplate === "/data/3.0/onecall"),
    "the code span should become a path identifier",
  );
});

test("html is detected without being told the format", () => {
  const entries = parse("<div><h2>2026-01-01 — Something</h2><p>Body.</p></div>");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "2026-01-01 — Something");
});

test("entry ids are content-addressed", () => {
  const first = parse("## A\n\nBody.\n");
  const same = parse("## A\n\nBody.\n");
  const edited = parse("## A\n\nBody changed.\n");
  assert.equal(first[0].id, same[0].id);
  assert.notEqual(first[0].id, edited[0].id);
  assert.equal(first[0].kind, "changelog");
});

test("the weather fixture yields the retirement notice plus three decoys", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-changelog-"));
  tempDirs.push(root);
  fs.cpSync(path.join(EXAMPLES, "weather-dashboard"), root, { recursive: true });
  fs.rmSync(path.join(root, ".acb"), { recursive: true, force: true });

  const config = loadConfig(root);
  const manifest = scanRepo(config).manifest;
  const state = emptyState();
  const result = await checkUpstream(config, manifest, state, { offline: true, baseline: false });

  assert.deepEqual(
    result.entries.map((e) => e.title),
    [
      "2026-08-12 — Air Pollution API: new hourly forecast endpoint",
      "2026-07-30 — Geocoding API: `limit` default lowered",
      "2026-06-15 — One Call API 2.5 is retired: migrate to One Call API 3.0",
      "2026-05-02 — Current Weather API: `lang` accepts two more locales",
    ],
  );

  const retirement = result.entries.find((e) => e.title.includes("One Call"));
  assert.ok(retirement);
  assert.equal(retirement.date, "2026-06-15");
  assert.deepEqual(retirement.tags.sort(), ["breaking", "deprecation", "removal", "sunset"]);
  const paths = new Set(retirement.identifiers.map((i) => i.pathTemplate));
  assert.ok(paths.has("/data/2.5/onecall"), "the retired endpoint");
  assert.ok(paths.has("/data/3.0/onecall"), "the replacement endpoint");

  // Nothing new on a second run; an edit brings the entry back.
  const repeat = await checkUpstream(config, manifest, state, { offline: true, baseline: false });
  assert.deepEqual(repeat.entries, []);

  const changelogPath = path.join(root, "upstream", "openweather-changelog.md");
  fs.appendFileSync(changelogPath, "\n## 2026-09-10 — Something new\n\nA later addition.\n");
  const afterEdit = await checkUpstream(config, manifest, state, { offline: true, baseline: false });
  assert.deepEqual(
    afterEdit.entries.map((e) => e.title),
    ["2026-09-10 — Something new"],
  );
});

test("--baseline records without reporting, and --since filters by date", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-changelog-baseline-"));
  tempDirs.push(root);
  fs.cpSync(path.join(EXAMPLES, "weather-dashboard"), root, { recursive: true });
  fs.rmSync(path.join(root, ".acb"), { recursive: true, force: true });
  const config = loadConfig(root);
  const manifest = scanRepo(config).manifest;

  const baselineState = emptyState();
  const baseline = await checkUpstream(config, manifest, baselineState, {
    offline: true,
    baseline: true,
  });
  assert.deepEqual(baseline.entries, []);
  assert.equal(baselineState.seen["http:api.openweathermap.org"].length, 4);

  const sinceState = emptyState();
  const since = await checkUpstream(config, manifest, sinceState, {
    offline: true,
    baseline: false,
    since: "2026-07-01",
  });
  assert.deepEqual(
    since.entries.map((e) => e.date),
    ["2026-08-12", "2026-07-30"],
  );
});

test("a missing local source is a warning, not a failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-changelog-missing-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "a.js"),
    'export const a = () => fetch("https://api.test/v1/a");\n',
  );
  fs.writeFileSync(
    path.join(root, "acb.config.json"),
    JSON.stringify({
      sources: { "http:api.test": [{ type: "changelog", path: "upstream/nope.md" }] },
    }),
  );

  const config = loadConfig(root);
  const result = await checkUpstream(config, scanRepo(config).manifest, emptyState(), {
    offline: true,
    baseline: false,
  });
  assert.deepEqual(result.entries, []);
});
