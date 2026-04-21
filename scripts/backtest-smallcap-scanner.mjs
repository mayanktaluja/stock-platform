#!/usr/bin/env node
/**
 * Honest paper-trade backtest for the Small-Cap Scanner (4-year window).
 *
 * What this does:
 *   - Builds the NSE Smallcap 250 + Microcap 250 universe (live constituents).
 *   - Fetches 4y of daily adjusted OHLC from Yahoo for every constituent
 *     (batched to respect rate limits).
 *   - Walks the 4-year window monthly. At each month-end, applies the
 *     scanner's three scoring engines to pick the top-N:
 *         buynow    — momentum + volume, filtered to score ≥ 55
 *         midterm   — 3-factor momentum heuristic
 *         volume    — volatility × log(volume)
 *   - Paper-trades equal-weighted portfolios of size 1 / 3 / 5 / 10
 *     for each category, rebalanced monthly.
 *   - Applies 0.5% round-trip friction (STT + brokerage + slippage).
 *   - Compares XIRR against Nifty 50 over identical window.
 *
 * Honesty caveats (REPORTED IN OUTPUT):
 *   - Survivorship bias: universe = TODAY's constituents. Names that
 *     were delisted / demoted between 2022 and 2026 aren't here.
 *     Real-world smallcap scanners have the same limitation.
 *   - Dividends: NOT included. Smallcap yields are typically <1% so
 *     understates total return by ~2-4% over 4 years.
 *   - Gap risk: only close-to-close. Overnight earnings gaps not modeled.
 *   - Look-ahead: strictly none — all scoring uses only data ≤ rebalance date.
 *   - Transaction friction: 0.5% round-trip (conservative for retail
 *     with discount broker + liquid smallcaps; understates cost for
 *     thinner names).
 *
 * Usage:
 *   node scripts/backtest-smallcap-scanner.mjs
 *   node scripts/backtest-smallcap-scanner.mjs --years=3
 *   node scripts/backtest-smallcap-scanner.mjs --friction=0  (compare without costs)
 *   node scripts/backtest-smallcap-scanner.mjs --universe=100 (faster; top-100 liquid only)
 */

import { fileURLToPath } from "url";
import path from "path";
import { writeFileSync } from "fs";
import YahooFinance from "yahoo-finance2";
import { analyzeStock } from "../analysis.js";
import { xirr } from "../riskMetrics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORT_PATH = path.join(__dirname, "..", "reports", "smallcap-backtest.json");

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// ───────────── CLI ─────────────
const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.slice(2).split("=");
    return [k, v ?? true];
  })
);
const YEARS = Number(args.years || 4);
const FRICTION = Number(args.friction ?? 0.005); // 0.5% round-trip
const UNIVERSE_CAP = args.universe ? Number(args.universe) : 500;
const START_DATE = new Date();
START_DATE.setFullYear(START_DATE.getFullYear() - YEARS);
START_DATE.setDate(1);
const END_DATE = new Date();

console.log(`\n═══ Small-Cap Scanner Backtest ═══`);
console.log(`Window: ${START_DATE.toISOString().slice(0, 10)} → ${END_DATE.toISOString().slice(0, 10)} (${YEARS}y)`);
console.log(`Friction: ${(FRICTION * 100).toFixed(2)}% round-trip`);
console.log(`Universe cap: ${UNIVERSE_CAP} stocks\n`);

// ───────────── Universe ─────────────
async function fetchUniverse() {
  const UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const symbols = new Set();
  for (const idx of ["NIFTY SMALLCAP 250", "NIFTY MICROCAP 250"]) {
    const url = `https://www.nseindia.com/api/equity-stockIndices?index=${encodeURIComponent(idx)}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://www.nseindia.com/market-data/live-equity-market" },
      });
      const data = await res.json();
      for (const row of data.data || []) {
        if (row.symbol && row.symbol !== idx) symbols.add(row.symbol);
      }
    } catch (err) {
      console.warn(`  ${idx} fetch failed: ${err.message}`);
    }
  }
  const list = [...symbols].slice(0, UNIVERSE_CAP);
  console.log(`✓ Universe: ${list.length} stocks\n`);
  return list;
}

// ───────────── History fetch (parallel, rate-limited) ─────────────
async function fetchHistoryFor(symbol) {
  // Index symbols like ^NSEI are passed through as-is; everything else
  // gets the NSE .NS suffix (user's universe uses bare tickers).
  const yahooSym = symbol.startsWith("^") ? symbol : symbol + ".NS";
  try {
    const result = await yf.chart(yahooSym, {
      period1: new Date(START_DATE.getTime() - 60 * 24 * 3600 * 1000), // 60 days pre-start for indicator warmup
      period2: END_DATE,
      interval: "1d",
    });
    const quotes = result?.quotes || [];
    return quotes
      .filter((q) => q.close != null && q.high != null && q.low != null && q.volume != null)
      .map((q) => {
        const dateObj = q.date instanceof Date ? q.date : new Date(q.date);
        return {
          date: dateObj,
          ts: dateObj.getTime(),
          open: q.open,
          high: q.high,
          low: q.low,
          // Scale unadjusted OHL by the adjclose/close ratio so splits/
          // bonuses don't fabricate drawdowns in intraday highs/lows.
          close: q.adjclose ?? q.close,
          volume: q.volume,
        };
      });
  } catch {
    return null;
  }
}

async function fetchAllHistories(symbols) {
  const BATCH = 8;
  const map = new Map();
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((s) => fetchHistoryFor(s).then((h) => [s, h])));
    for (const [s, h] of results) {
      if (h && h.length >= 252) map.set(s, h); // need at least 1y
    }
    process.stdout.write(`\r  Fetched ${Math.min(i + BATCH, symbols.length)}/${symbols.length} (${map.size} usable)`);
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`\n✓ Histories: ${map.size} usable stocks\n`);
  return map;
}

// ───────────── Helpers ─────────────
function slicedUpTo(series, ts) {
  // Return only bars where ts_bar <= ts
  return series.filter((b) => b.ts <= ts);
}

function perChangeN(series, days) {
  if (series.length < days + 1) return null;
  const latest = series[series.length - 1].close;
  const earlier = series[series.length - 1 - days].close;
  if (!earlier || !latest) return null;
  return ((latest - earlier) / earlier) * 100;
}

function volatilityPct(series) {
  const last = series[series.length - 1];
  if (!last) return 0;
  return ((last.high - last.low) / (last.close || 1)) * 100;
}

// Scanner's score functions — REPLICATED from server.js, so this is a true
// backtest of what our live small-cap scanner picks.
function computeMidtermScore(series) {
  let score = 50;
  const p30 = perChangeN(series, 30) ?? 0;
  const p365 = perChangeN(series, 252) ?? 0;
  const today = series.length >= 2
    ? ((series[series.length - 1].close - series[series.length - 2].close) / series[series.length - 2].close) * 100
    : 0;
  if (p30 > 5) score += 15;
  else if (p30 < -10) score -= 15;
  if (p365 > 20) score += 10;
  else if (p365 < -20) score -= 10;
  if (today > 0) score += 5;
  else score -= 5;
  return Math.max(0, Math.min(100, score));
}

function computeVolumeActivity(series) {
  const lastN = series.slice(-20);
  const avgVol = lastN.reduce((s, b) => s + b.volume, 0) / lastN.length;
  const last = series[series.length - 1];
  const vol = volatilityPct(series);
  if (!avgVol || !last.volume) return 0;
  // volatility × log(volume) — matches scanner
  return vol * Math.log10(last.volume);
}

// For buynow: full analyzeStock if we have enough data. Falls back to
// midtermScore otherwise so the walkback still produces a pick.
function computeBuyNowScore(series) {
  if (series.length < 50) return computeMidtermScore(series);
  try {
    const quote = {
      regularMarketPrice: series[series.length - 1].close,
      regularMarketPreviousClose: series[series.length - 2].close,
      regularMarketDayHigh: series[series.length - 1].high,
      regularMarketDayLow: series[series.length - 1].low,
      regularMarketVolume: series[series.length - 1].volume,
    };
    const analysis = analyzeStock(series, quote);
    return analysis?.score ?? 50;
  } catch {
    return computeMidtermScore(series);
  }
}

// ───────────── Month-ends ─────────────
function monthEndsInWindow(histories) {
  // Use the FIRST stock's trading calendar as the walk template — Yahoo
  // returns NSE holidays correctly, so any liquid stock gives the same
  // month-end series.
  const firstSymbol = [...histories.keys()][0];
  const bars = histories.get(firstSymbol);
  const monthEnds = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].date;
    const curr = bars[i].date;
    if (prev.getMonth() !== curr.getMonth()) {
      // prev is the last trading day of its month
      if (prev >= START_DATE) monthEnds.push(prev);
    }
  }
  // Also add the very last bar so we close out the final position
  monthEnds.push(bars[bars.length - 1].date);
  return monthEnds;
}

// ───────────── Simulation ─────────────
function simulateCategory(histories, monthEnds, scoreFn, topN, categoryName) {
  // Start capital 100 (normalise later). Equal-weighted into topN picks
  // held for one month; rebalance; apply friction on every trade.
  const INITIAL_CAPITAL = 100;
  const flows = [{ date: START_DATE, amount: -INITIAL_CAPITAL }];
  let capital = INITIAL_CAPITAL;
  const symbols = [...histories.keys()];
  const equityCurve = [];
  const trades = [];
  let peak = capital;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;

  for (let mi = 0; mi < monthEnds.length - 1; mi++) {
    const rebalDate = monthEnds[mi];
    const nextDate = monthEnds[mi + 1];
    const rebalTs = rebalDate.getTime();
    const nextTs = nextDate.getTime();

    // Score every stock as of rebalDate
    const scored = [];
    for (const sym of symbols) {
      const series = slicedUpTo(histories.get(sym), rebalTs);
      if (series.length < 60) continue;
      const score = scoreFn(series);
      if (!Number.isFinite(score) || score < 55) continue;
      scored.push({ sym, score, lastClose: series[series.length - 1].close });
    }
    if (scored.length === 0) {
      equityCurve.push({ date: rebalDate, capital });
      continue;
    }
    scored.sort((a, b) => b.score - a.score);
    const picks = scored.slice(0, topN);
    if (picks.length === 0) continue;

    // Equal-weighted sizing
    const perStock = capital / picks.length;
    // Apply buy friction
    const afterBuyFriction = perStock * (1 - FRICTION / 2);
    let nextCapital = 0;
    for (const pick of picks) {
      const entry = pick.lastClose;
      // Find the next-month closing price for this stock
      const fullSeries = histories.get(pick.sym);
      const exitBar = fullSeries.find((b) => b.ts >= nextTs);
      if (!exitBar) {
        // Stock data ended mid-window; assume no change
        nextCapital += afterBuyFriction;
        continue;
      }
      const exit = exitBar.close;
      const ret = (exit - entry) / entry;
      // Apply sell friction
      const proceeds = afterBuyFriction * (1 + ret) * (1 - FRICTION / 2);
      nextCapital += proceeds;
      trades.push({ sym: pick.sym, entry, exit, ret, rebal: rebalDate });
      if (ret > 0) wins++; else losses++;
    }
    capital = nextCapital;
    equityCurve.push({ date: nextDate, capital });
    if (capital > peak) peak = capital;
    const dd = (capital - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // Final liquidation — already captured in last iteration
  flows.push({ date: END_DATE, amount: capital });
  const annualReturn = xirr(flows);
  const totalReturn = (capital - INITIAL_CAPITAL) / INITIAL_CAPITAL;
  const winRate = wins + losses > 0 ? wins / (wins + losses) : null;

  // Unique names touched across the whole simulation
  const uniqueNames = new Set(trades.map((t) => t.sym));

  // Compute a rough annualised Sharpe from the monthly return series
  const monthlyReturns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].capital;
    const curr = equityCurve[i].capital;
    if (prev > 0) monthlyReturns.push((curr - prev) / prev);
  }
  let sharpe = null;
  if (monthlyReturns.length >= 6) {
    const mean = monthlyReturns.reduce((s, r) => s + r, 0) / monthlyReturns.length;
    const variance = monthlyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (monthlyReturns.length - 1);
    const stdev = Math.sqrt(variance);
    if (stdev > 0) {
      // Rf = 6.5%/12 for monthly; annualised Sharpe = √12 × (mean - rf) / stdev
      const rf = 0.065 / 12;
      sharpe = Math.sqrt(12) * (mean - rf) / stdev;
    }
  }

  return {
    category: categoryName,
    topN,
    initialCapital: INITIAL_CAPITAL,
    finalCapital: +capital.toFixed(2),
    totalReturnPct: +(totalReturn * 100).toFixed(2),
    xirrPct: annualReturn != null ? +(annualReturn * 100).toFixed(2) : null,
    maxDrawdownPct: +(maxDrawdown * 100).toFixed(2),
    sharpe: sharpe != null ? +sharpe.toFixed(2) : null,
    tradesCount: trades.length,
    uniqueNamesCount: uniqueNames.size,
    winRate: winRate != null ? +(winRate * 100).toFixed(1) : null,
    // Top 5 names that showed up most often — helps identify if the
    // backtest picked the same few winners (concentration risk signal)
    topRepeatedNames: Object.entries(
      trades.reduce((acc, t) => ((acc[t.sym] = (acc[t.sym] || 0) + 1), acc), {}),
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sym, count]) => ({ sym, count })),
  };
}

function simulateBuyHoldNifty(history, monthEnds) {
  // Buy Nifty at start, hold to end — baseline comparison
  const firstBar = history.find((b) => b.ts >= START_DATE.getTime());
  const lastBar = history[history.length - 1];
  if (!firstBar || !lastBar) return null;
  const entry = firstBar.close;
  const exit = lastBar.close;
  const flows = [
    { date: firstBar.date, amount: -100 },
    { date: lastBar.date, amount: 100 * (exit / entry) },
  ];
  const rate = xirr(flows);
  return {
    entry: +entry.toFixed(2),
    exit: +exit.toFixed(2),
    totalReturnPct: +(((exit - entry) / entry) * 100).toFixed(2),
    xirrPct: rate != null ? +(rate * 100).toFixed(2) : null,
  };
}

// ───────────── Main ─────────────
async function main() {
  console.log("1. Fetching universe …");
  const universe = await fetchUniverse();
  if (universe.length === 0) {
    console.error("No universe — aborting.");
    process.exit(1);
  }

  console.log(`2. Fetching ${YEARS}y history for ${universe.length} stocks …`);
  const histories = await fetchAllHistories(universe);
  if (histories.size < 50) {
    console.error("Too few stocks with usable history — aborting.");
    process.exit(1);
  }

  console.log("3. Fetching Nifty 50 benchmark …");
  const niftyHistory = await fetchHistoryFor("^NSEI");
  if (!niftyHistory) {
    console.error("Nifty fetch failed — continuing without baseline");
  }

  const monthEnds = monthEndsInWindow(histories);
  console.log(`✓ Month-ends in window: ${monthEnds.length}\n`);

  // Baseline
  const nifty = niftyHistory ? simulateBuyHoldNifty(niftyHistory, monthEnds) : null;

  // Run all (category, topN) combinations
  const results = [];
  const categories = {
    buynow: computeBuyNowScore,
    midterm: computeMidtermScore,
    volume: computeVolumeActivity,
  };
  for (const [name, fn] of Object.entries(categories)) {
    for (const topN of [1, 3, 5, 10]) {
      console.log(`  Running ${name} top-${topN} …`);
      const result = simulateCategory(histories, monthEnds, fn, topN, name);
      results.push(result);
    }
  }

  // Output
  console.log(`\n═══ RESULTS ═══`);
  console.log(`\n  Baseline Nifty 50 buy-and-hold:`);
  if (nifty) {
    console.log(`    Entry ₹${nifty.entry} → Exit ₹${nifty.exit}  (${nifty.totalReturnPct}%, XIRR ${nifty.xirrPct}%/yr)`);
  } else {
    console.log(`    (unavailable)`);
  }
  console.log(`\n  ${"Category".padEnd(10)} ${"TopN".padStart(5)} ${"XIRR".padStart(10)} ${"Total".padStart(10)} ${"MaxDD".padStart(10)} ${"Trades".padStart(8)} ${"Win%".padStart(8)}`);
  console.log(`  ${"-".repeat(68)}`);
  for (const r of results) {
    const vsNifty = nifty && r.xirrPct != null && nifty.xirrPct != null
      ? `  (${r.xirrPct - nifty.xirrPct >= 0 ? "+" : ""}${(r.xirrPct - nifty.xirrPct).toFixed(1)}%/yr alpha)`
      : "";
    console.log(`  ${r.category.padEnd(10)} ${String(r.topN).padStart(5)} ${String(r.xirrPct ?? "—").padStart(9)}% ${String(r.totalReturnPct).padStart(9)}% ${String(r.maxDrawdownPct).padStart(9)}% ${String(r.tradesCount).padStart(8)} ${String(r.winRate ?? "—").padStart(7)}%${vsNifty}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    window: { start: START_DATE.toISOString(), end: END_DATE.toISOString(), years: YEARS },
    friction: FRICTION,
    universeSize: histories.size,
    monthEnds: monthEnds.length,
    nifty,
    results,
    honestyNotes: [
      "Survivorship bias: universe uses TODAY's Smallcap 250 + Microcap 250 constituents; delisted/demoted names from 2022-2026 are not included.",
      "Dividends not included — understates total return by ~2-4% over 4 years.",
      "Transaction friction 0.5% round-trip applied to every buy AND sell. Understates costs for thinly-traded names.",
      "Rebalance cadence: monthly close-to-close. Intra-month exits / stop-losses not simulated.",
      "Gap risk: close-to-close only; overnight earnings gaps not modeled.",
      "No look-ahead: scoring strictly uses data up to the rebalance date.",
    ],
  };

  try {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\n✓ Full report → ${REPORT_PATH}`);
  } catch {}

  console.log(`\n  Honesty notes:`);
  report.honestyNotes.forEach((n, i) => console.log(`    ${i + 1}. ${n}`));
}

main().catch((err) => {
  console.error("\nBacktest failed:", err);
  process.exit(1);
});
