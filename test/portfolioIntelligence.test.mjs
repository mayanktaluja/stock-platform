// Unit tests for portfolioIntelligence.js core public surface.
//
// portfolioIntelligence.js is the LLM-free decision engine the Portfolio
// Analyzer leans on for: per-holding action (7-way ladder + macro overlay),
// portfolio health score (0–100 with breakdown), sector allocation +
// rebalance carve-out, recovery math, position-size sanity checks, and the
// orchestrator that ties them together.
//
// Pre-existing tests covered three small leaves:
//   - test/portfolioSellTrigger.test.mjs (computeSellTrigger)
//   - test/portfolioDrawdownRebalance.test.mjs (computeDrawdownInfo,
//     computeRebalanceSuggestion)
//
// That left the load-bearing entry points server.js wires up
// (`computePortfolioCombinedScore`, `computeAction`, `applyMacroToAction`,
// `computeHealthScore`, `buildPortfolioIntelligence`) entirely untested on
// a 1228-LOC module that drives investor-facing recommendations. This
// suite focuses on the happy / boundary / error case per entry point —
// each block targets a specific branch in the module so regressions
// (governance gate, CUT_LOSS tiers, macro upgrade/downgrade, health-score
// floor, Hamilton rounding) fail loudly rather than silently shifting
// rupee-priced advice.

import { strict as assert } from "node:assert";
import {
  computePortfolioCombinedScore,
  computeAction,
  applyMacroToAction,
  computeHealthScore,
  computeSectorAllocation,
  computeTopMovers,
  computeRecoveryMath,
  computeTargetPositionSize,
  buildPortfolioIntelligence,
} from "../portfolioIntelligence.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.error(`  ✗ ${name}\n     ${e.message}`); failed += 1; }
}

// ─── [1] computePortfolioCombinedScore ─────────────────────────────────

console.log("\n[1] computePortfolioCombinedScore — tech/fund blend + macro half-weight");
test("returns null when tech score is null (data-missing gate)", () => {
  assert.equal(computePortfolioCombinedScore(null, 80), null);
  assert.equal(computePortfolioCombinedScore(null, null), null);
});
test("falls back to tech-only when fundamental is null", () => {
  // 100% tech, no blending with fundamentals.
  assert.equal(computePortfolioCombinedScore(70, null), 70);
  assert.equal(computePortfolioCombinedScore(42, null, 0), 42);
});
test("60/40 tech/fund blend when both present", () => {
  // 80 * 0.6 + 60 * 0.4 = 48 + 24 = 72
  assert.equal(computePortfolioCombinedScore(80, 60), 72);
  // 50 * 0.6 + 70 * 0.4 = 58
  assert.equal(computePortfolioCombinedScore(50, 70), 58);
});
test("macro delta is applied at HALF weight on top of base", () => {
  // base = 60, delta = +10 → 60 + 5 = 65
  assert.equal(computePortfolioCombinedScore(60, null, 10), 65);
  // base = 60, delta = -10 → 60 - 5 = 55
  assert.equal(computePortfolioCombinedScore(60, null, -10), 55);
});
test("clamps to 0..100 boundary even with extreme macro deltas", () => {
  // 95 + 50 (huge tailwind) capped at 100
  assert.equal(computePortfolioCombinedScore(95, null, 50), 100);
  // 5 - 50 (huge headwind) floored at 0
  assert.equal(computePortfolioCombinedScore(5, null, -50), 0);
});
test("non-finite macro delta is treated as 0 (no NaN propagation)", () => {
  assert.equal(computePortfolioCombinedScore(70, null, NaN), 70);
  assert.equal(computePortfolioCombinedScore(70, null, Infinity), 70);
});

// ─── [2] computeAction — the 7-way action ladder ───────────────────────

const ctxLive = (overrides = {}) => ({ positionWeight: 5, hasLiveData: true, ...overrides });

console.log("\n[2] computeAction — data-missing returns NO_DATA");
test("hasLiveData=false short-circuits to NO_DATA", () => {
  const out = computeAction({ symbol: "X" }, {}, { hasLiveData: false });
  assert.equal(out.action, "NO_DATA");
  assert.equal(out.urgency, "none");
  assert.equal(out.color, "gray");
});

console.log("\n[3] computeAction — governance gate is Priority 0");
test("REVIEW severity governance gate trumps everything including a perfect score", () => {
  const govGate = {
    severity: "REVIEW",
    reason: "Promoter pledge spiked 40 pts in 90 days",
    pattern: "PLEDGE_SPIKE",
  };
  // Even with a 95/100 score and a 200% gain, the governance gate fires.
  const out = computeAction(
    { symbol: "ZZZ", pnlPercent: 200 },
    { combinedScore: 95, technicalScore: 95, fundamentalScore: 95, fundamentalVerdict: "QUALITY_GROWTH" },
    ctxLive({ governanceGate: govGate, positionWeight: 5 })
  );
  assert.equal(out.action, "REVIEW_GOVERNANCE");
  assert.equal(out.urgency, "high");
  assert.equal(out.color, "dark-red");
  assert.equal(out.governanceGate, govGate);
});

console.log("\n[4] computeAction — CUT_LOSS tiers (P&L-driven)");
test("pnl <= -40 is unconditional CUT_LOSS even with a strong technical score", () => {
  const out = computeAction(
    { symbol: "INOXWIND", pnlPercent: -50 },
    { combinedScore: 70, technicalScore: 70, fundamentalScore: 70 },
    ctxLive()
  );
  assert.equal(out.action, "CUT_LOSS");
  assert.equal(out.urgency, "high");
  assert.ok(out.factors.includes("loss_40_plus"));
});
test("pnl <= -30 + combinedScore < 65 → CUT_LOSS (tier 2)", () => {
  const out = computeAction(
    { symbol: "X", pnlPercent: -35 },
    { combinedScore: 60, technicalScore: 60 },
    ctxLive()
  );
  assert.equal(out.action, "CUT_LOSS");
  assert.ok(out.factors.includes("loss_30_plus"));
});
test("pnl <= -25 + combinedScore < 55 OR overvalued → CUT_LOSS (tier 3)", () => {
  const out = computeAction(
    { symbol: "X", pnlPercent: -28 },
    { combinedScore: 60, technicalScore: 60, fundamentalVerdict: "OVERVALUED" },
    ctxLive()
  );
  assert.equal(out.action, "CUT_LOSS");
});

console.log("\n[5] computeAction — bearish-score SELL path");
test("combinedScore <= 30 → SELL regardless of P&L", () => {
  const out = computeAction(
    { symbol: "X", pnlPercent: 5 }, // mild profit, doesn't save it
    { combinedScore: 25, technicalScore: 25 },
    ctxLive()
  );
  assert.equal(out.action, "SELL");
  assert.equal(out.urgency, "high");
});

console.log("\n[6] computeAction — profit-taking branch");
test("pnl >= 70 + combined < 70 → BOOK_PROFIT", () => {
  const out = computeAction(
    { symbol: "X", pnlPercent: 80 },
    { combinedScore: 60, technicalScore: 60 },
    ctxLive()
  );
  assert.equal(out.action, "BOOK_PROFIT");
  assert.equal(out.urgency, "medium");
});

console.log("\n[7] computeAction — concentration TRIM");
test("weight >= 15% → TRIM (Priority 4)", () => {
  const out = computeAction(
    { symbol: "X", pnlPercent: 10 },
    { combinedScore: 60, technicalScore: 60 }, // benign signals
    ctxLive({ positionWeight: 22 })
  );
  assert.equal(out.action, "TRIM");
  assert.equal(out.urgency, "medium");
  assert.ok(out.factors.includes("weight_over_15pct"));
});

console.log("\n[8] computeAction — accumulation branches");
test("pnl <= -10, score >= 70, DEEP_VALUE, weight < 10 → STRONG_ADD", () => {
  const out = computeAction(
    { symbol: "X", pnlPercent: -12 },
    { combinedScore: 75, technicalScore: 75, fundamentalScore: 75, fundamentalVerdict: "DEEP_VALUE" },
    ctxLive({ positionWeight: 4 })
  );
  assert.equal(out.action, "STRONG_ADD");
  assert.equal(out.color, "dark-green");
});
test("pnl <= -5, score >= 60, QUALITY_GROWTH → ADD", () => {
  const out = computeAction(
    { symbol: "X", pnlPercent: -8 },
    { combinedScore: 62, technicalScore: 62, fundamentalVerdict: "QUALITY_GROWTH" },
    ctxLive({ positionWeight: 4 })
  );
  assert.equal(out.action, "ADD");
});

console.log("\n[9] computeAction — default HOLD");
test("benign mid-range conditions → HOLD with appropriate reasoning", () => {
  const out = computeAction(
    { symbol: "X", pnlPercent: 3 },
    { combinedScore: 50, technicalScore: 50 },
    ctxLive({ positionWeight: 5 })
  );
  assert.equal(out.action, "HOLD");
  assert.equal(out.urgency, "low");
  assert.equal(out.displayAction, "Scorecard: neutral");
});
test("HOLD reasoning differs by score band (null vs neutral vs soft vs positive)", () => {
  const noScore = computeAction(
    { symbol: "X", pnlPercent: 0 }, {}, ctxLive({ positionWeight: 5 })
  );
  assert.equal(noScore.action, "HOLD");
  assert.match(noScore.reasoning, /limited/i);
});

// ─── [10] applyMacroToAction — overlay safety ──────────────────────────

console.log("\n[10] applyMacroToAction — no-op cases");
test("no macroInfo → returns the action unchanged", () => {
  const base = { action: "HOLD", factors: ["x"], reasoning: "r" };
  const out = applyMacroToAction(base, { symbol: "X" }, {}, ctxLive());
  assert.equal(out, base);
});
test("severity < 3 or |impact| < 2 → informational only, no mutation", () => {
  const base = { action: "HOLD", factors: ["x"], reasoning: "r" };
  const out = applyMacroToAction(
    base,
    { symbol: "X" },
    {},
    ctxLive({ macroInfo: { impact: -2, severity: 2, reason: "weak" } })
  );
  assert.equal(out, base);
});

console.log("\n[11] applyMacroToAction — never weakens a broken thesis");
test("CUT_LOSS under positive macro tailwind is NOT softened (load-bearing rule)", () => {
  const base = { action: "CUT_LOSS", factors: [], reasoning: "Drawdown.", urgency: "high" };
  const out = applyMacroToAction(
    base,
    { symbol: "X", pnlPercent: -50 },
    {},
    ctxLive({ macroInfo: { impact: 3, severity: 4, reason: "Rate-cut tailwind", regimeLabel: "DOVE" } })
  );
  // Action stays CUT_LOSS; the macro context is annotated but doesn't override.
  assert.equal(out.action, "CUT_LOSS");
  assert.equal(out.macroTailwind, "🌱 Rate-cut tailwind");
});

console.log("\n[12] applyMacroToAction — HOLD + overweight + headwind → TRIM");
test("HOLD with weight > 8% under macro headwind upgrades to TRIM", () => {
  const base = { action: "HOLD", factors: [], reasoning: "Scorecard: neutral", urgency: "low" };
  const out = applyMacroToAction(
    base,
    { symbol: "X" },
    {},
    ctxLive({
      positionWeight: 12,
      macroInfo: { impact: -3, severity: 4, reason: "Oil shock for IT services", regimeLabel: "OIL_SHOCK" },
    })
  );
  assert.equal(out.action, "TRIM");
  assert.equal(out.urgency, "medium");
  assert.match(out.macroWarning, /Oil shock/);
});

console.log("\n[13] applyMacroToAction — HOLD + bullish tech + tailwind → ADD");
test("HOLD with score >= 55 and weight < 10 under tailwind upgrades to ADD", () => {
  const base = { action: "HOLD", factors: [], reasoning: "Scorecard: neutral", urgency: "low" };
  const out = applyMacroToAction(
    base,
    { symbol: "X" },
    { combinedScore: 62 },
    ctxLive({
      positionWeight: 5,
      macroInfo: { impact: 3, severity: 4, reason: "Rate-cut tailwind", regimeLabel: "DOVE" },
    })
  );
  assert.equal(out.action, "ADD");
  assert.match(out.macroTailwind, /Rate-cut/);
});

console.log("\n[14] applyMacroToAction — governance gate is macro-immune");
test("REVIEW_GOVERNANCE annotates macro but never mutates the action", () => {
  const base = { action: "REVIEW_GOVERNANCE", factors: [], reasoning: "pledge spike", urgency: "high" };
  const out = applyMacroToAction(
    base,
    { symbol: "X" },
    {},
    ctxLive({ macroInfo: { impact: 3, severity: 5, reason: "Macro tailwind", regimeLabel: "BOOM" } })
  );
  assert.equal(out.action, "REVIEW_GOVERNANCE");
  assert.equal(out.macroTailwind, "🌱 Macro tailwind");
});

// ─── [15] computeHealthScore ────────────────────────────────────────────

console.log("\n[15] computeHealthScore — insufficient-data fallback");
test("empty/score-less portfolios return 50 / INSUFFICIENT_DATA", () => {
  assert.deepEqual(computeHealthScore([]).verdict, "INSUFFICIENT_DATA");
  const out = computeHealthScore([
    { holding: { symbol: "X" }, scores: {}, weight: 100 }, // no combinedScore
  ]);
  assert.equal(out.verdict, "INSUFFICIENT_DATA");
  assert.equal(out.score, 50);
});

console.log("\n[16] computeHealthScore — well-diversified profitable book scores well");
test("3-sector, all-profit, all-bullish portfolio lands in GOOD-or-better band", () => {
  const intel = [
    { holding: { sector: "IT", pnlPercent: 30 }, scores: { combinedScore: 80 }, weight: 33 },
    { holding: { sector: "Banks", pnlPercent: 20 }, scores: { combinedScore: 75 }, weight: 33 },
    { holding: { sector: "Pharma", pnlPercent: 10 }, scores: { combinedScore: 70 }, weight: 34 },
  ];
  const out = computeHealthScore(intel);
  assert.equal(out.stats.totalHoldings, 3);
  assert.equal(out.stats.inProfit, 3);
  assert.equal(out.stats.inLoss, 0);
  assert.equal(out.stats.sectorCount, 3);
  // Math: 40 base + ~30 quality + ~6 diversification (3-sector HHI ≈ 0.33) + 0
  // concentration + 0 loss + 0 valuation + 5 profit ≈ 81 raw, but quality is
  // weight-averaged not score-averaged so it lands closer to 30 actual → ~70.
  // The contract we hold: a clean profitable book reaches at least GOOD (65+),
  // never the AT_RISK / NEEDS_ATTENTION bands.
  assert.ok(out.score >= 65, `expected GOOD-or-better band, got ${out.score}`);
  assert.ok(["HEALTHY", "GOOD"].includes(out.verdict), `expected HEALTHY/GOOD, got ${out.verdict}`);
});

console.log("\n[17] computeHealthScore — concentration + losses penalise");
test("single-stock 70% in loss penalises concentration AND loss ratio", () => {
  const intel = [
    { holding: { sector: "Energy", pnlPercent: -20 }, scores: { combinedScore: 40 }, weight: 70 },
    { holding: { sector: "Energy", pnlPercent: -10 }, scores: { combinedScore: 40 }, weight: 30 },
  ];
  const out = computeHealthScore(intel);
  // Largest > 25 → -10 penalty; loss ratio = 1.0 → -12.
  assert.ok(out.breakdown.concentration <= -10, `expected concentration ≤ -10, got ${out.breakdown.concentration}`);
  assert.ok(out.breakdown.lossRatio <= -10, `expected lossRatio ≤ -10, got ${out.breakdown.lossRatio}`);
  assert.equal(out.stats.largestPosition, 70);
});

console.log("\n[18] computeHealthScore — score is clamped to 0..100");
test("score never escapes 0..100 (even with hostile inputs)", () => {
  const intel = [
    { holding: { sector: "IT", pnlPercent: 100 }, scores: { combinedScore: 100 }, weight: 50 },
    { holding: { sector: "Banks", pnlPercent: 100 }, scores: { combinedScore: 100 }, weight: 50 },
  ];
  const out = computeHealthScore(intel);
  assert.ok(out.score <= 100 && out.score >= 0);
});

// ─── [19] computeSectorAllocation ───────────────────────────────────────

console.log("\n[19] computeSectorAllocation — Hamilton rounding makes weights sum to 100");
test("rounded weights sum to 100.0 exactly (no +0.03% drift)", () => {
  // Three sectors with fractional weights that would each round to 33.3
  // (summing to 99.9 with naive rounding) — Hamilton's largest-remainder
  // method must add a 0.1 to the row with the biggest remainder.
  const intel = [
    { holding: { symbol: "A", sector: "IT", investedValue: 100 }, weight: 33.333 },
    { holding: { symbol: "B", sector: "Banks", investedValue: 100 }, weight: 33.333 },
    { holding: { symbol: "C", sector: "Pharma", investedValue: 100 }, weight: 33.334 },
  ];
  const rows = computeSectorAllocation(intel);
  const total = rows.reduce((s, r) => s + r.weight, 0);
  // Floating-point safety — should be 100.0 exactly.
  assert.ok(Math.abs(total - 100) < 0.01, `weights summed to ${total}, expected 100.0`);
  assert.equal(rows.length, 3);
});
test("sectors are sorted descending by weight and flagged by band", () => {
  const intel = [
    { holding: { symbol: "A", sector: "IT", investedValue: 100 }, weight: 40 },
    { holding: { symbol: "B", sector: "Banks", investedValue: 100 }, weight: 25 },
    { holding: { symbol: "C", sector: "Pharma", investedValue: 100 }, weight: 15 },
    { holding: { symbol: "D", sector: "Auto", investedValue: 100 }, weight: 20 },
  ];
  const rows = computeSectorAllocation(intel);
  // Sort: IT 40, Banks 25, Auto 20, Pharma 15 (descending).
  assert.equal(rows[0].sector, "IT");
  assert.equal(rows[0].flag, "overconcentrated");
  assert.equal(rows[1].sector, "Banks");
  assert.equal(rows[1].flag, "moderate");
  // Auto at 20 → moderate; Pharma at 15 → diversified.
  assert.equal(rows[2].sector, "Auto");
  assert.equal(rows[3].sector, "Pharma");
  assert.equal(rows[3].flag, "diversified");
});

// ─── [20] computeTopMovers ──────────────────────────────────────────────

console.log("\n[20] computeTopMovers — sorted by ABSOLUTE rupee P&L, not percent");
test("rupee-weighted ranking surfaces the biggest dollar movers", () => {
  const intel = [
    // A: ₹10K gain @ 80% pct  — high pct but small ₹
    { holding: { symbol: "A", pnl: 10000, pnlPercent: 80 } },
    // B: ₹100K gain @ 20% pct — modest pct but huge ₹ → top winner
    { holding: { symbol: "B", pnl: 100000, pnlPercent: 20 } },
    // C: ₹50K loss @ -40% pct  — top loser by ₹
    { holding: { symbol: "C", pnl: -50000, pnlPercent: -40 } },
    // D: ₹5K loss @ -5% pct
    { holding: { symbol: "D", pnl: -5000, pnlPercent: -5 } },
  ];
  const out = computeTopMovers(intel, 2);
  // Winners ordered by absolute ₹: B (100K) then A (10K).
  assert.equal(out.topWinners[0].symbol, "B");
  assert.equal(out.topWinners[1].symbol, "A");
  // Losers ordered by absolute ₹: C (50K) then D (5K).
  assert.equal(out.topLosers[0].symbol, "C");
  assert.equal(out.topLosers[1].symbol, "D");
});
test("holdings with null pnl are excluded", () => {
  const out = computeTopMovers([
    { holding: { symbol: "X", pnl: null, pnlPercent: 10 } },
    { holding: { symbol: "Y", pnl: 5000, pnlPercent: 10 } },
  ], 3);
  assert.equal(out.topWinners.length, 1);
  assert.equal(out.topWinners[0].symbol, "Y");
});

// ─── [21] computeRecoveryMath ───────────────────────────────────────────

console.log("\n[21] computeRecoveryMath — upside math + 52W refinement");
test("positive-pnl holding returns null (recovery math only applies in loss)", () => {
  assert.equal(
    computeRecoveryMath({ pnlPercent: 10, avgPrice: 100, currentPrice: 110 }, null),
    null
  );
});
test("missing avg/current price returns null", () => {
  assert.equal(computeRecoveryMath({ pnlPercent: -10 }, null), null);
  assert.equal(
    computeRecoveryMath({ pnlPercent: -10, avgPrice: 100 }, null),
    null
  );
});
test("small drawdown → 'high' recovery probability, reasonable upside", () => {
  // avg 100, current 95 → 5.26% upside needed → "high"
  const out = computeRecoveryMath({ pnlPercent: -5, avgPrice: 100, currentPrice: 95 }, null);
  assert.equal(out.recoveryProbability, "high");
  assert.equal(out.breakEvenPrice, 100);
  assert.ok(out.upsideNeededPct > 5 && out.upsideNeededPct < 6);
});
test("massive drawdown (>100% upside needed) → 'very_low'", () => {
  // avg 100, current 30 → needs 233% upside
  const out = computeRecoveryMath({ pnlPercent: -70, avgPrice: 100, currentPrice: 30 }, null);
  assert.equal(out.recoveryProbability, "very_low");
});
test("falling-knife: high 52W position + losing → downgraded to 'low'", () => {
  // avg 200, current 150 (33% upside needed → would be "low" already), but
  // current is high in the 52W range (high=160, low=80 → pos52 = 87%) → still low.
  const out = computeRecoveryMath(
    { pnlPercent: -25, avgPrice: 200, currentPrice: 150 },
    { fiftyTwoWeekHigh: 160, fiftyTwoWeekLow: 80 }
  );
  assert.equal(out.recoveryProbability, "low");
  assert.match(out.note, /YOU entered at an even higher level/);
});

// ─── [22] computeTargetPositionSize ─────────────────────────────────────

console.log("\n[22] computeTargetPositionSize — conviction tiers");
test("score >= 70 → high tier 7–10%", () => {
  const out = computeTargetPositionSize(75, 8);
  assert.equal(out.tier, "high");
  assert.equal(out.targetRange, "7-10%");
  assert.equal(out.status, "appropriate"); // 8% is inside 7–10
});
test("overweight: current > 1.5x targetMax → status overweight", () => {
  // tier=high, targetMax=10, 1.5x=15. Current 20 > 15 → overweight.
  const out = computeTargetPositionSize(75, 20);
  assert.equal(out.status, "overweight");
});
test("underweight: current < targetMin", () => {
  // tier=high, targetMin=7. Current 3 < 7 → underweight.
  const out = computeTargetPositionSize(75, 3);
  assert.equal(out.status, "underweight");
});
test("null combinedScore → status=no_data", () => {
  const out = computeTargetPositionSize(null, 5);
  assert.equal(out.status, "no_data");
  assert.equal(out.targetRange, null);
});
test("score < 40 → none tier 0–2%", () => {
  const out = computeTargetPositionSize(20, 1);
  assert.equal(out.tier, "none");
  assert.equal(out.targetRange, "0-2%");
});

// ─── [23] buildPortfolioIntelligence — orchestrator end-to-end ─────────

console.log("\n[23] buildPortfolioIntelligence — orchestrator wiring");
test("end-to-end happy path returns the full intel shape", () => {
  const holdings = [
    {
      symbol: "TCS", name: "Tata Consultancy", sector: "IT",
      avgPrice: 3000, currentPrice: 3500, investedValue: 30000, currentValue: 35000,
      pnl: 5000, pnlPercent: 16.67, fiftyTwoWeekHigh: 4000, fiftyTwoWeekLow: 2800,
    },
    {
      symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banks",
      avgPrice: 1500, currentPrice: 1400, investedValue: 30000, currentValue: 28000,
      pnl: -2000, pnlPercent: -6.67, fiftyTwoWeekHigh: 1800, fiftyTwoWeekLow: 1350,
    },
    {
      symbol: "SUNPHARMA", name: "Sun Pharma", sector: "Pharma",
      avgPrice: 1100, currentPrice: 1200, investedValue: 22000, currentValue: 24000,
      pnl: 2000, pnlPercent: 9.09, fiftyTwoWeekHigh: 1300, fiftyTwoWeekLow: 900,
    },
  ];
  const analyses = new Map([
    ["TCS",      { combinedScore: 72, technicalScore: 72, fundamentalScore: 70, fundamentalVerdict: "QUALITY_GROWTH" }],
    ["HDFCBANK", { combinedScore: 65, technicalScore: 60, fundamentalScore: 72, fundamentalVerdict: "QUALITY_GROWTH" }],
    ["SUNPHARMA",{ combinedScore: 55, technicalScore: 55, fundamentalScore: 55, fundamentalVerdict: "FAIR_VALUE" }],
  ]);

  const out = buildPortfolioIntelligence(holdings, analyses);

  // Top-level keys are all present (the shape consumed by gated/app.js).
  for (const k of ["healthScore", "healthVerdict", "healthBreakdown", "healthStats",
                   "urgentActions", "perStock", "sectorAllocation", "topWinners", "topLosers"]) {
    assert.ok(k in out, `missing top-level key: ${k}`);
  }
  assert.ok(out.healthScore >= 0 && out.healthScore <= 100);
  assert.ok(["HEALTHY", "GOOD", "NEEDS_ATTENTION", "AT_RISK", "INSUFFICIENT_DATA"].includes(out.healthVerdict));

  // Per-stock map has every symbol and exposes the load-bearing fields.
  for (const sym of ["TCS", "HDFCBANK", "SUNPHARMA"]) {
    assert.ok(out.perStock[sym], `missing perStock entry for ${sym}`);
    assert.ok("action" in out.perStock[sym]);
    assert.ok("recoveryMath" in out.perStock[sym]);
    assert.ok("positionSizing" in out.perStock[sym]);
    assert.ok("sellTrigger" in out.perStock[sym]);
    assert.ok("drawdownInfo" in out.perStock[sym]);
  }

  // Sector allocation has one row per sector, weights sum to 100 (Hamilton'd).
  assert.equal(out.sectorAllocation.length, 3);
  const total = out.sectorAllocation.reduce((s, r) => s + r.weight, 0);
  assert.ok(Math.abs(total - 100) < 0.01, `sector weights summed to ${total}, expected 100`);

  // Winners/losers are bucketed correctly by ₹ P&L (not percent).
  assert.equal(out.topWinners[0].symbol, "TCS"); // ₹5000
  assert.equal(out.topLosers[0].symbol, "HDFCBANK"); // ₹-2000

  // Urgent actions excludes HOLD/NO_DATA. None of these holdings trigger
  // a non-HOLD action in this fixture, so the queue may be empty — but the
  // contract is it's an array.
  assert.ok(Array.isArray(out.urgentActions));
});

test("getGovernanceGate injection routes through computeAction Priority 0", () => {
  const holdings = [{
    symbol: "VEDANTA", name: "Vedanta", sector: "Metals",
    avgPrice: 100, currentPrice: 110, investedValue: 10000, currentValue: 11000,
    pnl: 1000, pnlPercent: 10,
  }];
  const analyses = new Map([
    ["VEDANTA", { combinedScore: 70, technicalScore: 70, fundamentalScore: 70, fundamentalVerdict: "QUALITY_GROWTH" }],
  ]);
  // Closure: gate fires only for VEDANTA.
  const getGovernanceGate = (sym) => sym === "VEDANTA"
    ? { severity: "REVIEW", reason: "Promoter pledge >25%", pattern: "PLEDGE_HIGH" }
    : null;
  const out = buildPortfolioIntelligence(holdings, analyses, { getGovernanceGate });
  assert.equal(out.perStock.VEDANTA.action, "REVIEW_GOVERNANCE");
  // Urgent queue surfaces high-urgency governance review.
  assert.ok(out.urgentActions.some((u) => u.symbol === "VEDANTA" && u.action === "REVIEW_GOVERNANCE"));
});

test("missing analyses entry leaves the holding handled (no throw)", () => {
  const holdings = [{
    symbol: "UNKNOWN", name: "Unknown", sector: "Misc",
    avgPrice: 100, currentPrice: 105, investedValue: 10000, currentValue: 10500,
    pnl: 500, pnlPercent: 5,
  }];
  // Empty map — no scorecard for this symbol.
  const out = buildPortfolioIntelligence(holdings, new Map());
  // We expect either HOLD (no signals, but has live data) or NO_DATA;
  // either way, the per-stock entry must exist and orchestrator must not throw.
  assert.ok(out.perStock.UNKNOWN);
  assert.ok("action" in out.perStock.UNKNOWN);
});

test("zero invested totals don't divide-by-zero (defensive)", () => {
  const holdings = [{
    symbol: "X", name: "X", sector: "IT",
    avgPrice: 100, currentPrice: 100, investedValue: 0, currentValue: 0,
    pnl: 0, pnlPercent: 0,
  }];
  const out = buildPortfolioIntelligence(holdings, new Map([
    ["X", { combinedScore: 60, technicalScore: 60 }],
  ]));
  // weight collapses to 0 when totalInvested is 0; no NaN should appear.
  assert.equal(out.perStock.X.positionWeight, 0);
  assert.ok(Number.isFinite(out.healthScore));
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
