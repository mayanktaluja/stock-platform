#!/usr/bin/env node
/**
 * Paper Trading Simulation — 5-YEAR VERSION
 *
 * 60-month backtest (Apr 2021 – Mar 2026) using the platform's ACTUAL
 * production scoring engine with the optimized P0 parameters.
 *
 * Usage:
 *   node scripts/paper-trade-5yr.mjs
 */

import { fileURLToPath } from "url";
import path from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import YahooFinance from "yahoo-finance2";
import { analyzeStock, midTermAnalysis } from "../analysis.js";
import { scoreFundamentals, loadFundamentalsFromDisk, getFundamentals } from "../fundamentals.js";
import { getNifty100 } from "../stockList.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORT_DIR = path.join(__dirname, "..", "reports");
const REPORT_PATH = path.join(REPORT_DIR, "paper-trading-5yr-report.md");

// ==================== CONFIGURATION ====================

// 5-year range: need 6 months before first scan for indicator warmup
const HISTORY_START = "2020-10-01";
const HISTORY_END = "2026-04-16";
const NIFTY_INDEX_SYMBOL = "^NSEI";
const CONCURRENCY = 6;

// Generate 60 monthly scan dates: Apr 2021 through Mar 2026
function generateScanDates() {
  const dates = [];
  // First trading day approximations for each month
  const firstTradingDays = {
    0: 3, 1: 2, 2: 2, 3: 4, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1, 10: 3, 11: 1,
  };
  for (let year = 2021; year <= 2026; year++) {
    const startMonth = year === 2021 ? 3 : 0; // Apr 2021 start
    const endMonth = year === 2026 ? 2 : 11;   // Mar 2026 end
    for (let month = startMonth; month <= endMonth; month++) {
      const day = firstTradingDays[month];
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      dates.push({ label: `${monthNames[month]} ${year}`, date: dateStr });
    }
  }
  return dates;
}

const SCAN_DATES = generateScanDates();

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

// ==================== SLICE HISTORY UP TO A DATE ====================

function sliceHistoryUpTo(bars, dateStr) {
  const targetDate = new Date(dateStr);
  targetDate.setHours(23, 59, 59, 999);
  const filtered = bars.filter((b) => b.date <= targetDate);
  return filtered;
}

function sliceHistoryAfter(bars, dateStr) {
  const targetDate = new Date(dateStr);
  targetDate.setHours(0, 0, 0, 0);
  return bars.filter((b) => b.date > targetDate);
}

// ==================== TRADE TRACKING ====================

function trackTrade(forwardBars, entryPrice, target, stopLoss, maxExitDateStr) {
  const maxExitDate = new Date(maxExitDateStr);
  maxExitDate.setHours(23, 59, 59, 999);

  for (const bar of forwardBars) {
    if (bar.date > maxExitDate) break;

    // Check SL first (conservative — if both hit in same bar, assume SL)
    if (stopLoss && bar.low <= stopLoss) {
      return {
        exitPrice: stopLoss,
        exitDate: toDateStr(bar.date),
        exitReason: "SL_HIT",
        returnPct: ((stopLoss - entryPrice) / entryPrice) * 100,
      };
    }

    // Check target
    if (target && bar.high >= target) {
      return {
        exitPrice: target,
        exitDate: toDateStr(bar.date),
        exitReason: "TARGET_HIT",
        returnPct: ((target - entryPrice) / entryPrice) * 100,
      };
    }
  }

  // Time exit — find last bar on or before maxExitDate
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

// ==================== DMA200 CALCULATION ====================

function computeDMA200(bars) {
  if (!bars || bars.length < 200) return null;
  const closes = bars.slice(-200).map((b) => b.close);
  return closes.reduce((s, v) => s + v, 0) / 200;
}

// ==================== SCANNING LOGIC ====================

function runScan(stocks, histories, scanDateStr, activePositions, params = {}) {
  const techWeight = params.techWeight ?? 0.40;
  const fundWeight = params.fundWeight ?? 0.60;
  const buyNowThreshold = params.buyNowThreshold ?? 60;
  const midTermThreshold = params.midTermThreshold ?? 58;
  const slMultiplier = params.slMultiplier ?? 4;
  const targetMultiplier = params.targetMultiplier ?? 6;

  const buyNowCandidates = [];
  const midTermCandidates = [];
  const fundamentalCandidates = [];

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
    const snap = getFundamentals(stock.symbol);
    const fundResult = snap ? scoreFundamentals(snap, dma200) : null;

    const techScore = analysis.score;
    const fundScore = fundResult ? fundResult.score : null;
    const fundVerdict = fundResult ? fundResult.verdict : null;

    const entryPrice = quote.regularMarketPrice;
    const forwardBars = sliceHistoryAfter(fullBars, scanDateStr);

    // Override SL/target with custom multipliers
    const atr = analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null;
    const customSL = atr ? entryPrice - atr * slMultiplier : midTerm.stopLoss;
    const customTarget = atr ? entryPrice + atr * targetMultiplier : midTerm.target;

    // --- Category 1: Buy Now ---
    if (fundScore != null) {
      const combined = techScore * techWeight + fundScore * fundWeight;
      if (
        combined >= buyNowThreshold &&
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
          stopLoss: customSL,
          target: customTarget,
          maxExitDate: addCalendarMonths(scanDateStr, 3),
          forwardBars,
          dma200,
          snap,
        });
      }
    }

    // --- Category 2: Mid-Term ---
    if (midTerm.score >= midTermThreshold) {
      midTermCandidates.push({
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        category: "MID_TERM",
        entryPrice,
        techScore,
        midTermScore: midTerm.score,
        recommendation: midTerm.recommendation,
        stopLoss: customSL,
        target: customTarget,
        maxExitDate: addTradingDays(scanDateStr, 20),
        forwardBars,
        dma200,
        snap,
      });
    }

    // --- Category 3: Fundamental ---
    if (fundResult && (fundVerdict === "DEEP_VALUE" || fundVerdict === "QUALITY_GROWTH")) {
      const w52High = quote.fiftyTwoWeekHigh;
      const w52Low = quote.fiftyTwoWeekLow;
      const structuralSL = Math.max(
        dma200 && dma200 < entryPrice ? dma200 : entryPrice * 0.80,
        w52Low && w52Low < entryPrice ? w52Low : entryPrice * 0.80,
        entryPrice * 0.80
      );
      const finalSL = structuralSL >= entryPrice ? entryPrice * 0.80 : structuralSL;

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
        maxExitDate: addCalendarMonths(scanDateStr, 3),
        forwardBars,
        dma200,
        snap,
      });
    }
  }

  // Sort and pick top 10 from each, respecting deduplication
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

  const buyNowPicks = pickTop(buyNowCandidates, 10);
  const midTermPicks = pickTop(midTermCandidates, 10);
  const fundamentalPicks = pickTop(fundamentalCandidates, 10);

  return { buyNowPicks, midTermPicks, fundamentalPicks };
}

// ==================== MAIN SIMULATION ====================

async function runSimulation() {
  console.log("=== StarBhai Paper Trading Simulation ===\n");

  // Step 1: Load fundamentals
  console.log("Loading fundamentals from disk...");
  loadFundamentalsFromDisk();

  // Step 2: Get stock universe
  const stocks = getNifty100();
  console.log(`Stock universe: ${stocks.length} Nifty 100 stocks`);

  // Step 3: Fetch all historical data
  const histories = await fetchAllHistories(stocks);

  if (!histories.has(NIFTY_INDEX_SYMBOL)) {
    console.error("FATAL: Could not fetch Nifty 50 index data. Aborting.");
    process.exit(1);
  }

  // Step 4: Run monthly scans
  console.log(`Running ${SCAN_DATES.length} monthly scans (5 years)...\n`);
  const allTrades = [];
  const activePositions = new Set();
  const monthlyResults = [];

  for (const scan of SCAN_DATES) {
    console.log(`--- Scan: ${scan.label} (${scan.date}) ---`);

    // Check for exits of active trades before this scan
    const tradesBefore = allTrades.filter(
      (t) => t.exitDate && t.exitDate <= scan.date && activePositions.has(t.symbol)
    );
    for (const t of tradesBefore) {
      activePositions.delete(t.symbol);
    }

    // Also process any trades that should have exited by now
    for (const t of allTrades) {
      if (!t.exitDate && t.maxExitDate <= scan.date) {
        const result = trackTrade(t.forwardBars, t.entryPrice, t.target, t.stopLoss, t.maxExitDate);
        Object.assign(t, result);
        delete t.forwardBars;
        activePositions.delete(t.symbol);
      }
    }

    const { buyNowPicks, midTermPicks, fundamentalPicks } = runScan(
      stocks,
      histories,
      scan.date,
      activePositions
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

    for (const pick of midTermPicks) {
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

    // Count exits this month
    const exits = allTrades.filter(
      (t) =>
        t.exitDate &&
        t.exitDate >= scan.date &&
        t.exitDate <= (SCAN_DATES[SCAN_DATES.indexOf(scan) + 1]?.date || HISTORY_END)
    ).length;

    console.log(
      `  Buy Now: ${buyNowPicks.length} | Mid-Term: ${midTermPicks.length} | Fundamental: ${fundamentalPicks.length} | Total entries: ${entries}`
    );

    monthlyResults.push({
      label: scan.label,
      date: scan.date,
      entries,
      buyNow: buyNowPicks.length,
      midTerm: midTermPicks.length,
      fundamental: fundamentalPicks.length,
    });
  }

  // Finalize any remaining open trades
  for (const t of allTrades) {
    if (!t.exitDate) {
      const fullBars = histories.get(t.symbol);
      if (fullBars) {
        const forwardBars = sliceHistoryAfter(fullBars, t.scanDate);
        const result = trackTrade(forwardBars, t.entryPrice, t.target, t.stopLoss, t.maxExitDate);
        Object.assign(t, result);
      }
    }
  }

  console.log(`\nTotal trades: ${allTrades.length}`);

  // Step 5: Compute Nifty benchmark returns per month
  const niftyBars = histories.get(NIFTY_INDEX_SYMBOL);

  // Step 6: Sensitivity analysis
  console.log("\nRunning sensitivity analysis...");
  const sensitivityResults = runSensitivityAnalysis(stocks, histories);

  // Step 7: Generate report
  console.log("\nGenerating report...");
  generateReport(allTrades, monthlyResults, niftyBars, histories, stocks, sensitivityResults);

  console.log(`\nReport written to: ${REPORT_PATH}`);
  console.log("=== Simulation Complete ===");
}

// ==================== SENSITIVITY ANALYSIS ====================

function runSensitivityAnalysis(stocks, histories) {
  // Reduced grid for 5-year run (60 scans × 48 combos = too slow).
  // Focus on the most informative parameter variations.
  const weightSplits = [
    { techWeight: 0.40, fundWeight: 0.60, label: "40/60" },
    { techWeight: 0.50, fundWeight: 0.50, label: "50/50" },
    { techWeight: 0.60, fundWeight: 0.40, label: "60/40" },
  ];
  const slMultipliers = [3, 4];
  const scoreThresholds = [60, 65, 70];

  const results = [];

  for (const ws of weightSplits) {
    for (const slMult of slMultipliers) {
      for (const threshold of scoreThresholds) {
        const params = {
          techWeight: ws.techWeight,
          fundWeight: ws.fundWeight,
          buyNowThreshold: threshold,
          midTermThreshold: 58,
          slMultiplier: slMult,
          targetMultiplier: slMult === 3 ? 4.5 : slMult === 4 ? 6 : 7.5,
        };

        const trades = [];
        const activePos = new Set();

        for (const scan of SCAN_DATES) {
          // Expire active positions
          for (const t of trades) {
            if (t.exitDate && t.exitDate <= scan.date && activePos.has(t.symbol)) {
              activePos.delete(t.symbol);
            }
          }
          for (const t of trades) {
            if (!t.exitDate && t.maxExitDate <= scan.date) {
              const fwdBars = sliceHistoryAfter(histories.get(t.symbol) || [], t.scanDate);
              const result = trackTrade(fwdBars, t.entryPrice, t.target, t.stopLoss, t.maxExitDate);
              Object.assign(t, result);
              activePos.delete(t.symbol);
            }
          }

          const { buyNowPicks } = runScan(stocks, histories, scan.date, activePos, params);

          for (const pick of buyNowPicks) {
            activePos.add(pick.symbol);
            const result = trackTrade(pick.forwardBars, pick.entryPrice, pick.target, pick.stopLoss, pick.maxExitDate);
            trades.push({
              symbol: pick.symbol,
              scanDate: scan.date,
              entryPrice: pick.entryPrice,
              stopLoss: pick.stopLoss,
              target: pick.target,
              maxExitDate: pick.maxExitDate,
              ...result,
            });
            if (result.exitDate <= scan.date) activePos.delete(pick.symbol);
          }
        }

        // Finalize
        for (const t of trades) {
          if (!t.exitDate) {
            const fwdBars = sliceHistoryAfter(histories.get(t.symbol) || [], t.scanDate);
            const result = trackTrade(fwdBars, t.entryPrice, t.target, t.stopLoss, t.maxExitDate);
            Object.assign(t, result);
          }
        }

        const wins = trades.filter((t) => t.returnPct > 0).length;
        const avgReturn = trades.length > 0
          ? trades.reduce((s, t) => s + t.returnPct, 0) / trades.length
          : 0;

        // XIRR
        const cashflows = [];
        for (const t of trades) {
          cashflows.push({ date: new Date(t.scanDate), amount: -t.entryPrice });
          cashflows.push({ date: new Date(t.exitDate), amount: t.exitPrice });
        }
        cashflows.sort((a, b) => a.date - b.date);
        const xirrVal = cashflows.length >= 2 ? xirr(cashflows) : 0;

        results.push({
          weightLabel: ws.label,
          slMult,
          threshold,
          totalTrades: trades.length,
          winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
          avgReturn,
          xirr: xirrVal * 100,
        });

        console.log(
          `  W=${ws.label} SL=${slMult}x T=${threshold}: ${trades.length} trades, ` +
          `WR=${trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 0}%, ` +
          `Avg=${avgReturn.toFixed(2)}%, XIRR=${(xirrVal * 100).toFixed(1)}%`
        );
      }
    }
  }

  return results;
}

// ==================== REPORT GENERATION ====================

function generateReport(allTrades, monthlyResults, niftyBars, histories, stocks, sensitivityResults) {
  if (!existsSync(REPORT_DIR)) {
    mkdirSync(REPORT_DIR, { recursive: true });
  }

  const totalTrades = allTrades.length;
  const wins = allTrades.filter((t) => t.returnPct > 0).length;
  const losses = allTrades.filter((t) => t.returnPct <= 0).length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const avgReturn = totalTrades > 0
    ? allTrades.reduce((s, t) => s + t.returnPct, 0) / totalTrades
    : 0;

  // Compute XIRR for all trades
  const allCashflows = [];
  for (const t of allTrades) {
    allCashflows.push({ date: new Date(t.scanDate), amount: -t.entryPrice });
    allCashflows.push({ date: new Date(t.exitDate), amount: t.exitPrice });
  }
  allCashflows.sort((a, b) => a.date - b.date);
  const portfolioXIRR = allCashflows.length >= 2 ? xirr(allCashflows) * 100 : 0;

  // Nifty benchmark XIRR (buy at start, sell at end)
  let niftyXIRR = 0;
  if (niftyBars && niftyBars.length > 0) {
    const niftyStart = sliceHistoryUpTo(niftyBars, SCAN_DATES[0].date);
    const niftyEnd = sliceHistoryUpTo(niftyBars, SCAN_DATES[SCAN_DATES.length - 1].date);
    if (niftyStart.length > 0 && niftyEnd.length > 0) {
      const startPrice = niftyStart[niftyStart.length - 1].close;
      const endPrice = niftyEnd[niftyEnd.length - 1].close;
      const niftyCf = [
        { date: new Date(SCAN_DATES[0].date), amount: -startPrice },
        { date: new Date(SCAN_DATES[SCAN_DATES.length - 1].date), amount: endPrice },
      ];
      niftyXIRR = xirr(niftyCf) * 100;
    }
  }

  const alpha = portfolioXIRR - niftyXIRR;

  // ==================== SECTION 1: EXECUTIVE SUMMARY ====================

  let md = "";
  md += "# Paper Trading Simulation Report\n\n";
  md += `**Generated:** ${new Date().toISOString().slice(0, 10)}  \n`;
  md += `**Period:** Apr 2021 - Mar 2026 (${SCAN_DATES.length} monthly scans, 5 years)  \n`;
  md += `**Universe:** Nifty 100 stocks  \n`;
  md += `**Engine:** StarBhai production scoring engine  \n\n`;

  md += "---\n\n";
  md += "## 1. Executive Summary\n\n";
  md += "| Metric | Value |\n";
  md += "|--------|-------|\n";
  md += `| Total Trades | ${totalTrades} |\n`;
  md += `| Wins / Losses | ${wins} / ${losses} |\n`;
  md += `| Win Rate | ${winRate.toFixed(1)}% |\n`;
  md += `| Average Return per Trade | ${avgReturn.toFixed(2)}% |\n`;
  md += `| Portfolio XIRR | ${portfolioXIRR.toFixed(1)}% |\n`;
  md += `| Nifty 50 XIRR (benchmark) | ${niftyXIRR.toFixed(1)}% |\n`;
  md += `| Alpha (vs Nifty) | ${alpha >= 0 ? "+" : ""}${alpha.toFixed(1)}% |\n`;
  md += "\n";

  // ==================== SECTION 2: MONTHLY P&L WATERFALL ====================

  md += "---\n\n";
  md += "## 2. Monthly P&L Waterfall\n\n";
  md += "| Month | Entries | Exits (SL/Target/Time) | Avg Return | Nifty Monthly |\n";
  md += "|-------|---------|----------------------|------------|---------------|\n";

  for (let i = 0; i < SCAN_DATES.length; i++) {
    const scan = SCAN_DATES[i];
    const nextDate = SCAN_DATES[i + 1]?.date || HISTORY_END;
    const mr = monthlyResults[i];

    // Trades that exited in this month window
    const monthExits = allTrades.filter(
      (t) => t.exitDate >= scan.date && t.exitDate < nextDate
    );
    const slExits = monthExits.filter((t) => t.exitReason === "SL_HIT").length;
    const targetExits = monthExits.filter((t) => t.exitReason === "TARGET_HIT").length;
    const timeExits = monthExits.filter((t) => t.exitReason === "TIME_EXIT" || t.exitReason === "NO_DATA").length;
    const monthAvgReturn = monthExits.length > 0
      ? monthExits.reduce((s, t) => s + t.returnPct, 0) / monthExits.length
      : 0;

    // Nifty monthly return
    let niftyMonthly = "N/A";
    if (niftyBars) {
      const nStart = sliceHistoryUpTo(niftyBars, scan.date);
      const nEnd = sliceHistoryUpTo(niftyBars, nextDate);
      if (nStart.length > 0 && nEnd.length > 0) {
        const sp = nStart[nStart.length - 1].close;
        const ep = nEnd[nEnd.length - 1].close;
        niftyMonthly = `${((ep - sp) / sp * 100).toFixed(1)}%`;
      }
    }

    md += `| ${scan.label} | ${mr.entries} | ${monthExits.length} (${slExits}/${targetExits}/${timeExits}) | ${monthAvgReturn.toFixed(2)}% | ${niftyMonthly} |\n`;
  }
  md += "\n";

  // ==================== SECTION 3: CATEGORY DEEP-DIVE ====================

  md += "---\n\n";
  md += "## 3. Category Deep-Dive\n\n";

  const categories = [
    { key: "BUY_NOW", label: "Buy Now" },
    { key: "MID_TERM", label: "Mid-Term" },
    { key: "FUNDAMENTAL", label: "Fundamental" },
  ];

  for (const cat of categories) {
    const catTrades = allTrades.filter((t) => t.category === cat.key);
    if (catTrades.length === 0) {
      md += `### ${cat.label}\n\nNo trades in this category.\n\n`;
      continue;
    }

    const catWins = catTrades.filter((t) => t.returnPct > 0).length;
    const catWinRate = (catWins / catTrades.length) * 100;
    const catAvgReturn = catTrades.reduce((s, t) => s + t.returnPct, 0) / catTrades.length;
    const slHits = catTrades.filter((t) => t.exitReason === "SL_HIT").length;
    const targetHits = catTrades.filter((t) => t.exitReason === "TARGET_HIT").length;
    const timeExits = catTrades.filter((t) => t.exitReason === "TIME_EXIT" || t.exitReason === "NO_DATA").length;

    const best = catTrades.reduce((a, b) => (a.returnPct > b.returnPct ? a : b));
    const worst = catTrades.reduce((a, b) => (a.returnPct < b.returnPct ? a : b));

    // Average holding days
    const avgHoldDays = catTrades.reduce((s, t) => {
      const entry = new Date(t.scanDate);
      const exit = new Date(t.exitDate);
      return s + (exit - entry) / (1000 * 60 * 60 * 24);
    }, 0) / catTrades.length;

    md += `### ${cat.label}\n\n`;
    md += "| Metric | Value |\n";
    md += "|--------|-------|\n";
    md += `| Total Trades | ${catTrades.length} |\n`;
    md += `| Win Rate | ${catWinRate.toFixed(1)}% |\n`;
    md += `| Average Return | ${catAvgReturn.toFixed(2)}% |\n`;
    md += `| SL Exits | ${slHits} (${((slHits / catTrades.length) * 100).toFixed(0)}%) |\n`;
    md += `| Target Exits | ${targetHits} (${((targetHits / catTrades.length) * 100).toFixed(0)}%) |\n`;
    md += `| Time Exits | ${timeExits} (${((timeExits / catTrades.length) * 100).toFixed(0)}%) |\n`;
    md += `| Avg Holding Days | ${avgHoldDays.toFixed(0)} |\n`;
    md += `| Best Trade | ${best.symbol} (${best.scanLabel}): ${best.returnPct >= 0 ? "+" : ""}${best.returnPct.toFixed(2)}% |\n`;
    md += `| Worst Trade | ${worst.symbol} (${worst.scanLabel}): ${worst.returnPct >= 0 ? "+" : ""}${worst.returnPct.toFixed(2)}% |\n`;
    md += "\n";
  }

  // ==================== SECTION 4: SECTOR ANALYSIS ====================

  md += "---\n\n";
  md += "## 4. Sector Analysis\n\n";

  const sectorMap = new Map();
  for (const t of allTrades) {
    if (!sectorMap.has(t.sector)) sectorMap.set(t.sector, []);
    sectorMap.get(t.sector).push(t);
  }

  md += "| Sector | Trades | Win Rate | Avg Return | Best Pick | Worst Pick |\n";
  md += "|--------|--------|----------|------------|-----------|------------|\n";

  const sortedSectors = [...sectorMap.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [sector, trades] of sortedSectors) {
    const sWins = trades.filter((t) => t.returnPct > 0).length;
    const sWinRate = (sWins / trades.length) * 100;
    const sAvg = trades.reduce((s, t) => s + t.returnPct, 0) / trades.length;
    const sBest = trades.reduce((a, b) => (a.returnPct > b.returnPct ? a : b));
    const sWorst = trades.reduce((a, b) => (a.returnPct < b.returnPct ? a : b));
    md += `| ${sector} | ${trades.length} | ${sWinRate.toFixed(0)}% | ${sAvg.toFixed(2)}% | ${sBest.symbol.replace(".NS", "")} (${sBest.returnPct >= 0 ? "+" : ""}${sBest.returnPct.toFixed(1)}%) | ${sWorst.symbol.replace(".NS", "")} (${sWorst.returnPct >= 0 ? "+" : ""}${sWorst.returnPct.toFixed(1)}%) |\n`;
  }
  md += "\n";

  // ==================== SECTION 5: SIGNAL QUALITY ====================

  md += "---\n\n";
  md += "## 5. Signal Quality\n\n";

  // Score vs Return correlation (Pearson)
  md += "### Score vs Return Correlation\n\n";

  const buyNowTrades = allTrades.filter((t) => t.category === "BUY_NOW" && t.combinedScore != null);
  if (buyNowTrades.length > 2) {
    const scores = buyNowTrades.map((t) => t.combinedScore);
    const returns = buyNowTrades.map((t) => t.returnPct);
    const n = scores.length;
    const meanS = scores.reduce((s, v) => s + v, 0) / n;
    const meanR = returns.reduce((s, v) => s + v, 0) / n;
    let cov = 0, varS = 0, varR = 0;
    for (let i = 0; i < n; i++) {
      cov += (scores[i] - meanS) * (returns[i] - meanR);
      varS += (scores[i] - meanS) ** 2;
      varR += (returns[i] - meanR) ** 2;
    }
    const corr = varS > 0 && varR > 0 ? cov / Math.sqrt(varS * varR) : 0;
    md += `**Buy Now combined score vs return:** Pearson r = ${corr.toFixed(3)} (n=${n})  \n`;
    md += corr > 0.3 ? "Positive correlation — higher scores tend to produce better returns.\n\n"
      : corr < -0.3 ? "Negative correlation — higher scores are NOT producing better returns. Investigate scoring logic.\n\n"
      : "Weak correlation — score magnitude is not strongly predictive of return size.\n\n";
  } else {
    md += "Insufficient Buy Now trades for correlation analysis.\n\n";
  }

  // DEEP_VALUE vs QUALITY_GROWTH
  md += "### Verdict Performance Comparison\n\n";

  const deepValueTrades = allTrades.filter((t) => t.fundVerdict === "DEEP_VALUE");
  const qualityGrowthTrades = allTrades.filter((t) => t.fundVerdict === "QUALITY_GROWTH");

  md += "| Verdict | Trades | Win Rate | Avg Return |\n";
  md += "|---------|--------|----------|------------|\n";

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
  md += "\n";

  // ==================== SECTION 6: SENSITIVITY ANALYSIS ====================

  md += "---\n\n";
  md += "## 6. Sensitivity Analysis\n\n";
  md += "Grid: Rows = Tech/Fund weight splits, Columns = SL multiplier x Score threshold\n\n";

  const slMults = [3, 4, 5];
  const thresholds = [55, 60, 65, 70];

  // Build header
  md += "| Weights |";
  for (const sl of slMults) {
    for (const th of thresholds) {
      md += ` SL${sl}x/T${th} |`;
    }
  }
  md += "\n";
  md += "|---------|";
  for (let i = 0; i < slMults.length * thresholds.length; i++) {
    md += "----------|";
  }
  md += "\n";

  const weightLabels = ["30/70", "40/60", "50/50", "60/40"];
  let bestXIRR = -Infinity;
  let bestCombo = "";

  for (const wl of weightLabels) {
    md += `| **${wl}** |`;
    for (const sl of slMults) {
      for (const th of thresholds) {
        const entry = sensitivityResults.find(
          (r) => r.weightLabel === wl && r.slMult === sl && r.threshold === th
        );
        if (entry) {
          const xirrStr = entry.xirr.toFixed(1);
          md += ` ${xirrStr}% |`;
          if (entry.xirr > bestXIRR) {
            bestXIRR = entry.xirr;
            bestCombo = `W=${wl}, SL=${sl}x, Threshold=${th}`;
          }
        } else {
          md += " N/A |";
        }
      }
    }
    md += "\n";
  }

  md += "\n";
  if (bestCombo) {
    md += `**Best performing combination:** ${bestCombo} with XIRR = ${bestXIRR.toFixed(1)}%\n\n`;
  }

  // Also show a detailed table of the top 5 combinations
  md += "### Top 5 Sensitivity Combinations\n\n";
  md += "| Rank | Weights | SL Mult | Threshold | Trades | Win Rate | Avg Return | XIRR |\n";
  md += "|------|---------|---------|-----------|--------|----------|------------|------|\n";

  const sorted = [...sensitivityResults].sort((a, b) => b.xirr - a.xirr);
  for (let i = 0; i < Math.min(5, sorted.length); i++) {
    const r = sorted[i];
    md += `| ${i + 1} | ${r.weightLabel} | ${r.slMult}x | ${r.threshold} | ${r.totalTrades} | ${r.winRate.toFixed(1)}% | ${r.avgReturn.toFixed(2)}% | ${r.xirr.toFixed(1)}% |\n`;
  }
  md += "\n";

  // ==================== SECTION 7: GAP ANALYSIS & RECOMMENDATIONS ====================

  md += "---\n\n";
  md += "## 7. Gap Analysis & Recommendations\n\n";

  // Analyze the data to produce actionable findings
  const slHitRate = allTrades.length > 0
    ? (allTrades.filter((t) => t.exitReason === "SL_HIT").length / allTrades.length) * 100
    : 0;
  const targetHitRate = allTrades.length > 0
    ? (allTrades.filter((t) => t.exitReason === "TARGET_HIT").length / allTrades.length) * 100
    : 0;
  const timeExitRate = 100 - slHitRate - targetHitRate;

  md += "### What's Working Well\n\n";
  if (winRate > 50) {
    md += `- Overall win rate of ${winRate.toFixed(1)}% indicates the scoring engine is selecting stocks with a positive edge.\n`;
  }
  if (targetHitRate > 20) {
    md += `- Target hit rate of ${targetHitRate.toFixed(0)}% shows that the ATR-based targets are achievable within the holding period.\n`;
  }
  if (alpha > 0) {
    md += `- Strategy generated ${alpha.toFixed(1)}% alpha over the Nifty 50 benchmark.\n`;
  }
  const bestCatData = categories
    .map((c) => {
      const ct = allTrades.filter((t) => t.category === c.key);
      return { label: c.label, avg: ct.length > 0 ? ct.reduce((s, t) => s + t.returnPct, 0) / ct.length : 0, count: ct.length };
    })
    .filter((c) => c.count > 0)
    .sort((a, b) => b.avg - a.avg);
  if (bestCatData.length > 0 && bestCatData[0].avg > 0) {
    md += `- Best performing category: **${bestCatData[0].label}** with avg return of ${bestCatData[0].avg.toFixed(2)}%.\n`;
  }
  md += "\n";

  md += "### What's Not Working\n\n";
  if (winRate <= 50) {
    md += `- Win rate of ${winRate.toFixed(1)}% is below breakeven. The scoring engine is not consistently identifying profitable entries.\n`;
  }
  if (slHitRate > 40) {
    md += `- SL hit rate of ${slHitRate.toFixed(0)}% is high. Stop losses may be too tight (ATR multiplier too low) or entries are poorly timed.\n`;
  }
  if (timeExitRate > 50) {
    md += `- ${timeExitRate.toFixed(0)}% of trades exit on time without hitting target or SL. Consider extending holding periods or adjusting targets.\n`;
  }
  if (alpha <= 0) {
    md += `- Strategy underperformed Nifty by ${Math.abs(alpha).toFixed(1)}%. The stock selection does not justify the complexity vs buying the index.\n`;
  }
  const worstCatData = bestCatData.filter((c) => c.avg < 0);
  for (const wc of worstCatData) {
    md += `- **${wc.label}** category has negative avg return (${wc.avg.toFixed(2)}%). Review selection criteria.\n`;
  }
  md += "\n";

  md += "### Specific Parameter Changes Recommended\n\n";
  if (bestCombo) {
    md += `1. **Adopt the best sensitivity combination:** ${bestCombo} (XIRR: ${bestXIRR.toFixed(1)}%).\n`;
  }
  if (slHitRate > 35) {
    md += `2. **Widen stop losses:** Current ATR x4 SL is causing ${slHitRate.toFixed(0)}% SL exits. Test ATR x5 to allow more room for volatility.\n`;
  }
  if (timeExitRate > 40) {
    md += `3. **Tighten targets or extend holding period:** ${timeExitRate.toFixed(0)}% time exits suggest targets are aspirational. Consider reducing ATR target multiplier from 6x to 5x.\n`;
  }
  md += `4. **Deduplication impact:** The deduplication filter prevents the same DEEP_VALUE stocks from appearing monthly. Monitor whether this causes missed re-entry opportunities on stocks that continue to perform.\n`;
  md += "\n";

  md += "### Missing Signals / Indicators to Add\n\n";
  md += "1. **Earnings calendar filter:** Avoid entering positions 1 week before earnings announcements to reduce binary event risk.\n";
  md += "2. **Relative strength vs sector:** Add sector-relative momentum (stock RSI vs sector RSI) to filter out laggards in strong sectors.\n";
  md += "3. **Macro regime overlay:** Incorporate Nifty VIX and yield curve signals to adjust position sizing in high-volatility environments.\n";
  md += "4. **Volume confirmation:** Require above-average volume on the scan date for Buy Now entries to confirm institutional interest.\n";
  md += "5. **Trailing stop mechanism:** Replace fixed SL with a trailing stop (e.g., highest close minus ATR x 3) to lock in profits on trending moves.\n";
  md += "\n";

  md += "### Implementation Priorities\n\n";
  md += "| Priority | Action | Expected Impact | Effort |\n";
  md += "|----------|--------|-----------------|--------|\n";
  md += "| P0 | Adopt best sensitivity parameters | Direct XIRR improvement | Low |\n";
  md += "| P1 | Add trailing stop logic | Reduce time-exit losses, capture more upside | Medium |\n";
  md += "| P2 | Earnings calendar filter | Avoid 5-10% of SL exits from earnings gaps | Medium |\n";
  md += "| P3 | Macro regime overlay | Reduce drawdowns in bear markets | High |\n";
  md += "| P4 | Sector relative strength | Improve stock selection quality | Medium |\n";
  md += "\n";

  // ==================== DISCLAIMER ====================

  md += "---\n\n";
  md += "## Disclaimer\n\n";
  md += "This paper trading simulation has the following limitations:\n\n";
  md += "1. **Historical fundamentals approximation:** The simulation uses the current (Apr 2026) fundamentals.json snapshot for all 60 monthly scans spanning 5 years. In reality, fundamental scores changed significantly over this period as earnings were reported quarterly. This introduces look-ahead bias — the 2021-2023 results should be interpreted with caution. The 2025-2026 results are the most reliable.\n";
  md += "2. **No transaction costs:** Real trading involves brokerage, STT, GST, SEBI charges, and slippage. For Nifty 100 stocks, estimate 0.05-0.10% round-trip costs per trade.\n";
  md += "3. **Survivorship bias:** The Nifty 100 constituent list used is the current composition. Stocks that were removed from the index during the test period (due to poor performance) are not represented.\n";
  md += "4. **No position sizing:** All trades are treated equally. In practice, position sizing based on conviction, volatility, and portfolio risk would significantly affect returns.\n";
  md += "5. **Execution assumption:** Trades are assumed to execute at the closing price on the scan date. In practice, orders may fill at different prices.\n";
  md += "6. **SL/Target fill assumption:** When price gaps through SL or target, the simulation assumes fills at the exact SL/target level. In reality, gap fills would be worse.\n";
  md += "\n";
  md += "---\n\n";
  md += `*Report generated on ${new Date().toISOString()} by StarBhai Paper Trading Engine*\n`;

  writeFileSync(REPORT_PATH, md, "utf-8");
}

// ==================== ENTRY POINT ====================

runSimulation().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
