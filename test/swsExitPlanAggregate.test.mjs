import assert from "node:assert/strict";
import { buildExitPlan } from "../services/exitPlan/exitPlanPolicy.js";
import { buildSWSReport, rebuildTierAggregates } from "../services/swsPortfolioAggregate.js";

console.log("sws exit-plan aggregate regression");

function makeHolding(overrides = {}) {
  return {
    symbol: "GINASECO",
    name: "Gina Seco Life Scale",
    sector: "Capital Goods",
    quantity: 100,
    avgPrice: 100,
    currentPrice: 82,
    invested: 10_000,
    currentValue: 8_200,
    pnlAmount: -1_800,
    pnlPercent: -18,
    positionWeight: 18,
    swsCovered: true,
    action: "Reduction-50%",
    reasons: ["Synthetic SWS reduction reason."],
    sws: {
      ticker: "GINASECO",
      name: "Gina Seco Life Scale",
      sector: "Capital Goods",
      score: 35,
      v4_score: 35,
      verdict: "WATCH",
      snowflake_total: 9,
      snowflake: { total: 9, valuation: 1, future_growth: 2, past_performance: 2, financial_health: 2, dividends: 2 },
      current_price_inr: 82,
      fair_value_inr: 100,
      upside_pct: 22,
      valuation_confidence: "medium",
      market_cap_inr: 30_000_000_000,
      multiples: { pe: 20, ps: 2, pb: 3, ev_ebitda: 12 },
      net_margin_pct: 5,
      revenue_growth_pct: 4,
      earnings_growth_pct: -3,
    },
    exitPlan: buildExitPlan({
      action: "Reduction-50%",
      currentPrice: 82,
      avgPrice: 100,
      supportLevel: 90,
      fairValueInr: 100,
      pnlPercent: -18,
      positionWeight: 18,
      marketCapInr: 30_000_000_000,
      reasons: ["Synthetic SWS reduction reason."],
    }),
    ...overrides,
  };
}

{
  const report = buildSWSReport([makeHolding()], { freshCapitalInr: 0 });
  assert.equal(report.exitPlanSummary.schema_version, "exit-plan-summary-v1");
  assert.equal(report.exitPlanSummary.totalWithPlan, 1);
  assert.equal(report.exitPlanSummary.activeReviewCount, 1);
  assert.equal(report.exitPlanSummary.highVolatilityCount, 1);
  assert.equal(report.exitPlanSummary.rows[0].symbol, "GINASECO");
  assert.equal(report.holdingsByAction["Reduction-50%"][0].exitPlan.schema_version, "exit-plan-v1");
}

{
  const report = { snapshot: {}, tiers: {} };
  const rebuilt = rebuildTierAggregates(report, [makeHolding({ symbol: "REBUILT" })]);
  assert.equal(rebuilt.exitPlanSummary.totalWithPlan, 1);
  assert.equal(rebuilt.snapshot.actionMix["Reduction-50%"], 1);
}

console.log("  ok");
