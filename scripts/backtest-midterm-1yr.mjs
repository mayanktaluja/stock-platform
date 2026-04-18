#!/usr/bin/env node
/**
 * Mid-Term Picks Only — 1-Year Paper Trading
 * ════════════════════════════════════════════
 *
 * Focuses EXCLUSIVELY on Mid-Term picks (2-4 week holds, midTermScore >= 58).
 * Runs with AND without market mood filter for comparison.
 *
 * Usage: node scripts/backtest-midterm-1yr.mjs
 */

import YahooFinance from "yahoo-finance2";
import { analyzeStock, midTermAnalysis } from "../analysis.js";
import { loadFundamentalsFromDisk } from "../fundamentals.js";
import { getNifty100 } from "../stockList.js";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// ═══ CONFIG ═══
const HISTORY_START = "2024-04-01";
const HISTORY_END = "2026-04-16";
const CONCURRENCY = 6;
const MIDTERM_THRESHOLD = 58;
const MAX_PICKS = 10;
const HOLD_DAYS = 20; // 4 weeks

const SCAN_DATES = [
  { label: "Apr 2025", date: "2025-04-07" },
  { label: "May 2025", date: "2025-05-05" },
  { label: "Jun 2025", date: "2025-06-02" },
  { label: "Jul 2025", date: "2025-07-01" },
  { label: "Aug 2025", date: "2025-08-01" },
  { label: "Sep 2025", date: "2025-09-01" },
  { label: "Oct 2025", date: "2025-10-01" },
  { label: "Nov 2025", date: "2025-11-03" },
  { label: "Dec 2025", date: "2025-12-01" },
  { label: "Jan 2026", date: "2026-01-02" },
  { label: "Feb 2026", date: "2026-02-02" },
  { label: "Mar 2026", date: "2026-03-02" },
];

// ═══ HELPERS ═══
function toDateStr(d) { return typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10); }

function addTradingDays(dateStr, days) {
  let d = new Date(dateStr); let count = 0;
  while (count < days) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) count++; }
  return toDateStr(d);
}

// ═══ XIRR ═══
function xirr(cashflows) {
  if (!cashflows || cashflows.length < 2) return 0;
  if (!cashflows.some(c => c.amount > 0) || !cashflows.some(c => c.amount < 0)) return 0;
  function npv(rate) {
    const d0 = cashflows[0].date.getTime();
    return cashflows.reduce((s, cf) => {
      const y = (cf.date.getTime() - d0) / (365.25 * 864e5);
      return s + cf.amount / Math.pow(1 + rate, y);
    }, 0);
  }
  function dnpv(rate) {
    const d0 = cashflows[0].date.getTime();
    return cashflows.reduce((s, cf) => {
      const y = (cf.date.getTime() - d0) / (365.25 * 864e5);
      return y === 0 ? s : s - y * cf.amount / Math.pow(1 + rate, y + 1);
    }, 0);
  }
  let r = 0.1;
  for (let i = 0; i < 200; i++) {
    const f = npv(r), df = dnpv(r);
    if (Math.abs(df) < 1e-12) break;
    const nr = r - f / df;
    if (Math.abs(nr - r) < 1e-9) { r = nr; break; }
    r = Math.max(-0.99, Math.min(10, nr));
  }
  return isFinite(r) ? r : 0;
}

// ═══ DATA FETCH ═══
async function fetchAll(symbols) {
  const data = new Map();
  let cursor = 0, ok = 0, fail = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= symbols.length) return;
      try {
        const res = await yf.chart(symbols[i], { period1: HISTORY_START, period2: HISTORY_END, interval: "1d" });
        const bars = (res?.quotes || []).filter(q => q.close != null).map(q => ({
          date: new Date(q.date), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume,
        }));
        if (bars.length >= 50) { data.set(symbols[i], bars); ok++; } else fail++;
      } catch { fail++; }
      if ((ok + fail) % 20 === 0) console.log(`  Fetched ${ok + fail}/${symbols.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`  Done: ${ok} OK, ${fail} failed\n`);
  return data;
}

// ═══ MARKET MOOD ═══
function computeMood(niftyBars, scanDate) {
  const bars = niftyBars.filter(b => b.date <= new Date(scanDate));
  if (bars.length < 50) return { mood: "UNKNOWN", score: 2, picks: 7 };
  const last = bars[bars.length - 1].close;
  const close5 = bars[bars.length - 6]?.close || last;
  const sma20 = bars.slice(-20).reduce((s, b) => s + b.close, 0) / 20;
  const sma50 = bars.slice(-50).reduce((s, b) => s + b.close, 0) / 50;
  const score = (last > close5 ? 1 : 0) + (last > sma20 ? 1 : 0) + (last > sma50 ? 1 : 0);
  const map = { 3: { mood: "STRONG_BUY", picks: 10 }, 2: { mood: "BUY", picks: 7 }, 1: { mood: "SELECTIVE", picks: 4 }, 0: { mood: "STAY_OUT", picks: 0 } };
  return { ...map[score], score, niftyLevel: last.toFixed(0), ret5d: ((last - close5) / close5 * 100).toFixed(1) + "%" };
}

// ═══ TRACK TRADE (with 2-close SL + trailing stop) ═══
function trackTrade(forwardBars, entryPrice, target, stopLoss, maxExitDate) {
  const maxDate = new Date(maxExitDate); maxDate.setHours(23, 59, 59);
  let slCloseCount = 0;
  let highestClose = entryPrice;
  const atrEst = stopLoss ? (entryPrice - stopLoss) / 4 : 0;
  const trailDist = atrEst * 3;

  for (const bar of forwardBars) {
    if (bar.date > maxDate) break;
    if (bar.close > highestClose) highestClose = bar.close;
    const trailingLevel = highestClose - trailDist;
    const effectiveSL = stopLoss ? Math.max(stopLoss, trailingLevel) : null;

    // 2-close confirmation
    if (effectiveSL && bar.close < effectiveSL) {
      slCloseCount++;
      if (slCloseCount >= 2) return { exitPrice: bar.close, exitDate: bar.date, reason: "SL_CONFIRMED", peakPrice: highestClose };
    } else { slCloseCount = 0; }

    // Trailing stop (when moved above initial SL)
    if (trailDist > 0 && stopLoss && trailingLevel > stopLoss && bar.close < trailingLevel) {
      return { exitPrice: bar.close, exitDate: bar.date, reason: "TRAILING", peakPrice: highestClose };
    }

    // Target hit
    if (target && bar.high >= target) return { exitPrice: target, exitDate: bar.date, reason: "TARGET", peakPrice: highestClose };
  }

  // Time exit
  const validBars = forwardBars.filter(b => b.date <= maxDate);
  if (validBars.length > 0) {
    const last = validBars[validBars.length - 1];
    return { exitPrice: last.close, exitDate: last.date, reason: "EXPIRY", peakPrice: highestClose };
  }
  return { exitPrice: entryPrice, exitDate: maxDate, reason: "NO_DATA", peakPrice: highestClose };
}

// ═══ RUN SIMULATION ═══
function runSim(stocks, histories, niftyBars, useFilter) {
  const allTrades = [];
  const monthlyData = [];

  for (const scan of SCAN_DATES) {
    const scanDate = new Date(scan.date);
    const mood = computeMood(niftyBars, scan.date);
    let maxPicks = MAX_PICKS;

    if (useFilter) {
      if (mood.mood === "STAY_OUT") { monthlyData.push({ ...scan, mood: mood.mood, trades: 0, skipped: true }); continue; }
      maxPicks = mood.picks;
    }

    const candidates = [];
    for (const stock of stocks) {
      const fullBars = histories.get(stock.symbol);
      if (!fullBars) continue;
      const barsUpTo = fullBars.filter(b => b.date <= scanDate);
      if (barsUpTo.length < 50) continue;

      const last = barsUpTo[barsUpTo.length - 1];
      const quote = {
        symbol: stock.symbol, regularMarketPrice: last.close,
        regularMarketPreviousClose: barsUpTo[barsUpTo.length - 2]?.close || last.close,
        regularMarketDayHigh: last.high, regularMarketDayLow: last.low,
        regularMarketVolume: last.volume, regularMarketOpen: last.open,
        fiftyTwoWeekHigh: Math.max(...barsUpTo.slice(-252).map(d => d.high)),
        fiftyTwoWeekLow: Math.min(...barsUpTo.slice(-252).map(d => d.low)),
      };

      const analysis = analyzeStock(barsUpTo, quote);
      if (!analysis || analysis.score == null) continue;
      const closes = barsUpTo.map(b => b.close);
      const midTerm = midTermAnalysis(analysis, quote, closes);

      if (midTerm.score >= MIDTERM_THRESHOLD) {
        candidates.push({
          symbol: stock.symbol, name: stock.name, sector: stock.sector,
          entryPrice: last.close, midTermScore: midTerm.score, rec: midTerm.recommendation,
          stopLoss: midTerm.stopLoss, target: midTerm.target, rr: midTerm.riskReward,
          trend: midTerm.trendAlignment, rsi: analysis.indicators?.rsi,
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
      const trade = { scanDate: scan.label, scanDateRaw: scan.date, ...p, ...exit, returnPct, peakReturn, holdDays, maxExitDate };
      delete trade.forwardBars;
      allTrades.push(trade);
      monthTrades.push(trade);
    }

    const avgRet = monthTrades.length > 0 ? monthTrades.reduce((s, t) => s + t.returnPct, 0) / monthTrades.length : 0;
    monthlyData.push({ ...scan, mood: mood.mood, moodScore: mood.score, niftyLevel: mood.niftyLevel, ret5d: mood.ret5d, trades: monthTrades.length, avgReturn: avgRet, skipped: false });
  }

  return { allTrades, monthlyData };
}

// ═══ MAIN ═══
async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Mid-Term Picks — 1-Year Paper Trading          ║");
  console.log("║  Apr 2025 – Mar 2026 (12 monthly scans)         ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  loadFundamentalsFromDisk();
  const stocks = getNifty100();
  console.log(`Universe: ${stocks.length} stocks\n`);
  console.log("Fetching historical data...");
  const allSymbols = [...stocks.map(s => s.symbol), "^NSEI"];
  const allData = await fetchAll(allSymbols);
  const niftyBars = allData.get("^NSEI"); allData.delete("^NSEI");
  if (!niftyBars) { console.error("FATAL: No Nifty data"); process.exit(1); }

  // Run both modes
  console.log("Running WITH mood filter...");
  const withFilter = runSim(stocks, allData, niftyBars, true);
  console.log("Running WITHOUT mood filter...");
  const noFilter = runSim(stocks, allData, niftyBars, false);

  // Nifty benchmark
  const niftyStart = niftyBars.find(b => b.date >= new Date("2025-04-01"))?.close;
  const niftyEnd = niftyBars[niftyBars.length - 1]?.close;
  const niftyReturn = ((niftyEnd - niftyStart) / niftyStart * 100);

  // Compute XIRRs
  function computeXIRR(trades) {
    const cfs = [];
    for (const t of trades) {
      cfs.push({ date: new Date(t.scanDateRaw), amount: -10000 });
      cfs.push({ date: new Date(t.exitDate), amount: 10000 * (1 + t.returnPct / 100) });
    }
    cfs.sort((a, b) => a.date - b.date);
    return xirr(cfs);
  }

  const xirrWith = computeXIRR(withFilter.allTrades);
  const xirrNo = computeXIRR(noFilter.allTrades);

  // Nifty XIRR (monthly DCA)
  const niftyCfs = [];
  for (const scan of SCAN_DATES) {
    const entry = niftyBars.find(b => b.date >= new Date(scan.date))?.close;
    if (entry) {
      niftyCfs.push({ date: new Date(scan.date), amount: -10000 });
      niftyCfs.push({ date: new Date(niftyBars[niftyBars.length - 1].date), amount: 10000 * (niftyEnd / entry) });
    }
  }
  niftyCfs.sort((a, b) => a.date - b.date);
  const niftyXIRR = xirr(niftyCfs);

  // ═══ PRINT RESULTS ═══
  function printResults(label, result) {
    const t = result.allTrades;
    const wins = t.filter(x => x.returnPct > 0);
    const avgRet = t.reduce((s, x) => s + x.returnPct, 0) / t.length;
    const avgHold = t.reduce((s, x) => s + x.holdDays, 0) / t.length;
    const slHits = t.filter(x => x.reason === "SL_CONFIRMED").length;
    const trailHits = t.filter(x => x.reason === "TRAILING").length;
    const targetHits = t.filter(x => x.reason === "TARGET").length;
    const expiries = t.filter(x => x.reason === "EXPIRY").length;
    const avgPeak = t.reduce((s, x) => s + x.peakReturn, 0) / t.length;
    const best = t.reduce((a, b) => a.returnPct > b.returnPct ? a : b);
    const worst = t.reduce((a, b) => a.returnPct < b.returnPct ? a : b);

    console.log(`\n${"═".repeat(55)}`);
    console.log(`  ${label}`);
    console.log("═".repeat(55));
    console.log(`  Trades:       ${t.length}`);
    console.log(`  Win Rate:     ${wins.length}/${t.length} = ${(wins.length / t.length * 100).toFixed(1)}%`);
    console.log(`  Avg Return:   ${avgRet >= 0 ? "+" : ""}${avgRet.toFixed(2)}%`);
    console.log(`  Avg Peak:     +${avgPeak.toFixed(2)}% (unrealized high during hold)`);
    console.log(`  Avg Hold:     ${avgHold.toFixed(0)} days`);
    console.log(`  Exits:        ${slHits} SL confirmed, ${trailHits} trailing, ${targetHits} target, ${expiries} expiry`);
    console.log(`  Best:         ${best.symbol} ${best.scanDate} ${best.returnPct >= 0 ? "+" : ""}${best.returnPct.toFixed(1)}%`);
    console.log(`  Worst:        ${worst.symbol} ${worst.scanDate} ${worst.returnPct >= 0 ? "+" : ""}${worst.returnPct.toFixed(1)}%`);

    console.log(`\n  Monthly Breakdown:`);
    console.log(`  ${"Month".padEnd(12)} ${"Mood".padEnd(14)} ${"Picks".padStart(5)} ${"Avg Return".padStart(12)} ${"Nifty".padStart(8)}`);
    for (const m of result.monthlyData) {
      if (m.skipped) {
        console.log(`  ${m.label.padEnd(12)} ${"STAY_OUT".padEnd(14)} ${"-".padStart(5)} ${"skipped".padStart(12)}`);
      } else {
        // Get Nifty monthly return
        const mDate = new Date(m.date);
        const nextMonth = new Date(mDate); nextMonth.setMonth(nextMonth.getMonth() + 1);
        const nStart = niftyBars.find(b => b.date >= mDate)?.close;
        const nEnd = niftyBars.find(b => b.date >= nextMonth)?.close || niftyEnd;
        const nRet = nStart ? ((nEnd - nStart) / nStart * 100).toFixed(1) + "%" : "—";
        console.log(`  ${m.label.padEnd(12)} ${m.mood.padEnd(14)} ${String(m.trades).padStart(5)} ${(m.avgReturn >= 0 ? "+" : "") + m.avgReturn.toFixed(2) + "%".padStart(10)} ${nRet.padStart(8)}`);
      }
    }

    // Top 10 best and worst trades
    const sorted = [...t].sort((a, b) => b.returnPct - a.returnPct);
    console.log(`\n  Top 5 Winners:`);
    for (const x of sorted.slice(0, 5)) {
      console.log(`    ${x.symbol.padEnd(18)} ${x.scanDate.padEnd(10)} +${x.returnPct.toFixed(1)}% [${x.reason}] hold=${x.holdDays}d`);
    }
    console.log(`  Bottom 5 Losers:`);
    for (const x of sorted.slice(-5).reverse()) {
      console.log(`    ${x.symbol.padEnd(18)} ${x.scanDate.padEnd(10)} ${x.returnPct.toFixed(1)}% [${x.reason}] hold=${x.holdDays}d`);
    }

    // Sector breakdown
    const sectors = {};
    for (const x of t) {
      const s = x.sector || "Unknown";
      if (!sectors[s]) sectors[s] = { trades: 0, wins: 0, totalRet: 0 };
      sectors[s].trades++; sectors[s].totalRet += x.returnPct;
      if (x.returnPct > 0) sectors[s].wins++;
    }
    const sectorArr = Object.entries(sectors).map(([s, d]) => ({ sector: s, ...d, avgRet: d.totalRet / d.trades, wr: d.wins / d.trades }));
    sectorArr.sort((a, b) => b.avgRet - a.avgRet);
    console.log(`\n  Sector Performance:`);
    console.log(`  ${"Sector".padEnd(20)} ${"Trades".padStart(6)} ${"WinRate".padStart(8)} ${"AvgRet".padStart(8)}`);
    for (const s of sectorArr.slice(0, 12)) {
      console.log(`  ${s.sector.padEnd(20)} ${String(s.trades).padStart(6)} ${(s.wr * 100).toFixed(0).padStart(7)}% ${(s.avgRet >= 0 ? "+" : "") + s.avgRet.toFixed(2) + "%".padStart(7)}`);
    }
  }

  printResults("MID-TERM PICKS — WITH Market Mood Filter", withFilter);
  printResults("MID-TERM PICKS — WITHOUT Market Mood Filter", noFilter);

  // Final comparison
  console.log(`\n\n${"═".repeat(55)}`);
  console.log("  FINAL COMPARISON: Mid-Term vs Nifty 50");
  console.log("═".repeat(55));
  console.log(`\n  ${"".padEnd(30)} ${"XIRR".padStart(10)} ${"Alpha".padStart(10)}`);
  console.log(`  ${"With Mood Filter".padEnd(30)} ${(xirrWith * 100).toFixed(1).padStart(9)}% ${((xirrWith - niftyXIRR) * 100).toFixed(1).padStart(9)}pp`);
  console.log(`  ${"Without Mood Filter".padEnd(30)} ${(xirrNo * 100).toFixed(1).padStart(9)}% ${((xirrNo - niftyXIRR) * 100).toFixed(1).padStart(9)}pp`);
  console.log(`  ${"Nifty 50 (benchmark)".padEnd(30)} ${(niftyXIRR * 100).toFixed(1).padStart(9)}%`);
  console.log(`  ${"Nifty 50 absolute return".padEnd(30)} ${niftyReturn.toFixed(1).padStart(9)}%`);
  console.log(`\n  Mood Filter Value: ${((xirrWith - xirrNo) * 100).toFixed(1)}pp`);

  const skipped = withFilter.monthlyData.filter(m => m.skipped).length;
  console.log(`  Months Skipped (STAY_OUT): ${skipped}/12`);
  if (skipped > 0) {
    console.log(`  Skipped months: ${withFilter.monthlyData.filter(m => m.skipped).map(m => m.label).join(", ")}`);
  }

  console.log(`\n${"═".repeat(55)}\n`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
