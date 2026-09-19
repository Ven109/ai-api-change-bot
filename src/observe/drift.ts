// Deciding whether two profiles differ in a way a developer should hear about.
//
// This is the most dangerous file in the project. A detector that fires on
// ordinary data variation gets uninstalled in a month, and an API's data varies
// constantly — that is what data is. So the bar is deliberately high, and the
// rule is narrow enough to state in one line:
//
//   only ALWAYS -> ALWAYS transitions are news.
//
// A field that was always present and is now always absent is a change to the
// contract. A field that was present in three of five samples was always
// optional, and its absence today is not an event. We would rather miss a real
// change than spend the developer's trust, because trust is spent once.
//
// Nothing here uses a model. A model may later *explain* a finding; it must
// never decide one.

import type { FieldProfile, JsonType, Profile } from "./profile.ts";

export type DriftKind =
  | "response_unrecognized"
  | "field_removed"
  | "field_added"
  | "type_changed"
  | "became_null"
  | "became_empty";

export type Drift = {
  kind: DriftKind;
  path: string;
  /** Plain-language statement of what changed, with the counts behind it. */
  summary: string;
  /** Always `breaking` unless the field is new, which cannot break a reader. */
  severity: "breaking" | "info";
};

/**
 * Below this many samples on either side we do not claim anything. Two
 * responses agreeing proves very little, and a false "always" is exactly how
 * this kind of tool loses a user. The Volvo case in the dataset was only
 * attributable because independent observations agreed.
 */
export const MIN_SAMPLES = 3;

export type DiffOptions = {
  /** Lower the sample floor. For tests and for `--force`, not for daily use. */
  minSamples?: number;
};

export function diffProfiles(before: Profile, after: Profile, options: DiffOptions = {}): Drift[] {
  const floor = options.minSamples ?? MIN_SAMPLES;
  if (before.samples < floor || after.samples < floor) return [];

  const beforeByPath = new Map(before.fields.map((field) => [field.path, field]));
  const afterByPath = new Map(after.fields.map((field) => [field.path, field]));

  // Before comparing field by field, ask whether we are even looking at the
  // same kind of response. An error envelope, a rate-limit body or a login
  // page makes every recorded field look removed, and fifty breaking findings
  // is a worse answer than one. This also happens to be how the loud breakages
  // in the dataset present -- Twitter's 453 body replaced the whole payload.
  if (!recognizable(before, after)) {
    return [
      {
        kind: "response_unrecognized",
        path: "",
        severity: "breaking",
        summary:
          `the response no longer resembles what was recorded: almost none of the ` +
          `${countAlways(before)} previously reliable fields are present. ` +
          `Often an error envelope, an auth failure or a redirect rather than a schema change`,
      },
    ];
  }

  const drifts: Drift[] = [];

  for (const [path, old] of beforeByPath) {
    const fresh = afterByPath.get(path);

    if (!fresh) {
      if (always(old)) {
        drifts.push({
          kind: "field_removed",
          path,
          severity: "breaking",
          summary: `was present in all ${old.seen} observations, now absent from all ${after.samples}`,
        });
      }
      continue;
    }

    if (always(old) && never(fresh)) {
      drifts.push({
        kind: "field_removed",
        path,
        severity: "breaking",
        summary: `was present in all ${old.seen} observations, now absent from all ${fresh.seen}`,
      });
      continue;
    }

    // A field that is present on both sides: did its nature change?
    if (!always(old) || !always(fresh)) continue;

    if (never(nullsOf(old)) && all(nullsOf(fresh))) {
      drifts.push({
        kind: "became_null",
        path,
        severity: "breaking",
        summary: `was never null in ${old.seen} observations, now null in all ${fresh.seen}`,
      });
      continue;
    }

    if (never(emptiesOf(old)) && all(emptiesOf(fresh))) {
      drifts.push({
        kind: "became_empty",
        path,
        severity: "breaking",
        summary:
          `was never empty in ${old.seen} observations, now empty in all ${fresh.seen} ` +
          `(same type, same key — invisible to a schema check)`,
      });
      continue;
    }

    const changed = typeChange(old.types, fresh.types);
    if (changed) {
      drifts.push({
        kind: "type_changed",
        path,
        severity: "breaking",
        summary: `was ${changed.from} in all ${old.seen} observations, now ${changed.to}`,
      });
    }
  }

  // New fields are worth mentioning and can never break a reader, so they are
  // reported at `info` and never gate a build. The RFS calls this out: useful
  // features launch quietly and go unnoticed.
  for (const [path, fresh] of afterByPath) {
    if (beforeByPath.has(path)) continue;
    if (!always(fresh)) continue;
    drifts.push({
      kind: "field_added",
      path,
      severity: "info",
      summary: `new field, present in all ${fresh.seen} observations`,
    });
  }

  drifts.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  return drifts;
}

/** Present every single time its container was seen. */
function always(field: FieldProfile): boolean {
  return field.seen > 0 && field.present === field.seen;
}

/** Never present, though the container was seen. */
function never(field: FieldProfile): boolean {
  return field.seen > 0 && field.present === 0;
}

/**
 * Whether the two profiles describe the same kind of payload at all.
 *
 * We take the fields that were reliably present before and ask how many are
 * present in any form now. Losing one or two is drift; losing nearly all of
 * them means the probe got something else entirely, and reporting that as
 * hundreds of removed fields would be both wrong and unreadable.
 */
function recognizable(before: Profile, after: Profile): boolean {
  const stable = before.fields.filter(always);
  if (stable.length === 0) return true;

  const afterPaths = new Set(
    after.fields.filter((field) => field.present > 0).map((field) => field.path),
  );
  const survivors = stable.filter((field) => afterPaths.has(field.path)).length;
  return survivors / stable.length >= RECOGNIZABLE_FRACTION;
}

/** Keep at least this share of the previously reliable fields to count as the same response. */
const RECOGNIZABLE_FRACTION = 0.5;

function countAlways(profile: Profile): number {
  return profile.fields.filter(always).length;
}

// nulls and empties are counted against `present`, not `seen`: a field that is
// absent is not also "not null". These wrap them into the same shape as
// `always`/`never` so the rules above read the same way.
function nullsOf(field: FieldProfile): FieldProfile {
  return { ...field, seen: field.present, present: field.nulls };
}

function emptiesOf(field: FieldProfile): FieldProfile {
  return { ...field, seen: field.present, present: field.empties };
}

function all(field: FieldProfile): boolean {
  return field.seen > 0 && field.present === field.seen;
}

/**
 * Only a clean swap counts: one type before, a different single type after.
 * A field that was `string | null` and is now `string` has not broken anyone,
 * and a field that gained a type is reported through `became_null` instead if
 * that is what actually happened.
 */
function typeChange(before: JsonType[], after: JsonType[]): { from: string; to: string } | null {
  const oldTypes = before.filter((type) => type !== "null");
  const newTypes = after.filter((type) => type !== "null");
  if (oldTypes.length !== 1 || newTypes.length !== 1) return null;
  if (oldTypes[0] === newTypes[0]) return null;
  return { from: oldTypes[0], to: newTypes[0] };
}

function rank(drift: Drift): number {
  return drift.severity === "breaking" ? 0 : 1;
}
