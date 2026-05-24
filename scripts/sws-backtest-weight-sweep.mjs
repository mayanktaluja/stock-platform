#!/usr/bin/env node
/**
 * SWS — Tech-weight sweep backtest
 * =================================
 *
 * Question: at what tech-weight does the v3 score-blend maximise XIRR
 * on the SWS-scored Indian universe?
 *
 *   v3_score = v1_fundamentals * (1 - w) + technical_score * w
 *
 * For each w in {0, 0.15, 0.30, 0.45, 0.60}, simulate:
 *   - Quarterly rebalance over a 4-year window
 *   - At each rebalance, rank candidates by blended score, hold top 30
 *     equal-weighted until the next rebalance
 *   - Initial capital ₹10L, fully invested
 *
 * Reports: XIRR, total return, max drawdown, monthly Sharpe, turnover %.
 * Comparator: Nifty 50 buy-and-hold over the same window.
 *
 * Honest caveats — printed in the report:
 *   - Look-ahead bias: SWS v1 fundamentals are TODAY'S snapshot.
 *     Realistic XIRR will be lower because the v1 score for any past
 *     date is overstated whenever a stock's fundamentals have improved
 *     during the window. Subtract ~100-200 bps for a real-money estimate.
 *   - Survivorship: candidate set = stocks that exist on SWS today.
 *     Names that delisted during the window are absent.
 *   - No friction: subtract another ~50-100 bps for slippage + brokerage.
 *
 * Usage:
 *   node scripts/sws-backtest-weight-sweep.mjs                  # default
 *   node scripts/sws-backtest-weight-sweep.mjs --years 2
 *   node scripts/sws-backtest-weight-sweep.mjs --hold 20        # top-20 instead of 30
 *   node scripts/sws-backtest-weight-sweep.mjs --weights 0,30,60
 *   node scripts/sws-backtest-weight-sweep.mjs --pool 50        # candidate pool size
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YahooFinance from "yahoo-finance2";
import { analyzeStock } from "../analysis.js";
import { PATHS } from "./sws-config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORT_DIR = path.join(__dirname, "..", "reports");

// ==================== CLI ====================

const ARGS = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
  const [k, v] = a.slice(2).split("=");
  return [k, v ?? true];
}));

const YEARS = parseInt(ARGS.years || "4", 10);
const HOLD_N = parseInt(ARGS.hold || "30", 10);
const POOL_SIZE = parseInt(ARGS.pool || "60", 10); // candidate pool — wider than HOLD_N to give the blend room to choose
const WEIGHTS = (ARGS.weights || "0,15,30,45,60").split(",").map((s) => parseFloat(s) / 100);
// --rank-field=<field> ranks the candidate pool by any score on the picks card
// (default v1 `score`; pass v3_score_100 or v4_score_100 to compare scoring
// models, e.g. `--rank-field=v4_score_100 --weights=0`). STILL look-ahead-biased
// (present-day score held constant at every past rebalance) — directional only,
// never a forward-return pass/fail gate.
const RANK_FIELD = typeof ARGS["rank-field"] === "string" ? ARGS["rank-field"] : "score";
const INITIAL_CAPITAL = 1_000_000; // ₹10L
const REBALANCE_MONTHS = 3; // quarterly

if (!Number.isFinite(YEARS) || YEARS < 1 || YEARS > 6) { console.error("--years must be 1..6"); process.exit(1); }
if (!Number.isFinite(HOLD_N) || HOLD_N < 5 || HOLD_N > 50) { console.error("--hold must be 5..50"); process.exit(1); }
if (WEIGHTS.some((w) => !Number.isFinite(w) || w < 0 || w > 1)) { console.error("--weights values must be 0..100 (percent)"); process.exit(1); }

// ==================== TIME WINDOW ====================

const NOW = new Date();
const HISTORY_END = new Date(NOW);
const HISTORY_START = new Date(NOW);
HISTORY_START.setFullYear(HISTORY_START.getFullYear() - YEARS - 1); // +1y warmup so 200DMA is valid from rebalance #1

const REBAL_FIRST = new Date(NOW);
REBAL_FIRST.setFullYear(REBAL_FIRST.getFullYear() - YEARS);

function rebalanceDates() {
  const out = [];
  const cursor = new Date(REBAL_FIRST);
  while (cursor < HISTORY_END) {
    out.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth() + REBALANCE_MONTHS);
  }
  return out;
}

const REBAL_DATES = rebalanceDates();

// ==================== HELPERS ====================

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function isoDate(d) { return d.toISOString().slice(0, 10); }

function sliceUpTo(bars, date) {
  const cutoff = date.getTime();
  return bars.filter((b) => b.date.getTime() <= cutoff);
}

function priceAt(bars, date) {
  const eligible = sliceUpTo(bars, date);
  return eligible.length ? eligible[eligible.length - 1].close : null;
}

function buildMockQuote(barsUpTo) {
  if (!barsUpTo || barsUpTo.length < 2) return null;
  const last = barsUpTo[barsUpTo.length - 1];
  const prev = barsUpTo[barsUpTo.length - 2];
  const slice252 = barsUpTo.slice(-252);
  return {
    regularMarketPrice: last.close,
    regularMarketPreviousClose: prev.close,
    regularMarketDayHigh: last.high,
    regularMarketDayLow: last.low,
    regularMarketVolume: last.volume,
    regularMarketOpen: last.open,
    fiftyTwoWeekHigh: Math.max(...slice252.map((d) => d.high)),
    fiftyTwoWeekLow: Math.min(...slice252.map((d) => d.low)),
  };
}

function xirr(cashflows) {
  if (!cashflows || cashflows.length < 2) return 0;
  if (!cashflows.some((cf) => cf.amount > 0) || !cashflows.some((cf) => cf.amount < 0)) return 0;
  const npv = (rate) => {
    let r = 0;
    const d0 = cashflows[0].date.getTime();
    for (const cf of cashflows) {
      const years = (cf.date.getTime() - d0) / (365.25 * 864e5);
      r += cf.amount / Math.pow(1 + rate, years);
    }
    return r;
  };
  const dnpv = (rate) => {
    let r = 0;
    const d0 = cashflows[0].date.getTime();
    for (const cf of cashflows) {
      const years = (cf.date.getTime() - d0) / (365.25 * 864e5);
      if (years === 0) continue;
      r -= years * cf.amount / Math.pow(1 + rate, years + 1);
    }
    return r;
  };
  let rate = 0.1;
  for (let i = 0; i < 200; i++) {
    const f = npv(rate);
    const df = dnpv(rate);
    if (Math.abs(df) < 1e-12) break;
    const next = rate - f / df;
    if (Math.abs(next - rate) < 1e-9) { rate = next; break; }
    rate = clamp(next, -0.99, 10);
  }
  return Number.isFinite(rate) ? rate : 0;
}

function maxDrawdown(equityCurve) {
  let peak = -Infinity, dd = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    const cur = (peak - v) / peak;
    if (cur > dd) dd = cur;
  }
  return dd;
}

function monthlySharpe(equityCurve, dates) {
  // Bucket equity into month-end values, compute monthly returns, annualised Sharpe at rf=0.
  const monthly = new Map();
  for (let i = 0; i < equityCurve.length; i++) {
    const k = dates[i].toISOString().slice(0, 7);
    monthly.set(k, equityCurve[i]); // last value per month overwrites — that's fine
  }
  const vals = [...monthly.values()];
  if (vals.length < 3) return 0;
  const rets = [];
  for (let i = 1; i < vals.length; i++) rets.push((vals[i] - vals[i - 1]) / vals[i - 1]);
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(12);
}

// ==================== UNIVERSE ====================

function loadUniverse() {
  const picks = JSON.parse(fs.readFileSync(PATHS.picksLatest, "utf-8"));
  // Rank by RANK_FIELD (v1 `score` by default; v3_score_100 / v4_score_100 to
  // compare models) and mcap >= ₹500cr. Dedupe across sections; keep the
  // highest-ranked entry.
  const rv = (c) => c[RANK_FIELD];
  const map = new Map();
  for (const items of Object.values(picks.sections || {})) {
    if (!Array.isArray(items)) continue;
    for (const c of items) {
      if (!c.ticker || rv(c) == null) continue;
      if ((c.market_cap_inr || 0) < 5_000_000_000) continue; // ₹500cr floor
      const ex = map.get(c.ticker);
      if (!ex || (rv(c) || 0) > (rv(ex) || 0)) map.set(c.ticker, c);
    }
  }
  // Sort by RANK_FIELD desc, take POOL_SIZE.
  const ranked = [...map.values()].sort((a, b) => (rv(b) || 0) - (rv(a) || 0)).slice(0, POOL_SIZE);
  return ranked;
}

// ==================== FETCH ====================

async function fetchAll(tickers) {
  const data = new Map();
  let cursor = 0, ok = 0, fail = 0;
  const CONCURRENCY = 8;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= tickers.length) return;
      const sym = tickers[i].endsWith(".NS") ? tickers[i] : `${tickers[i]}.NS`;
      try {
        const res = await yf.chart(sym, { period1: HISTORY_START, period2: HISTORY_END, interval: "1d" });
        const bars = (res?.quotes || [])
          .filter((q) => q.close != null && q.open != null && q.high != null && q.low != null)
          .map((q) => ({ date: new Date(q.date), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume || 0 }));
        if (bars.length >= 250) { data.set(tickers[i], bars); ok++; }
        else fail++;
      } catch { fail++; }
      if ((ok + fail) % 10 === 0 || (ok + fail) === tickers.length) {
        process.stdout.write(`\r  Fetched ${ok + fail}/${tickers.length} (${ok} ok, ${fail} fail)   `);
      }
    }
  }

  console.log(`\n[fetch] Pulling ${tickers.length} symbols ${isoDate(HISTORY_START)}..${isoDate(HISTORY_END)} …`);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  process.stdout.write("\n");
  return data;
}

// ==================== TECH SCORE AT A DATE ====================

function techScoreAt(bars, date) {
  const upTo = sliceUpTo(bars, date);
  if (upTo.length < 60) return null;
  const quote = buildMockQuote(upTo);
  if (!quote) return null;
  const a = analyzeStock(upTo, quote);
  if (a.error) return null;
  return a.score; // 0-100
}

// ==================== ONE WEIGHT-RUN ====================

function runWeight(weight, candidates, priceData) {
  // Equity curve: build a per-day mark-to-market value across the full window.
  const allDays = [];
  // Build a union of all trading days from any one stock that has a long history.
  const reference = [...priceData.values()].sort((a, b) => b.length - a.length)[0];
  if (!reference) return null;
  for (const b of reference) {
    if (b.date >= REBAL_FIRST && b.date <= HISTORY_END) allDays.push(b.date);
  }
  if (!allDays.length) return null;

  let cash = INITIAL_CAPITAL;
  let positions = []; // {ticker, qty, lastPrice}
  const equityCurve = [];
  const equityDates = [];
  const cashflows = [{ date: REBAL_FIRST, amount: -INITIAL_CAPITAL }];
  let turnover_inr = 0;

  let nextRebal = 0;
  for (const day of allDays) {
    // Trigger rebalance if we hit the next rebalance date (or pass it).
    while (nextRebal < REBAL_DATES.length && day >= REBAL_DATES[nextRebal]) {
      // ── 1. Mark portfolio to current prices, then liquidate notionally ──
      let portValue = cash;
      for (const p of positions) {
        const px = priceAt(priceData.get(p.ticker), day);
        if (px != null) portValue += p.qty * px;
      }

      // ── 2. Score candidates by blended score, pick top HOLD_N ──
      const scored = [];
      for (const c of candidates) {
        const bars = priceData.get(c.ticker);
        if (!bars) continue;
        const tech = techScoreAt(bars, day);
        if (tech == null) continue;
        const v1 = c[RANK_FIELD] ?? c.score; // ranked by --rank-field; CONSTANT (look-ahead) — known limitation
        const blended = v1 * (1 - weight) + tech * weight;
        scored.push({ ticker: c.ticker, blended, v1, tech, price: priceAt(bars, day) });
      }
      scored.sort((a, b) => b.blended - a.blended);
      const winners = scored.filter((s) => s.price != null && s.price > 0).slice(0, HOLD_N);
      if (winners.length === 0) { nextRebal++; continue; }

      // ── 3. Compute new positions: equal-weighted, fully invested ──
      const perPos = portValue / winners.length;
      const oldByTicker = new Map(positions.map((p) => [p.ticker, p]));
      const newPositions = winners.map((w) => ({ ticker: w.ticker, qty: Math.floor(perPos / w.price), lastPrice: w.price }));

      // ── 4. Compute turnover for reporting ──
      const newSet = new Set(newPositions.map((p) => p.ticker));
      const oldSet = new Set(oldByTicker.keys());
      let removed_inr = 0, added_inr = 0;
      for (const p of positions) if (!newSet.has(p.ticker)) {
        const px = priceAt(priceData.get(p.ticker), day);
        if (px != null) removed_inr += p.qty * px;
      }
      for (const p of newPositions) if (!oldSet.has(p.ticker)) added_inr += p.qty * p.lastPrice;
      turnover_inr += Math.max(removed_inr, added_inr);

      // Update cash to reflect any rounding leftover after fully-invested rebalance
      let invested = 0;
      for (const p of newPositions) invested += p.qty * p.lastPrice;
      cash = portValue - invested;
      positions = newPositions;
      nextRebal++;
    }

    // Mark-to-market at end of day
    let val = cash;
    for (const p of positions) {
      const px = priceAt(priceData.get(p.ticker), day);
      if (px != null) val += p.qty * px;
    }
    equityCurve.push(val);
    equityDates.push(day);
  }

  // Final liquidation cashflow at last day
  const finalVal = equityCurve[equityCurve.length - 1] || 0;
  cashflows.push({ date: equityDates[equityDates.length - 1], amount: finalVal });

  const rate = xirr(cashflows);
  const totalReturn = finalVal / INITIAL_CAPITAL - 1;
  const dd = maxDrawdown(equityCurve);
  const sharpe = monthlySharpe(equityCurve, equityDates);
  const num_rebal = REBAL_DATES.length;
  const turnover_pct_per_rebal = (turnover_inr / num_rebal) / INITIAL_CAPITAL;

  return {
    weight,
    xirr: rate,
    total_return: totalReturn,
    max_drawdown: dd,
    sharpe,
    turnover_pct_per_rebal,
    final_value: finalVal,
    rebalance_count: num_rebal,
  };
}

// ==================== NIFTY 50 BENCHMARK ====================

async function fetchNifty() {
  const res = await yf.chart("^NSEI", { period1: HISTORY_START, period2: HISTORY_END, interval: "1d" });
  const bars = (res?.quotes || [])
    .filter((q) => q.close != null)
    .map((q) => ({ date: new Date(q.date), close: q.close }));
  return bars;
}

function niftyMetrics(bars) {
  const start = bars.find((b) => b.date >= REBAL_FIRST);
  const end = bars[bars.length - 1];
  if (!start || !end) return null;
  const ret = end.close / start.close - 1;
  const cashflows = [
    { date: start.date, amount: -INITIAL_CAPITAL },
    { date: end.date, amount: INITIAL_CAPITAL * (1 + ret) },
  ];
  const rate = xirr(cashflows);
  const equityCurve = [];
  const equityDates = [];
  for (const b of bars) {
    if (b.date < REBAL_FIRST) continue;
    equityCurve.push(INITIAL_CAPITAL * (b.close / start.close));
    equityDates.push(b.date);
  }
  return {
    xirr: rate,
    total_return: ret,
    max_drawdown: maxDrawdown(equityCurve),
    sharpe: monthlySharpe(equityCurve, equityDates),
  };
}

// ==================== REPORT ====================

function formatPct(v, digits = 2) {
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

function buildReport(results, nifty, candidates) {
  const md = [];
  md.push(`# SWS — Tech-weight sweep backtest\n`);
  md.push(`**Generated:** ${new Date().toISOString()}\n`);
  md.push(`**Window:** ${YEARS}-year (${isoDate(REBAL_FIRST)} → ${isoDate(HISTORY_END)}), quarterly rebalance (${REBAL_DATES.length} rebalance events)`);
  md.push(`**Hold:** Top ${HOLD_N} from a candidate pool of ${candidates.length} (mcap ≥ ₹500cr, sorted by SWS v1 fundamentals)`);
  md.push(`**Capital:** ₹${(INITIAL_CAPITAL / 100000).toFixed(0)}L initial, fully invested, no friction in this script\n`);

  md.push(`## Headline result\n`);
  md.push(`| Tech weight | XIRR | Total return | Max drawdown | Monthly Sharpe (annlsd) | Turnover % / rebal |`);
  md.push(`|---:|---:|---:|---:|---:|---:|`);
  for (const r of results) {
    md.push(`| ${(r.weight * 100).toFixed(0)}% | ${formatPct(r.xirr)} | ${formatPct(r.total_return)} | ${formatPct(r.max_drawdown)} | ${r.sharpe.toFixed(2)} | ${formatPct(r.turnover_pct_per_rebal)} |`);
  }
  if (nifty) {
    md.push(`| **Nifty 50 (BAH)** | ${formatPct(nifty.xirr)} | ${formatPct(nifty.total_return)} | ${formatPct(nifty.max_drawdown)} | ${nifty.sharpe.toFixed(2)} | — |`);
  }
  md.push(``);

  // Find best XIRR + best Sharpe + best risk-adjusted
  const bestXirr = results.reduce((a, b) => (b.xirr > a.xirr ? b : a));
  const bestSharpe = results.reduce((a, b) => (b.sharpe > a.sharpe ? b : a));
  const bestDD = results.reduce((a, b) => (b.max_drawdown < a.max_drawdown ? b : a));
  md.push(`## Winners\n`);
  md.push(`- **Best XIRR:** ${(bestXirr.weight * 100).toFixed(0)}% tech weight → ${formatPct(bestXirr.xirr)}`);
  md.push(`- **Best Sharpe (annualised):** ${(bestSharpe.weight * 100).toFixed(0)}% tech weight → ${bestSharpe.sharpe.toFixed(2)}`);
  md.push(`- **Lowest max drawdown:** ${(bestDD.weight * 100).toFixed(0)}% tech weight → ${formatPct(bestDD.max_drawdown)}`);
  md.push(``);

  md.push(`## Methodology + caveats — read before acting on this\n`);
  md.push(`**What this backtest does:**`);
  md.push(`1. Loads all SWS-scored stocks with mcap ≥ ₹500cr from the current \`picks-latest.json\`.`);
  md.push(`2. Sorts by SWS v1 fundamentals score, takes the top ${candidates.length} as the candidate pool.`);
  md.push(`3. At each quarterly rebalance date during the ${YEARS}-year window:`);
  md.push(`   - Computes a point-in-time technical score for each candidate from Yahoo OHLC up to that date (RSI, MACD, trend, volume, OBV, etc. — same engine used in production at \`/api/stock\`).`);
  md.push(`   - Blends \`v1 * (1 - w) + tech * w\` and ranks. Picks top ${HOLD_N}, equal-weighted.`);
  md.push(`   - Holds until next rebalance.`);
  md.push(`4. Marks-to-market daily; computes XIRR + drawdown + Sharpe + turnover.\n`);

  md.push(`**Honest limitations** (will overstate XIRR vs reality):`);
  md.push(`- **Look-ahead bias on fundamentals.** SWS v1 score is today's snapshot, applied as a constant across all past rebalance dates. A name whose fundamentals improved during the window gets credited in earlier dates as if those improvements already existed. Subtract roughly **100-200 bps** from each XIRR for a realistic estimate.`);
  md.push(`- **Survivorship.** Universe = stocks SWS covers TODAY. Names that delisted, were acquired, or fell out of coverage during the window are absent — those are precisely the worst performers, so the survivor universe overstates the rising tide.`);
  md.push(`- **No friction.** No brokerage, slippage, STT, or impact cost. Subtract another **50-100 bps** for real-money execution.`);
  md.push(`- **Equal-weighted, fully invested.** Real portfolios use position sizing, cash buffers, and stop-losses — none of which are simulated here.`);
  md.push(`- **Single regime.** ${YEARS} years includes one full mood (post-2022 bull leg in IN equities). The optimal weight may shift in a sustained drawdown regime.`);
  md.push(``);

  md.push(`**What this backtest is good for:** picking the *relative* winner among the weight points. Since all five weights face the same biases, the **delta** between them is informative even though the absolute XIRR is overstated.`);
  md.push(``);

  md.push(`## SEBI-strategist read\n`);
  if (bestXirr.weight === 0) {
    md.push(`The sweep says **fundamentals-only (0% tech) won the XIRR race**. This usually happens when the window is dominated by a multi-year up-trend where any technical exit signal clipped winners early. With the look-ahead bias on fundamentals on top, the result here under-rates the technical contribution. Real-money guidance would still keep some technical weight (15-30%) for drawdown management.`);
  } else if (bestXirr.weight <= 0.3) {
    md.push(`The sweep peaks in the **15-30% tech weight** range — consistent with the practitioner consensus on hybrid composites. The drop-off above 30% suggests technicals add value as a *filter* against momentum-broken stocks but become noisy as a primary score driver.`);
  } else {
    md.push(`The sweep peaks at **${(bestXirr.weight * 100).toFixed(0)}% tech weight** — higher than the 30% currently in production. Worth investigating whether the next-best weight is statistically distinguishable (Sharpe + drawdown also need to favour the higher weight). If results hold under a regime test, lifting the production weight is a defensible change.`);
  }
  md.push(``);

  md.push(`## Re-run\n`);
  md.push(`\`\`\``);
  md.push(`# Override defaults to stress-test sensitivity:`);
  md.push(`node scripts/sws-backtest-weight-sweep.mjs --years 4`);
  md.push(`node scripts/sws-backtest-weight-sweep.mjs --years 2 --hold 20`);
  md.push(`node scripts/sws-backtest-weight-sweep.mjs --weights 0,10,20,30,40,50`);
  md.push(`\`\`\``);
  md.push(``);

  return md.join("\n");
}

// ==================== MAIN ====================

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║ SWS — Tech-weight sweep backtest`);
  console.log(`║ Window: ${isoDate(REBAL_FIRST)} → ${isoDate(HISTORY_END)} (${YEARS}y, ${REBAL_DATES.length} quarterly rebalances)`);
  console.log(`║ Hold: top ${HOLD_N} of ${POOL_SIZE} candidates · Weights: ${WEIGHTS.map((w) => (w * 100).toFixed(0) + "%").join(", ")}`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝`);

  const candidates = loadUniverse();
  console.log(`\n[universe] ${candidates.length} candidates loaded from picks-latest.json`);
  console.log(`  Top 5 by v1: ${candidates.slice(0, 5).map((c) => `${c.ticker}(${c.score?.toFixed(1)})`).join(" ")}`);

  const tickers = candidates.map((c) => c.ticker);
  const priceData = await fetchAll(tickers);
  console.log(`[fetch] ${priceData.size}/${tickers.length} usable price series`);
  if (priceData.size < HOLD_N + 5) {
    console.error(`Not enough usable price series (${priceData.size}) for hold=${HOLD_N}. Aborting.`);
    process.exit(1);
  }

  // Drop candidates without price data
  const usable = candidates.filter((c) => priceData.has(c.ticker));
  console.log(`[universe] ${usable.length} candidates with usable price history`);

  console.log(`\n[backtest] Running ${WEIGHTS.length} weight points …`);
  const results = [];
  for (const w of WEIGHTS) {
    process.stdout.write(`  weight=${(w * 100).toFixed(0)}% … `);
    const t0 = Date.now();
    const r = runWeight(w, usable, priceData);
    if (r) {
      results.push(r);
      console.log(`xirr=${formatPct(r.xirr)}  total=${formatPct(r.total_return)}  dd=${formatPct(r.max_drawdown)}  sharpe=${r.sharpe.toFixed(2)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } else {
      console.log("FAILED");
    }
  }

  console.log(`\n[benchmark] Fetching Nifty 50 …`);
  let nifty = null;
  try { nifty = niftyMetrics(await fetchNifty()); } catch (e) { console.error(`Nifty fetch failed: ${e.message}`); }
  if (nifty) console.log(`  Nifty 50: xirr=${formatPct(nifty.xirr)}  total=${formatPct(nifty.total_return)}  dd=${formatPct(nifty.max_drawdown)}  sharpe=${nifty.sharpe.toFixed(2)}`);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `sws-backtest-weight-sweep-${YEARS}yr-${Date.now()}.md`);
  const report = buildReport(results, nifty, usable);
  fs.writeFileSync(reportPath, report);
  console.log(`\n[report] Written to ${reportPath}`);
  console.log(`\n=== SUMMARY ===`);
  console.log(report.split("\n").slice(0, 20).join("\n"));
}

main().catch((e) => { console.error(e); process.exit(1); });
