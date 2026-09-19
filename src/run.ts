// `acb run`: the whole loop, in one command.
//
// This is the experience the product is really about — one scheduled command
// that keeps a repository's API integrations healthy. Each stage announces
// whether it was deterministic or model-powered, so the boundary is visible
// in the terminal and in CI logs rather than only in the docs.

import path from "node:path";
import type { Config } from "./config.ts";
import { checkUpstream } from "./check/index.ts";
import { analyzeImpact } from "./impact/index.ts";
import { renderMarkdownReport, reportFileName } from "./impact/report.ts";
import {
  EXIT_ACTION_REQUIRED,
  EXIT_OK,
  debug,
  info,
  llmStage,
  stage,
  warn,
} from "./log.ts";
import { guard } from "./model/egress.ts";
import { createProvider } from "./model/index.ts";
import { groupByIntegration, migrateIntegration, type MigrationOutcome } from "./migrate/index.ts";
import { openPullRequest } from "./deliver/pr.ts";
import { driftToChangeEntries, observe } from "./observe/index.ts";
import { countCallSites, scanRepo } from "./scan/index.ts";
import { acbPaths, readJson, readState, writeFile, writeJson, writeState } from "./state.ts";
import type { ImpactItem, Manifest, MigrationStatus } from "./types.ts";
import { validationSummary } from "./validate/index.ts";

export type RunOptions = {
  /** Open a pull request for each migration. Never merges. */
  pr?: boolean;
  noLlm: boolean;
  noMigrate: boolean;
  offline: boolean;
  dryRunLlm: boolean;
  since?: string;
  keepWorkspace: boolean;
  json: boolean;
  /**
   * Also call the APIs and compare against the recorded contracts. Opt-in
   * because it makes live requests with the developer's credentials, which is
   * not something to start doing by surprise.
   */
  observe?: boolean;
};

export type RunItemResult = {
  integrationId: string;
  change: string;
  risk: string;
  deadline?: string;
  status: MigrationStatus | "dismissed";
  patchFile?: string;
  validation?: string;
  prUrl?: string;
};

export type RunResult = {
  integrations: number;
  callSites: number;
  newChanges: number;
  filteredOut: number;
  relevant: number;
  results: RunItemResult[];
  reportFile?: string;
  analyzer: string;
  egress?: string;
  exitCode: number;
};

export async function runLoop(config: Config, options: RunOptions): Promise<RunResult> {
  const paths = acbPaths(config.root);

  // 1. scan [deterministic]
  const previous = readJson<Manifest | undefined>(paths.manifest, undefined);
  const scanned = scanRepo(config, { previous });
  writeJson(paths.manifest, scanned.manifest);
  stage(
    "scan",
    `${scanned.manifest.integrations.length} integration(s), ` +
      `${countCallSites(scanned.manifest)} call site(s), ` +
      `${scanned.filesParsed} file(s) parsed, ${scanned.filesReused} cached`,
  );

  // 2. check [deterministic]
  const state = readState(config.root);
  const check = await checkUpstream(config, scanned.manifest, state, {
    offline: options.offline,
    baseline: false,
    since: options.since,
  });
  writeState(config.root, state);
  writeJson(paths.changes, {
    generatedAt: new Date().toISOString(),
    entries: check.entries,
  });
  stage("check", `${check.entries.length} new upstream change(s)`);
  for (const integrationId of check.withoutSources) {
    warn(`${integrationId}: no upstream source configured, so it cannot be checked`);
  }

  // 2b. observe [deterministic]
  //
  // What the provider *says*, above, covers a bit over half of real breakages.
  // What the provider *does* covers the rest -- including everything that is
  // announced nowhere, which was 43% of the measured dataset. Drift arrives as
  // ordinary change entries so the stages below need no special case.
  const entries = [...check.entries];
  if (options.observe) {
    const observed = await observe({
      config,
      manifest: scanned.manifest,
      check: true,
    });
    const drifted = driftToChangeEntries(observed);
    const breaking = observed.findings.filter((finding) => finding.severity === "breaking").length;
    stage(
      "observe",
      `${breaking} breaking drift(s) across ${observed.findings.length} change(s) in live responses`,
    );
    for (const skipped of observed.skipped) {
      debug(`${skipped.endpoint}: ${skipped.reason}`);
    }
    entries.push(...drifted);
    if (drifted.length) {
      writeJson(paths.changes, { generatedAt: new Date().toISOString(), entries });
    }
  }

  const base: RunResult = {
    integrations: scanned.manifest.integrations.length,
    callSites: countCallSites(scanned.manifest),
    newChanges: entries.length,
    filteredOut: 0,
    relevant: 0,
    results: [],
    analyzer: "deterministic prefilter only",
    exitCode: EXIT_OK,
  };

  if (entries.length === 0) {
    info(
      options.observe
        ? "nothing new upstream and no drift in live responses, nothing to do"
        : "nothing new upstream, nothing to do",
    );
    return base;
  }

  // 3. impact [deterministic prefilter, then LLM]
  const provider = options.noLlm
    ? undefined
    : guard(createProvider(config), { config, dryRun: options.dryRunLlm });
  if (!options.noLlm && !provider) {
    warn("no model configured: reporting the deterministic evidence only");
  }

  const impact = await analyzeImpact(config, scanned.manifest, entries, {
    noLlm: options.noLlm,
    provider,
  });
  base.analyzer = impact.analyzer;
  base.filteredOut = impact.unmatched.length;

  stage(
    "impact",
    `${impact.candidates.length} candidate(s), ` +
      `${impact.unmatched.length} filtered out before any model call`,
  );
  if (provider && !impact.dryRunFile) {
    llmStage(provider.label, "impact", `${impact.items.length} candidate(s) assessed`);
  }

  const generatedAt = new Date().toISOString();
  const reportBase = path.join(paths.reports, reportFileName(generatedAt));
  writeFile(
    reportBase + ".md",
    renderMarkdownReport({
      items: impact.items,
      unmatched: impact.unmatched,
      entries: entries,
      analyzer: impact.analyzer,
      generatedAt,
      egress: provider?.summary(),
    }),
  );
  writeJson(reportBase + ".json", {
    generatedAt,
    analyzer: impact.analyzer,
    items: impact.items,
    candidates: impact.candidates,
    unmatched: impact.unmatched.map((entry) => ({ id: entry.id, title: entry.title })),
  });
  base.reportFile = reportBase + ".md";

  if (impact.dryRunFile) {
    info(
      `dry run: ${impact.dryRunFiles?.length ?? 1} prompt(s) written to ` +
        `${path.dirname(impact.dryRunFile)}, nothing sent`,
    );
    base.egress = provider?.summary();
    return base;
  }

  for (const item of impact.items) {
    if (item.relevant) continue;
    base.results.push({
      integrationId: item.integrationId,
      change: item.summary,
      risk: item.risk,
      status: "dismissed",
    });
  }

  const relevant = impact.items.filter((item) => item.relevant);
  base.relevant = relevant.length;

  if (relevant.length === 0) {
    info("no upstream change affects this repository");
    base.egress = provider?.summary();
    return base;
  }

  // 4. migrate + validate [LLM agent, then deterministic]
  // --no-llm is a promise that nothing reaches a model, and a coding agent is
  // a model. Auto-detecting one must not quietly reintroduce it here.
  const canMigrate =
    !options.noMigrate &&
    !options.noLlm &&
    (provider !== undefined || config.migrate.agent.type !== "builtin");
  if (!canMigrate) {
    for (const item of relevant) {
      base.results.push(describeItem(item, "report-only"));
    }
    if (options.noLlm) debug("--no-llm: reporting only, no agent runs");
    else if (options.noMigrate) debug("--no-migrate: stopping after the report");
    else warn("no agent available and no model configured, so no migration was attempted");
    base.exitCode = EXIT_ACTION_REQUIRED;
    base.egress = provider?.summary();
    return base;
  }

  const outcomes: MigrationOutcome[] = [];
  for (const [, items] of groupByIntegration(relevant)) {
    const outcome = await migrateIntegration({
      config,
      provider,
      items,
      candidates: impact.candidates,
      entries: entries,
      keepWorkspace: options.keepWorkspace,
    });
    outcomes.push(outcome);

    let prUrl: string | undefined;
    if (options.pr) {
      const pr = await openPullRequest({
        config,
        outcome,
        entries: entries,
        reportFile: base.reportFile,
      });
      prUrl = pr.url;
      if (pr.url) {
        info(`      pull request${pr.draft ? " (draft)" : ""}: ${pr.url}`);
      } else if (pr.skipped) {
        warn(`no pull request opened: ${pr.skipped}`);
      }
    }

    for (const item of items) {
      base.results.push({
        ...describeItem(item, outcome.status),
        patchFile: outcome.patchFile,
        validation: outcome.validation ? validationSummary(outcome.validation) : undefined,
        prUrl,
      });
    }
  }

  base.egress = provider?.summary();
  // Always "action required": even a fully validated migration is waiting for
  // a human to review and merge it. Nothing here is ever auto-applied.
  base.exitCode = EXIT_ACTION_REQUIRED;
  return base;
}

function describeItem(item: ImpactItem, status: MigrationStatus): RunItemResult {
  return {
    integrationId: item.integrationId,
    change: item.summary,
    risk: item.risk,
    deadline: item.deadline,
    status,
  };
}

/** The end-of-run table. Short enough to read in a CI log. */
export function renderSummary(result: RunResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `Summary: ${result.integrations} integration(s), ${result.newChanges} new upstream ` +
      `change(s), ${result.relevant} affecting this repository ` +
      `(${result.filteredOut} filtered out deterministically)`,
  );
  if (result.results.length === 0) return lines.join("\n");

  lines.push("");
  const rows = result.results.map((row) => [
    row.integrationId,
    truncate(row.change, 56),
    row.risk,
    row.deadline ?? "—",
    row.status,
  ]);
  const header = ["integration", "change", "risk", "deadline", "status"];
  const widths = header.map((_, column) =>
    Math.max(header[column].length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();

  lines.push(line(header));
  lines.push(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) lines.push(line(row));

  const patches = result.results.map((row) => row.patchFile).filter(Boolean);
  if (patches.length) {
    lines.push("");
    for (const patch of [...new Set(patches)]) lines.push(`patch: ${patch}`);
  }
  const prs = result.results.map((row) => row.prUrl).filter(Boolean);
  for (const pr of [...new Set(prs)]) lines.push(`pull request: ${pr}`);
  if (result.reportFile) lines.push(`report: ${result.reportFile}`);
  if (result.egress) lines.push(result.egress);
  lines.push("");
  lines.push("Nothing was merged. Review the patch before applying it.");
  return lines.join("\n");
}

function truncate(text: string, length: number): string {
  const single = text.replace(/\s+/g, " ");
  return single.length > length ? single.slice(0, length - 1) + "…" : single;
}

