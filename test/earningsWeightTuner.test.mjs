// PR 5 — services/earnings/weightTuner.js unit tests.
//
// Covers the pure sweep logic: row selection, the validation gate,
// re-scoring under multiplier configs, config evaluation, the
// known-best ranking, and the deterministic train/holdout split.

import assert from "node:assert/strict";
import {
  selectResolvedForTuning,
  checkTuningGate,
  rescoreUnderMultipliers,
  evaluateConfig,
  rankConfigs,
  splitTrainHoldout,
  buildCandidateConfigs,
  COMPONENT_KEYS,
} from "../services/earnings/weightTuner.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

const sb = (over = {}) => ({
  v3_future_past: 0, v3_valuation: 0, v3_overlay: 0, runup: 0, sector_momentum: 0,
  trajectory: 0, last_quarter_echo: 0, announcements: 0, deal_flow: 0, llm_signal: 0,
  ...over,
});

/* ───────────────── selectResolvedForTuning ──────────────────────── */

console.log("[1] selectResolvedForTuning");
it("keeps only resolved rows with a score_breakdown, deduped", () => {
  const history = [
    {
      today_iso: "2026-05-09",
      predictions: [
        { symbol: "A", event_iso_date: "2026-05-08", predicted_verdict: "BEAT", actual_verdict: "BEAT", score_breakdown: sb() },
        { symbol: "B", event_iso_date: "2026-05-08", predicted_verdict: "BEAT", actual_verdict: null, score_breakdown: sb() }, // unresolved
        { symbol: "C", event_iso_date: "2026-05-08", predicted_verdict: "MISS", actual_verdict: "MISS" }, // no score_breakdown
      ],
    },
    {
      today_iso: "2026-05-13",
      predictions: [
        // duplicate of A — latest snapshot wins
        { symbol: "A", event_iso_date: "2026-05-08", predicted_verdict: "INLINE", actual_verdict: "BEAT", score_breakdown: sb({ runup: 5 }) },
      ],
    },
  ];
  const rows = selectResolvedForTuning(history);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "A");
  assert.equal(rows[0].predicted_verdict, "INLINE"); // from the 05-13 snapshot
});

/* ───────────────────── checkTuningGate ──────────────────────────── */

console.log("[2] checkTuningGate");
it("47 resolved / 1 quarter → gate NOT met", () => {
  const rows = Array.from({ length: 47 }, (_, i) => ({
    symbol: `S${i}`, event_iso_date: "2026-05-08", fiscal_quarter: "Q4 FY26", sector: "IT",
    actual_verdict: "BEAT", score_breakdown: sb(),
  }));
  const g = checkTuningGate(rows);
  assert.equal(g.met, false);
  assert.equal(g.resolved_count, 47);
  assert.equal(g.distinct_quarters, 1);
});
it(">=80 resolved, 2 quarters, 5 sectors x 10 → gate MET", () => {
  const sectors = ["IT", "Banks", "Pharma", "Auto", "FMCG"];
  const rows = [];
  for (const sec of sectors) {
    for (let i = 0; i < 20; i++) {
      rows.push({
        symbol: `${sec}${i}`, event_iso_date: "2026-05-08",
        fiscal_quarter: i % 2 ? "Q4 FY26" : "Q1 FY27", sector: sec,
        actual_verdict: "INLINE", score_breakdown: sb(),
      });
    }
  }
  const g = checkTuningGate(rows);
  assert.equal(g.met, true);
  assert.equal(g.distinct_quarters, 2);
  assert.equal(g.sectors_with_min_events, 5);
});

/* ─────────────────── rescoreUnderMultipliers ────────────────────── */

console.log("[3] rescoreUnderMultipliers");
it("baseline (no multipliers) sums components + 50 anchor", () => {
  const r = rescoreUnderMultipliers(sb({ trajectory: 10, runup: 5 }), {});
  assert.equal(r.score_100, 65); // 50 + 10 + 5
  assert.equal(r.verdict, "BEAT");
});
it("a multiplier rescales the named component only", () => {
  const r = rescoreUnderMultipliers(sb({ trajectory: 10, runup: 5 }), { runup: 0 });
  assert.equal(r.score_100, 60); // 50 + 10 + (5*0)
  assert.equal(r.verdict, "INLINE");
});
it("verdict thresholds: >=65 BEAT, <35 MISS, else INLINE", () => {
  assert.equal(rescoreUnderMultipliers(sb({ v3_future_past: -20 }), {}).verdict, "MISS"); // 30
  assert.equal(rescoreUnderMultipliers(sb({ v3_future_past: 0 }), {}).verdict, "INLINE"); // 50
});
it("confidence_pct respects the 65 cap", () => {
  const r = rescoreUnderMultipliers(sb({ v3_future_past: 18, trajectory: 15, runup: 8, announcements: 10 }), {});
  assert.ok(r.confidence_pct <= 65, r.confidence_pct);
});

/* ───────────────────── evaluateConfig ───────────────────────────── */

console.log("[4] evaluateConfig");
it("computes overall hit-rate + per-sector breakdown", () => {
  const rows = [
    { sector: "IT", actual_verdict: "BEAT", score_breakdown: sb({ trajectory: 20 }) },   // → BEAT ✓
    { sector: "IT", actual_verdict: "MISS", score_breakdown: sb({ trajectory: -20 }) },  // → MISS ✓
    { sector: "Banks", actual_verdict: "BEAT", score_breakdown: sb({ trajectory: -20 }) }, // → MISS ✗
  ];
  const res = evaluateConfig(rows, {});
  assert.equal(res.n, 3);
  assert.equal(res.hit_rate_pct, 66.7);
  assert.equal(res.by_sector.IT.hit_rate_pct, 100);
  assert.equal(res.by_sector.Banks.hit_rate_pct, 0);
});

/* ─────────────────────── rankConfigs ────────────────────────────── */

console.log("[5] rankConfigs — ranks the known-best config first");
it("a config that down-weights the noise component beats baseline", () => {
  // trajectory is truth-telling; runup is noise that drags the baseline
  // verdict off the BEAT/MISS line. With trajectory ±25 and runup ∓15,
  // baseline lands on INLINE (raw ±10 → score 60/40) and scores 0%;
  // a config that suppresses runup pushes it over the line and wins.
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({ sector: "IT", actual_verdict: "BEAT", score_breakdown: sb({ trajectory: 25, runup: -15 }) });
    rows.push({ sector: "IT", actual_verdict: "MISS", score_breakdown: sb({ trajectory: -25, runup: 15 }) });
  }
  const ranked = rankConfigs(rows, buildCandidateConfigs());
  const baseline = ranked.find((c) => c.name === "baseline");
  const best = ranked[0];
  assert.notEqual(best.name, "baseline", `best was baseline (${best.result.hit_rate_pct}%)`);
  assert.ok(best.result.hit_rate_pct > baseline.result.hit_rate_pct, `${best.result.hit_rate_pct} vs ${baseline.result.hit_rate_pct}`);
  // The winning config must be one that suppresses runup.
  assert.ok((best.multipliers.runup ?? 1) < 1, JSON.stringify(best.multipliers));
});

/* ─────────────────── splitTrainHoldout ──────────────────────────── */

console.log("[6] splitTrainHoldout — deterministic ~80/20");
it("splits ~80/20 and is stable across calls", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ symbol: `S${i}`, event_iso_date: "2026-05-08" }));
  const a = splitTrainHoldout(rows, 0.2);
  const b = splitTrainHoldout(rows, 0.2);
  assert.equal(a.train.length, 80);
  assert.equal(a.holdout.length, 20);
  assert.deepEqual(a.train.map((r) => r.symbol), b.train.map((r) => r.symbol)); // deterministic
  // train and holdout are disjoint
  const holdoutSet = new Set(a.holdout.map((r) => r.symbol));
  assert.ok(a.train.every((r) => !holdoutSet.has(r.symbol)));
});

/* ─────────────────── buildCandidateConfigs ──────────────────────── */

console.log("[7] buildCandidateConfigs");
it("includes baseline + named hypotheses + a full coordinate sweep", () => {
  const configs = buildCandidateConfigs();
  const names = new Set(configs.map((c) => c.name));
  assert.ok(names.has("baseline"));
  assert.ok(names.has("plan_v3_shift"));
  // coordinate sweep — every component has at least one x-variant.
  for (const k of COMPONENT_KEYS) {
    assert.ok([...names].some((n) => n.startsWith(`${k}_x`)), `no sweep config for ${k}`);
  }
});

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
if (fail) process.exit(1);
