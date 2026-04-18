#!/usr/bin/env node
/**
 * ₹2 Lakh Starting Capital — Compounding Paper Trading
 * ═════════════════════════════════════════════════════
 *
 * Two parallel simulations with ₹2,00,000 starting capital:
 *   Case A: Buy Nifty 50 index and hold
 *   Case B: Trade mid-term picks monthly, re-invest ALL returned capital
 *
 * The key difference from previous backtests: COMPOUNDING. When a mid-term
 * trade returns ₹10,700 from a ₹10,000 deployment, that ₹10,700 goes back
 * into the pool and is available for next month's trades. Gains compound.
 *
 * Runs for 1-year and 2-year horizons.
 *
 * Usage: node scripts/backtest-2L-capital.mjs
 */

import YahooFinance from "yahoo-finance2";
import { analyzeStock, midTermAnalysis } from "../analysis.js";
import { loadFundamentalsFromDisk } from "../fundamentals.js";
import { getNifty100 } from "../stockList.js";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const STARTING_CAPITAL = 200000; // ₹2 lakhs
const HISTORY_START = "2023-10-01";
const HISTORY_END = "2026-04-16";
const CONCURRENCY = 6;
const MIDTERM_THRESHOLD = 58;
const MAX_PICKS = 10;
const HOLD_DAYS = 20;

// 2-year scan dates: Apr 2024 – Mar 2026
function generateScanDates() {
  const dates = [];
  const fd = { 0:3, 1:2, 2:2, 3:4, 4:3, 5:2, 6:1, 7:1, 8:1, 9:1, 10:3, 11:1 };
  const mn = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  for (let y = 2024; y <= 2026; y++) {
    const sm = y === 2024 ? 3 : 0;
    const em = y === 2026 ? 2 : 11;
    for (let m = sm; m <= em; m++) {
      dates.push({ label: `${mn[m]} ${y}`, date: `${y}-${String(m+1).padStart(2,"0")}-${String(fd[m]).padStart(2,"0")}` });
    }
  }
  return dates;
}

const ALL_SCANS = generateScanDates(); // 24 months

// ═══ HELPERS ═══
function toDateStr(d) { return typeof d === "string" ? d.slice(0,10) : d.toISOString().slice(0,10); }
function addTradingDays(ds, n) {
  let d = new Date(ds), c = 0;
  while (c < n) { d.setDate(d.getDate()+1); if (d.getDay()!==0 && d.getDay()!==6) c++; }
  return toDateStr(d);
}

// ═══ DATA FETCH ═══
async function fetchAll(symbols) {
  const data = new Map(); let cursor = 0, ok = 0, fail = 0;
  async function worker() {
    while (true) {
      const i = cursor++; if (i >= symbols.length) return;
      try {
        const res = await yf.chart(symbols[i], { period1: HISTORY_START, period2: HISTORY_END, interval: "1d" });
        const bars = (res?.quotes||[]).filter(q=>q.close!=null).map(q=>({
          date: new Date(q.date), open:q.open, high:q.high, low:q.low, close:q.close, volume:q.volume
        }));
        if (bars.length >= 50) { data.set(symbols[i], bars); ok++; } else fail++;
      } catch { fail++; }
      if ((ok+fail) % 20 === 0) console.log(`  Fetched ${ok+fail}/${symbols.length}`);
    }
  }
  await Promise.all(Array.from({length:CONCURRENCY}, ()=>worker()));
  console.log(`  Done: ${ok} OK, ${fail} failed\n`);
  return data;
}

// ═══ TRADE TRACKING ═══
function trackTrade(forwardBars, entryPrice, target, stopLoss, maxExitDateStr) {
  const maxDate = new Date(maxExitDateStr); maxDate.setHours(23,59,59);
  let slCount = 0, highClose = entryPrice;
  const atrEst = stopLoss ? (entryPrice - stopLoss) / 4 : 0;
  const trailDist = atrEst * 3;
  for (const bar of forwardBars) {
    if (bar.date > maxDate) break;
    if (bar.close > highClose) highClose = bar.close;
    const trail = highClose - trailDist;
    const eSL = stopLoss ? Math.max(stopLoss, trail) : null;
    if (eSL && bar.close < eSL) { slCount++; if (slCount >= 2) return { exitPrice: bar.close, exitDate: bar.date, reason: "SL" }; } else slCount = 0;
    if (trailDist > 0 && stopLoss && trail > stopLoss && bar.close < trail) return { exitPrice: bar.close, exitDate: bar.date, reason: "TRAIL" };
    if (target && bar.high >= target) return { exitPrice: target, exitDate: bar.date, reason: "TARGET" };
  }
  const valid = forwardBars.filter(b => b.date <= maxDate);
  if (valid.length > 0) return { exitPrice: valid[valid.length-1].close, exitDate: valid[valid.length-1].date, reason: "EXPIRY" };
  return { exitPrice: entryPrice, exitDate: maxDate, reason: "NO_DATA" };
}

// ═══ MAIN SIMULATION ═══
function runCompoundingSim(stocks, histories, scanDates) {
  let capital = STARTING_CAPITAL;
  const log = [];
  const allTrades = [];
  let totalDeployed = 0;
  let totalReturned = 0;

  for (const scan of scanDates) {
    const scanDate = new Date(scan.date);
    const capitalBefore = capital;

    // Find mid-term candidates
    const candidates = [];
    for (const stock of stocks) {
      const fullBars = histories.get(stock.symbol);
      if (!fullBars) continue;
      const barsUpTo = fullBars.filter(b => b.date <= scanDate);
      if (barsUpTo.length < 50) continue;

      const last = barsUpTo[barsUpTo.length - 1];
      const quote = {
        symbol: stock.symbol, regularMarketPrice: last.close,
        regularMarketPreviousClose: barsUpTo.length >= 2 ? barsUpTo[barsUpTo.length-2].close : last.close,
        regularMarketDayHigh: last.high, regularMarketDayLow: last.low,
        regularMarketVolume: last.volume, regularMarketOpen: last.open,
        fiftyTwoWeekHigh: Math.max(...barsUpTo.slice(-252).map(d=>d.high)),
        fiftyTwoWeekLow: Math.min(...barsUpTo.slice(-252).map(d=>d.low)),
      };

      const analysis = analyzeStock(barsUpTo, quote);
      if (!analysis || analysis.score == null) continue;
      const closes = barsUpTo.map(b => b.close);
      const midTerm = midTermAnalysis(analysis, quote, closes);

      if (midTerm.score >= MIDTERM_THRESHOLD) {
        candidates.push({
          symbol: stock.symbol, name: stock.name, sector: stock.sector,
          entryPrice: last.close, score: midTerm.score, rec: midTerm.recommendation,
          stopLoss: midTerm.stopLoss, target: midTerm.target,
          forwardBars: fullBars.filter(b => b.date > scanDate),
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const picks = candidates.slice(0, MAX_PICKS);

    if (picks.length === 0) {
      log.push({ month: scan.label, capital: capitalBefore, deployed: 0, returned: 0, pnl: 0, trades: 0, capitalAfter: capital });
      continue;
    }

    // Deploy capital equally across picks
    const perPick = capital / picks.length;
    let monthDeployed = 0;
    let monthReturned = 0;
    const monthTrades = [];

    for (const p of picks) {
      const shares = perPick / p.entryPrice; // fractional shares
      const deployed = shares * p.entryPrice; // = perPick
      monthDeployed += deployed;

      const maxExit = addTradingDays(scan.date, HOLD_DAYS);
      const exit = trackTrade(p.forwardBars, p.entryPrice, p.target, p.stopLoss, maxExit);
      const returned = shares * exit.exitPrice;
      monthReturned += returned;

      const returnPct = ((exit.exitPrice - p.entryPrice) / p.entryPrice) * 100;
      const holdDays = Math.round((new Date(exit.exitDate) - scanDate) / 864e5);

      monthTrades.push({ symbol: p.symbol, sector: p.sector, score: p.score, entryPrice: p.entryPrice, exitPrice: exit.exitPrice, returnPct, reason: exit.reason, holdDays, deployed, returned });
      allTrades.push({ month: scan.label, ...monthTrades[monthTrades.length - 1] });
    }

    totalDeployed += monthDeployed;
    totalReturned += monthReturned;

    // COMPOUNDING: capital after this month = returned from trades
    // (all capital was deployed, so new capital = what came back)
    capital = monthReturned;

    const monthPnl = monthReturned - monthDeployed;
    const monthReturnPct = (monthPnl / monthDeployed) * 100;

    log.push({
      month: scan.label, capital: capitalBefore, deployed: monthDeployed,
      returned: monthReturned, pnl: monthPnl, returnPct: monthReturnPct,
      trades: picks.length, capitalAfter: capital,
      wins: monthTrades.filter(t => t.returnPct > 0).length,
      losses: monthTrades.filter(t => t.returnPct <= 0).length,
    });
  }

  return { log, allTrades, finalCapital: capital, totalDeployed, totalReturned };
}

// ═══ NIFTY BUY & HOLD ═══
function niftyBuyHold(niftyBars, startDate, endDate) {
  const start = niftyBars.find(b => b.date >= new Date(startDate));
  const end = [...niftyBars].reverse().find(b => b.date <= new Date(endDate));
  if (!start || !end) return { startPrice: 0, endPrice: 0, returnPct: 0, value: STARTING_CAPITAL };
  const returnPct = ((end.close - start.close) / start.close) * 100;
  const value = STARTING_CAPITAL * (end.close / start.close);
  return { startPrice: start.close, endPrice: end.close, startDate: toDateStr(start.date), endDate: toDateStr(end.date), returnPct, value };
}

// ═══ MAIN ═══
async function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║  ₹2 Lakh Capital — Compounding Paper Trading         ║");
  console.log("║  Mid-Term Picks vs Nifty 50 Buy & Hold               ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  loadFundamentalsFromDisk();
  const stocks = getNifty100();
  console.log(`Starting capital: ₹${(STARTING_CAPITAL/100000).toFixed(1)}L`);
  console.log(`Universe: ${stocks.length} stocks\n`);

  console.log("Fetching data...");
  const allSymbols = [...stocks.map(s => s.symbol), "^NSEI"];
  const allData = await fetchAll(allSymbols);
  const niftyBars = allData.get("^NSEI"); allData.delete("^NSEI");

  // ═══ RUN SIMULATIONS ═══

  // 1-Year: Apr 2025 – Mar 2026 (last 12 scans)
  const scans1yr = ALL_SCANS.slice(12); // months 13-24
  // 2-Year: Apr 2024 – Mar 2026 (all 24 scans)
  const scans2yr = ALL_SCANS;

  console.log("\n═══ 1-YEAR SIMULATION (Apr 2025 – Mar 2026) ═══\n");
  const sim1yr = runCompoundingSim(stocks, allData, scans1yr);
  const nifty1yr = niftyBuyHold(niftyBars, "2025-04-07", "2026-03-31");

  console.log("\n═══ 2-YEAR SIMULATION (Apr 2024 – Mar 2026) ═══\n");
  const sim2yr = runCompoundingSim(stocks, allData, scans2yr);
  const nifty2yr = niftyBuyHold(niftyBars, "2024-04-04", "2026-03-31");

  // ═══ PRINT RESULTS ═══
  function printSim(label, sim, nifty, months) {
    const totalReturn = ((sim.finalCapital - STARTING_CAPITAL) / STARTING_CAPITAL) * 100;
    const wins = sim.allTrades.filter(t => t.returnPct > 0).length;
    const total = sim.allTrades.length;

    console.log(`\n${"═".repeat(60)}`);
    console.log(`  ${label}`);
    console.log("═".repeat(60));

    console.log(`\n  ┌─────────────────────────────────────────────────┐`);
    console.log(`  │  STARTING CAPITAL:  ₹${(STARTING_CAPITAL/100000).toFixed(2)}L                     │`);
    console.log(`  │                                                 │`);
    console.log(`  │  Mid-Term Final:    ₹${(sim.finalCapital/100000).toFixed(2)}L  (${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(1)}%)${" ".repeat(Math.max(0, 14 - (totalReturn.toFixed(1).length)))}│`);
    console.log(`  │  Nifty Buy & Hold:  ₹${(nifty.value/100000).toFixed(2)}L  (${nifty.returnPct >= 0 ? "+" : ""}${nifty.returnPct.toFixed(1)}%)${" ".repeat(Math.max(0, 14 - (nifty.returnPct.toFixed(1).length)))}│`);
    console.log(`  │                                                 │`);
    const diff = sim.finalCapital - nifty.value;
    const winner = diff > 0 ? "MID-TERM WINS" : "NIFTY WINS";
    console.log(`  │  Difference:        ₹${(Math.abs(diff)/1000).toFixed(1)}K ${diff > 0 ? "MORE" : "LESS"} than Nifty  │`);
    console.log(`  │  ${winner}${" ".repeat(Math.max(0, 36 - winner.length))}│`);
    console.log(`  └─────────────────────────────────────────────────┘`);

    console.log(`\n  Trades: ${total} | Win Rate: ${wins}/${total} = ${(wins/total*100).toFixed(1)}%`);
    console.log(`  Avg Return/Trade: ${(sim.allTrades.reduce((s,t)=>s+t.returnPct,0)/total).toFixed(2)}%`);
    console.log(`  Avg Hold: ${(sim.allTrades.reduce((s,t)=>s+t.holdDays,0)/total).toFixed(0)} days`);

    const exits = { SL: 0, TRAIL: 0, TARGET: 0, EXPIRY: 0 };
    for (const t of sim.allTrades) exits[t.reason] = (exits[t.reason] || 0) + 1;
    console.log(`  Exits: ${exits.SL} SL, ${exits.TRAIL} trailing, ${exits.TARGET} target, ${exits.EXPIRY} expiry`);

    console.log(`\n  Month-by-Month Capital Growth:`);
    console.log(`  ${"Month".padEnd(12)} ${"Capital Start".padStart(14)} ${"Picks".padStart(6)} ${"Month P&L".padStart(12)} ${"Capital End".padStart(14)}`);
    console.log(`  ${"-".repeat(60)}`);

    for (const m of sim.log) {
      const pnlStr = m.pnl >= 0 ? `+₹${(m.pnl/1000).toFixed(1)}K` : `-₹${(Math.abs(m.pnl)/1000).toFixed(1)}K`;
      console.log(`  ${m.month.padEnd(12)} ${("₹"+(m.capital/100000).toFixed(2)+"L").padStart(14)} ${String(m.trades).padStart(6)} ${pnlStr.padStart(12)} ${("₹"+(m.capitalAfter/100000).toFixed(2)+"L").padStart(14)}`);
    }

    // Show yearly summaries for 2-year sim
    if (months > 12) {
      console.log(`\n  Year-by-Year Summary:`);
      const yr1End = sim.log[11]?.capitalAfter || STARTING_CAPITAL;
      const yr2End = sim.finalCapital;
      console.log(`    Year 1 (Apr 2024 – Mar 2025): ₹${(STARTING_CAPITAL/100000).toFixed(2)}L → ₹${(yr1End/100000).toFixed(2)}L (${((yr1End-STARTING_CAPITAL)/STARTING_CAPITAL*100).toFixed(1)}%)`);
      console.log(`    Year 2 (Apr 2025 – Mar 2026): ₹${(yr1End/100000).toFixed(2)}L → ₹${(yr2End/100000).toFixed(2)}L (${((yr2End-yr1End)/yr1End*100).toFixed(1)}%)`);
    }

    // Top winners and losers
    const sorted = [...sim.allTrades].sort((a,b) => b.returnPct - a.returnPct);
    console.log(`\n  Top 5 Winners:`);
    for (const t of sorted.slice(0,5)) console.log(`    ${t.symbol.padEnd(18)} ${t.month.padEnd(10)} +${t.returnPct.toFixed(1)}% [${t.reason}] ₹${(t.returned-t.deployed).toFixed(0)} profit`);
    console.log(`  Bottom 5 Losers:`);
    for (const t of sorted.slice(-5).reverse()) console.log(`    ${t.symbol.padEnd(18)} ${t.month.padEnd(10)} ${t.returnPct.toFixed(1)}% [${t.reason}] ₹${(t.returned-t.deployed).toFixed(0)} loss`);
  }

  printSim("1-YEAR: ₹2L Mid-Term vs Nifty (Apr 2025 – Mar 2026)", sim1yr, nifty1yr, 12);
  printSim("2-YEAR: ₹2L Mid-Term vs Nifty (Apr 2024 – Mar 2026)", sim2yr, nifty2yr, 24);

  // Final summary
  console.log(`\n\n${"═".repeat(60)}`);
  console.log("  FINAL ANSWER: What happens to your ₹2 Lakhs?");
  console.log("═".repeat(60));
  console.log(`\n  Starting with ₹2,00,000 — no additional investment\n`);
  console.log(`  ${"".padEnd(20)} ${"Mid-Term".padStart(14)} ${"Nifty B&H".padStart(14)} ${"Winner".padStart(14)}`);
  console.log(`  ${"After 1 Year".padEnd(20)} ${"₹"+(sim1yr.finalCapital/100000).toFixed(2)+"L".padStart(13)} ${"₹"+(nifty1yr.value/100000).toFixed(2)+"L".padStart(13)} ${sim1yr.finalCapital > nifty1yr.value ? "Mid-Term ✅".padStart(13) : "Nifty ✅".padStart(13)}`);
  console.log(`  ${"After 2 Years".padEnd(20)} ${"₹"+(sim2yr.finalCapital/100000).toFixed(2)+"L".padStart(13)} ${"₹"+(nifty2yr.value/100000).toFixed(2)+"L".padStart(13)} ${sim2yr.finalCapital > nifty2yr.value ? "Mid-Term ✅".padStart(13) : "Nifty ✅".padStart(13)}`);

  const ret1 = ((sim1yr.finalCapital - STARTING_CAPITAL) / STARTING_CAPITAL * 100).toFixed(1);
  const ret2 = ((sim2yr.finalCapital - STARTING_CAPITAL) / STARTING_CAPITAL * 100).toFixed(1);
  const nRet1 = nifty1yr.returnPct.toFixed(1);
  const nRet2 = nifty2yr.returnPct.toFixed(1);
  console.log(`  ${"Return (1yr)".padEnd(20)} ${(ret1+"%").padStart(14)} ${(nRet1+"%").padStart(14)}`);
  console.log(`  ${"Return (2yr)".padEnd(20)} ${(ret2+"%").padStart(14)} ${(nRet2+"%").padStart(14)}`);

  console.log(`\n${"═".repeat(60)}\n`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
