// Validating a migration, deterministically.
//
// An AI-written migration is only worth a pull request if something other
// than the AI has checked it, and if the reviewer can re-run that check
// themselves. Three independent checks, reported separately:
//
//   1. the repository's own commands (tests, typecheck, lint);
//   2. residual usage — the exact path, parameter or member chain that matched
//      before the migration must be gone from the code;
//   3. the HTTP contract check against the provider's spec (AIA-23), which
//      does not care how good the repo's tests are.
//
// Failures come back as text a coding agent can act on, which is what the
// bounded retry loop in `migrate` feeds back.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../config.ts";
import { debug, warn } from "../log.ts";
import { scanRepo } from "../scan/index.ts";
import { acbPaths } from "../state.ts";
import type { Candidate, ImpactItem, ValidationCheck, ValidationResult } from "../types.ts";
import { checkContracts, contractSummary } from "./contract.ts";

const execFileAsync = promisify(execFile);

/** Keep the last lines of command output: enough to see the failure. */
const OUTPUT_TAIL_LINES = 200;

export type ValidateInput = {
  config: Config;
  /** The migrated copy to check. */
  workspace: string;
  /**
   * The changes being migrated. Several entries about one operation are one
   * migration, so validation takes the whole set.
   */
  items: ImpactItem[];
  /**
   * The prefilter candidates those items came from. Their evidence is what the
   * residual-usage check looks for, so pass them when available.
   */
  candidates?: Candidate[];
};

export async function validateMigration(input: ValidateInput): Promise<ValidationResult> {
  const checks: ValidationCheck[] = [];

  checks.push(...(await runRepoCommands(input)));
  checks.push(residualUsageCheck(input));
  checks.push(contractCheck(input));

  return { passed: checks.every((check) => check.passed), checks };
}

async function runRepoCommands(input: ValidateInput): Promise<ValidationCheck[]> {
  const { commands, timeoutMs } = input.config.validate;
  if (commands.length === 0) {
    warn(
      'no validate.commands configured: the repository\'s own tests were not run. ' +
        "Add them to acb.config.json so a migration has to prove itself.",
    );
    return [
      {
        name: "repo checks",
        passed: true,
        details: "no validate.commands configured, so nothing was run",
      },
    ];
  }

  const checks: ValidationCheck[] = [];
  for (const command of commands) {
    debug(`running: ${command}`);
    try {
      const { stdout, stderr } = await execFileAsync(command, {
        cwd: input.workspace,
        shell: true,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, CI: "1", NO_COLOR: "1" },
      });
      checks.push({
        name: `\`${command}\``,
        passed: true,
        details: tail(`${stdout}${stderr}`) || "passed",
      });
    } catch (err) {
      const failure = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
      checks.push({
        name: `\`${command}\``,
        passed: false,
        details: failure.killed
          ? `timed out after ${input.config.validate.timeoutMs}ms`
          : tail(`${failure.stdout ?? ""}${failure.stderr ?? ""}`) ||
            failure.message ||
            "failed",
      });
    }
  }
  return checks;
}

/**
 * The old usage must be gone.
 *
 * This is what catches the most common half-migration: one of two call sites
 * updated, tests still green because the other one is mocked. It checks for
 * the *specific* things that matched before — that path, that parameter, that
 * member chain — rather than re-running the matcher, because a migration note
 * usually names both the old and the new endpoint, so "still matches the
 * entry" would be true even after a perfect migration.
 */
function residualUsageCheck(input: ValidateInput): ValidationCheck {
  const { config, workspace } = input;
  const evidence = (input.candidates ?? [])
    .flatMap((candidate) => candidate.matches)
    .map((match) => match.evidence)
    .filter((value): value is NonNullable<typeof value> => Boolean(value));

  if (evidence.length === 0) {
    return {
      name: "residual usage",
      passed: true,
      details: "no recorded pre-migration usage to re-check",
    };
  }

  const workspaceConfig: Config = { ...config, root: workspace };
  const { manifest } = scanRepo(workspaceConfig);
  const integrationIds = new Set(input.items.map((item) => item.integrationId));
  const callSites = manifest.integrations
    .filter((integration) => integrationIds.has(integration.id))
    .flatMap((integration) => integration.callSites);

  const oldPaths = new Set(
    evidence.map((item) => item.pathTemplate).filter(Boolean) as string[],
  );
  const oldParams = new Set(evidence.map((item) => item.param).filter(Boolean) as string[]);
  const oldMembers = new Set(evidence.map((item) => item.member).filter(Boolean) as string[]);

  const remaining: string[] = [];
  for (const site of callSites) {
    if (site.pathTemplate && oldPaths.has(site.pathTemplate)) {
      remaining.push(
        `- ${site.file}:${site.line} still calls \`${site.method ?? "GET"} ${site.pathTemplate}\``,
      );
      continue;
    }
    for (const param of site.queryParams ?? []) {
      if (oldParams.has(param)) {
        remaining.push(
          `- ${site.file}:${site.line} still passes the \`${param}\` parameter`,
        );
      }
    }
    if (site.member && oldMembers.has(site.member)) {
      remaining.push(`- ${site.file}:${site.line} still uses \`${site.member}\``);
    }
  }

  if (remaining.length === 0) {
    return {
      name: "residual usage",
      passed: true,
      details: `the pre-migration usage is gone (${describeEvidence(oldPaths, oldParams, oldMembers)})`,
    };
  }

  return {
    name: "residual usage",
    passed: false,
    details:
      `the migration is incomplete — ${remaining.length} location(s) still use what changed:\n` +
      `${remaining.join("\n")}\n`,
  };
}

function describeEvidence(
  paths: Set<string>,
  params: Set<string>,
  members: Set<string>,
): string {
  const parts: string[] = [];
  if (paths.size) parts.push([...paths].join(", "));
  if (params.size) parts.push([...params].map((name) => `?${name}`).join(", "));
  if (members.size) parts.push([...members].join(", "));
  return parts.join("; ");
}

function contractCheck(input: ValidateInput): ValidationCheck {
  const workspaceConfig: Config = { ...input.config, root: input.workspace };
  const { manifest } = scanRepo(workspaceConfig);
  const integrationId = input.items[0]?.integrationId;
  const result = checkContracts({
    config: workspaceConfig,
    manifest,
    // Snapshots live with the real repository, not in the throwaway copy.
    specsDir: acbPaths(input.config.root).specs,
    integrationId,
  });

  const errors = result.problems.filter((problem) => problem.severity === "error");
  const warnings = result.problems.filter((problem) => problem.severity === "warning");

  if (result.checked.length === 0) {
    return {
      name: "HTTP contract",
      passed: true,
      details: `${integrationId}: no spec available, contract check skipped`,
    };
  }

  const describe = (list: typeof result.problems): string =>
    list.map((p) => `- ${p.file}:${p.line} — ${p.message}`).join("\n");

  if (errors.length === 0) {
    return {
      name: "HTTP contract",
      passed: true,
      details:
        contractSummary(result) + (warnings.length ? `\n${describe(warnings)}` : ""),
    };
  }

  return {
    name: "HTTP contract",
    passed: false,
    details: `${errors.length} call(s) do not match the provider's API description:\n${describe(errors)}`,
  };
}

function tail(text: string): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= OUTPUT_TAIL_LINES) return lines.join("\n");
  return ["… output trimmed …", ...lines.slice(-OUTPUT_TAIL_LINES)].join("\n");
}

/** A compact failure summary to hand back to the agent for another attempt. */
export function formatFailures(result: ValidationResult): string {
  return result.checks
    .filter((check) => !check.passed)
    .map((check) => `## ${check.name} failed\n\n${check.details}`)
    .join("\n\n");
}

export function validationSummary(result: ValidationResult): string {
  const failed = result.checks.filter((check) => !check.passed);
  if (failed.length === 0) return `all ${result.checks.length} check(s) passed`;
  return `${failed.length} of ${result.checks.length} check(s) failed: ${failed
    .map((check) => check.name)
    .join(", ")}`;
}
