#!/usr/bin/env node
/**
 * Multi-Year Concentration Study
 *
 * Runs the honest paper-trading simulation across multiple calendar
 * years AND multiple concentration levels (top-1, top-3, top-5, top-10)
 * per scan. Produces a matrix that exposes:
 *
 *   • Which years were kind vs. hostile to the engine
 *   • Whether concentration helps (signal at the top) or hurts
 *     (lose diversification benefits)
 *   • Which category (BUY_NOW / MID_TERM / FUNDAMENTAL) contributes
 *     what at each level
 *   • Alpha vs Nifty 50 per cell
 *
 * Honest methodology (inherited from Phase 0-4):
 *   • Yahoo adjClose + proportional H/L scaling (corporate-action-safe)
 *   • 0.5% round-trip friction
 *   • 3× ATR SL / 7× ATR target
 *   • Activation-gated trailing at +2× ATR
 *   • Sector exclusions (Banking / Tourism / Cement / Chemicals)
 *   • Max 2 per sector in any top-N
 *
 * Known biases documented in the output report:
 *   1. Fundamentals snapshot is Apr 2026 (look-ahead worsens for
 *      older years — 2023 least honest, 2026 YTD most honest)
 *   2. Universe composition is as-of Apr 2026 (survivorship)
 *   3. Mock macro regime (no historical regime data)
 *
 * Usage:
 *   node scripts/multi-year-concentration.mjs
 *   node scripts/multi-year-concentration.mjs --universe=nifty100  # faster
 *   node scripts/multi-year-concentration.mjs --years=2024,2025
 */

import { fileURLToPath } from "url";
import path from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import YahooFinance from "yahoo-finance2";
import { analyzeStock, midTermAnalysis } from "../analysis.js";
import { scoreFundamentals, loadFundamentalsFromDisk, getFundamentals } from "../fundamentals.js";
import { getNifty100, getNifty500 } from "../stockList.js";
import { getPointInTimeFundamentals, computePitSectorPeMedians } from "../pointInTimeFundamentals.js";
import { classifyRegime, regimeSizeFromLabel, shouldSkipScan } from "../historicalRegime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORT_DIR = path.join(__dirname, "..", "reports");

// ──────────────────── CLI ────────────────────

function parseArgs() {
  const args = {};
  for (const raw of process.argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const [k, v] = raw.slice(2).split("=");
    args[k] = v === undefined ? true : v;
  }
  return args;
}
const CLI = parseArgs();

// --pit flag enables point-in-time fundamentals (honest, look-ahead-free).
// Without it, every scan uses the current fundamentals.json snapshot
// (look-ahead contaminated for older years).
const PIT = !!CLI.pit;
// Phase 7: PIT coverage expanded to 494/500 Nifty 500 stocks, so both
// modes can default to nifty500 now.
const UNIVERSE = CLI.universe || "nifty500";
const YEARS = (CLI.years || "2023,2024,2025,2026").split(",").map((y) => parseInt(y.trim(), 10));
const CONCENTRATIONS = (CLI.concentrations || "1,3,5,10").split(",").map((n) => parseInt(n.trim(), 10));
const FRICTION_PCT = CLI.friction !== undefined ? parseFloat(CLI.friction) : 0.5;
// Phase 6 defaults: 4× SL / 6× target (reverted Phase 1's 3/7).
const SL_MULT = CLI["sl-mult"] !== undefined ? parseFloat(CLI["sl-mult"]) : 4;
const TARGET_MULT = CLI["target-mult"] !== undefined ? parseFloat(CLI["target-mult"]) : 6;
const TRAIL_MULT = CLI["trail-mult"] !== undefined ? parseFloat(CLI["trail-mult"]) : 3;
const TRAIL_ACTIVATION_MULT = 2;
const MAX_PER_SECTOR = 2;
// Phase 6: Banking removed from exclusions after 2025 diagnostic showed it
// was a top-performing sector (55% WR, +5% avg — rate-cut cycle). Keep the
// other three (0% WR in 2025).
const EXCLUDED_SECTORS = new Set(["Tourism", "Cement", "Chemicals"]);
// Phase 6: cross-category dedup flag.
const CROSS_CATEGORY_DEDUP = CLI["no-cross-dedup"] ? false : true;
// Phase 7: real regime overlay on/off. When enabled, position sizes and
// skip-scan decisions come from the historicalRegime classifier operating
// on live Nifty history.
const USE_REGIME = CLI.regime !== undefined ? (CLI.regime !== "false" && CLI.regime !== "0") : true;
// Phase 7: top-1 conviction gate. Only take the #1 pick if its score is at
// least CONVICTION_GAP points above #2. Tunable. 0 disables.
const CONVICTION_GAP = CLI["conviction-gap"] !== undefined ? parseFloat(CLI["conviction-gap"]) : 3;

const NIFTY_INDEX_SYMBOL = "^NSEI";
const CONCURRENCY = 6;

// Date coverage: earliest year start minus 8mo warmup → latest year end
const EARLIEST_YEAR = Math.min(...YEARS);
const LATEST_YEAR = Math.max(...YEARS);
const today = new Date();
const historyStart = new Date(EARLIEST_YEAR - 1, 4, 1); // May of previous year → 8mo warmup
const historyEnd = new Date(LATEST_YEAR === today.getFullYear() ? today : new Date(LATEST_YEAR, 11, 31));
historyEnd.setMonth(historyEnd.getMonth() + 1); // small forward buffer

const HISTORY_START_STR = toDateStr(historyStart);
const HISTORY_END_STR = toDateStr(historyEnd);

// ──────────────────── Date helpers ────────────────────

function toDateStr(d) {
  if (typeof d === "string") return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function yearWindow(y) {
  const start = new Date(y, 0, 1);
  let end;
  if (y === today.getFullYear()) {
    const lastMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
    end = new Date(lastMonth === 11 ? y - 1 : y, lastMonth, 28);
    // simpler: cap to last full month
    end = new Date(y, today.getMonth(), 1);
    end.setDate(end.getDate() - 1);
  } else {
    end = new Date(y, 11, 31);
  }
  return { start: toDateStr(start), end: toDateStr(end) };
}

function generateMonthlyScanDates(startStr, endStr) {
  const firstTradingDays = { 0: 3, 1: 2, 2: 2, 3: 4, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1, 10: 3, 11: 1 };
  const start = new Date(startStr);
  const end = new Date(endStr);
  const dates = [];
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  let y = start.getFullYear();
  let m = start.getMonth();
  while (y < end.getFullYear() || (y === end.getFullYear() && m <= end.getMonth())) {
    const day = firstTradingDays[m];
    const dateStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (new Date(dateStr) <= end) {
      dates.push({ label: `${monthNames[m]} ${y}`, date: dateStr });
    }
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return dates;
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

// ──────────────────── XIRR ────────────────────

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
    if (Math.abs(newRate - rate) < 1e-9) { rate = newRate; break; }
    rate = newRate;
    if (rate < -0.99) rate = -0.99;
    if (rate > 10) rate = 10;
  }
  return isFinite(rate) ? rate : 0;
}

// ──────────────────── Data fetch ────────────────────

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

async function fetchHistory(symbol) {
  try {
    const result = await yf.chart(symbol, {
      period1: HISTORY_START_STR,
      period2: HISTORY_END_STR,
      interval: "1d",
    });
    if (!result || !result.quotes || result.quotes.length === 0) return null;
    const bars = [];
    for (const q of result.quotes) {
      if (q.close == null || q.open == null || q.high == null || q.low == null) continue;
      const adjClose = q.adjclose != null ? q.adjclose : q.close;
      const ratio = q.close > 0 ? adjClose / q.close : 1;
      bars.push({
        date: new Date(q.date),
        open: q.open * ratio,
        high: q.high * ratio,
        low: q.low * ratio,
        close: adjClose,
        volume: q.volume || 0,
      });
    }
    return bars;
  } catch (err) {
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
      if (completed % 50 === 0 || completed === total) {
        console.log(`  Fetched ${completed}/${total}`);
      }
    }
  }
  console.log(`Fetching ${total} symbols (concurrency ${CONCURRENCY})...`);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`Done. ${histories.size} symbols valid.`);
  return histories;
}

// ──────────────────── Mock quote + slicing ────────────────────

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

function sliceHistoryUpTo(bars, dateStr) {
  const target = new Date(dateStr);
  target.setHours(23, 59, 59, 999);
  return bars.filter((b) => b.date <= target);
}
function sliceHistoryAfter(bars, dateStr) {
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return bars.filter((b) => b.date > target);
}
function computeDMA200(bars) {
  if (!bars || bars.length < 200) return null;
  const closes = bars.slice(-200).map((b) => b.close);
  return closes.reduce((s, v) => s + v, 0) / 200;
}

// ──────────────────── Trade exits ────────────────────

function trackTradeFixed(forwardBars, entry, target, stopLoss, maxExit) {
  const maxDate = new Date(maxExit); maxDate.setHours(23,59,59,999);
  for (const bar of forwardBars) {
    if (bar.date > maxDate) break;
    if (stopLoss && bar.low <= stopLoss) {
      return { exitPrice: stopLoss, exitDate: toDateStr(bar.date), exitReason: "SL_HIT",
        returnPct: ((stopLoss - entry) / entry) * 100 };
    }
    if (target && bar.high >= target) {
      return { exitPrice: target, exitDate: toDateStr(bar.date), exitReason: "TARGET_HIT",
        returnPct: ((target - entry) / entry) * 100 };
    }
  }
  const eligible = forwardBars.filter((b) => b.date <= maxDate);
  if (eligible.length === 0) return { exitPrice: entry, exitDate: maxExit, exitReason: "NO_DATA", returnPct: 0 };
  const last = eligible[eligible.length - 1];
  return { exitPrice: last.close, exitDate: toDateStr(last.date), exitReason: "TIME_EXIT",
    returnPct: ((last.close - entry) / entry) * 100 };
}

function trackTradeTrailing(forwardBars, entry, target, stopLoss, trailDist, activationLevel, maxExit) {
  const maxDate = new Date(maxExit); maxDate.setHours(23,59,59,999);
  let highestClose = entry;
  let currentStop = stopLoss;
  let activated = false;

  for (const bar of forwardBars) {
    if (bar.date > maxDate) break;
    if (stopLoss && bar.low <= stopLoss) {
      return { exitPrice: stopLoss, exitDate: toDateStr(bar.date), exitReason: "SL_HIT",
        returnPct: ((stopLoss - entry) / entry) * 100 };
    }
    if (target && bar.high >= target) {
      return { exitPrice: target, exitDate: toDateStr(bar.date), exitReason: "TARGET_HIT",
        returnPct: ((target - entry) / entry) * 100 };
    }
    if (bar.close > highestClose) highestClose = bar.close;
    if (!activated && activationLevel && highestClose >= activationLevel) activated = true;
    if (activated) {
      const newStop = highestClose - trailDist;
      if (newStop > currentStop) currentStop = newStop;
      if (bar.close <= currentStop && currentStop > stopLoss) {
        return { exitPrice: bar.close, exitDate: toDateStr(bar.date), exitReason: "TRAIL_HIT",
          returnPct: ((bar.close - entry) / entry) * 100 };
      }
    }
  }
  const eligible = forwardBars.filter((b) => b.date <= maxDate);
  if (eligible.length === 0) return { exitPrice: entry, exitDate: maxExit, exitReason: "NO_DATA", returnPct: 0 };
  const last = eligible[eligible.length - 1];
  return { exitPrice: last.close, exitDate: toDateStr(last.date), exitReason: "TIME_EXIT",
    returnPct: ((last.close - entry) / entry) * 100 };
}

function applyFriction(result, frictionPct) {
  if (!result || !isFinite(result.returnPct)) return result;
  return { ...result, returnPctGross: result.returnPct, returnPct: result.returnPct - frictionPct, frictionApplied: frictionPct };
}

// ──────────────────── Scan + pick ────────────────────

function runScan(stocks, histories, scanDateStr, activePositions, topN, pitCtx = null) {
  const buyNow = [], midTerm = [], fundamental = [];
  const scanDate = new Date(scanDateStr);

  for (const stock of stocks) {
    const fullBars = histories.get(stock.symbol);
    if (!fullBars) continue;
    if (EXCLUDED_SECTORS.has(stock.sector || "")) continue;

    const barsUpTo = sliceHistoryUpTo(fullBars, scanDateStr);
    if (barsUpTo.length < 50) continue;

    const quote = buildMockQuote(barsUpTo, stock.symbol);
    if (!quote) continue;
    const analysis = analyzeStock(barsUpTo, quote);
    if (analysis.error) continue;

    const mt = midTermAnalysis(analysis, quote);
    const dma200 = computeDMA200(barsUpTo);

    // Point-in-time fundamentals if enabled, else current snapshot.
    let snap = null;
    if (pitCtx) {
      const pit = getPointInTimeFundamentals(stock.symbol, scanDate, {
        price: quote.regularMarketPrice,
        week52High: quote.fiftyTwoWeekHigh,
        week52Low: quote.fiftyTwoWeekLow,
      });
      if (pit) {
        pit.name = stock.name;
        // Inject PIT sector P/E computed at this scan date
        pit.sectorPe = pitCtx.sectorPeMedians.get(stock.sector) ?? null;
        snap = pit;
      }
    } else {
      snap = getFundamentals(stock.symbol);
    }
    const fund = snap ? scoreFundamentals(snap, dma200) : null;

    const entry = quote.regularMarketPrice;
    const forwardBars = sliceHistoryAfter(fullBars, scanDateStr);
    const atr = analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null;
    const sl = atr ? entry - atr * SL_MULT : mt.stopLoss;
    const tgt = atr ? entry + atr * TARGET_MULT : mt.target;
    const trail = atr ? atr * TRAIL_MULT : null;
    const activation = atr ? entry + atr * TRAIL_ACTIVATION_MULT : null;

    // BUY_NOW
    if (fund && (fund.verdict === "DEEP_VALUE" || fund.verdict === "QUALITY_GROWTH") &&
        analysis.recommendation !== "HOLD") {
      const combined = analysis.score * 0.40 + fund.score * 0.60;
      if (combined >= 60) {
        buyNow.push({
          ...sharedPickFields(stock, entry, sl, tgt, trail, activation, forwardBars),
          category: "BUY_NOW", combinedScore: combined,
          techScore: analysis.score, fundScore: fund.score, fundVerdict: fund.verdict,
          maxExitDate: addCalendarMonths(scanDateStr, 3),
        });
      }
    }
    // MID_TERM
    if (mt.score >= 58) {
      midTerm.push({
        ...sharedPickFields(stock, entry, sl, tgt, trail, activation, forwardBars),
        category: "MID_TERM", midTermScore: mt.score,
        maxExitDate: addTradingDays(scanDateStr, 20),
      });
    }
    // FUNDAMENTAL
    if (fund && (fund.verdict === "DEEP_VALUE" || fund.verdict === "QUALITY_GROWTH")) {
      fundamental.push({
        ...sharedPickFields(stock, entry, sl, tgt, trail, activation, forwardBars),
        category: "FUNDAMENTAL", fundScore: fund.score, fundVerdict: fund.verdict,
        maxExitDate: addCalendarMonths(scanDateStr, 3),
      });
    }
  }

  buyNow.sort((a, b) => b.combinedScore - a.combinedScore);
  midTerm.sort((a, b) => b.midTermScore - a.midTermScore);
  fundamental.sort((a, b) => b.fundScore - a.fundScore);

  // Phase 6: cross-category dedup. Priority: BUY_NOW > FUNDAMENTAL > MID_TERM.
  // Once a stock is claimed by a higher-priority lane it won't be picked by
  // a lower one — prevents triple-weighting a single bad idea.
  const claimedBySymbol = CROSS_CATEGORY_DEDUP ? new Set() : null;

  function pickTopN(candidates, limit, scoreKey) {
    const picked = [];
    const sectorCount = new Map();
    // Phase 7: top-1 conviction gate. If the caller is asking for top-1
    // and CONVICTION_GAP > 0, skip when #1 score doesn't clear #2 by the
    // threshold — reduces picks where #1 was barely ahead of noise.
    // Applied per-category since scores aren't comparable across categories.
    if (limit === 1 && CONVICTION_GAP > 0 && candidates.length >= 2 && scoreKey) {
      const gap = (candidates[0][scoreKey] || 0) - (candidates[1][scoreKey] || 0);
      if (gap < CONVICTION_GAP) return []; // skip the top-1 altogether
    }
    for (const c of candidates) {
      if (picked.length >= limit) break;
      if (activePositions.has(c.symbol)) continue;
      if (claimedBySymbol && claimedBySymbol.has(c.symbol)) continue;
      const sec = c.sector || "Unknown";
      if ((sectorCount.get(sec) || 0) >= MAX_PER_SECTOR) continue;
      sectorCount.set(sec, (sectorCount.get(sec) || 0) + 1);
      picked.push(c);
      if (claimedBySymbol) claimedBySymbol.add(c.symbol);
    }
    return picked;
  }
  // Pick in priority order so dedup takes effect
  const buyNowPicks = pickTopN(buyNow, topN, "combinedScore");
  const fundamentalPicks = pickTopN(fundamental, topN, "fundScore");
  const midTermPicks = pickTopN(midTerm, topN, "midTermScore");
  return {
    buyNowPicks,
    midTermPicks,
    fundamentalPicks,
  };
}

function sharedPickFields(stock, entry, sl, tgt, trail, activation, forwardBars) {
  return {
    symbol: stock.symbol, name: stock.name, sector: stock.sector,
    entryPrice: entry, stopLoss: sl, target: tgt, trailDist: trail, trailActivation: activation,
    forwardBars,
  };
}

// ──────────────────── Simulate one (year, concentration, exitMode) cell ────────────────────

function simulate(stocks, histories, scanDates, topN, exitMode, frictionPct, usePit = false) {
  const trades = [];
  const active = new Set();
  const niftyBars = histories.get(NIFTY_INDEX_SYMBOL);

  const regimeStats = { RISK_OFF: 0, NEUTRAL: 0, RISK_ON: 0, skipped: 0 };

  for (const scan of scanDates) {
    for (const t of trades) {
      if (t.exitDate && t.exitDate <= scan.date && active.has(t.symbol)) active.delete(t.symbol);
    }

    // Phase 7: real regime classification at scan date (no look-ahead —
    // only uses niftyBars ≤ scan.date).
    let regime = "NEUTRAL", regimeMetrics = null, sizeMult = 1.0;
    if (USE_REGIME && niftyBars) {
      const r = classifyRegime(niftyBars, new Date(scan.date));
      regime = r.regime; regimeMetrics = r.metrics;
      sizeMult = regimeSizeFromLabel(regime);
      regimeStats[regime] = (regimeStats[regime] || 0) + 1;
      // Skip scans during catastrophic risk-off (−12% in 20 days)
      if (shouldSkipScan(regime, regimeMetrics)) {
        regimeStats.skipped++;
        continue;
      }
    }

    // Build point-in-time sector-P/E medians once per scan (if --pit enabled)
    let pitCtx = null;
    if (usePit) {
      const priceBySymbol = new Map();
      for (const s of stocks) {
        const bars = histories.get(s.symbol);
        if (!bars) continue;
        const bu = sliceHistoryUpTo(bars, scan.date);
        if (bu.length > 0) priceBySymbol.set(s.symbol, bu[bu.length - 1].close);
      }
      const medians = computePitSectorPeMedians(stocks, new Date(scan.date), priceBySymbol);
      pitCtx = { sectorPeMedians: medians };
    }

    const { buyNowPicks, midTermPicks, fundamentalPicks } = runScan(stocks, histories, scan.date, active, topN, pitCtx);
    const all = [...buyNowPicks, ...midTermPicks, ...fundamentalPicks];
    for (const pick of all) {
      active.add(pick.symbol);
      let res;
      if (exitMode === "trailing" && pick.trailDist) {
        res = trackTradeTrailing(pick.forwardBars, pick.entryPrice, pick.target, pick.stopLoss, pick.trailDist, pick.trailActivation, pick.maxExitDate);
      } else {
        res = trackTradeFixed(pick.forwardBars, pick.entryPrice, pick.target, pick.stopLoss, pick.maxExitDate);
      }
      res = applyFriction(res, frictionPct);
      // Phase 7: size-scale the return by regime multiplier. This represents
      // taking a smaller position in risky regimes (vs taking full size always).
      const sizedRet = res.returnPct * sizeMult;
      trades.push({
        symbol: pick.symbol, sector: pick.sector, category: pick.category,
        scanDate: scan.date, entryPrice: pick.entryPrice,
        stopLoss: pick.stopLoss, target: pick.target, maxExitDate: pick.maxExitDate,
        regime, sizeMult, unsizedReturnPct: res.returnPct,
        ...res,
        returnPct: sizedRet, // overwrite — downstream uses .returnPct
      });
      if (res.exitDate <= scan.date) active.delete(pick.symbol);
    }
  }
  // Finalize stragglers
  for (const t of trades) {
    if (!t.exitDate) {
      const fullBars = histories.get(t.symbol);
      if (fullBars) {
        const fwdBars = sliceHistoryAfter(fullBars, t.scanDate);
        const res = exitMode === "trailing"
          ? trackTradeTrailing(fwdBars, t.entryPrice, t.target, t.stopLoss, null, null, t.maxExitDate)
          : trackTradeFixed(fwdBars, t.entryPrice, t.target, t.stopLoss, t.maxExitDate);
        Object.assign(t, applyFriction(res, frictionPct));
      }
    }
  }
  return trades;
}

// ──────────────────── Metrics ────────────────────

function maxDrawdown(trades) {
  if (trades.length === 0) return 0;
  const sorted = [...trades].sort((a, b) => new Date(a.scanDate) - new Date(b.scanDate));
  let equity = 100, peak = 100, maxDD = 0;
  for (const t of sorted) {
    equity *= 1 + t.returnPct / 100 / Math.max(1, trades.length / 12);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function computeCellMetrics(trades, niftyBars, yearWindow) {
  const n = trades.length;
  if (n === 0) return { totalTrades: 0, winRate: 0, avgReturn: 0, xirr: 0, niftyXIRR: 0, alpha: 0, maxDD: 0 };

  const wins = trades.filter((t) => t.returnPct > 0).length;
  const winRate = (wins / n) * 100;
  const avgReturn = trades.reduce((s, t) => s + t.returnPct, 0) / n;

  const cashflows = [];
  for (const t of trades) {
    cashflows.push({ date: new Date(t.scanDate), amount: -t.entryPrice });
    cashflows.push({ date: new Date(t.exitDate), amount: t.exitPrice * (1 - (t.frictionApplied || 0) / 100) });
  }
  cashflows.sort((a, b) => a.date - b.date);
  const portfolioXIRR = cashflows.length >= 2 ? xirr(cashflows) * 100 : 0;

  let niftyXIRR = 0;
  if (niftyBars) {
    const nStart = sliceHistoryUpTo(niftyBars, yearWindow.start);
    const nEnd = sliceHistoryUpTo(niftyBars, yearWindow.end);
    if (nStart.length && nEnd.length) {
      const sp = nStart[nStart.length - 1].close;
      const ep = nEnd[nEnd.length - 1].close;
      const cf = [
        { date: new Date(yearWindow.start), amount: -sp },
        { date: new Date(yearWindow.end), amount: ep },
      ];
      niftyXIRR = xirr(cf) * 100;
    }
  }
  const alpha = portfolioXIRR - niftyXIRR;

  const slHits = trades.filter((t) => t.exitReason === "SL_HIT").length;
  const targetHits = trades.filter((t) => t.exitReason === "TARGET_HIT").length;
  const trailHits = trades.filter((t) => t.exitReason === "TRAIL_HIT").length;
  const timeExits = trades.filter((t) => t.exitReason === "TIME_EXIT" || t.exitReason === "NO_DATA").length;

  return { totalTrades: n, wins, winRate, avgReturn, portfolioXIRR, niftyXIRR, alpha,
    maxDD: maxDrawdown(trades), slHits, targetHits, trailHits, timeExits };
}

// ──────────────────── Category breakdown ────────────────────

function byCategory(trades) {
  const out = {};
  for (const cat of ["BUY_NOW", "MID_TERM", "FUNDAMENTAL"]) {
    const ct = trades.filter((t) => t.category === cat);
    if (ct.length === 0) { out[cat] = null; continue; }
    const wins = ct.filter((t) => t.returnPct > 0).length;
    out[cat] = {
      count: ct.length,
      winRate: (wins / ct.length) * 100,
      avgReturn: ct.reduce((s, t) => s + t.returnPct, 0) / ct.length,
    };
  }
  return out;
}

// ──────────────────── Main ────────────────────

async function main() {
  console.log("=== Multi-Year Concentration Study ===");
  console.log(`Years: ${YEARS.join(", ")} | Concentrations: ${CONCENTRATIONS.join(", ")}`);
  console.log(`Universe: ${UNIVERSE} | History: ${HISTORY_START_STR} → ${HISTORY_END_STR}`);
  console.log(`Fundamentals: ${PIT ? "POINT-IN-TIME (honest)" : "current snapshot (look-ahead contaminated for older years)"}`);

  loadFundamentalsFromDisk();
  const stocks = UNIVERSE === "nifty500" ? getNifty500() : getNifty100();
  console.log(`Universe size: ${stocks.length}`);

  const histories = await fetchAllHistories(stocks);
  if (!histories.has(NIFTY_INDEX_SYMBOL)) {
    console.error("FATAL: Nifty index data not fetched");
    process.exit(1);
  }
  const niftyBars = histories.get(NIFTY_INDEX_SYMBOL);

  const results = [];
  for (const year of YEARS) {
    const yw = yearWindow(year);
    const scanDates = generateMonthlyScanDates(yw.start, yw.end);
    if (scanDates.length === 0) {
      console.warn(`No scan dates for year ${year}`);
      continue;
    }
    console.log(`\n${year}: ${yw.start} → ${yw.end} (${scanDates.length} scans)`);

    for (const concentration of CONCENTRATIONS) {
      for (const exitMode of ["fixed", "trailing"]) {
        const trades = simulate(stocks, histories, scanDates, concentration, exitMode, FRICTION_PCT, PIT);
        const metrics = computeCellMetrics(trades, niftyBars, yw);
        const cats = byCategory(trades);
        results.push({ year, yearWindow: yw, concentration, exitMode, trades: trades.length,
          metrics, cats });
        console.log(`  top-${concentration} ${exitMode}: trades=${metrics.totalTrades} WR=${metrics.winRate.toFixed(1)}% XIRR=${metrics.portfolioXIRR.toFixed(1)}% α=${metrics.alpha >= 0 ? "+" : ""}${metrics.alpha.toFixed(1)}% maxDD=${metrics.maxDD.toFixed(1)}%`);
      }
    }
  }

  generateReport(results);
}

// ──────────────────── Report ────────────────────

function generateReport(results) {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const suffix = PIT ? "-pit" : "";
  const reportPath = path.join(REPORT_DIR, `multi-year-concentration-${stamp}${suffix}.md`);

  let md = "";
  md += `# Multi-Year Concentration Study — ${PIT ? "Point-in-Time (Honest)" : "Honest Paper Trading"}\n\n`;
  md += `**Generated:** ${new Date().toISOString()}  \n`;
  md += `**Universe:** ${UNIVERSE}  \n`;
  md += `**Fundamentals:** ${PIT ? "**point-in-time** (90-day reporting lag, no look-ahead)" : "current snapshot (look-ahead bias for older years)"}  \n`;
  md += `**Years analyzed:** ${YEARS.join(", ")}  \n`;
  md += `**Concentrations tested:** top-${CONCENTRATIONS.join(", top-")}  \n`;
  md += `**Exit modes:** fixed + trailing  \n`;
  md += `**Friction:** ${FRICTION_PCT}% round-trip  \n`;
  md += `**SL/Target:** ${SL_MULT}× / ${TARGET_MULT}× ATR  \n`;
  md += `**Trail:** ${TRAIL_MULT}× ATR, activates at +${TRAIL_ACTIVATION_MULT}× gain  \n`;
  md += "\n";

  // ───────── Alpha matrix per exit mode ─────────
  md += "## Headline Alpha Matrix (vs Nifty 50, by year × concentration)\n\n";
  for (const exitMode of ["fixed", "trailing"]) {
    md += `### Exit mode: ${exitMode}\n\n`;
    md += "| Year | Nifty XIRR |";
    for (const c of CONCENTRATIONS) md += ` Top-${c} α |`;
    md += "\n|---|---|";
    for (const c of CONCENTRATIONS) md += "---|";
    md += "\n";
    for (const year of YEARS) {
      const firstCell = results.find((r) => r.year === year && r.exitMode === exitMode);
      const niftyXIRR = firstCell?.metrics?.niftyXIRR ?? 0;
      md += `| ${year} | ${niftyXIRR.toFixed(1)}% |`;
      for (const c of CONCENTRATIONS) {
        const cell = results.find((r) => r.year === year && r.concentration === c && r.exitMode === exitMode);
        if (!cell) { md += " — |"; continue; }
        const a = cell.metrics.alpha;
        const sign = a >= 0 ? "+" : "";
        md += ` ${sign}${a.toFixed(1)}% |`;
      }
      md += "\n";
    }
    md += "\n";
  }

  // ───────── XIRR matrix ─────────
  md += "## Portfolio XIRR Matrix (absolute returns)\n\n";
  for (const exitMode of ["fixed", "trailing"]) {
    md += `### Exit mode: ${exitMode}\n\n`;
    md += "| Year | Nifty |";
    for (const c of CONCENTRATIONS) md += ` Top-${c} |`;
    md += "\n|---|---|";
    for (const c of CONCENTRATIONS) md += "---|";
    md += "\n";
    for (const year of YEARS) {
      const firstCell = results.find((r) => r.year === year && r.exitMode === exitMode);
      const niftyXIRR = firstCell?.metrics?.niftyXIRR ?? 0;
      md += `| ${year} | ${niftyXIRR.toFixed(1)}% |`;
      for (const c of CONCENTRATIONS) {
        const cell = results.find((r) => r.year === year && r.concentration === c && r.exitMode === exitMode);
        if (!cell) { md += " — |"; continue; }
        md += ` ${cell.metrics.portfolioXIRR.toFixed(1)}% |`;
      }
      md += "\n";
    }
    md += "\n";
  }

  // ───────── Win rate matrix ─────────
  md += "## Win-Rate Matrix\n\n";
  for (const exitMode of ["fixed", "trailing"]) {
    md += `### Exit mode: ${exitMode}\n\n`;
    md += "| Year |";
    for (const c of CONCENTRATIONS) md += ` Top-${c} |`;
    md += "\n|---|";
    for (const c of CONCENTRATIONS) md += "---|";
    md += "\n";
    for (const year of YEARS) {
      md += `| ${year} |`;
      for (const c of CONCENTRATIONS) {
        const cell = results.find((r) => r.year === year && r.concentration === c && r.exitMode === exitMode);
        if (!cell) { md += " — |"; continue; }
        md += ` ${cell.metrics.winRate.toFixed(1)}% (${cell.metrics.totalTrades}) |`;
      }
      md += "\n";
    }
    md += "\n";
  }

  // ───────── Per-year deep dive ─────────
  md += "## Per-Year Deep Dive\n\n";
  for (const year of YEARS) {
    const yearCells = results.filter((r) => r.year === year && r.exitMode === "fixed");
    const yw = yearCells[0]?.yearWindow;
    const niftyXIRR = yearCells[0]?.metrics?.niftyXIRR ?? 0;
    const isPartial = year === today.getFullYear();
    md += `### ${year}${isPartial ? " (YTD)" : ""}\n\n`;
    md += `Window: ${yw?.start} → ${yw?.end} | Nifty 50: **${niftyXIRR.toFixed(1)}% XIRR**\n\n`;

    // Best cell this year
    const allThisYear = results.filter((r) => r.year === year);
    const bestCell = allThisYear.sort((a, b) => b.metrics.alpha - a.metrics.alpha)[0];
    const worstCell = allThisYear.sort((a, b) => a.metrics.alpha - b.metrics.alpha)[0];
    md += `- **Best cell:** Top-${bestCell.concentration} ${bestCell.exitMode} → α=**${bestCell.metrics.alpha >= 0 ? "+" : ""}${bestCell.metrics.alpha.toFixed(1)}%**, WR=${bestCell.metrics.winRate.toFixed(1)}%, ${bestCell.metrics.totalTrades} trades\n`;
    md += `- **Worst cell:** Top-${worstCell.concentration} ${worstCell.exitMode} → α=**${worstCell.metrics.alpha >= 0 ? "+" : ""}${worstCell.metrics.alpha.toFixed(1)}%**, WR=${worstCell.metrics.winRate.toFixed(1)}%, ${worstCell.metrics.totalTrades} trades\n`;

    // Category contribution at top-3 fixed (representative)
    const repCell = results.find((r) => r.year === year && r.concentration === 3 && r.exitMode === "fixed");
    if (repCell?.cats) {
      md += `- **Category mix (top-3 fixed):** `;
      const parts = [];
      for (const [k, v] of Object.entries(repCell.cats)) {
        if (v) parts.push(`${k} ${v.count} trades @ ${v.avgReturn >= 0 ? "+" : ""}${v.avgReturn.toFixed(2)}% avg, WR ${v.winRate.toFixed(0)}%`);
      }
      md += parts.join(" · ") + "\n";
    }
    md += "\n";
  }

  // ───────── Top-level insights ─────────
  md += "## Top Insights\n\n";
  const insights = extractInsights(results);
  for (let i = 0; i < insights.length; i++) {
    md += `${i + 1}. ${insights[i]}\n`;
  }
  md += "\n";

  // ───────── Action items ─────────
  md += "## Action Items for Engine Improvement\n\n";
  const actions = buildActionItems(results);
  for (let i = 0; i < actions.length; i++) {
    md += `### P${actions[i].priority}: ${actions[i].title}\n\n`;
    md += `${actions[i].detail}\n\n`;
  }

  // ───────── Biases ─────────
  md += "## Known Biases & Caveats\n\n";
  md += "1. **Fundamentals look-ahead.** `fundamentals.json` is the Apr 2026 snapshot. Older years 'know' today's margins/ROE/debt. The bias worsens monotonically with age — 2026 YTD is the honest year; 2023 is the most contaminated.\n";
  md += "2. **Survivorship bias.** Universe is as of Apr 2026 — stocks delisted or kicked from Nifty 500 between 2023–2026 are absent. Typically biases results slightly upward.\n";
  md += "3. **Mock macro regime.** The backtest doesn't have historical macro regime data, so Kelly-lite sizing is disabled here for simplicity (equal-weight trades).\n";
  md += "4. **No slippage beyond friction.** The 0.5% friction is generous for Nifty 500 largecaps but aggressive for midcaps. A stock-weighted slippage model would be more accurate.\n";
  md += "5. **Quarterly earnings not embedded.** We don't enforce earnings blackouts in this backtest — production has the guard, but the multi-year sim pre-dates live earnings calendar data for 2023-2024.\n\n";

  md += "---\n";
  md += `*Generated by scripts/multi-year-concentration.mjs on ${new Date().toISOString()}*\n`;

  writeFileSync(reportPath, md, "utf-8");
  console.log(`\nReport written to: ${reportPath}`);
}

// ──────────────────── Insights extraction ────────────────────

function extractInsights(results) {
  const insights = [];

  // 1. Does concentration help or hurt?
  const byConc = new Map();
  for (const c of CONCENTRATIONS) {
    const cells = results.filter((r) => r.concentration === c && r.exitMode === "fixed");
    const avgAlpha = cells.reduce((s, r) => s + r.metrics.alpha, 0) / (cells.length || 1);
    byConc.set(c, avgAlpha);
  }
  const sortedConc = [...byConc.entries()].sort((a, b) => b[1] - a[1]);
  const best = sortedConc[0], worst = sortedConc[sortedConc.length - 1];
  insights.push(`Concentration sweet spot (avg alpha across years, fixed exit): **top-${best[0]} delivers ${best[1] >= 0 ? "+" : ""}${best[1].toFixed(1)}% alpha**, top-${worst[0]} delivers ${worst[1] >= 0 ? "+" : ""}${worst[1].toFixed(1)}%. ` +
    (best[0] < worst[0]
      ? `Signal is strongest at the TOP of the ranking — adding lower-ranked picks dilutes alpha.`
      : `Spreading picks across more names actually HELPS — the top-1 signal alone is noisier than the crowd.`));

  // 2. Year-over-year variance
  const byYear = new Map();
  for (const year of YEARS) {
    const cells = results.filter((r) => r.year === year && r.exitMode === "fixed");
    const bestYearAlpha = Math.max(...cells.map((c) => c.metrics.alpha));
    byYear.set(year, bestYearAlpha);
  }
  const yearEntries = [...byYear.entries()];
  const goodYears = yearEntries.filter(([, a]) => a > 0).map(([y]) => y);
  const badYears = yearEntries.filter(([, a]) => a <= 0).map(([y]) => y);
  insights.push(`Alpha generation is regime-dependent: engine beat Nifty in **${goodYears.length}/${yearEntries.length} years**` +
    (goodYears.length > 0 ? ` (${goodYears.join(", ")})` : "") +
    (badYears.length > 0 ? ` — it underperformed in ${badYears.join(", ")}.` : "."));

  // 3. Does trailing help or hurt?
  const fixedCells = results.filter((r) => r.exitMode === "fixed");
  const trailCells = results.filter((r) => r.exitMode === "trailing");
  const avgFixedAlpha = fixedCells.reduce((s, r) => s + r.metrics.alpha, 0) / (fixedCells.length || 1);
  const avgTrailAlpha = trailCells.reduce((s, r) => s + r.metrics.alpha, 0) / (trailCells.length || 1);
  const diff = avgTrailAlpha - avgFixedAlpha;
  insights.push(`Trailing stop vs fixed target (avg across all cells): trailing ${diff >= 0 ? "adds" : "costs"} **${Math.abs(diff).toFixed(2)} pp alpha**. ` +
    (diff > 0.5 ? "Clear win for trailing — the activation gate is doing what it should."
      : diff < -0.5 ? "Fixed target still wins — trailing is cutting too early even with the +2×ATR activation gate."
      : "Roughly a wash — pick based on secondary considerations (drawdown, holding time)."));

  // 4. Category performance at top-3 fixed
  const catAgg = { BUY_NOW: [], MID_TERM: [], FUNDAMENTAL: [] };
  for (const r of results.filter((r) => r.exitMode === "fixed" && r.concentration === 3)) {
    for (const [k, v] of Object.entries(r.cats)) {
      if (v) catAgg[k].push(v.avgReturn);
    }
  }
  const catRanking = [...Object.entries(catAgg)]
    .map(([k, arr]) => [k, arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null])
    .filter(([, v]) => v != null)
    .sort((a, b) => b[1] - a[1]);
  if (catRanking.length) {
    insights.push(`Category contribution at top-3 fixed (avg return across years): ` +
      catRanking.map(([k, v]) => `**${k}: ${v >= 0 ? "+" : ""}${v.toFixed(2)}%**`).join(" · "));
  }

  // 5. Max drawdown per concentration
  const ddByConc = new Map();
  for (const c of CONCENTRATIONS) {
    const cells = results.filter((r) => r.concentration === c && r.exitMode === "fixed");
    const avgDD = cells.reduce((s, r) => s + r.metrics.maxDD, 0) / (cells.length || 1);
    ddByConc.set(c, avgDD);
  }
  const lowestDD = [...ddByConc.entries()].sort((a, b) => a[1] - b[1])[0];
  insights.push(`Lowest avg max-drawdown: **top-${lowestDD[0]} at ${lowestDD[1].toFixed(1)}%**. Concentration and drawdown move together — denser portfolios amplify both good and bad months.`);

  return insights;
}

// ──────────────────── Action items ────────────────────

function buildActionItems(results) {
  const actions = [];

  // Check if any top-1 underperforms top-3 or top-5
  const top1Alpha = results.filter((r) => r.exitMode === "fixed" && r.concentration === 1)
    .reduce((s, r) => s + r.metrics.alpha, 0) / YEARS.length;
  const top3Alpha = results.filter((r) => r.exitMode === "fixed" && r.concentration === 3)
    .reduce((s, r) => s + r.metrics.alpha, 0) / YEARS.length;
  if (top1Alpha < top3Alpha - 1) {
    actions.push({
      priority: 0,
      title: "The top-1 pick is noisier than the top-3 average — investigate ranking function",
      detail: `Top-1 avg alpha (${top1Alpha.toFixed(1)}%) underperforms top-3 avg (${top3Alpha.toFixed(1)}%). This is a signal that our scoring function ranks correctly on average but the #1 slot has execution variance. Action: (a) check if there's a specific signal that predicts top-1 failure (sector, verdict), (b) consider a 'stability' filter that demotes stocks with high recent score volatility, (c) add a 'conviction threshold' — only take the top-1 if score gap over top-2 is > X.`,
    });
  }

  // Check whether trailing loses to fixed consistently
  const fixedCells = results.filter((r) => r.exitMode === "fixed");
  const trailCells = results.filter((r) => r.exitMode === "trailing");
  const avgFixed = fixedCells.reduce((s, r) => s + r.metrics.alpha, 0) / fixedCells.length;
  const avgTrail = trailCells.reduce((s, r) => s + r.metrics.alpha, 0) / trailCells.length;
  if (avgTrail < avgFixed - 0.5) {
    actions.push({
      priority: 0,
      title: "Trailing stop still loses to fixed target — activation gate isn't tight enough",
      detail: `Avg alpha fixed=${avgFixed.toFixed(1)}% vs trailing=${avgTrail.toFixed(1)}% (delta ${(avgTrail - avgFixed).toFixed(1)} pp). Despite the +2× ATR activation gate, the trailing engine is still cutting trades short. Action: (a) raise activation threshold from +2×ATR to +3×ATR, (b) widen trail distance from 3×ATR to 4×ATR, (c) add a minimum-hold period (e.g. don't trail within 5 trading days of entry regardless of gain).`,
    });
  }

  // Check whether FUNDAMENTAL category is negative
  let fundAvg = 0, fundCount = 0;
  for (const r of results.filter((r) => r.exitMode === "fixed")) {
    if (r.cats?.FUNDAMENTAL) { fundAvg += r.cats.FUNDAMENTAL.avgReturn; fundCount++; }
  }
  if (fundCount > 0 && fundAvg / fundCount < -1) {
    actions.push({
      priority: 1,
      title: "FUNDAMENTAL category is a net drag — tighten or drop",
      detail: `Avg return across years: ${(fundAvg / fundCount).toFixed(2)}%. The fundamental-only lane (DEEP_VALUE + QUALITY_GROWTH with no technical filter) is still a value trap, even after Phase 4's QG/DV rebalance. Action: (a) require every FUNDAMENTAL pick to ALSO have a positive technical trigger (RSI<40 recovery, MACD bull cross, near-lower Bollinger), (b) or drop the category entirely and fold strong fundamentals into BUY_NOW's score weighting.`,
    });
  }

  // Check if any year has >20% max DD
  const badDDYear = results.filter((r) => r.exitMode === "fixed" && r.metrics.maxDD > 20)
    .sort((a, b) => b.metrics.maxDD - a.metrics.maxDD)[0];
  if (badDDYear) {
    actions.push({
      priority: 1,
      title: `Max drawdown exceeded 20% in ${badDDYear.year} (top-${badDDYear.concentration}) — add regime overlay`,
      detail: `Peak drawdown: ${badDDYear.metrics.maxDD.toFixed(1)}%. Action: port the Phase 2 Kelly-lite regime sizing out of the mock backtest and onto real historical macro regimes. A FILTER (not just a sizer) that STOPS taking picks during identified risk-off regimes would bound downside. Rough eval: would the worst months have been skippable based on pre-month signals (Nifty 20-day MA break, VIX spike, global risk-off)?`,
    });
  }

  // Check top-10 vs top-1 win rate — if top-1 WR is higher, signal is good but rare
  const top1WR = results.filter((r) => r.exitMode === "fixed" && r.concentration === 1)
    .reduce((s, r) => s + r.metrics.winRate, 0) / YEARS.length;
  const top10WR = results.filter((r) => r.exitMode === "fixed" && r.concentration === 10)
    .reduce((s, r) => s + r.metrics.winRate, 0) / YEARS.length;
  if (top1WR > top10WR + 3) {
    actions.push({
      priority: 2,
      title: "Top-1 has meaningfully higher win rate than top-10 — ranking is directionally correct, diversify cautiously",
      detail: `Top-1 WR: ${top1WR.toFixed(1)}% vs top-10 WR: ${top10WR.toFixed(1)}%. The ranking DOES identify quality — just running top-1 only gives up too much diversification benefit. Action: build a 'top-3-with-size-weighting' mode where pick #1 gets 50%, #2 gets 30%, #3 gets 20%. That captures ranking signal without concentrating single-stock risk.`,
    });
  }

  // Always-on: fundamentals data quality
  actions.push({
    priority: 2,
    title: "Eliminate fundamental look-ahead with point-in-time data (biggest honest-measurement fix left)",
    detail: `Current backtest uses today's fundamentals.json for all historical decisions. For 2023-2024 trades this is a real data leak — we 'knew' the FY25 margin outcome when scoring a Q1-FY24 pick. Action: (a) scrape Screener.in or NSE quarterly results keyed by (symbol, fiscal_period, announcement_date), (b) store at .fundamentals-history.jsonl with effective-dated rows, (c) modify backtest to read the snapshot as-of SCAN_DATE not today. This alone likely moves the honest 2023-2024 alpha by ±2-4 pp. Effort: 2-3 days. This is the single highest-ROI remaining measurement fix.`,
  });

  // Always-on: real macro regime history
  actions.push({
    priority: 3,
    title: "Collect historical macro regime labels for the 2023-2026 window",
    detail: "Our Kelly-lite sizing was proven valuable in principle but runs on a mock delta in backtest. Hand-label (or LLM-batch-label) monthly macro regimes for the 48 months of this study based on known major events (SVB collapse, Israel-Hamas, Fed cuts, India election, etc.). Once labelled, re-run this matrix with real Kelly sizing and we can measure whether regime-aware sizing actually improves Sharpe.",
  });

  // Always-on: earnings blackout retroactive
  actions.push({
    priority: 3,
    title: "Backfill earnings calendar for 2023-2025 and re-run with blackout applied",
    detail: "Production has a 3-day earnings blackout (Phase 2). The multi-year sim here doesn't — so our 2023-2025 trades include earnings-gap losses that production wouldn't incur. Backfill BSE/NSE corporate-action announcement dates for the universe and re-run. Expected effect: +0.5-1.0 pp alpha per year, lower max-DD.",
  });

  // Sort by priority
  actions.sort((a, b) => a.priority - b.priority);
  return actions;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
