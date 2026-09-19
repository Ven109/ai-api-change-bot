// The scorer decides whether a whole project gets built, so its arithmetic
// gets the same scrutiny as the product code.

import assert from "node:assert/strict";
import test from "node:test";
import { leadDays, median, renderReport, scoreCases, type Case } from "../eval/score.ts";

function testCase(overrides: Partial<Case> & { id: string }): Case {
  return {
    api_host: "api.test",
    change: { kind: "operation_removed", summary: "gone" },
    announced_at: "2026-01-01",
    effective_at: "2026-06-01",
    signals: {},
    confidence: "verified",
    ...overrides,
  };
}

test("lead time is counted in days from detection to breakage", () => {
  assert.equal(leadDays("2026-01-01", "2026-06-01"), 151);
  assert.equal(leadDays("2026-06-01", "2026-06-01"), 0, "same-day detection is zero lead");
  assert.equal(median([10, 20, 30]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(median([]), null);
});

test("a signal that existed but saw nothing counts as a miss", () => {
  const report = scoreCases([
    testCase({
      id: "a",
      signals: {
        // The spec existed and simply never showed the change.
        spec: { available: true, detected_at: null, note: "spec never updated" },
      },
    }),
  ]);

  const spec = report.perSignal.find((entry) => entry.signal === "spec")!;
  assert.equal(spec.applicable, 1);
  assert.equal(spec.detected, 0);
  assert.equal(spec.detectionRate, 0);
  assert.deepEqual(report.missedEntirely, ["a"]);
});

test("a signal that did not exist is not counted against it", () => {
  const report = scoreCases([
    testCase({
      id: "a",
      signals: {
        spec: { available: false, note: "no spec published at the time" },
        changelog: { available: true, detected_at: "2026-01-01" },
      },
    }),
  ]);

  const spec = report.perSignal.find((entry) => entry.signal === "spec")!;
  assert.equal(spec.applicable, 0, "an absent signal is not a failed signal");
  assert.equal(spec.detectionRate, 0);

  const changelog = report.perSignal.find((entry) => entry.signal === "changelog")!;
  assert.equal(changelog.detectionRate, 1);
  assert.equal(changelog.medianLeadDays, 151);
});

test("the earliest signal wins, not the best-known one", () => {
  const report = scoreCases([
    testCase({
      id: "a",
      effective_at: "2026-06-01",
      signals: {
        spec: { available: true, detected_at: "2026-05-01" },
        changelog: { available: true, detected_at: "2026-01-15" },
        headers: { available: true, detected_at: "2026-03-01" },
      },
    }),
  ]);

  assert.equal(report.announced.detected, 1);
  // 2026-01-15 → 2026-06-01, the earliest of the three.
  assert.equal(report.announced.medianDays, 137);
});

test("unverified cases are excluded rather than allowed to flatter the number", () => {
  const report = scoreCases([
    testCase({ id: "good", signals: { changelog: { available: true, detected_at: "2026-01-01" } } }),
    testCase({ id: "shaky", confidence: "unverified", signals: {} }),
  ]);

  assert.equal(report.cases, 1);
  assert.equal(report.excluded, 1);
  assert.equal(report.announced.rate, 1, "the excluded case neither helps nor hurts");
});

test("silent changes are tracked separately, and so is contract-only detection", () => {
  const report = scoreCases([
    testCase({
      id: "silent-caught-by-calling",
      announced_at: null,
      signals: {
        changelog: { available: true, detected_at: null },
        contract: { available: true, detected_at: "2026-05-20" },
      },
    }),
    testCase({
      id: "silent-missed",
      announced_at: null,
      signals: { contract: { available: false } },
    }),
    testCase({
      id: "announced",
      announced_at: "2026-01-01",
      signals: { changelog: { available: true, detected_at: "2026-01-01" } },
    }),
  ]);

  assert.equal(report.silent.of, 2);
  assert.equal(report.announced.of, 1);
  assert.equal(report.silent.detected, 1);
  assert.equal(
    report.silent.byContractOnly,
    1,
    "the case only calling the API could have caught",
  );
  assert.deepEqual(report.missedEntirely, ["silent-missed"]);
});

test("the go/no-go threshold is applied as written, not negotiated", () => {
  // 3 of 3 detected, but all of them only days before the breakage.
  const lateButComplete = scoreCases([
    testCase({
      id: "a",
      effective_at: "2026-06-01",
      signals: { changelog: { available: true, detected_at: "2026-05-30" } },
    }),
    testCase({
      id: "b",
      effective_at: "2026-06-01",
      signals: { changelog: { available: true, detected_at: "2026-05-29" } },
    }),
    testCase({
      id: "c",
      effective_at: "2026-06-01",
      signals: { changelog: { available: true, detected_at: "2026-05-28" } },
    }),
  ]);
  assert.equal(lateButComplete.announced.rate, 1);
  assert.equal(
    lateButComplete.verdict.go,
    false,
    "100% detection two days out is not a product",
  );
  assert.match(lateButComplete.verdict.because, /misses the pre-registered bar/);

  // Early warning, but only half the cases.
  const earlyButPartial = scoreCases([
    testCase({ id: "a", signals: { changelog: { available: true, detected_at: "2026-01-01" } } }),
    testCase({ id: "b", signals: { changelog: { available: true, detected_at: null } } }),
  ]);
  assert.equal(earlyButPartial.verdict.go, false);

  const clears = scoreCases([
    testCase({ id: "a", signals: { spec: { available: true, detected_at: "2026-01-01" } } }),
    testCase({ id: "b", signals: { spec: { available: true, detected_at: "2026-02-01" } } }),
    testCase({ id: "c", signals: { spec: { available: true, detected_at: "2026-03-01" } } }),
    testCase({ id: "d", signals: { spec: { available: true, detected_at: null } } }),
  ]);
  assert.equal(clears.announced.rate, 0.75);
  assert.equal(clears.verdict.go, true);
});

test("a silent change is scored on how late it was caught, not on lead time", () => {
  // The dataset forced this split. A change nobody announced cannot be caught
  // early by any tool, so scoring it on lead time measures the metric, not the
  // product. Detection the day after it breaks is 1 day late, not -1 lead.
  const report = scoreCases([
    testCase({
      id: "silent",
      announced_at: null,
      effective_at: "2026-06-01",
      signals: { contract: { available: true, detected_at: "2026-06-03" } },
    }),
  ]);

  assert.equal(report.silent.detected, 1);
  assert.equal(report.silent.medianDays, 2, "two days late, not minus two days early");
  assert.equal(report.announced.of, 0);
  assert.equal(
    report.verdict.go,
    false,
    "an all-silent dataset cannot clear a bar about advance warning",
  );
  assert.match(report.verdict.implication, /ONLY be caught by calling the API/);
});

test("the pre-registered bar still binds the class it was written for", () => {
  // Splitting the metric must not become a way to pass by redefinition: an
  // announced change detected late still fails, exactly as it did before.
  const report = scoreCases([
    testCase({
      id: "announced-but-late",
      announced_at: "2026-01-01",
      effective_at: "2026-06-01",
      signals: { changelog: { available: true, detected_at: "2026-05-30" } },
    }),
  ]);

  assert.equal(report.announced.rate, 1);
  assert.equal(report.announced.medianDays, 2);
  assert.equal(report.verdict.go, false);
});

test("the announced detection rate is reported as circular, not as a win", () => {
  // Cases are classed as announced BECAUSE an announcement was found, so that
  // rate is near-tautological. The report has to say so itself, or the headline
  // number quietly flatters whatever tool is being judged.
  const report = scoreCases([
    testCase({ id: "a", announced_at: "2026-01-01", signals: { changelog: { available: true, detected_at: "2026-01-01" } } }),
    testCase({ id: "b", announced_at: null, signals: { contract: { available: true, detected_at: "2026-06-01" } } }),
  ]);

  assert.equal(report.announced.rate, 1);
  assert.equal(report.announcedShare, 0.5, "the non-circular number: half were announced at all");
  assert.match(renderReport(report), /circular/);
});

test("the report states the verdict and the uncomfortable numbers", () => {
  const markdown = renderReport(
    scoreCases([
      testCase({
        id: "a",
        announced_at: null,
        signals: {
          changelog: { available: true, detected_at: null },
          contract: { available: true, detected_at: "2026-05-25" },
        },
      }),
    ]),
  );

  assert.match(markdown, /\| changelog \| 1 \| 0 \| 0% \|/);
  assert.match(markdown, /Silent changes\*\*/);
  assert.match(markdown, /could only be caught by calling the API/);
  assert.match(markdown, /Registry verdict: NO-GO/);
});
