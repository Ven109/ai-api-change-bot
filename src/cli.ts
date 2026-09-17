// Command line entry point: argument parsing and command dispatch only.
// The pipeline stages live in their own modules and are added issue by issue.

import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILENAME, ConfigError, loadConfig, type Config } from "./config.ts";
import {
  acbPaths,
  readJson,
  readState,
  writeFile,
  writeJson,
  writeState,
} from "./state.ts";
import {
  EXIT_ACTION_REQUIRED,
  EXIT_ERROR,
  EXIT_OK,
  debug,
  error,
  info,
  llmStage,
  setVerbose,
  stage,
  warn,
} from "./log.ts";
import { countCallSites, scanRepo } from "./scan/index.ts";
import type { Manifest } from "./types.ts";
import { checkUpstream } from "./check/index.ts";
import { analyzeImpact } from "./impact/index.ts";
import { createProvider } from "./model/index.ts";
import { guard } from "./model/egress.ts";
import { checkContracts, contractSummary } from "./validate/contract.ts";
import { renderSummary, runLoop } from "./run.ts";
import { groupByIntegration, migrateIntegration } from "./migrate/index.ts";
import { validationSummary } from "./validate/index.ts";
import type { Candidate, ImpactItem } from "./types.ts";
import { renderMarkdownReport, reportFileName } from "./impact/report.ts";
import type { ChangeEntry } from "./types.ts";

const USAGE = `acb — self-maintaining API dependencies

Usage: acb <command> [options]

Commands:
  scan       Discover external API/SDK integrations and write .acb/manifest.json
  check      Fetch upstream sources and report new API changes
  impact     Decide which upstream changes affect this repository
  migrate    Let an agent prepare a migration, then validate it
  contract   Check HTTP call sites against the provider's API description
  run        The whole loop: scan -> check -> impact -> migrate -> validate
  config     Print the effective configuration
  version    Print the acb version

Global options:
  --cwd <dir>      Repository to work on (default: current directory)
  --json           Machine-readable output where supported
  --verbose        Explain what is happening
  -h, --help       Show help

Exit codes:
  0  success, nothing to do
  1  error
  2  action required (a relevant change was found, or validation failed)

Configuration lives in ${CONFIG_FILENAME}; run "acb config" to see the
effective values. With no model configured, acb stays in deterministic-only
mode and never contacts a model provider.
`;

const COMMAND_HELP: Record<string, string> = {
  scan: `acb scan — discover external API/SDK integrations [deterministic]

Usage: acb scan [--full] [--json]

Walks the repository, extracts raw HTTP call sites (the primary case) and SDK
usage, and writes .acb/manifest.json. Only files whose hash changed since the
last scan are reparsed.

Options:
  --full     Ignore cached hashes and reparse everything
`,
  check: `acb check — look for new upstream API changes [deterministic]

Usage: acb check [--offline] [--since <date>] [--baseline] [--json]

Reads the sources configured for each integration (OpenAPI specs, changelogs)
plus sources resolved from package registries, and reports change entries that
have not been seen before.

Options:
  --offline        Skip every network source
  --since <date>   Only consider entries at or after this date
  --baseline       Mark everything as seen without reporting (first-run setup)
`,
  impact: `acb impact — decide what actually affects this repository

Usage: acb impact [--no-llm] [--dry-run-llm] [--json]

Stage 1 [deterministic]: match change identifiers against the manifest's call
sites. Change entries with no match stop here and nothing is sent anywhere.
Stage 2 [LLM]: for the remaining candidates, ask the configured model to judge
relevance and risk and to draft a migration plan.

Options:
  --no-llm        Deterministic prefilter only
  --dry-run-llm   Write the prompts to .acb/egress/ instead of sending them
`,
  migrate: `acb migrate — prepare a migration and validate it [LLM + deterministic]

Usage: acb migrate [--item <id>] [--pr]

Copies the repository into an isolated workspace under .acb/work/, lets the
configured agent edit it, then validates deterministically (repo tests,
residual usage, HTTP contract check). Writes a patch; never merges anything.

The agent is either the built-in one (any configured model) or your own
coding agent, via migrate.agent = {"type":"command","command":"claude -p …"}.
Either way acb writes the brief to ACB_TASK.md in the workspace and validates
the result itself.

Options:
  --item <id>          Migrate a single impact item
  --keep-workspace     Leave .acb/work/<id> on disk for inspection
  --pr                 Also open a draft/ready pull request
`,
  run: `acb run — the whole loop

Usage: acb run [--no-llm] [--no-migrate] [--pr] [--offline] [--since <date>]

Runs scan, check, impact and (for relevant changes) migrate + validate, then
writes patches or opens pull requests.

Each stage says whether it was [deterministic] or [LLM …]. Exits 0 when there
is nothing to do and 2 whenever something needs a human, which includes a
migration that validated: acb never merges anything.

Options:
  --no-llm           Deterministic report only, no model calls
  --no-migrate       Report, but do not attempt a migration
  --offline          Skip every network source
  --dry-run-llm      Write the prompts to .acb/egress/ and send nothing
  --since <date>     Ignore upstream entries older than this
  --keep-workspace   Leave .acb/work/<id> on disk for inspection
  --pr               Open a pull request for each validated migration
`,
  contract: `acb contract — check calls against the provider's spec [deterministic]

Usage: acb contract [<integration>] [--json]

For every HTTP integration with an OpenAPI description, checks that each call
site still matches the contract: the operation exists, it is not deprecated,
and the query parameters are defined. Useful in CI on its own, since repository
tests usually mock HTTP and keep passing when the real call is wrong.
`,
  config: `acb config — print the effective configuration

Usage: acb config [--json]
`,
};

export type ParsedArgs = {
  command?: string;
  help: boolean;
  json: boolean;
  verbose: boolean;
  cwd?: string;
  flags: Set<string>;
  options: Map<string, string>;
  positionals: string[];
};

const VALUE_OPTIONS = new Set(["--cwd", "--item", "--since", "--report"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    json: false,
    verbose: false,
    flags: new Set(),
    options: new Map(),
    positionals: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--verbose") {
      parsed.verbose = true;
    } else if (VALUE_OPTIONS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      if (arg === "--cwd") parsed.cwd = value;
      else parsed.options.set(arg.slice(2), value);
    } else if (arg.startsWith("--")) {
      parsed.flags.add(arg.slice(2));
    } else if (parsed.command === undefined) {
      parsed.command = arg;
    } else {
      parsed.positionals.push(arg);
    }
  }

  return parsed;
}

export class UsageError extends Error {}

/** Thrown by stages that are planned but not implemented yet. */
export class NotImplementedError extends Error {
  constructor(command: string, issue: string) {
    super(`"acb ${command}" is not implemented yet (tracked in ${issue})`);
  }
}

function printConfig(config: Config, asJson: boolean): void {
  if (asJson) {
    info(JSON.stringify(config, null, 2));
    return;
  }
  const paths = acbPaths(config.root);
  info(`root:        ${config.root}`);
  info(`config:      ${config.configPath ?? `(defaults, no ${CONFIG_FILENAME})`}`);
  info(`state dir:   ${paths.dir}`);
  const model = config.model;
  info(
    `model:       ${model.provider}${model.model ? `/${model.model}` : ""}` +
      (model.provider === "none" ? "  (deterministic-only mode)" : ""),
  );
  info(`sources:     ${Object.keys(config.sources).length} integration(s) configured`);
  info(`validate:    ${config.validate.commands.length ? config.validate.commands.join(", ") : "(none configured)"}`);
  info(`agent:       ${config.migrate.agent.type}${config.migrate.agent.command ? ` (${config.migrate.agent.command})` : ""}`);
  info(`privacy:     ${config.privacy.mode}`);
}

function runScan(config: Config, args: ParsedArgs): number {
  const paths = acbPaths(config.root);
  const previous = readJson<Manifest | undefined>(paths.manifest, undefined);
  const { manifest, filesParsed, filesReused, fullReason } = scanRepo(config, {
    previous,
    full: args.flags.has("full"),
  });
  writeJson(paths.manifest, manifest);

  if (args.json) {
    info(JSON.stringify(manifest, null, 2));
    return EXIT_OK;
  }

  stage(
    "scan",
    `${manifest.integrations.length} integration(s), ${countCallSites(manifest)} call site(s), ` +
      `${filesParsed} file(s) parsed, ${filesReused} cached`,
  );
  if (fullReason && previous) debug(`full reparse: ${fullReason}`);
  for (const integration of manifest.integrations) {
    const version = integration.declaredVersion ? ` (${integration.declaredVersion})` : "";
    info(`  ${integration.id}${version}`);
    if (integration.kind === "sdk") {
      // Member chains repeat a lot; the distinct ones are what matters here.
      const members = [...new Set(integration.callSites.map((s) => s.member))].sort();
      info(`    ${integration.callSites.length} usage(s): ${members.slice(0, 8).join(", ")}`);
      continue;
    }
    for (const site of integration.callSites) {
      const query = site.queryParams?.length ? `?${site.queryParams.join("&")}` : "";
      info(
        `    ${site.method ?? "GET"} ${site.pathTemplate ?? ""}${query}` +
          `  (${site.file}:${site.line})`,
      );
    }
  }
  if (manifest.specs.length) {
    info(`  API specs in repo: ${manifest.specs.join(", ")}`);
  }
  return EXIT_OK;
}

/** Load the manifest, scanning first if there is none yet. */
function requireManifest(config: Config): Manifest {
  const paths = acbPaths(config.root);
  const existing = readJson<Manifest | undefined>(paths.manifest, undefined);
  if (existing) return existing;
  debug("no manifest yet, scanning first");
  const { manifest } = scanRepo(config);
  writeJson(paths.manifest, manifest);
  return manifest;
}

async function runCheck(config: Config, args: ParsedArgs): Promise<number> {
  const manifest = requireManifest(config);
  const state = readState(config.root);

  const result = await checkUpstream(config, manifest, state, {
    offline: args.flags.has("offline"),
    baseline: args.flags.has("baseline"),
    since: args.options.get("since"),
  });
  writeState(config.root, state);
  // Keep the entries around so `acb impact` can work on them without
  // re-reading (and re-consuming) the upstream sources.
  writeJson(acbPaths(config.root).changes, {
    generatedAt: new Date().toISOString(),
    entries: result.entries,
  });

  if (args.json) {
    info(JSON.stringify(result, null, 2));
    return result.entries.length > 0 ? EXIT_ACTION_REQUIRED : EXIT_OK;
  }

  stage("check", `${result.entries.length} new upstream change(s)`);
  for (const entry of result.entries) {
    const tags = entry.tags.length ? ` [${entry.tags.join(", ")}]` : "";
    info(`  ${entry.integrationId}: ${entry.title}${tags}`);
  }
  if (result.snapshotsWritten.length) {
    debug(`snapshots updated: ${result.snapshotsWritten.join(", ")}`);
  }
  if (result.alreadySeen) debug(`${result.alreadySeen} change(s) already reported earlier`);
  for (const integrationId of result.withoutSources) {
    warn(
      `${integrationId}: no upstream source configured. Add one under "sources" in ` +
        `${CONFIG_FILENAME} (an OpenAPI URL or a changelog page).`,
    );
  }

  return result.entries.length > 0 ? EXIT_ACTION_REQUIRED : EXIT_OK;
}

/**
 * The change entries to analyze: whatever the last `check` reported, or a
 * fresh check when there is nothing pending.
 */
async function pendingChanges(
  config: Config,
  manifest: Manifest,
  args: ParsedArgs,
): Promise<ChangeEntry[]> {
  const paths = acbPaths(config.root);
  const stored = readJson<{ entries: ChangeEntry[] } | undefined>(paths.changes, undefined);
  if (stored?.entries?.length) {
    debug(`${stored.entries.length} pending change(s) from the last check`);
    return stored.entries;
  }

  const state = readState(config.root);
  const result = await checkUpstream(config, manifest, state, {
    offline: args.flags.has("offline"),
    baseline: false,
    since: args.options.get("since"),
  });
  writeState(config.root, state);
  writeJson(paths.changes, { generatedAt: new Date().toISOString(), entries: result.entries });
  stage("check", `${result.entries.length} new upstream change(s)`);
  return result.entries;
}

async function runImpact(config: Config, args: ParsedArgs): Promise<number> {
  const manifest = requireManifest(config);
  const entries = await pendingChanges(config, manifest, args);

  const noLlm = args.flags.has("no-llm");
  const provider = noLlm
    ? undefined
    : guard(createProvider(config), {
        config,
        dryRun: args.flags.has("dry-run-llm") || args.flags.has("print-prompts"),
      });
  if (!noLlm && !provider) {
    warn(
      'no model configured, reporting the deterministic evidence only. Set "model" in ' +
        `${CONFIG_FILENAME} for risk assessment and migration plans.`,
    );
  }

  const result = await analyzeImpact(config, manifest, entries, { noLlm, provider });

  const analyzer = result.analyzer;
  const generatedAt = new Date().toISOString();
  const markdown = renderMarkdownReport({
    items: result.items,
    unmatched: result.unmatched,
    entries,
    analyzer,
    generatedAt,
    egress: provider?.summary(),
  });

  const paths = acbPaths(config.root);
  const base = reportFileName(generatedAt);
  writeFile(path.join(paths.reports, base + ".md"), markdown);
  writeJson(path.join(paths.reports, base + ".json"), {
    generatedAt,
    analyzer,
    items: result.items,
    candidates: result.candidates,
    unmatched: result.unmatched.map((entry) => ({ id: entry.id, title: entry.title })),
  });

  if (args.json) {
    info(JSON.stringify({ items: result.items, candidates: result.candidates }, null, 2));
    return result.items.some((item) => item.relevant) ? EXIT_ACTION_REQUIRED : EXIT_OK;
  }

  stage(
    "impact",
    `${result.candidates.length} candidate(s) from ${entries.length} change(s), ` +
      `${result.unmatched.length} filtered out before any model call`,
  );
  if (result.dryRunFile) {
    const count = result.dryRunFiles?.length ?? 1;
    info(
      `  dry run: ${count} prompt(s) written to ${path.dirname(result.dryRunFile)}, nothing sent`,
    );
    return EXIT_OK;
  }
  if (provider) {
    llmStage(provider.label, "impact", `${result.items.length} candidate(s) assessed`);
  }
  for (const item of result.items.filter((i) => i.relevant)) {
    const deadline = item.deadline ? `, deadline ${item.deadline}` : "";
    info(`  [${item.risk}${deadline}] ${item.integrationId}: ${item.summary}`);
    for (const step of item.migrationSteps.slice(0, 4)) info(`      → ${step}`);
    for (const location of item.affected.slice(0, 5)) {
      info(`      ${location.file}:${location.line} — ${location.reason}`);
    }
    const hidden = item.affected.length - 5;
    if (hidden > 0) info(`      … and ${hidden} more location(s)`);
  }
  for (const item of result.items.filter((i) => !i.relevant)) {
    info(`  dismissed: ${item.summary} — ${item.dismissedReason}`);
  }
  info(`  report: ${path.join(paths.reports, base + ".md")}`);
  if (provider) info(`  ${provider.summary()}`);

  return result.items.some((item) => item.relevant) ? EXIT_ACTION_REQUIRED : EXIT_OK;
}

function runContract(config: Config, args: ParsedArgs): number {
  const manifest = requireManifest(config);
  const result = checkContracts({
    config,
    manifest,
    integrationId: args.positionals[0],
  });

  if (args.json) {
    info(JSON.stringify(result, null, 2));
    return result.problems.some((p) => p.severity === "error") ? EXIT_ACTION_REQUIRED : EXIT_OK;
  }

  stage("contract", contractSummary(result));
  for (const problem of result.problems) {
    info(`  ${problem.severity}: ${problem.file}:${problem.line} — ${problem.message}`);
  }
  for (const integrationId of result.skipped) {
    debug(`${integrationId}: no spec available, contract check skipped`);
  }

  return result.problems.some((p) => p.severity === "error") ? EXIT_ACTION_REQUIRED : EXIT_OK;
}

type StoredImpact = {
  items: ImpactItem[];
  candidates: Candidate[];
  entries?: ChangeEntry[];
};

/** The impact report to migrate: the newest one in .acb/reports. */
function latestImpact(config: Config): StoredImpact | undefined {
  const reports = acbPaths(config.root).reports;
  if (!fs.existsSync(reports)) return undefined;
  const files = fs
    .readdirSync(reports)
    .filter((file) => file.endsWith("-impact.json"))
    .sort();
  const newest = files.at(-1);
  if (!newest) return undefined;
  debug(`using impact report ${newest}`);
  return readJson<StoredImpact | undefined>(path.join(reports, newest), undefined);
}

async function runMigrate(config: Config, args: ParsedArgs): Promise<number> {
  const stored = latestImpact(config);
  if (!stored?.items?.length) {
    error('no impact report found. Run "acb impact" first, or use "acb run".');
    return EXIT_ERROR;
  }

  const external = config.migrate.agent.type === "command";
  const provider = guard(createProvider(config), { config });
  if (!provider && !external) {
    error(
      'migrating needs a model or an external agent. Configure "model" in ' +
        `${CONFIG_FILENAME} (provider: anthropic | openai | replay), or ` +
        'set migrate.agent to {"type":"command","command":"claude -p …"}.',
    );
    return EXIT_ERROR;
  }

  const wanted = args.options.get("item");
  const relevant = stored.items.filter(
    (item) => item.relevant && (wanted === undefined || item.id === wanted),
  );
  const groups = groupByIntegration(relevant);
  if (groups.size === 0) {
    info("nothing to migrate");
    return EXIT_OK;
  }

  const pending = readJson<{ entries: ChangeEntry[] } | undefined>(
    acbPaths(config.root).changes,
    undefined,
  );

  let failures = 0;
  for (const [integrationId, items] of groups) {
    const outcome = await migrateIntegration({
      config,
      provider,
      items,
      candidates: stored.candidates,
      entries: pending?.entries,
      keepWorkspace: args.flags.has("keep-workspace"),
    });

    info(`  ${outcome.status}: ${integrationId} (${items.length} change(s))`);
    info(`      attempts: ${outcome.attempts}, files changed: ${outcome.changedFiles.length}`);
    if (outcome.validation) info(`      ${validationSummary(outcome.validation)}`);
    for (const check of outcome.validation?.checks ?? []) {
      if (!check.passed) info(`      failed: ${check.name} — ${firstLine(check.details)}`);
    }
    if (outcome.error) info(`      stopped early: ${outcome.error}`);
    if (outcome.summary) info(`      agent: ${firstLine(outcome.summary)}`);
    if (outcome.patchFile) info(`      patch: ${outcome.patchFile}`);
    info(`      transcript: ${outcome.transcriptFile}`);
    if (outcome.status !== "validated") failures++;
  }

  if (provider) info(`  ${provider.summary()}`);
  return failures > 0 ? EXIT_ACTION_REQUIRED : EXIT_OK;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0].slice(0, 160);
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    error((err as Error).message);
    return EXIT_ERROR;
  }

  setVerbose(args.verbose);

  if (args.command === undefined || args.command === "help") {
    info(USAGE);
    return EXIT_OK;
  }

  if (args.help) {
    info(COMMAND_HELP[args.command] ?? USAGE);
    return EXIT_OK;
  }

  const root = path.resolve(args.cwd ?? process.cwd());

  try {
    switch (args.command) {
      case "version": {
        info(await readVersion());
        return EXIT_OK;
      }
      case "config": {
        printConfig(loadConfig(root), args.json);
        return EXIT_OK;
      }
      case "scan":
        return runScan(loadConfig(root), args);
      case "check":
        return await runCheck(loadConfig(root), args);
      case "impact":
        return await runImpact(loadConfig(root), args);
      case "migrate":
        return await runMigrate(loadConfig(root), args);
      case "contract":
        return runContract(loadConfig(root), args);
      case "run": {
        const config = loadConfig(root);
        const result = await runLoop(config, {
          noLlm: args.flags.has("no-llm"),
          noMigrate: args.flags.has("no-migrate"),
          offline: args.flags.has("offline"),
          dryRunLlm: args.flags.has("dry-run-llm") || args.flags.has("print-prompts"),
          since: args.options.get("since"),
          keepWorkspace: args.flags.has("keep-workspace"),
          json: args.json,
        });
        info(args.json ? JSON.stringify(result, null, 2) : renderSummary(result));
        return result.exitCode;
      }
      default:
        throw new UsageError(`unknown command: ${args.command}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      error((err as Error).message);
      info(USAGE);
      return EXIT_ERROR;
    }
    if (err instanceof ConfigError || err instanceof NotImplementedError) {
      error((err as Error).message);
      return EXIT_ERROR;
    }
    throw err;
  }
}

async function readVersion(): Promise<string> {
  const pkg = await import("node:fs").then((fs) =>
    JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ),
  );
  return `acb ${pkg.version}`;
}
