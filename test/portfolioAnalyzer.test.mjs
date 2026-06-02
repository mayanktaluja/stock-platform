/**
 * Regression tests for portfolioAnalyzer.js
 *
 * Covers the two public entry points consumed by the analyzer API
 * (`/api/portfolio/analyze` and `/api/portfolio/analyze/rerun` in
 * server.js):
 *
 *   • analyzeHolding(input)
 *       - ETF short-circuit path (priced-only, no scoring/exit-plan)
 *       - normal equity in profit (full report shape + tax note)
 *       - equity carrying multiple red-flag triggers
 *
 *   • buildReport(enrichedHoldings, unmatched, meta)
 *       - empty holdings + empty MF book (server.js:5577 MF-only call)
 *       - two-holding aggregation (totals, sectorAllocation, urgent
 *         actions, top winners/losers, sorted holdings, summary)
 *
 * The module under test wraps a lot of downstream services
 * (portfolioIntelligence, riskMetrics, xirrOptimizer, mfRecommendation,
 * governance, sws indian risk layer). We rely on their real
 * implementations rather than mocking — that matches how the analyzer
 * runs in production and keeps the coverage honest.
 *
 * Run with: node test/portfolioAnalyzer.test.mjs
 */

import { analyzeHolding, buildReport } from "../portfolioAnalyzer.js";
import { containsForbiddenExitPlanCopy } from "../services/exitPlan/exitPlanPolicy.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", got);
  }
}

console.log("portfolioAnalyzer.js regression\n");

// ─────────────────────────── analyzeHolding ───────────────────────────

console.log("analyzeHolding — ETF short-circuit");
{
  const etf = analyzeHolding({
    symbol: "NIFTYBEES",
    name: "Nippon India ETF Nifty 50 BeES",
    sector: "ETF",
    quantity: 100,
    avgPrice: 200,
    quote: { regularMarketPrice: 250 },
    // No analysis/fundamentals/midTerm — ETFs aren't scored
    instrumentType: "etf",
    positionWeight: 10,
    sectorWeight: 10,
  });

  assert(
    "instrumentType === 'etf'",
    etf.instrumentType === "etf",
    etf.instrumentType,
  );
  assert(
    "scored === false",
    etf.scored === false,
    etf.scored,
  );
  assert(
    "action === 'ETF'",
    etf.action === "ETF",
    etf.action,
  );
  assert(
    "scoring fields nulled (combinedScore)",
    etf.combinedScore === null,
    etf.combinedScore,
  );
  assert(
    "scoring fields nulled (recommendation)",
    etf.recommendation === null,
    etf.recommendation,
  );
  assert(
    "outlook nulled",
    etf.outlook === null,
    etf.outlook,
  );
  assert(
    "exitPlan nulled",
    etf.exitPlan === null,
    etf.exitPlan,
  );
  assert(
    "redFlags is empty array",
    Array.isArray(etf.redFlags) && etf.redFlags.length === 0,
    etf.redFlags,
  );
  // Position math still computed — ETFs roll up into portfolio totals
  assert(
    "invested = qty × avgPrice",
    etf.invested === 100 * 200,
    etf.invested,
  );
  assert(
    "currentValue = qty × price",
    etf.currentValue === 100 * 250,
    etf.currentValue,
  );
  assert(
    "pnlAmount = currentValue − invested",
    etf.pnlAmount === 100 * 250 - 100 * 200,
    etf.pnlAmount,
  );
  assert(
    "pnlPercent = pnl/invested × 100",
    etf.pnlPercent === 25,
    etf.pnlPercent,
  );
  // Tax note still computed for an ETF gain (no purchase date → generic gain note)
  assert(
    "taxNote present for ETF in gain",
    etf.taxNote != null && typeof etf.taxNote.summary === "string",
    etf.taxNote,
  );
}

console.log("\nanalyzeHolding — equity in profit (long-term)");
{
  // ~400 days = long-term holding for LTCG.
  const purchaseDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
  const eq = analyzeHolding({
    symbol: "TCS",
    name: "Tata Consultancy Services",
    sector: "IT Services",
    quantity: 50,
    avgPrice: 3000,
    quote: {
      regularMarketPrice: 4000,
      fiftyTwoWeekHigh: 4200,
      fiftyTwoWeekLow: 3500,
    },
    analysis: {
      score: 65,
      recommendation: "BUY",
      indicators: { trend: { strength: "moderate_bullish" } },
    },
    fundamentals: {
      score: 70,
      verdict: "QUALITY_GROWTH",
      snapshot: { roe: 0.35, debtToEquity: 0.1, profitMargin: 0.2, revenueGrowth: 0.1 },
    },
    midTerm: {
      score: 60,
      stopLoss: 3700,
      target: 4500,
      volatilityPct: 1.5,
    },
    longTerm: {
      score: 72,
      target: 4500,
      valuationBasis: "long-term reference",
    },
    macroInfo: { delta: 1, impact: 0, severity: 0 },
    positionWeight: 8,
    sectorWeight: 15,
    purchaseDate,
    historical: [],
    benchReturns: [],
    instrumentType: "equity",
  });

  assert(
    "instrumentType === 'equity'",
    eq.instrumentType === "equity",
    eq.instrumentType,
  );
  assert(
    "scored === true",
    eq.scored === true,
    eq.scored,
  );
  assert(
    "sector canonicalised (IT Services)",
    eq.sector === "IT Services",
    eq.sector,
  );
  assert(
    "combinedScore is numeric",
    Number.isFinite(eq.combinedScore),
    eq.combinedScore,
  );
  // computeAction always returns a non-empty action string for a scored holding
  assert(
    "action is non-empty string",
    typeof eq.action === "string" && eq.action.length > 0,
    eq.action,
  );
  // Exit plan should carry the ATR-derived levels from midTerm
  assert(
    "exitPlan.supportLevel pulled from midTerm.stopLoss",
    eq.exitPlan && eq.exitPlan.supportLevel === 3700,
    eq.exitPlan && eq.exitPlan.supportLevel,
  );
  assert(
    "exitPlan.upsideBand pulled from midTerm.target",
    eq.exitPlan && eq.exitPlan.upsideBand === 4500,
    eq.exitPlan && eq.exitPlan.upsideBand,
  );
  assert(
    "exitPlan.atrPct populated",
    eq.exitPlan && eq.exitPlan.atrPct === 1.5,
    eq.exitPlan && eq.exitPlan.atrPct,
  );
  assert(
    "exitPlan carries analytical-reference label",
    eq.exitPlan && /analytical reference/i.test(eq.exitPlan.displayLabel),
    eq.exitPlan && eq.exitPlan.displayLabel,
  );
  assert(
    "exitPlan has no imperative/hype copy",
    eq.exitPlan && !containsForbiddenExitPlanCopy(eq.exitPlan),
    eq.exitPlan,
  );
  // Tax note recognises >365 day holding → long-term
  assert(
    "taxNote flags long-term holding",
    eq.taxNote && /long-term/i.test(eq.taxNote.summary),
    eq.taxNote && eq.taxNote.summary,
  );
  // Outlook block — three horizons
  assert(
    "outlook has three horizons",
    eq.outlook
      && eq.outlook.shortTerm
      && eq.outlook.midTerm
      && eq.outlook.longTerm,
    eq.outlook,
  );
  // Long-term direction should be "up" with score=72
  assert(
    "outlook.longTerm.direction === 'up' (score 72)",
    eq.outlook.longTerm.direction === "up",
    eq.outlook.longTerm.direction,
  );
}

console.log("\nanalyzeHolding — red-flag triggers (high D/E, neg margin, oversized position)");
{
  const eq = analyzeHolding({
    symbol: "BADCO",
    name: "Bad Company Ltd",
    sector: "NBFC",
    quantity: 1000,
    avgPrice: 100,
    quote: {
      regularMarketPrice: 50, // 50% drawdown
      fiftyTwoWeekHigh: 200,
      fiftyTwoWeekLow: 45,
    },
    analysis: {
      score: 20,
      indicators: { trend: { strength: "strong_bearish" } },
    },
    fundamentals: {
      score: 25,
      verdict: "OVERVALUED",
      snapshot: {
        debtToEquity: 3.5,        // > 2 → high-severity flag
        roe: 0.04,                // < 0.10 → medium-severity flag
        profitMargin: -0.05,      // < 0 → high-severity flag
        revenueGrowth: -0.12,     // < 0 → medium-severity flag
      },
    },
    midTerm: { slConfirmed: true },
    macroInfo: { delta: -1, impact: 0, severity: 0 },
    positionWeight: 25,            // > 15 → medium-severity position flag
    sectorWeight: 30,
    earningsNearby: { date: "2026-05-20" },  // event-day flag
    historical: [],
    benchReturns: [],
    instrumentType: "equity",
  });

  const flagsByCategory = {};
  for (const f of eq.redFlags) {
    flagsByCategory[f.category] = (flagsByCategory[f.category] || 0) + 1;
  }
  assert(
    "high-D/E flag fired (fundamentals)",
    eq.redFlags.some((f) => f.category === "fundamentals" && /Debt\/Equity/.test(f.message)),
    eq.redFlags.map((f) => f.message),
  );
  assert(
    "negative-profit-margin flag fired",
    eq.redFlags.some((f) => f.category === "fundamentals" && /negative/.test(f.message)),
    eq.redFlags.map((f) => f.message),
  );
  assert(
    "strong-bearish trend flag fired (technical)",
    eq.redFlags.some((f) => f.category === "technical" && /strongly bearish/.test(f.message)),
    eq.redFlags.map((f) => f.message),
  );
  assert(
    "position-weight flag fired (>15%)",
    eq.redFlags.some((f) => f.category === "position"),
    eq.redFlags.map((f) => f.message),
  );
  assert(
    "earnings-nearby flag fired (event)",
    eq.redFlags.some((f) => f.category === "event"),
    eq.redFlags.map((f) => f.message),
  );
  assert(
    "slConfirmed flag fired (exit-trigger)",
    eq.redFlags.some((f) => f.category === "exit-trigger"),
    eq.redFlags.map((f) => f.message),
  );
  // Position is in loss → tax note short-form summary
  assert(
    "taxNote summary marks position as in loss",
    eq.taxNote && /loss/i.test(eq.taxNote.summary),
    eq.taxNote && eq.taxNote.summary,
  );
}

// ─────────────────────────── buildReport ───────────────────────────

console.log("\nbuildReport — empty holdings + empty MF (server.js MF-only call)");
{
  const report = buildReport([], [], {
    source: "groww-csv",
    parseSummary: { rows: 0 },
    warnings: ["mf-enrich-failed"],
  });

  assert(
    "summary.holdingsCount === 0",
    report.summary.holdingsCount === 0,
    report.summary.holdingsCount,
  );
  assert(
    "summary.totalInvested === 0",
    report.summary.totalInvested === 0,
    report.summary.totalInvested,
  );
  assert(
    "summary.totalCurrent === 0",
    report.summary.totalCurrent === 0,
    report.summary.totalCurrent,
  );
  assert(
    "summary.totalPnLPct === 0 (guarded division-by-zero)",
    report.summary.totalPnLPct === 0,
    report.summary.totalPnLPct,
  );
  assert(
    "holdings array empty",
    Array.isArray(report.holdings) && report.holdings.length === 0,
    report.holdings,
  );
  assert(
    "sectorAllocation empty",
    Array.isArray(report.sectorAllocation) && report.sectorAllocation.length === 0,
    report.sectorAllocation,
  );
  assert(
    "urgentActions empty",
    Array.isArray(report.urgentActions) && report.urgentActions.length === 0,
    report.urgentActions,
  );
  assert(
    "stressTests empty (no equity holdings)",
    Array.isArray(report.stressTests) && report.stressTests.length === 0,
    report.stressTests,
  );
  assert(
    "risk block is null (zero total value)",
    report.risk === null,
    report.risk,
  );
  assert(
    "warnings forwarded from meta",
    Array.isArray(report.warnings)
      && report.warnings.length === 1
      && report.warnings[0] === "mf-enrich-failed",
    report.warnings,
  );
  // Disclaimer is the SEBI sticky-footer canonical sentence
  assert(
    "disclaimer present (SEBI canonical)",
    typeof report.disclaimer === "string"
      && /not a SEBI-registered/i.test(report.disclaimer),
    report.disclaimer,
  );
}

console.log("\nbuildReport — two-holding aggregation");
{
  // Two synthetic enriched holdings — minimum fields needed by the
  // aggregator. They use disjoint sectors so sectorAllocation will
  // show two distinct buckets at 100% combined.
  const holdingA = {
    symbol: "TCS",
    name: "Tata Consultancy Services",
    sector: "IT Services",
    quantity: 50,
    avgPrice: 3000,
    currentPrice: 4000,
    invested: 150000,
    currentValue: 200000,
    pnlAmount: 50000,
    pnlPercent: 33.33,
    positionWeight: 66.67,
    combinedScore: 75,
    fundamentalVerdict: "QUALITY_GROWTH",
    action: "HOLD",
    displayAction: "Hold",
    actionUrgency: "none",
    risk: { beta: 0.9 },
    _stockReturns: [],
  };
  const holdingB = {
    symbol: "BADCO",
    name: "Bad Company",
    sector: "NBFC",
    quantity: 1000,
    avgPrice: 100,
    currentPrice: 50,
    invested: 100000,
    currentValue: 50000,
    pnlAmount: -50000,
    pnlPercent: -50,
    positionWeight: 33.33,
    combinedScore: 25,
    fundamentalVerdict: "OVERVALUED",
    action: "CUT_LOSS",
    displayAction: "Cut Loss",
    actionUrgency: "high",
    risk: { beta: 1.5 },
    _stockReturns: [],
  };

  const report = buildReport(
    [holdingA, holdingB],
    [{ row: 3, reason: "unresolved-symbol" }],
    {
      source: "groww-csv",
      regime: { tilt: "neutral" },
      benchSymbol: "^NSEI",
      benchReturns: [],
      asOfDate: "2026-05-18",
      warnings: [],
    },
  );

  // ── Summary totals ──
  assert(
    "summary.holdingsCount === 2",
    report.summary.holdingsCount === 2,
    report.summary.holdingsCount,
  );
  assert(
    "summary.unmatchedCount === 1",
    report.summary.unmatchedCount === 1,
    report.summary.unmatchedCount,
  );
  assert(
    "summary.totalInvested === 250000",
    report.summary.totalInvested === 250000,
    report.summary.totalInvested,
  );
  assert(
    "summary.totalCurrent === 250000",
    report.summary.totalCurrent === 250000,
    report.summary.totalCurrent,
  );
  assert(
    "summary.totalPnL === 0 (50k gain − 50k loss)",
    report.summary.totalPnL === 0,
    report.summary.totalPnL,
  );

  // ── Sorted holdings (by currentValue desc) ──
  assert(
    "holdings sorted desc by currentValue (TCS first)",
    report.holdings[0].symbol === "TCS" && report.holdings[1].symbol === "BADCO",
    report.holdings.map((h) => h.symbol),
  );
  // Internal _stockReturns stripped from wire payload
  assert(
    "_stockReturns stripped from wire payload",
    report.holdings.every((h) => !("_stockReturns" in h)),
    Object.keys(report.holdings[0]),
  );

  // ── Sector allocation ──
  assert(
    "sectorAllocation has two buckets",
    report.sectorAllocation.length === 2,
    report.sectorAllocation,
  );
  assert(
    "sectors sum to 100%",
    Math.abs(report.sectorAllocation.reduce((s, x) => s + x.pct, 0) - 100) < 0.01,
    report.sectorAllocation.map((s) => s.pct),
  );
  // Top sector should be IT Services (200k of 250k)
  assert(
    "top sector = IT Services (largest)",
    report.sectorAllocation[0].sector === "IT Services",
    report.sectorAllocation[0],
  );

  // ── Urgent actions ──
  assert(
    "urgentActions contains the CUT_LOSS holding",
    report.urgentActions.length === 1
      && report.urgentActions[0].symbol === "BADCO",
    report.urgentActions.map((u) => u.symbol),
  );

  // ── Verdict mix ──
  assert(
    "verdictMix.counts.QUALITY_GROWTH === 1",
    report.verdictMix.counts.QUALITY_GROWTH === 1,
    report.verdictMix.counts,
  );
  assert(
    "verdictMix.counts.OVERVALUED === 1",
    report.verdictMix.counts.OVERVALUED === 1,
    report.verdictMix.counts,
  );

  // ── Top winners / losers ──
  assert(
    "topWinners[0] === TCS (biggest gain)",
    report.topWinners[0] && report.topWinners[0].symbol === "TCS",
    report.topWinners.map((h) => h.symbol),
  );
  assert(
    "topLosers[0] === BADCO (biggest loss)",
    report.topLosers[0] && report.topLosers[0].symbol === "BADCO",
    report.topLosers.map((h) => h.symbol),
  );

  // ── Stress tests — three scenarios at -10/-20/-30% Nifty ──
  assert(
    "stressTests has 3 scenarios",
    report.stressTests.length === 3,
    report.stressTests.length,
  );
  assert(
    "stress scenarios tagged correctly",
    report.stressTests.map((t) => t.tag).join(",") === "nifty_minus_10,nifty_minus_20,nifty_minus_30",
    report.stressTests.map((t) => t.tag),
  );

  // ── Currency exposure (TCS in IT Services → USD-earning hedge) ──
  assert(
    "currencyExposure.usdEarningPct > 0 (TCS is IT Services)",
    report.currencyExposure && report.currencyExposure.usdEarningPct > 0,
    report.currencyExposure,
  );

  // ── Metadata ──
  assert(
    "asOfDate preserved",
    report.asOfDate === "2026-05-18",
    report.asOfDate,
  );
  assert(
    "benchmark forwarded from meta",
    report.benchmark === "^NSEI",
    report.benchmark,
  );
  assert(
    "exitPlanSummary present even when synthetic holdings lack plans",
    report.exitPlanSummary && report.exitPlanSummary.schema_version === "exit-plan-summary-v1",
    report.exitPlanSummary,
  );
}

// ──────────────────────────── Summary ────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
