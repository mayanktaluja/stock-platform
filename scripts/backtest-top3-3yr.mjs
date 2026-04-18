#!/usr/bin/env node
/**
 * TOP 3 PICKS ONLY -- 3-Year Paper Trading Simulation
 * =====================================================
 *
 * Same as all-categories but picks ONLY the TOP 3 highest-scoring stocks
 * per category per month. Tests if concentrating on the best signals
 * produces better returns than diversifying across 10 picks.
 *
 * Categories:
 *   1. Deep Value Picks        (fundScore >= 72, verdict = DEEP_VALUE)
 *   2. Quality Growth Picks    (fundScore 58-71, verdict = QUALITY_GROWTH)
 *   3. Best Stocks to Buy Now  (combined tech+fund >= 65, dual-lane)
 *   4. Intraday Trading Picks  (intradayScore >= 50, 1-day hold)
 *   5. Mid-Term Investment     (midTermScore >= 58, 4-week hold)
 *
 * 36 monthly scans: Apr 2023 - Mar 2026
 * History: Apr 2022 - Apr 2026 (12 months warmup)
 *
 * Usage: node scripts/backtest-all-categories-3yr.mjs
 */

import { fileURLToPath } from "url";
import path from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import YahooFinance from "yahoo-finance2";
import { analyzeStock, midTermAnalysis, longTermOutlook } from "../analysis.js";
import { scoreFundamentals, loadFundamentalsFromDisk, getFundamentals } from "../fundamentals.js";
import { getNifty100 } from "../stockList.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORT_DIR = path.join(__dirname, "..", "reports");
const REPORT_PATH = path.join(REPORT_DIR, "top3-picks-3yr-report.md");

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// ==================== CONFIGURATION ====================

const HISTORY_START = "2022-04-01";
const HISTORY_END   = "2026-04-16";
const NIFTY_SYMBOL  = "^NSEI";
const CONCURRENCY   = 6;
const STARTING_CAPITAL = 200000; // Rs 2,00,000 per category

// Excluded sectors for "Best Stocks to Buy Now"
const BUY_NOW_EXCLUDED_SECTORS = new Set(["Banking", "Tourism", "Cement", "Chemicals"]);

// ==================== SCAN DATE GENERATOR ====================

function generateScanDates() {
  const dates = [];
  const firstDays = { 0:3, 1:2, 2:2, 3:4, 4:3, 5:2, 6:1, 7:1, 8:1, 9:1, 10:3, 11:1 };
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // Apr 2023 through Mar 2026 = 36 months
  for (let y = 2023; y <= 2026; y++) {
    const sm = (y === 2023) ? 3 : 0;   // Apr 2023 start
    const em = (y === 2026) ? 2 : 11;  // Mar 2026 end
    for (let m = sm; m <= em; m++) {
      const day = firstDays[m];
      dates.push({
        label: `${monthNames[m]} ${y}`,
        date: `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        monthIndex: dates.length,
      });
    }
  }
  return dates;
}

const SCAN_DATES = generateScanDates();

// ==================== HELPER FUNCTIONS ====================

function toDateStr(d) {
  if (typeof d === "string") return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function addTradingDays(dateStr, days) {
  let d = new Date(dateStr);
  let count = 0;
  while (count < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return toDateStr(d);
}

function addCalendarMonths(dateStr, months) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return toDateStr(d);
}

function fmtLakh(amount) {
  const lakhs = amount / 100000;
  if (lakhs >= 100) return (lakhs / 100).toFixed(2) + " Cr";
  return lakhs.toFixed(2) + "L";
}

function fmtPct(val) {
  return (val >= 0 ? "+" : "") + val.toFixed(2) + "%";
}

function fmtRupee(val) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(val);
}

// ==================== XIRR (Newton's method) ====================

function xirr(cashflows) {
  if (!cashflows || cashflows.length < 2) return 0;
  const hasPositive = cashflows.some(cf => cf.amount > 0);
  const hasNegative = cashflows.some(cf => cf.amount < 0);
  if (!hasPositive || !hasNegative) return 0;

  function npv(rate) {
    let result = 0;
    const d0 = cashflows[0].date.getTime();
    for (const cf of cashflows) {
      const years = (cf.date.getTime() - d0) / (365.25 * 864e5);
      result += cf.amount / Math.pow(1 + rate, years);
    }
    return result;
  }

  function npvDeriv(rate) {
    let result = 0;
    const d0 = cashflows[0].date.getTime();
    for (const cf of cashflows) {
      const years = (cf.date.getTime() - d0) / (365.25 * 864e5);
      if (years === 0) continue;
      result -= years * cf.amount / Math.pow(1 + rate, years + 1);
    }
    return result;
  }

  let rate = 0.1;
  for (let i = 0; i < 200; i++) {
    const f = npv(rate);
    const df = npvDeriv(rate);
    if (Math.abs(df) < 1e-12) break;
    const newRate = rate - f / df;
    if (Math.abs(newRate - rate) < 1e-9) { rate = newRate; break; }
    rate = Math.max(-0.99, Math.min(10, newRate));
  }
  return isFinite(rate) ? rate : 0;
}

// ==================== DATA FETCHING ====================

async function fetchAll(symbols) {
  const data = new Map();
  let cursor = 0, ok = 0, fail = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= symbols.length) return;
      try {
        const res = await yf.chart(symbols[i], {
          period1: HISTORY_START,
          period2: HISTORY_END,
          interval: "1d",
        });
        const bars = (res?.quotes || [])
          .filter(q => q.close != null && q.open != null && q.high != null && q.low != null)
          .map(q => ({
            date: new Date(q.date), open: q.open, high: q.high,
            low: q.low, close: q.close, volume: q.volume || 0,
          }));
        if (bars.length >= 50) { data.set(symbols[i], bars); ok++; }
        else fail++;
      } catch { fail++; }
      if ((ok + fail) % 15 === 0 || (ok + fail) === symbols.length) {
        console.log(`  Fetched ${ok + fail}/${symbols.length} (${ok} OK, ${fail} failed)`);
      }
    }
  }

  console.log(`\nFetching ${symbols.length} symbols with concurrency ${CONCURRENCY}...`);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`  Done: ${ok} OK, ${fail} failed\n`);
  return data;
}

// ==================== MOCK QUOTE BUILDER ====================

function buildMockQuote(barsUpTo, symbol) {
  if (!barsUpTo || barsUpTo.length < 2) return null;
  const last = barsUpTo[barsUpTo.length - 1];
  const prev = barsUpTo[barsUpTo.length - 2];
  const slice252 = barsUpTo.slice(-252);
  return {
    symbol,
    regularMarketPrice: last.close,
    regularMarketPreviousClose: prev.close,
    regularMarketDayHigh: last.high,
    regularMarketDayLow: last.low,
    regularMarketVolume: last.volume,
    regularMarketOpen: last.open,
    fiftyTwoWeekHigh: Math.max(...slice252.map(d => d.high)),
    fiftyTwoWeekLow: Math.min(...slice252.map(d => d.low)),
  };
}

// ==================== SLICE HELPERS ====================

function sliceUpTo(bars, dateStr) {
  const target = new Date(dateStr);
  target.setHours(23, 59, 59, 999);
  return bars.filter(b => b.date <= target);
}

function sliceAfter(bars, dateStr) {
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return bars.filter(b => b.date > target);
}

function computeDMA200(bars) {
  if (!bars || bars.length < 200) return null;
  const closes = bars.slice(-200).map(b => b.close);
  return closes.reduce((s, v) => s + v, 0) / 200;
}

// ==================== TRADE TRACKING ====================

/**
 * Standard trade tracker with 2-close SL confirmation + trailing stop.
 * Used by Deep Value, Quality Growth, Best Buy Now, and Mid-Term.
 */
function trackTrade(forwardBars, entryPrice, target, stopLoss, maxExitDateStr) {
  const maxDate = new Date(maxExitDateStr);
  maxDate.setHours(23, 59, 59);
  let slCloseCount = 0;
  let highestClose = entryPrice;
  const atrEst = stopLoss ? (entryPrice - stopLoss) / 4 : 0;
  const trailDist = atrEst * 3;

  for (const bar of forwardBars) {
    if (bar.date > maxDate) break;
    if (bar.close > highestClose) highestClose = bar.close;
    const trailingLevel = highestClose - trailDist;
    const effectiveSL = stopLoss ? Math.max(stopLoss, trailingLevel) : null;

    // 2-close SL confirmation
    if (effectiveSL && bar.close < effectiveSL) {
      slCloseCount++;
      if (slCloseCount >= 2) {
        return { exitPrice: bar.close, exitDate: toDateStr(bar.date), reason: "SL_CONFIRMED", peakPrice: highestClose };
      }
    } else {
      slCloseCount = 0;
    }

    // Trailing stop trigger (when trailing level has moved above initial SL)
    if (trailDist > 0 && stopLoss && trailingLevel > stopLoss && bar.close < trailingLevel) {
      return { exitPrice: bar.close, exitDate: toDateStr(bar.date), reason: "TRAILING", peakPrice: highestClose };
    }

    // Target hit
    if (target && bar.high >= target) {
      return { exitPrice: target, exitDate: toDateStr(bar.date), reason: "TARGET", peakPrice: highestClose };
    }
  }

  // Time exit
  const validBars = forwardBars.filter(b => b.date <= maxDate);
  if (validBars.length > 0) {
    const last = validBars[validBars.length - 1];
    return { exitPrice: last.close, exitDate: toDateStr(last.date), reason: "EXPIRY", peakPrice: highestClose };
  }
  return { exitPrice: entryPrice, exitDate: maxExitDateStr, reason: "NO_DATA", peakPrice: highestClose };
}

/**
 * Intraday trade tracker: enter at scan date close, exit next trading day.
 */
function trackIntradayTrade(forwardBars, entryPrice, target, stopLoss) {
  const nextBar = forwardBars[0];
  if (!nextBar) return { exitPrice: entryPrice, exitDate: null, reason: "NO_DATA" };

  // Check if SL hit during the day (conservative: check SL before target)
  if (stopLoss && nextBar.low <= stopLoss) {
    return { exitPrice: stopLoss, exitDate: toDateStr(nextBar.date), reason: "SL" };
  }
  if (target && nextBar.high >= target) {
    return { exitPrice: target, exitDate: toDateStr(nextBar.date), reason: "TARGET" };
  }
  return { exitPrice: nextBar.close, exitDate: toDateStr(nextBar.date), reason: "DAY_CLOSE" };
}

// ==================== CATEGORY SCANNERS ====================

/**
 * Category 1: Deep Value Picks
 * verdict = DEEP_VALUE (fundScore >= 72), structural SL, valuation target, hold max 3mo
 */
function scanDeepValue(stocks, histories, scanDateStr) {
  const candidates = [];

  for (const stock of stocks) {
    const fullBars = histories.get(stock.symbol);
    if (!fullBars) continue;
    const barsUpTo = sliceUpTo(fullBars, scanDateStr);
    if (barsUpTo.length < 50) continue;

    const quote = buildMockQuote(barsUpTo, stock.symbol);
    if (!quote) continue;

    const dma200 = computeDMA200(barsUpTo);
    const snap = getFundamentals(stock.symbol);
    if (!snap) continue;
    const fundResult = scoreFundamentals(snap, dma200);
    if (!fundResult || fundResult.verdict !== "DEEP_VALUE") continue;

    const entryPrice = quote.regularMarketPrice;
    const w52High = quote.fiftyTwoWeekHigh;
    const w52Low  = quote.fiftyTwoWeekLow;

    // Structural SL: max(200DMA, 52W_low, price * 0.80)
    let structuralSL = entryPrice * 0.80;
    if (dma200 && dma200 < entryPrice) structuralSL = Math.max(structuralSL, dma200);
    if (w52Low && w52Low < entryPrice)  structuralSL = Math.max(structuralSL, w52Low);
    if (structuralSL >= entryPrice) structuralSL = entryPrice * 0.80;

    // Valuation target
    const pe = snap?.pe ?? null;
    const sectorPe = fundResult.breakdown?.sectorPeUsed ?? snap?.sectorPe ?? null;
    const revGrowth = fundResult.breakdown?.revenueGrowthValue ?? null;
    const meaningfulDiscount = pe && sectorPe && pe > 0 && sectorPe > 0
      && pe < sectorPe && (sectorPe / pe) >= 1.10;

    let valuationTarget;
    if (meaningfulDiscount) {
      valuationTarget = entryPrice * Math.min(sectorPe / pe, 1.40);
    } else if (w52High && w52High > entryPrice) {
      const growthImplied = revGrowth != null && revGrowth > 0 ? entryPrice * (1 + revGrowth) : 0;
      valuationTarget = Math.max(w52High, growthImplied);
    } else if (revGrowth != null && revGrowth > 0) {
      valuationTarget = entryPrice * (1 + revGrowth);
    } else {
      valuationTarget = entryPrice * 1.15;
    }

    candidates.push({
      symbol: stock.symbol, name: stock.name, sector: stock.sector,
      entryPrice, fundScore: fundResult.score, fundVerdict: fundResult.verdict,
      stopLoss: structuralSL, target: valuationTarget,
      maxExitDate: addCalendarMonths(scanDateStr, 3),
      forwardBars: sliceAfter(fullBars, scanDateStr),
    });
  }

  candidates.sort((a, b) => b.fundScore - a.fundScore);
  return candidates.slice(0, 3);
}

/**
 * Category 2: Quality Growth Picks
 * verdict = QUALITY_GROWTH (fundScore 58-71), structural SL, valuation target, hold max 3mo
 */
function scanQualityGrowth(stocks, histories, scanDateStr) {
  const candidates = [];

  for (const stock of stocks) {
    const fullBars = histories.get(stock.symbol);
    if (!fullBars) continue;
    const barsUpTo = sliceUpTo(fullBars, scanDateStr);
    if (barsUpTo.length < 50) continue;

    const quote = buildMockQuote(barsUpTo, stock.symbol);
    if (!quote) continue;

    const dma200 = computeDMA200(barsUpTo);
    const snap = getFundamentals(stock.symbol);
    if (!snap) continue;
    const fundResult = scoreFundamentals(snap, dma200);
    if (!fundResult || fundResult.verdict !== "QUALITY_GROWTH") continue;

    const entryPrice = quote.regularMarketPrice;
    const w52High = quote.fiftyTwoWeekHigh;
    const w52Low  = quote.fiftyTwoWeekLow;

    // Structural SL: same as Deep Value
    let structuralSL = entryPrice * 0.80;
    if (dma200 && dma200 < entryPrice) structuralSL = Math.max(structuralSL, dma200);
    if (w52Low && w52Low < entryPrice)  structuralSL = Math.max(structuralSL, w52Low);
    if (structuralSL >= entryPrice) structuralSL = entryPrice * 0.80;

    // Valuation target: same logic
    const pe = snap?.pe ?? null;
    const sectorPe = fundResult.breakdown?.sectorPeUsed ?? snap?.sectorPe ?? null;
    const revGrowth = fundResult.breakdown?.revenueGrowthValue ?? null;
    const meaningfulDiscount = pe && sectorPe && pe > 0 && sectorPe > 0
      && pe < sectorPe && (sectorPe / pe) >= 1.10;

    let valuationTarget;
    if (meaningfulDiscount) {
      valuationTarget = entryPrice * Math.min(sectorPe / pe, 1.40);
    } else if (w52High && w52High > entryPrice) {
      const growthImplied = revGrowth != null && revGrowth > 0 ? entryPrice * (1 + revGrowth) : 0;
      valuationTarget = Math.max(w52High, growthImplied);
    } else if (revGrowth != null && revGrowth > 0) {
      valuationTarget = entryPrice * (1 + revGrowth);
    } else {
      valuationTarget = entryPrice * 1.15;
    }

    candidates.push({
      symbol: stock.symbol, name: stock.name, sector: stock.sector,
      entryPrice, fundScore: fundResult.score, fundVerdict: fundResult.verdict,
      stopLoss: structuralSL, target: valuationTarget,
      maxExitDate: addCalendarMonths(scanDateStr, 3),
      forwardBars: sliceAfter(fullBars, scanDateStr),
    });
  }

  candidates.sort((a, b) => b.fundScore - a.fundScore);
  return candidates.slice(0, 3);
}

/**
 * Category 3: Best Stocks to Buy Now
 * Combined = tech*0.50 + fund*0.50 >= 65, only DV/QG, excluded sectors,
 * QG gets +5 sort bonus, dual-lane: 6 QG + 4 DV, ATR SL/target, 3mo hold
 */
function scanBuyNow(stocks, histories, scanDateStr) {
  const candidates = [];

  for (const stock of stocks) {
    if (BUY_NOW_EXCLUDED_SECTORS.has(stock.sector)) continue;

    const fullBars = histories.get(stock.symbol);
    if (!fullBars) continue;
    const barsUpTo = sliceUpTo(fullBars, scanDateStr);
    if (barsUpTo.length < 50) continue;

    const quote = buildMockQuote(barsUpTo, stock.symbol);
    if (!quote) continue;

    const analysis = analyzeStock(barsUpTo, quote);
    if (analysis.error) continue;

    const dma200 = computeDMA200(barsUpTo);
    const snap = getFundamentals(stock.symbol);
    if (!snap) continue;
    const fundResult = scoreFundamentals(snap, dma200);
    if (!fundResult) continue;
    if (fundResult.verdict !== "DEEP_VALUE" && fundResult.verdict !== "QUALITY_GROWTH") continue;

    const techScore = analysis.score;
    const fundScore = fundResult.score;
    const combined = techScore * 0.50 + fundScore * 0.50;
    if (combined < 65) continue;

    const entryPrice = quote.regularMarketPrice;
    const atr = analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null;
    const sl = atr ? entryPrice - atr * 4 : entryPrice * 0.85;
    const tgt = atr ? entryPrice + atr * 5 : entryPrice * 1.15;

    // QG gets +5 sort bonus
    const sortScore = combined + (fundResult.verdict === "QUALITY_GROWTH" ? 5 : 0);

    candidates.push({
      symbol: stock.symbol, name: stock.name, sector: stock.sector,
      entryPrice, techScore, fundScore, combinedScore: combined,
      fundVerdict: fundResult.verdict, sortScore,
      stopLoss: sl, target: tgt,
      maxExitDate: addCalendarMonths(scanDateStr, 3),
      forwardBars: sliceAfter(fullBars, scanDateStr),
    });
  }

  // Dual-lane: 6 QG slots + 4 DV slots
  const qgCandidates = candidates.filter(c => c.fundVerdict === "QUALITY_GROWTH").sort((a, b) => b.sortScore - a.sortScore);
  const dvCandidates = candidates.filter(c => c.fundVerdict === "DEEP_VALUE").sort((a, b) => b.sortScore - a.sortScore);

  const picked = [];
  const pickedSymbols = new Set();

  // Fill QG lane (up to 6)
  for (const c of qgCandidates) {
    if (picked.length >= 6) break;
    if (pickedSymbols.has(c.symbol)) continue;
    picked.push(c);
    pickedSymbols.add(c.symbol);
  }

  // Fill DV lane (up to 4)
  for (const c of dvCandidates) {
    if (picked.length >= 10) break;
    if (pickedSymbols.has(c.symbol)) continue;
    picked.push(c);
    pickedSymbols.add(c.symbol);
  }

  // If either lane didn't fill, top up from the other
  if (picked.length < 10) {
    const remaining = candidates
      .filter(c => !pickedSymbols.has(c.symbol))
      .sort((a, b) => b.sortScore - a.sortScore);
    for (const c of remaining) {
      if (picked.length >= 10) break;
      picked.push(c);
      pickedSymbols.add(c.symbol);
    }
  }

  return picked;
}

/**
 * Category 4: Intraday Trading Picks
 * intradayScore >= 50, direction from techScore, ATR SL/target, 1-day hold
 */
function scanIntraday(stocks, histories, scanDateStr) {
  const candidates = [];

  for (const stock of stocks) {
    const fullBars = histories.get(stock.symbol);
    if (!fullBars) continue;
    const barsUpTo = sliceUpTo(fullBars, scanDateStr);
    if (barsUpTo.length < 50) continue;

    const quote = buildMockQuote(barsUpTo, stock.symbol);
    if (!quote) continue;

    const analysis = analyzeStock(barsUpTo, quote);
    if (analysis.error) continue;
    if (analysis.intradayScore < 50) continue;

    const techScore = analysis.score;
    let direction;
    if (techScore >= 55) direction = "LONG";
    else if (techScore <= 45) direction = "SHORT";
    else continue; // SKIP

    const entryPrice = quote.regularMarketPrice;
    const atr = analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null;
    if (!atr) continue;

    let sl, tgt;
    if (direction === "LONG") {
      sl  = entryPrice - atr * 1.5;
      tgt = entryPrice + atr * 2;
    } else {
      sl  = entryPrice + atr * 1.5;
      tgt = entryPrice - atr * 2;
    }

    candidates.push({
      symbol: stock.symbol, name: stock.name, sector: stock.sector,
      entryPrice, techScore, intradayScore: analysis.intradayScore,
      direction, stopLoss: sl, target: tgt,
      forwardBars: sliceAfter(fullBars, scanDateStr),
    });
  }

  candidates.sort((a, b) => b.intradayScore - a.intradayScore);
  return candidates.slice(0, 3);
}

/**
 * Category 5: Mid-Term Investment Picks
 * midTermScore >= 58, ATR x4 SL / ATR x5 target, trailing stop (ATR x3),
 * 2-close SL confirmation, hold max 20 trading days
 */
function scanMidTerm(stocks, histories, scanDateStr) {
  const candidates = [];

  for (const stock of stocks) {
    const fullBars = histories.get(stock.symbol);
    if (!fullBars) continue;
    const barsUpTo = sliceUpTo(fullBars, scanDateStr);
    if (barsUpTo.length < 50) continue;

    const quote = buildMockQuote(barsUpTo, stock.symbol);
    if (!quote) continue;

    const analysis = analyzeStock(barsUpTo, quote);
    if (analysis.error) continue;
    const closes = barsUpTo.map(b => b.close);
    const midTerm = midTermAnalysis(analysis, quote, closes);

    if (midTerm.score < 58) continue;

    candidates.push({
      symbol: stock.symbol, name: stock.name, sector: stock.sector,
      entryPrice: quote.regularMarketPrice,
      midTermScore: midTerm.score, rec: midTerm.recommendation,
      stopLoss: midTerm.stopLoss, target: midTerm.target,
      riskReward: midTerm.riskReward,
      maxExitDate: addTradingDays(scanDateStr, 20),
      forwardBars: sliceAfter(fullBars, scanDateStr),
    });
  }

  candidates.sort((a, b) => b.midTermScore - a.midTermScore);
  return candidates.slice(0, 3);
}

// ==================== CATEGORY DEFINITIONS ====================

const CATEGORIES = [
  { key: "DEEP_VALUE",     label: "Deep Value Picks",            shortLabel: "Deep Value" },
  { key: "QUALITY_GROWTH", label: "Quality Growth Picks",        shortLabel: "Quality Growth" },
  { key: "BUY_NOW",        label: "Best Stocks to Buy Now",      shortLabel: "Buy Now" },
  { key: "INTRADAY",       label: "Intraday Trading Picks",      shortLabel: "Intraday" },
  { key: "MID_TERM",       label: "Mid-Term Investment Picks",   shortLabel: "Mid-Term" },
];

// ==================== MAIN SIMULATION ====================

async function runSimulation() {
  console.log("=".repeat(70));
  console.log("  ALL 5 CATEGORIES -- 3-Year Paper Trading Simulation");
  console.log("  Apr 2023 - Mar 2026 (36 monthly scans)");
  console.log("  Capital: Rs 2,00,000 per category (Rs 10,00,000 total)");
  console.log("=".repeat(70));
  console.log();

  console.log(`Scan dates: ${SCAN_DATES.length} months`);
  console.log(`First: ${SCAN_DATES[0].label} (${SCAN_DATES[0].date})`);
  console.log(`Last:  ${SCAN_DATES[SCAN_DATES.length - 1].label} (${SCAN_DATES[SCAN_DATES.length - 1].date})\n`);

  // Step 1: Load fundamentals
  console.log("Loading fundamentals from disk...");
  loadFundamentalsFromDisk();

  // Step 2: Stock universe
  const stocks = getNifty100();
  console.log(`Universe: ${stocks.length} Nifty 100 stocks\n`);

  // Step 3: Fetch all historical data
  const allSymbols = [...stocks.map(s => s.symbol), NIFTY_SYMBOL];
  const histories = await fetchAll(allSymbols);

  const niftyBars = histories.get(NIFTY_SYMBOL);
  if (!niftyBars) { console.error("FATAL: No Nifty 50 data"); process.exit(1); }
  console.log(`Nifty 50 bars: ${niftyBars.length} (${toDateStr(niftyBars[0].date)} to ${toDateStr(niftyBars[niftyBars.length - 1].date)})\n`);

  // Step 4: Run monthly scans for all 5 categories with independent capital pools
  console.log("Running 36 monthly scans for ALL 5 categories...\n");

  // Per-category state
  const catState = {};
  for (const cat of CATEGORIES) {
    catState[cat.key] = {
      capital: STARTING_CAPITAL,
      trades: [],
      monthlyCapital: [],  // track capital at start of each month
      cashflows: [],       // for XIRR
    };
  }

  // Track all stock picks per category for overlap analysis
  const catStockPicks = {};
  for (const cat of CATEGORIES) catStockPicks[cat.key] = new Set();

  for (const scan of SCAN_DATES) {
    console.log(`--- ${scan.label} (${scan.date}) ---`);

    // ---- Category 1: Deep Value ----
    {
      const cat = catState["DEEP_VALUE"];
      cat.monthlyCapital.push({ label: scan.label, capital: cat.capital });
      const picks = scanDeepValue(stocks, histories, scan.date);
      if (picks.length > 0 && cat.capital > 0) {
        const perPick = cat.capital / picks.length;
        let returned = 0;
        for (const p of picks) {
          catStockPicks["DEEP_VALUE"].add(p.symbol);
          const shares = perPick / p.entryPrice;
          const exit = trackTrade(p.forwardBars, p.entryPrice, p.target, p.stopLoss, p.maxExitDate);
          const exitAmount = shares * exit.exitPrice;
          const returnPct = ((exit.exitPrice - p.entryPrice) / p.entryPrice) * 100;
          returned += exitAmount;
          cat.cashflows.push({ date: new Date(scan.date), amount: -perPick });
          cat.cashflows.push({ date: new Date(exit.exitDate || scan.date), amount: exitAmount });
          cat.trades.push({
            scanDate: scan.label, scanDateRaw: scan.date, monthIndex: scan.monthIndex,
            symbol: p.symbol, name: p.name, sector: p.sector,
            entryPrice: p.entryPrice, exitPrice: exit.exitPrice,
            exitDate: exit.exitDate, reason: exit.reason,
            returnPct, invested: perPick, returned: exitAmount,
            fundScore: p.fundScore, fundVerdict: p.fundVerdict,
          });
        }
        cat.capital = returned;
      }
      console.log(`  Deep Value: ${picks.length} picks, capital Rs ${fmtRupee(cat.capital)}`);
    }

    // ---- Category 2: Quality Growth ----
    {
      const cat = catState["QUALITY_GROWTH"];
      cat.monthlyCapital.push({ label: scan.label, capital: cat.capital });
      const picks = scanQualityGrowth(stocks, histories, scan.date);
      if (picks.length > 0 && cat.capital > 0) {
        const perPick = cat.capital / picks.length;
        let returned = 0;
        for (const p of picks) {
          catStockPicks["QUALITY_GROWTH"].add(p.symbol);
          const shares = perPick / p.entryPrice;
          const exit = trackTrade(p.forwardBars, p.entryPrice, p.target, p.stopLoss, p.maxExitDate);
          const exitAmount = shares * exit.exitPrice;
          const returnPct = ((exit.exitPrice - p.entryPrice) / p.entryPrice) * 100;
          returned += exitAmount;
          cat.cashflows.push({ date: new Date(scan.date), amount: -perPick });
          cat.cashflows.push({ date: new Date(exit.exitDate || scan.date), amount: exitAmount });
          cat.trades.push({
            scanDate: scan.label, scanDateRaw: scan.date, monthIndex: scan.monthIndex,
            symbol: p.symbol, name: p.name, sector: p.sector,
            entryPrice: p.entryPrice, exitPrice: exit.exitPrice,
            exitDate: exit.exitDate, reason: exit.reason,
            returnPct, invested: perPick, returned: exitAmount,
            fundScore: p.fundScore, fundVerdict: p.fundVerdict,
          });
        }
        cat.capital = returned;
      }
      console.log(`  Quality Growth: ${picks.length} picks, capital Rs ${fmtRupee(cat.capital)}`);
    }

    // ---- Category 3: Best Stocks to Buy Now ----
    {
      const cat = catState["BUY_NOW"];
      cat.monthlyCapital.push({ label: scan.label, capital: cat.capital });
      const picks = scanBuyNow(stocks, histories, scan.date);
      if (picks.length > 0 && cat.capital > 0) {
        const perPick = cat.capital / picks.length;
        let returned = 0;
        for (const p of picks) {
          catStockPicks["BUY_NOW"].add(p.symbol);
          const shares = perPick / p.entryPrice;
          const exit = trackTrade(p.forwardBars, p.entryPrice, p.target, p.stopLoss, p.maxExitDate);
          const exitAmount = shares * exit.exitPrice;
          const returnPct = ((exit.exitPrice - p.entryPrice) / p.entryPrice) * 100;
          returned += exitAmount;
          cat.cashflows.push({ date: new Date(scan.date), amount: -perPick });
          cat.cashflows.push({ date: new Date(exit.exitDate || scan.date), amount: exitAmount });
          cat.trades.push({
            scanDate: scan.label, scanDateRaw: scan.date, monthIndex: scan.monthIndex,
            symbol: p.symbol, name: p.name, sector: p.sector,
            entryPrice: p.entryPrice, exitPrice: exit.exitPrice,
            exitDate: exit.exitDate, reason: exit.reason,
            returnPct, invested: perPick, returned: exitAmount,
            techScore: p.techScore, fundScore: p.fundScore,
            combinedScore: p.combinedScore, fundVerdict: p.fundVerdict,
          });
        }
        cat.capital = returned;
      }
      console.log(`  Buy Now: ${picks.length} picks, capital Rs ${fmtRupee(cat.capital)}`);
    }

    // ---- Category 4: Intraday ----
    {
      const cat = catState["INTRADAY"];
      cat.monthlyCapital.push({ label: scan.label, capital: cat.capital });
      const picks = scanIntraday(stocks, histories, scan.date);
      if (picks.length > 0 && cat.capital > 0) {
        const perPick = cat.capital / picks.length;
        let returned = 0;
        for (const p of picks) {
          catStockPicks["INTRADAY"].add(p.symbol);
          const shares = perPick / p.entryPrice;

          // For SHORT positions, profit = entry - exit (but we simulate by adjusting return calc)
          let exit;
          if (p.direction === "LONG") {
            exit = trackIntradayTrade(p.forwardBars, p.entryPrice, p.target, p.stopLoss);
          } else {
            // SHORT: SL is above entry, target is below entry
            // Swap for trackIntradayTrade then compute return differently
            exit = trackIntradayTrade(p.forwardBars, p.entryPrice, null, null);
            // For shorts, check manually
            const nextBar = p.forwardBars[0];
            if (!nextBar) {
              exit = { exitPrice: p.entryPrice, exitDate: null, reason: "NO_DATA" };
            } else {
              // SL is above entry for shorts
              if (nextBar.high >= p.stopLoss) {
                exit = { exitPrice: p.stopLoss, exitDate: toDateStr(nextBar.date), reason: "SL" };
              } else if (nextBar.low <= p.target) {
                exit = { exitPrice: p.target, exitDate: toDateStr(nextBar.date), reason: "TARGET" };
              } else {
                exit = { exitPrice: nextBar.close, exitDate: toDateStr(nextBar.date), reason: "DAY_CLOSE" };
              }
            }
          }

          let returnPct;
          if (p.direction === "LONG") {
            returnPct = ((exit.exitPrice - p.entryPrice) / p.entryPrice) * 100;
          } else {
            // SHORT: profit when price falls
            returnPct = ((p.entryPrice - exit.exitPrice) / p.entryPrice) * 100;
          }

          const exitAmount = perPick * (1 + returnPct / 100);
          returned += exitAmount;

          cat.cashflows.push({ date: new Date(scan.date), amount: -perPick });
          cat.cashflows.push({ date: new Date(exit.exitDate || scan.date), amount: exitAmount });
          cat.trades.push({
            scanDate: scan.label, scanDateRaw: scan.date, monthIndex: scan.monthIndex,
            symbol: p.symbol, name: p.name, sector: p.sector,
            entryPrice: p.entryPrice, exitPrice: exit.exitPrice,
            exitDate: exit.exitDate, reason: exit.reason,
            returnPct, invested: perPick, returned: exitAmount,
            direction: p.direction, intradayScore: p.intradayScore, techScore: p.techScore,
          });
        }
        cat.capital = returned;
      }
      console.log(`  Intraday: ${picks.length} picks, capital Rs ${fmtRupee(cat.capital)}`);
    }

    // ---- Category 5: Mid-Term ----
    {
      const cat = catState["MID_TERM"];
      cat.monthlyCapital.push({ label: scan.label, capital: cat.capital });
      const picks = scanMidTerm(stocks, histories, scan.date);
      if (picks.length > 0 && cat.capital > 0) {
        const perPick = cat.capital / picks.length;
        let returned = 0;
        for (const p of picks) {
          catStockPicks["MID_TERM"].add(p.symbol);
          const shares = perPick / p.entryPrice;
          const exit = trackTrade(p.forwardBars, p.entryPrice, p.target, p.stopLoss, p.maxExitDate);
          const exitAmount = shares * exit.exitPrice;
          const returnPct = ((exit.exitPrice - p.entryPrice) / p.entryPrice) * 100;
          returned += exitAmount;
          cat.cashflows.push({ date: new Date(scan.date), amount: -perPick });
          cat.cashflows.push({ date: new Date(exit.exitDate || scan.date), amount: exitAmount });
          cat.trades.push({
            scanDate: scan.label, scanDateRaw: scan.date, monthIndex: scan.monthIndex,
            symbol: p.symbol, name: p.name, sector: p.sector,
            entryPrice: p.entryPrice, exitPrice: exit.exitPrice,
            exitDate: exit.exitDate, reason: exit.reason,
            returnPct, invested: perPick, returned: exitAmount,
            midTermScore: p.midTermScore,
          });
        }
        cat.capital = returned;
      }
      console.log(`  Mid-Term: ${picks.length} picks, capital Rs ${fmtRupee(cat.capital)}`);
    }
  }

  // ==================== COMPUTE METRICS ====================

  console.log("\n\nComputing metrics...\n");

  // Nifty benchmark: buy-and-hold from first to last scan date
  const niftyStart = sliceUpTo(niftyBars, SCAN_DATES[0].date);
  const niftyEnd   = sliceUpTo(niftyBars, SCAN_DATES[SCAN_DATES.length - 1].date);
  const niftyStartPrice = niftyStart[niftyStart.length - 1]?.close || 1;
  const niftyEndPrice   = niftyEnd[niftyEnd.length - 1]?.close || 1;
  const niftyReturn = ((niftyEndPrice - niftyStartPrice) / niftyStartPrice) * 100;
  const niftyXIRRCf = [
    { date: new Date(SCAN_DATES[0].date), amount: -STARTING_CAPITAL },
    { date: new Date(SCAN_DATES[SCAN_DATES.length - 1].date), amount: STARTING_CAPITAL * (1 + niftyReturn / 100) },
  ];
  const niftyXIRRVal = xirr(niftyXIRRCf) * 100;

  // Per-category XIRR
  const categoryMetrics = {};
  for (const cat of CATEGORIES) {
    const st = catState[cat.key];
    const trades = st.trades;
    const total = trades.length;
    const wins = trades.filter(t => t.returnPct > 0).length;
    const avgReturn = total > 0 ? trades.reduce((s, t) => s + t.returnPct, 0) / total : 0;

    st.cashflows.sort((a, b) => a.date - b.date);
    const catXIRR = st.cashflows.length >= 2 ? xirr(st.cashflows) * 100 : 0;

    categoryMetrics[cat.key] = {
      trades: total,
      wins,
      losses: total - wins,
      winRate: total > 0 ? (wins / total) * 100 : 0,
      avgReturn,
      finalCapital: st.capital,
      xirr: catXIRR,
      alpha: catXIRR - niftyXIRRVal,
    };
  }

  // Print console summary
  console.log("=".repeat(70));
  console.log("  CATEGORY LEADERBOARD");
  console.log("=".repeat(70));
  console.log();

  for (const cat of CATEGORIES) {
    const m = categoryMetrics[cat.key];
    console.log(`  ${cat.label.padEnd(30)} | Trades: ${String(m.trades).padStart(4)} | WR: ${m.winRate.toFixed(1).padStart(5)}% | Avg: ${fmtPct(m.avgReturn).padStart(8)} | Final: Rs ${fmtLakh(m.finalCapital).padStart(8)} | XIRR: ${fmtPct(m.xirr).padStart(8)} | Alpha: ${fmtPct(m.alpha).padStart(8)}`);
  }
  console.log(`\n  Nifty 50 (benchmark)             | Return: ${fmtPct(niftyReturn)} | XIRR: ${fmtPct(niftyXIRRVal)}`);

  // Combined portfolio
  const totalFinal = CATEGORIES.reduce((s, c) => s + catState[c.key].capital, 0);
  const totalInvested = STARTING_CAPITAL * 5;
  const totalReturn = ((totalFinal - totalInvested) / totalInvested) * 100;
  const niftyEquiv = totalInvested * (1 + niftyReturn / 100);

  console.log(`\n  Combined Portfolio (Rs 10L total):`);
  console.log(`    Invested:   Rs ${fmtLakh(totalInvested)}`);
  console.log(`    Final:      Rs ${fmtLakh(totalFinal)}`);
  console.log(`    Return:     ${fmtPct(totalReturn)}`);
  console.log(`    Nifty equiv: Rs ${fmtLakh(niftyEquiv)} (${fmtPct(niftyReturn)})`);

  // ==================== GENERATE REPORT ====================

  console.log("\nGenerating report...");
  generateReport(catState, categoryMetrics, catStockPicks, niftyBars, niftyXIRRVal, niftyReturn, niftyStartPrice, niftyEndPrice);
  console.log(`Report saved to: ${REPORT_PATH}`);
  console.log("\n=== Simulation Complete ===\n");
}

// ==================== REPORT GENERATION ====================

function generateReport(catState, metrics, catStockPicks, niftyBars, niftyXIRR, niftyReturn, niftyStart, niftyEnd) {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });

  let md = "";

  // ============================================================
  // HEADER
  // ============================================================
  md += "# All 5 Categories -- 3-Year Paper Trading Report\n\n";
  md += `**Generated:** ${new Date().toISOString().slice(0, 10)}  \n`;
  md += `**Scan Period:** Apr 2023 - Mar 2026 (36 monthly scans)  \n`;
  md += `**History:** Apr 2022 - Apr 2026 (4 years OHLCV)  \n`;
  md += `**Capital:** Rs 2,00,000 per category (Rs 10,00,000 total), compounding monthly  \n`;
  md += `**Universe:** Nifty 100 stocks  \n`;
  md += `**Nifty 50:** ${niftyStart.toFixed(0)} -> ${niftyEnd.toFixed(0)} (${fmtPct(niftyReturn)})  \n\n`;
  md += "---\n\n";

  // ============================================================
  // SECTION 1: CATEGORY LEADERBOARD
  // ============================================================
  md += "## 1. Category Leaderboard\n\n";
  md += "| Category | Trades | Win Rate | Avg Return | Final Value (from Rs 2L) | XIRR | Nifty XIRR | Alpha |\n";
  md += "|----------|--------|----------|------------|--------------------------|------|------------|-------|\n";

  // Sort by XIRR descending
  const sorted = [...CATEGORIES].sort((a, b) => metrics[b.key].xirr - metrics[a.key].xirr);
  for (const cat of sorted) {
    const m = metrics[cat.key];
    md += `| **${cat.shortLabel}** | ${m.trades} | ${m.winRate.toFixed(1)}% | ${fmtPct(m.avgReturn)} | Rs ${fmtLakh(m.finalCapital)} | ${fmtPct(m.xirr)} | ${fmtPct(niftyXIRR)} | ${fmtPct(m.alpha)} |\n`;
  }
  md += "\n";

  // Quick verdict
  const bestCat = sorted[0];
  const worstCat = sorted[sorted.length - 1];
  md += `**Best category:** ${bestCat.label} with XIRR of ${fmtPct(metrics[bestCat.key].xirr)}  \n`;
  md += `**Worst category:** ${worstCat.label} with XIRR of ${fmtPct(metrics[worstCat.key].xirr)}  \n`;
  md += `**Nifty 50 XIRR:** ${fmtPct(niftyXIRR)}  \n\n`;

  const beatingNifty = CATEGORIES.filter(c => metrics[c.key].xirr > niftyXIRR).length;
  md += `**${beatingNifty}/5 categories beat the Nifty 50 benchmark.**\n\n`;
  md += "---\n\n";

  // ============================================================
  // SECTION 2: PER-CATEGORY DETAIL
  // ============================================================
  md += "## 2. Per-Category Detail\n\n";

  for (const cat of CATEGORIES) {
    const m = metrics[cat.key];
    const st = catState[cat.key];
    const trades = st.trades;

    md += `### ${cat.label}\n\n`;

    // Summary table
    md += "| Metric | Value |\n";
    md += "|--------|-------|\n";
    md += `| Starting Capital | Rs 2,00,000 |\n`;
    md += `| Final Capital | Rs ${fmtRupee(m.finalCapital)} (${fmtLakh(m.finalCapital)}) |\n`;
    md += `| Total Trades | ${m.trades} |\n`;
    md += `| Wins / Losses | ${m.wins} / ${m.losses} |\n`;
    md += `| Win Rate | ${m.winRate.toFixed(1)}% |\n`;
    md += `| Average Return/Trade | ${fmtPct(m.avgReturn)} |\n`;
    md += `| XIRR | ${fmtPct(m.xirr)} |\n`;
    md += `| Alpha vs Nifty | ${fmtPct(m.alpha)} |\n`;
    md += "\n";

    if (trades.length === 0) {
      md += "No trades in this category.\n\n";
      continue;
    }

    // Monthly capital growth table
    md += "**Monthly Capital Growth:**\n\n";
    md += "| Month | Capital at Start |\n";
    md += "|-------|------------------|\n";
    for (const mc of st.monthlyCapital) {
      md += `| ${mc.label} | Rs ${fmtRupee(mc.capital)} |\n`;
    }
    md += "\n";

    // Year-by-year breakdown
    md += "**Year-by-Year Breakdown:**\n\n";
    md += "| Year | Trades | Win Rate | Avg Return | Capital Start | Capital End |\n";
    md += "|------|--------|----------|------------|---------------|-------------|\n";

    const yearRanges = [
      { label: "Year 1 (Apr 2023 - Mar 2024)", start: 0, end: 11 },
      { label: "Year 2 (Apr 2024 - Mar 2025)", start: 12, end: 23 },
      { label: "Year 3 (Apr 2025 - Mar 2026)", start: 24, end: 35 },
    ];

    for (const yr of yearRanges) {
      const yearTrades = trades.filter(t => t.monthIndex >= yr.start && t.monthIndex <= yr.end);
      const yrWins = yearTrades.filter(t => t.returnPct > 0).length;
      const yrWR = yearTrades.length > 0 ? (yrWins / yearTrades.length * 100).toFixed(1) : "N/A";
      const yrAvg = yearTrades.length > 0 ? yearTrades.reduce((s, t) => s + t.returnPct, 0) / yearTrades.length : 0;
      const capStart = st.monthlyCapital[yr.start]?.capital || 0;
      const capEnd = yr.end + 1 < st.monthlyCapital.length ? st.monthlyCapital[yr.end + 1]?.capital : st.capital;
      md += `| ${yr.label} | ${yearTrades.length} | ${yrWR}% | ${fmtPct(yrAvg)} | Rs ${fmtRupee(capStart)} | Rs ${fmtRupee(capEnd)} |\n`;
    }
    md += "\n";

    // Top 5 winners
    const sortedTrades = [...trades].sort((a, b) => b.returnPct - a.returnPct);
    md += "**Top 5 Winners:**\n\n";
    md += "| Symbol | Month | Entry | Exit | Return | Reason |\n";
    md += "|--------|-------|-------|------|--------|--------|\n";
    for (const t of sortedTrades.slice(0, 5)) {
      md += `| ${t.symbol.replace(".NS", "")} | ${t.scanDate} | Rs ${t.entryPrice.toFixed(0)} | Rs ${t.exitPrice.toFixed(0)} | ${fmtPct(t.returnPct)} | ${t.reason} |\n`;
    }
    md += "\n";

    // Bottom 5 losers
    md += "**Bottom 5 Losers:**\n\n";
    md += "| Symbol | Month | Entry | Exit | Return | Reason |\n";
    md += "|--------|-------|-------|------|--------|--------|\n";
    for (const t of sortedTrades.slice(-5).reverse()) {
      md += `| ${t.symbol.replace(".NS", "")} | ${t.scanDate} | Rs ${t.entryPrice.toFixed(0)} | Rs ${t.exitPrice.toFixed(0)} | ${fmtPct(t.returnPct)} | ${t.reason} |\n`;
    }
    md += "\n";

    // Exit distribution
    const exitReasons = {};
    for (const t of trades) {
      exitReasons[t.reason] = exitReasons[t.reason] || { count: 0, totalRet: 0 };
      exitReasons[t.reason].count++;
      exitReasons[t.reason].totalRet += t.returnPct;
    }

    md += "**Exit Distribution:**\n\n";
    md += "| Exit Reason | Count | % | Avg Return |\n";
    md += "|-------------|-------|---|------------|\n";
    for (const [reason, data] of Object.entries(exitReasons).sort((a, b) => b[1].count - a[1].count)) {
      const pct = (data.count / trades.length * 100).toFixed(1);
      const avg = (data.totalRet / data.count);
      md += `| ${reason} | ${data.count} | ${pct}% | ${fmtPct(avg)} |\n`;
    }
    md += "\n";

    // Sector performance
    const sectorMap = new Map();
    for (const t of trades) {
      if (!sectorMap.has(t.sector)) sectorMap.set(t.sector, []);
      sectorMap.get(t.sector).push(t);
    }

    md += "**Sector Performance:**\n\n";
    md += "| Sector | Trades | Win Rate | Avg Return |\n";
    md += "|--------|--------|----------|------------|\n";
    const sectorArr = [...sectorMap.entries()]
      .map(([sec, tr]) => ({
        sector: sec,
        trades: tr.length,
        wins: tr.filter(t => t.returnPct > 0).length,
        avg: tr.reduce((s, t) => s + t.returnPct, 0) / tr.length,
      }))
      .sort((a, b) => b.avg - a.avg);
    for (const s of sectorArr) {
      md += `| ${s.sector} | ${s.trades} | ${(s.wins / s.trades * 100).toFixed(0)}% | ${fmtPct(s.avg)} |\n`;
    }
    md += "\n---\n\n";
  }

  // ============================================================
  // SECTION 3: COMBINED PORTFOLIO
  // ============================================================
  md += "## 3. Combined Portfolio\n\n";
  md += "If you invested Rs 2,00,000 in EACH category (Rs 10,00,000 total):\n\n";

  const totalInvested = STARTING_CAPITAL * 5;
  const totalFinal = CATEGORIES.reduce((s, c) => s + catState[c.key].capital, 0);
  const totalReturn = ((totalFinal - totalInvested) / totalInvested) * 100;
  const niftyEquiv = totalInvested * (1 + niftyReturn / 100);

  md += "| Metric | Value |\n";
  md += "|--------|-------|\n";
  md += `| Total Invested | Rs ${fmtRupee(totalInvested)} (${fmtLakh(totalInvested)}) |\n`;
  md += `| Total Portfolio Value | Rs ${fmtRupee(totalFinal)} (${fmtLakh(totalFinal)}) |\n`;
  md += `| Total P&L | Rs ${fmtRupee(totalFinal - totalInvested)} (${fmtLakh(totalFinal - totalInvested)}) |\n`;
  md += `| Total Return | ${fmtPct(totalReturn)} |\n`;
  md += `| Nifty Equivalent (Rs 10L buy & hold) | Rs ${fmtRupee(niftyEquiv)} (${fmtLakh(niftyEquiv)}) |\n`;
  md += `| Nifty Return | ${fmtPct(niftyReturn)} |\n`;
  md += `| Portfolio Alpha | ${fmtPct(totalReturn - niftyReturn)} |\n`;
  md += "\n";

  // Per-category contribution to combined portfolio
  md += "**Per-Category Contribution:**\n\n";
  md += "| Category | Invested | Final | P&L | Weight in Final Portfolio |\n";
  md += "|----------|----------|-------|-----|---------------------------|\n";
  for (const cat of sorted) {
    const final = catState[cat.key].capital;
    const pnl = final - STARTING_CAPITAL;
    const weight = totalFinal > 0 ? (final / totalFinal * 100) : 0;
    md += `| ${cat.shortLabel} | Rs ${fmtLakh(STARTING_CAPITAL)} | Rs ${fmtLakh(final)} | Rs ${fmtLakh(pnl)} | ${weight.toFixed(1)}% |\n`;
  }
  md += "\n";

  // Best combination analysis
  md += "**Which combination maximizes returns?**\n\n";
  const catReturns = CATEGORIES.map(c => ({
    key: c.key, label: c.shortLabel,
    returnPct: ((catState[c.key].capital - STARTING_CAPITAL) / STARTING_CAPITAL) * 100,
  })).sort((a, b) => b.returnPct - a.returnPct);

  // Try all pairs and triples
  const combos = [];
  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 5; j++) {
      const invested = STARTING_CAPITAL * 2;
      const final2 = catState[CATEGORIES[i].key].capital + catState[CATEGORIES[j].key].capital;
      combos.push({
        labels: `${CATEGORIES[i].shortLabel} + ${CATEGORIES[j].shortLabel}`,
        returnPct: ((final2 - invested) / invested) * 100,
        count: 2,
      });
      for (let k = j + 1; k < 5; k++) {
        const invested3 = STARTING_CAPITAL * 3;
        const final3 = final2 + catState[CATEGORIES[k].key].capital;
        combos.push({
          labels: `${CATEGORIES[i].shortLabel} + ${CATEGORIES[j].shortLabel} + ${CATEGORIES[k].shortLabel}`,
          returnPct: ((final3 - invested3) / invested3) * 100,
          count: 3,
        });
      }
    }
  }
  combos.sort((a, b) => b.returnPct - a.returnPct);

  md += "| Rank | Combination | Return |\n";
  md += "|------|-------------|--------|\n";
  for (let i = 0; i < Math.min(5, combos.length); i++) {
    md += `| ${i + 1} | ${combos[i].labels} | ${fmtPct(combos[i].returnPct)} |\n`;
  }
  md += "\n---\n\n";

  // ============================================================
  // SECTION 4: CATEGORY CORRELATIONS
  // ============================================================
  md += "## 4. Category Correlations\n\n";

  // Stock overlap
  md += "### Stock Overlap Between Categories\n\n";
  md += "Do categories pick the same stocks? (unique symbols picked across all 36 months)\n\n";
  md += "| Category A | Category B | A Stocks | B Stocks | Overlap | Overlap % |\n";
  md += "|------------|------------|----------|----------|---------|----------|\n";

  for (let i = 0; i < CATEGORIES.length; i++) {
    for (let j = i + 1; j < CATEGORIES.length; j++) {
      const setA = catStockPicks[CATEGORIES[i].key];
      const setB = catStockPicks[CATEGORIES[j].key];
      const overlap = [...setA].filter(s => setB.has(s)).length;
      const overlapPct = Math.min(setA.size, setB.size) > 0
        ? (overlap / Math.min(setA.size, setB.size) * 100).toFixed(0)
        : "0";
      md += `| ${CATEGORIES[i].shortLabel} | ${CATEGORIES[j].shortLabel} | ${setA.size} | ${setB.size} | ${overlap} | ${overlapPct}% |\n`;
    }
  }
  md += "\n";

  // Monthly return correlation (hedging effect)
  md += "### Monthly Performance Correlation (Hedging Effect)\n\n";
  md += "When one category loses in a month, does another win?\n\n";

  // Compute monthly average returns per category
  const monthlyRetByCat = {};
  for (const cat of CATEGORIES) {
    monthlyRetByCat[cat.key] = [];
    for (let mi = 0; mi < 36; mi++) {
      const monthTrades = catState[cat.key].trades.filter(t => t.monthIndex === mi);
      const avg = monthTrades.length > 0
        ? monthTrades.reduce((s, t) => s + t.returnPct, 0) / monthTrades.length
        : 0;
      monthlyRetByCat[cat.key].push(avg);
    }
  }

  // Compute pairwise Pearson correlation
  function pearson(xs, ys) {
    const n = xs.length;
    if (n < 3) return 0;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < n; i++) {
      cov += (xs[i] - mx) * (ys[i] - my);
      vx += (xs[i] - mx) ** 2;
      vy += (ys[i] - my) ** 2;
    }
    return (vx > 0 && vy > 0) ? cov / Math.sqrt(vx * vy) : 0;
  }

  md += "| Category A | Category B | Pearson r | Interpretation |\n";
  md += "|------------|------------|-----------|----------------|\n";

  for (let i = 0; i < CATEGORIES.length; i++) {
    for (let j = i + 1; j < CATEGORIES.length; j++) {
      const r = pearson(monthlyRetByCat[CATEGORIES[i].key], monthlyRetByCat[CATEGORIES[j].key]);
      let interp;
      if (r > 0.5) interp = "Highly correlated (move together)";
      else if (r > 0.2) interp = "Moderately correlated";
      else if (r > -0.2) interp = "Uncorrelated (good diversification)";
      else if (r > -0.5) interp = "Negatively correlated (natural hedge)";
      else interp = "Strongly negatively correlated (excellent hedge)";
      md += `| ${CATEGORIES[i].shortLabel} | ${CATEGORIES[j].shortLabel} | ${r.toFixed(3)} | ${interp} |\n`;
    }
  }
  md += "\n";

  // Months where majority of categories lost vs won
  let diversificationWins = 0;
  for (let mi = 0; mi < 36; mi++) {
    const catReturns = CATEGORIES.map(c => monthlyRetByCat[c.key][mi]);
    const positives = catReturns.filter(r => r > 0).length;
    const negatives = catReturns.filter(r => r < 0).length;
    if (positives > 0 && negatives > 0) diversificationWins++;
  }
  md += `**Diversification benefit:** In ${diversificationWins}/36 months, at least one category was positive while another was negative. This natural hedging reduces portfolio volatility.\n\n`;
  md += "---\n\n";

  // ============================================================
  // SECTION 5: IMPROVEMENT RECOMMENDATIONS
  // ============================================================
  md += "## 5. Improvement Recommendations\n\n";
  md += "Based on 3 years of data across all 5 categories:\n\n";

  // Which category to focus on
  md += "### Categories to Focus On\n\n";
  for (const cat of sorted.slice(0, 2)) {
    const m = metrics[cat.key];
    md += `- **${cat.label}**: XIRR ${fmtPct(m.xirr)}, alpha ${fmtPct(m.alpha)} vs Nifty. `;
    if (m.winRate > 50) md += `Strong win rate (${m.winRate.toFixed(1)}%). `;
    md += "Recommend increasing capital allocation.\n";
  }
  md += "\n";

  // Categories to reduce/eliminate
  md += "### Categories to Reduce or Eliminate\n\n";
  for (const cat of sorted.slice(-2).reverse()) {
    const m = metrics[cat.key];
    md += `- **${cat.label}**: XIRR ${fmtPct(m.xirr)}`;
    if (m.alpha < 0) md += `, underperforming Nifty by ${fmtPct(Math.abs(m.alpha))}`;
    md += ". ";
    if (m.winRate < 50) md += `Low win rate (${m.winRate.toFixed(1)}%). `;
    md += "Consider reducing allocation or reviewing selection criteria.\n";
  }
  md += "\n";

  // Parameter changes per category
  md += "### Specific Parameter Changes\n\n";

  for (const cat of CATEGORIES) {
    const m = metrics[cat.key];
    const trades = catState[cat.key].trades;
    md += `**${cat.shortLabel}:**\n`;

    // SL hit rate
    const slTrades = trades.filter(t => t.reason === "SL_CONFIRMED" || t.reason === "SL");
    const slRate = trades.length > 0 ? (slTrades.length / trades.length * 100) : 0;
    if (slRate > 40) {
      md += `- SL hit rate is ${slRate.toFixed(0)}% -- consider widening stop loss\n`;
    }

    // Target hit rate
    const targetTrades = trades.filter(t => t.reason === "TARGET");
    const tgtRate = trades.length > 0 ? (targetTrades.length / trades.length * 100) : 0;
    if (tgtRate < 15) {
      md += `- Only ${tgtRate.toFixed(0)}% hit target -- consider tightening target or extending hold period\n`;
    }

    // Time exit rate
    const expiryTrades = trades.filter(t => t.reason === "EXPIRY" || t.reason === "DAY_CLOSE");
    const expRate = trades.length > 0 ? (expiryTrades.length / trades.length * 100) : 0;
    if (expRate > 50) {
      md += `- ${expRate.toFixed(0)}% expire at time limit -- targets may be too ambitious\n`;
    }

    if (m.winRate < 45) {
      md += `- Win rate below 45% -- entry criteria need tightening\n`;
    }
    if (m.alpha > 5) {
      md += `- Generating significant alpha -- consider increasing allocation\n`;
    }
    md += "\n";
  }

  // What's missing
  md += "### What's Missing\n\n";
  md += "1. **Earnings calendar filter:** Avoid entering within 1 week of earnings -- reduces binary event risk for all categories\n";
  md += "2. **Market regime overlay:** Use Nifty VIX or trend to modulate position sizing across all categories\n";
  md += "3. **Sector rotation signal:** Overweight categories/sectors showing momentum, underweight laggards\n";
  md += "4. **Intraday improvements:** The 1-day hold with monthly scans misses intraday opportunities -- consider daily scans\n";
  md += "5. **Compounding optimization:** Instead of equal split, dynamically allocate more capital to categories with recent momentum\n";
  md += "6. **Transaction cost modeling:** Add 0.05-0.10% round-trip costs per trade for realistic P&L\n";
  md += "7. **Drawdown limits:** Add a per-category drawdown circuit breaker (e.g., pause if capital drops 30% from peak)\n\n";

  md += "---\n\n";

  // ============================================================
  // DISCLAIMER
  // ============================================================
  md += "## Disclaimer\n\n";
  md += "This is a **paper trading simulation** with the following limitations:\n\n";
  md += "1. **Historical fundamentals approximation:** Uses the current (Apr 2026) fundamentals.json snapshot for all 36 scans. In reality, fundamental scores change quarterly as earnings are reported. This introduces look-ahead bias -- results for 2023-2024 should be interpreted with caution.\n";
  md += "2. **No transaction costs:** Real trading involves brokerage, STT, GST, SEBI charges, and slippage. Estimate 0.05-0.10% round-trip per trade.\n";
  md += "3. **Survivorship bias:** Uses the current Nifty 100 composition. Stocks removed from the index during the test period are not represented.\n";
  md += "4. **No position sizing limits:** All capital is deployed equally across picks each month. In practice, concentration limits and risk budgets would apply.\n";
  md += "5. **Execution assumption:** Trades execute at closing price on scan date. Real orders may fill at different prices.\n";
  md += "6. **Gap risk:** When price gaps through SL or target, simulation assumes fill at exact SL/target level. Real fills would be worse.\n";
  md += "7. **Intraday simulation:** Intraday picks are scanned monthly (not daily), which significantly underrepresents the frequency a real intraday trader would operate at.\n";
  md += "8. **Compounding risk:** Each category's capital fully compounds monthly. A bad month can significantly reduce future capital, amplifying drawdowns.\n\n";
  md += "---\n\n";
  md += `*Report generated on ${new Date().toISOString()} by StarBhai All-Categories Backtest Engine*\n`;

  writeFileSync(REPORT_PATH, md, "utf-8");
}

// ==================== ENTRY POINT ====================

runSimulation().catch(e => { console.error("FATAL:", e); process.exit(1); });
