#!/usr/bin/env node
/**
 * Why does top-3 lose to Nifty in 2025 while top-1 and top-5 both win?
 *
 * Hypothesis candidates:
 *   A) At top-3, a single bad sector has outsized weight (2/3 of picks)
 *      vs top-5 where it's 2/5 — concentration amplifies a bad theme
 *   B) Cross-category dedup combined with top-3 narrows the pool too
 *      much — BUY_NOW claims the best 3, MID_TERM/FUNDAMENTAL get leftovers
 *   C) Sector-cap of 2 becomes binding at top-3 but not at top-5 —
 *      top-3 is forced into 2 + 1 split, top-5 gets 2 + 2 + 1 naturally
 *
 * This script dumps per-trade data for 2025 at top-3 and top-5 side by
 * side so we can see which trades are shared vs unique.
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
const HISTORY_START = "2024-05-01";
const HISTORY_END = "2026-03-01";

const EXCLUDED_SECTORS = new Set(["Tourism", "Cement", "Chemicals"]); // Phase 6

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

function toDateStr(d) { if (typeof d === "string") return d.slice(0, 10); return d.toISOString().slice(0, 10); }
function addTradingDays(dateStr, days) {
  let d = new Date(dateStr); let count = 0;
  while (count < days) { d.setDate(d.getDate() + 1); const dow = d.getDay(); if (dow !== 0 && dow !== 6) count++; }
  return toDateStr(d);
}
function addCalendarMonths(dateStr, months) { const d = new Date(dateStr); d.setMonth(d.getMonth() + months); return toDateStr(d); }

async function fetchHistory(symbol) {
  try {
    const result = await yf.chart(symbol, { period1: HISTORY_START, period2: HISTORY_END, interval: "1d" });
    if (!result?.quotes?.length) return null;
    const bars = [];
    for (const q of result.quotes) {
      if (q.close == null || q.open == null || q.high == null || q.low == null) continue;
      const adjClose = q.adjclose ?? q.close;
      const ratio = q.close > 0 ? adjClose / q.close : 1;
      bars.push({ date: new Date(q.date), open: q.open * ratio, high: q.high * ratio, low: q.low * ratio, close: adjClose, volume: q.volume || 0 });
    }
    return bars;
  } catch { return null; }
}

async function fetchAll(stocks) {
  const h = new Map();
  const q = [...stocks.map(s => s.symbol), NIFTY_INDEX_SYMBOL];
  let done = 0;
  async function w() {
    while (q.length) {
      const s = q.shift(); if (!s) break;
      const d = await fetchHistory(s); if (d) h.set(s, d);
      done++; if (done % 50 === 0) console.log(`  ${done}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => w()));
  return h;
}

function buildQuote(hist, symbol) {
  const last = hist[hist.length - 1], prev = hist[hist.length - 2];
  const s252 = hist.slice(-252);
  return {
    symbol, regularMarketPrice: last.close, regularMarketPreviousClose: prev.close,
    regularMarketChange: last.close - prev.close,
    regularMarketChangePercent: ((last.close - prev.close) / prev.close) * 100,
    regularMarketDayHigh: last.high, regularMarketDayLow: last.low,
    regularMarketVolume: last.volume, regularMarketOpen: last.open,
    fiftyTwoWeekHigh: Math.max(...s252.map(d => d.high)),
    fiftyTwoWeekLow: Math.min(...s252.map(d => d.low)),
  };
}
function sliceUp(bars, d) { const t = new Date(d); t.setHours(23,59,59,999); return bars.filter(b => b.date <= t); }
function sliceAfter(bars, d) { const t = new Date(d); t.setHours(0,0,0,0); return bars.filter(b => b.date > t); }
function dma200(bars) { if (bars.length < 200) return null; return bars.slice(-200).map(b=>b.close).reduce((s,v)=>s+v,0) / 200; }

function trackFixed(fwd, entry, target, sl, max) {
  const maxD = new Date(max); maxD.setHours(23,59,59,999);
  for (const bar of fwd) {
    if (bar.date > maxD) break;
    if (sl && bar.low <= sl) return { price: sl, date: toDateStr(bar.date), reason: "SL", ret: ((sl-entry)/entry)*100 };
    if (target && bar.high >= target) return { price: target, date: toDateStr(bar.date), reason: "TGT", ret: ((target-entry)/entry)*100 };
  }
  const el = fwd.filter(b => b.date <= maxD);
  if (!el.length) return { price: entry, date: max, reason: "NOD", ret: 0 };
  const last = el[el.length-1];
  return { price: last.close, date: toDateStr(last.date), reason: "TIME", ret: ((last.close-entry)/entry)*100 };
}

function genScans() {
  const firstDay = { 0:3,1:2,2:2,3:4,4:3,5:2,6:1,7:1,8:1,9:1,10:3,11:1 };
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const out = [];
  for (let m = 0; m < 12; m++) {
    out.push({ label: `${months[m]} 2025`, date: `2025-${String(m+1).padStart(2,"0")}-${String(firstDay[m]).padStart(2,"0")}` });
  }
  return out;
}

function runScan(stocks, histories, scanDate, active, topN, sectorPeMedians) {
  const buyNow = [], midTerm = [], fund = [];
  for (const stock of stocks) {
    const bars = histories.get(stock.symbol); if (!bars) continue;
    if (EXCLUDED_SECTORS.has(stock.sector || "")) continue;
    const barsUpTo = sliceUp(bars, scanDate); if (barsUpTo.length < 50) continue;
    const quote = buildQuote(barsUpTo, stock.symbol);
    const analysis = analyzeStock(barsUpTo, quote); if (analysis.error) continue;
    const mt = midTermAnalysis(analysis, quote);
    const d200 = dma200(barsUpTo);
    const pit = getPointInTimeFundamentals(stock.symbol, new Date(scanDate), {
      price: quote.regularMarketPrice, week52High: quote.fiftyTwoWeekHigh, week52Low: quote.fiftyTwoWeekLow,
    });
    if (pit) { pit.name = stock.name; pit.sectorPe = sectorPeMedians.get(stock.sector) ?? null; }
    const f = pit ? scoreFundamentals(pit, d200) : null;
    const entry = quote.regularMarketPrice;
    const forward = sliceAfter(bars, scanDate);
    const atr = analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null;
    const sl = atr ? entry - atr * 4 : mt.stopLoss;
    const tgt = atr ? entry + atr * 6 : mt.target;
    const common = { symbol: stock.symbol, name: stock.name, sector: stock.sector,
      entry, sl, tgt, forward, techScore: analysis.score, fundVerdict: f?.verdict, fundScore: f?.score };
    if (f && (f.verdict === "DEEP_VALUE" || f.verdict === "QUALITY_GROWTH") && analysis.recommendation !== "HOLD") {
      const combined = analysis.score * 0.4 + f.score * 0.6;
      if (combined >= 60) buyNow.push({ ...common, cat: "BUY_NOW", combined, maxExit: addCalendarMonths(scanDate, 3) });
    }
    if (mt.score >= 58) midTerm.push({ ...common, cat: "MID_TERM", mtScore: mt.score, maxExit: addTradingDays(scanDate, 20) });
    if (f && (f.verdict === "DEEP_VALUE" || f.verdict === "QUALITY_GROWTH"))
      fund.push({ ...common, cat: "FUNDAMENTAL", maxExit: addCalendarMonths(scanDate, 3) });
  }
  buyNow.sort((a,b) => b.combined - a.combined);
  midTerm.sort((a,b) => b.mtScore - a.mtScore);
  fund.sort((a,b) => (b.fundScore||0) - (a.fundScore||0));
  const claimed = new Set();
  function pick(cands, lim) {
    const out = []; const sc = new Map();
    for (const c of cands) {
      if (out.length >= lim) break;
      if (active.has(c.symbol)) continue;
      if (claimed.has(c.symbol)) continue;
      if ((sc.get(c.sector) || 0) >= 2) continue;
      sc.set(c.sector, (sc.get(c.sector) || 0) + 1);
      out.push(c); claimed.add(c.symbol);
    }
    return out;
  }
  const bn = pick(buyNow, topN);
  const fd = pick(fund, topN);
  const mt = pick(midTerm, topN);
  return [...bn, ...fd, ...mt];
}

function simulate(stocks, histories, scans, topN) {
  const trades = [];
  const active = new Set();
  for (const scan of scans) {
    for (const t of trades) if (t.exit?.date && t.exit.date <= scan.date && active.has(t.symbol)) active.delete(t.symbol);
    const priceMap = new Map();
    for (const s of stocks) {
      const b = histories.get(s.symbol); if (!b) continue;
      const bu = sliceUp(b, scan.date); if (bu.length) priceMap.set(s.symbol, bu[bu.length-1].close);
    }
    const medians = computePitSectorPeMedians(stocks, new Date(scan.date), priceMap);
    const picks = runScan(stocks, histories, scan.date, active, topN, medians);
    for (const p of picks) {
      active.add(p.symbol);
      const exit = trackFixed(p.forward, p.entry, p.tgt, p.sl, p.maxExit);
      const netRet = exit.ret - 0.5;
      trades.push({ scanDate: scan.date, scanMonth: scan.label, symbol: p.symbol, name: p.name,
        sector: p.sector, cat: p.cat, entry: p.entry, exit, netRet });
      if (exit.date <= scan.date) active.delete(p.symbol);
    }
  }
  return trades;
}

function mkKey(t) { return `${t.scanDate}|${t.symbol}|${t.cat}`; }

async function main() {
  loadFundamentalsFromDisk();
  const stocks = getNifty100();
  console.log(`Fetching ${stocks.length} stocks...`);
  const histories = await fetchAll(stocks);
  const scans = genScans();

  console.log("\n=== Running top-3 vs top-5 for 2025 ===");
  const t3 = simulate(stocks, histories, scans, 3);
  const t5 = simulate(stocks, histories, scans, 5);
  console.log(`top-3: ${t3.length} trades, avg ret ${(t3.reduce((s,t)=>s+t.netRet,0)/t3.length).toFixed(2)}%`);
  console.log(`top-5: ${t5.length} trades, avg ret ${(t5.reduce((s,t)=>s+t.netRet,0)/t5.length).toFixed(2)}%`);

  // Find trades unique to top-3 (not present in top-5)
  const t5Keys = new Set(t5.map(mkKey));
  const uniqueT3 = t3.filter(t => !t5Keys.has(mkKey(t)));
  const t3Keys = new Set(t3.map(mkKey));
  const uniqueT5 = t5.filter(t => !t3Keys.has(mkKey(t)));
  const shared = t3.filter(t => t5Keys.has(mkKey(t)));

  console.log(`\nShared trades: ${shared.length} (avg ${(shared.reduce((s,t)=>s+t.netRet,0)/shared.length).toFixed(2)}%)`);
  console.log(`Unique to top-3: ${uniqueT3.length} (avg ${uniqueT3.length ? (uniqueT3.reduce((s,t)=>s+t.netRet,0)/uniqueT3.length).toFixed(2) : "—"}%)`);
  console.log(`Unique to top-5: ${uniqueT5.length} (avg ${uniqueT5.length ? (uniqueT5.reduce((s,t)=>s+t.netRet,0)/uniqueT5.length).toFixed(2) : "—"}%)`);

  // Wait — top-3 shouldn't have unique trades vs top-5 because top-5 is a superset.
  // Unless cross-category dedup interacts weirdly with pick count.
  if (uniqueT3.length > 0) {
    console.log("\n⚠️  Top-3 has trades top-5 doesn't — cross-cat dedup produces different allocations at different pick counts!");
    console.log("\nUnique-to-top-3 trades (showing first 20):");
    uniqueT3.slice(0, 20).forEach(t => console.log(`  ${t.scanDate} ${t.symbol.replace(".NS","").padEnd(14)} ${t.cat.padEnd(12)} ${t.sector.padEnd(13)} ret=${t.netRet.toFixed(1)}% (${t.exit.reason})`));
  }

  // Per-category breakdown
  console.log("\n── Per-category P&L in 2025 ──");
  for (const cat of ["BUY_NOW", "MID_TERM", "FUNDAMENTAL"]) {
    const t3c = t3.filter(t => t.cat === cat);
    const t5c = t5.filter(t => t.cat === cat);
    console.log(`  ${cat}:`);
    console.log(`    top-3: ${t3c.length} trades, avg ${t3c.length ? (t3c.reduce((s,t)=>s+t.netRet,0)/t3c.length).toFixed(2) : "—"}%`);
    console.log(`    top-5: ${t5c.length} trades, avg ${t5c.length ? (t5c.reduce((s,t)=>s+t.netRet,0)/t5c.length).toFixed(2) : "—"}%`);
    const t3sym = new Set(t3c.map(t => t.symbol));
    const t5sym = new Set(t5c.map(t => t.symbol));
    const onlyIn3 = [...t3sym].filter(s => !t5sym.has(s));
    const onlyIn5 = [...t5sym].filter(s => !t3sym.has(s));
    console.log(`    symbols only in top-3: ${onlyIn3.map(s=>s.replace(".NS","")).join(", ") || "(none)"}`);
    console.log(`    symbols only in top-5: ${onlyIn5.map(s=>s.replace(".NS","")).join(", ") || "(none)"}`);
  }

  // Sector attribution
  console.log("\n── Sector P&L contribution (top-3 vs top-5) ──");
  const secs = new Set([...t3.map(t => t.sector), ...t5.map(t => t.sector)]);
  const secData = [];
  for (const sec of secs) {
    const t3s = t3.filter(t => t.sector === sec);
    const t5s = t5.filter(t => t.sector === sec);
    secData.push({
      sec, t3Cnt: t3s.length, t3Avg: t3s.length ? t3s.reduce((s,t)=>s+t.netRet,0)/t3s.length : 0, t3Total: t3s.reduce((s,t)=>s+t.netRet,0),
      t5Cnt: t5s.length, t5Avg: t5s.length ? t5s.reduce((s,t)=>s+t.netRet,0)/t5s.length : 0, t5Total: t5s.reduce((s,t)=>s+t.netRet,0),
    });
  }
  secData.sort((a,b) => a.t3Total - b.t3Total);
  console.log(`${"Sector".padEnd(15)} ${"t3_cnt".padStart(6)} ${"t3_avg".padStart(8)} ${"t3_total".padStart(9)}  |  ${"t5_cnt".padStart(6)} ${"t5_avg".padStart(8)} ${"t5_total".padStart(9)}`);
  for (const s of secData) {
    console.log(`${s.sec.padEnd(15)} ${String(s.t3Cnt).padStart(6)} ${s.t3Avg.toFixed(1).padStart(7)}% ${s.t3Total.toFixed(1).padStart(8)}%  |  ${String(s.t5Cnt).padStart(6)} ${s.t5Avg.toFixed(1).padStart(7)}% ${s.t5Total.toFixed(1).padStart(8)}%`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
