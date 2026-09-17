// The external-agent path, exercised with a shell script standing in for a
// real coding agent, so CI needs none installed.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { checkUpstream } from "../src/check/index.ts";
import { analyzeImpact } from "../src/impact/index.ts";
import { migrateIntegration } from "../src/migrate/index.ts";
import { AGENT_PRESETS, runExternalAgent } from "../src/migrate/external.ts";
import { createWorkspace } from "../src/migrate/workspace.ts";
import { ReplayProvider } from "../src/model/index.ts";
import { scanRepo } from "../src/scan/index.ts";
import { emptyState } from "../src/state.ts";

const EXAMPLES = path.join(import.meta.dirname, "..", "examples");
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A "coding agent" that reads the brief and applies the migration. */
function agentScript(root: string, body: string): string {
  const file = path.join(root, "fake-agent.sh");
  fs.writeFileSync(file, `#!/bin/sh\nset -e\n${body}\n`, { mode: 0o755 });
  return file;
}

function weatherCopy(agentBody: string, extraConfig: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-external-"));
  tempDirs.push(root);
  fs.cpSync(path.join(EXAMPLES, "weather-dashboard"), root, { recursive: true });
  fs.rmSync(path.join(root, ".acb"), { recursive: true, force: true });

  const script = agentScript(root, agentBody);
  const configPath = path.join(root, "acb.config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  raw.validate = { commands: ["node test/weather.test.js"] };
  raw.migrate = {
    agent: { type: "command", command: `sh ${script}`, promptVia: "file" },
    maxAttempts: 2,
    ...extraConfig,
  };
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

const SED_MIGRATION = `
for f in src/weather.js src/alerts.js; do
  sed -i.bak 's|/data/2.5/onecall|/data/3.0/onecall|' "$f"
  rm -f "$f.bak"
done
echo "Moved both One Call call sites to /data/3.0/onecall as the brief describes."
`;

test("an external agent's work is validated and turned into a patch", async () => {
  const root = weatherCopy(SED_MIGRATION);
  const { config, entries, impact } = await prepared(root);

  const outcome = await migrateIntegration({
    config,
    items: impact.items,
    candidates: impact.candidates,
    entries,
  });

  assert.equal(outcome.status, "validated", JSON.stringify(outcome.validation, null, 2));
  assert.deepEqual(outcome.changedFiles.sort(), ["src/alerts.js", "src/weather.js"]);
  assert.match(outcome.summary, /Moved both One Call call sites/);
  assert.ok(outcome.patch?.includes("/data/3.0/onecall"));

  // The agent's output is recorded for review.
  const transcript = fs
    .readFileSync(outcome.transcriptFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(transcript[0].type, "external-agent");
  assert.equal(transcript[0].exitCode, 0);
  assert.match(transcript[0].command, /fake-agent\.sh/);
});

test("the brief reaches the agent as ACB_TASK.md and never lands in the patch", async () => {
  const root = weatherCopy(`
test -f ACB_TASK.md || { echo "no brief" >&2; exit 9; }
grep -q "Definition of done" ACB_TASK.md || exit 8
cp ACB_TASK.md brief-copy.txt
${SED_MIGRATION}
`);
  const { config, entries, impact } = await prepared(root);

  const outcome = await migrateIntegration({
    config,
    items: impact.items,
    candidates: impact.candidates,
    entries,
  });

  assert.equal(outcome.status, "validated");
  assert.doesNotMatch(outcome.patch ?? "", /ACB_TASK\.md/);
  // Anything else the agent creates is part of the diff, as it should be.
  assert.ok(outcome.changedFiles.includes("brief-copy.txt"));
});

test("a failing external agent is retried with the validation failures", async () => {
  const root = weatherCopy(`
if [ -f .attempted ]; then
  # Second attempt: finish the job.
  sed -i.bak 's|/data/2.5/onecall|/data/3.0/onecall|' src/alerts.js
  rm -f src/alerts.js.bak
  grep -q "residual usage failed" ACB_TASK.md || exit 7
  echo "Fixed the remaining call site in src/alerts.js."
else
  # First attempt: only half the migration.
  touch .attempted
  sed -i.bak 's|/data/2.5/onecall|/data/3.0/onecall|' src/weather.js
  rm -f src/weather.js.bak
  echo "Updated src/weather.js."
fi
`);
  const { config, entries, impact } = await prepared(root);

  const outcome = await migrateIntegration({
    config,
    items: impact.items,
    candidates: impact.candidates,
    entries,
  });

  assert.equal(outcome.attempts, 2, "the first attempt failed validation and was fed back");
  assert.equal(outcome.status, "validated");
  assert.match(outcome.summary, /Fixed the remaining call site/);
});

test("a crashing agent is reported, with whatever it managed to change", async () => {
  const root = weatherCopy(
    `
sed -i.bak 's|/data/2.5/onecall|/data/3.0/onecall|' src/weather.js
rm -f src/weather.js.bak
echo "boom" >&2
exit 4
`,
    { maxAttempts: 1 },
  );
  const { config, entries, impact } = await prepared(root);

  const outcome = await migrateIntegration({
    config,
    items: impact.items,
    candidates: impact.candidates,
    entries,
  });

  assert.equal(outcome.status, "failed-validation");
  assert.deepEqual(outcome.changedFiles, ["src/weather.js"]);
  const transcript = JSON.parse(fs.readFileSync(outcome.transcriptFile, "utf8").trim());
  assert.equal(transcript.exitCode, 4);
  assert.match(transcript.stderr, /boom/);
});

test("an agent that runs too long is stopped", async () => {
  const root = weatherCopy("sleep 30");
  const config = loadConfig(root);
  const workspace = await createWorkspace(config, "timeout-test");

  const run = await runExternalAgent({
    config,
    workspaceDir: workspace.dir,
    brief: "# task",
    timeoutMs: 500,
  });
  assert.equal(run.timedOut, true);
});

test("the prompt can be piped to the agent instead", async () => {
  const root = weatherCopy("cat > from-stdin.txt");
  const config = loadConfig(root);
  const workspace = await createWorkspace(config, "stdin-test");

  const run = await runExternalAgent({
    config: {
      ...config,
      migrate: {
        ...config.migrate,
        agent: { ...config.migrate.agent, promptVia: "stdin" },
      },
    },
    workspaceDir: workspace.dir,
    brief: "# the brief itself",
  });

  assert.equal(run.exitCode, 0);
  assert.equal(
    fs.readFileSync(path.join(workspace.dir, "from-stdin.txt"), "utf8").trim(),
    "# the brief itself",
  );
});

test("the documented presets are shaped as the adapter expects", () => {
  for (const [name, preset] of Object.entries(AGENT_PRESETS)) {
    assert.ok(preset.command.length > 0, name);
    assert.ok(["stdin", "file"].includes(preset.promptVia), name);
  }
  assert.match(AGENT_PRESETS["claude-code"].command, /^claude -p/);
});
