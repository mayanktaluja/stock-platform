#!/usr/bin/env node
/**
 * Diagnostic: why is 2025 alpha negative under PIT fundamentals?
 *
 * Runs the engine for 2025 with PIT, then dumps:
 *   • Per-trade detail (symbol, sector, action, entry/exit, return, reason)
 *   • Sector attribution (which sectors drove losses?)
 *   • Exit-reason distribution (did we stop out too fast? time-out on winners?)
 *   • Score/concentration attribution (are low-score picks dragging us?)
 *   • Best/worst 10 trades
 *
 * Plus three counterfactual runs for hypothesis testing:
 *   A) No sector exclusions
 *   B) No max-per-sector cap
 *   C) 40-day time exit instead of 20
 */

import { fileURLToPath } from "url";
import path from "path";
import YahooFinance from "yahoo-finance2";
import { analyzeStock, midTermAnalysis } from "../analysis.js";
import { scoreFundamentals, loadFundamentalsFromDisk } from "../fundamentals.js";
import { getNifty100 } from "../stockList.js";
import { getPointInTimeFundamentals, computePitSectorPeMedians } from "../pointInTimeFundamentals.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONCURRENCY = 6;
const NIFTY_INDEX_SYMBOL = "^NSEI";
const YEAR = parseInt(process.env.YEAR || "2025", 10);
const TOP_N = 5; // representative concentration

const HISTORY_START = `${YEAR - 1}-05-01`;
const HISTORY_END = `${YEAR + 1}-03-01`;

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

function toDateStr(d) { if (typeof d === "string") return d.slice(0, 10); return d.toISOString().slice(0, 10); }
function addDays(dateStr, days) { const d = new Date(dateStr); d.setDate(d.getDate() + days); return toDateStr(d); }
function addTradingDays(dateStr, days) {
  let d = new Date(dateStr); let count = 0;
  while (count < days) { d.setDate(d.getDate() + 1); const dow = d.getDay(); if (dow !== 0 && dow !== 6) count++; }
  return toDateStr(d);
}
function addCalendarMonths(dateStr, months) {
  const d = new Date(dateStr); d.setMonth(d.getMonth() + months); return toDateStr(d);
}

async function fetchHistory(symbol) {
  try {
    const result = await yf.chart(symbol, { period1: HISTORY_START, period2: HISTORY_END, interval: "1d" });
    if (!result || !result.quotes || result.quotes.length === 0) return null;
    const bars = [];
    for (const q of result.quotes) {
      if (q.close == null || q.open == null || q.high == null || q.low == null) continue;
      const adjClose = q.adjclose != null ? q.adjclose : q.close;
      const ratio = q.close > 0 ? adjClose / q.close : 1;
      bars.push({
        date: new Date(q.date), open: q.open * ratio, high: q.high * ratio,
        low: q.low * ratio, close: adjClose, volume: q.volume || 0,
      });
    }
    return bars;
  } catch { return null; }
}

async function fetchAllHistories(stocks) {
  const histories = new Map();
  const queue = [...stocks.map((s) => s.symbol), NIFTY_INDEX_SYMBOL];
  let completed = 0;
  async function worker() {
    while (queue.length > 0) {
      const symbol = queue.shift();
      if (!symbol) break;
      const data = await fetchHistory(symbol);
      if (data) histories.set(symbol, data);
      completed++;
      if (completed % 50 === 0) console.log(`  ${completed} fetched`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return histories;
}

function buildMockQuote(historical, symbol) {
  const last = historical[historical.length - 1], prev = historical[historical.length - 2];
  const slice252 = historical.slice(-252);
  return {
    symbol, regularMarketPrice: last.close, regularMarketPreviousClose: prev.close,
    regularMarketChange: last.close - prev.close,
    regularMarketChangePercent: ((last.close - prev.close) / prev.close) * 100,
    regularMarketDayHigh: last.high, regularMarketDayLow: last.low,
    regularMarketVolume: last.volume, regularMarketOpen: last.open,
    fiftyTwoWeekHigh: Math.max(...slice252.map((d) => d.high)),
    fiftyTwoWeekLow: Math.min(...slice252.map((d) => d.low)),
  };
}
function sliceUpTo(bars, dateStr) { const d = new Date(dateStr); d.setHours(23,59,59,999); return bars.filter(b => b.date <= d); }
function sliceAfter(bars, dateStr) { const d = new Date(dateStr); d.setHours(0,0,0,0); return bars.filter(b => b.date > d); }
function computeDMA200(bars) { if (bars.length < 200) return null; const closes = bars.slice(-200).map(b => b.close); return closes.reduce((s,v) => s+v, 0) / 200; }

function generateMonthlyScans(startStr, endStr) {
  const firstDay = { 0:3,1:2,2:2,3:4,4:3,5:2,6:1,7:1,8:1,9:1,10:3,11:1 };
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const start = new Date(startStr), end = new Date(endStr);
  const out = [];
  let y = start.getFullYear(), m = start.getMonth();
  while (y < end.getFullYear() || (y === end.getFullYear() && m <= end.getMonth())) {
    const day = firstDay[m];
    const dateStr = `${y}-${String(m+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    if (new Date(dateStr) <= end) out.push({ label: `${months[m]} ${y}`, date: dateStr });
    m++; if (m > 11) { m = 0; y++; }
  }
  return out;
}

function trackTradeFixed(forward, entry, target, stopLoss, maxExit) {
  const maxD = new Date(maxExit); maxD.setHours(23,59,59,999);
  for (const bar of forward) {
    if (bar.date > maxD) break;
    if (stopLoss && bar.low <= stopLoss) return { exitPrice: stopLoss, exitDate: toDateStr(bar.date), exitReason: "SL_HIT", returnPct: ((stopLoss - entry) / entry) * 100 };
    if (target && bar.high >= target) return { exitPrice: target, exitDate: toDateStr(bar.date), exitReason: "TARGET_HIT", returnPct: ((target - entry) / entry) * 100 };
  }
  const eligible = forward.filter(b => b.date <= maxD);
  if (!eligible.length) return { exitPrice: entry, exitDate: maxExit, exitReason: "NO_DATA", returnPct: 0 };
  const last = eligible[eligible.length - 1];
  return { exitPrice: last.close, exitDate: toDateStr(last.date), exitReason: "TIME_EXIT", returnPct: ((last.close - entry) / entry) * 100 };
}

function runScan(stocks, histories, scanDate, active, topN, pitCtx, opts = {}) {
  const { excludedSectors = new Set(["Banking","Tourism","Cement","Chemicals"]),
          maxPerSector = 2, timeExitDays = 20, slMult = 3, targetMult = 7,
          crossCategoryDedup = false } = opts;

  const buyNow = [], midTerm = [], fund = [];
  for (const stock of stocks) {
    const bars = histories.get(stock.symbol);
    if (!bars) continue;
    if (excludedSectors.has(stock.sector || "")) continue;
    const barsUpTo = sliceUpTo(bars, scanDate);
    if (barsUpTo.length < 50) continue;
    const quote = buildMockQuote(barsUpTo, stock.symbol);
    const analysis = analyzeStock(barsUpTo, quote);
    if (analysis.error) continue;
    const mt = midTermAnalysis(analysis, quote);
    const dma200 = computeDMA200(barsUpTo);
    let snap = null;
    if (pitCtx) {
      const pit = getPointInTimeFundamentals(stock.symbol, new Date(scanDate), {
        price: quote.regularMarketPrice, week52High: quote.fiftyTwoWeekHigh, week52Low: quote.fiftyTwoWeekLow,
      });
      if (pit) { pit.name = stock.name; pit.sectorPe = pitCtx.medians.get(stock.sector) ?? null; snap = pit; }
    }
    const f = snap ? scoreFundamentals(snap, dma200) : null;

    const entry = quote.regularMarketPrice;
    const forward = sliceAfter(bars, scanDate);
    const atr = analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null;
    const sl = atr ? entry - atr * slMult : mt.stopLoss;
    const tgt = atr ? entry + atr * targetMult : mt.target;
    const techScore = analysis.score;

    const common = {
      symbol: stock.symbol, name: stock.name, sector: stock.sector,
      entry, stopLoss: sl, target: tgt, atr, forward, techScore,
      fundScore: f?.score, fundVerdict: f?.verdict,
    };
    if (f && (f.verdict === "DEEP_VALUE" || f.verdict === "QUALITY_GROWTH") && analysis.recommendation !== "HOLD") {
      const combined = techScore * 0.4 + f.score * 0.6;
      if (combined >= 60) buyNow.push({ ...common, category: "BUY_NOW", combinedScore: combined,
        maxExitDate: addCalendarMonths(scanDate, 3) });
    }
    if (mt.score >= 58) midTerm.push({ ...common, category: "MID_TERM", mtScore: mt.score,
      maxExitDate: addTradingDays(scanDate, timeExitDays) });
    if (f && (f.verdict === "DEEP_VALUE" || f.verdict === "QUALITY_GROWTH")) fund.push({ ...common, category: "FUNDAMENTAL",
      maxExitDate: addCalendarMonths(scanDate, 3) });
  }
  buyNow.sort((a, b) => b.combinedScore - a.combinedScore);
  midTerm.sort((a, b) => b.mtScore - a.mtScore);
  fund.sort((a, b) => (b.fundScore || 0) - (a.fundScore || 0));
  // Track symbols taken by higher-priority categories when crossCategoryDedup=true.
  // Priority: BUY_NOW > FUNDAMENTAL > MID_TERM.
  const claimed = crossCategoryDedup ? new Set() : null;
  function pick(cands, limit) {
    const out = [];
    const sc = new Map();
    for (const c of cands) {
      if (out.length >= limit) break;
      if (active.has(c.symbol)) continue;
      if (claimed && claimed.has(c.symbol)) continue;
      const s = c.sector || "?";
      if ((sc.get(s) || 0) >= maxPerSector) continue;
      sc.set(s, (sc.get(s) || 0) + 1);
      out.push(c);
      if (claimed) claimed.add(c.symbol);
    }
    return out;
  }
  // Pick order enforces priority for dedup
  const bn = pick(buyNow, topN);
  const fd = pick(fund, topN);
  const mt = pick(midTerm, topN);
  return { buyNow: bn, midTerm: mt, fund: fd };
}

function simulate(stocks, histories, scans, topN, opts = {}) {
  const trades = [];
  const active = new Set();
  for (const scan of scans) {
    for (const t of trades) if (t.exitDate && t.exitDate <= scan.date && active.has(t.symbol)) active.delete(t.symbol);
    const priceMap = new Map();
    for (const s of stocks) { const bars = histories.get(s.symbol); if (!bars) continue; const bu = sliceUpTo(bars, scan.date); if (bu.length) priceMap.set(s.symbol, bu[bu.length-1].close); }
    const medians = computePitSectorPeMedians(stocks, new Date(scan.date), priceMap);
    const pitCtx = { medians };
    const { buyNow, midTerm, fund } = runScan(stocks, histories, scan.date, active, topN, pitCtx, opts);
    for (const pick of [...buyNow, ...midTerm, ...fund]) {
      active.add(pick.symbol);
      const res = trackTradeFixed(pick.forward, pick.entry, pick.target, pick.stopLoss, pick.maxExitDate);
      const net = { ...res, returnPct: res.returnPct - 0.5 };
      trades.push({
        symbol: pick.symbol, name: pick.name, sector: pick.sector, category: pick.category,
        scanDate: scan.date, entry: pick.entry, stopLoss: pick.stopLoss, target: pick.target, atr: pick.atr,
        techScore: pick.techScore, fundScore: pick.fundScore, fundVerdict: pick.fundVerdict,
        ...net,
      });
      if (net.exitDate <= scan.date) active.delete(pick.symbol);
    }
  }
  return trades;
}

function metrics(trades, niftyBars, window) {
  if (!trades.length) return { n: 0, wr: 0, avg: 0, xirr: 0, niftyXirr: 0, alpha: 0 };
  const wins = trades.filter(t => t.returnPct > 0).length;
  const avg = trades.reduce((s,t) => s+t.returnPct, 0) / trades.length;
  const cf = [];
  for (const t of trades) {
    cf.push({ date: new Date(t.scanDate), amount: -t.entry });
    cf.push({ date: new Date(t.exitDate), amount: t.exitPrice * 0.995 });
  }
  cf.sort((a,b) => a.date - b.date);
  let rate = 0.1;
  for (let i = 0; i < 200; i++) {
    let f = 0, df = 0;
    const d0 = cf[0].date.getTime();
    for (const c of cf) {
      const y = (c.date.getTime() - d0) / (365.25 * 86400000);
      f += c.amount / Math.pow(1+rate, y);
      if (y > 0) df -= y * c.amount / Math.pow(1+rate, y+1);
    }
    if (Math.abs(df) < 1e-12) break;
    const nr = rate - f / df;
    if (Math.abs(nr - rate) < 1e-9) { rate = nr; break; }
    rate = Math.max(-0.99, Math.min(10, nr));
  }
  const xirr = rate * 100;
  const nStart = niftyBars ? sliceUpTo(niftyBars, window.start) : [];
  const nEnd = niftyBars ? sliceUpTo(niftyBars, window.end) : [];
  let niftyXirr = 0;
  if (nStart.length && nEnd.length) {
    const sp = nStart[nStart.length-1].close, ep = nEnd[nEnd.length-1].close;
    const d0 = new Date(window.start).getTime(), d1 = new Date(window.end).getTime();
    const yearsDiff = (d1 - d0) / (365.25 * 86400000);
    niftyXirr = (Math.pow(ep/sp, 1/yearsDiff) - 1) * 100;
  }
  return { n: trades.length, wr: (wins/trades.length)*100, avg, xirr, niftyXirr, alpha: xirr - niftyXirr };
}

function sectorBreakdown(trades) {
  const bySec = new Map();
  for (const t of trades) {
    if (!bySec.has(t.sector)) bySec.set(t.sector, []);
    bySec.get(t.sector).push(t);
  }
  return [...bySec.entries()].map(([sec, arr]) => ({
    sector: sec, count: arr.length,
    wr: (arr.filter(t => t.returnPct > 0).length / arr.length) * 100,
    avg: arr.reduce((s,t) => s+t.returnPct, 0) / arr.length,
    totalImpact: arr.reduce((s,t) => s+t.returnPct, 0),
  })).sort((a,b) => a.totalImpact - b.totalImpact);
}

function catBreakdown(trades) {
  const out = {};
  for (const cat of ["BUY_NOW","MID_TERM","FUNDAMENTAL"]) {
    const ct = trades.filter(t => t.category === cat);
    out[cat] = ct.length ? { n: ct.length, wr: (ct.filter(t => t.returnPct > 0).length / ct.length) * 100, avg: ct.reduce((s,t) => s+t.returnPct, 0) / ct.length } : null;
  }
  return out;
}

function exitBreakdown(trades) {
  const out = {};
  for (const r of ["SL_HIT","TARGET_HIT","TIME_EXIT","NO_DATA"]) {
    const m = trades.filter(t => t.exitReason === r);
    out[r] = m.length ? { n: m.length, avg: m.reduce((s,t) => s+t.returnPct, 0) / m.length } : null;
  }
  return out;
}

// ──────────────────── Main ────────────────────

async function main() {
  console.log(`=== Diagnostic: ${YEAR} deep-dive ===`);
  loadFundamentalsFromDisk();
  const stocks = getNifty100();
  const histories = await fetchAllHistories(stocks);
  const niftyBars = histories.get(NIFTY_INDEX_SYMBOL);
  const window = { start: `${YEAR}-01-01`, end: `${YEAR}-12-31` };
  const scans = generateMonthlyScans(window.start, window.end);

  console.log(`\nUniverse: ${stocks.length} stocks | ${scans.length} scans`);
  console.log("\n── Variant A: BASELINE (current engine settings) ──");
  const baseTrades = simulate(stocks, histories, scans, TOP_N);
  const baseM = metrics(baseTrades, niftyBars, window);
  printVariant("Baseline", baseTrades, baseM);

  console.log("\n── Variant B: NO SECTOR EXCLUSIONS ──");
  const noExcl = simulate(stocks, histories, scans, TOP_N, { excludedSectors: new Set() });
  printVariant("No exclusions", noExcl, metrics(noExcl, niftyBars, window));

  console.log("\n── Variant C: MAX 4 PER SECTOR (vs 2) ──");
  const bigSec = simulate(stocks, histories, scans, TOP_N, { maxPerSector: 4 });
  printVariant("Max 4/sector", bigSec, metrics(bigSec, niftyBars, window));

  console.log("\n── Variant D: 40-DAY TIME EXIT for midterm (vs 20) ──");
  const longTime = simulate(stocks, histories, scans, TOP_N, { timeExitDays: 40 });
  printVariant("40-day time-exit", longTime, metrics(longTime, niftyBars, window));

  console.log("\n── Variant E: 4x ATR SL / 6x target (vs 3/7) ──");
  const widerSL = simulate(stocks, histories, scans, TOP_N, { slMult: 4, targetMult: 6 });
  printVariant("4x SL / 6x target", widerSL, metrics(widerSL, niftyBars, window));

  console.log("\n── Variant F: COMBINED — no exclusions + max 4 + 40-day ──");
  const combo = simulate(stocks, histories, scans, TOP_N, { excludedSectors: new Set(), maxPerSector: 4, timeExitDays: 40 });
  printVariant("Combined fix", combo, metrics(combo, niftyBars, window));

  console.log("\n── Variant G: SURGICAL FIX — remove only Banking from excl + 4x/6x SL + cross-cat dedup ──");
  const surgical = simulate(stocks, histories, scans, TOP_N, {
    excludedSectors: new Set(["Tourism","Cement","Chemicals"]),  // keep losers, remove Banking
    slMult: 4, targetMult: 6,
    crossCategoryDedup: true,
  });
  printVariant("Surgical (Phase 6)", surgical, metrics(surgical, niftyBars, window));

  console.log("\n── Sector attribution (baseline): WORST 5 ──");
  const secs = sectorBreakdown(baseTrades);
  for (const s of secs.slice(0, 5)) console.log(`  ${s.sector}: ${s.count} trades, WR ${s.wr.toFixed(0)}%, avg ${s.avg.toFixed(2)}%, total impact ${s.totalImpact.toFixed(1)}%`);
  console.log("  (best 3)");
  for (const s of secs.slice(-3)) console.log(`  ${s.sector}: ${s.count} trades, WR ${s.wr.toFixed(0)}%, avg ${s.avg.toFixed(2)}%, total impact +${s.totalImpact.toFixed(1)}%`);

  console.log("\n── What did the EXCLUDED sectors do in 2025? ──");
  const noExclTrades = noExcl.filter(t => ["Banking","Tourism","Cement","Chemicals"].includes(t.sector));
  if (noExclTrades.length) {
    const bySec = {};
    for (const t of noExclTrades) {
      if (!bySec[t.sector]) bySec[t.sector] = [];
      bySec[t.sector].push(t);
    }
    for (const [sec, arr] of Object.entries(bySec)) {
      const wr = (arr.filter(t => t.returnPct > 0).length / arr.length) * 100;
      const avg = arr.reduce((s,t) => s+t.returnPct, 0) / arr.length;
      console.log(`  ${sec}: ${arr.length} trades would have been taken, WR ${wr.toFixed(0)}%, avg ${avg.toFixed(2)}%`);
    }
  } else {
    console.log("  (no trades in those sectors qualified even with exclusion off)");
  }

  console.log("\n── Best & Worst 10 trades (baseline) ──");
  const sorted = [...baseTrades].sort((a,b) => b.returnPct - a.returnPct);
  console.log("  Top 10:");
  for (const t of sorted.slice(0, 10)) console.log(`    ${t.symbol.replace(".NS","").padEnd(15)} ${t.category.padEnd(12)} ${t.sector.padEnd(15)} ${t.scanDate} entry=${t.entry.toFixed(0)} exit=${t.exitPrice.toFixed(0)} ${t.returnPct.toFixed(1)}% (${t.exitReason})`);
  console.log("  Bottom 10:");
  for (const t of sorted.slice(-10).reverse()) console.log(`    ${t.symbol.replace(".NS","").padEnd(15)} ${t.category.padEnd(12)} ${t.sector.padEnd(15)} ${t.scanDate} entry=${t.entry.toFixed(0)} exit=${t.exitPrice.toFixed(0)} ${t.returnPct.toFixed(1)}% (${t.exitReason})`);
}

function printVariant(label, trades, m) {
  const cats = catBreakdown(trades);
  const exits = exitBreakdown(trades);
  console.log(`  ${label}: ${m.n} trades | WR ${m.wr.toFixed(1)}% | avg ${m.avg.toFixed(2)}% | XIRR ${m.xirr.toFixed(1)}% | Nifty ${m.niftyXirr.toFixed(1)}% | α ${m.alpha >= 0 ? "+" : ""}${m.alpha.toFixed(1)}%`);
  console.log(`    categories: ${Object.entries(cats).filter(([,v])=>v).map(([k,v]) => `${k} n=${v.n} wr=${v.wr.toFixed(0)}% avg=${v.avg.toFixed(2)}%`).join(" · ")}`);
  console.log(`    exits:      ${Object.entries(exits).filter(([,v])=>v).map(([k,v]) => `${k} n=${v.n} avg=${v.avg.toFixed(2)}%`).join(" · ")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
