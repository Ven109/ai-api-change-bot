// A field-level profile of what an endpoint actually returns.
//
// This exists because of what the breakage dataset showed (eval/FINDINGS.md):
// the changes that hurt people longest were HTTP 200 with an unchanged shape.
// Zoom returned `"user_email": ""` for nine months. Volvo flipped an object to
// `null`. Stripe moved a field and it reached a database as `Invalid Date`.
// Every one of those is invisible to a spec diff, to a key-set diff, and to
// error monitoring — same status, same names, same structure.
//
// So we record types and value *classes*, never values. A profile says "this
// field was a non-empty string in all five samples", which is enough to notice
// it becoming empty and not enough to leak what it contained.

/** The JSON type of an observed value. `null` is its own type, deliberately. */
export type JsonType = "string" | "number" | "boolean" | "null" | "array" | "object";

export type FieldProfile = {
  /** Dotted path, with `[]` for array elements: `data.items[].id`. */
  path: string;
  /** How many times this field's container was observed. The denominator. */
  seen: number;
  /** How many of those had the key at all. */
  present: number;
  /** Types observed, sorted, so the record is stable across runs. */
  types: JsonType[];
  /** Observations that were `null`. */
  nulls: number;
  /** Observations that were `""`, `[]` or `{}`. Zero and false are NOT empty. */
  empties: number;
};

export type Profile = {
  /** How many responses went into this profile. */
  samples: number;
  /** Sorted by path, so two profiles of the same API are byte-identical. */
  fields: FieldProfile[];
};

/**
 * Containers with more keys than this are treated as dictionaries keyed by
 * data (`usersById`, `{"cus_123": {...}}`) rather than as records with a fixed
 * shape. Without this, every new id invents a new field path, the profile
 * grows without bound, and every run reports dozens of "new fields" that are
 * just yesterday's data. Their contents still get profiled under `{*}`, so a
 * real change inside the values is still visible.
 */
const DICTIONARY_KEY_THRESHOLD = 40;

/** Depth limit, so a self-referential or pathological response cannot hang a run. */
const MAX_DEPTH = 12;

export function profileSamples(samples: unknown[]): Profile {
  // Two tallies: how often each container was visited, and what was found in
  // it. A field's denominator is its parent's visit count, which is what makes
  // "absent in 2 of 5" expressible rather than silently missing.
  const containerSeen = new Map<string, number>();
  const fields = new Map<string, Omit<FieldProfile, "path" | "seen">>();

  for (const sample of samples) visit(sample, "", 0, containerSeen, fields);

  const out: FieldProfile[] = [];
  for (const [path, stats] of fields) {
    out.push({ path, seen: containerSeen.get(parentPath(path)) ?? 0, ...stats });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { samples: samples.length, fields: out };
}

function visit(
  value: unknown,
  path: string,
  depth: number,
  containerSeen: Map<string, number>,
  fields: Map<string, Omit<FieldProfile, "path" | "seen">>,
): void {
  if (depth > MAX_DEPTH) return;

  if (Array.isArray(value)) {
    // Every element folds into one `[]` profile. Profiling per index would make
    // list ordering and length look like schema changes, which they are not.
    for (const element of value) visit(element, `${path}[]`, depth + 1, containerSeen, fields);
    return;
  }

  if (!isRecord(value)) return;

  const keys = Object.keys(value);
  const asDictionary = keys.length > DICTIONARY_KEY_THRESHOLD;
  const containerPath = asDictionary ? `${path}{*}` : path;

  // A dictionary node holds no fields of its own — its keys are data. Counting
  // it as a container too would inflate the denominator of everything beneath
  // it by one and make fields look intermittently absent.
  if (!asDictionary) {
    containerSeen.set(containerPath, (containerSeen.get(containerPath) ?? 0) + 1);
  }

  for (const key of keys) {
    const child = (value as Record<string, unknown>)[key];
    if (asDictionary) {
      // The keys are data; only what is under them is a contract.
      visit(child, containerPath, depth + 1, containerSeen, fields);
      continue;
    }

    const childPath = path ? `${path}.${key}` : key;
    record(fields, childPath, child);
    visit(child, childPath, depth + 1, containerSeen, fields);
  }
}

function record(
  fields: Map<string, Omit<FieldProfile, "path" | "seen">>,
  path: string,
  value: unknown,
): void {
  let stats = fields.get(path);
  if (!stats) {
    stats = { present: 0, types: [], nulls: 0, empties: 0 };
    fields.set(path, stats);
  }

  stats.present++;
  const type = typeOf(value);
  if (!stats.types.includes(type)) {
    stats.types.push(type);
    stats.types.sort();
  }
  if (type === "null") stats.nulls++;
  if (isEmpty(value)) stats.empties++;
}

export function typeOf(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
    case "bigint":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

/**
 * Empty means "carries no information": `""`, `[]`, `{}`. Zero and false are
 * ordinary values and must never count, or every boolean flag in the response
 * becomes a drift report the first time it is false.
 */
export function isEmpty(value: unknown): boolean {
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `data.items[].id` -> `data.items[]`; a top-level key -> `""`. */
function parentPath(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(0, dot);
}

/** Look a field up by path. Profiles are sorted, but callers want it by name. */
export function fieldAt(profile: Profile, path: string): FieldProfile | undefined {
  return profile.fields.find((field) => field.path === path);
}
