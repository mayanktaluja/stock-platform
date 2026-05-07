// Unit + regression tests for services/swsPortfolioHealth.js.
// Covers each component (quality / valuation / diversification /
// concentration / risk / macro / loss-control), hard caps, verdict
// mapping, the band/grade mapping, snapshot regressions for typical /
// healthy / broken Indian retail portfolios, and edge cases.
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

console.log("\nQuality component (weighted v3 → 0..25)\n");

{
  const holdings = uniformHoldings(5, { v3: 100, sector: "IT Services" });
  const ph = computePortfolioHealth({}, holdings);
  // avg v3=100 → 25 * cov(=1.0) = 25
  assert("avg v3 100 → quality 25", Math.abs(ph.components.quality - 25) < 0.05, ph.components);
}
{
  const holdings = uniformHoldings(5, { v3: 50 });
  const ph = computePortfolioHealth({}, holdings);
  // avg v3=50 → 12.5 * 1.0 = 12.5
  assert("avg v3 50 → quality 12.5", Math.abs(ph.components.quality - 12.5) < 0.05, ph.components);
}
{
  const holdings = uniformHoldings(5, { v3: 0 });
  const ph = computePortfolioHealth({}, holdings);
  assert("avg v3 0 → quality 0", Math.abs(ph.components.quality - 0) < 0.05, ph.components);
}

console.log("\nValuation component (weighted upside → 0..15)\n");

{
  const holdings = uniformHoldings(5, { upside: 30 });
  const ph = computePortfolioHealth({}, holdings);
  assert("avg upside +30 → valuation 15", Math.abs(ph.components.valuation - 15) < 0.05, ph.components);
}
{
  const holdings = uniformHoldings(5, { upside: 0 });
  const ph = computePortfolioHealth({}, holdings);
  assert("avg upside 0 → valuation 7.5 (FV midpoint)", Math.abs(ph.components.valuation - 7.5) < 0.05, ph.components);
}
{
  const holdings = uniformHoldings(5, { upside: -20 });
  const ph = computePortfolioHealth({}, holdings);
  assert("avg upside -20 → valuation 0", Math.abs(ph.components.valuation - 0) < 0.05, ph.components);
}
{
  const holdings = uniformHoldings(5, { upside: -30 });
  const ph = computePortfolioHealth({}, holdings);
  assert("avg upside -30 → valuation 0 (clamped, no negative)", ph.components.valuation === 0, ph.components);
}

console.log("\nDiversification component (HHI → 0..15)\n");

{
  const holdings = uniformHoldings(1, { v3: 50 });
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

console.log("\nConcentration component (top-1 step → 0..10)\n");

{
  // top1 = 8% → full 10
  const holdings = Array.from({ length: 13 }, (_, i) =>
    makeHolding({
      ticker: `T${i}`,
      positionWeight: 100 / 13,
      sector: ["IT Services", "Banking", "Pharma", "Energy", "FMCG", "Auto", "Metals"][i % 7],
    })
  );
  // top1 ≈ 7.69 → ≤8 → 10
  const ph = computePortfolioHealth({}, holdings);
  assert("top1 ≤8 → concentration 10", ph.components.concentration === 10, ph.components);
}
{
  // top1 = 22% (in 18..25 band) → 1
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 22, sector: "IT Services" }),
    makeHolding({ ticker: "B", positionWeight: 20, sector: "Banking" }),
    makeHolding({ ticker: "C", positionWeight: 20, sector: "Pharma" }),
    makeHolding({ ticker: "D", positionWeight: 20, sector: "Energy" }),
    makeHolding({ ticker: "E", positionWeight: 18, sector: "FMCG" }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert("top1=22 → concentration 1 (18..25 band)", ph.components.concentration === 1, ph.components);
}
{
  // top1 = 40% → 0 (>25)
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 40, sector: "IT Services" }),
    makeHolding({ ticker: "B", positionWeight: 30, sector: "Banking" }),
    makeHolding({ ticker: "C", positionWeight: 30, sector: "Pharma" }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert("top1=40 → concentration 0 (>25)", ph.components.concentration === 0, ph.components);
}

console.log("\nRisk component (start 15, deduct flags → 0..15)\n");

{
  // No flags → full 15
  const ph = computePortfolioHealth({}, uniformHoldings(3));
  assert("no flags → risk 15", ph.components.risk === 15, ph.components);
}
{
  // 1 EXIT (-4) + 1 Reduction-50% (-1) = 15-5 = 10
  const holdings = [
    makeHolding({ ticker: "A", action: "EXIT" }),
    makeHolding({ ticker: "B", action: "Reduction-50%" }),
    makeHolding({ ticker: "C", action: "HOLD" }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert("1 EXIT + 1 Reduction-50% → risk 10", ph.components.risk === 10, ph.components);
}
{
  // 1 GSM (-4) + 1 pledge>30 (-3) = 15-7 = 8
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 4, sws: { surveillance: { list: "GSM", stage: "II" } } }),
    makeHolding({
      ticker: "B",
      positionWeight: 3,
      sws: { indianRisk: { governance_snapshot: { promoter_pledge: 0.40 } } },
    }),
    makeHolding({ ticker: "C", positionWeight: 93 }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert("1 GSM + 1 pledge>30 → risk 8", ph.components.risk === 8, ph.components);
}

console.log("\nMacro component (regime tilt → 0..10, 5 = neutral)\n");

{
  // No regime → neutral 5
  const ph = computePortfolioHealth({}, uniformHoldings(3));
  assert("no regime → macro 5 (neutral)", ph.components.macro === 5, ph.components);
}
{
  // Bullish regime on a sector that holds 100% of book → measurable above 5
  const regime = {
    regime: "POLICY_STIMULUS",
    severity: 3,
    confidence: 0.9,
    sectorImpacts: [{ sector: "IT Services", impact: 0.8, reason: "stimulus" }],
  };
  const holdings = uniformHoldings(3, { sector: "IT Services" });
  const ph = computePortfolioHealth({}, holdings, { macroRegime: regime });
  assert("bullish regime + 100% sector → macro > 5", ph.components.macro > 5, ph.components);
}

console.log("\nLoss control (% of book value in red → 0..10)\n");

{
  // 0% red → 10
  const ph = computePortfolioHealth({}, uniformHoldings(3, { pnl: 5 }));
  assert("0% red → lossControl 10", ph.components.lossControl === 10, ph.components);
}
{
  // 2/3 holdings red, equal weights → 67% red value → 0
  const holdings = [
    makeHolding({ ticker: "A", pnlPercent: -10 }),
    makeHolding({ ticker: "B", pnlPercent: -5 }),
    makeHolding({ ticker: "C", pnlPercent: 5 }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert("67% red value → lossControl 0", ph.components.lossControl === 0, ph.components);
}
{
  // 4/10 holdings red, equal weights → 40% red value → 4
  const holdings = [];
  for (let i = 0; i < 10; i++) {
    holdings.push(makeHolding({ ticker: `T${i}`, positionWeight: 10, pnlPercent: i < 4 ? -5 : 5 }));
  }
  const ph = computePortfolioHealth({}, holdings);
  assert("40% red value → lossControl 4", ph.components.lossControl === 4, ph.components);
}

console.log("\nVerdict mapping\n");

{
  // Score ≥80 → HEALTHY. Build a high-quality, diversified, profitable book.
  const holdings = Array.from({ length: 12 }, (_, i) =>
    makeHolding({
      ticker: `T${i}`,
      positionWeight: 100 / 12,
      sector: ["IT Services", "Banking", "Pharma", "Energy", "FMCG", "Auto"][i % 6],
      pnlPercent: 12,
      sws: { v3_score: 88, upside_pct: 22 },
    })
  );
  const ph = computePortfolioHealth({}, holdings);
  assert(`12-stock quality book → HEALTHY (got ${ph.verdict}/${ph.score})`, ph.verdict === "HEALTHY" && ph.score >= 80, ph);
}

console.log("\nHard caps\n");

{
  // top1=42% → cap 55
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 42, sector: "IT Services", sws: { v3_score: 100, upside_pct: 30 } }),
    makeHolding({ ticker: "B", positionWeight: 20, sector: "Banking", sws: { v3_score: 100, upside_pct: 30 } }),
    makeHolding({ ticker: "C", positionWeight: 19, sector: "Pharma", sws: { v3_score: 100, upside_pct: 30 } }),
    makeHolding({ ticker: "D", positionWeight: 19, sector: "Energy", sws: { v3_score: 100, upside_pct: 30 } }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert(`top1>40 → score capped at 55 (got ${ph.score})`, ph.score <= 55, ph);
  assert("top1>40 → caps populated", Array.isArray(ph.caps) && ph.caps.some((c) => c.rule === "top1>40"), ph.caps);
  assert("top1>40 → capAppliedAt = 55", ph.capAppliedAt === 55, ph);
}
{
  // GSM holding triggers cap 70
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 6, sws: { v3_score: 95, upside_pct: 25, surveillance: { list: "GSM", stage: "II" } }, sector: "IT Services" }),
    makeHolding({ ticker: "B", positionWeight: 30, sector: "Banking", sws: { v3_score: 95, upside_pct: 25 } }),
    makeHolding({ ticker: "C", positionWeight: 30, sector: "Pharma", sws: { v3_score: 95, upside_pct: 25 } }),
    makeHolding({ ticker: "D", positionWeight: 34, sector: "Energy", sws: { v3_score: 95, upside_pct: 25 } }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert(`GSM holding → score capped ≤ 70 (got ${ph.score})`, ph.score <= 70, ph);
  assert("GSM cap rule present", ph.caps?.some((c) => c.rule === "gsm"), ph.caps);
}
{
  // Aggregate P&L < -25% → cap 70
  const holdings = uniformHoldings(5, { v3: 90, upside: 25, pnl: -35, sector: "IT Services" });
  // sector=100% IT also triggers sector>55 cap
  const ph = computePortfolioHealth({}, holdings);
  assert(`agg P&L -35% → score capped ≤ 70 (got ${ph.score})`, ph.score <= 70, ph);
  assert("aggPnL<-25 cap rule present", ph.caps?.some((c) => c.rule === "aggPnL<-25"), ph.caps);
}

console.log("\nGrade & band mapping\n");

{
  // High-quality, well-diversified, deep-discount, all-green book → grade A
  const holdings = Array.from({ length: 13 }, (_, i) =>
    makeHolding({
      ticker: `T${i}`,
      positionWeight: 100 / 13,
      sector: ["IT Services", "Banking", "Pharma", "Energy", "FMCG", "Auto", "Metals"][i % 7],
      pnlPercent: 18,
      sws: { v3_score: 92, upside_pct: 28 },
    })
  );
  const ph = computePortfolioHealth({}, holdings);
  assert(`13-stock A-tier book → grade A (got ${ph.grade}/${ph.score})`, ph.grade === "A" && ph.score >= 85, ph);
}
{
  // Single bad holding → grade D or E
  const holdings = [
    makeHolding({
      ticker: "A",
      positionWeight: 100,
      sws: { v3_score: 10, upside_pct: -25 },
      action: "EXIT",
      pnlPercent: -30,
    }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert(`one EXIT, all-loss, single-holding → grade ≤ D (got ${ph.grade}/${ph.score})`, ["D", "E"].includes(ph.grade), ph);
}

console.log("\nDriver / drag ordering\n");

{
  // High quality + severe concentration: quality earns above mid (driver),
  // concentration earns 0 (drag).
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 50, sector: "IT Services", sws: { v3_score: 90, upside_pct: 25 } }),
    makeHolding({ ticker: "B", positionWeight: 25, sector: "Banking", sws: { v3_score: 90, upside_pct: 25 } }),
    makeHolding({ ticker: "C", positionWeight: 15, sector: "Pharma", sws: { v3_score: 90, upside_pct: 25 } }),
    makeHolding({ ticker: "D", positionWeight: 10, sector: "Energy", sws: { v3_score: 90, upside_pct: 25 } }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  const firstDriver = ph.topDrivers[0]?.label || "";
  assert("top driver is quality-related", /quality|v3/i.test(firstDriver), firstDriver);
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
  // All uncovered → coverageFactor floors at 0.6, quality/valuation become 0
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
  // NaN guards
  const holdings = [makeHolding({ ticker: "A", positionWeight: NaN, sws: { v3_score: NaN, upside_pct: NaN } })];
  const ph = computePortfolioHealth({}, holdings);
  assert("NaN inputs → finite score", Number.isFinite(ph.score) && ph.score >= 0 && ph.score <= 100, ph);
}

console.log("\nSEBI-style realistic fixtures\n");

{
  // 1. Typical Indian retail book — IT-heavy, 5 holdings, all FAIR_VALUE,
  //    all green, top-1=22%. Should land 55–75 (GOOD or NEEDS_ATTENTION).
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 22, sector: "IT Services", sws: { v3_score: 55, upside_pct: 5 }, pnlPercent: 8 }),
    makeHolding({ ticker: "B", positionWeight: 20, sector: "IT Services", sws: { v3_score: 50, upside_pct: 0 }, pnlPercent: 6 }),
    makeHolding({ ticker: "C", positionWeight: 18, sector: "IT Services", sws: { v3_score: 60, upside_pct: 8 }, pnlPercent: 10 }),
    makeHolding({ ticker: "D", positionWeight: 20, sector: "Banking", sws: { v3_score: 55, upside_pct: 4 }, pnlPercent: 5 }),
    makeHolding({ ticker: "E", positionWeight: 20, sector: "FMCG", sws: { v3_score: 55, upside_pct: 6 }, pnlPercent: 7 }),
  ];
  // Note: 60% IT sector triggers sector>55 cap (cap 70).
  const ph = computePortfolioHealth({}, holdings);
  assert(
    `typical IT-heavy retail → score ∈ [50, 75] (got ${ph.score})`,
    ph.score >= 50 && ph.score <= 75,
    ph
  );
  assert(
    `typical retail → verdict ∈ {NEEDS_ATTENTION, GOOD} (got ${ph.verdict})`,
    ["NEEDS_ATTENTION", "GOOD"].includes(ph.verdict),
    ph.verdict
  );
}
{
  // 2. Healthy book — 8 holdings, 5+ sectors equal-ish, avg v3 80, avg
  //    upside +12%, top-1=14%, all green. Should land 70+.
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 14, sector: "IT Services", sws: { v3_score: 82, upside_pct: 14 }, pnlPercent: 12 }),
    makeHolding({ ticker: "B", positionWeight: 13, sector: "Banking", sws: { v3_score: 80, upside_pct: 12 }, pnlPercent: 10 }),
    makeHolding({ ticker: "C", positionWeight: 13, sector: "Pharma", sws: { v3_score: 78, upside_pct: 10 }, pnlPercent: 8 }),
    makeHolding({ ticker: "D", positionWeight: 12, sector: "Energy", sws: { v3_score: 80, upside_pct: 13 }, pnlPercent: 9 }),
    makeHolding({ ticker: "E", positionWeight: 12, sector: "FMCG", sws: { v3_score: 80, upside_pct: 11 }, pnlPercent: 7 }),
    makeHolding({ ticker: "F", positionWeight: 12, sector: "Auto", sws: { v3_score: 78, upside_pct: 10 }, pnlPercent: 6 }),
    makeHolding({ ticker: "G", positionWeight: 12, sector: "Metals", sws: { v3_score: 82, upside_pct: 12 }, pnlPercent: 8 }),
    makeHolding({ ticker: "H", positionWeight: 12, sector: "Telecom", sws: { v3_score: 80, upside_pct: 14 }, pnlPercent: 11 }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert(
    `healthy 8-stock book → score ∈ [70, 92] (got ${ph.score})`,
    ph.score >= 70 && ph.score <= 92,
    ph
  );
  assert(
    `healthy book → verdict ∈ {GOOD, HEALTHY} (got ${ph.verdict})`,
    ["GOOD", "HEALTHY"].includes(ph.verdict),
    ph.verdict
  );
}
{
  // 3. Broken book — 3 holdings, top-1=50%, all OVERVALUED, P&L -32%.
  //    Caps: top1>40 (cap 55), aggPnL<-25 (cap 70), single-sector >55 (cap 70).
  //    Lowest cap is 55. Score must be ≤ 50.
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 50, sector: "IT Services", sws: { v3_score: 35, upside_pct: -25 }, pnlPercent: -40 }),
    makeHolding({ ticker: "B", positionWeight: 30, sector: "IT Services", sws: { v3_score: 30, upside_pct: -22 }, pnlPercent: -28 }),
    makeHolding({ ticker: "C", positionWeight: 20, sector: "IT Services", sws: { v3_score: 35, upside_pct: -20 }, pnlPercent: -25 }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert(`broken book → score ≤ 50 (got ${ph.score})`, ph.score <= 50, ph);
  assert(`broken book → caps.length ≥ 2 (got ${ph.caps?.length || 0})`, (ph.caps?.length || 0) >= 2, ph.caps);
  assert(
    `broken book → verdict ∈ {AT_RISK, CRITICAL} (got ${ph.verdict})`,
    ["AT_RISK", "CRITICAL"].includes(ph.verdict),
    ph.verdict
  );
}
{
  // 4. Single-holding book — diversification=0, top-1=100% triggers
  //    concentration cap, single sector >55% triggers sector cap.
  const holdings = [
    makeHolding({ ticker: "A", positionWeight: 100, sector: "Banking", sws: { v3_score: 70, upside_pct: 15 }, pnlPercent: 8 }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert("single holding → diversification 0", ph.components.diversification === 0, ph.components);
  assert(`single holding → caps populated (got ${ph.caps?.length || 0})`, (ph.caps?.length || 0) >= 1, ph.caps);
  assert(`single holding → score ≤ 60 (got ${ph.score})`, ph.score <= 60, ph);
}
{
  // 5. GSM surveillance on a 6%-weight holding → cap fires at 70.
  const holdings = [
    makeHolding({ ticker: "GSM_A", positionWeight: 6, sector: "Pharma", sws: { v3_score: 50, upside_pct: 5, surveillance: { list: "GSM", stage: "II" } }, pnlPercent: 5 }),
    makeHolding({ ticker: "B", positionWeight: 24, sector: "IT Services", sws: { v3_score: 80, upside_pct: 18 }, pnlPercent: 12 }),
    makeHolding({ ticker: "C", positionWeight: 24, sector: "Banking", sws: { v3_score: 78, upside_pct: 14 }, pnlPercent: 10 }),
    makeHolding({ ticker: "D", positionWeight: 23, sector: "FMCG", sws: { v3_score: 75, upside_pct: 12 }, pnlPercent: 8 }),
    makeHolding({ ticker: "E", positionWeight: 23, sector: "Energy", sws: { v3_score: 75, upside_pct: 14 }, pnlPercent: 9 }),
  ];
  const ph = computePortfolioHealth({}, holdings);
  assert("GSM caps include gsm rule", ph.caps?.some((c) => c.rule === "gsm"), ph.caps);
  assert(`GSM → score ≤ 70 (got ${ph.score})`, ph.score <= 70, ph);
}

console.log("\nSnapshot regression — locks the new earned-points formula\n");

{
  // 8-holding fixture mirroring a realistic Indian retail book.
  // Components (with full coverage, no regime):
  //  • avg v3 (value-weighted) ≈ 60 → quality 15.0
  //  • avg upside ≈ 11.6 → valuation ≈ 7.5 + (11.6/30)*7.5 ≈ 10.4
  //  • 4 sectors with top sector 30% (IT, A+F) → HHI ≈ 0.235 → div ≈ 11.5
  //  • top1=20 (in 18..25 band) → concentration 1
  //  • 1 Reduction-50% → risk 14
  //  • macro 5 (no regime)
  //  • 25% red value (E + F red, equal weights) → lossControl 7
  // Sum ≈ 15 + 10.4 + 11.5 + 1 + 14 + 7 + 5 = 63.9 → ~64
  // No caps (top1=20, no GSM, no pledge, max sector 30%, agg P&L positive).
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
  // Realistic mid-tier book — must NOT hit 100, must land 55–75.
  assert(
    `8-holding fixture → score ∈ [55, 75] (got ${ph.score})`,
    ph.score >= 55 && ph.score <= 75,
    { score: ph.score, components: ph.components }
  );
  assert(
    `8-holding fixture → verdict ∈ {NEEDS_ATTENTION, GOOD} (got ${ph.verdict})`,
    ["NEEDS_ATTENTION", "GOOD"].includes(ph.verdict),
    ph.verdict
  );
  assert(
    "8-holding fixture → has methodologyNote",
    typeof ph.methodologyNote === "string" && ph.methodologyNote.length > 0,
    ph.methodologyNote
  );
  assert(
    "8-holding fixture → no caps triggered",
    !ph.caps,
    ph.caps
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
