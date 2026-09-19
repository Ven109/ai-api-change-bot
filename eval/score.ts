// Scoring the breakage dataset: what would each signal have known, and when?
//
// This answers the one question the registry project is a bet on. It is
// deliberately unforgiving:
//
//   * a case with no `detected_at` counts as a miss, not as missing data;
//   * `confidence: unverified` cases are excluded from the headline number
//     rather than quietly inflating it;
//   * the silent subset is scored separately, because that is where
//     changelog-watching is structurally unable to help and where contract
//     verification has to earn its place.
//
// Two classes, two metrics — and the dataset is what forced this.
//
// An ANNOUNCED change can be caught before it bites, so the measure is lead
// time, against the threshold written down before collection: >=70% union
// detection with a median lead of >=30 days.
//
// A SILENT change cannot be caught early by anyone, because nothing exists to
// read. Scoring it on lead time would guarantee a failing number no matter how
// good the tool is, which would say more about the metric than the product.
// The measure there is detection LATENCY: how long after it breaks until you
// know, versus the current state of the art, which is waiting for a user to
// complain. Those are different products and they are reported separately.

import fs from "node:fs";
import path from "node:path";

const SIGNALS = ["spec", "changelog", "headers", "sdk", "contract"] as const;
type Signal = (typeof SIGNALS)[number];

const GO_DETECTION_RATE = 0.7;
const GO_MEDIAN_LEAD_DAYS = 30;

type SignalRecord = {
  available: boolean;
  detected_at?: string | null;
  source_url?: string;
  note?: string;
};

export type Case = {
  id: string;
  api_host: string;
  change: { kind: string; summary: string; method?: string; path_template?: string };
  announced_at?: string | null;
  effective_at: string;
  signals: Partial<Record<Signal, SignalRecord>>;
  evidence_of_pain?: string[];
  confidence: "verified" | "partial" | "unverified";
  notes?: string;
};

export type SignalScore = {
  signal: Signal;
  /** Cases where this signal existed at all. */
  applicable: number;
  detected: number;
  detectionRate: number;
  leadDays: number[];
  medianLeadDays: number | null;
  worstLeadDays: number | null;
};

export type ClassScore = {
  of: number;
  detected: number;
  rate: number;
  /** Announced: days of warning. Silent: days of delay (0 = same day). */
  medianDays: number | null;
};

export type Report = {
  cases: number;
  /** Share of all breakages that were announced anywhere at all. */
  announcedShare: number;
  excluded: number;
  perSignal: SignalScore[];
  announced: ClassScore;
  silent: ClassScore & { byContractOnly: number };
  missedEntirely: string[];
  verdict: { go: boolean; because: string; implication: string };
};

export function leadDays(detectedAt: string, effectiveAt: string): number {
  const ms = Date.parse(effectiveAt) - Date.parse(detectedAt);
  return Math.round(ms / 86_400_000);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

export function scoreCases(cases: Case[]): Report {
  // A case we could not verify cannot be evidence for or against anything.
  const scored = cases.filter((entry) => entry.confidence !== "unverified");
  const excluded = cases.length - scored.length;
  const silent = scored.filter((entry) => !entry.announced_at);

  const perSignal: SignalScore[] = SIGNALS.map((signal) => {
    const applicable = scored.filter((entry) => entry.signals[signal]?.available);
    const detections = applicable
      .map((entry) => entry.signals[signal])
      .filter((record): record is SignalRecord => Boolean(record?.detected_at));

    const leads = applicable.flatMap((entry) => {
      const detectedAt = entry.signals[signal]?.detected_at;
      return detectedAt ? [leadDays(detectedAt, entry.effective_at)] : [];
    });

    return {
      signal,
      applicable: applicable.length,
      detected: detections.length,
      detectionRate: applicable.length ? detections.length / applicable.length : 0,
      leadDays: leads,
      medianLeadDays: median(leads),
      worstLeadDays: leads.length ? Math.min(...leads) : null,
    };
  });

  const announcedCases = scored.filter((entry) => Boolean(entry.announced_at));
  const missedEntirely: string[] = [];
  for (const entry of scored) {
    if (earliestDetection(entry) === undefined) missedEntirely.push(entry.id);
  }

  const announced = classScore(announcedCases, "lead");
  const silentScore = classScore(silent, "latency");
  const silentByContractOnly = silent.filter((entry) => {
    const others = SIGNALS.filter((signal) => signal !== "contract");
    return (
      Boolean(entry.signals.contract?.detected_at) &&
      others.every((signal) => !entry.signals[signal]?.detected_at)
    );
  }).length;

  // The pre-registered threshold applies to the announced class, which is what
  // a registry of announcements can possibly serve.
  //
  // Read `announced.rate` with suspicion: a case carries an announced_at only
  // because research FOUND the announcement, so this rate is close to circular
  // and will tend to 100% no matter how good any tool is. The number that is
  // not circular is announcedShare — what fraction of breakages were announced
  // at all — and the lead time on those.
  const go =
    announced.rate >= GO_DETECTION_RATE && (announced.medianDays ?? 0) >= GO_MEDIAN_LEAD_DAYS;

  return {
    cases: scored.length,
    announcedShare: scored.length ? announcedCases.length / scored.length : 0,
    excluded,
    perSignal,
    announced,
    silent: { ...silentScore, byContractOnly: silentByContractOnly },
    missedEntirely,
    verdict: {
      go,
      because: go
        ? `announced changes: ${percent(announced.rate)} detected, median lead ` +
          `${announced.medianDays}d — clears the pre-registered bar ` +
          `(>=${percent(GO_DETECTION_RATE)}, >=${GO_MEDIAN_LEAD_DAYS}d)`
        : `announced changes: ${percent(announced.rate)} detected, median lead ` +
          `${announced.medianDays ?? "n/a"}d — misses the pre-registered bar ` +
          `(>=${percent(GO_DETECTION_RATE)}, >=${GO_MEDIAN_LEAD_DAYS}d)`,
      implication: implication(silentScore, silentByContractOnly, scored.length),
    },
  };
}

function classScore(cases: Case[], metric: "lead" | "latency"): ClassScore {
  const days: number[] = [];
  let detected = 0;
  for (const entry of cases) {
    const earliest = earliestDetection(entry);
    if (earliest === undefined) continue;
    detected++;
    // Lead counts down to the breakage; latency counts up from it. A silent
    // change detected on the day it lands is latency 0, not lead 0.
    const value =
      metric === "lead"
        ? leadDays(earliest, entry.effective_at)
        : Math.max(0, -leadDays(earliest, entry.effective_at));
    days.push(value);
  }
  return {
    of: cases.length,
    detected,
    rate: cases.length ? detected / cases.length : 0,
    medianDays: median(days),
  };
}

/** What the silent subset means for what should be built. */
function implication(
  silent: ClassScore,
  byContractOnly: number,
  total: number,
): string {
  if (silent.of === 0) return "No silent changes in the dataset, so nothing can be concluded about them.";
  const share = Math.round((silent.of / total) * 100);
  if (byContractOnly === 0) {
    return `${silent.of} silent change(s) (${share}% of the dataset), none of which needed a live call to catch.`;
  }
  return (
    `${silent.of} of ${total} cases (${share}%) were announced nowhere, and ${byContractOnly} ` +
    `could ONLY be caught by calling the API. No registry of documents can reach those, ` +
    `however complete it is — which makes contract verification the primary signal, not a supplement.`
  );
}

function earliestDetection(entry: Case): string | undefined {
  const dates = SIGNALS.map((signal) => entry.signals[signal]?.detected_at).filter(
    (date): date is string => Boolean(date),
  );
  if (dates.length === 0) return undefined;
  return dates.sort()[0];
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function renderReport(report: Report): string {
  const lines: string[] = [];
  lines.push("# Breakage detection: what would we have known, and when?");
  lines.push("");
  lines.push(
    `${report.cases} scored case(s)` +
      (report.excluded ? `, ${report.excluded} excluded as unverified` : "") +
      `: ${report.announced.of} announced, ${report.silent.of} announced nowhere.`,
  );
  lines.push("");
  lines.push("| Signal | Applicable | Detected | Rate | Median lead | Worst lead |");
  lines.push("<!-- lead is days BEFORE the break; a negative number means the signal only spoke afterwards -->");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const score of report.perSignal) {
    lines.push(
      `| ${score.signal} | ${score.applicable} | ${score.detected} | ` +
        `${percent(score.detectionRate)} | ` +
        `${score.medianLeadDays === null ? "—" : `${score.medianLeadDays}d`} | ` +
        `${score.worstLeadDays === null ? "—" : `${score.worstLeadDays}d`} |`,
    );
  }
  lines.push("");
  lines.push(
    `**Announced changes** (can be caught early): ${report.announced.detected}/${report.announced.of} ` +
      `detected (${percent(report.announced.rate)}), median lead ` +
      `${report.announced.medianDays === null ? "—" : `${report.announced.medianDays}d`}.`,
  );
  lines.push("");
  lines.push(
    `> Treat that detection rate as circular: a case is classed as announced only because ` +
      `the announcement was found, so it tends to 100% regardless of tooling. The honest ` +
      `figures are the **${percent(report.announcedShare)} of breakages that were announced at all** ` +
      `and the median lead on those.`,
  );
  lines.push("");
  lines.push(
    `**Silent changes** (cannot be caught early by anyone): ${report.silent.detected}/${report.silent.of} ` +
      `detected (${percent(report.silent.rate)}), median delay after breaking ` +
      `${report.silent.medianDays === null ? "—" : `${report.silent.medianDays}d`}. ` +
      `${report.silent.byContractOnly} could only be caught by calling the API.`,
  );
  lines.push("");
  if (report.missedEntirely.length) {
    lines.push(`**Caught by nothing:** ${report.missedEntirely.join(", ")}`);
    lines.push("");
  }
  lines.push(`**Registry verdict: ${report.verdict.go ? "GO" : "NO-GO"}** — ${report.verdict.because}`);
  lines.push("");
  lines.push(`**What the silent subset implies:** ${report.verdict.implication}`);
  return lines.join("\n");
}

/** Cases are YAML-ish but committed as JSON, so no parser dependency is needed. */
export function loadCases(dir: string): Case[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Case);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const dir = path.join(import.meta.dirname, "cases");
  const cases = loadCases(dir);
  if (cases.length === 0) {
    console.error(`no cases in ${dir}`);
    process.exit(1);
  }
  console.log(renderReport(scoreCases(cases)));
}
