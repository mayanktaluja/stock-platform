// Unit + regression tests for services/swsPortfolioHealth.js.
// Covers each component (quality / valuation / diversification /
// concentration / risk / macro / pnl), the band/grade mapping, the
// snapshot regression, and edge cases (single-holding, all-cash,
// zero coverage).
//
// Run with: node test/swsPortfolioHealth.test.mjs

import { computePortfolioHealth } from "../services/swsPortfolioHealth.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

// Build a holding row that mirrors the swsHoldingEngine.scoreHolding shape.
function makeHolding(overrides = {}) {
  const sws = overrides.sws || {};
  return {
    swsCovered: overrides.swsCovered !== undefined ? overrides.swsCovered : true,
    sector: overrides.sector || "IT Services",
    positionWeight: overrides.positionWeight ?? 10,
    pnlPercent: overrides.pnlPercent ?? 5,
    currentValue: overrides.currentValue ?? 100000,
    action: overrides.action || "HOLD",
    sws: {
      ticker: overrides.ticker || "TEST",
      sector: overrides.sector || "IT Services",
      v3_score: sws.v3_score ?? 50,
      snowflake_total: sws.snowflake_total ?? 15,
      upside_pct: sws.upside_pct ?? 0,
      surveillance: sws.surveillance ?? null,
      indianRisk: sws.indianRisk ?? null,
      ...sws,
    },
  };
}

// Build N equal-weight, equal-sector holdings with custom v3 scores.
function uniformHoldings(n, { v3 = 50, sector = "IT Services", upside = 0, action = "HOLD", pnl = 5 } = {}) {
  const w = 100 / n;
  return Array.from({ length: n }, (_, i) =>
    makeHolding({
      ticker: `T${i}`,
      positionWeight: w,
      sector,
      pnlPercent: pnl,
      action,
      sws: { v3_score: v3, upside_pct: upside, snowflake_total: 15 },
    })
  );
}

console.log("\nQuality component (weighted v3 → +0..35)\n");

{
  const holdings = uniformHoldings(5, { v3: 100 });
  const ph = computePortfolioHealth({}, holdings);
  // Quality should be 35 * 1.0 (full coverage) = 35
  assert("avg v3 100 → quality +35", Math.abs(ph.components.quality - 35) < 0.05, ph.components);
}
{
  const holdings = uniformHoldings(5, { v3: 50 });
  const ph = computePortfolioHealth({}, holdings);
  // Quality should be 17.5 * 1.0 = 17.5
  assert("avg v3 50 → quality +17.5", Math.abs(ph.components.quality - 17.5) < 0.05, ph.components);
}
{
  const holdings = uniformHoldings(5, { v3: 0 });
  const ph = computePortfolioHealth({}, holdings);
  assert("avg v3 0 → quality 0", Math.abs(ph.components.quality - 0) < 0.05, ph.components);
}

console.log("\nValuation component (weighted upside, capped → +0..15)\n");

{
  const holdings = uniformHoldings(5, { upside: 30 });
  const ph = computePortfolioHealth({}, holdings);
  assert("avg upside +30 → valuation +15", Math.abs(ph.components.valuation - 15) < 0.05, ph.components);
}
{
  const holdings = uniformHoldings(5, { upside: 0 });
  const ph = computePortfolioHealth({}, holdings);
  assert("avg upside 0 → valuation +7.5", Math.abs(ph.components.valuation - 7.5) < 0.05, ph.components);
}
{
  const holdings = uniformHoldings(5, { upside: -20 });
  const ph = computePortfolioHealth({}, holdings);
  assert("avg upside -20 → valuation 0", Math.abs(ph.components.valuation - 0) < 0.05, ph.components);
}

console.log("\nDiversification component (HHI → +0..15)\n");

{
  const holdings = uniformHoldings(1, { v3: 50 });
  // Single sector → HHI = 1 → diversification = 0
  const ph = computePortfolioHealth({}, holdings);
  assert("1 sector → diversification 0", Math.abs(ph.components.diversification - 0) < 0.05, ph.components);
}
{
  // 5 equal sectors → HHI = 0.2 → diversification = (1-0.2)*15 = 12
  const holdings = [
    makeHolding({ ticker: "A", sector: "IT Services", positionWeight: 20 }),
    makeHolding({ ticker: "B", sector: "Banking", positionWeight: 20 }),
    makeHolding({ ticker: "C", sector: "Pharma", positionWeight: 20 }),
    makeHolding({ ticker: "D", sector: "Energy", positionWeight: 20 }),
    makeHolding({ ticker: "E", sector: "FMCG", positionWeight: 20 }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert("5 equal sectors → diversification ≈ 12", Math.abs(ph.components.diversification - 12) < 0.1, ph.components);
}

console.log("\nConcentration component (top-1/top-3 → -10..0)\n");

{
  // top1 = 40% (>35), but top3 < 60 so only top1 fires → -6.
  // Need to spread remaining 60% so the next two are small.
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 40, sector: "IT Services" }),
    makeHolding({ ticker: "B", positionWeight: 7.5, sector: "Banking" }),
    makeHolding({ ticker: "C", positionWeight: 7.5, sector: "Pharma" }),
    makeHolding({ ticker: "D", positionWeight: 7.5, sector: "Energy" }),
    makeHolding({ ticker: "E", positionWeight: 7.5, sector: "FMCG" }),
    makeHolding({ ticker: "F", positionWeight: 7.5, sector: "Auto" }),
    makeHolding({ ticker: "G", positionWeight: 7.5, sector: "Metals" }),
    makeHolding({ ticker: "H", positionWeight: 7.5, sector: "Telecom" }),
    makeHolding({ ticker: "I", positionWeight: 7.5, sector: "Power" }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert("top1=40, top3=55 → concentration -6", ph.components.concentration === -6, ph.components);
}
{
  // top1 = 28% (>25), top3 = 28+22+15 = 65% (>60), so -3 + -2 = -5
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 28, sector: "IT Services" }),
    makeHolding({ ticker: "B", positionWeight: 22, sector: "Banking" }),
    makeHolding({ ticker: "C", positionWeight: 15, sector: "Pharma" }),
    makeHolding({ ticker: "D", positionWeight: 20, sector: "Energy" }),
    makeHolding({ ticker: "E", positionWeight: 15, sector: "FMCG" }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert("top1=28, top3=65 → concentration -5", ph.components.concentration === -5, ph.components);
}

console.log("\nRisk component (action + surveillance + pledge → -10..0)\n");

{
  // 1 EXIT (-3) + 1 Reduction-50% (-1) = -4
  const holdings = [
    makeHolding({ ticker: "A", action: "EXIT" }),
    makeHolding({ ticker: "B", action: "Reduction-50%" }),
    makeHolding({ ticker: "C", action: "HOLD" }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  // Coverage = 1.0; risk delta = -4 * 1.0 = -4
  assert("1 EXIT + 1 Reduction-50% → risk -4", ph.components.risk === -4, ph.components);
}
{
  // 1 GSM surveillance (-3) + 1 pledge>30% (-2) = -5
  const holdings = [
    makeHolding({ ticker: "A", sws: { surveillance: { list: "GSM", stage: "II" } } }),
    makeHolding({
      ticker: "B",
      sws: {
        indianRisk: { governance_snapshot: { promoter_pledge: 0.40 } },
      },
    }),
    makeHolding({ ticker: "C" }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert("1 GSM + 1 pledge>30 → risk -5", ph.components.risk === -5, ph.components);
}

console.log("\nMacro component (regime tilt → -10..+10)\n");

{
  // regime null → macro 0
  const ph = computePortfolioHealth({}, uniformHoldings(3));
  assert("no regime → macro 0", ph.components.macro === 0, ph.components);
}
{
  // bullish regime on a sector that holds 100% of book → measurable +
  const regime = {
    regime: "POLICY_STIMULUS",
    severity: 3,
    confidence: 0.9,
    sectorImpacts: [{ sector: "IT Services", impact: 0.8, reason: "stimulus" }],
  };
  const holdings = uniformHoldings(3, { sector: "IT Services" });
  const ph = computePortfolioHealth({}, holdings, { macroRegime: regime });
  assert("bullish regime + 100% sector exposure → macro > 0", ph.components.macro > 0, ph.components);
}

console.log("\nP&L component (red ratio → -5..0)\n");

{
  // 0/3 red → 0
  const holdings = uniformHoldings(3, { pnl: 5 });
  const ph = computePortfolioHealth({}, holdings);
  assert("0% red → pnl 0", ph.components.pnl === 0, ph.components);
}
{
  // 2/3 ≈ 67% red → -5
  const holdings = [
    makeHolding({ ticker: "A", pnlPercent: -10 }),
    makeHolding({ ticker: "B", pnlPercent: -5 }),
    makeHolding({ ticker: "C", pnlPercent: 5 }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert("67% red → pnl -5", ph.components.pnl === -5, ph.components);
}
{
  // 4/10 = 40% red → -2
  const holdings = [];
  for (let i = 0; i < 10; i++) {
    holdings.push(makeHolding({ ticker: `T${i}`, positionWeight: 10, pnlPercent: i < 4 ? -5 : 5 }));
  }
  const ph = computePortfolioHealth({}, holdings);
  assert("40% red → pnl -2", ph.components.pnl === -2, ph.components);
}

console.log("\nGrade & band mapping\n");

{
  // High score → A / Resilient
  const regime = null;
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 20, sector: "IT Services", sws: { v3_score: 90, upside_pct: 25 } }),
    makeHolding({ ticker: "B", positionWeight: 20, sector: "Banking", sws: { v3_score: 90, upside_pct: 25 } }),
    makeHolding({ ticker: "C", positionWeight: 20, sector: "Pharma", sws: { v3_score: 90, upside_pct: 25 } }),
    makeHolding({ ticker: "D", positionWeight: 20, sector: "Energy", sws: { v3_score: 90, upside_pct: 25 } }),
    makeHolding({ ticker: "E", positionWeight: 20, sector: "FMCG", sws: { v3_score: 90, upside_pct: 25 } }),
  ];
  const ph = computePortfolioHealth({}, holdings, { macroRegime: regime });
  assert(`high-quality book → grade A (got ${ph.grade}/${ph.score})`, ph.grade === "A" && ph.score >= 85, ph);
}
{
  // Single bad holding → low score
  const holdings = [makeHolding({ ticker: "A", positionWeight: 100, sws: { v3_score: 10, upside_pct: -25 }, action: "EXIT", pnlPercent: -30 })];
  const ph = computePortfolioHealth({}, holdings);
  assert(`one EXIT, all-loss, single-holding → grade ≤ D (got ${ph.grade}/${ph.score})`, ["D", "E"].includes(ph.grade), ph);
}

console.log("\nDriver / drag ordering\n");

{
  // Force a mix: high quality (driver), severe concentration (drag)
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 50, sector: "IT Services", sws: { v3_score: 90, upside_pct: 25 } }),
    makeHolding({ ticker: "B", positionWeight: 25, sector: "Banking", sws: { v3_score: 90, upside_pct: 25 } }),
    makeHolding({ ticker: "C", positionWeight: 15, sector: "Pharma", sws: { v3_score: 90, upside_pct: 25 } }),
    makeHolding({ ticker: "D", positionWeight: 10, sector: "Energy", sws: { v3_score: 90, upside_pct: 25 } }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  // Quality should rank first in drivers (largest +Δ)
  const firstDriver = ph.topDrivers[0]?.label || "";
  assert("top driver is quality-related", /quality|v3/i.test(firstDriver), firstDriver);
  // Top1 = 50% triggers concentration drag
  const dragLabels = ph.topDrags.map((d) => d.label).join(" | ");
  assert("concentration appears in drags", /concentration|top-1|top-3/i.test(dragLabels), dragLabels);
}

console.log("\nEdge cases\n");

{
  const ph = computePortfolioHealth({}, []);
  assert("empty holdings → null", ph === null, ph);
}
{
  const holdings = [makeHolding({ ticker: "A", positionWeight: 100 })];
  const ph = computePortfolioHealth({}, holdings);
  assert("single holding → finite score", Number.isFinite(ph.score), ph);
  assert("single holding → diversification 0", ph.components.diversification === 0, ph.components);
  assert("single holding → notes mentions single", (ph.notes || []).join("|").includes("Single-holding"), ph.notes);
}
{
  // All uncovered → coverageFactor floors at 0.6
  const holdings = [
    makeHolding({ ticker: "A", swsCovered: false, sector: "IT Services", positionWeight: 50 }),
    makeHolding({ ticker: "B", swsCovered: false, sector: "Banking", positionWeight: 50 }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert("zero coverage → coverageFactor = 0.6", ph.components.coverageFactor === 0.6, ph.components);
  assert("zero coverage → quality 0", ph.components.quality === 0, ph.components);
  assert("zero coverage → finite score 0..100", ph.score >= 0 && ph.score <= 100, ph);
}
{
  // All overvalued → valuation floors at 0 (no double-penalty)
  const holdings = uniformHoldings(5, { upside: -30 });
  const ph = computePortfolioHealth({}, holdings);
  assert("all overvalued → valuation 0 (no negative)", ph.components.valuation === 0, ph.components);
}
{
  // NaN guards
  const holdings = [makeHolding({ ticker: "A", positionWeight: NaN, sws: { v3_score: NaN, upside_pct: NaN } })];
  const ph = computePortfolioHealth({}, holdings);
  assert("NaN inputs → finite score", Number.isFinite(ph.score) && ph.score >= 0 && ph.score <= 100, ph);
}

console.log("\nSnapshot regression — locks the v1 formula\n");

{
  // 8-holding fixture: mix of sectors, scores, actions.
  // Expected (eyeballed from the formula):
  //  • coverage = 8/8 = 1.0 → factor = 1.0
  //  • avg v3 (weighted ≈ uniform) ≈ 60 → quality ≈ 21.0
  //  • avg upside ≈ 12 → valuation ≈ +9.6
  //  • 5 sectors, slightly tilted toward IT Services (top1=20) → div ≈ 12
  //  • top1=20 (≤25), top3=55 (≤60) → concentration 0
  //  • 1 Reduction-50% → risk -1
  //  • macro = 0 (no regime)
  //  • 2/8 = 25% red → pnl 0
  // Expected score ≈ 60 + 21 + 9.6 + 12 + 0 - 1 + 0 + 0 = 101.6 → clamp 100
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 20, sector: "IT Services",   sws: { v3_score: 70, upside_pct: 20 }, pnlPercent: 10 }),
    makeHolding({ ticker: "B", positionWeight: 20, sector: "Banking",       sws: { v3_score: 65, upside_pct: 15 }, pnlPercent: 8 }),
    makeHolding({ ticker: "C", positionWeight: 15, sector: "Pharma",        sws: { v3_score: 60, upside_pct: 10 }, pnlPercent: 6 }),
    makeHolding({ ticker: "D", positionWeight: 15, sector: "Energy",        sws: { v3_score: 55, upside_pct: 12 }, pnlPercent: 4 }),
    makeHolding({ ticker: "E", positionWeight: 10, sector: "FMCG",          sws: { v3_score: 50, upside_pct: 8 },  pnlPercent: -3 }),
    makeHolding({ ticker: "F", positionWeight: 10, sector: "IT Services",   sws: { v3_score: 60, upside_pct: 5 },  pnlPercent: -5 }),
    makeHolding({ ticker: "G", positionWeight: 5,  sector: "Pharma",        sws: { v3_score: 55, upside_pct: 15 }, pnlPercent: 2, action: "Reduction-50%" }),
    makeHolding({ ticker: "H", positionWeight: 5,  sector: "Banking",       sws: { v3_score: 65, upside_pct: 18 }, pnlPercent: 7 }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  // Lock the integer score. If the formula moves, this test must be
  // updated explicitly — it's the single point that pins all weights.
  assert(`8-holding fixture → score = 100 (got ${ph.score})`, ph.score === 100, { score: ph.score, components: ph.components });
  assert("8-holding fixture → grade A", ph.grade === "A", ph);
  assert("8-holding fixture → has methodologyNote", typeof ph.methodologyNote === "string" && ph.methodologyNote.length > 0, ph.methodologyNote);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
