// `acb observe` — record what the APIs this repo calls actually return, and
// notice when that changes.
//
// This is the signal the breakage dataset says matters most: applicable to
// 14 of 14 real cases and catching 13, where spec diffing managed 2 of 6.
// It is also the only signal that works on an API with no changelog, no spec
// and no announcement, which was 43% of the dataset.
//
// Deterministic end to end. A model is never consulted to decide whether
// something changed.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { acbPaths, readJson } from "../state.ts";
import { searchForSymbols } from "../impact/prefilter.ts";
import { debug } from "../log.ts";
import type { ChangeEntry, Manifest } from "../types.ts";
import { diffProfiles, MIN_SAMPLES, type Drift } from "./drift.ts";
import { profileSamples, type Profile } from "./profile.ts";
import { plannedProbes, runProbe, type ObserveSpec, type Probe } from "./probe.ts";

/** One endpoint's recorded contract. Commit these — they are the baseline. */
export type Observation = {
  version: 1;
  integrationId: string;
  method: "GET";
  path: string;
  url: string;
  recordedAt: string;
  status: number;
  profile: Profile;
};

/** A drift plus the thing that makes it actionable: who reads the field. */
export type DriftFinding = Drift & {
  integrationId: string;
  path_: string;
  endpoint: string;
  /** Where in this repository the affected field is read. */
  readAt: { file: string; line: number }[];
};

export type ObserveResult = {
  mode: "record" | "check";
  recorded: Observation[];
  findings: DriftFinding[];
  /** Endpoints we could not probe, and why. Surfaced, never swallowed. */
  skipped: { endpoint: string; reason: string }[];
  /** True when at least one finding touches a field this repo actually reads. */
  actionRequired: boolean;
};

/**
 * Ceiling on live requests per run, across every host. Three samples of a
 * handful of endpoints is the intended shape; anything approaching this
 * number means a misconfiguration, and stopping is friendlier than billing.
 */
export const DEFAULT_MAX_REQUESTS = 60;

export type ObserveOptions = {
  config: Config;
  manifest: Manifest;
  check?: boolean;
  integrationId?: string;
  dryRun?: boolean;
  samples?: number;
  minSamples?: number;
  /** Hard ceiling on live requests for the whole run. */
  maxRequests?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export async function observe(options: ObserveOptions): Promise<ObserveResult> {
  const { config, manifest } = options;
  const dir = acbPaths(config.root).observations;
  const budget = { remaining: options.maxRequests ?? DEFAULT_MAX_REQUESTS };
  const result: ObserveResult = {
    mode: options.check ? "check" : "record",
    recorded: [],
    findings: [],
    skipped: [],
    actionRequired: false,
  };

  for (const integration of manifest.integrations) {
    if (integration.kind !== "http") continue;
    if (options.integrationId && integration.id !== options.integrationId) continue;

    // Probing is opt-in per host, and deliberately so. Calling every endpoint
    // we happen to find would spend the developer's money without asking --
    // some APIs bill per request -- and would send traffic to a third party
    // that nobody approved. An unlisted host is reported, never called.
    const spec: ObserveSpec | undefined =
      config.observe[integration.host ?? ""] ?? config.observe[integration.id];
    if (!spec) {
      result.skipped.push({
        endpoint: integration.id,
        reason: `not listed under "observe" in acb.config.json, so it is never called`,
      });
      continue;
    }

    const { probes, skipped } = plannedProbes(integration, spec);
    for (const entry of skipped) {
      result.skipped.push({ endpoint: `GET ${entry.path}`, reason: entry.reason });
    }

    for (const probe of probes) {
      if (options.dryRun) {
        result.skipped.push({ endpoint: probe.url, reason: "dry run — not called" });
        continue;
      }

      const samples = options.samples ?? spec.samples ?? 3;
      if (budget.remaining < samples) {
        result.skipped.push({
          endpoint: probe.url,
          reason: `request budget reached (${options.maxRequests ?? DEFAULT_MAX_REQUESTS}) — raise it with --max-requests if this is intended`,
        });
        continue;
      }
      budget.remaining -= samples;

      const run = await runProbe(probe, {
        spec,
        samples: options.samples,
        fetchImpl: options.fetchImpl,
      });
      if (run.skipped) {
        result.skipped.push({ endpoint: probe.url, reason: run.skipped });
        continue;
      }

      const profile = profileSamples(run.bodies);
      const observation: Observation = {
        version: 1,
        integrationId: integration.id,
        method: "GET",
        path: probe.path,
        url: probe.url,
        recordedAt: (options.now?.() ?? new Date()).toISOString(),
        status: run.status,
        profile,
      };

      if (!options.check) {
        writeObservation(dir, observation);
        result.recorded.push(observation);
        continue;
      }

      const baseline = readObservation(dir, integration.id, probe);
      if (!baseline) {
        result.skipped.push({
          endpoint: probe.url,
          reason: "no baseline recorded yet — run `acb observe` first",
        });
        continue;
      }

      const drifts = diffProfiles(baseline.profile, profile, {
        minSamples: options.minSamples,
      });
      for (const drift of drifts) {
        const readAt = whoReads(config.root, manifest, drift.path);
        result.findings.push({
          ...drift,
          integrationId: integration.id,
          path_: drift.path,
          endpoint: `GET ${probe.path}`,
          readAt,
        });
        if (drift.severity === "breaking" && readAt.length > 0) result.actionRequired = true;
      }
    }
  }

  // Findings this repo actually reads come first. A drift on a field nobody
  // touches is a log line; a drift on a field read in src/billing is a PR.
  result.findings.sort(
    (a, b) =>
      Number(b.readAt.length > 0) - Number(a.readAt.length > 0) ||
      Number(a.severity === "info") - Number(b.severity === "info") ||
      a.path_.localeCompare(b.path_),
  );
  return result;
}

/**
 * Which lines in this repository read the drifted field.
 *
 * This is what separates a useful report from a noisy one. We search for the
 * leaf name rather than the full JSON path, because code reaches fields
 * through locals and destructuring far more often than through the whole
 * chain, and a missed join is worse than a loose one here: the finding still
 * gets reported, just without a line number.
 */
function whoReads(root: string, manifest: Manifest, fieldPath: string): { file: string; line: number }[] {
  const leaf = fieldPath.split(".").pop()?.replace(/\[\]$/, "").replace(/\{\*\}$/, "");
  if (!leaf || leaf.length < 3) return [];
  const hits = searchForSymbols(root, manifest, [leaf]);
  const unique = new Map<string, { file: string; line: number }>();
  for (const hit of hits) unique.set(`${hit.file}:${hit.line}`, { file: hit.file, line: hit.line });
  return [...unique.values()].slice(0, 5);
}

function observationFile(dir: string, integrationId: string, probe: Probe): string {
  const safe = `${integrationId}__GET__${probe.path}`.replace(/[^\w.-]+/g, "_").slice(0, 180);
  return path.join(dir, `${safe}.json`);
}

export function writeObservation(dir: string, observation: Observation): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = observationFile(dir, observation.integrationId, {
    method: "GET",
    url: observation.url,
    path: observation.path,
  });
  fs.writeFileSync(file, JSON.stringify(observation, null, 2) + "\n");
  debug(`recorded ${observation.url} -> ${path.relative(process.cwd(), file)}`);
}

export function readObservation(
  dir: string,
  integrationId: string,
  probe: Probe,
): Observation | undefined {
  const file = observationFile(dir, integrationId, probe);
  if (!fs.existsSync(file)) return undefined;
  return readJson<Observation | undefined>(file, undefined);
}

// --- Rendering -------------------------------------------------------------
//
// The report is the product surface. It has to answer three questions without
// the developer asking: what changed, does it affect me, and what do I do now.

export function renderObserve(result: ObserveResult): string {
  const lines: string[] = [];

  if (result.mode === "record") {
    if (result.recorded.length === 0 && result.skipped.length === 0) {
      return "No HTTP integrations to observe. Run `acb scan` first.";
    }
    lines.push(`Recorded ${result.recorded.length} endpoint contract(s):`);
    lines.push("");
    for (const observation of result.recorded) {
      const fields = observation.profile.fields.length;
      lines.push(
        `  ${observation.integrationId}  GET ${observation.path}` +
          `  ${observation.profile.samples} samples, ${fields} fields`,
      );
    }
    if (result.recorded.length) {
      lines.push("");
      lines.push("Commit .acb/observations/ — it is the baseline everything is compared against.");
      lines.push("Then run `acb observe --check` on a schedule, or in CI.");
    }
    renderSkipped(lines, result.skipped);
    return lines.join("\n");
  }

  if (result.findings.length === 0) {
    lines.push("No drift. Every observed field matches the recorded contract.");
    renderSkipped(lines, result.skipped);
    return lines.join("\n");
  }

  const breaking = result.findings.filter((finding) => finding.severity === "breaking");
  const info = result.findings.filter((finding) => finding.severity === "info");

  for (const finding of breaking) {
    lines.push(`${finding.integrationId}  ${finding.endpoint}`);
    lines.push("");
    lines.push(`  ✗ ${finding.path_ || "(whole response)"}`);
    lines.push(`    ${finding.summary}`);
    if (finding.readAt.length) {
      lines.push("");
      for (const site of finding.readAt) {
        lines.push(`    read at ${site.file}:${site.line}`);
      }
    } else {
      lines.push(`    nothing in this repository reads it — informational`);
    }
    lines.push("");
  }

  if (info.length) {
    lines.push(`New since the baseline (nothing breaks, but you may want them):`);
    for (const finding of info) {
      lines.push(`  + ${finding.path_}  ${finding.endpoint}`);
    }
    lines.push("");
  }

  const affected = breaking.filter((finding) => finding.readAt.length > 0).length;
  lines.push(
    `${breaking.length} breaking drift(s), ${affected} affecting code in this repository.`,
  );
  if (affected > 0) {
    lines.push("");
    lines.push("Next: `acb impact` to assess it, then `acb migrate` to open a PR.");
    lines.push("Or re-record with `acb observe` if you have already handled this.");
  }
  renderSkipped(lines, result.skipped);
  return lines.join("\n");
}

function renderSkipped(lines: string[], skipped: { endpoint: string; reason: string }[]): void {
  if (skipped.length === 0) return;
  lines.push("");
  lines.push(`Not observed (${skipped.length}):`);
  for (const entry of skipped.slice(0, 10)) {
    lines.push(`  ${entry.endpoint} — ${entry.reason}`);
  }
  if (skipped.length > 10) lines.push(`  …and ${skipped.length - 10} more`);
}

/**
 * Turn drift into the same `ChangeEntry` shape that `acb check` produces from
 * a spec or a changelog.
 *
 * This is the point of the whole feature: observed drift becomes just another
 * upstream change, so `acb impact` and `acb migrate` work on it unmodified.
 * Everything downstream — prefilter, agent brief, validation, PR — was already
 * built and does not need to know that this change was discovered by calling
 * the API rather than by reading an announcement.
 *
 * They are `kind: "openapi"` because the identifiers are exact, which is what
 * the prefilter uses to decide it may search the repository for field names.
 */
export function driftToChangeEntries(result: ObserveResult, now = new Date()): ChangeEntry[] {
  const breaking = result.findings.filter((finding) => finding.severity === "breaking");
  const byEndpoint = new Map<string, DriftFinding[]>();
  for (const finding of breaking) {
    const key = `${finding.integrationId} ${finding.endpoint}`;
    const list = byEndpoint.get(key) ?? [];
    list.push(finding);
    byEndpoint.set(key, list);
  }

  const entries: ChangeEntry[] = [];
  for (const [key, findings] of byEndpoint) {
    const [method, pathTemplate] = findings[0].endpoint.split(" ");
    // One entry per endpoint, not per field: a single upstream change usually
    // moves several fields at once, and three overlapping patches for one
    // operation is a worse outcome than one coherent migration.
    const moved = result.findings.filter((finding) => finding.severity === "info");
    entries.push({
      id: `drift:${hash(key + findings.map((f) => f.path_).join(","))}`,
      integrationId: findings[0].integrationId,
      source: "observed",
      kind: "openapi",
      title: `${findings[0].endpoint} response changed`,
      body: [
        `Observed by calling the API, not announced anywhere.`,
        ``,
        ...findings.map((finding) => `- \`${finding.path_}\`: ${finding.summary}`),
        ...(moved.length
          ? ["", "Fields that appeared at the same time, which may be the new home:",
             ...moved.map((finding) => `- \`${finding.path_}\``)]
          : []),
      ].join("\n"),
      date: now.toISOString().slice(0, 10),
      tags: ["breaking", "observed"],
      identifiers: findings.map((finding) => ({
        method,
        pathTemplate,
        field: finding.path_.split(".").pop()?.replace(/\[\]$/, ""),
      })),
    });
  }
  return entries;
}

function hash(input: string): string {
  // Content-addressed so re-observing the same drift does not create a new
  // entry every run, matching how changelog entry ids work.
  let value = 0;
  for (let index = 0; index < input.length; index++) {
    value = (Math.imul(31, value) + input.charCodeAt(index)) | 0;
  }
  return (value >>> 0).toString(16);
}

export { MIN_SAMPLES };
