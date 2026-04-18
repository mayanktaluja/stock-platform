#!/usr/bin/env node
/**
 * StarBhai Historical Backtest
 * ════════════════════════════════════════════════════════════════════════
 *
 * Validates the platform's stock-picking engine against real market data.
 *
 * Test period: Nov 2025 – Jan 2026 entry, tracked forward to Apr 2026.
 * Benchmark: Nifty 50 total return over the same window.
 *
 * Categories tested (NO intraday):
 *   1. Best Stocks to Buy Now (40% tech + 60% fund, score ≥ 60, DEEP_VALUE or QUALITY_GROWTH)
 *   2. Mid-Term Picks (midTermScore ≥ 58)
 *   3. Fundamental Picks (fundamentalScore DEEP_VALUE ≥ 72 or QUALITY_GROWTH ≥ 58)
 *
 * Usage:
 *   node scripts/backtest.mjs
 */

import YahooFinance from "yahoo-finance2";
import { analyzeStock, midTermAnalysis, longTermOutlook } from "../analysis.js";
import { scoreFundamentals, loadFundamentalsFromDisk, getFundamentals } from "../fundamentals.js";
import { getNifty100 } from "../stockList.js";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

// ════════════════════ CONFIG ════════════════════

const SCAN_DATES = [
  { label: "Nov 2025", date: "2025-11-03", historyStart: "2025-05-01", midTermExit: "2025-11-28", longExit: "2026-04-15" },
  { label: "Dec 2025", date: "2025-12-01", historyStart: "2025-06-01", midTermExit: "2025-12-26", longExit: "2026-04-15" },
  { label: "Jan 2026", date: "2026-01-02", historyStart: "2025-07-01", midTermExit: "2026-01-30", longExit: "2026-04-15" },
];

const SCANNER_TECH_WEIGHT = 0.40;
const SCANNER_FUND_WEIGHT = 0.60;
const SCANNER_MIN_SCORE = 60;
const MIDTERM_MIN_SCORE = 58;
const MAX_PICKS_PER_SCAN = 10;
const CONCURRENCY = 6;

// ════════════════════ DATA FETCHING ════════════════════

async function fetchHistorical(symbol, startDate, endDate) {
  try {
    const result = await yf.chart(symbol, {
      period1: startDate,
      period2: endDate,
      interval: "1d",
    });
    if (!result?.quotes?.length) return null;
    return result.quotes
      .filter((q) => q.close != null && q.volume != null)
      .map((q) => ({
        date: new Date(q.date),
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume,
      }));
  } catch {
    return null;
  }
}

// ════════════════════ SCANNING ENGINE ════════════════════

function buildMockQuote(historical, symbol) {
  const last = historical[historical.length - 1];
  const highs = historical.map((d) => d.high);
  const lows = historical.map((d) => d.low);
  return {
    symbol,
    regularMarketPrice: last.close,
    regularMarketDayHigh: last.high,
    regularMarketDayLow: last.low,
    regularMarketVolume: last.volume,
    regularMarketOpen: last.open,
    regularMarketPreviousClose: historical.length >= 2 ? historical[historical.length - 2].close : last.close,
    regularMarketChange: historical.length >= 2 ? last.close - historical[historical.length - 2].close : 0,
    regularMarketChangePercent: historical.length >= 2
      ? ((last.close - historical[historical.length - 2].close) / historical[historical.length - 2].close) * 100
      : 0,
    fiftyTwoWeekHigh: Math.max(...highs.slice(-252)),
    fiftyTwoWeekLow: Math.min(...lows.slice(-252)),
  };
}

function runScan(historical, symbol, fundSnap) {
  if (!historical || historical.length < 50) return null;

  const quote = buildMockQuote(historical, symbol);
  const analysis = analyzeStock(historical, quote);
  if (!analysis || analysis.score == null) return null;

  const techScore = analysis.score;

  // Mid-term
  const midTerm = midTermAnalysis(analysis, quote);

  // Fundamentals
  let fundamentalScore = null;
  let fundamentalResult = null;
  let dma200 = null;
  if (historical.length >= 200) {
    const closes = historical.map((d) => d.close);
    dma200 = closes.slice(-200).reduce((s, v) => s + v, 0) / 200;
  }
  if (fundSnap) {
    fundamentalResult = scoreFundamentals(fundSnap, dma200);
    fundamentalScore = fundamentalResult?.score ?? null;
  }

  // Combined scanner score (40/60)
  let scannerScore = null;
  if (fundamentalScore != null) {
    scannerScore = Math.round(techScore * SCANNER_TECH_WEIGHT + fundamentalScore * SCANNER_FUND_WEIGHT);
  }

  const verdict = fundamentalResult?.verdict ?? null;

  // ── Long-term structural SL + valuation target ──
  // Mirrors longTermOutlook() in analysis.js:
  //   SL  = max(200DMA, 52W low, price × 0.80)
  //   TGT = P/E re-rating to sector (if undervalued), else 52W high or growth-implied
  const price = quote.regularMarketPrice;
  const w52High = quote.fiftyTwoWeekHigh;
  const w52Low = quote.fiftyTwoWeekLow;

  let longTermSL = parseFloat((price * 0.80).toFixed(2)); // 20% floor
  if (dma200 && dma200 < price) longTermSL = Math.max(longTermSL, parseFloat(dma200.toFixed(2)));
  if (w52Low && w52Low < price) longTermSL = Math.max(longTermSL, parseFloat(w52Low.toFixed(2)));
  if (longTermSL >= price) longTermSL = parseFloat((price * 0.80).toFixed(2));

  let longTermTarget = null;
  const snap = fundamentalResult?.snapshot || {};
  const pe = snap.pe;
  const sectorPe = snap.sectorPe;
  const revGrowth = fundamentalResult?.breakdown?.revenueGrowthValue;

  if (pe && sectorPe && pe > 0 && sectorPe > 0 && pe < sectorPe && (sectorPe / pe) >= 1.10) {
    longTermTarget = parseFloat((price * Math.min(sectorPe / pe, 1.40)).toFixed(2));
  } else if (w52High && w52High > price) {
    const growthImplied = revGrowth != null ? price * (1 + revGrowth) : 0;
    longTermTarget = parseFloat(Math.max(w52High, growthImplied).toFixed(2));
  } else if (revGrowth != null && revGrowth > 0) {
    longTermTarget = parseFloat((price * (1 + revGrowth)).toFixed(2));
  } else {
    longTermTarget = parseFloat((price * 1.15).toFixed(2));
  }

  return {
    symbol,
    entryPrice: price,
    techScore,
    fundamentalScore,
    scannerScore,
    verdict,
    midTermScore: midTerm.score,
    midTermRec: midTerm.recommendation,
    midTermTarget: midTerm.target,
    midTermSL: midTerm.stopLoss,
    longTermTarget,
    longTermSL,
  };
}

// ════════════════════ TRADE TRACKING ════════════════════

function trackTrade(forwardData, entryPrice, target, stopLoss, maxExitDate) {
  // Walk forward day by day
  for (const bar of forwardData) {
    if (bar.date > maxExitDate) break;

    // Check SL first (conservative — assume worst case)
    if (stopLoss != null && bar.low <= stopLoss) {
      return { exitPrice: stopLoss, exitDate: bar.date, reason: "SL" };
    }
    // Check target
    if (target != null && bar.high >= target) {
      return { exitPrice: target, exitDate: bar.date, reason: "TARGET" };
    }
  }

  // Holding period expired — exit at last available close
  const lastBar = forwardData.filter((d) => d.date <= maxExitDate);
  if (lastBar.length > 0) {
    const exit = lastBar[lastBar.length - 1];
    return { exitPrice: exit.close, exitDate: exit.date, reason: "EXPIRY" };
  }

  return { exitPrice: entryPrice, exitDate: maxExitDate, reason: "NO_DATA" };
}

// ════════════════════ XIRR CALCULATION ════════════════════

function xirr(cashflows) {
  // cashflows: [{date: Date, amount: number}]
  // Newton's method to solve sum(cf / (1+r)^t) = 0
  if (cashflows.length < 2) return 0;

  const dayMs = 86400000;
  const d0 = cashflows[0].date;

  function npv(rate) {
    return cashflows.reduce((sum, cf) => {
      const years = (cf.date - d0) / (365.25 * dayMs);
      return sum + cf.amount / Math.pow(1 + rate, years);
    }, 0);
  }

  function dnpv(rate) {
    return cashflows.reduce((sum, cf) => {
      const years = (cf.date - d0) / (365.25 * dayMs);
      if (years === 0) return sum;
      return sum - years * cf.amount / Math.pow(1 + rate, years + 1);
    }, 0);
  }

  let rate = 0.10; // initial guess
  for (let i = 0; i < 200; i++) {
    const f = npv(rate);
    const df = dnpv(rate);
    if (Math.abs(df) < 1e-12) break;
    const newRate = rate - f / df;
    if (Math.abs(newRate - rate) < 1e-8) break;
    rate = newRate;
    if (rate < -0.99) rate = -0.99; // clamp to avoid divergence
  }

  return rate;
}

// ════════════════════ MAIN ════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║         StarBhai Historical Backtest                        ║");
  console.log("║         Nov 2025 – Jan 2026 entries → Apr 2026 exit         ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Prime fundamentals cache
  loadFundamentalsFromDisk();
  const stocks = getNifty100();
  console.log(`Universe: ${stocks.length} Nifty 100 stocks\n`);

  // ── Phase 1: Fetch all historical data ──
  console.log("Phase 1: Fetching historical data (May 2025 – Apr 2026)...");
  const allHistory = new Map();
  let fetched = 0;
  let failed = 0;

  // Worker pool
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= stocks.length) return;
      const sym = stocks[i].symbol;
      const data = await fetchHistorical(sym, "2025-05-01", "2026-04-16");
      if (data && data.length >= 50) {
        allHistory.set(sym, data);
        fetched++;
      } else {
        failed++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`  Fetched: ${fetched}/${stocks.length}, Failed: ${failed}\n`);

  // ── Phase 2: Fetch Nifty 50 benchmark ──
  console.log("Phase 2: Fetching Nifty 50 benchmark...");
  const niftyHistory = await fetchHistorical("^NSEI", "2025-10-01", "2026-04-16");
  if (!niftyHistory) {
    console.error("  FATAL: Could not fetch Nifty 50 index data");
    process.exit(1);
  }
  console.log(`  Nifty 50: ${niftyHistory.length} bars\n`);

  // ── Phase 3: Run scans at each date ──
  const allTrades = [];

  for (const scan of SCAN_DATES) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`SCAN: ${scan.label} (${scan.date})`);
    console.log("═".repeat(60));

    const scanDate = new Date(scan.date + "T00:00:00");
    const midTermExitDate = new Date(scan.midTermExit + "T23:59:59");
    const longExitDate = new Date(scan.longExit + "T23:59:59");

    const buyNowPicks = [];
    const midTermPicks = [];
    const fundPicks = [];

    for (const stock of stocks) {
      const sym = stock.symbol;
      const fullHistory = allHistory.get(sym);
      if (!fullHistory) continue;

      // Slice history up to scan date (only data available at decision time)
      const historyUpToScan = fullHistory.filter((d) => d.date <= scanDate);
      if (historyUpToScan.length < 50) continue;

      // Forward data (after scan date, for tracking exits)
      const forwardData = fullHistory.filter((d) => d.date > scanDate);

      const fundSnap = getFundamentals(sym);
      const result = runScan(historyUpToScan, sym, fundSnap);
      if (!result) continue;

      // Category 1: Best Stocks to Buy Now
      if (
        result.scannerScore != null &&
        result.scannerScore >= SCANNER_MIN_SCORE &&
        (result.verdict === "DEEP_VALUE" || result.verdict === "QUALITY_GROWTH") &&
        result.midTermRec !== "HOLD"
      ) {
        buyNowPicks.push({ ...result, category: "BuyNow", forwardData });
      }

      // Category 2: Mid-Term Picks
      if (result.midTermScore >= MIDTERM_MIN_SCORE) {
        midTermPicks.push({ ...result, category: "MidTerm", forwardData });
      }

      // Category 3: Fundamental Picks (Deep Value + Quality Growth)
      if (
        result.fundamentalScore != null &&
        (result.verdict === "DEEP_VALUE" || result.verdict === "QUALITY_GROWTH")
      ) {
        fundPicks.push({ ...result, category: "Fundamental", forwardData });
      }
    }

    // Sort and pick top N
    buyNowPicks.sort((a, b) => b.scannerScore - a.scannerScore);
    midTermPicks.sort((a, b) => b.midTermScore - a.midTermScore);
    fundPicks.sort((a, b) => b.fundamentalScore - a.fundamentalScore);

    const topBuyNow = buyNowPicks.slice(0, MAX_PICKS_PER_SCAN);
    const topMidTerm = midTermPicks.slice(0, MAX_PICKS_PER_SCAN);
    const topFund = fundPicks.slice(0, MAX_PICKS_PER_SCAN);

    // Track trades
    for (const pick of topBuyNow) {
      const exit = trackTrade(pick.forwardData, pick.entryPrice, pick.midTermTarget, pick.midTermSL, longExitDate);
      allTrades.push({
        scanDate: scan.label,
        category: "BuyNow",
        symbol: pick.symbol,
        entryDate: scanDate,
        entryPrice: pick.entryPrice,
        scannerScore: pick.scannerScore,
        verdict: pick.verdict,
        ...exit,
        returnPct: ((exit.exitPrice - pick.entryPrice) / pick.entryPrice) * 100,
      });
    }

    for (const pick of topMidTerm) {
      const exit = trackTrade(pick.forwardData, pick.entryPrice, pick.midTermTarget, pick.midTermSL, midTermExitDate);
      allTrades.push({
        scanDate: scan.label,
        category: "MidTerm",
        symbol: pick.symbol,
        entryDate: scanDate,
        entryPrice: pick.entryPrice,
        midTermScore: pick.midTermScore,
        ...exit,
        returnPct: ((exit.exitPrice - pick.entryPrice) / pick.entryPrice) * 100,
      });
    }

    for (const pick of topFund) {
      const exit = trackTrade(pick.forwardData, pick.entryPrice, pick.longTermTarget, pick.longTermSL, longExitDate);
      allTrades.push({
        scanDate: scan.label,
        category: "Fundamental",
        symbol: pick.symbol,
        entryDate: scanDate,
        entryPrice: pick.entryPrice,
        fundamentalScore: pick.fundamentalScore,
        verdict: pick.verdict,
        ...exit,
        returnPct: ((exit.exitPrice - pick.entryPrice) / pick.entryPrice) * 100,
      });
    }

    // Print picks for this scan
    console.log(`\n  Best Stocks to Buy Now (${topBuyNow.length} picks):`);
    for (const t of allTrades.filter((t) => t.scanDate === scan.label && t.category === "BuyNow")) {
      const r = t.returnPct >= 0 ? `+${t.returnPct.toFixed(1)}%` : `${t.returnPct.toFixed(1)}%`;
      console.log(`    ${t.symbol.padEnd(18)} score=${t.scannerScore} entry=₹${t.entryPrice.toFixed(0).padStart(7)} exit=₹${t.exitPrice.toFixed(0).padStart(7)} ${r.padStart(7)} [${t.reason}] ${t.verdict}`);
    }

    console.log(`\n  Mid-Term Picks (${topMidTerm.length} picks):`);
    for (const t of allTrades.filter((t) => t.scanDate === scan.label && t.category === "MidTerm")) {
      const r = t.returnPct >= 0 ? `+${t.returnPct.toFixed(1)}%` : `${t.returnPct.toFixed(1)}%`;
      console.log(`    ${t.symbol.padEnd(18)} score=${t.midTermScore} entry=₹${t.entryPrice.toFixed(0).padStart(7)} exit=₹${t.exitPrice.toFixed(0).padStart(7)} ${r.padStart(7)} [${t.reason}]`);
    }

    console.log(`\n  Fundamental Picks (${topFund.length} picks):`);
    for (const t of allTrades.filter((t) => t.scanDate === scan.label && t.category === "Fundamental")) {
      const r = t.returnPct >= 0 ? `+${t.returnPct.toFixed(1)}%` : `${t.returnPct.toFixed(1)}%`;
      console.log(`    ${t.symbol.padEnd(18)} score=${t.fundamentalScore} entry=₹${t.entryPrice.toFixed(0).padStart(7)} exit=₹${t.exitPrice.toFixed(0).padStart(7)} ${r.padStart(7)} [${t.reason}] ${t.verdict}`);
    }
  }

  // ── Phase 4: Aggregate results ──
  console.log(`\n\n${"═".repeat(60)}`);
  console.log("RESULTS SUMMARY");
  console.log("═".repeat(60));

  const categories = ["BuyNow", "MidTerm", "Fundamental"];
  for (const cat of categories) {
    const trades = allTrades.filter((t) => t.category === cat);
    if (trades.length === 0) continue;

    const wins = trades.filter((t) => t.returnPct > 0);
    const losses = trades.filter((t) => t.returnPct <= 0);
    const avgReturn = trades.reduce((s, t) => s + t.returnPct, 0) / trades.length;
    const targetHits = trades.filter((t) => t.reason === "TARGET").length;
    const slHits = trades.filter((t) => t.reason === "SL").length;
    const expiries = trades.filter((t) => t.reason === "EXPIRY").length;
    const best = trades.reduce((a, b) => (a.returnPct > b.returnPct ? a : b));
    const worst = trades.reduce((a, b) => (a.returnPct < b.returnPct ? a : b));

    console.log(`\n  ${cat.toUpperCase()} (${trades.length} trades across 3 scans)`);
    console.log(`    Win rate:    ${wins.length}/${trades.length} = ${((wins.length / trades.length) * 100).toFixed(0)}%`);
    console.log(`    Avg return:  ${avgReturn >= 0 ? "+" : ""}${avgReturn.toFixed(2)}%`);
    console.log(`    Exits:       ${targetHits} target, ${slHits} SL, ${expiries} expiry`);
    console.log(`    Best trade:  ${best.symbol} ${best.scanDate} ${best.returnPct >= 0 ? "+" : ""}${best.returnPct.toFixed(1)}%`);
    console.log(`    Worst trade: ${worst.symbol} ${worst.scanDate} ${worst.returnPct >= 0 ? "+" : ""}${worst.returnPct.toFixed(1)}%`);
  }

  // ── Phase 5: Portfolio XIRR ──
  // Equal-weight: invest ₹10,000 in each pick at entry, receive proportional amount at exit
  const INVEST_PER_TRADE = 10000;
  const cashflows = [];

  for (const t of allTrades) {
    // Outflow at entry
    cashflows.push({ date: t.entryDate, amount: -INVEST_PER_TRADE });
    // Inflow at exit
    const exitAmount = INVEST_PER_TRADE * (1 + t.returnPct / 100);
    cashflows.push({ date: t.exitDate, amount: exitAmount });
  }

  // Sort by date
  cashflows.sort((a, b) => a.date - b.date);

  let portfolioXIRR = null;
  try {
    portfolioXIRR = xirr(cashflows);
  } catch {
    portfolioXIRR = null;
  }

  // ── Phase 6: Nifty 50 benchmark ──
  // Average entry date across scans, final exit = Apr 15 2026
  const niftyScanDates = SCAN_DATES.map((s) => new Date(s.date + "T00:00:00"));
  const niftyEntries = niftyScanDates.map((d) => {
    const bar = niftyHistory.find((b) => b.date >= d);
    return bar ? bar.close : null;
  }).filter(Boolean);

  const niftyExitBar = niftyHistory[niftyHistory.length - 1];
  const niftyExitPrice = niftyExitBar?.close;

  const niftyReturns = niftyEntries.map((entry) => ((niftyExitPrice - entry) / entry) * 100);
  const avgNiftyReturn = niftyReturns.reduce((s, r) => s + r, 0) / niftyReturns.length;

  // Nifty XIRR (equal-weight at each scan date)
  const niftyCashflows = [];
  for (let i = 0; i < niftyScanDates.length; i++) {
    niftyCashflows.push({ date: niftyScanDates[i], amount: -INVEST_PER_TRADE });
    niftyCashflows.push({ date: niftyExitBar.date, amount: INVEST_PER_TRADE * (1 + niftyReturns[i] / 100) });
  }
  niftyCashflows.sort((a, b) => a.date - b.date);

  let niftyXIRR = null;
  try {
    niftyXIRR = xirr(niftyCashflows);
  } catch {
    niftyXIRR = null;
  }

  // ── Print final comparison ──
  const totalTrades = allTrades.length;
  const totalWins = allTrades.filter((t) => t.returnPct > 0).length;
  const totalAvgReturn = allTrades.reduce((s, t) => s + t.returnPct, 0) / totalTrades;

  console.log(`\n\n${"═".repeat(60)}`);
  console.log("PORTFOLIO vs NIFTY 50");
  console.log("═".repeat(60));
  console.log(`  Total trades:        ${totalTrades}`);
  console.log(`  Overall win rate:    ${totalWins}/${totalTrades} = ${((totalWins / totalTrades) * 100).toFixed(0)}%`);
  console.log(`  Avg return/trade:    ${totalAvgReturn >= 0 ? "+" : ""}${totalAvgReturn.toFixed(2)}%`);
  console.log(`  Portfolio XIRR:      ${portfolioXIRR != null ? (portfolioXIRR * 100).toFixed(2) + "%" : "N/A"}`);
  console.log(`  Nifty 50 return:     ${avgNiftyReturn >= 0 ? "+" : ""}${avgNiftyReturn.toFixed(2)}%`);
  console.log(`  Nifty 50 XIRR:       ${niftyXIRR != null ? (niftyXIRR * 100).toFixed(2) + "%" : "N/A"}`);
  if (portfolioXIRR != null && niftyXIRR != null) {
    const alpha = (portfolioXIRR - niftyXIRR) * 100;
    console.log(`  ALPHA:               ${alpha >= 0 ? "+" : ""}${alpha.toFixed(2)}pp ${alpha >= 0 ? "✓ BEATS NIFTY" : "✗ UNDERPERFORMS"}`);
  }

  console.log(`\n  Nifty 50 levels:`);
  for (let i = 0; i < niftyScanDates.length; i++) {
    console.log(`    ${SCAN_DATES[i].label}: entry ₹${niftyEntries[i]?.toFixed(0) || "?"} → exit ₹${niftyExitPrice?.toFixed(0) || "?"} (${niftyReturns[i]?.toFixed(1)}%)`);
  }

  console.log(`\n  Methodology:`);
  console.log(`    • Entry: first trading day of each month`);
  console.log(`    • Buy Now / Fundamental: hold to Apr 15 or SL/target`);
  console.log(`    • Mid-Term: hold 4 weeks or SL/target`);
  console.log(`    • Equal-weight ₹${INVEST_PER_TRADE.toLocaleString()} per trade`);
  console.log(`    • Fundamentals: Apr 2026 snapshot (approximation — ROE/margins stable QoQ)`);
  console.log(`    • No transaction costs, slippage, or macro regime modeled`);

  console.log(`\n${"═".repeat(60)}\n`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
