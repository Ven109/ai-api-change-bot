import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { loadConfig, parseConfig } from "../src/config.ts";
import { checkUpstream } from "../src/check/index.ts";
import { analyzeImpact } from "../src/impact/index.ts";
import { buildBrief } from "../src/migrate/brief.ts";
import { groupByIntegration, migrateIntegration } from "../src/migrate/index.ts";
import { resolveInWorkspace, runTool, type ToolContext } from "../src/migrate/tools.ts";
import { createWorkspace } from "../src/migrate/workspace.ts";
import { ReplayProvider } from "../src/model/index.ts";
import { scanRepo } from "../src/scan/index.ts";
import { emptyState } from "../src/state.ts";
import type { ImpactItem, ValidationResult } from "../src/types.ts";

const execFileAsync = promisify(execFile);
const EXAMPLES = path.join(import.meta.dirname, "..", "examples");
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function weatherCopy(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-migrate-"));
  tempDirs.push(root);
  fs.cpSync(path.join(EXAMPLES, "weather-dashboard"), root, { recursive: true });
  fs.rmSync(path.join(root, ".acb"), { recursive: true, force: true });

  // node's test runner refuses to nest, so run the fixture's test file directly.
  const configPath = path.join(root, "acb.config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  raw.validate = { commands: ["node test/weather.test.js"] };
  fs.writeFileSync(configPath, JSON.stringify(raw));
  return root;
}

async function prepared(root: string) {
  const config = loadConfig(root);
  const manifest = scanRepo(config).manifest;
  const { entries } = await checkUpstream(config, manifest, emptyState(), {
    offline: true,
    baseline: false,
  });
  const impact = await analyzeImpact(config, manifest, entries, {
    provider: ReplayProvider.fromFile(path.join(root, "replay", "impact.json")),
  });
  return { config, entries, impact };
}

function fingerprint(root: string): string {
  const files = ["src/weather.js", "src/alerts.js", "test/weather.test.js", "package.json"];
  return files
    .map((file) => `${file}:${fs.readFileSync(path.join(root, file), "utf8").length}`)
    .join("|");
}

test("weather fixture: the agent migrates both call sites and validation passes", async () => {
  const root = weatherCopy();
  const before = fingerprint(root);
  const { config, entries, impact } = await prepared(root);

  const outcome = await migrateIntegration({
    config,
    provider: ReplayProvider.fromFile(path.join(root, "replay", "migrate.json")),
    items: impact.items,
    candidates: impact.candidates,
    entries,
  });

  assert.equal(outcome.status, "validated", JSON.stringify(outcome.validation, null, 2));
  assert.equal(outcome.attempts, 1);
  assert.deepEqual(outcome.changedFiles.sort(), ["src/alerts.js", "src/weather.js"]);
  assert.ok(outcome.patch?.includes("/data/3.0/onecall"));
  assert.ok(outcome.patch?.includes("-    `${OPENWEATHER_BASE_URL}/data/2.5/onecall` +"));
  assert.match(outcome.summary, /3\.0/);

  // The user's tree is untouched: the work happened in a copy.
  assert.equal(fingerprint(root), before);

  // The transcript records every tool call, for review.
  const transcript = fs
    .readFileSync(outcome.transcriptFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    transcript.map((entry) => entry.name),
    ["read_file", "replace_in_file", "search", "replace_in_file", "run_validation", "finish"],
  );
  assert.ok(transcript.every((entry) => entry.isError === false));
});

test("the generated patch applies to the original repository", async () => {
  const root = weatherCopy();
  const { config, entries, impact } = await prepared(root);
  const outcome = await migrateIntegration({
    config,
    provider: ReplayProvider.fromFile(path.join(root, "replay", "migrate.json")),
    items: impact.items,
    candidates: impact.candidates,
    entries,
  });

  const target = fs.mkdtempSync(path.join(os.tmpdir(), "acb-migrate-apply-"));
  tempDirs.push(target);
  fs.cpSync(path.join(EXAMPLES, "weather-dashboard"), target, { recursive: true });
  fs.rmSync(path.join(target, ".acb"), { recursive: true, force: true });
  await execFileAsync("git", ["init", "-q"], { cwd: target });

  await execFileAsync("git", ["apply", "--check", outcome.patchFile!], { cwd: target });
  await execFileAsync("git", ["apply", outcome.patchFile!], { cwd: target });
  assert.match(
    fs.readFileSync(path.join(target, "src", "weather.js"), "utf8"),
    /data\/3\.0\/onecall/,
  );
});

test("a failing migration is retried, then reported as failed", async () => {
  const root = weatherCopy();
  const { config, entries, impact } = await prepared(root);

  // An agent that edits only one of the two call sites, every time.
  const halfMigration = {
    responses: Array.from({ length: 6 }, () => ({
      toolCalls: [
        {
          name: "replace_in_file",
          input: {
            path: "src/weather.js",
            old: "`${OPENWEATHER_BASE_URL}/data/2.5/onecall` +",
            new: "`${OPENWEATHER_BASE_URL}/data/3.0/onecall` +",
          },
        },
        { name: "finish", input: { summary: "done (not really)" } },
      ],
    })),
  };

  const outcome = await migrateIntegration({
    config: { ...config, migrate: { ...config.migrate, maxAttempts: 2 } },
    provider: new ReplayProvider(halfMigration),
    items: impact.items,
    candidates: impact.candidates,
    entries,
  });

  assert.equal(outcome.status, "failed-validation");
  assert.equal(outcome.attempts, 2, "the failure is fed back and retried");
  const residual = outcome.validation?.checks.find((check) => check.name === "residual usage");
  assert.equal(residual?.passed, false);
  assert.match(residual?.details ?? "", /src\/alerts\.js:20/);
  // A failed migration still yields a patch, clearly labelled by its status.
  assert.ok(outcome.patchFile, "the partial patch is kept for the reviewer");
});

test("an exhausted step budget ends as incomplete, with the transcript kept", async () => {
  const root = weatherCopy();
  const { config, entries, impact } = await prepared(root);

  const dithering = {
    responses: Array.from({ length: 10 }, () => ({ text: "Let me think about this." })),
  };

  const outcome = await migrateIntegration({
    config: {
      ...config,
      migrate: { ...config.migrate, maxSteps: 2, maxAttempts: 1 },
    },
    provider: new ReplayProvider(dithering),
    items: impact.items,
    candidates: impact.candidates,
    entries,
  });

  assert.equal(outcome.status, "incomplete");
  assert.equal(outcome.patch, undefined, "nothing was changed");
  assert.ok(fs.existsSync(outcome.transcriptFile));
});

test("a provider failure is reported, not thrown", async () => {
  const root = weatherCopy();
  const { config, entries, impact } = await prepared(root);

  const outcome = await migrateIntegration({
    config,
    provider: new ReplayProvider({ responses: [] }), // every call fails
    items: impact.items,
    candidates: impact.candidates,
    entries,
  });

  assert.equal(outcome.status, "incomplete");
  assert.match(outcome.error ?? "", /no recorded response/);
});

test("tools refuse to leave the workspace or read excluded files", async () => {
  const root = weatherCopy();
  fs.writeFileSync(path.join(root, ".env"), "OPENWEATHER_API_KEY=sk-secret-value\n");
  const config = loadConfig(root);
  const workspace = await createWorkspace(config, "tools-test");
  const context: ToolContext = {
    config,
    workspaceDir: workspace.dir,
    validate: async (): Promise<ValidationResult> => ({ passed: true, checks: [] }),
  };

  for (const bad of ["../../etc/passwd", "/etc/passwd", "src/../../escape.js", ".env"]) {
    assert.throws(() => resolveInWorkspace(context, bad), /not allowed|escapes|excluded/, bad);
    const outcome = await runTool(context, "read_file", { path: bad });
    assert.equal(outcome.isError, true, `read_file should refuse ${bad}`);
  }

  // A symlink pointing out of the workspace is refused too.
  fs.symlinkSync("/etc/passwd", path.join(workspace.dir, "link.js"));
  assert.throws(() => resolveInWorkspace(context, "link.js"), /through a link/);

  // Excluded files are not even listed.
  const listing = await runTool(context, "list_files", {});
  assert.doesNotMatch(listing.content, /\.env/);

  // And a legitimate path works.
  const good = await runTool(context, "read_file", { path: "src/weather.js", endLine: 3 });
  assert.equal(good.isError, undefined);
  assert.match(good.content, /^1\| \/\/ Weather lookups/);
});

test("replace_in_file demands an unambiguous match", async () => {
  const root = weatherCopy();
  const config = loadConfig(root);
  const workspace = await createWorkspace(config, "replace-test");
  const context: ToolContext = {
    config,
    workspaceDir: workspace.dir,
    validate: async (): Promise<ValidationResult> => ({ passed: true, checks: [] }),
  };

  const missing = await runTool(context, "replace_in_file", {
    path: "src/weather.js",
    old: "does not appear",
    new: "x",
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content, /not in src\/weather\.js/);

  const ambiguous = await runTool(context, "replace_in_file", {
    path: "src/weather.js",
    old: "const",
    new: "let",
  });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content, /appears \d+ times/);

  const ok = await runTool(context, "replace_in_file", {
    path: "src/weather.js",
    old: "/data/2.5/onecall",
    new: "/data/3.0/onecall",
  });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content, /replaced 1 occurrence/);
});

test("the brief covers every change for the integration", () => {
  const items: ImpactItem[] = [
    {
      id: "a",
      entryId: "e1",
      integrationId: "http:api.test",
      relevant: true,
      risk: "high",
      deadline: "2027-01-15",
      summary: "Track endpoint deprecated",
      whatChanged: "It moves to /v2/tracking.",
      affected: [{ file: "src/a.py", line: 5, reason: "calls it" }],
      migrationSteps: ["Move to /v2/tracking"],
      dependencyChanges: [],
      validationHints: ["no /v1/ calls remain"],
      analyzedBy: "test-model",
    },
    {
      id: "b",
      entryId: "e2",
      integrationId: "http:api.test",
      relevant: true,
      risk: "medium",
      summary: "carrier renamed to carrier_code",
      affected: [{ file: "src/a.py", line: 7, reason: "passes carrier" }],
      migrationSteps: ["Rename the parameter"],
      dependencyChanges: [],
      validationHints: [],
      analyzedBy: "test-model",
    },
  ];

  const brief = buildBrief({ integrationId: "http:api.test", items });
  assert.match(brief, /2 upstream change\(s\)/);
  assert.match(brief, /Highest risk: high/);
  assert.match(brief, /Earliest deadline: 2027-01-15/);
  assert.match(brief, /Change 1: Track endpoint deprecated/);
  assert.match(brief, /Change 2: carrier renamed/);
  assert.match(brief, /src\/a\.py:5/);
  assert.match(brief, /Definition of done/);
  assert.match(brief, /including tests and mocks/);
});

test("items are grouped per integration, and irrelevant ones dropped", () => {
  const item = (id: string, integrationId: string, relevant = true): ImpactItem => ({
    id,
    entryId: id,
    integrationId,
    relevant,
    risk: "low",
    summary: id,
    affected: [],
    migrationSteps: [],
    dependencyChanges: [],
    validationHints: [],
    analyzedBy: "t",
  });

  const groups = groupByIntegration([
    item("a", "http:one.test"),
    item("b", "http:one.test"),
    item("c", "http:two.test"),
    item("d", "http:two.test", false),
  ]);

  assert.deepEqual([...groups.keys()], ["http:one.test", "http:two.test"]);
  assert.equal(groups.get("http:one.test")!.length, 2);
  assert.equal(groups.get("http:two.test")!.length, 1);
});

test("build artefacts from the validation run stay out of the patch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-migrate-artefacts-"));
  tempDirs.push(root);
  fs.cpSync(path.join(EXAMPLES, "shipping-service"), root, { recursive: true });
  fs.rmSync(path.join(root, ".acb"), { recursive: true, force: true });

  const config = parseConfig(
    { validate: { commands: ["python3 -m unittest discover -s tests -t ."] } },
    root,
  );
  const workspace = await createWorkspace(config, "artefacts");
  // Running python leaves __pycache__ behind.
  await execFileAsync("python3", ["-m", "unittest", "discover", "-s", "tests", "-t", "."], {
    cwd: workspace.dir,
  });
  fs.writeFileSync(
    path.join(workspace.dir, "shipping", "client.py"),
    fs.readFileSync(path.join(workspace.dir, "shipping", "client.py"), "utf8").replace(
      "/v1/labels",
      "/v2/labels",
    ),
  );

  const { changedFiles, diffWorkspace } = await import("../src/migrate/workspace.ts");
  assert.deepEqual(await changedFiles(workspace), ["shipping/client.py"]);
  const patch = await diffWorkspace(workspace);
  assert.doesNotMatch(patch, /__pycache__/);
  assert.doesNotMatch(patch, /ACB_TASK\.md/);
});
