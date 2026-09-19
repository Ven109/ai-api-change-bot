// `npm run demo` — the whole loop on both fixtures.
//
// Each fixture is copied into .demo/ first, so the demo never modifies the
// examples in place and can be re-run at will.
//
//   npm run demo          recorded responses: no key, no network, no cost
//   npm run demo:real     your own model and a real agent, end to end
//
// "real" needs no API key either: the analysis runs through the Claude Code
// CLI you are already logged into, and the edit through whichever agent is
// installed. Override with ACB_PROVIDER/ACB_MODEL for anything else.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.join(import.meta.dirname, "..");
const demoRoot = path.join(repoRoot, ".demo");
const acb = path.join(repoRoot, "bin", "acb");

type Fixture = {
  name: string;
  /** Point the spec source at the baseline first, to simulate "before". */
  baselineSource?: { integrationId: string; path: string };
  /** Then the new version, which is the release being detected. */
  releaseSource?: { integrationId: string; path: string };
  why: string;
};

const FIXTURES: Fixture[] = [
  {
    name: "weather-dashboard",
    why: "Node + fetch, upstream change announced in prose. Judging it needs a model.",
  },
  {
    name: "shipping-service",
    why: "Python + requests, upstream change published as an OpenAPI diff. Detected without a model.",
    baselineSource: { integrationId: "http:api.parcelio.test", path: "upstream/openapi.v1.json" },
    releaseSource: { integrationId: "http:api.parcelio.test", path: "upstream/openapi.v2.json" },
  },
];

/** --real runs on the user's own model instead of the recordings. */
const real = process.argv.includes("--real");

async function run(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [acb, ...args], {
      cwd,
      stdio: "inherit",
      env: real
        ? {
            ...process.env,
            ACB_PROVIDER: process.env.ACB_PROVIDER ?? "claude-cli",
          }
        : {
            ...process.env,
            ACB_PROVIDER: "replay",
            ACB_REPLAY_FILE: "replay/run.json",
          },
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function setSource(root: string, integrationId: string, specPath: string): void {
  const file = path.join(root, "acb.config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.sources[integrationId] = [{ type: "openapi", path: specPath }];
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

function heading(text: string): void {
  console.log(`\n${"=".repeat(78)}\n${text}\n${"=".repeat(78)}`);
}

fs.rmSync(demoRoot, { recursive: true, force: true });
fs.mkdirSync(demoRoot, { recursive: true });

for (const fixture of FIXTURES) {
  const source = path.join(repoRoot, "examples", fixture.name);
  const target = path.join(demoRoot, fixture.name);
  fs.cpSync(source, target, { recursive: true });
  fs.rmSync(path.join(target, ".acb"), { recursive: true, force: true });

  heading(`${fixture.name}\n${fixture.why}`);

  if (real) {
    // Let the agent be chosen automatically (SDK, then an agent CLI), rather
    // than the built-in loop the recordings drive.
    const configPath = path.join(target, "acb.config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.migrate = { ...(config.migrate ?? {}), agent: { type: "auto" } };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  }

  if (fixture.baselineSource && fixture.releaseSource) {
    // First run: record the provider's spec as it is today. Nothing to report.
    setSource(target, fixture.baselineSource.integrationId, fixture.baselineSource.path);
    console.log("\n--- before the upstream release: recording the baseline ---\n");
    await run(["check"], target);

    // Then the provider ships a new version of the spec.
    setSource(target, fixture.releaseSource.integrationId, fixture.releaseSource.path);
    console.log("\n--- the provider ships a new API version ---\n");
  }

  const code = await run(["run", "--offline"], target);
  console.log(`\n(exit code ${code}: 2 means "a human needs to look at this")`);
}

heading("Done");
console.log(
  real
    ? `
Everything above ran on your own model: the analysis through the Claude Code
CLI, the edit through whichever agent this machine has. No API key involved —
it used the login you already had.
`
    : `
Everything above ran offline with recorded model responses, labelled
"replay (recorded responses, not a live model)" in the output. Run
\`npm run demo:real\` to do the same with your own model.
`,
);
console.log(`

What to look at:
  .demo/*/.acb/reports/*.md        the impact reports
  .demo/*/.acb/patches/*.patch     the migrations, as patches
  .demo/*/.acb/reports/*.jsonl     what the agent did, tool call by tool call
  .demo/*/.acb/manifest.json       the integrations acb discovered

Running it on your own model:
  npm run demo:real                          your Claude Code login, no API key
  ACB_PROVIDER=anthropic ANTHROPIC_API_KEY=… npm run demo:real
  ACB_PROVIDER=openai ACB_BASE_URL=http://localhost:11434/v1 npm run demo:real

Pinning a particular agent for the edit, instead of auto-detection:
  migrate.agent = {"type":"sdk"}
  migrate.agent = {"type":"command","command":"claude -p --permission-mode acceptEdits","promptVia":"stdin"}
`);
