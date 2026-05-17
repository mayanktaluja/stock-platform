// Unit test for the picks-vs-snapshots Fair-Value drift report formatter
// in scripts/sws-verify-db-vs-json.mjs (Layer 2 of the fix in
// ~/.claude/plans/so-i-have-attached-virtual-sphinx.md).
//
// The SQL JOIN that finds drift requires a live database, but the
// formatting + report shape doesn't. We extracted formatPicksFvDriftReport
// as a pure function for exactly this reason — assert the JSON contract
// without needing Postgres credentials in CI.

import test from "node:test";
import assert from "node:assert/strict";

import { formatPicksFvDriftReport } from "../scripts/sws-verify-db-vs-json.mjs";

test("formatPicksFvDriftReport: empty rows → drifted_count 0", () => {
  const r = formatPicksFvDriftReport({ runId: "run-x", rows: [], checkedAt: "2026-05-18T00:00:00.000Z" });
  assert.equal(r.run_id, "run-x");
  assert.equal(r.checked_at, "2026-05-18T00:00:00.000Z");
  assert.equal(r.drifted_count, 0);
  assert.deepEqual(r.drifted_top, []);
});

test("formatPicksFvDriftReport: single drift surfaces ticker + section + delta", () => {
  const rows = [
    { ticker: "STAR", section: "upcoming_earnings", pickFv: 1264, snapFv: 1078.5 },
  ];
  const r = formatPicksFvDriftReport({ runId: "run-x", rows });
  assert.equal(r.drifted_count, 1);
  assert.equal(r.drifted_top.length, 1);
  const e = r.drifted_top[0];
  assert.equal(e.ticker, "STAR");
  assert.equal(e.section, "upcoming_earnings");
  assert.equal(e.pick_fv, 1264);
  assert.equal(e.snap_fv, 1078.5);
  assert.equal(e.delta, 185.5);
});

test("formatPicksFvDriftReport: caps drifted_top at 20", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    ticker: `T${i.toString().padStart(3, "0")}`,
    section: "test_section",
    pickFv: 1000 + i,
    snapFv: 1000,
  }));
  const r = formatPicksFvDriftReport({ runId: "run-x", rows });
  assert.equal(r.drifted_count, 50, "drifted_count counts all rows");
  assert.equal(r.drifted_top.length, 20, "drifted_top capped at 20");
  // First 20 preserved in order
  assert.equal(r.drifted_top[0].ticker, "T000");
  assert.equal(r.drifted_top[19].ticker, "T019");
});

test("formatPicksFvDriftReport: defaults checked_at when omitted", () => {
  const before = Date.now();
  const r = formatPicksFvDriftReport({ runId: "x", rows: [] });
  const t = Date.parse(r.checked_at);
  assert.ok(t >= before - 1000 && t <= Date.now() + 1000, "checked_at within ±1s of now");
});

test("formatPicksFvDriftReport: rounds delta to 2 decimals", () => {
  const rows = [{ ticker: "X", section: "y", pickFv: 100.123456, snapFv: 100 }];
  const r = formatPicksFvDriftReport({ runId: "x", rows });
  assert.equal(r.drifted_top[0].delta, 0.12);
});

test("formatPicksFvDriftReport: handles negative delta (pick < snap)", () => {
  const rows = [{ ticker: "X", section: "y", pickFv: 950, snapFv: 1000 }];
  const r = formatPicksFvDriftReport({ runId: "x", rows });
  assert.equal(r.drifted_top[0].delta, -50);
});
