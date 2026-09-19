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
// The threshold was written down before the data was collected (see
// eval/README.md): >=70% union detection with a median lead time of >=30 days.

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

export type Report = {
  cases: number;
  excluded: number;
  silent: number;
  perSignal: SignalScore[];
  union: { detected: number; rate: number; medianLeadDays: number | null };
  silentUnion: { detected: number; of: number; byContractOnly: number };
  missedEntirely: string[];
  verdict: { go: boolean; because: string };
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

  // The union: the earliest any signal would have known.
  const unionLeads: number[] = [];
  const missedEntirely: string[] = [];
  for (const entry of scored) {
    const earliest = earliestDetection(entry);
    if (earliest === undefined) missedEntirely.push(entry.id);
    else unionLeads.push(leadDays(earliest, entry.effective_at));
  }

  const silentDetected = silent.filter((entry) => earliestDetection(entry) !== undefined);
  const silentByContractOnly = silent.filter((entry) => {
    const others = SIGNALS.filter((signal) => signal !== "contract");
    const onlyContract =
      Boolean(entry.signals.contract?.detected_at) &&
      others.every((signal) => !entry.signals[signal]?.detected_at);
    return onlyContract;
  });

  const unionRate = scored.length ? unionLeads.length / scored.length : 0;
  const unionMedian = median(unionLeads);
  const go = unionRate >= GO_DETECTION_RATE && (unionMedian ?? 0) >= GO_MEDIAN_LEAD_DAYS;

  return {
    cases: scored.length,
    excluded,
    silent: silent.length,
    perSignal,
    union: { detected: unionLeads.length, rate: unionRate, medianLeadDays: unionMedian },
    silentUnion: {
      detected: silentDetected.length,
      of: silent.length,
      byContractOnly: silentByContractOnly.length,
    },
    missedEntirely,
    verdict: {
      go,
      because: go
        ? `union detection ${percent(unionRate)} with median lead ${unionMedian}d clears the ` +
          `threshold set before collection (>=${percent(GO_DETECTION_RATE)}, >=${GO_MEDIAN_LEAD_DAYS}d)`
        : `union detection ${percent(unionRate)} with median lead ${unionMedian ?? "n/a"}d misses ` +
          `the threshold (>=${percent(GO_DETECTION_RATE)}, >=${GO_MEDIAN_LEAD_DAYS}d). ` +
          `A registry of announcements is not enough; contract verification is the product.`,
    },
  };
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
      `, of which ${report.silent} had no announcement anywhere.`,
  );
  lines.push("");
  lines.push("| Signal | Applicable | Detected | Rate | Median lead | Worst lead |");
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
    `**Union:** ${report.union.detected}/${report.cases} detected by at least one signal ` +
      `(${percent(report.union.rate)}), median lead ` +
      `${report.union.medianLeadDays === null ? "—" : `${report.union.medianLeadDays}d`}.`,
  );
  lines.push("");
  lines.push(
    `**Silent changes:** ${report.silentUnion.detected}/${report.silentUnion.of} caught, ` +
      `${report.silentUnion.byContractOnly} of them **only** by calling the API. ` +
      `This is the number that says whether contract verification is optional.`,
  );
  lines.push("");
  if (report.missedEntirely.length) {
    lines.push(`**Caught by nothing:** ${report.missedEntirely.join(", ")}`);
    lines.push("");
  }
  lines.push(`**Verdict: ${report.verdict.go ? "GO" : "NO-GO"}** — ${report.verdict.because}`);
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
