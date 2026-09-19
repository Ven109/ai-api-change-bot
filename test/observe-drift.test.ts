// The drift detector decides whether a developer gets interrupted, so it is
// tested from both directions: it must catch the four real silent breakages
// from eval/cases/, and it must stay completely quiet through ordinary data
// churn. The second half matters more. A detector that cries wolf is deleted.

import assert from "node:assert/strict";
import test from "node:test";
import { diffProfiles, MIN_SAMPLES } from "../src/observe/drift.ts";
import { fieldAt, profileSamples } from "../src/observe/profile.ts";

/** Profiles built from the same response repeated, which is the common case. */
function profileOf(...samples: unknown[]) {
  return profileSamples(samples);
}

function repeat<T>(value: T, times: number): T[] {
  return Array.from({ length: times }, () => structuredClone(value));
}

test("a profile records types and value classes, never the values", () => {
  const profile = profileOf(
    { id: "cus_1", name: "Ada", tags: [], meta: { plan: "pro" } },
    { id: "cus_2", name: "", tags: ["x"], meta: { plan: "free" } },
  );

  const id = fieldAt(profile, "id")!;
  assert.deepEqual(id.types, ["string"]);
  assert.equal(id.present, 2);
  assert.equal(id.seen, 2);

  const name = fieldAt(profile, "name")!;
  assert.equal(name.empties, 1, "the empty string is counted as a class, not stored");

  assert.ok(fieldAt(profile, "meta.plan"), "nested fields are profiled");
  assert.equal(
    JSON.stringify(profile).includes("Ada"),
    false,
    "no observed value may appear anywhere in the profile",
  );
});

test("array elements collapse to one profile, so list length is not a schema change", () => {
  const before = profileOf({ items: [{ id: 1 }, { id: 2 }] });
  const after = profileOf({ items: [{ id: 9 }] });

  assert.ok(fieldAt(before, "items[].id"), "elements share one path");
  assert.equal(fieldAt(before, "items[].id")!.seen, 2, "each element is an observation");
  assert.deepEqual(
    diffProfiles(
      profileSamples(repeat({ items: [{ id: 1 }, { id: 2 }] }, 5)),
      profileSamples(repeat({ items: [{ id: 9 }] }, 5)),
    ),
    [],
    "a shorter list is data, not drift",
  );
  assert.equal(after.samples, 1);
});

test("id-keyed dictionaries do not invent a new field per key", () => {
  const many = (prefix: string) =>
    Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`${prefix}_${index}`, { status: "ok" }]),
    );

  const before = profileSamples(repeat({ byId: many("a") }, 5));
  const after = profileSamples(repeat({ byId: many("b") }, 5));

  assert.equal(
    before.fields.some((field) => field.path.includes("a_7")),
    false,
    "the keys are data and must not become paths",
  );
  assert.ok(fieldAt(before, "byId{*}.status"), "but their contents are still a contract");
  assert.deepEqual(
    diffProfiles(before, after),
    [],
    "an entirely different key set is not drift when the keys are data",
  );
});

// --- The four silent breakages from the dataset -----------------------------

test("Stripe: a field that moved away is caught (field_removed)", () => {
  // current_period_end left Subscription for SubscriptionItem. No error, no
  // status change -- it reached a database as new Date("Invalid Date").
  const before = profileSamples(
    repeat({ id: "sub_1", current_period_end: 1743465600, items: { data: [{ id: "si_1" }] } }, 5),
  );
  const after = profileSamples(
    repeat({ id: "sub_1", items: { data: [{ id: "si_1", current_period_end: 1743465600 }] } }, 5),
  );

  const drifts = diffProfiles(before, after);
  const removed = drifts.find((drift) => drift.path === "current_period_end")!;
  assert.equal(removed.kind, "field_removed");
  assert.equal(removed.severity, "breaking");

  const added = drifts.find((drift) => drift.path === "items.data[].current_period_end")!;
  assert.equal(added.kind, "field_added", "and the new home is surfaced, which is the fix");
  assert.equal(added.severity, "info");
});

test("Zoom: values blanked while the schema is untouched (became_empty)", () => {
  // Nine months of "user_email": "". Same status, same key, same type --
  // there is no schema check in existence that sees this.
  const before = profileSamples(repeat({ participants: [{ user_email: "a@b.com" }] }, 5));
  const after = profileSamples(repeat({ participants: [{ user_email: "" }] }, 5));

  const [drift] = diffProfiles(before, after);
  assert.equal(drift.kind, "became_empty");
  assert.equal(drift.path, "participants[].user_email");
  assert.match(drift.summary, /invisible to a schema check/);
});

test("Volvo: an object becomes null at HTTP 200 (became_null)", () => {
  const before = profileSamples(
    repeat({ data: { serviceTrigger: { value: "NORMAL", unit: "none" } } }, 5),
  );
  const after = profileSamples(repeat({ data: { serviceTrigger: null } }, 5));

  const drift = diffProfiles(before, after).find((entry) => entry.path === "data.serviceTrigger")!;
  assert.equal(drift.kind, "became_null");
  assert.equal(drift.severity, "breaking");
});

test("Meta: an edge that starts returning nothing (became_empty)", () => {
  const before = profileSamples(repeat({ posts: [{ id: "1" }], name: "Event" }, 5));
  const after = profileSamples(repeat({ posts: [], name: "Event" }, 5));

  const drift = diffProfiles(before, after).find((entry) => entry.path === "posts")!;
  assert.equal(drift.kind, "became_empty", "empty arrays read as 'no data', not as a break");
});

// --- The half that decides whether anyone keeps it installed ----------------

test("ordinary data churn produces no findings at all", () => {
  // Everything here changes between runs, and none of it is a contract change:
  // different ids, different numbers, a flag flipping, an optional field that
  // was always optional, a list growing and shrinking, a nullable that was
  // always sometimes null.
  const before = profileSamples([
    { id: "a1", count: 41, active: true, items: [{ n: 1 }], note: "hi", middle_name: null },
    { id: "a2", count: 7, active: false, items: [], note: "", middle_name: "Q" },
    { id: "a3", count: 0, active: true, items: [{ n: 2 }, { n: 3 }], middle_name: null },
    { id: "a4", count: 999, active: false, items: [{ n: 4 }], note: "x", middle_name: "R" },
    { id: "a5", count: 12, active: true, items: [], note: "y", middle_name: null },
  ]);
  const after = profileSamples([
    { id: "b9", count: 3, active: false, items: [], note: "", middle_name: "Z" },
    { id: "b8", count: 100000, active: true, items: [{ n: 8 }], middle_name: null },
    { id: "b7", count: 0, active: false, items: [{ n: 9 }, { n: 10 }], note: "zz", middle_name: null },
    { id: "b6", count: 5, active: true, items: [], note: "q", middle_name: "W" },
    { id: "b5", count: 64, active: true, items: [{ n: 11 }], note: "", middle_name: null },
  ]);

  assert.deepEqual(
    diffProfiles(before, after),
    [],
    "not one finding: ids, numbers, booleans, list length, optional and nullable fields all moved",
  );
});

test("a field that was only sometimes absent is never reported", () => {
  // This is the single most important suppression. Optional fields are
  // everywhere, and "it was missing today" is not news if it was ever missing.
  const before = profileSamples([
    { id: 1, coupon: "X" },
    { id: 2 },
    { id: 3, coupon: "Y" },
    { id: 4 },
    { id: 5, coupon: "Z" },
  ]);
  const after = profileSamples(repeat({ id: 9 }, 5));

  assert.deepEqual(diffProfiles(before, after), [], "it was always optional; its absence is not an event");
});

test("a sometimes-null field going fully null is not reported either", () => {
  const before = profileSamples([
    { ends_at: null },
    { ends_at: "2026-01-01" },
    { ends_at: null },
    { ends_at: "2026-02-01" },
    { ends_at: null },
  ]);
  const after = profileSamples(repeat({ ends_at: null }, 5));

  assert.deepEqual(
    diffProfiles(before, after),
    [],
    "callers of a sometimes-null field already handle null",
  );
});

test("too few samples means no claim, rather than a confident wrong one", () => {
  const before = profileSamples(repeat({ email: "a@b.com" }, 2));
  const after = profileSamples(repeat({ email: "" }, 2));

  assert.deepEqual(diffProfiles(before, after), [], `under ${MIN_SAMPLES} samples we say nothing`);
  assert.equal(
    diffProfiles(before, after, { minSamples: 2 }).length,
    1,
    "the floor is a policy, not a limitation",
  );
});

test("a nullable field losing its null is not a break for anyone reading it", () => {
  const before = profileSamples([
    { ends_at: null },
    { ends_at: "2026-01-01" },
    { ends_at: null },
    { ends_at: "2026-02-01" },
    { ends_at: null },
  ]);
  const after = profileSamples(repeat({ ends_at: "2026-03-01" }, 5));

  assert.deepEqual(diffProfiles(before, after), [], "code that handled null still works");
});

test("a wholesale change collapses into one finding, not one per field", () => {
  // If a probe returns an error envelope, every field looks 'removed'. That
  // must not produce fifty breaking findings.
  const before = profileSamples(repeat({ a: 1, b: 2, c: 3 }, 5));
  const after = profileSamples(repeat({ error: "rate limited" }, 5));

  const drifts = diffProfiles(before, after);
  assert.equal(drifts.length, 1, "one honest finding, not one per lost field");
  assert.equal(drifts[0].kind, "response_unrecognized");
  assert.match(drifts[0].summary, /error envelope/);
});
