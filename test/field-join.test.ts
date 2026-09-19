// How code actually reads a response field, measured rather than assumed.
//
// This join decides whether a drift finding carries a line number the
// developer can jump to, so it is tested as a recall/precision pair against
// the idioms real code uses. An earlier version matched only `x.field` and
// `x["field"]` and missed four of the ten shapes below, including
// destructuring and Python's `.get()`.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { searchForSymbols } from "../src/impact/prefilter.ts";
import type { Manifest } from "../src/types.ts";

function search(symbol: string, cases: Record<string, string>): Set<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acb-join-"));
  for (const [file, code] of Object.entries(cases)) {
    fs.writeFileSync(path.join(root, file), code);
  }
  const manifest = {
    files: Object.fromEntries(Object.keys(cases).map((file) => [file, "hash"])),
  } as unknown as Manifest;
  return new Set(searchForSymbols(root, manifest, [symbol]).map((hit) => hit.file));
}

test("the idioms that read a field are found", () => {
  const found = search("current_period_end", {
    "a.ts": "const x = sub.current_period_end;",
    "b.ts": 'const x = sub["current_period_end"];',
    "c.ts": "const { current_period_end } = sub;",
    "d.ts": "const { current_period_end: end } = sub;",
    "e.py": 'x = sub.get("current_period_end")',
    "f.py": 'x = sub["current_period_end"]',
    "g.ts": "const x = sub?.current_period_end;",
    "h.ts": "const x = data.items[0].current_period_end;",
    // APIs return snake_case; plenty of codebases map it to camelCase. Missing
    // those would mean missing the well-structured repositories specifically.
    "i.ts": "const x = sub.currentPeriodEnd;",
  });

  for (const file of ["a.ts", "b.ts", "c.ts", "d.ts", "e.py", "f.py", "g.ts", "h.ts", "i.ts"]) {
    assert.ok(found.has(file), `should find the field read in ${file}`);
  }
});

test("a field reached through a variable is a known miss, not a silent one", () => {
  const found = search("current_period_end", {
    "j.ts": "const k = `current_period_end`; const x = sub[k];",
  });
  assert.equal(
    found.has("j.ts"),
    false,
    "resolving this needs dataflow analysis; the drift is still reported, just without a line",
  );
});

test("things that merely mention the name are not field reads", () => {
  const found = search("status", {
    "a.ts": "// status of the job is irrelevant here",
    "b.ts": 'console.log("status unknown");',
    "c.ts": "const statusCode = res.statusCode;",
    "d.ts": "const x = obj.statusline;",
    "e.ts": "function status() { return 1; }",
    // Shaped exactly like destructuring a response, but binding a name is not
    // reading a field.
    "f.ts": 'import { status } from "./local";',
  });

  assert.deepEqual([...found], [], "every one of these would be a false interruption");
});
