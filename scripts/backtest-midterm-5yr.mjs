#!/usr/bin/env node
/**
 * Mid-Term Picks Only -- 5-Year Paper Trading with SIP Tracking
 * ==============================================================
 *
 * Focuses EXCLUSIVELY on Mid-Term picks (2-4 week holds, midTermScore >= 58).
 * Runs 60 monthly scans (Apr 2021 - Mar 2026) with AND without market mood filter.
 * Tracks a Rs 1,00,000/month SIP -- equal weight across all mid-term picks each month.
 * Generates year-by-year portfolio growth and a full markdown report.
 *
 * Usage: node scripts/backtest-midterm-5yr.mjs
 */

import { fileURLToPath } from "url";
import path from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import YahooFinance from "yahoo-finance2";
import { analyzeStock, midTermAnalysis } from "../analysis.js";
import { loadFundamentalsFromDisk } from "../fundamentals.js";
import { getNifty100 } from "../stockList.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORT_DIR = path.join(__dirname, "..", "reports");
const REPORT_PATH = path.join(REPORT_DIR, "midterm-5yr-report.md");

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// ==================== CONFIGURATION ====================

const HISTORY_START = "2019-10-01"; // 18 months warmup before first scan
const HISTORY_END = "2026-04-16";
const NIFTY_SYMBOL = "^NSEI";
const CONCURRENCY = 6;
const MIDTERM_THRESHOLD = 58;
const MAX_PICKS = 10;
const HOLD_DAYS = 20; // 4 weeks / 20 trading days
const SIP_AMOUNT = 100000; // Rs 1,00,000 per month

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

// ==================== SCAN DATES GENERATOR ====================

function generateScanDates() {
  const dates = [];
  const firstDays = { 0: 3, 1: 2, 2: 2, 3: 4, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1, 10: 3, 11: 1 };
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Apr 2021 (startMonth=3) through Mar 2026 (endMonth=2)
  const startYear = 2021, startMonth = 3;
  const endYear = 2026, endMonth = 2;

  for (let y = startYear; y <= endYear; y++) {
    const sm = (y === startYear) ? startMonth : 0;
    const em = (y === endYear) ? endMonth : 11;
    for (let m = sm; m <= em; m++) {
      const day = firstDays[m];
      dates.push({
        label: `${monthNames[m]} ${y}`,
        date: `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        monthIndex: dates.length, // 0-59
      });
    }
  }
  return dates;
}

const SCAN_DATES = generateScanDates();

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
      if ((ok + fail) % 20 === 0) console.log(`  Fetched ${ok + fail}/${symbols.length}`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`  Done: ${ok} OK, ${fail} failed\n`);
  return data;
}

// ==================== MARKET MOOD FILTER ====================

function computeMood(niftyBars, scanDate) {
  const targetDate = new Date(scanDate);
  targetDate.setHours(23, 59, 59, 999);
  const bars = niftyBars.filter(b => b.date <= targetDate);

  if (bars.length < 50) return { mood: "UNKNOWN", score: 2, picks: 7, niftyLevel: 0 };

  const last = bars[bars.length - 1].close;
  const close5 = bars[bars.length - 6]?.close || last;
  const sma20 = bars.slice(-20).reduce((s, b) => s + b.close, 0) / 20;
  const sma50 = bars.slice(-50).reduce((s, b) => s + b.close, 0) / 50;
  const score = (last > close5 ? 1 : 0) + (last > sma20 ? 1 : 0) + (last > sma50 ? 1 : 0);

  const map = {
    3: { mood: "STRONG_BUY", picks: 10 },
    2: { mood: "BUY", picks: 7 },
    1: { mood: "SELECTIVE", picks: 4 },
    0: { mood: "STAY_OUT", picks: 0 },
  };

  return {
    ...map[score], score,
    niftyLevel: last.toFixed(0),
    ret5d: ((last - close5) / close5 * 100).toFixed(1) + "%",
  };
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

// ==================== TRADE TRACKING (2-close SL + trailing stop) ====================

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
        return { exitPrice: bar.close, exitDate: bar.date, reason: "SL_CONFIRMED", peakPrice: highestClose };
      }
    } else { slCloseCount = 0; }

    // Trailing stop (when moved above initial SL)
    if (trailDist > 0 && stopLoss && trailingLevel > stopLoss && bar.close < trailingLevel) {
      return { exitPrice: bar.close, exitDate: bar.date, reason: "TRAILING", peakPrice: highestClose };
    }

    // Target hit
    if (target && bar.high >= target) {
      return { exitPrice: target, exitDate: bar.date, reason: "TARGET", peakPrice: highestClose };
    }
  }

  // Time exit
  const validBars = forwardBars.filter(b => b.date <= maxDate);
  if (validBars.length > 0) {
    const last = validBars[validBars.length - 1];
    return { exitPrice: last.close, exitDate: last.date, reason: "EXPIRY", peakPrice: highestClose };
  }
  return { exitPrice: entryPrice, exitDate: maxDate, reason: "NO_DATA", peakPrice: highestClose };
}

// ==================== RUN SIMULATION ====================

function runSim(stocks, histories, niftyBars, useFilter) {
  const allTrades = [];
  const monthlyData = [];

  for (const scan of SCAN_DATES) {
    const scanDate = new Date(scan.date);
    const mood = computeMood(niftyBars, scan.date);
    let maxPicks = MAX_PICKS;

    if (useFilter) {
      if (mood.mood === "STAY_OUT") {
        monthlyData.push({
          ...scan, mood: mood.mood, moodScore: mood.score,
          niftyLevel: mood.niftyLevel, ret5d: mood.ret5d,
          trades: 0, avgReturn: 0, skipped: true, tradePicks: [],
        });
        continue;
      }
      maxPicks = mood.picks;
    }

    const candidates = [];
    for (const stock of stocks) {
      const fullBars = histories.get(stock.symbol);
      if (!fullBars) continue;
      const barsUpTo = fullBars.filter(b => b.date <= scanDate);
      if (barsUpTo.length < 50) continue;

      const quote = buildMockQuote(barsUpTo, stock.symbol);
      if (!quote) continue;

      const analysis = analyzeStock(barsUpTo, quote);
      if (!analysis || analysis.score == null) continue;
      const closes = barsUpTo.map(b => b.close);
      const midTerm = midTermAnalysis(analysis, quote, closes);

      if (midTerm.score >= MIDTERM_THRESHOLD) {
        candidates.push({
          symbol: stock.symbol, name: stock.name, sector: stock.sector,
          entryPrice: quote.regularMarketPrice,
          midTermScore: midTerm.score, rec: midTerm.recommendation,
          stopLoss: midTerm.stopLoss, target: midTerm.target,
          rr: midTerm.riskReward,
          forwardBars: fullBars.filter(b => b.date > scanDate),
        });
      }
    }

    candidates.sort((a, b) => b.midTermScore - a.midTermScore);
    const picks = candidates.slice(0, maxPicks);
    const maxExitDate = addTradingDays(scan.date, HOLD_DAYS);

    const monthTrades = [];
    for (const p of picks) {
      const exit = trackTrade(p.forwardBars, p.entryPrice, p.target, p.stopLoss, maxExitDate);
      const returnPct = ((exit.exitPrice - p.entryPrice) / p.entryPrice) * 100;
      const peakReturn = ((exit.peakPrice - p.entryPrice) / p.entryPrice) * 100;
      const holdDays = Math.round((new Date(exit.exitDate) - scanDate) / 864e5);
      const trade = {
        scanDate: scan.label, scanDateRaw: scan.date,
        monthIndex: scan.monthIndex,
        symbol: p.symbol, name: p.name, sector: p.sector,
        entryPrice: p.entryPrice, midTermScore: p.midTermScore,
        rec: p.rec, stopLoss: p.stopLoss, target: p.target, rr: p.rr,
        exitPrice: exit.exitPrice, exitDate: exit.exitDate,
        reason: exit.reason, peakPrice: exit.peakPrice,
        returnPct, peakReturn, holdDays, maxExitDate,
      };
      allTrades.push(trade);
      monthTrades.push(trade);
    }

    const avgRet = monthTrades.length > 0
      ? monthTrades.reduce((s, t) => s + t.returnPct, 0) / monthTrades.length
      : 0;

    monthlyData.push({
      ...scan, mood: mood.mood, moodScore: mood.score,
      niftyLevel: mood.niftyLevel, ret5d: mood.ret5d,
      trades: monthTrades.length, avgReturn: avgRet,
      skipped: false, tradePicks: monthTrades,
    });
  }

  return { allTrades, monthlyData };
}

// ==================== SIP TRACKING ====================

function computeSIP(monthlyData) {
  let totalInvested = 0;
  let totalReturned = 0;
  const sipCashflows = []; // for XIRR
  const monthlyDetail = [];
  const yearlyDetail = [];

  // Group months into years (12 months each)
  for (let i = 0; i < monthlyData.length; i++) {
    const m = monthlyData[i];
    const monthInvested = SIP_AMOUNT;
    totalInvested += monthInvested;

    let monthReturned = 0;
    if (m.skipped || m.trades === 0) {
      // No picks this month -- money stays idle (returned as-is)
      monthReturned = monthInvested;
      sipCashflows.push({ date: new Date(m.date), amount: -monthInvested });
      sipCashflows.push({ date: new Date(m.date), amount: monthInvested }); // immediate return (idle)
    } else {
      const perPick = monthInvested / m.trades;
      sipCashflows.push({ date: new Date(m.date), amount: -monthInvested });

      for (const trade of m.tradePicks) {
        const exitAmount = perPick * (1 + trade.returnPct / 100);
        monthReturned += exitAmount;
        sipCashflows.push({ date: new Date(trade.exitDate), amount: exitAmount });
      }
    }

    totalReturned += monthReturned;
    const monthPnL = monthReturned - monthInvested;

    monthlyDetail.push({
      label: m.label,
      date: m.date,
      mood: m.mood,
      picks: m.trades,
      skipped: m.skipped,
      invested: monthInvested,
      returned: monthReturned,
      pnl: monthPnL,
      pnlPct: (monthPnL / monthInvested) * 100,
      avgReturn: m.avgReturn,
      cumulativeInvested: totalInvested,
      cumulativeReturned: totalReturned,
      cumulativePnL: totalReturned - totalInvested,
    });
  }

  // Year-by-year aggregation
  for (let year = 0; year < 5; year++) {
    const startIdx = year * 12;
    const endIdx = Math.min(startIdx + 12, monthlyDetail.length);
    const yearMonths = monthlyDetail.slice(startIdx, endIdx);

    const yearInvested = yearMonths.reduce((s, m) => s + m.invested, 0);
    const yearReturned = yearMonths.reduce((s, m) => s + m.returned, 0);
    const yearPnL = yearReturned - yearInvested;
    const yearReturnPct = (yearPnL / yearInvested) * 100;

    // Cumulative at end of this year
    const lastMonth = yearMonths[yearMonths.length - 1];
    const cumulInvested = lastMonth.cumulativeInvested;
    const cumulReturned = lastMonth.cumulativeReturned;
    const cumulPnL = cumulReturned - cumulInvested;

    yearlyDetail.push({
      year: year + 1,
      yearLabel: `Year ${year + 1}`,
      months: `${yearMonths[0].label} - ${yearMonths[yearMonths.length - 1].label}`,
      yearInvested,
      yearReturned,
      yearPnL,
      yearReturnPct,
      cumulInvested,
      cumulReturned,
      cumulPnL,
      cumulReturnPct: (cumulPnL / cumulInvested) * 100,
      portfolioValue: cumulReturned,
    });
  }

  // Compute XIRR
  sipCashflows.sort((a, b) => a.date - b.date);
  const sipXIRR = xirr(sipCashflows);

  return { monthlyDetail, yearlyDetail, sipXIRR, totalInvested, totalReturned, sipCashflows };
}

// ==================== NIFTY SIP BENCHMARK ====================

function computeNiftySIP(niftyBars) {
  let totalInvested = 0;
  let totalUnits = 0;
  const niftyCashflows = [];
  const yearlyNifty = [];

  const niftyEnd = niftyBars[niftyBars.length - 1];
  const endPrice = niftyEnd.close;

  for (let i = 0; i < SCAN_DATES.length; i++) {
    const scan = SCAN_DATES[i];
    const entryBar = niftyBars.find(b => b.date >= new Date(scan.date));
    if (!entryBar) continue;

    const entryPrice = entryBar.close;
    const units = SIP_AMOUNT / entryPrice;
    totalInvested += SIP_AMOUNT;
    totalUnits += units;

    niftyCashflows.push({ date: new Date(scan.date), amount: -SIP_AMOUNT });
  }

  const portfolioValue = totalUnits * endPrice;
  niftyCashflows.push({ date: new Date(niftyEnd.date), amount: portfolioValue });
  niftyCashflows.sort((a, b) => a.date - b.date);
  const niftyXIRR = xirr(niftyCashflows);

  // Year-by-year Nifty SIP value
  let cumulUnits = 0;
  let cumulInvested = 0;
  for (let year = 0; year < 5; year++) {
    const startIdx = year * 12;
    const endIdx = Math.min(startIdx + 12, SCAN_DATES.length);
    for (let i = startIdx; i < endIdx; i++) {
      const scan = SCAN_DATES[i];
      const entryBar = niftyBars.find(b => b.date >= new Date(scan.date));
      if (entryBar) {
        cumulUnits += SIP_AMOUNT / entryBar.close;
        cumulInvested += SIP_AMOUNT;
      }
    }
    // Value at end of this year period
    const yearEndScan = SCAN_DATES[Math.min(endIdx, SCAN_DATES.length) - 1];
    // Use last trading day of the year period
    const yearEndDate = new Date(yearEndScan.date);
    yearEndDate.setMonth(yearEndDate.getMonth() + 1);
    const yearEndBar = niftyBars.filter(b => b.date <= yearEndDate);
    const yearEndPrice = yearEndBar.length > 0 ? yearEndBar[yearEndBar.length - 1].close : endPrice;
    const sipValue = cumulUnits * yearEndPrice;

    yearlyNifty.push({
      year: year + 1,
      invested: cumulInvested,
      value: sipValue,
      pnl: sipValue - cumulInvested,
      returnPct: ((sipValue - cumulInvested) / cumulInvested) * 100,
    });
  }

  return {
    totalInvested,
    portfolioValue,
    totalPnL: portfolioValue - totalInvested,
    totalReturnPct: ((portfolioValue - totalInvested) / totalInvested) * 100,
    niftyXIRR,
    yearlyNifty,
  };
}

// ==================== REPORT GENERATION ====================

function generateReport(sipWith, sipWithout, simWith, simWithout, niftySIP, niftyBars) {
  if (!existsSync(REPORT_DIR)) {
    mkdirSync(REPORT_DIR, { recursive: true });
  }

  let md = "";

  // ============================================================
  // HEADER
  // ============================================================

  md += "# Mid-Term 5-Year SIP Paper Trading Report\n\n";
  md += `**Generated:** ${new Date().toISOString().slice(0, 10)}  \n`;
  md += `**Data Period:** Oct 2019 - Apr 2026 (6.5 years OHLCV, 18 months warmup)  \n`;
  md += `**Scan Period:** Apr 2021 - Mar 2026 (60 monthly scans)  \n`;
  md += `**Strategy:** Mid-Term picks only (score >= 58, 4-week hold, ATR x4 SL, ATR x5 target)  \n`;
  md += `**SIP Amount:** Rs 1,00,000 / month (equal weight across all picks)  \n`;
  md += `**Universe:** Nifty 100 stocks  \n`;
  md += `**Engine:** StarBhai production scoring engine  \n\n`;

  md += "---\n\n";

  // ============================================================
  // SECTION 1: EXECUTIVE SUMMARY
  // ============================================================

  md += "## 1. Executive Summary\n\n";

  md += "| Metric | With Mood Filter | Without Filter | Nifty SIP |\n";
  md += "|--------|-----------------|----------------|------------|\n";
  md += `| Total Invested | Rs ${fmtRupee(sipWith.totalInvested)} | Rs ${fmtRupee(sipWithout.totalInvested)} | Rs ${fmtRupee(niftySIP.totalInvested)} |\n`;
  md += `| Total Returned | Rs ${fmtRupee(sipWith.totalReturned)} | Rs ${fmtRupee(sipWithout.totalReturned)} | Rs ${fmtRupee(niftySIP.portfolioValue)} |\n`;
  md += `| Absolute P&L | Rs ${fmtRupee(sipWith.totalReturned - sipWith.totalInvested)} | Rs ${fmtRupee(sipWithout.totalReturned - sipWithout.totalInvested)} | Rs ${fmtRupee(niftySIP.totalPnL)} |\n`;
  md += `| Total Return % | ${fmtPct(((sipWith.totalReturned - sipWith.totalInvested) / sipWith.totalInvested) * 100)} | ${fmtPct(((sipWithout.totalReturned - sipWithout.totalInvested) / sipWithout.totalInvested) * 100)} | ${fmtPct(niftySIP.totalReturnPct)} |\n`;
  md += `| XIRR | ${fmtPct(sipWith.sipXIRR * 100)} | ${fmtPct(sipWithout.sipXIRR * 100)} | ${fmtPct(niftySIP.niftyXIRR * 100)} |\n`;
  md += `| Alpha over Nifty (XIRR) | ${fmtPct((sipWith.sipXIRR - niftySIP.niftyXIRR) * 100)} | ${fmtPct((sipWithout.sipXIRR - niftySIP.niftyXIRR) * 100)} | - |\n`;
  md += `| Total Trades | ${simWith.allTrades.length} | ${simWithout.allTrades.length} | - |\n`;

  const winsW = simWith.allTrades.filter(t => t.returnPct > 0).length;
  const winsN = simWithout.allTrades.filter(t => t.returnPct > 0).length;
  md += `| Win Rate | ${(winsW / simWith.allTrades.length * 100).toFixed(1)}% | ${(winsN / simWithout.allTrades.length * 100).toFixed(1)}% | - |\n`;
  md += `| Avg Return/Trade | ${fmtPct(simWith.allTrades.reduce((s, t) => s + t.returnPct, 0) / simWith.allTrades.length)} | ${fmtPct(simWithout.allTrades.reduce((s, t) => s + t.returnPct, 0) / simWithout.allTrades.length)} | - |\n`;
  md += "\n";

  // Mood filter impact
  const filterValue = (sipWith.sipXIRR - sipWithout.sipXIRR) * 100;
  md += `**Mood Filter Value:** ${fmtPct(filterValue)} XIRR impact  \n`;
  const skippedMonths = sipWith.monthlyDetail.filter(m => m.skipped).length;
  md += `**Months Skipped (STAY_OUT):** ${skippedMonths}/60  \n\n`;

  md += "---\n\n";

  // ============================================================
  // SECTION 2: YEAR-BY-YEAR PORTFOLIO GROWTH
  // ============================================================

  md += "## 2. Year-by-Year Portfolio Growth\n\n";

  md += "### With Mood Filter\n\n";
  md += "| Year | Months | Invested (Yr) | Returned (Yr) | Yr P&L | Yr Return | Invested (Cumul) | Portfolio Value | Cumul P&L | Cumul Return | Nifty SIP Value |\n";
  md += "|------|--------|---------------|---------------|--------|-----------|------------------|-----------------|-----------|--------------|------------------|\n";

  for (let i = 0; i < sipWith.yearlyDetail.length; i++) {
    const y = sipWith.yearlyDetail[i];
    const ny = niftySIP.yearlyNifty[i];
    md += `| ${y.yearLabel} | ${y.months} | Rs ${fmtLakh(y.yearInvested)} | Rs ${fmtLakh(y.yearReturned)} | Rs ${fmtLakh(y.yearPnL)} | ${fmtPct(y.yearReturnPct)} | Rs ${fmtLakh(y.cumulInvested)} | Rs ${fmtLakh(y.portfolioValue)} | Rs ${fmtLakh(y.cumulPnL)} | ${fmtPct(y.cumulReturnPct)} | Rs ${fmtLakh(ny.value)} |\n`;
  }
  md += "\n";

  md += "### Without Mood Filter\n\n";
  md += "| Year | Months | Invested (Yr) | Returned (Yr) | Yr P&L | Yr Return | Invested (Cumul) | Portfolio Value | Cumul P&L | Cumul Return | Nifty SIP Value |\n";
  md += "|------|--------|---------------|---------------|--------|-----------|------------------|-----------------|-----------|--------------|------------------|\n";

  for (let i = 0; i < sipWithout.yearlyDetail.length; i++) {
    const y = sipWithout.yearlyDetail[i];
    const ny = niftySIP.yearlyNifty[i];
    md += `| ${y.yearLabel} | ${y.months} | Rs ${fmtLakh(y.yearInvested)} | Rs ${fmtLakh(y.yearReturned)} | Rs ${fmtLakh(y.yearPnL)} | ${fmtPct(y.yearReturnPct)} | Rs ${fmtLakh(y.cumulInvested)} | Rs ${fmtLakh(y.portfolioValue)} | Rs ${fmtLakh(y.cumulPnL)} | ${fmtPct(y.cumulReturnPct)} | Rs ${fmtLakh(ny.value)} |\n`;
  }
  md += "\n";

  // SIP Journey summary
  md += "### Rs 1L SIP Journey (With Filter)\n\n";
  md += "```\n";
  for (const y of sipWith.yearlyDetail) {
    md += `After ${y.yearLabel}: Invested Rs ${fmtLakh(y.cumulInvested)} --> Portfolio Rs ${fmtLakh(y.portfolioValue)} (${fmtPct(y.cumulReturnPct)})\n`;
  }
  md += "```\n\n";

  md += "### Rs 1L SIP Journey (Without Filter)\n\n";
  md += "```\n";
  for (const y of sipWithout.yearlyDetail) {
    md += `After ${y.yearLabel}: Invested Rs ${fmtLakh(y.cumulInvested)} --> Portfolio Rs ${fmtLakh(y.portfolioValue)} (${fmtPct(y.cumulReturnPct)})\n`;
  }
  md += "```\n\n";

  md += "### Nifty 50 SIP Journey (Benchmark)\n\n";
  md += "```\n";
  for (const ny of niftySIP.yearlyNifty) {
    md += `After Year ${ny.year}: Invested Rs ${fmtLakh(ny.invested)} --> Value Rs ${fmtLakh(ny.value)} (${fmtPct(ny.returnPct)})\n`;
  }
  md += "```\n\n";

  md += "---\n\n";

  // ============================================================
  // SECTION 3: MONTHLY DETAIL TABLE
  // ============================================================

  md += "## 3. Monthly Detail (60 Months)\n\n";

  md += "### With Mood Filter\n\n";
  md += "| # | Month | Mood | Picks | Avg Return | Month P&L (Rs) | Cumulative P&L (Rs) |\n";
  md += "|---|-------|------|-------|------------|----------------|--------------------|\n";

  for (let i = 0; i < sipWith.monthlyDetail.length; i++) {
    const m = sipWith.monthlyDetail[i];
    const moodStr = m.skipped ? "STAY_OUT" : m.mood;
    const picksStr = m.skipped ? "-" : String(m.picks);
    const avgRetStr = m.skipped ? "skipped" : fmtPct(m.avgReturn);
    md += `| ${i + 1} | ${m.label} | ${moodStr} | ${picksStr} | ${avgRetStr} | Rs ${fmtRupee(m.pnl)} | Rs ${fmtRupee(m.cumulativePnL)} |\n`;
  }
  md += "\n";

  md += "### Without Mood Filter\n\n";
  md += "| # | Month | Mood | Picks | Avg Return | Month P&L (Rs) | Cumulative P&L (Rs) |\n";
  md += "|---|-------|------|-------|------------|----------------|--------------------|\n";

  for (let i = 0; i < sipWithout.monthlyDetail.length; i++) {
    const m = sipWithout.monthlyDetail[i];
    md += `| ${i + 1} | ${m.label} | ${m.mood} | ${m.picks} | ${fmtPct(m.avgReturn)} | Rs ${fmtRupee(m.pnl)} | Rs ${fmtRupee(m.cumulativePnL)} |\n`;
  }
  md += "\n";

  md += "---\n\n";

  // ============================================================
  // SECTION 4: TRADE STATISTICS
  // ============================================================

  md += "## 4. Trade Statistics\n\n";

  function tradeStats(label, trades) {
    const total = trades.length;
    if (total === 0) return `### ${label}\n\nNo trades.\n\n`;

    const wins = trades.filter(t => t.returnPct > 0);
    const losses = trades.filter(t => t.returnPct <= 0);
    const avgRet = trades.reduce((s, t) => s + t.returnPct, 0) / total;
    const avgHold = trades.reduce((s, t) => s + t.holdDays, 0) / total;
    const avgPeak = trades.reduce((s, t) => s + t.peakReturn, 0) / total;
    const medianRet = [...trades].sort((a, b) => a.returnPct - b.returnPct)[Math.floor(total / 2)].returnPct;

    const slHits = trades.filter(t => t.reason === "SL_CONFIRMED").length;
    const trailHits = trades.filter(t => t.reason === "TRAILING").length;
    const targetHits = trades.filter(t => t.reason === "TARGET").length;
    const expiries = trades.filter(t => t.reason === "EXPIRY").length;
    const noData = trades.filter(t => t.reason === "NO_DATA").length;

    let s = `### ${label}\n\n`;

    s += "| Metric | Value |\n";
    s += "|--------|-------|\n";
    s += `| Total Trades | ${total} |\n`;
    s += `| Wins / Losses | ${wins.length} / ${losses.length} |\n`;
    s += `| Win Rate | ${(wins.length / total * 100).toFixed(1)}% |\n`;
    s += `| Avg Return | ${fmtPct(avgRet)} |\n`;
    s += `| Median Return | ${fmtPct(medianRet)} |\n`;
    s += `| Avg Peak Return | ${fmtPct(avgPeak)} |\n`;
    s += `| Avg Hold Days | ${avgHold.toFixed(1)} |\n`;
    s += `| Best Trade | ${trades.reduce((a, b) => a.returnPct > b.returnPct ? a : b).symbol} ${fmtPct(Math.max(...trades.map(t => t.returnPct)))} |\n`;
    s += `| Worst Trade | ${trades.reduce((a, b) => a.returnPct < b.returnPct ? a : b).symbol} ${fmtPct(Math.min(...trades.map(t => t.returnPct)))} |\n`;
    s += "\n";

    s += "**Exit Distribution:**\n\n";
    s += "| Exit Reason | Count | % | Avg Return |\n";
    s += "|------------|-------|---|------------|\n";

    const exitGroups = [
      { key: "SL_CONFIRMED", label: "Stop Loss (2-close)" },
      { key: "TRAILING", label: "Trailing Stop" },
      { key: "TARGET", label: "Target Hit" },
      { key: "EXPIRY", label: "Time Expiry" },
      { key: "NO_DATA", label: "No Data" },
    ];
    for (const eg of exitGroups) {
      const group = trades.filter(t => t.reason === eg.key);
      if (group.length === 0) continue;
      const gAvg = group.reduce((s2, t) => s2 + t.returnPct, 0) / group.length;
      s += `| ${eg.label} | ${group.length} | ${(group.length / total * 100).toFixed(1)}% | ${fmtPct(gAvg)} |\n`;
    }
    s += "\n";

    // Top 10 winners
    const sorted = [...trades].sort((a, b) => b.returnPct - a.returnPct);
    s += "**Top 10 Winners:**\n\n";
    s += "| Symbol | Month | Entry | Exit | Return | Exit Reason | Hold |\n";
    s += "|--------|-------|-------|------|--------|-------------|------|\n";
    for (const t of sorted.slice(0, 10)) {
      s += `| ${t.symbol.replace(".NS", "")} | ${t.scanDate} | Rs ${t.entryPrice.toFixed(0)} | Rs ${t.exitPrice.toFixed(0)} | ${fmtPct(t.returnPct)} | ${t.reason} | ${t.holdDays}d |\n`;
    }
    s += "\n";

    // Bottom 10 losers
    s += "**Bottom 10 Losers:**\n\n";
    s += "| Symbol | Month | Entry | Exit | Return | Exit Reason | Hold |\n";
    s += "|--------|-------|-------|------|--------|-------------|------|\n";
    for (const t of sorted.slice(-10).reverse()) {
      s += `| ${t.symbol.replace(".NS", "")} | ${t.scanDate} | Rs ${t.entryPrice.toFixed(0)} | Rs ${t.exitPrice.toFixed(0)} | ${fmtPct(t.returnPct)} | ${t.reason} | ${t.holdDays}d |\n`;
    }
    s += "\n";

    // Sector performance
    const sectorMap = new Map();
    for (const t of trades) {
      const sec = t.sector || "Unknown";
      if (!sectorMap.has(sec)) sectorMap.set(sec, []);
      sectorMap.get(sec).push(t);
    }
    const sectorArr = [...sectorMap.entries()].map(([sec, tr]) => ({
      sector: sec,
      trades: tr.length,
      wins: tr.filter(t => t.returnPct > 0).length,
      totalRet: tr.reduce((s2, t) => s2 + t.returnPct, 0),
    })).sort((a, b) => (b.totalRet / b.trades) - (a.totalRet / a.trades));

    s += "**Sector Performance:**\n\n";
    s += "| Sector | Trades | Win Rate | Avg Return | Total P&L Contribution |\n";
    s += "|--------|--------|----------|------------|------------------------|\n";
    for (const sec of sectorArr) {
      const avgR = sec.totalRet / sec.trades;
      const wr = (sec.wins / sec.trades * 100).toFixed(0);
      s += `| ${sec.sector} | ${sec.trades} | ${wr}% | ${fmtPct(avgR)} | ${fmtPct(sec.totalRet)} |\n`;
    }
    s += "\n";

    return s;
  }

  md += tradeStats("With Mood Filter", simWith.allTrades);
  md += tradeStats("Without Mood Filter", simWithout.allTrades);

  md += "---\n\n";

  // ============================================================
  // SECTION 5: WITH FILTER VS WITHOUT FILTER COMPARISON
  // ============================================================

  md += "## 5. With Filter vs Without Filter Comparison\n\n";

  const metricsComparison = [
    { metric: "Total Trades", w: simWith.allTrades.length, n: simWithout.allTrades.length },
    { metric: "Win Rate", w: (winsW / simWith.allTrades.length * 100).toFixed(1) + "%", n: (winsN / simWithout.allTrades.length * 100).toFixed(1) + "%" },
    { metric: "Avg Return/Trade", w: fmtPct(simWith.allTrades.reduce((s, t) => s + t.returnPct, 0) / simWith.allTrades.length), n: fmtPct(simWithout.allTrades.reduce((s, t) => s + t.returnPct, 0) / simWithout.allTrades.length) },
    { metric: "Total Invested", w: "Rs " + fmtLakh(sipWith.totalInvested), n: "Rs " + fmtLakh(sipWithout.totalInvested) },
    { metric: "Total Returned", w: "Rs " + fmtLakh(sipWith.totalReturned), n: "Rs " + fmtLakh(sipWithout.totalReturned) },
    { metric: "Total P&L", w: "Rs " + fmtLakh(sipWith.totalReturned - sipWith.totalInvested), n: "Rs " + fmtLakh(sipWithout.totalReturned - sipWithout.totalInvested) },
    { metric: "XIRR", w: fmtPct(sipWith.sipXIRR * 100), n: fmtPct(sipWithout.sipXIRR * 100) },
    { metric: "Months Skipped", w: sipWith.monthlyDetail.filter(m => m.skipped).length, n: 0 },
  ];

  md += "| Metric | With Filter | Without Filter | Difference |\n";
  md += "|--------|------------|----------------|------------|\n";
  for (const mc of metricsComparison) {
    md += `| ${mc.metric} | ${mc.w} | ${mc.n} | - |\n`;
  }
  md += "\n";

  // Year-by-year comparison
  md += "### Year-by-Year Return Comparison\n\n";
  md += "| Year | With Filter Return | Without Filter Return | Nifty SIP Return | Filter Better? |\n";
  md += "|------|--------------------|-----------------------|------------------|----------------|\n";

  for (let i = 0; i < 5; i++) {
    const yw = sipWith.yearlyDetail[i];
    const yn = sipWithout.yearlyDetail[i];
    const ny = niftySIP.yearlyNifty[i];
    const filterBetter = yw.yearReturnPct > yn.yearReturnPct ? "YES" : "NO";
    md += `| Year ${i + 1} | ${fmtPct(yw.yearReturnPct)} | ${fmtPct(yn.yearReturnPct)} | ${fmtPct(ny.returnPct)} | ${filterBetter} |\n`;
  }
  md += "\n";

  // Exit reason comparison
  md += "### Exit Reason Distribution Comparison\n\n";
  md += "| Exit Reason | With Filter | % | Without Filter | % |\n";
  md += "|------------|-------------|---|----------------|---|\n";
  const reasons = ["SL_CONFIRMED", "TRAILING", "TARGET", "EXPIRY", "NO_DATA"];
  for (const r of reasons) {
    const cw = simWith.allTrades.filter(t => t.reason === r).length;
    const cn = simWithout.allTrades.filter(t => t.reason === r).length;
    const pw = simWith.allTrades.length > 0 ? (cw / simWith.allTrades.length * 100).toFixed(1) : "0.0";
    const pn = simWithout.allTrades.length > 0 ? (cn / simWithout.allTrades.length * 100).toFixed(1) : "0.0";
    md += `| ${r} | ${cw} | ${pw}% | ${cn} | ${pn}% |\n`;
  }
  md += "\n";

  md += "---\n\n";

  // ============================================================
  // SECTION 6: KEY INSIGHTS
  // ============================================================

  md += "## 6. Key Insights\n\n";

  // Is mid-term consistently profitable across all 5 years?
  md += "### Consistency Across Years\n\n";

  let profitableYearsW = 0, profitableYearsN = 0;
  for (let i = 0; i < 5; i++) {
    if (sipWith.yearlyDetail[i].yearPnL > 0) profitableYearsW++;
    if (sipWithout.yearlyDetail[i].yearPnL > 0) profitableYearsN++;
  }

  md += `- **With filter:** ${profitableYearsW}/5 years profitable\n`;
  md += `- **Without filter:** ${profitableYearsN}/5 years profitable\n`;

  // Best and worst years
  const bestYearW = sipWith.yearlyDetail.reduce((a, b) => a.yearReturnPct > b.yearReturnPct ? a : b);
  const worstYearW = sipWith.yearlyDetail.reduce((a, b) => a.yearReturnPct < b.yearReturnPct ? a : b);
  const bestYearN = sipWithout.yearlyDetail.reduce((a, b) => a.yearReturnPct > b.yearReturnPct ? a : b);
  const worstYearN = sipWithout.yearlyDetail.reduce((a, b) => a.yearReturnPct < b.yearReturnPct ? a : b);

  md += `- **Best year (with filter):** ${bestYearW.yearLabel} at ${fmtPct(bestYearW.yearReturnPct)}\n`;
  md += `- **Worst year (with filter):** ${worstYearW.yearLabel} at ${fmtPct(worstYearW.yearReturnPct)}\n`;
  md += `- **Best year (no filter):** ${bestYearN.yearLabel} at ${fmtPct(bestYearN.yearReturnPct)}\n`;
  md += `- **Worst year (no filter):** ${worstYearN.yearLabel} at ${fmtPct(worstYearN.yearReturnPct)}\n\n`;

  // Does the mood filter help for mid-term specifically?
  md += "### Mood Filter Effectiveness for Mid-Term\n\n";

  if (filterValue > 0) {
    md += `The mood filter **improves** mid-term XIRR by ${fmtPct(filterValue)}.  \n`;
    md += `It skipped ${skippedMonths} months, avoiding potential drawdowns during bearish periods.  \n`;
  } else if (filterValue < -1) {
    md += `The mood filter **hurts** mid-term XIRR by ${fmtPct(Math.abs(filterValue))}.  \n`;
    md += `It skipped ${skippedMonths} months, but some of those months had profitable mid-term opportunities.  \n`;
    md += `Consider: mid-term picks may be resilient enough to trade through bearish macro conditions.  \n`;
  } else {
    md += `The mood filter has **negligible impact** on mid-term XIRR (${fmtPct(filterValue)}).  \n`;
    md += `Mid-term picks appear to perform similarly regardless of macro mood.  \n`;
  }
  md += "\n";

  // Validate STAY_OUT months
  const stayOutMonths = sipWith.monthlyDetail.filter(m => m.skipped);
  if (stayOutMonths.length > 0) {
    md += "### STAY_OUT Months Validation\n\n";
    md += "What happened to the no-filter picks during months the filter said STAY_OUT?\n\n";
    md += "| Month | No-Filter Picks | No-Filter Avg Return | Filter Correct? |\n";
    md += "|-------|----------------|---------------------|------------------|\n";

    let correctCount = 0;
    for (const m of stayOutMonths) {
      const noFilterMonth = sipWithout.monthlyDetail.find(n => n.label === m.label);
      if (noFilterMonth) {
        const correct = noFilterMonth.avgReturn < 0;
        if (correct) correctCount++;
        md += `| ${m.label} | ${noFilterMonth.picks} | ${fmtPct(noFilterMonth.avgReturn)} | ${correct ? "YES (loss avoided)" : "NO (missed gains)"} |\n`;
      }
    }
    md += "\n";

    const accuracy = stayOutMonths.length > 0 ? (correctCount / stayOutMonths.length * 100).toFixed(0) : "0";
    md += `**Filter accuracy for mid-term:** ${correctCount}/${stayOutMonths.length} = ${accuracy}% of STAY_OUT months actually had negative mid-term returns.  \n\n`;
  }

  // Alpha over Nifty
  md += "### Alpha Over Nifty 50 SIP\n\n";
  const alphaW = (sipWith.sipXIRR - niftySIP.niftyXIRR) * 100;
  const alphaN = (sipWithout.sipXIRR - niftySIP.niftyXIRR) * 100;

  md += `- **With filter XIRR alpha:** ${fmtPct(alphaW)} over Nifty SIP\n`;
  md += `- **Without filter XIRR alpha:** ${fmtPct(alphaN)} over Nifty SIP\n`;
  md += `- **Nifty SIP final value:** Rs ${fmtLakh(niftySIP.portfolioValue)} on Rs ${fmtLakh(niftySIP.totalInvested)} invested\n`;

  if (alphaW > 0 && alphaN > 0) {
    md += `- Mid-term strategy generates positive alpha over passive Nifty investing in both modes\n`;
  } else if (alphaW > 0) {
    md += `- Mid-term strategy generates positive alpha only with the mood filter\n`;
  } else if (alphaN > 0) {
    md += `- Mid-term strategy generates positive alpha only without the mood filter\n`;
  } else {
    md += `- Mid-term strategy underperforms passive Nifty SIP -- consider adjustments\n`;
  }
  md += "\n";

  md += "---\n\n";

  // ============================================================
  // DISCLAIMER
  // ============================================================

  md += "## Disclaimer\n\n";
  md += "This is a **paper trading simulation** with the following limitations:\n\n";
  md += "- **Survivorship bias:** Uses current Nifty 100 constituents; stocks that were delisted or removed are not included.\n";
  md += "- **Look-ahead bias in stock list:** The Nifty 100 composition changes over time; this simulation uses today's list for all 5 years.\n";
  md += "- **No slippage or transaction costs:** Real execution would involve brokerage, STT, impact cost, and bid-ask spread.\n";
  md += "- **No compounding reinvestment:** Idle capital from STAY_OUT months earns 0% (in reality, it could be parked in liquid funds).\n";
  md += "- **Yahoo Finance data quality:** Adjusted prices may have gaps, especially around splits and bonuses.\n";
  md += "- **Indicator computation:** Indicators are computed on available data; missing bars are skipped, not interpolated.\n";
  md += "- **SIP assumption:** Equal weight across all picks each month; real portfolio would need rebalancing.\n\n";
  md += "*Generated by StarBhai Mid-Term 5-Year SIP Backtest Engine*\n";

  writeFileSync(REPORT_PATH, md, "utf-8");
  return md;
}

// ==================== CONSOLE OUTPUT ====================

function printConsoleResults(label, sip, sim, niftySIP) {
  const trades = sim.allTrades;
  const total = trades.length;
  const wins = trades.filter(t => t.returnPct > 0);
  const avgRet = trades.reduce((s, t) => s + t.returnPct, 0) / total;
  const avgHold = trades.reduce((s, t) => s + t.holdDays, 0) / total;
  const slHits = trades.filter(t => t.reason === "SL_CONFIRMED").length;
  const trailHits = trades.filter(t => t.reason === "TRAILING").length;
  const targetHits = trades.filter(t => t.reason === "TARGET").length;
  const expiries = trades.filter(t => t.reason === "EXPIRY").length;

  console.log(`\n${"=".repeat(65)}`);
  console.log(`  ${label}`);
  console.log("=".repeat(65));

  console.log(`\n  -- Trade Summary --`);
  console.log(`  Trades:       ${total}`);
  console.log(`  Win Rate:     ${wins.length}/${total} = ${(wins.length / total * 100).toFixed(1)}%`);
  console.log(`  Avg Return:   ${fmtPct(avgRet)}`);
  console.log(`  Avg Hold:     ${avgHold.toFixed(0)} days`);
  console.log(`  Exits:        ${slHits} SL, ${trailHits} trailing, ${targetHits} target, ${expiries} expiry`);

  console.log(`\n  -- SIP Summary --`);
  console.log(`  Total Invested:  Rs ${fmtRupee(sip.totalInvested)} (${fmtLakh(sip.totalInvested)})`);
  console.log(`  Total Returned:  Rs ${fmtRupee(sip.totalReturned)} (${fmtLakh(sip.totalReturned)})`);
  console.log(`  Absolute P&L:    Rs ${fmtRupee(sip.totalReturned - sip.totalInvested)} (${fmtLakh(sip.totalReturned - sip.totalInvested)})`);
  console.log(`  Total Return:    ${fmtPct(((sip.totalReturned - sip.totalInvested) / sip.totalInvested) * 100)}`);
  console.log(`  XIRR:            ${fmtPct(sip.sipXIRR * 100)}`);

  console.log(`\n  -- Year-by-Year Portfolio Growth --`);
  console.log(`  ${"Year".padEnd(8)} ${"Invested".padStart(12)} ${"Portfolio".padStart(12)} ${"P&L".padStart(12)} ${"Return".padStart(10)}`);
  for (const y of sip.yearlyDetail) {
    console.log(`  ${y.yearLabel.padEnd(8)} ${("Rs " + fmtLakh(y.cumulInvested)).padStart(12)} ${("Rs " + fmtLakh(y.portfolioValue)).padStart(12)} ${("Rs " + fmtLakh(y.cumulPnL)).padStart(12)} ${fmtPct(y.cumulReturnPct).padStart(10)}`);
  }

  // Top 5 winners/losers
  const sorted = [...trades].sort((a, b) => b.returnPct - a.returnPct);
  console.log(`\n  Top 5 Winners:`);
  for (const t of sorted.slice(0, 5)) {
    console.log(`    ${t.symbol.replace(".NS", "").padEnd(16)} ${t.scanDate.padEnd(10)} ${fmtPct(t.returnPct).padStart(8)} [${t.reason}] ${t.holdDays}d`);
  }
  console.log(`  Bottom 5 Losers:`);
  for (const t of sorted.slice(-5).reverse()) {
    console.log(`    ${t.symbol.replace(".NS", "").padEnd(16)} ${t.scanDate.padEnd(10)} ${fmtPct(t.returnPct).padStart(8)} [${t.reason}] ${t.holdDays}d`);
  }
}

// ==================== MAIN ====================

async function main() {
  console.log("=".repeat(65));
  console.log("  Mid-Term Picks -- 5-Year SIP Paper Trading Simulation");
  console.log("  Apr 2021 - Mar 2026 (60 monthly scans)");
  console.log("  SIP: Rs 1,00,000/month");
  console.log("=".repeat(65));
  console.log();

  console.log(`Scan dates generated: ${SCAN_DATES.length} months`);
  console.log(`First scan: ${SCAN_DATES[0].label} (${SCAN_DATES[0].date})`);
  console.log(`Last scan:  ${SCAN_DATES[SCAN_DATES.length - 1].label} (${SCAN_DATES[SCAN_DATES.length - 1].date})\n`);

  // Load fundamentals
  loadFundamentalsFromDisk();

  // Get stock universe
  const stocks = getNifty100();
  console.log(`Universe: ${stocks.length} stocks\n`);

  // Fetch all historical data
  console.log("Fetching 6+ years of historical data (Oct 2019 - Apr 2026)...");
  const allSymbols = [...stocks.map(s => s.symbol), NIFTY_SYMBOL];
  const allData = await fetchAll(allSymbols);

  const niftyBars = allData.get(NIFTY_SYMBOL);
  allData.delete(NIFTY_SYMBOL);
  if (!niftyBars) { console.error("FATAL: No Nifty 50 data"); process.exit(1); }
  console.log(`Nifty 50 bars: ${niftyBars.length} (${toDateStr(niftyBars[0].date)} to ${toDateStr(niftyBars[niftyBars.length - 1].date)})\n`);

  // Run simulations
  console.log("Running simulation WITH mood filter...");
  const simWith = runSim(stocks, allData, niftyBars, true);
  console.log(`  ${simWith.allTrades.length} trades across ${simWith.monthlyData.filter(m => !m.skipped).length} active months\n`);

  console.log("Running simulation WITHOUT mood filter...");
  const simWithout = runSim(stocks, allData, niftyBars, false);
  console.log(`  ${simWithout.allTrades.length} trades across ${simWithout.monthlyData.filter(m => !m.skipped).length} active months\n`);

  // Compute SIP tracking
  console.log("Computing SIP tracking (with filter)...");
  const sipWith = computeSIP(simWith.monthlyData);

  console.log("Computing SIP tracking (without filter)...");
  const sipWithout = computeSIP(simWithout.monthlyData);

  // Nifty SIP benchmark
  console.log("Computing Nifty 50 SIP benchmark...\n");
  const niftySIP = computeNiftySIP(niftyBars);

  // Print console results
  printConsoleResults("MID-TERM WITH MOOD FILTER", sipWith, simWith, niftySIP);
  printConsoleResults("MID-TERM WITHOUT MOOD FILTER", sipWithout, simWithout, niftySIP);

  // Final comparison
  console.log(`\n\n${"=".repeat(65)}`);
  console.log("  FINAL COMPARISON: Mid-Term SIP vs Nifty 50 SIP");
  console.log("=".repeat(65));

  console.log(`\n  ${"Strategy".padEnd(30)} ${"Invested".padStart(14)} ${"Value".padStart(14)} ${"P&L".padStart(14)} ${"XIRR".padStart(10)}`);
  console.log(`  ${"-".repeat(82)}`);

  const pnlW = sipWith.totalReturned - sipWith.totalInvested;
  const pnlN = sipWithout.totalReturned - sipWithout.totalInvested;

  console.log(`  ${"Mid-Term (with filter)".padEnd(30)} ${"Rs " + fmtLakh(sipWith.totalInvested)} ${"Rs " + fmtLakh(sipWith.totalReturned)} ${"Rs " + fmtLakh(pnlW)} ${fmtPct(sipWith.sipXIRR * 100).padStart(10)}`);
  console.log(`  ${"Mid-Term (no filter)".padEnd(30)} ${"Rs " + fmtLakh(sipWithout.totalInvested)} ${"Rs " + fmtLakh(sipWithout.totalReturned)} ${"Rs " + fmtLakh(pnlN)} ${fmtPct(sipWithout.sipXIRR * 100).padStart(10)}`);
  console.log(`  ${"Nifty 50 SIP (benchmark)".padEnd(30)} ${"Rs " + fmtLakh(niftySIP.totalInvested)} ${"Rs " + fmtLakh(niftySIP.portfolioValue)} ${"Rs " + fmtLakh(niftySIP.totalPnL)} ${fmtPct(niftySIP.niftyXIRR * 100).padStart(10)}`);

  console.log(`\n  Alpha (with filter):    ${fmtPct((sipWith.sipXIRR - niftySIP.niftyXIRR) * 100)} over Nifty`);
  console.log(`  Alpha (no filter):      ${fmtPct((sipWithout.sipXIRR - niftySIP.niftyXIRR) * 100)} over Nifty`);
  console.log(`  Mood filter value:      ${fmtPct((sipWith.sipXIRR - sipWithout.sipXIRR) * 100)} XIRR impact`);

  const skipped = simWith.monthlyData.filter(m => m.skipped).length;
  console.log(`  Months skipped:         ${skipped}/60`);
  if (skipped > 0) {
    console.log(`  Skipped months:         ${simWith.monthlyData.filter(m => m.skipped).map(m => m.label).join(", ")}`);
  }

  // Generate markdown report
  console.log(`\nGenerating report...`);
  generateReport(sipWith, sipWithout, simWith, simWithout, niftySIP, niftyBars);
  console.log(`Report saved to: ${REPORT_PATH}`);

  console.log(`\n${"=".repeat(65)}\n`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
