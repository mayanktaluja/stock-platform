/**
 * Tests for services/earnings/earningsPredictor.js
 *
 * Focus: the verdict mapping table + INSUFFICIENT_DATA gate + the
 * V1 confidence cap + the v2 V3-pillar components. Every failure mode
 * that could mislead a trader should fail loudly here.
 *
 * Run with: node test/earningsPredictor.test.mjs
 */

import {
  predictEarningsOutcome,
  V1_CONFIDENCE_CAP_PCT,
  PREDICTOR_VERSION,
} from "../services/earnings/earningsPredictor.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}

// V3 breakdown skeleton — neutral midpoints (a 3/6 snowflake pillar)
// so the V3 components contribute ~0 unless a test overrides them.
function makeV3(overrides = {}) {
  return {
    v3_score_100: 50,
    v3_verdict: "ACCEPTABLE",
    source: "computed",
    breakdown: {
      pts_health: 11,
      pts_future: 10, // neutral = (3/6)*20
      pts_valuation: 6,
      pts_past: 6, // neutral = (3/6)*12
      pts_dividends: 4,
      pts_fv_upside: 6, // neutral = fair value
      fv_imputed: false,
      pts_mom_1y: 4,
      pts_mom_3m: 2,
      pts_mom_1m: 1,
      momentum_imputed: false,
      pts_overlay: 0,
      overlay_reasons: [],
      surveillance: null,
      ...overrides,
    },
  };
}

// Skeleton signals helper — pass overrides for the bits each test cares about.
function makeSignals(overrides = {}) {
  return {
    data_quality: "MEDIUM",
    sector: "Technology",
    market_cap_inr: 1e12,
    snowflake_total: 18,
    v3: makeV3(),
    momentum: {
      ret_1m_pct: 2,
      ret_3m_pct: 4,
      sector_avg_1m_pct: 3,
      pre_runup_signal: "neutral",
      runup_vs_sector_pct: -1,
    },
    trajectory: { eps_yoy_pct: null },
    upside_pct: 0,
    sws_upcoming_earnings: null,
    announcements: { top3: [] },
    deals_7d: null,
    ...overrides,
  };
}

// ──── INSUFFICIENT_DATA gate (HARD RULE) ────
{
  const event = { signals: { ...makeSignals(), data_quality: "LOW" } };
  const r = predictEarningsOutcome(event);
  assert("LOW data_quality → INSUFFICIENT_DATA", r.verdict === "INSUFFICIENT_DATA", r.verdict);
  assert("INSUFFICIENT_DATA carries no confidence", r.confidence_pct === null, r.confidence_pct);
  assert("INSUFFICIENT_DATA carries no score", r.score_100 === null, r.score_100);
}
{
  const r = predictEarningsOutcome({ signals: null });
  assert("null signals → INSUFFICIENT_DATA", r.verdict === "INSUFFICIENT_DATA", r.verdict);
}
{
  const r = predictEarningsOutcome(null);
  assert("null event → INSUFFICIENT_DATA", r.verdict === "INSUFFICIENT_DATA", r.verdict);
}

// ──── BEAT path: strong V3 future/past + lagging runup + raised EPS ────
{
  const r = predictEarningsOutcome({
    signals: makeSignals({
      data_quality: "HIGH",
      v3: makeV3({
        pts_future: 20, pts_past: 12, pts_fv_upside: 12, pts_overlay: 0,
      }),
      momentum: { ret_1m_pct: -3, sector_avg_1m_pct: 5, pre_runup_signal: "lagging", runup_vs_sector_pct: -8 },
      trajectory: { eps_yoy_pct: 30 },
    }),
  });
  // Override v3_verdict on the resolved block.
  assert("strong V3 + lagging + EPS+30% → BEAT", r.verdict === "BEAT", r);
  assert("BEAT score ≥ 65", r.score_100 >= 65, r.score_100);
  assert("confidence respects V1 cap", r.confidence_pct <= V1_CONFIDENCE_CAP_PCT, r.confidence_pct);
}

// ──── MISS path: weak V3 + risk overlay + spike runup + EPS down ────
{
  const sig = makeSignals({
    data_quality: "HIGH",
    v3: makeV3({
      pts_future: 0, pts_past: 0, pts_fv_upside: 0, pts_overlay: -10,
      overlay_reasons: ["GSM surveillance"],
    }),
    momentum: { ret_1m_pct: 18, sector_avg_1m_pct: 5, pre_runup_signal: "spike", runup_vs_sector_pct: 13 },
    trajectory: { eps_yoy_pct: -25 },
  });
  sig.v3.v3_verdict = "AVOID";
  const r = predictEarningsOutcome({ signals: sig });
  assert("weak V3 + overlay + spike + EPS-25% → MISS", r.verdict === "MISS", r);
  assert("MISS score < 35", r.score_100 < 35, r.score_100);
  assert("V3 overlay component is negative", r.score_breakdown.v3_overlay < 0, r.score_breakdown);
}

// ──── INLINE path: balanced signals ────
{
  const r = predictEarningsOutcome({
    signals: makeSignals({
      data_quality: "MEDIUM",
      momentum: { ret_1m_pct: 3, sector_avg_1m_pct: 3, pre_runup_signal: "neutral", runup_vs_sector_pct: 0 },
      trajectory: { eps_yoy_pct: null },
    }),
  });
  assert("Balanced inputs → INLINE", r.verdict === "INLINE", r);
  assert("INLINE score in [35,64]", r.score_100 >= 35 && r.score_100 < 65, r.score_100);
}

// ──── V3 future/past anchored symmetric — weak future scores NEGATIVE ────
{
  const weak = predictEarningsOutcome({
    signals: makeSignals({ data_quality: "HIGH", v3: makeV3({ pts_future: 0, pts_past: 0 }) }),
  });
  const strong = predictEarningsOutcome({
    signals: makeSignals({ data_quality: "HIGH", v3: makeV3({ pts_future: 20, pts_past: 12 }) }),
  });
  assert("weak V3 future/past → negative component", weak.score_breakdown.v3_future_past < 0, weak.score_breakdown);
  assert("strong V3 future/past → positive component", strong.score_breakdown.v3_future_past > 0, strong.score_breakdown);
}

// ──── No V3 block → V3 components degrade to 0, valuation falls back ────
{
  const sig = makeSignals({ data_quality: "MEDIUM", upside_pct: 40 });
  sig.v3 = null;
  const r = predictEarningsOutcome({ signals: sig });
  assert("no V3 block → v3_future_past 0", r.score_breakdown.v3_future_past === 0, r.score_breakdown);
  assert("no V3 block → v3_overlay 0", r.score_breakdown.v3_overlay === 0, r.score_breakdown);
  assert("no V3 block → valuation falls back to raw upside_pct (positive)", r.score_breakdown.v3_valuation > 0, r.score_breakdown);
}

// ──── Confidence cap is hard ────
{
  const sig = makeSignals({
    data_quality: "HIGH",
    v3: makeV3({ pts_future: 20, pts_past: 12, pts_fv_upside: 12, pts_overlay: 0 }),
    momentum: { ret_1m_pct: -5, sector_avg_1m_pct: 20, pre_runup_signal: "lagging", runup_vs_sector_pct: -25 },
    trajectory: { eps_yoy_pct: 100 },
    announcements: { top3: [{ classification: "ORDER_WIN", materiality_score: 8 }, { classification: "CAPACITY_EXPANSION", materiality_score: 7 }, { classification: "MA_DEAL", materiality_score: 7 }] },
  });
  sig.v3.v3_verdict = "TOP_PICK";
  const r = predictEarningsOutcome({ signals: sig });
  assert("Stacked-positive signals respect 65% confidence cap", r.confidence_pct <= V1_CONFIDENCE_CAP_PCT, r.confidence_pct);
  assert("Stacked-positive yields BEAT", r.verdict === "BEAT", r);
}

// ──── Component breakdown is exposed (audit-trail style) ────
{
  const r = predictEarningsOutcome({
    signals: makeSignals({ data_quality: "HIGH" }),
  });
  assert("score_breakdown has all v2 components", r.score_breakdown && [
    "v3_future_past", "v3_valuation", "v3_overlay", "runup", "sector_momentum",
    "trajectory", "last_quarter_echo", "announcements", "deal_flow", "llm_signal",
  ].every((k) => k in r.score_breakdown), Object.keys(r.score_breakdown || {}));
  assert("score_breakdown keeps v1 aliases for one release", r.score_breakdown &&
    "sws_quality" in r.score_breakdown && "fv_upside" in r.score_breakdown, Object.keys(r.score_breakdown || {}));
  assert("reasons_top is an array", Array.isArray(r.reasons_top), typeof r.reasons_top);
  assert("predictor_version is v2", PREDICTOR_VERSION.includes("v2"), PREDICTOR_VERSION);
}

// ──── Announcements signal: positive vs negative ────
{
  const positive = predictEarningsOutcome({
    signals: makeSignals({
      data_quality: "HIGH",
      announcements: { top3: [{ classification: "ORDER_WIN", materiality_score: 8 }] },
    }),
  });
  const negative = predictEarningsOutcome({
    signals: makeSignals({
      data_quality: "HIGH",
      announcements: { top3: [{ classification: "LITIGATION", materiality_score: 7 }] },
    }),
  });
  assert("ORDER_WIN announcement contributes positively", positive.score_breakdown.announcements > 0, positive.score_breakdown);
  assert("LITIGATION announcement contributes negatively", negative.score_breakdown.announcements < 0, negative.score_breakdown);
}

// ──── Deal-flow signal scaling ────
{
  const heavySell = predictEarningsOutcome({
    signals: makeSignals({
      data_quality: "HIGH",
      market_cap_inr: 1e10, // ₹1000 Cr mcap
      deals_7d: { net_notional_inr: -2e8 }, // ₹20 Cr net sell = 2% of mcap
    }),
  });
  assert("Heavy net-sell drives deal_flow component negative", heavySell.score_breakdown.deal_flow < 0, heavySell.score_breakdown);
  // Tiny deal in a huge stock shouldn't move the needle.
  const tinyDeal = predictEarningsOutcome({
    signals: makeSignals({
      data_quality: "HIGH",
      market_cap_inr: 1e13,
      deals_7d: { net_notional_inr: 1e6 }, // ₹10 lakhs in a ₹1L Cr stock — noise
    }),
  });
  assert("Sub-threshold deals score 0", tinyDeal.score_breakdown.deal_flow === 0, tinyDeal.score_breakdown);
}

// ──── LLM qualitative signal (component 9) ────
{
  const base = makeSignals({ data_quality: "HIGH" });
  const noLlm = predictEarningsOutcome({ signals: base });
  const leanBeat = predictEarningsOutcome({
    signals: { ...base, llm_signal: { bias: "lean_beat", confidence_delta_pct: 5, classifier_provider: "groq", top_reason: "order win" } },
  });
  const leanMiss = predictEarningsOutcome({
    signals: { ...base, llm_signal: { bias: "lean_miss", confidence_delta_pct: -5, classifier_provider: "groq", top_reason: "margin pressure" } },
  });
  assert("no LLM signal → llm_signal component is 0", noLlm.score_breakdown.llm_signal === 0, noLlm.score_breakdown);
  assert("lean_beat LLM signal lifts the score", leanBeat.score_100 > noLlm.score_100, { beat: leanBeat.score_100, none: noLlm.score_100 });
  assert("lean_miss LLM signal lowers the score", leanMiss.score_100 < noLlm.score_100, { miss: leanMiss.score_100, none: noLlm.score_100 });
  assert("LLM component is capped at ±10", Math.abs(leanBeat.score_breakdown.llm_signal) <= 10, leanBeat.score_breakdown.llm_signal);
  // neutral bias contributes nothing.
  const neutral = predictEarningsOutcome({
    signals: { ...base, llm_signal: { bias: "neutral", confidence_delta_pct: 0, classifier_provider: "heuristic" } },
  });
  assert("neutral LLM bias → 0 pts", neutral.score_breakdown.llm_signal === 0, neutral.score_breakdown);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
