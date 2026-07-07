// Run: node test/multibaggerQualityFactor.test.mjs

import assert from "node:assert/strict";

import { computeQualityFactorV2 } from "../services/multibagger/qualityFactorV2.js";
import { scoreCandidate } from "../services/multibagger/multibaggerScorer.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nmultibaggerQualityFactor");

it("scores quality evidence across growth, accounting, balance sheet, and governance", () => {
  const q = computeQualityFactorV2({
    overview: { snowflake: { financial_health: 5 } },
    yearly_history: [
      { year: 2025, revenue: 100, netIncome: 10, operatingCashFlow: 8, totalDebt: 50 },
      { year: 2026, revenue: 130, netIncome: 14, operatingCashFlow: 12, totalDebt: 45 },
    ],
    news: [],
  });
  assert.equal(q.quality_gate_pass, true);
  assert.equal(q.data_confidence, 100);
  assert.ok(q.total_score >= 4);
});

it("flags audit/restatement news as governance risk", () => {
  const q = computeQualityFactorV2({
    yearly_history: [
      { year: 2025, revenue: 100, netIncome: 10, operatingCashFlow: 8, totalDebt: 50 },
      { year: 2026, revenue: 130, netIncome: 14, operatingCashFlow: 12, totalDebt: 45 },
    ],
    news: [{ title: "Auditor resignation and restatement risk" }],
  });
  assert.equal(q.quality_gate_pass, false);
  assert.ok(q.reasons.includes("audit_or_restatement_risk"));
});

it("prevents story bonus alone from lifting weak-quality rows into top tier", () => {
  const row = {
    ticker: "THEME",
    sector: "IT",
    overview: {
      market_cap_inr: 4_000 * 1e7,
      upside_pct: 30,
      snowflake: { financial_health: 4 },
      rewards: ["AI data center PLI beneficiary", "Earnings are forecast to grow 31% per year"],
      risks: [],
      returns_pct: { "1Y": 10 },
      average_daily_volume_30d: 1_000_000,
      last_close_inr: 100,
    },
    v4_breakdown: {
      pts_future: 22, // v4.1: Future pillar max is 0–22 (was 20 = old max; keep max so the quality cap still bites)
      pts_valuation: 18,
      pts_mom_1y: 7,
      pts_mom_3m: 3,
      pts_mom_1m: 2,
      fv_imputed: false,
      surveillance: { list: null },
    },
    data_completeness_pct: 90,
    yearly_history: [],
    macroRegime: { regime: "RISK_ON" },
    position_size_inr: 10_000,
  };
  const scored = scoreCandidate(row);
  assert.equal(scored.quality_factor_v2.quality_gate_pass, false);
  assert.equal(scored.diagnostics.quality_cap_applied, true);
  assert.equal(scored.verdict, "HIGH_CONVICTION");
  assert.ok(scored.score_0_100 < 70);
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
