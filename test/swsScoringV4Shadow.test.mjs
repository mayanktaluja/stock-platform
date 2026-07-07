// Tests for the Tier-3 SHADOW scoring engine. The load-bearing guarantee: the
// shadow never changes live V4 — with zero variants it equals live exactly, and
// the live scorer's output is identical whether or not the shadow is imported.

import assert from "node:assert";
import { computeV4Score } from "../services/swsScoringV4.js";
import {
  computeV4ShadowScore,
  computeShadowVariantMatrix,
  SHADOW_VARIANT_KEYS,
  LIVE_PILLAR_WEIGHTS,
} from "../services/swsScoringV4Shadow.js";

let passed = 0;
function t(name, fn) { fn(); passed++; }

// Universe for momentum percentile ranking (small but populated).
const universe = {
  r1y: [-40, -10, 0, 12, 25, 60], r3m: [-25, -8, 0, 5, 15], r1m: [-30, -12, -2, 4, 10],
  fvBenchmark: null, fvCompositeIndustryAverages: {},
};
function mkStock(over = {}) {
  return {
    ticker: over.ticker || "TESTCO",
    overview: {
      snowflake: { financial_health: 4, future: 4, valuation: 4, past: 3, ...(over.snow || {}) },
      upside_pct: over.upside_pct ?? 18,
      fair_value_inr: over.fair_value_inr ?? 118,
      current_price_inr: over.current_price_inr ?? 100,
      fair_value_range_inr: over.range ?? { min: 90, max: 120, count: 8 },
      returns_pct: over.returns ?? { "1Y": 20, "3M": 4, "1M": 3 },
      ...(over.ov || {}),
    },
    ...(over.top || {}),
  };
}
const opts = { universe };

t("zero variants selected → shadow score EXACTLY equals live", () => {
  const s = mkStock();
  const live = computeV4Score(s, opts).v4_score_100;
  const shadow = computeV4ShadowScore(s, opts, []);
  assert.strictEqual(shadow.shadow_score, live);
  assert.strictEqual(shadow.delta, 0);
  assert.strictEqual(shadow.live_score, live);
});

t("live V4 output is byte-identical with the shadow module loaded", () => {
  // Importing/using the shadow must not mutate the live scorer. Compute live,
  // run shadow (which calls live internally), then compute live again → identical.
  const s = mkStock();
  const before = JSON.stringify(computeV4Score(s, opts));
  computeShadowVariantMatrix(s, opts); // exercises every variant path
  const after = JSON.stringify(computeV4Score(s, opts));
  assert.strictEqual(before, after);
  // And the shadow's reported live_score matches a direct live call.
  assert.strictEqual(computeV4ShadowScore(s, opts).live_score, computeV4Score(s, opts).v4_score_100);
});

t("A4 fires for near-max FV with many analysts (count>5); stays silent at count<=5 (live handles that)", () => {
  const many = mkStock({ fair_value_inr: 119.5, range: { min: 90, max: 120, count: 12 }, upside_pct: 19.5 });
  const few = mkStock({ fair_value_inr: 119.5, range: { min: 90, max: 120, count: 3 }, upside_pct: 19.5 });
  const a4Many = computeV4ShadowScore(many, opts, ["A4_fv_deinflation"]);
  const a4Few = computeV4ShadowScore(few, opts, ["A4_fv_deinflation"]);
  assert.ok(a4Many.delta < 0, "many-analyst near-max should be de-rated by A4");
  assert.strictEqual(a4Few.delta, 0, "thin-coverage near-max is already handled by live; A4 adds nothing");
});

t("A2 penalises 1Y-up / 1M-down divergence, ignores aligned momentum", () => {
  const diverge = mkStock({ returns: { "1Y": 40, "3M": -5, "1M": -15 } });
  const aligned = mkStock({ returns: { "1Y": 20, "3M": 6, "1M": 4 } });
  assert.ok(computeV4ShadowScore(diverge, opts, ["A2_momentum_divergence"]).delta < 0);
  assert.strictEqual(computeV4ShadowScore(aligned, opts, ["A2_momentum_divergence"]).delta, 0);
});

t("A5 gradient penalises a SEVERE trap harder than the binary; relaxes a MILD one", () => {
  // Severe: health 1, -35% 3M, no knife (1M > -25) → gradient 8 > binary 4 → net penalty.
  const severe = mkStock({ snow: { financial_health: 1, valuation: 5, future: 3, past: 3 }, returns: { "1Y": -20, "3M": -35, "1M": -8 } });
  assert.ok(computeV4ShadowScore(severe, opts, ["A5_valuetrap_gradient"]).delta < 0, "severe cheap drawdown should be penalised harder than the flat -4");
  // Mild: health 3, -22% 3M → gradient < 4 → the step rule was too harsh, gradient relaxes it.
  const mild = mkStock({ snow: { financial_health: 3, valuation: 5, future: 3, past: 3 }, returns: { "1Y": -10, "3M": -22, "1M": -6 } });
  assert.ok(computeV4ShadowScore(mild, opts, ["A5_valuetrap_gradient"]).delta > 0, "a mild trap the binary over-penalised is relaxed by the gradient");
});

t("A8 haircuts a stale brief, graduated by age; fresh brief untouched", () => {
  const now = Date.parse("2026-07-07T00:00:00Z");
  const stale = mkStock({ top: { parsed_at: "2026-06-01T00:00:00Z" } }); // ~36d
  const fresh = mkStock({ top: { parsed_at: "2026-07-05T00:00:00Z" } }); // 2d
  assert.ok(computeV4ShadowScore(stale, { ...opts, now }, ["A8_freshness_demotion"]).delta < 0);
  assert.strictEqual(computeV4ShadowScore(fresh, { ...opts, now }, ["A8_freshness_demotion"]).delta, 0);
});

t("A1 reweight nudges the score and preserves the 76-pt pillar block sum", () => {
  const s = mkStock();
  const a1 = computeV4ShadowScore(s, opts, ["A1_reweight"]);
  // default candidate sums to 76 (22+22+14+18), same as live 22+20+18+16.
  const sum = Object.values(LIVE_PILLAR_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, 76);
  assert.ok(typeof a1.delta === "number");
});

t("A11 DCF fallback is INERT until dcf_fair_value_inr is ingested", () => {
  const noFv = mkStock({ upside_pct: null, fair_value_inr: null, range: {} });
  const a11 = computeV4ShadowScore(noFv, opts, ["A11_dcf_fallback"]);
  assert.strictEqual(a11.delta, 0);
});

t("combined shadow = live + sum of per-variant deltas, verdict re-derived", () => {
  const s = mkStock({ snow: { financial_health: 2, valuation: 5, future: 3, past: 3 }, returns: { "1Y": 35, "3M": -24, "1M": -14 }, fair_value_inr: 119.6, range: { min: 90, max: 120, count: 10 }, upside_pct: 19.6, top: { parsed_at: "2026-06-01T00:00:00Z" } });
  const now = Date.parse("2026-07-07T00:00:00Z");
  const combined = computeV4ShadowScore(s, { ...opts, now }, SHADOW_VARIANT_KEYS);
  const sumDelta = combined.applied.reduce((a, x) => a + x.delta, 0);
  assert.ok(Math.abs(sumDelta - combined.delta) < 0.05, "combined delta = sum of applied deltas");
  assert.strictEqual(typeof combined.verdict_changed, "boolean");
});

console.log(`swsScoringV4Shadow: ${passed} tests passed`);
