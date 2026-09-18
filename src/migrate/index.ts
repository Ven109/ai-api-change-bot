// The `migrate` stage: brief, edit in a copy, validate, retry, write a patch.
//
// The unit of work is one integration, not one change entry: a deprecated
// operation, its renamed parameter and its removed response field are three
// upstream entries and a single edit. Migrating them separately would produce
// three overlapping patches for the same lines.
//
// The user's working tree is never touched, nothing is committed to their
// branch, and nothing is ever merged. The output is a patch (and, with --pr,
// a pull request for a human to review).

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { debug, info, llmStage, warn } from "../log.ts";
import { ModelError, type ModelProvider } from "../model/provider.ts";
import { acbPaths, writeFile } from "../state.ts";
import type {
  Candidate,
  ChangeEntry,
  ImpactItem,
  MigrationStatus,
  ValidationResult,
} from "../types.ts";
import { formatFailures, validateMigration, validationSummary } from "../validate/index.ts";
import { runAgent } from "./agent.ts";
import { buildBrief } from "./brief.ts";
import { runExternalAgent } from "./external.ts";
import { explainSelection, selectAgent } from "./select.ts";
import { runSdkAgent } from "./sdk-agent.ts";
import { renderValidation, type ToolContext } from "./tools.ts";
import {
  AGENT_FILES,
  changedFiles,
  createWorkspace,
  diffWorkspace,
  removeWorkspace,
} from "./workspace.ts";

export type MigrateInput = {
  config: Config;
  /** Not needed when migrate.agent.type is "command". */
  provider?: ModelProvider;
  /** Every relevant change for one integration. */
  items: ImpactItem[];
  candidates?: Candidate[];
  entries?: ChangeEntry[];
  /** Keep the workspace on disk for inspection. */
  keepWorkspace?: boolean;
};

export type MigrationOutcome = {
  integrationId: string;
  items: ImpactItem[];
  status: MigrationStatus;
  /** The agent's own account of what it did. */
  summary: string;
  validation?: ValidationResult;
  patchFile?: string;
  patch?: string;
  changedFiles: string[];
  attempts: number;
  transcriptFile: string;
  workspaceDir?: string;
  /** Set when the run could not be completed at all. */
  error?: string;
};

export async function migrateIntegration(input: MigrateInput): Promise<MigrationOutcome> {
  const { config, items, provider } = input;
  const integrationId = items[0].integrationId;
  const id = slug(integrationId);
  const paths = acbPaths(config.root);
  const transcriptFile = path.join(paths.reports, `${id}.transcript.jsonl`);
  fs.rmSync(transcriptFile, { force: true });

  const relevantCandidates = (input.candidates ?? []).filter((candidate) =>
    items.some((item) => item.entryId === candidate.entryId),
  );

  const agent = await selectAgent(config);
  info(`  ${explainSelection(agent)}`);
  if (agent.kind === "builtin" && !provider) {
    throw new ModelError(
      "migrating needs an agent: install one (npm i -D @anthropic-ai/claude-agent-sdk, or the " +
        'claude/codex/aider CLI), or configure a model for the built-in loop.',
    );
  }

  const workspace = await createWorkspace(config, id);
  const context: ToolContext = {
    config,
    workspaceDir: workspace.dir,
    validate: () =>
      validateMigration({
        config,
        workspace: workspace.dir,
        items,
        candidates: relevantCandidates,
      }),
  };

  const brief = buildBrief({
    integrationId,
    items,
    entries: input.entries,
    candidates: relevantCandidates,
  });
  // The brief is also written into the workspace, which is what an external
  // agent (AIA-25) reads. It is stripped from the patch.
  writeFile(path.join(workspace.dir, AGENT_FILES[0]), brief);

  let attempts = 0;
  let summary = "";
  let validation: ValidationResult | undefined;
  let status: MigrationStatus = "failed-validation";
  let message = brief;
  let error: string | undefined;

  while (attempts < config.migrate.maxAttempts) {
    attempts++;
    llmStage(
      agent.kind === "builtin" ? provider!.label : agent.label,
      "migrate",
      `${integrationId}, attempt ${attempts}/${config.migrate.maxAttempts}`,
    );

    let budgetExhausted = false;
    try {
      if (agent.kind === "sdk") {
        const run = await runSdkAgent({
          config,
          workspaceDir: workspace.dir,
          brief: message,
        });
        for (const event of run.events) {
          appendTranscript(transcriptFile, {
            type: "sdk-agent",
            attempt: attempts,
            tool: event.name,
            detail: event.detail,
          });
        }
        summary = run.summary || "(the agent gave no summary)";
        if (run.error) {
          warn(`${integrationId}: ${run.error}`);
          budgetExhausted = true;
        }
      } else if (agent.kind === "command") {
        const run = await runExternalAgent({
          config,
          workspaceDir: workspace.dir,
          brief: message,
        });
        appendTranscript(transcriptFile, {
          type: "external-agent",
          attempt: attempts,
          command: agent.command,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          stdout: run.stdout.slice(-4000),
          stderr: run.stderr.slice(-4000),
        });
        summary =
          firstMeaningfulLine(run.stdout) ||
          `The external agent exited with code ${run.exitCode}.`;
        if (run.timedOut) {
          budgetExhausted = true;
          warn(`${integrationId}: the external agent timed out`);
        }
      } else {
        const outcome = await runAgent({
          provider: provider!,
          context,
          brief: message,
          maxSteps: config.migrate.maxSteps,
          transcriptFile,
        });
        summary = outcome.summary;
        budgetExhausted = outcome.status === "budget-exhausted";
      }
    } catch (err) {
      // A provider failure mid-attempt still leaves whatever was edited, which
      // is worth keeping and reporting rather than throwing away.
      error = (err as Error).message;
      warn(`${integrationId}: the agent stopped early: ${error}`);
      if (err instanceof ModelError) status = "incomplete";
      else throw err;
      break;
    }

    // Validate ourselves regardless of what the agent claims: the report only
    // ever states what we verified.
    validation = await context.validate();
    debug(`attempt ${attempts}: ${validationSummary(validation)}`);

    if (validation.passed) {
      status = "validated";
      break;
    }
    status = budgetExhausted ? "incomplete" : "failed-validation";

    if (attempts < config.migrate.maxAttempts) {
      info(`      validation failed, asking the agent to fix it`);
      message =
        `${brief}\n\n# Your previous attempt did not validate\n\n` +
        `${formatFailures(validation)}\n\n` +
        (agent.kind !== "builtin"
          ? `Fix these problems in this directory. The same checks will run again afterwards.`
          : `Fix these problems. Use run_validation to confirm, then call finish.`);
    }
  }

  const patch = await diffWorkspace(workspace);
  const changed = (await changedFiles(workspace)).filter((file) => !AGENT_FILES.includes(file));

  let patchFile: string | undefined;
  if (patch.trim()) {
    patchFile = path.join(paths.patches, `${id}.patch`);
    writeFile(patchFile, patch);
  } else {
    warn(`${integrationId}: nothing was changed`);
    status = "incomplete";
  }

  const workspaceDir = input.keepWorkspace ? workspace.dir : undefined;
  if (!input.keepWorkspace) removeWorkspace(workspace);

  return {
    integrationId,
    items,
    status,
    summary,
    validation,
    patchFile,
    patch: patch.trim() ? patch : undefined,
    changedFiles: changed,
    attempts,
    transcriptFile,
    workspaceDir,
    error,
  };
}

function appendTranscript(file: string, entry: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

/** The agent's last substantive line of output, as its summary. */
function firstMeaningfulLine(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 20);
  return lines.at(-1)?.slice(0, 1000) ?? "";
}

/** Group relevant items by integration: one migration, one patch, one PR. */
export function groupByIntegration(items: ImpactItem[]): Map<string, ImpactItem[]> {
  const groups = new Map<string, ImpactItem[]>();
  for (const item of items) {
    if (!item.relevant) continue;
    const group = groups.get(item.integrationId) ?? [];
    group.push(item);
    groups.set(item.integrationId, group);
  }
  return groups;
}

export function slug(text: string): string {
  return text.replace(/[^\w.-]+/g, "_").slice(0, 80);
}

export { renderValidation };
