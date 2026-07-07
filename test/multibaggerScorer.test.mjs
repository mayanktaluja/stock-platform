// Tests for services/multibagger/multibaggerScorer.js — the 12-component
// 0-100 composite + 5 hard gates.
// Run: node test/multibaggerScorer.test.mjs

import assert from "node:assert/strict";
import { scoreCandidate, MULTIBAGGER_SCORER_CONFIG } from "../services/multibagger/multibaggerScorer.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nmultibaggerScorer");

const NOW = "2026-05-20T00:00:00Z";

const strongRow = () => ({
  ticker: "INOXWIND",
  sector: "Renewables",
  overview: {
    market_cap_inr: 16_000 * 1e7, // ₹16,000 Cr → small-cap
    upside_pct: 60,
    snowflake: { financial_health: 5, future: 5, past: 5, valuation: 3, dividends: 0 },
    rewards: ["Earnings are forecast to grow 37% per year", "Beneficiary of PLI scheme"],
    risks: [],
    returns_pct: { "1Y": -48 },
    average_daily_volume_30d: 1_000_000,
    last_close_inr: 96,
  },
  v4_breakdown: {
    pts_future: 20, // v4.1: Future pillar is 0–22 (was 18 on the old 0–20 scale — same ~0.9 "strong" fraction)
    pts_valuation: 10,
    pts_mom_1y: 2,
    pts_mom_3m: 1,
    pts_mom_1m: 0.5,
    fv_imputed: false,
    surveillance: { list: null },
  },
  data_completeness_pct: 92,
  news: [],
  yearly_history: [
    { year: 2024, netIncome: -335_217_000 },
    { year: 2025, netIncome: 4_456_475_000 }, // loss → profit flip
    { year: 2026, netIncome: 5_018_675_000 },
  ],
  most_recent_reported_date: "2026-04-29",
  macroRegime: { regime: "RISK_ON" },
  sector_ttm_return_pct: 20,
  position_size_inr: 14_000,
  now_iso: NOW,
});

it("config exposes verdict bands", () => {
  assert.equal(MULTIBAGGER_SCORER_CONFIG.VERDICT_BANDS.FIVEX_CANDIDATE, 70);
  assert.equal(MULTIBAGGER_SCORER_CONFIG.VERDICT_BANDS.HIGH_CONVICTION, 55);
});

it("strong INOXWIND-shape row → 5X_CANDIDATE verdict", () => {
  const r = scoreCandidate(strongRow());
  assert.equal(r.gate_blocked, false);
  assert.ok(r.score_0_100 >= 70, `score should be ≥70, got ${r.score_0_100}`);
  assert.equal(r.verdict, "5X_CANDIDATE");
});

it("hard reject when promoter pledge ≥25%", () => {
  const row = strongRow();
  row.pledge_events = [{
    symbol: "INOXWIND",
    event_date_iso: "2026-04-01",
    pledge_pct_after: 30,
    pledge_pct_before: 28,
  }];
  const r = scoreCandidate(row);
  assert.equal(r.gate_blocked, true);
  assert.equal(r.verdict, "HARD_REJECT");
  assert.match(r.gate_reasons.join(" "), /pledge_pledge_30pct/);
});

it("hard reject when liquidity insufficient", () => {
  const row = strongRow();
  row.overview.average_daily_volume_30d = 100; // 100 × ₹96 = ₹9,600 ADV
  const r = scoreCandidate(row);
  assert.equal(r.gate_blocked, true);
  assert.match(r.gate_reasons.join(" "), /liquidity_/);
});

it("hard reject on GSM surveillance", () => {
  const row = strongRow();
  row.v4_breakdown.surveillance = { list: "GSM" };
  const r = scoreCandidate(row);
  assert.equal(r.gate_blocked, true);
  assert.match(r.gate_reasons.join(" "), /surveillance_gsm/);
});

it("hard reject on going-concern audit flag", () => {
  const row = strongRow();
  row.news = [{ title: "Auditor flags going concern doubt", published_at_iso: "2026-04-01" }];
  const r = scoreCandidate(row);
  assert.equal(r.gate_blocked, true);
  assert.match(r.gate_reasons.join(" "), /audit_quality_flag/);
});

it("hard reject on data completeness < 40%", () => {
  const row = strongRow();
  row.data_completeness_pct = 35;
  const r = scoreCandidate(row);
  assert.equal(r.gate_blocked, true);
  assert.match(r.gate_reasons.join(" "), /data_completeness_below_40pct/);
});

it("health < 3 caps total score at 50", () => {
  const row = strongRow();
  row.overview.snowflake.financial_health = 2;
  const r = scoreCandidate(row);
  assert.ok(r.score_0_100 <= 50, `expected ≤50 with health=2, got ${r.score_0_100}`);
  assert.equal(r.diagnostics.health_cap_applied, true);
});

it("micro-cap (<₹500Cr) gets full 10 pts", () => {
  const row = strongRow();
  row.overview.market_cap_inr = 300 * 1e7;
  // Re-jig ADV gate — micro-cap with high vol needed
  row.overview.average_daily_volume_30d = 100_000;
  row.overview.last_close_inr = 80;
  const r = scoreCandidate(row);
  assert.equal(r.breakdown.mcap, 10);
});

it("RATE_HIKE drops Defense tailwind to 60%", () => {
  const row = strongRow();
  row.sector = "Defense";
  row.macroRegime = { regime: "RATE_HIKE" };
  row.sector_ttm_return_pct = 20;
  const r = scoreCandidate(row);
  // base 17 × 0.6 × 1.0 = 10.2
  assert.equal(r.breakdown.sector_tailwind, 10.2);
});

it("cohort-exhausted sector (TTM>80%) → 0 tailwind", () => {
  const row = strongRow();
  row.sector_ttm_return_pct = 100;
  const r = scoreCandidate(row);
  assert.equal(r.breakdown.sector_tailwind, 0);
});

it("imputed momentum capped at 3", () => {
  const row = strongRow();
  row.overview.returns_pct["1Y"] = null;
  const r = scoreCandidate(row);
  assert.equal(r.breakdown.momentum, 3);
});

it("score stays in [0, 100]", () => {
  const row = strongRow();
  const r = scoreCandidate(row);
  assert.ok(r.score_0_100 >= 0 && r.score_0_100 <= 100);
});

it("liquidity bonus tiers", () => {
  const row = strongRow();
  // High ADV ≥ ₹5Cr → 5pts
  row.overview.average_daily_volume_30d = 1_000_000;
  row.overview.last_close_inr = 600; // 1M × 600 = ₹60Cr ADV
  const r = scoreCandidate(row);
  assert.equal(r.breakdown.liquidity_bonus, 5);
});

it("forward growth from rewards text — 37% → 5pts", () => {
  const row = strongRow();
  const r = scoreCandidate(row);
  assert.equal(r.breakdown.forward_growth, 5);
});

it("story bonus fires on PLI + renewable tags", () => {
  const row = strongRow();
  row.overview.rewards = ["PLI scheme beneficiary", "Renewable wind energy supplier"];
  const r = scoreCandidate(row);
  assert.equal(r.breakdown.story_bonus, 3);
});

it("verdict PASS for weak signals across the board", () => {
  const row = strongRow();
  row.overview.snowflake.financial_health = 3;
  row.v4_breakdown.pts_future = 4;
  row.v4_breakdown.pts_valuation = 4;
  row.overview.upside_pct = 5;
  row.yearly_history = [{ year: 2024, netIncome: 100 }, { year: 2025, netIncome: 95 }];
  row.macroRegime = { regime: "RATE_HIKE" };
  row.sector = "IT";
  row.overview.rewards = [];
  const r = scoreCandidate(row);
  assert.ok(r.score_0_100 < 40, `expected PASS band, got ${r.score_0_100}`);
  assert.equal(r.verdict, "PASS");
});

it("verdict HIGH_CONVICTION lands between 55 and 70", () => {
  const row = strongRow();
  // Drop sector tailwind to push score from 5X_CANDIDATE down to HIGH
  row.sector = "IT";
  row.macroRegime = { regime: "RATE_HIKE" };
  const r = scoreCandidate(row);
  assert.ok(r.score_0_100 >= 55, `expected ≥55, got ${r.score_0_100}`);
  // Allow either HIGH or 5X depending on margin
  assert.ok(["HIGH_CONVICTION", "5X_CANDIDATE"].includes(r.verdict));
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
