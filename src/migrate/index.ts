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
  provider: ModelProvider;
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
      provider.label,
      "migrate",
      `${integrationId}, attempt ${attempts}/${config.migrate.maxAttempts}`,
    );

    let budgetExhausted = false;
    try {
      const outcome = await runAgent({
        provider,
        context,
        brief: message,
        maxSteps: config.migrate.maxSteps,
        transcriptFile,
      });
      summary = outcome.summary;
      budgetExhausted = outcome.status === "budget-exhausted";
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
        `Fix these problems. Use run_validation to confirm, then call finish.`;
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
