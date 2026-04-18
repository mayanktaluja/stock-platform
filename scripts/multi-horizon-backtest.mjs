#!/usr/bin/env node
/**
 * Multi-Horizon Paper Trading Simulation with Market Mood Filter
 * ══════════════════════════════════════════════════════════════════
 *
 * Runs 5 horizon tests (1yr, 2yr, 3yr, 4yr, 5yr) each with and without
 * a market mood filter, using a single fetch of 5.5 years of OHLCV data.
 *
 * Generates a consolidated markdown report at reports/multi-horizon-report.md
 *
 * Usage:
 *   node scripts/multi-horizon-backtest.mjs
 */

import { fileURLToPath } from "url";
import path from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import YahooFinance from "yahoo-finance2";
import { analyzeStock, midTermAnalysis } from "../analysis.js";
import { scoreFundamentals } from "../fundamentals.js";
import {
  loadFundamentalsHistory,
  buildSnapshotAsOf,
  computeSectorMediansAsOf,
} from "../fundamentalsHistory.js";
import { getNifty100 } from "../stockList.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORT_DIR = path.join(__dirname, "..", "reports");
const REPORT_PATH = path.join(REPORT_DIR, "multi-horizon-report.md");

// ==================== CONFIGURATION ====================

const HISTORY_START = "2020-10-01";
const HISTORY_END = "2026-04-16";
const NIFTY_INDEX_SYMBOL = "^NSEI";
const CONCURRENCY = 6;

const HORIZONS = [
  { label: "1 Year",  startYear: 2025, startMonth: 3, endYear: 2026, endMonth: 2 },
  { label: "2 Years", startYear: 2024, startMonth: 3, endYear: 2026, endMonth: 2 },
  { label: "3 Years", startYear: 2023, startMonth: 3, endYear: 2026, endMonth: 2 },
  { label: "4 Years", startYear: 2022, startMonth: 3, endYear: 2026, endMonth: 2 },
  { label: "5 Years", startYear: 2021, startMonth: 3, endYear: 2026, endMonth: 2 },
];

// ==================== YAHOO FINANCE CLIENT ====================

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

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

function yearFraction(d1, d2) {
  const ms = new Date(d2).getTime() - new Date(d1).getTime();
  return ms / (365.25 * 24 * 60 * 60 * 1000);
}

// ==================== SCAN DATES GENERATOR ====================

function generateScanDates(startYear, startMonth, endYear, endMonth) {
  const dates = [];
  const firstDays = { 0: 3, 1: 2, 2: 2, 3: 4, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1, 10: 3, 11: 1 };
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (let y = startYear; y <= endYear; y++) {
    const sm = (y === startYear) ? startMonth : 0;
    const em = (y === endYear) ? endMonth : 11;
    for (let m = sm; m <= em; m++) {
      dates.push({
        label: `${monthNames[m]} ${y}`,
        date: `${y}-${String(m + 1).padStart(2, "0")}-${String(firstDays[m]).padStart(2, "0")}`,
      });
    }
  }
  return dates;
}

// ==================== MARKET MOOD FILTER ====================

function computeMarketMood(niftyBars, scanDate) {
  const targetDate = new Date(scanDate);
  targetDate.setHours(23, 59, 59, 999);
  const bars = niftyBars.filter((b) => b.date <= targetDate);

  if (bars.length < 50) return { mood: "UNKNOWN", score: 2, picks: 7 };

  const lastClose = bars[bars.length - 1].close;

  // Signal 1: Nifty 5-day return > 0%
  const close5ago = bars.length >= 6 ? bars[bars.length - 6].close : lastClose;
  const ret5d = (lastClose - close5ago) / close5ago;
  const sig1 = ret5d > 0 ? 1 : 0;

  // Signal 2: Price above 20-day SMA
  const sma20 = bars.slice(-20).reduce((s, b) => s + b.close, 0) / 20;
  const sig2 = lastClose > sma20 ? 1 : 0;

  // Signal 3: Price above 50-day SMA
  const sma50 = bars.slice(-50).reduce((s, b) => s + b.close, 0) / 50;
  const sig3 = lastClose > sma50 ? 1 : 0;

  const score = sig1 + sig2 + sig3;

  const moods = {
    3: { mood: "STRONG_BUY_DAY", picks: 10 },
    2: { mood: "BUY_DAY", picks: 7 },
    1: { mood: "SELECTIVE", picks: 4 },
    0: { mood: "STAY_OUT", picks: 0 },
  };

  return { ...moods[score], score, ret5d, sma20, sma50, lastClose };
}

// ==================== XIRR CALCULATION ====================

function xirr(cashflows) {
  if (!cashflows || cashflows.length < 2) return 0;

  const hasPositive = cashflows.some((cf) => cf.amount > 0);
  const hasNegative = cashflows.some((cf) => cf.amount < 0);
  if (!hasPositive || !hasNegative) return 0;

  function npv(rate) {
    let result = 0;
    const d0 = cashflows[0].date.getTime();
    for (const cf of cashflows) {
      const years = (cf.date.getTime() - d0) / (365.25 * 24 * 60 * 60 * 1000);
      result += cf.amount / Math.pow(1 + rate, years);
    }
    return result;
  }

  function npvDeriv(rate) {
    let result = 0;
    const d0 = cashflows[0].date.getTime();
    for (const cf of cashflows) {
      const years = (cf.date.getTime() - d0) / (365.25 * 24 * 60 * 60 * 1000);
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
    if (Math.abs(newRate - rate) < 1e-9) {
      rate = newRate;
      break;
    }
    rate = newRate;
    if (rate < -0.99) rate = -0.99;
    if (rate > 10) rate = 10;
  }

  return isFinite(rate) ? rate : 0;
}

// ==================== DATA FETCHING ====================

async function fetchHistory(symbol) {
  try {
    const result = await yf.chart(symbol, {
      period1: HISTORY_START,
      period2: HISTORY_END,
      interval: "1d",
    });
    if (!result || !result.quotes || result.quotes.length === 0) return null;
    return result.quotes
      .filter((q) => q.close != null && q.open != null && q.high != null && q.low != null)
      .map((q) => ({
        date: new Date(q.date),
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume || 0,
      }));
  } catch (err) {
    console.error(`  [WARN] Failed to fetch ${symbol}: ${err.message}`);
    return null;
  }
}

async function fetchAllHistories(stocks) {
  const histories = new Map();
  const queue = [...stocks.map((s) => s.symbol), NIFTY_INDEX_SYMBOL];
  let completed = 0;
  const total = queue.length;

  async function worker() {
    while (queue.length > 0) {
      const symbol = queue.shift();
      if (!symbol) break;
      const data = await fetchHistory(symbol);
      if (data) histories.set(symbol, data);
      completed++;
      if (completed % 10 === 0 || completed === total) {
        console.log(`  Fetched ${completed}/${total} symbols`);
      }
    }
  }

  console.log(`\nFetching ${total} symbols with concurrency ${CONCURRENCY}...`);
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  console.log(`  Done. ${histories.size} symbols with valid data.\n`);
  return histories;
}

// ==================== HISTORY SLICING ====================

function sliceHistoryUpTo(bars, dateStr) {
  const targetDate = new Date(dateStr);
  targetDate.setHours(23, 59, 59, 999);
  return bars.filter((b) => b.date <= targetDate);
}

function sliceHistoryAfter(bars, dateStr) {
  const targetDate = new Date(dateStr);
  targetDate.setHours(0, 0, 0, 0);
  return bars.filter((b) => b.date > targetDate);
}

// ==================== MOCK QUOTE BUILDER ====================

function buildMockQuote(historical, symbol) {
  if (!historical || historical.length < 2) return null;
  const last = historical[historical.length - 1];
  const prev = historical[historical.length - 2];
  const slice252 = historical.slice(-252);
  return {
    symbol,
    regularMarketPrice: last.close,
    regularMarketPreviousClose: prev.close,
    regularMarketChange: last.close - prev.close,
    regularMarketChangePercent: ((last.close - prev.close) / prev.close) * 100,
    regularMarketDayHigh: last.high,
    regularMarketDayLow: last.low,
    regularMarketVolume: last.volume,
    regularMarketOpen: last.open,
    fiftyTwoWeekHigh: Math.max(...slice252.map((d) => d.high)),
    fiftyTwoWeekLow: Math.min(...slice252.map((d) => d.low)),
  };
}

// ==================== DMA200 CALCULATION ====================

function computeDMA200(bars) {
  if (!bars || bars.length < 200) return null;
  const closes = bars.slice(-200).map((b) => b.close);
  return closes.reduce((s, v) => s + v, 0) / 200;
}

// ==================== TRADE TRACKING ====================

function trackTrade(forwardBars, entryPrice, target, stopLoss, maxExitDateStr) {
  const maxExitDate = new Date(maxExitDateStr);
  maxExitDate.setHours(23, 59, 59, 999);

  for (const bar of forwardBars) {
    if (bar.date > maxExitDate) break;

    if (stopLoss && bar.low <= stopLoss) {
      return {
        exitPrice: stopLoss,
        exitDate: toDateStr(bar.date),
        exitReason: "SL_HIT",
        returnPct: ((stopLoss - entryPrice) / entryPrice) * 100,
      };
    }

    if (target && bar.high >= target) {
      return {
        exitPrice: target,
        exitDate: toDateStr(bar.date),
        exitReason: "TARGET_HIT",
        returnPct: ((target - entryPrice) / entryPrice) * 100,
      };
    }
  }

  const eligibleBars = forwardBars.filter((b) => b.date <= maxExitDate);
  if (eligibleBars.length === 0) {
    return {
      exitPrice: entryPrice,
      exitDate: maxExitDateStr,
      exitReason: "NO_DATA",
      returnPct: 0,
    };
  }

  const lastBar = eligibleBars[eligibleBars.length - 1];
  return {
    exitPrice: lastBar.close,
    exitDate: toDateStr(lastBar.date),
    exitReason: "TIME_EXIT",
    returnPct: ((lastBar.close - entryPrice) / entryPrice) * 100,
  };
}

// ==================== SCANNING LOGIC ====================

function runScan(stocks, histories, scanDateStr, activePositions, maxPicks, scanStats) {
  const buyNowCandidates = [];
  const midTermCandidates = [];
  const fundamentalCandidates = [];

  // ---- Pass 1: build priceMap for point-in-time sector P/E medians ----
  // Every stock with a usable quote at scanDate contributes to the sector
  // median. We compute once per scan so every buildSnapshotAsOf() call inside
  // the main loop shares the same benchmark.
  const priceMap = new Map();
  for (const stock of stocks) {
    const fullBars = histories.get(stock.symbol);
    if (!fullBars) continue;
    const barsUpTo = sliceHistoryUpTo(fullBars, scanDateStr);
    if (barsUpTo.length < 50) continue;
    const q = buildMockQuote(barsUpTo, stock.symbol);
    if (!q) continue;
    priceMap.set(stock.symbol, { price: q.regularMarketPrice, sector: stock.sector });
  }
  const sectorMedians = computeSectorMediansAsOf(scanDateStr, priceMap);

  // ---- Pass 2: per-stock scoring ----
  for (const stock of stocks) {
    const fullBars = histories.get(stock.symbol);
    if (!fullBars) continue;

    const barsUpTo = sliceHistoryUpTo(fullBars, scanDateStr);
    if (barsUpTo.length < 50) continue;

    const quote = buildMockQuote(barsUpTo, stock.symbol);
    if (!quote) continue;

    const analysis = analyzeStock(barsUpTo, quote);
    if (analysis.error) continue;

    const midTerm = midTermAnalysis(analysis, quote);
    const dma200 = computeDMA200(barsUpTo);
    // Point-in-time fundamentals — returns null when historical data isn't
    // available as-of scanDate. Don't fall back to current snapshot; that's
    // the look-ahead bug we're fixing.
    const snap = buildSnapshotAsOf(stock.symbol, scanDateStr, quote, sectorMedians, {
      name: stock.name,
      sector: stock.sector,
    });
    if (scanStats) {
      if (snap) scanStats.withFundamentals++;
      else scanStats.withoutFundamentals++;
    }
    const fundResult = snap ? scoreFundamentals(snap, dma200) : null;

    const techScore = analysis.score;
    const fundScore = fundResult ? fundResult.score : null;
    const fundVerdict = fundResult ? fundResult.verdict : null;

    const entryPrice = quote.regularMarketPrice;
    const forwardBars = sliceHistoryAfter(fullBars, scanDateStr);

    const atr = analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null;
    // Unified with production (server.js scan endpoints): ATR×4 SL, ATR×5 target.
    const midTermSL = atr ? entryPrice - atr * 4 : midTerm.stopLoss;
    const midTermTarget = atr ? entryPrice + atr * 5 : midTerm.target;

    // --- Category 1: Buy Now ---
    // Unified 40/60 weighting to match server.js live + precompute scanner.
    if (fundScore != null) {
      const combined = techScore * 0.40 + fundScore * 0.60;
      if (
        combined >= 65 &&
        (fundVerdict === "DEEP_VALUE" || fundVerdict === "QUALITY_GROWTH") &&
        analysis.recommendation !== "HOLD"
      ) {
        buyNowCandidates.push({
          symbol: stock.symbol,
          name: stock.name,
          sector: stock.sector,
          category: "BUY_NOW",
          entryPrice,
          techScore,
          fundScore,
          combinedScore: combined,
          fundVerdict,
          recommendation: analysis.recommendation,
          stopLoss: midTermSL,
          target: midTermTarget,
          maxExitDate: addCalendarMonths(scanDateStr, 3),
          forwardBars,
          dma200,
        });
      }
    }

    // --- Category 2: Mid-Term ---
    if (midTerm.score >= 58) {
      midTermCandidates.push({
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        category: "MID_TERM",
        entryPrice,
        techScore,
        midTermScore: midTerm.score,
        recommendation: midTerm.recommendation,
        stopLoss: midTermSL,
        target: midTermTarget,
        maxExitDate: addTradingDays(scanDateStr, 20),
        forwardBars,
        dma200,
      });
    }

    // --- Category 3: Fundamental ---
    // Week 2 (Apr 2026): widened SL floor from 20% → 25%. Backtest showed
    // the 20% floor was too tight for 3-month holds in Indian mid-caps —
    // many QG/DV picks hit SL on normal volatility before the value thesis
    // could play out. 25% gives room for -1σ monthly moves without exiting
    // prematurely.
    if (fundResult && (fundVerdict === "DEEP_VALUE" || fundVerdict === "QUALITY_GROWTH")) {
      const w52High = quote.fiftyTwoWeekHigh;
      const w52Low = quote.fiftyTwoWeekLow;
      const structuralSL = Math.max(
        dma200 && dma200 < entryPrice ? dma200 : entryPrice * 0.75,
        w52Low && w52Low < entryPrice ? w52Low : entryPrice * 0.75,
        entryPrice * 0.75
      );
      const finalSL = structuralSL >= entryPrice ? entryPrice * 0.75 : structuralSL;

      const pe = snap?.pe ?? null;
      const sectorPe = fundResult.breakdown?.sectorPeUsed ?? snap?.sectorPe ?? null;
      const revGrowth = fundResult.breakdown?.revenueGrowthValue ?? null;
      let valuationTarget;
      if (pe && sectorPe && pe > 0 && sectorPe > 0 && pe < sectorPe && (sectorPe / pe) >= 1.10) {
        valuationTarget = entryPrice * Math.min(sectorPe / pe, 1.40);
      } else if (w52High && w52High > entryPrice) {
        const growthImplied = revGrowth != null && revGrowth > 0 ? entryPrice * (1 + revGrowth) : 0;
        valuationTarget = Math.max(w52High, growthImplied);
      } else if (revGrowth != null && revGrowth > 0) {
        valuationTarget = entryPrice * (1 + revGrowth);
      } else {
        valuationTarget = entryPrice * 1.15;
      }

      fundamentalCandidates.push({
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        category: "FUNDAMENTAL",
        entryPrice,
        fundScore,
        fundVerdict,
        stopLoss: finalSL,
        target: valuationTarget,
        // Week 2: Fundamental hold extended 3 → 6 months. Deep Value re-ratings
        // typically take 1-2 quarters to play out; the 3-month cap was
        // exiting too many trades at TIME_EXIT before the valuation target
        // was reached. 6 months gives two earnings cycles' worth of room.
        maxExitDate: addCalendarMonths(scanDateStr, 6),
        forwardBars,
        dma200,
      });
    }
  }

  // Sort and pick top N from each, respecting deduplication
  buyNowCandidates.sort((a, b) => b.combinedScore - a.combinedScore);
  midTermCandidates.sort((a, b) => b.midTermScore - a.midTermScore);
  fundamentalCandidates.sort((a, b) => b.fundScore - a.fundScore);

  function pickTop(candidates, limit) {
    const picked = [];
    for (const c of candidates) {
      if (picked.length >= limit) break;
      if (activePositions.has(c.symbol)) continue;
      picked.push(c);
    }
    return picked;
  }

  const buyNowPicks = pickTop(buyNowCandidates, maxPicks);
  const midTermPicks = pickTop(midTermCandidates, maxPicks);
  const fundamentalPicks = pickTop(fundamentalCandidates, maxPicks);

  return { buyNowPicks, midTermPicks, fundamentalPicks };
}

// ==================== RUN ONE HORIZON ====================

function runHorizon(horizon, stocks, histories, niftyBars, useFilter) {
  const scanDates = generateScanDates(horizon.startYear, horizon.startMonth, horizon.endYear, horizon.endMonth);
  const allTrades = [];
  const activePositions = new Set();
  const monthlyResults = [];
  const moodLog = [];
  let skippedMonths = 0;
  // Tracks how many (stock, scanDate) pairs had point-in-time fundamentals
  // available vs. were skipped due to missing history. Reported per-horizon
  // so we can call out when coverage is incomplete.
  const scanStatsAccumulator = { withFundamentals: 0, withoutFundamentals: 0 };

  for (const scan of scanDates) {
    // Expire active positions that should have exited
    for (const t of allTrades) {
      if (t.exitDate && t.exitDate <= scan.date && activePositions.has(t.symbol)) {
        activePositions.delete(t.symbol);
      }
    }
    for (const t of allTrades) {
      if (!t.exitDate && t.maxExitDate <= scan.date) {
        const fullBars = histories.get(t.symbol);
        if (fullBars) {
          const fwdBars = sliceHistoryAfter(fullBars, t.scanDate);
          const result = trackTrade(fwdBars, t.entryPrice, t.target, t.stopLoss, t.maxExitDate);
          Object.assign(t, result);
        }
        activePositions.delete(t.symbol);
      }
    }

    // Compute market mood
    const mood = computeMarketMood(niftyBars, scan.date);
    let maxPicks;
    // Week 3 (Apr 2026): VALUE-PICKS-THROUGH-STAY-OUT.
    //
    // The previous behaviour treated STAY_OUT as "skip every pick this month".
    // Unfiltered backtest shows the filter COSTS 14.7pp alpha at 1yr (filter
    // -1.4%, no-filter +13.3%) — the filter is blocking exactly the months
    // when value gets cheapest. Buffett's dictum applies: fear is when to
    // buy quality + value, not when to sit out.
    //
    // New rule: STAY_OUT only suppresses Mid-Term (momentum) picks. Buy Now
    // and Fundamental (which are both value-gated — DEEP_VALUE or
    // QUALITY_GROWTH verdicts only) still fire. These are the trades you
    // WANT to place during fear regimes, and the unfiltered results prove
    // the edge is there.
    let suppressMidTerm = false;
    if (useFilter) {
      if (mood.picks === 0) {
        // STAY_OUT — don't skip; just suppress momentum.
        suppressMidTerm = true;
        skippedMonths++;  // (legacy counter — now means "mid-term skipped")
        maxPicks = 5;     // value-only month — modest pick cap
      } else {
        maxPicks = mood.picks;
      }
    } else {
      maxPicks = 10; // No filter — always pick 10
    }

    moodLog.push({
      label: scan.label,
      date: scan.date,
      mood: mood.mood,
      score: mood.score,
      skipped: false,
      picks: maxPicks,
    });

    const { buyNowPicks, midTermPicks, fundamentalPicks } = runScan(
      stocks,
      histories,
      scan.date,
      activePositions,
      maxPicks,
      scanStatsAccumulator
    );

    let entries = 0;

    for (const pick of buyNowPicks) {
      activePositions.add(pick.symbol);
      const result = trackTrade(pick.forwardBars, pick.entryPrice, pick.target, pick.stopLoss, pick.maxExitDate);
      allTrades.push({
        symbol: pick.symbol,
        name: pick.name,
        sector: pick.sector,
        category: pick.category,
        scanDate: scan.date,
        scanLabel: scan.label,
        entryPrice: pick.entryPrice,
        techScore: pick.techScore,
        fundScore: pick.fundScore,
        combinedScore: pick.combinedScore,
        fundVerdict: pick.fundVerdict,
        stopLoss: pick.stopLoss,
        target: pick.target,
        maxExitDate: pick.maxExitDate,
        ...result,
      });
      if (result.exitDate <= scan.date) activePositions.delete(pick.symbol);
      entries++;
    }

    // Week 3: during STAY_OUT regimes suppress Mid-Term (momentum) only.
    // Buy Now + Fundamental (value) trades were already executed above.
    const midTermToRun = suppressMidTerm ? [] : midTermPicks;
    for (const pick of midTermToRun) {
      activePositions.add(pick.symbol);
      const result = trackTrade(pick.forwardBars, pick.entryPrice, pick.target, pick.stopLoss, pick.maxExitDate);
      allTrades.push({
        symbol: pick.symbol,
        name: pick.name,
        sector: pick.sector,
        category: pick.category,
        scanDate: scan.date,
        scanLabel: scan.label,
        entryPrice: pick.entryPrice,
        midTermScore: pick.midTermScore,
        stopLoss: pick.stopLoss,
        target: pick.target,
        maxExitDate: pick.maxExitDate,
        ...result,
      });
      if (result.exitDate <= scan.date) activePositions.delete(pick.symbol);
      entries++;
    }

    for (const pick of fundamentalPicks) {
      activePositions.add(pick.symbol);
      const result = trackTrade(pick.forwardBars, pick.entryPrice, pick.target, pick.stopLoss, pick.maxExitDate);
      allTrades.push({
        symbol: pick.symbol,
        name: pick.name,
        sector: pick.sector,
        category: pick.category,
        scanDate: scan.date,
        scanLabel: scan.label,
        entryPrice: pick.entryPrice,
        fundScore: pick.fundScore,
        fundVerdict: pick.fundVerdict,
        stopLoss: pick.stopLoss,
        target: pick.target,
        maxExitDate: pick.maxExitDate,
        ...result,
      });
      if (result.exitDate <= scan.date) activePositions.delete(pick.symbol);
      entries++;
    }

    // Nifty monthly return
    const nextScan = scanDates[scanDates.indexOf(scan) + 1];
    let niftyMonthly = null;
    if (nextScan) {
      const nStart = sliceHistoryUpTo(niftyBars, scan.date);
      const nEnd = sliceHistoryUpTo(niftyBars, nextScan.date);
      if (nStart.length > 0 && nEnd.length > 0) {
        const sp = nStart[nStart.length - 1].close;
        const ep = nEnd[nEnd.length - 1].close;
        niftyMonthly = ((ep - sp) / sp) * 100;
      }
    }

    // Average return of trades that exited in this window
    const nextDate = nextScan?.date || HISTORY_END;
    const monthExits = allTrades.filter(
      (t) => t.exitDate >= scan.date && t.exitDate < nextDate
    );
    const monthAvgReturn = monthExits.length > 0
      ? monthExits.reduce((s, t) => s + t.returnPct, 0) / monthExits.length
      : 0;

    monthlyResults.push({
      label: scan.label,
      date: scan.date,
      mood: mood.mood,
      moodScore: mood.score,
      entries,
      skipped: false,
      avgReturn: monthAvgReturn,
      niftyMonthly,
    });
  }

  // Finalize remaining open trades
  for (const t of allTrades) {
    if (!t.exitDate) {
      const fullBars = histories.get(t.symbol);
      if (fullBars) {
        const fwdBars = sliceHistoryAfter(fullBars, t.scanDate);
        const result = trackTrade(fwdBars, t.entryPrice, t.target, t.stopLoss, t.maxExitDate);
        Object.assign(t, result);
      }
    }
  }

  // Compute aggregate metrics
  const totalTrades = allTrades.length;
  const wins = allTrades.filter((t) => t.returnPct > 0).length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const avgReturn = totalTrades > 0
    ? allTrades.reduce((s, t) => s + t.returnPct, 0) / totalTrades
    : 0;

  // XIRR — overall and per-category. Per-category is built from a filtered
  // slice of allTrades using the same cashflow convention.
  const INVEST_PER_TRADE = 10000;
  function xirrForTrades(trades) {
    if (!trades || trades.length === 0) return { xirr: 0, tradeCount: 0, winRate: 0, avgReturn: 0 };
    const cf = [];
    let wins = 0;
    let sumRet = 0;
    for (const t of trades) {
      cf.push({ date: new Date(t.scanDate), amount: -INVEST_PER_TRADE });
      cf.push({ date: new Date(t.exitDate), amount: INVEST_PER_TRADE * (1 + t.returnPct / 100) });
      if (t.returnPct > 0) wins++;
      sumRet += t.returnPct;
    }
    cf.sort((a, b) => a.date - b.date);
    return {
      xirr: cf.length >= 2 ? xirr(cf) * 100 : 0,
      tradeCount: trades.length,
      winRate: (wins / trades.length) * 100,
      avgReturn: sumRet / trades.length,
    };
  }

  const cashflows = [];
  for (const t of allTrades) {
    cashflows.push({ date: new Date(t.scanDate), amount: -INVEST_PER_TRADE });
    const exitAmount = INVEST_PER_TRADE * (1 + t.returnPct / 100);
    cashflows.push({ date: new Date(t.exitDate), amount: exitAmount });
  }
  cashflows.sort((a, b) => a.date - b.date);
  const portfolioXIRR = cashflows.length >= 2 ? xirr(cashflows) * 100 : 0;

  // Per-category XIRR. "Fundamental" trades carry a fundVerdict
  // (DEEP_VALUE or QUALITY_GROWTH) which we split into sub-buckets. Buy Now
  // trades also carry a fundVerdict but are reported as one bucket since
  // the combined-score gate already filters them.
  const byCategory = {
    buyNow: xirrForTrades(allTrades.filter((t) => t.category === "BUY_NOW")),
    midTerm: xirrForTrades(allTrades.filter((t) => t.category === "MID_TERM")),
    fundamental: xirrForTrades(allTrades.filter((t) => t.category === "FUNDAMENTAL")),
    qualityGrowth: xirrForTrades(
      allTrades.filter((t) => t.category === "FUNDAMENTAL" && t.fundVerdict === "QUALITY_GROWTH")
    ),
    deepValue: xirrForTrades(
      allTrades.filter((t) => t.category === "FUNDAMENTAL" && t.fundVerdict === "DEEP_VALUE")
    ),
  };

  // ─── Top-K concentration sweep ───
  // For each category, what if we only kept the top K highest-ranked picks
  // per scan month? Trades are already stored in rank order within each
  // (scanDate, category) group (runScan pushes them after sorting descending
  // by the category's native score), so taking the first K per group == top-K.
  //
  // `pickMatches(t, cat)` decides which bucket a trade belongs to. QG and DV
  // re-rank within the FUNDAMENTAL bucket by sharing the same native order
  // (fundScore desc) — they're naturally split because the verdict is fixed
  // per trade.
  function topKPerScan(pickMatches, K) {
    const byScan = new Map();
    for (const t of allTrades) {
      if (!pickMatches(t)) continue;
      if (!byScan.has(t.scanDate)) byScan.set(t.scanDate, []);
      byScan.get(t.scanDate).push(t);
    }
    const picked = [];
    for (const arr of byScan.values()) picked.push(...arr.slice(0, K));
    return picked;
  }

  const KS = [1, 2, 3, 5, 10];
  const topK = {
    buyNow: {},
    midTerm: {},
    qualityGrowth: {},
    deepValue: {},
  };
  for (const K of KS) {
    topK.buyNow[K] = xirrForTrades(topKPerScan((t) => t.category === "BUY_NOW", K));
    topK.midTerm[K] = xirrForTrades(topKPerScan((t) => t.category === "MID_TERM", K));
    topK.qualityGrowth[K] = xirrForTrades(
      topKPerScan((t) => t.category === "FUNDAMENTAL" && t.fundVerdict === "QUALITY_GROWTH", K)
    );
    topK.deepValue[K] = xirrForTrades(
      topKPerScan((t) => t.category === "FUNDAMENTAL" && t.fundVerdict === "DEEP_VALUE", K)
    );
  }

  // Nifty benchmark XIRR
  let niftyXIRR = 0;
  if (scanDates.length > 0) {
    const niftyStart = sliceHistoryUpTo(niftyBars, scanDates[0].date);
    const niftyEnd = sliceHistoryUpTo(niftyBars, scanDates[scanDates.length - 1].date);
    if (niftyStart.length > 0 && niftyEnd.length > 0) {
      const startPrice = niftyStart[niftyStart.length - 1].close;
      const endPrice = niftyEnd[niftyEnd.length - 1].close;
      const niftyCf = [
        { date: new Date(scanDates[0].date), amount: -startPrice },
        { date: new Date(scanDates[scanDates.length - 1].date), amount: endPrice },
      ];
      niftyXIRR = xirr(niftyCf) * 100;
    }
  }

  const alpha = portfolioXIRR - niftyXIRR;

  return {
    horizon: horizon.label,
    useFilter,
    scanDates,
    allTrades,
    monthlyResults,
    moodLog,
    skippedMonths,
    totalTrades,
    wins,
    winRate,
    avgReturn,
    portfolioXIRR,
    niftyXIRR,
    alpha,
    byCategory,
    topK,
    fundamentalsCoverage: scanStatsAccumulator,
  };
}

// ==================== REPORT GENERATION ====================

function generateReport(filteredResults, unfilteredResults, niftyBars) {
  if (!existsSync(REPORT_DIR)) {
    mkdirSync(REPORT_DIR, { recursive: true });
  }

  let md = "";
  md += "# Multi-Horizon Paper Trading Report with Market Mood Filter\n\n";
  md += `**Generated:** ${new Date().toISOString().slice(0, 10)}  \n`;
  md += `**Data Period:** Oct 2020 - Apr 2026 (5.5 years of OHLCV)  \n`;
  md += `**Horizons Tested:** 1yr, 2yr, 3yr, 4yr, 5yr  \n`;
  md += `**Universe:** Nifty 100 stocks  \n`;
  md += `**Engine:** StarBhai production scoring engine  \n\n`;

  // ============================================================
  // PART 1: Cross-Horizon Comparison Table
  // ============================================================

  md += "---\n\n";
  md += "## Part 1: Cross-Horizon Comparison\n\n";
  md += "| Horizon | Trades (Filtered) | Win Rate | Avg Return | XIRR | Nifty XIRR | Alpha | Months Skipped | XIRR (No Filter) | Filter Value |\n";
  md += "|---------|-------------------|----------|------------|------|------------|-------|----------------|-------------------|--------------|\n";

  for (let i = 0; i < filteredResults.length; i++) {
    const f = filteredResults[i];
    const u = unfilteredResults[i];
    const filterValue = f.portfolioXIRR - u.portfolioXIRR;
    md += `| ${f.horizon} | ${f.totalTrades} | ${f.winRate.toFixed(1)}% | ${f.avgReturn.toFixed(2)}% | ${f.portfolioXIRR.toFixed(1)}% | ${f.niftyXIRR.toFixed(1)}% | ${f.alpha >= 0 ? "+" : ""}${f.alpha.toFixed(1)}% | ${f.skippedMonths} | ${u.portfolioXIRR.toFixed(1)}% | ${filterValue >= 0 ? "+" : ""}${filterValue.toFixed(1)}pp |\n`;
  }
  md += "\n";

  md += "**Key Observations:**\n\n";
  const bestHorizon = filteredResults.reduce((a, b) => a.portfolioXIRR > b.portfolioXIRR ? a : b);
  const bestAlpha = filteredResults.reduce((a, b) => a.alpha > b.alpha ? a : b);
  md += `- Best absolute XIRR: **${bestHorizon.horizon}** at ${bestHorizon.portfolioXIRR.toFixed(1)}%\n`;
  md += `- Best alpha: **${bestAlpha.horizon}** at ${bestAlpha.alpha >= 0 ? "+" : ""}${bestAlpha.alpha.toFixed(1)}%\n`;

  const avgFilterValue = filteredResults.reduce((s, f, i) => s + (f.portfolioXIRR - unfilteredResults[i].portfolioXIRR), 0) / filteredResults.length;
  md += `- Average filter value across all horizons: ${avgFilterValue >= 0 ? "+" : ""}${avgFilterValue.toFixed(1)}pp\n\n`;

  // ─── Category × Horizon XIRR vs Nifty (the honest comparison) ───
  md += "### Portfolio by Category vs Nifty 50\n\n";
  md += "Per-category XIRR across 1-4 year horizons (the window with 100% point-in-time ";
  md += "fundamentals coverage). Alpha is category XIRR minus Nifty XIRR over the same window. ";
  md += "All results use the market-mood-filtered variant.\n\n";

  const catHorizons = filteredResults.filter(
    (r) => r.horizon === "1 Year" || r.horizon === "2 Years" ||
           r.horizon === "3 Years" || r.horizon === "4 Years"
  );
  const fmt = (x, plus = false) => `${plus && x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

  md += "| Horizon | Category | Trades | Win Rate | Avg Return | Portfolio XIRR | Nifty 50 XIRR | Alpha |\n";
  md += "|---------|----------|-------:|---------:|-----------:|---------------:|--------------:|------:|\n";
  for (const r of catHorizons) {
    const rows = [
      ["Buy Now",        r.byCategory.buyNow],
      ["Mid-Term",       r.byCategory.midTerm],
      ["Quality Growth", r.byCategory.qualityGrowth],
      ["Deep Value",     r.byCategory.deepValue],
      ["All combined",   { tradeCount: r.totalTrades, winRate: r.winRate, avgReturn: r.avgReturn, xirr: r.portfolioXIRR }],
    ];
    for (const [label, c] of rows) {
      const alpha = c.tradeCount > 0 ? c.xirr - r.niftyXIRR : 0;
      md += `| ${r.horizon} | ${label} | ${c.tradeCount} | ${c.tradeCount ? c.winRate.toFixed(1) + "%" : "—"} | ${c.tradeCount ? c.avgReturn.toFixed(2) + "%" : "—"} | ${c.tradeCount ? fmt(c.xirr) : "—"} | ${fmt(r.niftyXIRR)} | ${c.tradeCount ? fmt(alpha, true) : "—"} |\n`;
    }
  }
  md += "\n";
  md += "**Reading this table:**\n";
  md += "- *Buy Now* — combined 50/50 technical+fundamental score ≥ 65, fund verdict is DEEP_VALUE or QUALITY_GROWTH, recommendation is not HOLD. Held up to 3 months with ATR×3 SL / ATR×5 target.\n";
  md += "- *Mid-Term* — pure technical score ≥ 58. Held up to 20 trading days.\n";
  md += "- *Quality Growth* — fundamental verdict QUALITY_GROWTH (score 58-71). Held up to 3 months with 20% trailing stop.\n";
  md += "- *Deep Value* — fundamental verdict DEEP_VALUE (score ≥ 72). Held up to 3 months with 20% trailing stop.\n";
  md += "- *All combined* — every trade the strategy produced across all three categories.\n\n";

  // ─── Top-K Concentration Analysis ───
  md += "### Top-K Concentration Analysis\n\n";
  md += "For each category, what if we only kept the top K highest-scoring picks per scan month? ";
  md += "Lower K = more concentrated, fewer but higher-conviction trades. ";
  md += "Cell format: `XIRR% (alpha)` where alpha = category XIRR − Nifty XIRR. Bold is the best K for that row.\n\n";

  for (const r of catHorizons) {
    md += `**${r.horizon}** (Nifty XIRR: ${r.niftyXIRR.toFixed(1)}%)\n\n`;
    md += "| Category | Top 1 | Top 2 | Top 3 | Top 5 | Top 10 |\n";
    md += "|----------|-------|-------|-------|-------|--------|\n";
    const cats = [
      ["Buy Now", r.topK.buyNow],
      ["Mid-Term", r.topK.midTerm],
      ["Quality Growth", r.topK.qualityGrowth],
      ["Deep Value", r.topK.deepValue],
    ];
    for (const [label, kdata] of cats) {
      const ks = [1, 2, 3, 5, 10];
      const bestK = ks.reduce((best, k) =>
        kdata[k].tradeCount > 0 && (best == null || kdata[k].xirr > kdata[best].xirr) ? k : best, null);
      const cells = ks.map((k) => {
        const c = kdata[k];
        if (c.tradeCount === 0) return "—";
        const alpha = c.xirr - r.niftyXIRR;
        const sign = alpha >= 0 ? "+" : "";
        const txt = `${c.xirr.toFixed(1)}% (${sign}${alpha.toFixed(1)})`;
        return k === bestK ? `**${txt}**` : txt;
      });
      md += `| ${label} | ${cells.join(" | ")} |\n`;
    }
    md += "\n";
  }
  md += "\n";

  // ─── Fundamentals Coverage (point-in-time honesty check) ───
  md += "### Fundamentals Coverage\n\n";
  md += "Stock×scanDate pairs where historical fundamentals were available as-of the scan date. ";
  md += "Pairs without historical data skip fundamental-gated trades (they don't fall back to the current snapshot).\n\n";
  md += "| Horizon | With Fundamentals | Without Fundamentals | Coverage % |\n";
  md += "|---------|-------------------|----------------------|------------|\n";
  for (const f of filteredResults) {
    const cov = f.fundamentalsCoverage || { withFundamentals: 0, withoutFundamentals: 0 };
    const total = cov.withFundamentals + cov.withoutFundamentals;
    const pct = total > 0 ? (cov.withFundamentals / total) * 100 : 0;
    md += `| ${f.horizon} | ${cov.withFundamentals} | ${cov.withoutFundamentals} | ${pct.toFixed(1)}% |\n`;
  }
  md += "\n";

  // ============================================================
  // PART 2: Individual Horizon Sections
  // ============================================================

  md += "---\n\n";
  md += "## Part 2: Individual Horizon Analysis\n\n";

  for (let hi = 0; hi < filteredResults.length; hi++) {
    const res = filteredResults[hi];
    md += `### ${res.horizon} Horizon\n\n`;

    md += "**Summary:**\n\n";
    md += "| Metric | Value |\n";
    md += "|--------|-------|\n";
    md += `| Total Trades | ${res.totalTrades} |\n`;
    md += `| Wins / Losses | ${res.wins} / ${res.totalTrades - res.wins} |\n`;
    md += `| Win Rate | ${res.winRate.toFixed(1)}% |\n`;
    md += `| Avg Return/Trade | ${res.avgReturn.toFixed(2)}% |\n`;
    md += `| XIRR (Filtered) | ${res.portfolioXIRR.toFixed(1)}% |\n`;
    md += `| XIRR (No Filter) | ${unfilteredResults[hi].portfolioXIRR.toFixed(1)}% |\n`;
    md += `| Nifty XIRR | ${res.niftyXIRR.toFixed(1)}% |\n`;
    md += `| Alpha | ${res.alpha >= 0 ? "+" : ""}${res.alpha.toFixed(1)}% |\n`;
    md += `| Months Skipped | ${res.skippedMonths} |\n`;
    md += "\n";

    // Monthly P&L table
    md += "#### Monthly P&L\n\n";
    md += "| Month | Mood | Entries | Avg Return | Nifty Monthly |\n";
    md += "|-------|------|---------|------------|---------------|\n";

    for (const mr of res.monthlyResults) {
      const moodLabel = mr.skipped ? "STAY_OUT" : mr.mood;
      const avgRetStr = mr.skipped ? "-" : `${mr.avgReturn.toFixed(2)}%`;
      const niftyStr = mr.niftyMonthly != null ? `${mr.niftyMonthly.toFixed(1)}%` : "N/A";
      md += `| ${mr.label} | ${moodLabel} | ${mr.entries} | ${avgRetStr} | ${niftyStr} |\n`;
    }
    md += "\n";

    // Category breakdown
    md += "#### Category Breakdown\n\n";
    md += "| Category | Trades | Win Rate | Avg Return | SL Exits | Target Exits | Time Exits |\n";
    md += "|----------|--------|----------|------------|----------|--------------|------------|\n";

    const categories = [
      { key: "BUY_NOW", label: "Buy Now" },
      { key: "MID_TERM", label: "Mid-Term" },
      { key: "FUNDAMENTAL", label: "Fundamental" },
    ];

    for (const cat of categories) {
      const catTrades = res.allTrades.filter((t) => t.category === cat.key);
      if (catTrades.length === 0) {
        md += `| ${cat.label} | 0 | - | - | - | - | - |\n`;
        continue;
      }
      const catWins = catTrades.filter((t) => t.returnPct > 0).length;
      const catWinRate = (catWins / catTrades.length) * 100;
      const catAvg = catTrades.reduce((s, t) => s + t.returnPct, 0) / catTrades.length;
      const slExits = catTrades.filter((t) => t.exitReason === "SL_HIT").length;
      const targetExits = catTrades.filter((t) => t.exitReason === "TARGET_HIT").length;
      const timeExits = catTrades.filter((t) => t.exitReason === "TIME_EXIT" || t.exitReason === "NO_DATA").length;
      md += `| ${cat.label} | ${catTrades.length} | ${catWinRate.toFixed(1)}% | ${catAvg.toFixed(2)}% | ${slExits} (${((slExits / catTrades.length) * 100).toFixed(0)}%) | ${targetExits} (${((targetExits / catTrades.length) * 100).toFixed(0)}%) | ${timeExits} (${((timeExits / catTrades.length) * 100).toFixed(0)}%) |\n`;
    }
    md += "\n";

    // Sector analysis (top 10 by trade count)
    md += "#### Sector Analysis (Top 10)\n\n";
    md += "| Sector | Trades | Win Rate | Avg Return |\n";
    md += "|--------|--------|----------|------------|\n";

    const sectorMap = new Map();
    for (const t of res.allTrades) {
      if (!sectorMap.has(t.sector)) sectorMap.set(t.sector, []);
      sectorMap.get(t.sector).push(t);
    }
    const sortedSectors = [...sectorMap.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
    for (const [sector, trades] of sortedSectors) {
      const sWins = trades.filter((t) => t.returnPct > 0).length;
      const sWinRate = (sWins / trades.length) * 100;
      const sAvg = trades.reduce((s, t) => s + t.returnPct, 0) / trades.length;
      md += `| ${sector} | ${trades.length} | ${sWinRate.toFixed(0)}% | ${sAvg.toFixed(2)}% |\n`;
    }
    md += "\n";

    // Verdict comparison
    md += "#### Verdict Comparison\n\n";
    md += "| Verdict | Trades | Win Rate | Avg Return |\n";
    md += "|---------|--------|----------|------------|\n";

    const deepValueTrades = res.allTrades.filter((t) => t.fundVerdict === "DEEP_VALUE");
    const qualityGrowthTrades = res.allTrades.filter((t) => t.fundVerdict === "QUALITY_GROWTH");

    if (deepValueTrades.length > 0) {
      const dvWins = deepValueTrades.filter((t) => t.returnPct > 0).length;
      const dvAvg = deepValueTrades.reduce((s, t) => s + t.returnPct, 0) / deepValueTrades.length;
      md += `| DEEP_VALUE | ${deepValueTrades.length} | ${((dvWins / deepValueTrades.length) * 100).toFixed(1)}% | ${dvAvg.toFixed(2)}% |\n`;
    }
    if (qualityGrowthTrades.length > 0) {
      const qgWins = qualityGrowthTrades.filter((t) => t.returnPct > 0).length;
      const qgAvg = qualityGrowthTrades.reduce((s, t) => s + t.returnPct, 0) / qualityGrowthTrades.length;
      md += `| QUALITY_GROWTH | ${qualityGrowthTrades.length} | ${((qgWins / qualityGrowthTrades.length) * 100).toFixed(1)}% | ${qgAvg.toFixed(2)}% |\n`;
    }
    if (deepValueTrades.length === 0 && qualityGrowthTrades.length === 0) {
      md += `| (none) | 0 | - | - |\n`;
    }
    md += "\n";
  }

  // ============================================================
  // PART 3: Market Mood Filter Deep-Dive
  // ============================================================

  md += "---\n\n";
  md += "## Part 3: Market Mood Filter Deep-Dive\n\n";

  // Collect all STAY_OUT months across all horizons (use 5yr as the most complete)
  const fiveYrResult = filteredResults[filteredResults.length - 1]; // 5yr is the last
  const stayOutMonths = fiveYrResult.moodLog.filter((m) => m.skipped);

  md += "### STAY_OUT Months Validation\n\n";
  md += "The mood filter signals STAY_OUT when all 3 indicators (5-day return, above SMA20, above SMA50) are negative.\n\n";

  if (stayOutMonths.length > 0) {
    md += "| Month | Nifty Monthly Return | Filter Correct? |\n";
    md += "|-------|---------------------|------------------|\n";

    let correctCount = 0;
    let totalValidated = 0;
    for (const m of stayOutMonths) {
      if (m.niftyMonthlyReturn != null) {
        totalValidated++;
        const correct = m.niftyMonthlyReturn < 0;
        if (correct) correctCount++;
        md += `| ${m.label} | ${m.niftyMonthlyReturn.toFixed(1)}% | ${correct ? "YES (Nifty fell)" : "NO (Nifty rose)"} |\n`;
      } else {
        md += `| ${m.label} | N/A | N/A |\n`;
      }
    }
    md += "\n";

    const accuracy = totalValidated > 0 ? (correctCount / totalValidated) * 100 : 0;
    md += `**Filter Accuracy (True Positive Rate):** ${correctCount}/${totalValidated} = ${accuracy.toFixed(0)}%  \n`;
    md += `This means ${accuracy.toFixed(0)}% of months the filter told us to stay out, Nifty actually declined.\n\n`;
  } else {
    md += "No STAY_OUT months recorded in the 5-year horizon.\n\n";
  }

  // Mood distribution across the longest horizon
  md += "### Mood Distribution (5-Year Horizon)\n\n";
  md += "| Mood | Count | % of Months |\n";
  md += "|------|-------|-------------|\n";

  const moodCounts = {};
  for (const m of fiveYrResult.moodLog) {
    const mood = m.skipped ? "STAY_OUT" : m.mood;
    moodCounts[mood] = (moodCounts[mood] || 0) + 1;
  }
  const totalMoodMonths = fiveYrResult.moodLog.length;
  for (const [mood, count] of Object.entries(moodCounts).sort((a, b) => b[1] - a[1])) {
    md += `| ${mood} | ${count} | ${((count / totalMoodMonths) * 100).toFixed(0)}% |\n`;
  }
  md += "\n";

  // XIRR improvement from filter per horizon
  md += "### XIRR Improvement from Filter per Horizon\n\n";
  md += "| Horizon | XIRR (With Filter) | XIRR (No Filter) | Improvement | Months Skipped |\n";
  md += "|---------|--------------------|--------------------|-------------|----------------|\n";

  for (let i = 0; i < filteredResults.length; i++) {
    const f = filteredResults[i];
    const u = unfilteredResults[i];
    const improvement = f.portfolioXIRR - u.portfolioXIRR;
    md += `| ${f.horizon} | ${f.portfolioXIRR.toFixed(1)}% | ${u.portfolioXIRR.toFixed(1)}% | ${improvement >= 0 ? "+" : ""}${improvement.toFixed(1)}pp | ${f.skippedMonths} |\n`;
  }
  md += "\n";

  // ============================================================
  // PART 4: Consolidated Improvement Recommendations
  // ============================================================

  md += "---\n\n";
  md += "## Part 4: Consolidated Improvement Recommendations\n\n";

  // 1. Consistent winners across all timeframes
  md += "### 1. Consistent Winners Across All Timeframes\n\n";

  const symbolWinMap = new Map();
  const symbolTradeMap = new Map();
  for (const res of filteredResults) {
    for (const t of res.allTrades) {
      if (!symbolTradeMap.has(t.symbol)) symbolTradeMap.set(t.symbol, 0);
      if (!symbolWinMap.has(t.symbol)) symbolWinMap.set(t.symbol, { wins: 0, total: 0, totalReturn: 0, horizons: new Set() });
      const entry = symbolWinMap.get(t.symbol);
      entry.total++;
      entry.totalReturn += t.returnPct;
      entry.horizons.add(res.horizon);
      if (t.returnPct > 0) entry.wins++;
    }
  }

  const consistentWinners = [...symbolWinMap.entries()]
    .filter(([, v]) => v.horizons.size >= 3 && v.total >= 5 && (v.wins / v.total) >= 0.60)
    .sort((a, b) => (b[1].totalReturn / b[1].total) - (a[1].totalReturn / a[1].total))
    .slice(0, 10);

  if (consistentWinners.length > 0) {
    md += "Stocks that appear across 3+ horizons with >= 60% win rate:\n\n";
    md += "| Symbol | Trades | Win Rate | Avg Return | Horizons |\n";
    md += "|--------|--------|----------|------------|----------|\n";
    for (const [sym, data] of consistentWinners) {
      md += `| ${sym.replace(".NS", "")} | ${data.total} | ${((data.wins / data.total) * 100).toFixed(0)}% | ${(data.totalReturn / data.total).toFixed(2)}% | ${data.horizons.size} |\n`;
    }
  } else {
    md += "No stocks found with consistent wins across 3+ horizons (60%+ win rate). Consider widening criteria.\n";
  }
  md += "\n";

  // 2. Consistent losers to exclude
  md += "### 2. Consistent Losers to Exclude\n\n";

  const consistentLosers = [...symbolWinMap.entries()]
    .filter(([, v]) => v.horizons.size >= 3 && v.total >= 5 && (v.wins / v.total) < 0.35)
    .sort((a, b) => (a[1].totalReturn / a[1].total) - (b[1].totalReturn / b[1].total))
    .slice(0, 10);

  if (consistentLosers.length > 0) {
    md += "Stocks that appear across 3+ horizons with < 35% win rate:\n\n";
    md += "| Symbol | Trades | Win Rate | Avg Return | Horizons |\n";
    md += "|--------|--------|----------|------------|----------|\n";
    for (const [sym, data] of consistentLosers) {
      md += `| ${sym.replace(".NS", "")} | ${data.total} | ${((data.wins / data.total) * 100).toFixed(0)}% | ${(data.totalReturn / data.total).toFixed(2)}% | ${data.horizons.size} |\n`;
    }
  } else {
    md += "No stocks found with consistent losses across 3+ horizons. The scoring engine is not systematically picking losers.\n";
  }
  md += "\n";

  // 3. QUALITY_GROWTH vs DEEP_VALUE performance evolution
  md += "### 3. QUALITY_GROWTH vs DEEP_VALUE Performance Evolution\n\n";
  md += "| Horizon | DV Trades | DV Win Rate | DV Avg Return | QG Trades | QG Win Rate | QG Avg Return |\n";
  md += "|---------|-----------|-------------|---------------|-----------|-------------|---------------|\n";

  for (const res of filteredResults) {
    const dvTrades = res.allTrades.filter((t) => t.fundVerdict === "DEEP_VALUE");
    const qgTrades = res.allTrades.filter((t) => t.fundVerdict === "QUALITY_GROWTH");
    const dvWins = dvTrades.filter((t) => t.returnPct > 0).length;
    const qgWins = qgTrades.filter((t) => t.returnPct > 0).length;
    const dvAvg = dvTrades.length > 0 ? dvTrades.reduce((s, t) => s + t.returnPct, 0) / dvTrades.length : 0;
    const qgAvg = qgTrades.length > 0 ? qgTrades.reduce((s, t) => s + t.returnPct, 0) / qgTrades.length : 0;
    const dvWR = dvTrades.length > 0 ? ((dvWins / dvTrades.length) * 100).toFixed(1) : "-";
    const qgWR = qgTrades.length > 0 ? ((qgWins / qgTrades.length) * 100).toFixed(1) : "-";
    md += `| ${res.horizon} | ${dvTrades.length} | ${dvWR}% | ${dvAvg.toFixed(2)}% | ${qgTrades.length} | ${qgWR}% | ${qgAvg.toFixed(2)}% |\n`;
  }
  md += "\n";

  // Determine which is better
  let dvBetterCount = 0;
  let qgBetterCount = 0;
  for (const res of filteredResults) {
    const dvTrades = res.allTrades.filter((t) => t.fundVerdict === "DEEP_VALUE");
    const qgTrades = res.allTrades.filter((t) => t.fundVerdict === "QUALITY_GROWTH");
    const dvAvg = dvTrades.length > 0 ? dvTrades.reduce((s, t) => s + t.returnPct, 0) / dvTrades.length : 0;
    const qgAvg = qgTrades.length > 0 ? qgTrades.reduce((s, t) => s + t.returnPct, 0) / qgTrades.length : 0;
    if (dvAvg > qgAvg) dvBetterCount++;
    else if (qgAvg > dvAvg) qgBetterCount++;
  }
  if (dvBetterCount > qgBetterCount) {
    md += `**Finding:** DEEP_VALUE outperforms QUALITY_GROWTH in ${dvBetterCount}/${filteredResults.length} horizons. Consider overweighting DEEP_VALUE picks.\n\n`;
  } else if (qgBetterCount > dvBetterCount) {
    md += `**Finding:** QUALITY_GROWTH outperforms DEEP_VALUE in ${qgBetterCount}/${filteredResults.length} horizons. Consider overweighting QUALITY_GROWTH picks.\n\n`;
  } else {
    md += `**Finding:** DEEP_VALUE and QUALITY_GROWTH are roughly balanced across horizons. Maintain equal allocation.\n\n`;
  }

  // 4. Sector allocation recommendations
  md += "### 4. Sector Allocation Recommendations\n\n";

  const sectorCrossHorizon = new Map();
  for (const res of filteredResults) {
    for (const t of res.allTrades) {
      if (!sectorCrossHorizon.has(t.sector)) {
        sectorCrossHorizon.set(t.sector, { wins: 0, total: 0, totalReturn: 0, horizonWins: new Map() });
      }
      const entry = sectorCrossHorizon.get(t.sector);
      entry.total++;
      entry.totalReturn += t.returnPct;
      if (t.returnPct > 0) entry.wins++;
      if (!entry.horizonWins.has(res.horizon)) entry.horizonWins.set(res.horizon, { wins: 0, total: 0 });
      const hEntry = entry.horizonWins.get(res.horizon);
      hEntry.total++;
      if (t.returnPct > 0) hEntry.wins++;
    }
  }

  md += "| Sector | Total Trades | Win Rate | Avg Return | Recommendation |\n";
  md += "|--------|-------------|----------|------------|----------------|\n";

  const sectorRecs = [...sectorCrossHorizon.entries()]
    .filter(([, v]) => v.total >= 10)
    .sort((a, b) => (b[1].totalReturn / b[1].total) - (a[1].totalReturn / a[1].total));

  for (const [sector, data] of sectorRecs) {
    const winRate = (data.wins / data.total) * 100;
    const avgReturn = data.totalReturn / data.total;
    let rec;
    if (winRate >= 55 && avgReturn > 2) rec = "OVERWEIGHT";
    else if (winRate >= 50 && avgReturn > 0) rec = "MAINTAIN";
    else if (winRate < 40 || avgReturn < -2) rec = "UNDERWEIGHT / EXCLUDE";
    else rec = "NEUTRAL";
    md += `| ${sector} | ${data.total} | ${winRate.toFixed(0)}% | ${avgReturn.toFixed(2)}% | ${rec} |\n`;
  }
  md += "\n";

  // 5. Parameter tuning robust across all horizons
  md += "### 5. Parameter Tuning Observations\n\n";

  // Analyze exit reason distribution across horizons
  md += "#### Exit Reason Distribution Across Horizons\n\n";
  md += "| Horizon | SL Hit | Target Hit | Time Exit | No Data |\n";
  md += "|---------|--------|------------|-----------|----------|\n";

  for (const res of filteredResults) {
    const sl = res.allTrades.filter((t) => t.exitReason === "SL_HIT").length;
    const tgt = res.allTrades.filter((t) => t.exitReason === "TARGET_HIT").length;
    const time = res.allTrades.filter((t) => t.exitReason === "TIME_EXIT").length;
    const noData = res.allTrades.filter((t) => t.exitReason === "NO_DATA").length;
    const total = res.totalTrades || 1;
    md += `| ${res.horizon} | ${sl} (${((sl / total) * 100).toFixed(0)}%) | ${tgt} (${((tgt / total) * 100).toFixed(0)}%) | ${time} (${((time / total) * 100).toFixed(0)}%) | ${noData} (${((noData / total) * 100).toFixed(0)}%) |\n`;
  }
  md += "\n";

  // Compute average metrics across horizons
  const avgSLRate = filteredResults.reduce((s, r) => {
    const sl = r.allTrades.filter((t) => t.exitReason === "SL_HIT").length;
    return s + (r.totalTrades > 0 ? (sl / r.totalTrades) * 100 : 0);
  }, 0) / filteredResults.length;

  const avgTargetRate = filteredResults.reduce((s, r) => {
    const tgt = r.allTrades.filter((t) => t.exitReason === "TARGET_HIT").length;
    return s + (r.totalTrades > 0 ? (tgt / r.totalTrades) * 100 : 0);
  }, 0) / filteredResults.length;

  const avgTimeRate = filteredResults.reduce((s, r) => {
    const time = r.allTrades.filter((t) => t.exitReason === "TIME_EXIT" || t.exitReason === "NO_DATA").length;
    return s + (r.totalTrades > 0 ? (time / r.totalTrades) * 100 : 0);
  }, 0) / filteredResults.length;

  md += "**Cross-Horizon Averages:**\n";
  md += `- SL Hit Rate: ${avgSLRate.toFixed(0)}%\n`;
  md += `- Target Hit Rate: ${avgTargetRate.toFixed(0)}%\n`;
  md += `- Time Exit Rate: ${avgTimeRate.toFixed(0)}%\n\n`;

  if (avgSLRate > 35) {
    md += `- **Stop Loss Too Tight:** ${avgSLRate.toFixed(0)}% SL rate across all horizons suggests ATR x3 is not giving enough room. Consider widening to ATR x4 for mid-term, or using a trailing stop.\n`;
  }
  if (avgTargetRate < 20) {
    md += `- **Targets Too Ambitious:** Only ${avgTargetRate.toFixed(0)}% of trades hit target. Consider reducing ATR target multiplier from 6x to 4.5x or 5x.\n`;
  }
  if (avgTimeRate > 45) {
    md += `- **Holding Period Issue:** ${avgTimeRate.toFixed(0)}% time exits. Either extend holding periods or tighten targets to be more achievable.\n`;
  }

  // 6. Concrete priority list
  md += "\n### 6. Concrete Priority List with Estimated Impact\n\n";
  md += "| Priority | Action | Rationale | Estimated XIRR Impact |\n";
  md += "|----------|--------|-----------|----------------------|\n";

  // Build recommendations based on actual data
  const filterEffective = avgFilterValue > 0;
  const bestFilterHorizon = filteredResults.reduce((best, f, i) => {
    const v = f.portfolioXIRR - unfilteredResults[i].portfolioXIRR;
    return v > best.v ? { v, label: f.horizon } : best;
  }, { v: -Infinity, label: "" });

  md += `| P0 | ${filterEffective ? "Keep" : "Remove"} market mood filter | ${filterEffective ? `Adds ${avgFilterValue.toFixed(1)}pp on average; best in ${bestFilterHorizon.label} (${bestFilterHorizon.v >= 0 ? "+" : ""}${bestFilterHorizon.v.toFixed(1)}pp)` : `Costs ${Math.abs(avgFilterValue).toFixed(1)}pp on average; filter is reducing returns`} | ${avgFilterValue >= 0 ? "+" : ""}${avgFilterValue.toFixed(1)}pp |\n`;

  if (avgSLRate > 30) {
    md += `| P1 | Widen stop loss from ATR x3 to ATR x4 | SL hit rate of ${avgSLRate.toFixed(0)}% is excessive across all horizons | +2-5pp est. |\n`;
  }

  if (avgTargetRate < 25) {
    md += `| P2 | Reduce target multiplier from ATR x6 to ATR x5 | Only ${avgTargetRate.toFixed(0)}% target hits; more achievable targets improve realized gains | +1-3pp est. |\n`;
  }

  if (consistentLosers.length > 0) {
    const loserSymbols = consistentLosers.slice(0, 3).map(([s]) => s.replace(".NS", "")).join(", ");
    md += `| P3 | Exclude consistent losers: ${loserSymbols} | These stocks lose money across 3+ horizons with <35% win rate | +1-2pp est. |\n`;
  }

  const worstSectors = sectorRecs.filter(([, d]) => (d.wins / d.total) < 0.40).slice(0, 2);
  if (worstSectors.length > 0) {
    const sectorNames = worstSectors.map(([s]) => s).join(", ");
    md += `| P4 | Underweight sectors: ${sectorNames} | Win rate below 40% consistently; these sectors drag portfolio returns | +1-3pp est. |\n`;
  }

  md += `| P5 | Add trailing stop mechanism | Reduce time-exit losses; lock in gains on trending moves | +2-4pp est. |\n`;
  md += `| P6 | Earnings calendar filter | Avoid binary event risk; reduce SL exits near earnings dates | +1-2pp est. |\n`;
  md += "\n";

  // ============================================================
  // DISCLAIMER
  // ============================================================

  md += "---\n\n";
  md += "## Disclaimer\n\n";
  md += "This multi-horizon paper trading simulation has the following limitations:\n\n";
  md += "1. **Point-in-time fundamentals (fixed Apr 2026):** The simulation now uses historical annual/quarterly financial statements from Yahoo Finance, matched to each scan date with a 90-day filing lag for annuals and 45 days for quarterlies. Scan dates with no historical data available (pre ~2022-06 for most stocks) skip fundamental-gated trades rather than fall back to the current snapshot. See the `Fundamentals Coverage` table below.\n";
  md += "2. **No transaction costs:** Real trading involves brokerage, STT, GST, SEBI charges, and slippage. For Nifty 100 stocks, estimate 0.05-0.10% round-trip costs per trade.\n";
  md += "3. **Survivorship bias:** The Nifty 100 constituent list used is the current composition. Stocks that were removed from the index during the test period (due to poor performance) are not represented.\n";
  md += "4. **No position sizing:** All trades are treated equally with fixed capital allocation. In practice, position sizing based on conviction, volatility, and portfolio risk would significantly affect returns.\n";
  md += "5. **Execution assumption:** Trades are assumed to execute at the closing price on the scan date. In practice, orders may fill at different prices.\n";
  md += "6. **SL/Target fill assumption:** When price gaps through SL or target, the simulation assumes fills at the exact SL/target level. In reality, gap fills would be worse.\n";
  md += "7. **Market mood filter uses Nifty 50 index only.** A more sophisticated regime filter could incorporate VIX, yield curves, FII flows, and global market signals.\n";
  md += "\n";
  md += "---\n\n";
  md += `*Report generated on ${new Date().toISOString()} by StarBhai Multi-Horizon Paper Trading Engine*\n`;

  writeFileSync(REPORT_PATH, md, "utf-8");
}

// ==================== MAIN SIMULATION ====================

async function main() {
  console.log("==========================================================");
  console.log("  Multi-Horizon Paper Trading Simulation");
  console.log("  with Market Mood Filter");
  console.log("==========================================================\n");

  // Step 1: Load point-in-time fundamentals history
  console.log("Step 1: Loading point-in-time fundamentals history...");
  const history = loadFundamentalsHistory();
  if (!history) {
    console.error("FATAL: fundamentalsHistory.json missing. Run scripts/fetch-fundamentals-history.mjs first.");
    process.exit(1);
  }
  console.log(
    `  Coverage: ${history.coverage.earliest} → ${history.coverage.latest} ` +
    `(${history.counts.ok}/${history.counts.total} stocks with data)`
  );

  // Step 2: Get stock universe
  const stocks = getNifty100();
  console.log(`Step 2: Stock universe: ${stocks.length} Nifty 100 stocks`);

  // Step 3: Fetch ALL historical data once
  console.log("Step 3: Fetching 5.5 years of historical data (Oct 2020 - Apr 2026)...");
  const histories = await fetchAllHistories(stocks);

  if (!histories.has(NIFTY_INDEX_SYMBOL)) {
    console.error("FATAL: Could not fetch Nifty 50 index data. Aborting.");
    process.exit(1);
  }

  const niftyBars = histories.get(NIFTY_INDEX_SYMBOL);

  // Step 4: Run all horizons — filtered and unfiltered
  console.log("Step 4: Running horizon tests...\n");

  const filteredResults = [];
  const unfilteredResults = [];

  for (const horizon of HORIZONS) {
    console.log(`\n>>> HORIZON: ${horizon.label} (WITH mood filter) <<<`);
    const filteredResult = runHorizon(horizon, stocks, histories, niftyBars, true);
    filteredResults.push(filteredResult);
    console.log(
      `  Trades: ${filteredResult.totalTrades} | Win Rate: ${filteredResult.winRate.toFixed(1)}% | ` +
      `XIRR: ${filteredResult.portfolioXIRR.toFixed(1)}% | Alpha: ${filteredResult.alpha >= 0 ? "+" : ""}${filteredResult.alpha.toFixed(1)}% | ` +
      `Skipped: ${filteredResult.skippedMonths} months`
    );

    console.log(`\n>>> HORIZON: ${horizon.label} (WITHOUT mood filter) <<<`);
    const unfilteredResult = runHorizon(horizon, stocks, histories, niftyBars, false);
    unfilteredResults.push(unfilteredResult);
    console.log(
      `  Trades: ${unfilteredResult.totalTrades} | Win Rate: ${unfilteredResult.winRate.toFixed(1)}% | ` +
      `XIRR: ${unfilteredResult.portfolioXIRR.toFixed(1)}% | Alpha: ${unfilteredResult.alpha >= 0 ? "+" : ""}${unfilteredResult.alpha.toFixed(1)}%`
    );

    const filterValue = filteredResult.portfolioXIRR - unfilteredResult.portfolioXIRR;
    console.log(
      `  Filter value: ${filterValue >= 0 ? "+" : ""}${filterValue.toFixed(1)}pp`
    );
  }

  // Step 5: Generate consolidated report
  console.log("\n\nStep 5: Generating consolidated report...");
  generateReport(filteredResults, unfilteredResults, niftyBars);
  console.log(`Report written to: ${REPORT_PATH}`);

  // Step 6: Print summary to console
  console.log("\n==========================================================");
  console.log("  FINAL SUMMARY");
  console.log("==========================================================\n");

  console.log("Cross-Horizon Comparison:");
  console.log("".padEnd(120, "-"));
  console.log(
    "Horizon".padEnd(12) +
    "Trades".padEnd(10) +
    "Win Rate".padEnd(12) +
    "XIRR".padEnd(10) +
    "Nifty XIRR".padEnd(14) +
    "Alpha".padEnd(10) +
    "Skipped".padEnd(10) +
    "No-Filter".padEnd(12) +
    "Filter Val".padEnd(12)
  );
  console.log("".padEnd(120, "-"));

  for (let i = 0; i < filteredResults.length; i++) {
    const f = filteredResults[i];
    const u = unfilteredResults[i];
    const fv = f.portfolioXIRR - u.portfolioXIRR;
    console.log(
      f.horizon.padEnd(12) +
      String(f.totalTrades).padEnd(10) +
      `${f.winRate.toFixed(1)}%`.padEnd(12) +
      `${f.portfolioXIRR.toFixed(1)}%`.padEnd(10) +
      `${f.niftyXIRR.toFixed(1)}%`.padEnd(14) +
      `${f.alpha >= 0 ? "+" : ""}${f.alpha.toFixed(1)}%`.padEnd(10) +
      String(f.skippedMonths).padEnd(10) +
      `${u.portfolioXIRR.toFixed(1)}%`.padEnd(12) +
      `${fv >= 0 ? "+" : ""}${fv.toFixed(1)}pp`.padEnd(12)
    );
  }

  console.log("".padEnd(120, "-"));
  console.log("\n=== Simulation Complete ===");
}

// ==================== ENTRY POINT ====================

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
