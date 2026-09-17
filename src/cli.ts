// Command line entry point: argument parsing and command dispatch only.
// The pipeline stages live in their own modules and are added issue by issue.

import path from "node:path";
import { CONFIG_FILENAME, ConfigError, loadConfig, type Config } from "./config.ts";
import { acbPaths, readJson, writeJson } from "./state.ts";
import { EXIT_ERROR, EXIT_OK, debug, error, info, setVerbose, stage } from "./log.ts";
import { countCallSites, scanRepo } from "./scan/index.ts";
import type { Manifest } from "./types.ts";

const USAGE = `acb — self-maintaining API dependencies

Usage: acb <command> [options]

Commands:
  scan       Discover external API/SDK integrations and write .acb/manifest.json
  check      Fetch upstream sources and report new API changes
  impact     Decide which upstream changes affect this repository
  migrate    Let an agent prepare a migration, then validate it
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

Options:
  --item <id>   Migrate a single impact item
  --pr          Also open a draft/ready pull request
`,
  run: `acb run — the whole loop

Usage: acb run [--no-llm] [--no-migrate] [--pr] [--offline] [--since <date>]

Runs scan, check, impact and (for relevant items) migrate + validate, then
writes patches or opens pull requests. Exits 2 when something needs a human.
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
        loadConfig(root);
        throw new NotImplementedError("check", "AIA-22/AIA-6");
      case "impact":
        loadConfig(root);
        throw new NotImplementedError("impact", "AIA-7/AIA-9");
      case "migrate":
        loadConfig(root);
        throw new NotImplementedError("migrate", "AIA-10/AIA-11");
      case "run":
        loadConfig(root);
        throw new NotImplementedError("run", "AIA-26");
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
