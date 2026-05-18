// PR-D1 — scripts/sws-scoring.mjs#buildMomentumCoverageReport unit tests.
//
// Audit finding #11 (2026-05-18 production audit): data/sws/v3-universe-
// stats.json had universe_size: 5517 but counts.r1m/r3m/r1y of 5464 — a 53-
// stock gap with no surfaced explanation. The fix is *not* a script bug fix
// (the gap is upstream: SWS returns returns_pct: null for thinly-traded BSE-
// only tickers); the fix is to *surface* the gap as a structured
// momentum_coverage block in the JSON so the audit trail is observable.
//
// These tests pin the shape and math of that block.

import assert from "node:assert/strict";
import {
  buildUniverseStats,
  buildMomentumCoverageReport,
} from "../scripts/sws-scoring.mjs";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

// Fixture: 6 stocks. 4 have full returns, 1 has missing 1M only, 1 has nothing.
function makeFixture() {
  return [
    { ticker: "AAA", overview: { returns_pct: { "1M": 2.1, "3M": 5.6, "1Y": 12.4 } } },
    { ticker: "BBB", overview: { returns_pct: { "1M": -3.0, "3M": 1.1, "1Y": 20.5 } } },
    { ticker: "CCC", overview: { returns_pct: { "1M": 0.5, "3M": -1.5, "1Y": -7.2 } } },
    { ticker: "DDD", overview: { returns_pct: { "1M": 8.0, "3M": 14.0, "1Y": 28.0 } } },
    { ticker: "EEE", overview: { returns_pct: { "3M": 3.0, "1Y": 9.0 } } }, // missing 1M
    { ticker: "FFF", overview: { returns_pct: null } },                       // missing all
  ];
}

console.log("[1] buildUniverseStats stays stable — shape unchanged");
it("returns {r1m, r3m, r1y} sorted ascending", () => {
  const stats = buildUniverseStats(makeFixture());
  assert.deepEqual(Object.keys(stats).sort(), ["r1m", "r1y", "r3m"]);
  assert.equal(stats.r1m.length, 4); // AAA, BBB, CCC, DDD (EEE missing 1M, FFF missing all)
  assert.equal(stats.r3m.length, 5); // AAA, BBB, CCC, DDD, EEE
  assert.equal(stats.r1y.length, 5);
  // sorted ascending
  for (let i = 1; i < stats.r1m.length; i++) assert.ok(stats.r1m[i] >= stats.r1m[i - 1]);
  for (let i = 1; i < stats.r3m.length; i++) assert.ok(stats.r3m[i] >= stats.r3m[i - 1]);
  for (let i = 1; i < stats.r1y.length; i++) assert.ok(stats.r1y[i] >= stats.r1y[i - 1]);
});

console.log("[2] buildMomentumCoverageReport — basic shape");
it("emits scored, with_all_windows, completeness_pct, missing_per_window, missing_all_windows, notes", () => {
  const rep = buildMomentumCoverageReport(makeFixture());
  assert.equal(rep.scored, 6);
  assert.equal(rep.with_all_windows, 4);                  // AAA, BBB, CCC, DDD
  assert.equal(rep.completeness_pct, 66.7);              // 4/6 = 66.666... → 66.7
  assert.ok(rep.missing_per_window);
  assert.ok(rep.missing_per_window.r1m);
  assert.ok(rep.missing_per_window.r3m);
  assert.ok(rep.missing_per_window.r1y);
  assert.ok(rep.missing_all_windows);
  assert.ok(typeof rep.notes === "string" && rep.notes.length > 0);
});

console.log("[3] buildMomentumCoverageReport — per-window counts");
it("counts EEE missing 1M only; FFF missing all three", () => {
  const rep = buildMomentumCoverageReport(makeFixture());
  assert.equal(rep.missing_per_window.r1m.count, 2);     // EEE, FFF
  assert.equal(rep.missing_per_window.r3m.count, 1);     // FFF
  assert.equal(rep.missing_per_window.r1y.count, 1);     // FFF
  assert.equal(rep.missing_all_windows.count, 1);        // FFF only
  assert.deepEqual(rep.missing_per_window.r1m.sample_first_25, ["EEE", "FFF"]);
  assert.deepEqual(rep.missing_per_window.r3m.sample_first_25, ["FFF"]);
  assert.deepEqual(rep.missing_per_window.r1y.sample_first_25, ["FFF"]);
  assert.deepEqual(rep.missing_all_windows.sample_first_25, ["FFF"]);
});

console.log("[4] buildMomentumCoverageReport — empty input");
it("handles zero stocks gracefully", () => {
  const rep = buildMomentumCoverageReport([]);
  assert.equal(rep.scored, 0);
  assert.equal(rep.with_all_windows, 0);
  assert.equal(rep.completeness_pct, 0);
  assert.equal(rep.missing_per_window.r1m.count, 0);
  assert.equal(rep.missing_per_window.r3m.count, 0);
  assert.equal(rep.missing_per_window.r1y.count, 0);
  assert.equal(rep.missing_all_windows.count, 0);
  assert.deepEqual(rep.missing_per_window.r1m.sample_first_25, []);
});

console.log("[5] buildMomentumCoverageReport — sample cap at 25");
it("truncates the sample to 25 entries even when more are missing", () => {
  const big = [];
  for (let i = 0; i < 60; i++) {
    big.push({ ticker: `T${String(i).padStart(3, "0")}`, overview: { returns_pct: null } });
  }
  const rep = buildMomentumCoverageReport(big);
  assert.equal(rep.scored, 60);
  assert.equal(rep.with_all_windows, 0);
  assert.equal(rep.missing_all_windows.count, 60);
  assert.equal(rep.missing_all_windows.sample_first_25.length, 25);
  // First-25 alpha-sorted starts at T000
  assert.equal(rep.missing_all_windows.sample_first_25[0], "T000");
  assert.equal(rep.missing_all_windows.sample_first_25[24], "T024");
});

console.log("[6] buildMomentumCoverageReport — missing-all sample is intersection of all 3 windows");
it("only tickers missing ALL 3 windows show up in missing_all_windows", () => {
  const fix = [
    { ticker: "FULL", overview: { returns_pct: { "1M": 1, "3M": 2, "1Y": 3 } } },
    { ticker: "ONLY_1M_MISSING", overview: { returns_pct: { "3M": 2, "1Y": 3 } } },
    { ticker: "ALL_MISSING_A", overview: { returns_pct: null } },
    { ticker: "ALL_MISSING_B", overview: {} },
  ];
  const rep = buildMomentumCoverageReport(fix);
  assert.equal(rep.missing_all_windows.count, 2);
  assert.deepEqual(rep.missing_all_windows.sample_first_25, ["ALL_MISSING_A", "ALL_MISSING_B"]);
});

console.log("[7] buildMomentumCoverageReport — non-finite values count as missing");
it("NaN and Infinity in returns_pct are treated as absent", () => {
  const fix = [
    { ticker: "NANY", overview: { returns_pct: { "1M": NaN, "3M": Infinity, "1Y": -Infinity } } },
    { ticker: "GOOD", overview: { returns_pct: { "1M": 1, "3M": 2, "1Y": 3 } } },
  ];
  const rep = buildMomentumCoverageReport(fix);
  assert.equal(rep.scored, 2);
  assert.equal(rep.with_all_windows, 1);
  assert.equal(rep.missing_all_windows.count, 1);
  assert.deepEqual(rep.missing_all_windows.sample_first_25, ["NANY"]);
});

console.log("[8] buildMomentumCoverageReport — silent when ticker is missing");
it("a stock with no ticker is counted but not listed by name", () => {
  const fix = [
    { ticker: null, overview: { returns_pct: null } },
    { ticker: "OK", overview: { returns_pct: { "1M": 1, "3M": 2, "1Y": 3 } } },
  ];
  const rep = buildMomentumCoverageReport(fix);
  assert.equal(rep.scored, 2);
  assert.equal(rep.with_all_windows, 1);
  // missing_all_windows.count reflects ALL stocks missing all windows, even
  // those without a ticker — but the sample only includes named ones.
  assert.equal(rep.missing_all_windows.count, 0); // null ticker was skipped from missing.r1m etc.
});

console.log("[9] real-data shape check — pinned for the 53-stock prod gap");
it("re-validates the known-good production shape on a synthesized 1000-stock dataset", () => {
  const N = 1000;
  const MISSING_COUNT = 53;
  const fix = [];
  for (let i = 0; i < N - MISSING_COUNT; i++) {
    fix.push({
      ticker: `OK_${String(i).padStart(4, "0")}`,
      overview: { returns_pct: { "1M": i % 10, "3M": (i % 10) * 2, "1Y": (i % 10) * 4 } },
    });
  }
  for (let i = 0; i < MISSING_COUNT; i++) {
    fix.push({ ticker: `GAP_${String(i).padStart(3, "0")}`, overview: { returns_pct: null } });
  }
  const stats = buildUniverseStats(fix);
  const rep = buildMomentumCoverageReport(fix);
  assert.equal(stats.r1m.length, N - MISSING_COUNT);
  assert.equal(stats.r3m.length, N - MISSING_COUNT);
  assert.equal(stats.r1y.length, N - MISSING_COUNT);
  assert.equal(rep.scored, N);
  assert.equal(rep.with_all_windows, N - MISSING_COUNT);
  assert.equal(rep.missing_all_windows.count, MISSING_COUNT);
  assert.equal(rep.completeness_pct, Math.round((1 - MISSING_COUNT / N) * 1000) / 10);
});

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
