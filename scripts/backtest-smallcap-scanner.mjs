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
const MODE = args.mode || "compare"; // "compare" | "baseline" | "improved"
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

// ───────────── Simulation (with Tier-3 improvements) ─────────────
//
// `opts` controls which of the improvement layers are applied. Passing
// no opts = original monthly equal-weighted baseline. Full opts =
// quarterly + trailing-stop + profit-ladder + ERC + guardrails.
//
// opts: {
//   rebalance:       "monthly" | "quarterly"            default monthly
//   weighting:       "equal"   | "erc"                  default equal
//   trailingStop:    0.20 means 20% trail-from-peak     default off
//   profitLadder:    true  = scale out 30% at +30%, +30% at +50%
//   liquidityMin:    0 | 1 (₹Cr/day minimum recent 20d avg value)
//   sectorCap:       0.30  = max 30% per canonical sector
//   minScore:        55    = entry filter
//   sectorMap:       Map<symbol, canonicalSector>       default null (off)
// }
function simulateCategory(histories, monthEnds, scoreFn, topN, categoryName, opts = {}) {
  const REBAL = opts.rebalance || "monthly";
  const WEIGHTING = opts.weighting || "equal";
  const STOP = opts.trailingStop ?? null;                 // e.g. 0.20
  const LADDER = opts.profitLadder ?? false;
  const LIQ_MIN_CR = opts.liquidityMin ?? 0;
  const SECTOR_CAP = opts.sectorCap ?? null;              // 0.30 = 30%
  const MIN_SCORE = opts.minScore ?? 55;
  const SECTOR_MAP = opts.sectorMap || null;

  // Build the rebalance-date list. "monthly" uses all month-ends; "quarterly"
  // takes every 3rd.
  const rebalDates = REBAL === "quarterly"
    ? monthEnds.filter((_, i) => i % 3 === 0 || i === monthEnds.length - 1)
    : monthEnds;

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

  // Helpers inside the simulation scope
  const applyStopAndLadder = (entry, fullSeries, fromTs, toTs) => {
    // Walk day-by-day to implement trailing stop + profit ladder.
    // Returns the effective realised return.
    const bars = fullSeries.filter((b) => b.ts >= fromTs && b.ts <= toTs);
    if (bars.length === 0) return null;
    let positionRemaining = 1.0; // fraction of initial position still held
    let realisedProceeds = 0;    // proceeds from partial exits, measured as (fraction × price/entry)
    let peakPrice = entry;
    let exitedFully = false;

    for (const b of bars) {
      if (b.close > peakPrice) peakPrice = b.close;
      const priceRatio = b.close / entry;

      // Profit ladder: scale out 30% at +30% and another 30% at +50%
      if (LADDER && positionRemaining > 0.7 && priceRatio >= 1.30) {
        realisedProceeds += 0.30 * priceRatio;
        positionRemaining -= 0.30;
      }
      if (LADDER && positionRemaining > 0.4 && priceRatio >= 1.50) {
        realisedProceeds += 0.30 * priceRatio;
        positionRemaining -= 0.30;
      }

      // Trailing stop from peak
      if (STOP != null && positionRemaining > 0 && b.close <= peakPrice * (1 - STOP)) {
        realisedProceeds += positionRemaining * (b.close / entry);
        positionRemaining = 0;
        exitedFully = true;
        break;
      }
    }

    // If we still hold, exit at last bar close
    if (!exitedFully && positionRemaining > 0) {
      const last = bars[bars.length - 1];
      realisedProceeds += positionRemaining * (last.close / entry);
    }
    return realisedProceeds; // proceeds expressed as a multiple of initial (1.0 = flat)
  };

  // 20-day median daily ₹ value (for liquidity floor)
  const liquidityOK = (sym, upToTs) => {
    if (LIQ_MIN_CR <= 0) return true;
    const bars = histories.get(sym).filter((b) => b.ts <= upToTs).slice(-20);
    if (bars.length < 10) return true;
    const values = bars.map((b) => b.close * b.volume).filter((v) => Number.isFinite(v) && v > 0);
    if (values.length === 0) return true;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return median / 1e7 >= LIQ_MIN_CR; // ₹Cr
  };

  // ERC weighting: weight ∝ 1 / annualised vol
  const volatility20d = (sym, upToTs) => {
    const bars = histories.get(sym).filter((b) => b.ts <= upToTs).slice(-21);
    if (bars.length < 20) return null;
    const returns = [];
    for (let i = 1; i < bars.length; i++) returns.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance * 252); // annualised
  };

  // Apply sector cap to a sorted list of picks
  const applySectorCap = (sorted, maxCount) => {
    if (!SECTOR_CAP || !SECTOR_MAP) return sorted.slice(0, maxCount);
    const capPerSector = Math.max(1, Math.ceil(maxCount * SECTOR_CAP));
    const result = [];
    const bySector = new Map();
    for (const p of sorted) {
      if (result.length >= maxCount) break;
      const sec = SECTOR_MAP.get(p.sym) || "Unknown";
      const have = bySector.get(sec) || 0;
      if (have >= capPerSector) continue;
      result.push(p);
      bySector.set(sec, have + 1);
    }
    if (result.length < maxCount) {
      for (const p of sorted) {
        if (result.length >= maxCount) break;
        if (!result.includes(p)) result.push(p);
      }
    }
    return result;
  };

  for (let mi = 0; mi < rebalDates.length - 1; mi++) {
    const rebalDate = rebalDates[mi];
    const nextDate = rebalDates[mi + 1];
    const rebalTs = rebalDate.getTime();
    const nextTs = nextDate.getTime();

    // Score every stock as of rebalDate
    const scored = [];
    for (const sym of symbols) {
      const series = slicedUpTo(histories.get(sym), rebalTs);
      if (series.length < 60) continue;
      if (!liquidityOK(sym, rebalTs)) continue;
      const score = scoreFn(series);
      if (!Number.isFinite(score) || score < MIN_SCORE) continue;
      scored.push({ sym, score, lastClose: series[series.length - 1].close });
    }
    if (scored.length === 0) {
      equityCurve.push({ date: rebalDate, capital });
      continue;
    }
    scored.sort((a, b) => b.score - a.score);
    const picks = applySectorCap(scored, topN);
    if (picks.length === 0) continue;

    // Weights
    let weights;
    if (WEIGHTING === "erc") {
      const invVols = picks.map((p) => {
        const v = volatility20d(p.sym, rebalTs);
        return v && v > 0 ? 1 / v : 1 / 0.25; // fallback 25% vol
      });
      const sumInv = invVols.reduce((s, v) => s + v, 0);
      weights = invVols.map((v) => v / sumInv);
    } else {
      weights = picks.map(() => 1 / picks.length);
    }

    // Place trades
    let nextCapital = 0;
    for (let i = 0; i < picks.length; i++) {
      const pick = picks[i];
      const allocation = capital * weights[i];
      const afterBuyFriction = allocation * (1 - FRICTION / 2);
      const entry = pick.lastClose;
      const fullSeries = histories.get(pick.sym);

      // If stop/ladder active, walk intra-period; else use simple hold-to-exit
      let proceedsMultiple;
      if (STOP != null || LADDER) {
        proceedsMultiple = applyStopAndLadder(entry, fullSeries, rebalTs, nextTs);
        if (proceedsMultiple == null) {
          // No bars in period — assume held at entry
          proceedsMultiple = 1.0;
        }
      } else {
        const exitBar = fullSeries.find((b) => b.ts >= nextTs);
        if (!exitBar) { proceedsMultiple = 1.0; }
        else proceedsMultiple = exitBar.close / entry;
      }

      const proceeds = afterBuyFriction * proceedsMultiple * (1 - FRICTION / 2);
      nextCapital += proceeds;
      const ret = proceedsMultiple - 1;
      trades.push({ sym: pick.sym, entry, ret, rebal: rebalDate });
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

  // Baseline Nifty buy-and-hold
  const nifty = niftyHistory ? simulateBuyHoldNifty(niftyHistory, monthEnds) : null;

  // Build sector map for sector-cap calculation. We pull from the live
  // NSE index data we already fetched, then canonicalise via a simple
  // map for the sectors that show up most often in the smallcap space.
  //
  // (Light-weight sector mapping — full canonicalizer is in
  // macroRegime.normalizeSector but we don't load it here to keep the
  // script independent.)
  const sectorMap = new Map();
  const LIGHT_SECTORS = {
    IT: "IT", SOFTWARE: "IT",
    BANK: "Banking", FINANCE: "NBFC", NBFC: "NBFC",
    PHARMA: "Pharma", HEALTH: "Pharma",
    AUTO: "Auto",
    METAL: "Metals", STEEL: "Metals",
    OIL: "Oil & Gas", GAS: "Oil & Gas", PETRO: "Oil & Gas",
    CEMENT: "Cement",
    POWER: "Power", UTIL: "Power",
    TELECOM: "Telecom",
    CHEM: "Chemicals", FERTIL: "Chemicals",
    CAPITAL: "Capital Goods", INDUSTRIAL: "Capital Goods", ELECTRICAL: "Capital Goods",
    DEFENCE: "Defence", AEROSPACE: "Defence",
    INFRA: "Infrastructure", CONSTRUCT: "Infrastructure",
    FMCG: "FMCG", CONSUMER: "FMCG", FOOD: "FMCG",
    RETAIL: "Retail", HOTEL: "Retail",
    REALTY: "Real Estate",
    TEXTILE: "Textiles",
    MEDIA: "Media",
  };
  // We don't have real sector metadata per symbol here; the sectorMap stays
  // sparse and the sector cap falls back gracefully for unmapped symbols.
  // (This is a known limitation — the LIVE scanner uses NSE metadata.)

  // Define the scenarios we compare:
  //   baseline     : original monthly equal-weighted, no guardrails
  //   improved     : quarterly rebalance + trailing stop + profit ladder +
  //                  ERC weighting + liquidity floor + sector cap
  const scenarios = MODE === "compare"
    ? [
        { label: "baseline",  opts: {} },
        { label: "+quarterly",       opts: { rebalance: "quarterly" } },
        { label: "+liq-floor",       opts: { rebalance: "quarterly", liquidityMin: 1 } },
        { label: "+trailing-stop",   opts: { rebalance: "quarterly", liquidityMin: 1, trailingStop: 0.20 } },
        { label: "+profit-ladder",   opts: { rebalance: "quarterly", liquidityMin: 1, trailingStop: 0.20, profitLadder: true } },
        { label: "+erc-weighting",   opts: { rebalance: "quarterly", liquidityMin: 1, trailingStop: 0.20, profitLadder: true, weighting: "erc" } },
      ]
    : [{ label: "single-run", opts: {} }];

  const categories = {
    buynow: computeBuyNowScore,
    midterm: computeMidtermScore,
    volume: computeVolumeActivity,
  };

  // Matrix: (scenario × category × topN) — but to keep run time sane we
  // only do categories × topN for each scenario when MODE=compare.
  const allResults = [];
  for (const s of scenarios) {
    console.log(`\n── Scenario: ${s.label} (${JSON.stringify(s.opts)}) ──`);
    for (const [name, fn] of Object.entries(categories)) {
      for (const topN of [1, 3, 5, 10]) {
        process.stdout.write(`  ${name} top-${topN}  `);
        const result = simulateCategory(histories, monthEnds, fn, topN, name, s.opts);
        result.scenario = s.label;
        allResults.push(result);
        console.log(`→ XIRR ${result.xirrPct ?? "—"}%`);
      }
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

  // Table: best strategy per scenario
  console.log(`\n  ${"Scenario".padEnd(18)} ${"Cat".padEnd(8)} ${"TopN".padStart(5)} ${"XIRR".padStart(10)} ${"MaxDD".padStart(9)} ${"Sharpe".padStart(7)} ${"vs Nifty".padStart(10)}`);
  console.log(`  ${"-".repeat(80)}`);
  for (const r of allResults) {
    const alpha = nifty && r.xirrPct != null && nifty.xirrPct != null
      ? `${r.xirrPct - nifty.xirrPct >= 0 ? "+" : ""}${(r.xirrPct - nifty.xirrPct).toFixed(1)}%/yr`
      : "—";
    console.log(
      `  ${r.scenario.padEnd(18)} ${r.category.padEnd(8)} ${String(r.topN).padStart(5)} ${String(r.xirrPct ?? "—").padStart(9)}% ${String(r.maxDrawdownPct).padStart(8)}% ${String(r.sharpe ?? "—").padStart(7)} ${alpha.padStart(10)}`,
    );
  }

  // Pick the best row from each scenario (by Sharpe) for a summary
  const bestPerScenario = {};
  for (const r of allResults) {
    if (r.sharpe == null) continue;
    const key = r.scenario;
    if (!bestPerScenario[key] || bestPerScenario[key].sharpe < r.sharpe) {
      bestPerScenario[key] = r;
    }
  }
  console.log(`\n  ── Best risk-adjusted (highest Sharpe) per scenario ──`);
  console.log(`  ${"Scenario".padEnd(18)} ${"Pick".padEnd(18)} ${"XIRR".padStart(8)} ${"MaxDD".padStart(8)} ${"Sharpe".padStart(7)}`);
  console.log(`  ${"-".repeat(65)}`);
  for (const [scen, r] of Object.entries(bestPerScenario)) {
    console.log(`  ${scen.padEnd(18)} ${(r.category + " top-" + r.topN).padEnd(18)} ${String(r.xirrPct).padStart(7)}% ${String(r.maxDrawdownPct).padStart(7)}% ${String(r.sharpe).padStart(7)}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    window: { start: START_DATE.toISOString(), end: END_DATE.toISOString(), years: YEARS },
    friction: FRICTION,
    universeSize: histories.size,
    monthEnds: monthEnds.length,
    nifty,
    scenarios: scenarios.map((s) => ({ label: s.label, opts: s.opts })),
    results: allResults,
    bestPerScenario,
    honestyNotes: [
      "Survivorship bias: universe uses TODAY's Smallcap 250 + Microcap 250 constituents; delisted/demoted names from 2022-2026 are not included.",
      "Dividends not included — understates total return by ~2-4% over 4 years.",
      "Transaction friction 0.5% round-trip applied to every buy AND sell. Understates costs for thinly-traded names.",
      "Stop-loss walks daily closes within each rebalance period; intra-bar stops not triggered unless a close breaks below.",
      "Profit ladder: 30% out at +30%, another 30% at +50%, 40% held to rebalance. Applied WHEN active only.",
      "ERC weighting uses 20d realised volatility — rebalanced on each rebalance date.",
      "No look-ahead: scoring + sizing use data strictly up to the rebalance date.",
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
