import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { countCallSites, scanRepo } from "../src/scan/index.ts";
import type { Manifest } from "../src/types.ts";

const tempDirs: string[] = [];

function repoWithTwoCallSites(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acb-incr-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "src", "a.js"),
    'const BASE = "https://api.example.dev";\nexport const a = () => fetch(`${BASE}/v1/a`);\n',
  );
  fs.writeFileSync(
    path.join(dir, "src", "b.js"),
    'export const b = () => fetch("https://api.example.dev/v1/b");\n',
  );
  return dir;
}

function scan(root: string, previous?: Manifest, full = false) {
  return scanRepo(loadConfig(root), { previous, full });
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("a second scan reparses nothing and produces the same manifest", () => {
  const root = repoWithTwoCallSites();
  const first = scan(root);
  assert.equal(first.filesParsed, 2);
  assert.equal(first.fullReason, "no previous manifest");

  const second = scan(root, first.manifest);
  assert.equal(second.filesParsed, 0);
  assert.equal(second.filesReused, 2);
  assert.equal(second.fullReason, undefined);

  const a = { ...first.manifest, generatedAt: "" };
  const b = { ...second.manifest, generatedAt: "" };
  assert.equal(JSON.stringify(b), JSON.stringify(a));
});

test("editing one file reparses only that file", () => {
  const root = repoWithTwoCallSites();
  const first = scan(root);

  fs.writeFileSync(
    path.join(root, "src", "b.js"),
    'export const b = () => fetch("https://api.example.dev/v2/b");\n',
  );

  const second = scan(root, first.manifest);
  assert.equal(second.filesParsed, 1);
  assert.equal(second.filesReused, 1);
  assert.deepEqual(
    second.manifest.integrations[0].callSites.map((s) => `${s.file} ${s.pathTemplate}`),
    ["src/a.js /v1/a", "src/b.js /v2/b"],
  );
});

test("deleting the last call site drops the integration", () => {
  const root = repoWithTwoCallSites();
  const first = scan(root);

  fs.rmSync(path.join(root, "src", "b.js"));
  const second = scan(root, first.manifest);
  assert.equal(countCallSites(second.manifest), 1);
  assert.equal(second.manifest.files["src/b.js"], undefined);

  fs.rmSync(path.join(root, "src", "a.js"));
  const third = scan(root, second.manifest);
  assert.deepEqual(third.manifest.integrations, []);
});

test("--full reparses everything", () => {
  const root = repoWithTwoCallSites();
  const first = scan(root);
  const second = scan(root, first.manifest, true);
  assert.equal(second.filesParsed, 2);
  assert.equal(second.fullReason, "--full requested");
});

test("changing a dependency manifest forces a full reparse", () => {
  const root = repoWithTwoCallSites();
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { openai: "^4.0.0" } }),
  );
  fs.writeFileSync(
    path.join(root, "src", "c.js"),
    'import OpenAI from "openai";\nexport const c = new OpenAI();\n',
  );
  const first = scan(root);
  assert.ok(first.manifest.integrations.some((i) => i.id === "npm:openai"));

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { openai: "^5.0.0" } }),
  );
  const second = scan(root, first.manifest);
  assert.equal(second.fullReason, "package.json changed");
  const sdk = second.manifest.integrations.find((i) => i.id === "npm:openai");
  assert.equal(sdk?.declaredVersion, "^5.0.0");
});

test("SDK usage in unchanged files survives an incremental scan", () => {
  const root = repoWithTwoCallSites();
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { openai: "^4.0.0" } }),
  );
  fs.writeFileSync(
    path.join(root, "src", "c.js"),
    'import OpenAI from "openai";\nconst client = new OpenAI();\nexport const go = () => client.chat.completions.create({});\n',
  );
  const first = scan(root);
  const before = first.manifest.integrations.find((i) => i.id === "npm:openai");

  // Touch an unrelated file, so c.js is served from the cache.
  fs.writeFileSync(
    path.join(root, "src", "b.js"),
    'export const b = () => fetch("https://api.example.dev/v1/b2");\n',
  );
  const second = scan(root, first.manifest);
  assert.equal(second.filesParsed, 1);

  const after = second.manifest.integrations.find((i) => i.id === "npm:openai");
  assert.deepEqual(after?.callSites, before?.callSites);
});

test("a changed base URL constant invalidates files that did not change", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-incr-const-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "config.js"),
    'export const API_BASE = "https://api.one.dev";\n',
  );
  fs.writeFileSync(
    path.join(root, "src", "use.js"),
    'import { API_BASE } from "./config.js";\nexport const go = () => fetch(`${API_BASE}/v1/go`);\n',
  );

  const first = scan(root);
  assert.deepEqual(
    first.manifest.integrations.map((i) => i.id),
    ["http:api.one.dev"],
  );

  fs.writeFileSync(
    path.join(root, "src", "config.js"),
    'export const API_BASE = "https://api.two.dev";\n',
  );
  const second = scan(root, first.manifest);
  assert.equal(second.fullReason, "repo-wide base URL constants changed");
  assert.deepEqual(
    second.manifest.integrations.map((i) => i.id),
    ["http:api.two.dev"],
  );
});

test("the manifest is deterministically ordered", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-incr-sort-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "z.js"),
    'export const z = () => fetch("https://zeta.example.dev/v1/z");\n',
  );
  fs.writeFileSync(
    path.join(root, "src", "a.js"),
    'export const a = () => fetch("https://alpha.example.dev/v1/a");\n',
  );

  const { manifest } = scan(root);
  assert.deepEqual(
    manifest.integrations.map((i) => i.id),
    ["http:alpha.example.dev", "http:zeta.example.dev"],
  );
  assert.deepEqual(Object.keys(manifest.files), [...Object.keys(manifest.files)].sort());
});
