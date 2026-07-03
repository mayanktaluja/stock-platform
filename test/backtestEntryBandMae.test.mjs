import assert from "node:assert/strict";
import {
  avg,
  classifyFlag,
  classifyFlagCause,
  computeForwardStats,
  detectFlags,
  median,
  percentileRank,
  summarizeHorizon,
} from "../scripts/backtest-entry-band-mae.mjs";
import { KNIFE, CONFIRMED } from "../services/entry/entryTimingConfig.js";

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok ${name}`);
  } catch (err) {
    fail += 1;
    console.error(`  not ok ${name}`);
    console.error(err.stack || err.message);
  }
}

console.log("backtestEntryBandMae");

// ---------------------------------------------------------------------------
// MAE math on a synthetic price walk
// ---------------------------------------------------------------------------

check("MAE on a synthetic price walk picks the per-horizon trough", () => {
  // entry 100; dips to 96 by day 4, 90 by day 9, 85 by day 15, recovers to 102 by day 22
  const obs = [
    { day: 1, px: 99 },
    { day: 4, px: 96 },
    { day: 6, px: 94 },
    { day: 9, px: 90 },
    { day: 15, px: 85 },
    { day: 20, px: 92 },
    { day: 22, px: 102 },
  ];
  const out = computeForwardStats(100, obs);
  assert.equal(out.horizons.t5.resolved, true);
  assert.equal(out.horizons.t5.mae_pct, -4); // min(99,96) => 96
  assert.equal(out.horizons.t10.resolved, true);
  assert.equal(out.horizons.t10.mae_pct, -10); // 90 at day 9
  assert.equal(out.horizons.t21.resolved, true);
  assert.equal(out.horizons.t21.mae_pct, -15); // 85 at day 15
  assert.equal(out.trough_day, 15);
  assert.equal(out.trough_mae_pct, -15);
});

check("MAE can be positive when price never dips below entry", () => {
  const out = computeForwardStats(100, [
    { day: 2, px: 101 },
    { day: 6, px: 104 },
    { day: 22, px: 110 },
  ]);
  assert.equal(out.horizons.t5.mae_pct, 1);
  assert.equal(out.horizons.t21.mae_pct, 1); // min over whole window is day-2 101
});

check("right-censoring: horizon unresolved without a price at/after the boundary", () => {
  // observations stop at day 8 -> T+5 resolved, T+10 and T+21 right-censored
  const out = computeForwardStats(100, [
    { day: 2, px: 97 },
    { day: 8, px: 95 },
  ]);
  assert.equal(out.horizons.t5.resolved, true);
  assert.equal(out.horizons.t5.mae_pct, -3);
  assert.equal(out.horizons.t10.resolved, false);
  assert.equal(out.horizons.t10.mae_pct, null);
  assert.equal(out.horizons.t21.resolved, false);
  assert.equal(out.horizons.t21.mae_pct, null);
});

check("day<=0 and junk observations are ignored", () => {
  const out = computeForwardStats(100, [
    { day: 0, px: 50 }, // same-day duplicate commit — must not count
    { day: -3, px: 40 },
    { day: 3, px: null },
    { day: 5, px: 98 },
    { day: 21, px: 99 },
  ]);
  assert.equal(out.horizons.t5.mae_pct, -2);
  assert.equal(out.horizons.t21.mae_pct, -2);
});

check("0.75xFV touch and invalidation-touch proxies", () => {
  // FV 120 -> 0.75xFV = 90; invalidation = 0.92 x entry 100 = 92
  const touched = computeForwardStats(100, [{ day: 3, px: 89 }, { day: 21, px: 95 }], { fairValue: 120 });
  assert.equal(touched.touched_075fv, true);
  assert.equal(touched.touched_invalidation, true);
  const clean = computeForwardStats(100, [{ day: 3, px: 96 }, { day: 21, px: 99 }], { fairValue: 120 });
  assert.equal(clean.touched_075fv, false);
  assert.equal(clean.touched_invalidation, false);
  const noFv = computeForwardStats(100, [{ day: 3, px: 89 }, { day: 21, px: 95 }]);
  assert.equal(noFv.touched_075fv, null); // FV unknown -> null, not false
});

check("bad entry price yields unresolved horizons, not a throw", () => {
  const out = computeForwardStats(null, [{ day: 5, px: 98 }]);
  assert.equal(out.horizons.t5.resolved, false);
  assert.equal(out.horizons.t21.mae_pct, null);
});

// ---------------------------------------------------------------------------
// Percentile ranking
// ---------------------------------------------------------------------------

check("percentileRank is the fraction strictly below", () => {
  const sorted = [-30, -10, 0, 5, 10];
  assert.equal(percentileRank(sorted, -30), 0); // nothing strictly below
  assert.equal(percentileRank(sorted, -10), 0.2);
  assert.equal(percentileRank(sorted, 0), 0.4);
  assert.equal(percentileRank(sorted, 7), 0.8);
  assert.equal(percentileRank(sorted, 100), 1);
  assert.equal(percentileRank(sorted, -100), 0);
});

check("percentileRank guards empty/invalid input", () => {
  assert.equal(percentileRank([], 5), null);
  assert.equal(percentileRank(null, 5), null);
  assert.equal(percentileRank([1, 2, 3], null), null);
  assert.equal(percentileRank([1, 2, 3], NaN), null);
});

// ---------------------------------------------------------------------------
// Candidate-rule classifier (knife / confirmed / stabilizing fixtures)
// ---------------------------------------------------------------------------

check("knife: sharp 1M leg (boundary inclusive)", () => {
  assert.equal(classifyFlag({ r1m: KNIFE.R1M_MAX, r3m: 5, r7d: 0, pct3m: 0.9 }), "FALLING_KNIFE");
  assert.equal(classifyFlag({ r1m: -15, r3m: 5, r7d: 0, pct3m: 0.9 }), "FALLING_KNIFE");
});

check("knife: 3M and 7D legs fire independently", () => {
  assert.equal(classifyFlag({ r1m: 2, r3m: KNIFE.R3M_MAX - 1, r7d: 1, pct3m: 0.9 }), "FALLING_KNIFE");
  assert.equal(classifyFlag({ r1m: 2, r3m: 3, r7d: KNIFE.R7D_MAX, pct3m: 0.9 }), "FALLING_KNIFE");
});

check("knife: slow bleeder needs 1M<0 AND 3M<0 AND weak percentile", () => {
  assert.equal(classifyFlag({ r1m: -3, r3m: -5, r7d: 0, pct3m: 0.1 }), "FALLING_KNIFE");
  // percentile at/above the cutoff -> not a bleeder
  assert.equal(classifyFlag({ r1m: -3, r3m: -5, r7d: 0, pct3m: KNIFE.SLOW_BLEEDER_PCT3M_MAX }), "STABILIZING");
  // 3M positive -> not a bleeder
  assert.equal(classifyFlag({ r1m: -3, r3m: 2, r7d: 0, pct3m: 0.1 }), "STABILIZING");
});

check("confirmed: r1m strictly positive AND pct3m at/above median", () => {
  assert.equal(classifyFlag({ r1m: 4, r3m: 8, r7d: 1, pct3m: CONFIRMED.PCT3M_MIN }), "ENTRY_CONFIRMED");
  assert.equal(classifyFlag({ r1m: CONFIRMED.R1M_MIN, r3m: 8, r7d: 1, pct3m: 0.9 }), "STABILIZING"); // r1m must be > MIN
  assert.equal(classifyFlag({ r1m: 4, r3m: 8, r7d: 1, pct3m: 0.4 }), "STABILIZING"); // below median
});

check("knife takes precedence over confirmed legs", () => {
  // 7D crash with a still-positive 1M and strong percentile -> knife, not confirmed
  assert.equal(classifyFlag({ r1m: 3, r3m: 10, r7d: -9, pct3m: 0.8 }), "FALLING_KNIFE");
});

check("missing returns degrade to STABILIZING, never throw", () => {
  assert.equal(classifyFlag({}), "STABILIZING");
  assert.equal(classifyFlag({ r1m: null, r3m: null, r7d: null, pct3m: null }), "STABILIZING");
  assert.equal(classifyFlag({ r1m: -3, r3m: -5, r7d: null, pct3m: null }), "STABILIZING"); // bleeder needs pct3m
});

// ---------------------------------------------------------------------------
// Flag-cause stratification
// ---------------------------------------------------------------------------

check("cause: fv_reconcile_epoch when either commit date spans 2026-06-14..17", () => {
  assert.equal(
    classifyFlagCause({ prevFv: 100, curFv: 100, flagDateIso: "2026-06-15T02:00:00Z", prevDateIso: "2026-06-13T02:00:00Z" }),
    "fv_reconcile_epoch",
  );
  assert.equal(
    classifyFlagCause({ prevFv: 100, curFv: 100, flagDateIso: "2026-06-18T02:00:00Z", prevDateIso: "2026-06-17T02:00:00Z" }),
    "fv_reconcile_epoch",
  );
});

check("cause: fv_move when |dFV| > 2%, else price_move", () => {
  assert.equal(
    classifyFlagCause({ prevFv: 100, curFv: 103, flagDateIso: "2026-06-20T02:00:00Z", prevDateIso: "2026-06-19T02:00:00Z" }),
    "fv_move",
  );
  assert.equal(
    classifyFlagCause({ prevFv: 100, curFv: 101.5, flagDateIso: "2026-06-20T02:00:00Z", prevDateIso: "2026-06-19T02:00:00Z" }),
    "price_move",
  );
  // unknown prev FV (ticker absent at prev commit) -> price_move by default
  assert.equal(
    classifyFlagCause({ prevFv: null, curFv: 100, flagDateIso: "2026-06-20T02:00:00Z", prevDateIso: "2026-06-19T02:00:00Z" }),
    "price_move",
  );
});

// ---------------------------------------------------------------------------
// Flag detection + left-censor exclusion (pure, no git)
// ---------------------------------------------------------------------------

const IN = { entry_state: "BUY_ZONE", fresh_buy_eligible: true, px: 100, fv: 130 };
const STAGGER = { entry_state: "STAGGER_ONLY", fresh_buy_eligible: true, px: 112, fv: 130 };
const INELIGIBLE = { entry_state: "BUY_ZONE", fresh_buy_eligible: false, px: 100, fv: 130 };
const NO_BUY = { entry_state: "NO_BUY_ABOVE", fresh_buy_eligible: false, px: 125, fv: 130 };

check("left-censored: already flagged at the first commit is excluded from flags", () => {
  const { flags, leftCensored } = detectFlags([
    { date: "2026-05-25T03:00:00Z", bands: { AAA: IN } },
    { date: "2026-05-26T03:00:00Z", bands: { AAA: IN } },
  ]);
  assert.equal(flags.length, 0); // AAA never re-transitions
  assert.equal(leftCensored.length, 1);
  assert.equal(leftCensored[0].ticker, "AAA");
});

check("transition from absent counts as a flag with from_state=absent", () => {
  const { flags, leftCensored } = detectFlags([
    { date: "2026-05-25T03:00:00Z", bands: {} },
    { date: "2026-05-26T03:00:00Z", bands: { BBB: IN } },
  ]);
  assert.equal(leftCensored.length, 0);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].ticker, "BBB");
  assert.equal(flags[0].from_state, "absent");
  assert.equal(flags[0].commit_index, 1);
});

check("transitions from STAGGER_ONLY / NO_BUY_ABOVE / ineligible-BUY_ZONE all flag", () => {
  const { flags } = detectFlags([
    { date: "d0", bands: { S: STAGGER, N: NO_BUY, I: INELIGIBLE } },
    { date: "d1", bands: { S: IN, N: IN, I: IN } },
  ]);
  const byTicker = Object.fromEntries(flags.map((f) => [f.ticker, f.from_state]));
  assert.equal(flags.length, 3);
  assert.equal(byTicker.S, "STAGGER_ONLY");
  assert.equal(byTicker.N, "NO_BUY_ABOVE");
  assert.equal(byTicker.I, "ineligible");
});

check("staying in-flag does not re-flag; dropping out and re-entering does", () => {
  const { flags, leftCensored } = detectFlags([
    { date: "d0", bands: {} },
    { date: "d1", bands: { CCC: IN } }, // flag 1
    { date: "d2", bands: { CCC: IN } }, // still in — no new flag
    { date: "d3", bands: {} }, // dropped out
    { date: "d4", bands: { CCC: IN } }, // flag 2 (re-entry from absent)
  ]);
  assert.equal(leftCensored.length, 0);
  assert.equal(flags.length, 2);
  assert.deepEqual(flags.map((f) => f.commit_index), [1, 4]);
});

// ---------------------------------------------------------------------------
// Cohort summary plumbing
// ---------------------------------------------------------------------------

check("summarizeHorizon uses only resolved flags (right-censored excluded)", () => {
  const recs = [
    { forward: { horizons: { t5: { resolved: true, mae_pct: -4 } } } },
    { forward: { horizons: { t5: { resolved: true, mae_pct: -8 } } } },
    { forward: { horizons: { t5: { resolved: false, mae_pct: null } } } }, // censored
  ];
  const s = summarizeHorizon(recs, "t5");
  assert.equal(s.resolved_n, 2);
  assert.equal(s.avg_mae_pct, -6);
  assert.equal(s.median_mae_pct, -6);
  assert.equal(s.worst_mae_pct, -8);
});

check("avg/median helpers skip non-finite values", () => {
  assert.equal(avg([2, 4, null, NaN]), 3);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(avg([]), null);
  assert.equal(median([]), null);
});

console.log(`\nbacktestEntryBandMae result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
