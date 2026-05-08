/**
 * Tests for services/earnings/earningsPredictor.js
 *
 * Focus: the verdict mapping table + INSUFFICIENT_DATA gate + the
 * V1 confidence cap. Every failure mode that could mislead a trader
 * should fail loudly here.
 *
 * Run with: node test/earningsPredictor.test.mjs
 */

import {
  predictEarningsOutcome,
  V1_CONFIDENCE_CAP_PCT,
} from "../services/earnings/earningsPredictor.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}

// Skeleton signals helper — pass overrides for the bits each test cares about.
function makeSignals(overrides = {}) {
  return {
    data_quality: "MEDIUM",
    sector: "Technology",
    market_cap_inr: 1e12,
    snowflake_total: 18,
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

// ──── BEAT path: TOP_PICK + lagging runup + raised earnings trajectory ────
{
  const r = predictEarningsOutcome({
    signals: makeSignals({
      data_quality: "HIGH",
      snowflake_total: 25,
      sws_upcoming_earnings: { composite_verdict: "TOP_PICK", v3_verdict: "TOP_PICK", current_price_inr: 1000 },
      momentum: { ret_1m_pct: -3, sector_avg_1m_pct: 5, pre_runup_signal: "lagging", runup_vs_sector_pct: -8 },
      trajectory: { eps_yoy_pct: 30 },
      upside_pct: 35,
    }),
  });
  assert("TOP_PICK + lagging + EPS+30% → BEAT", r.verdict === "BEAT", r);
  assert("BEAT score ≥ 65", r.score_100 >= 65, r.score_100);
  assert("confidence respects V1 cap", r.confidence_pct <= V1_CONFIDENCE_CAP_PCT, r.confidence_pct);
}

// ──── MISS path: AVOID + spike runup + EPS down + overvalued ────
{
  const r = predictEarningsOutcome({
    signals: makeSignals({
      data_quality: "HIGH",
      snowflake_total: 8,
      sws_upcoming_earnings: { composite_verdict: "AVOID", v3_verdict: "AVOID", current_price_inr: 500 },
      momentum: { ret_1m_pct: 18, sector_avg_1m_pct: 5, pre_runup_signal: "spike", runup_vs_sector_pct: 13 },
      trajectory: { eps_yoy_pct: -25 },
      upside_pct: -25,
    }),
  });
  assert("AVOID + spike + EPS-25% + overvalued → MISS", r.verdict === "MISS", r);
  assert("MISS score < 35", r.score_100 < 35, r.score_100);
}

// ──── INLINE path: balanced signals ────
{
  const r = predictEarningsOutcome({
    signals: makeSignals({
      data_quality: "MEDIUM",
      snowflake_total: 16,
      momentum: { ret_1m_pct: 3, sector_avg_1m_pct: 3, pre_runup_signal: "neutral", runup_vs_sector_pct: 0 },
      trajectory: { eps_yoy_pct: null },
    }),
  });
  assert("Balanced inputs → INLINE", r.verdict === "INLINE", r);
  assert("INLINE score in [35,64]", r.score_100 >= 35 && r.score_100 < 65, r.score_100);
}

// ──── Confidence cap is hard ────
{
  const r = predictEarningsOutcome({
    signals: makeSignals({
      data_quality: "HIGH",
      snowflake_total: 30,
      sws_upcoming_earnings: { composite_verdict: "TOP_PICK", v3_verdict: "TOP_PICK" },
      momentum: { ret_1m_pct: -5, sector_avg_1m_pct: 20, pre_runup_signal: "lagging", runup_vs_sector_pct: -25 },
      trajectory: { eps_yoy_pct: 100 },
      upside_pct: 80,
      announcements: { top3: [{ classification: "ORDER_WIN", materiality_score: 8 }, { classification: "CAPACITY_EXPANSION", materiality_score: 7 }, { classification: "MA_DEAL", materiality_score: 7 }] },
    }),
  });
  assert("Stacked-positive signals respect 65% confidence cap", r.confidence_pct <= V1_CONFIDENCE_CAP_PCT, r.confidence_pct);
  assert("Stacked-positive yields BEAT", r.verdict === "BEAT", r);
}

// ──── Component breakdown is exposed (audit-trail style) ────
{
  const r = predictEarningsOutcome({
    signals: makeSignals({
      data_quality: "HIGH",
      sws_upcoming_earnings: { composite_verdict: "STRONG", v3_verdict: "STRONG" },
    }),
  });
  assert("score_breakdown has all 8 components", r.score_breakdown && [
    "sws_quality", "runup", "sector_momentum", "trajectory",
    "fv_upside", "last_quarter_echo", "announcements", "deal_flow",
  ].every((k) => k in r.score_breakdown), Object.keys(r.score_breakdown || {}));
  assert("reasons_top is an array", Array.isArray(r.reasons_top), typeof r.reasons_top);
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

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
