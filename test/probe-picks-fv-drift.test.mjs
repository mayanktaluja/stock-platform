// Unit test for the trimAndAppend rotation in scripts/probe-picks-fv-drift.mjs
// (Layer 3 of the fix in ~/.claude/plans/so-i-have-attached-virtual-sphinx.md).
//
// trimAndAppend is the only stateful primitive in the probe — the rest is
// fetch + file I/O. Asserting it here keeps the 24h rolling window correct
// without a real launchd schedule.

import test from "node:test";
import assert from "node:assert/strict";

import { trimAndAppend } from "../scripts/probe-picks-fv-drift.mjs";

test("trimAndAppend: empty file → appends one entry, single trailing newline", () => {
  const now = new Date("2026-05-18T01:00:00.000Z");
  const out = trimAndAppend({
    now,
    countObj: { ts: now.toISOString(), fv_drift_count: 0, source: "probe" },
    existingLines: [],
  });
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.fv_drift_count, 0);
  assert.ok(out.endsWith("\n"), "must end with newline so next append is clean");
});

test("trimAndAppend: drops entries older than 24h", () => {
  const now = new Date("2026-05-18T01:00:00.000Z");
  const tsFresh = new Date(now.getTime() - 60 * 60 * 1000).toISOString();   // 1h ago — kept
  const tsEdge  = new Date(now.getTime() - 23.5 * 60 * 60 * 1000).toISOString(); // 23.5h ago — kept
  const tsStale = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago — dropped
  const existing = [
    JSON.stringify({ ts: tsFresh, fv_drift_count: 1 }),
    JSON.stringify({ ts: tsEdge,  fv_drift_count: 2 }),
    JSON.stringify({ ts: tsStale, fv_drift_count: 99 }),
  ];
  const out = trimAndAppend({
    now,
    countObj: { ts: now.toISOString(), fv_drift_count: 0, source: "probe" },
    existingLines: existing,
  });
  const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 3, "kept fresh + edge + new; dropped stale");
  assert.ok(!lines.some((l) => l.fv_drift_count === 99), "25h-old entry must be dropped");
  assert.equal(lines[lines.length - 1].fv_drift_count, 0, "new entry appended last");
});

test("trimAndAppend: tolerates malformed JSON lines (drops them)", () => {
  const now = new Date("2026-05-18T01:00:00.000Z");
  const tsFresh = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const existing = [
    "garbage that is not JSON",
    JSON.stringify({ ts: tsFresh, fv_drift_count: 1 }),
    "",
    "   ",
    "{partial",
  ];
  const out = trimAndAppend({
    now,
    countObj: { ts: now.toISOString(), fv_drift_count: 0 },
    existingLines: existing,
  });
  const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, "kept 1 valid + 1 new; dropped 3 malformed + 2 empty");
});

test("trimAndAppend: rejects entries with non-numeric ts (Date.parse → NaN)", () => {
  const now = new Date("2026-05-18T01:00:00.000Z");
  const existing = [
    JSON.stringify({ ts: "not-a-date", fv_drift_count: 5 }),
    JSON.stringify({ ts: null, fv_drift_count: 9 }),
  ];
  const out = trimAndAppend({
    now,
    countObj: { ts: now.toISOString(), fv_drift_count: 0 },
    existingLines: existing,
  });
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "only the new entry survives");
});

test("trimAndAppend: existing lines come back in order, append at end", () => {
  const now = new Date("2026-05-18T01:00:00.000Z");
  const tsA = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const tsB = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  const existing = [
    JSON.stringify({ ts: tsA, fv_drift_count: 1 }),
    JSON.stringify({ ts: tsB, fv_drift_count: 2 }),
  ];
  const out = trimAndAppend({
    now,
    countObj: { ts: now.toISOString(), fv_drift_count: 3 },
    existingLines: existing,
  });
  const counts = out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).fv_drift_count);
  assert.deepEqual(counts, [1, 2, 3], "FIFO order preserved");
});
