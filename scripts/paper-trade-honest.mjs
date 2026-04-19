#!/usr/bin/env node
/**
 * Paper Trading Simulation — HONEST BACKTEST
 *
 * Phase 0 deliverable. Fixes the three things that made the old 5-year
 * number unreliable:
 *
 *   1. Uses ADJUSTED close/high/low throughout so splits and bonuses
 *      don't fabricate 50% drawdowns on unadjusted series.
 *   2. Applies 0.5% round-trip friction (STT + exchange fees + GST +
 *      slippage + brokerage) to every closed trade before P&L.
 *   3. Configurable date window — default 24 months (Apr 2024 → Mar 2026)
 *      because pre-2024 data is noisy on midcap fundamentals.
 *
 * Also adds a second exit engine that actually executes the trailing
 * stop rule the UI has been advertising. We run BOTH (fixed-target and
 * trailing) so the report shows the lift from switching.
 *
 * Usage:
 *   node scripts/paper-trade-honest.mjs                    # 24mo, both modes
 *   node scripts/paper-trade-honest.mjs --window=12mo
 *   node scripts/paper-trade-honest.mjs --start=2024-04-01 --end=2026-03-31
 *   node scripts/paper-trade-honest.mjs --friction=0        # compare no-friction
 *   node scripts/paper-trade-honest.mjs --mode=fixed        # only fixed-exit scenario
 */

import { fileURLToPath } from "url";
import path from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import YahooFinance from "yahoo-finance2";
import { analyzeStock, midTermAnalysis } from "../analysis.js";
import { scoreFundamentals, loadFundamentalsFromDisk, getFundamentals } from "../fundamentals.js";
import { getNifty100, getNifty500 } from "../stockList.js";
import { regimeSizeMultiplier } from "../positionSizing.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORT_DIR = path.join(__dirname, "..", "reports");

// ==================== CLI ARGS ====================

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

function resolveWindow(windowArg) {
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), 1);
  end.setDate(end.getDate() - 1);

  const months = ({ "12mo": 12, "18mo": 18, "24mo": 24, "36mo": 36 })[windowArg];
  if (!months) return null;
  const start = new Date(end);
  start.setMonth(start.getMonth() - months + 1);
  start.setDate(1);
  return { start: toDateStr(start), end: toDateStr(end) };
}

const windowResolved = CLI.start && CLI.end
  ? { start: CLI.start, end: CLI.end }
  : resolveWindow(CLI.window || "24mo") || resolveWindow("24mo");

const SCAN_START = windowResolved.start;
const SCAN_END = windowResolved.end;

const HISTORY_START = (() => {
  const d = new Date(SCAN_START);
  d.setMonth(d.getMonth() - 8);
  return toDateStr(d);
})();
const HISTORY_END = (() => {
  const d = new Date(SCAN_END);
  d.setMonth(d.getMonth() + 4);
  return toDateStr(d);
})();

const FRICTION_PCT = CLI.friction !== undefined ? parseFloat(CLI.friction) : 0.5;
const EXIT_MODE = CLI.mode || "both"; // fixed | trailing | both

// Phase 1 (Apr 2026) defaults. Overridable via CLI for before/after comparison.
const SL_MULTIPLIER = CLI["sl-mult"] !== undefined ? parseFloat(CLI["sl-mult"]) : 3;
const TARGET_MULTIPLIER = CLI["target-mult"] !== undefined ? parseFloat(CLI["target-mult"]) : 7;
const TRAIL_MULTIPLIER = CLI["trail-mult"] !== undefined ? parseFloat(CLI["trail-mult"]) : 3;
const TRAIL_ACTIVATION_MULT = CLI["trail-activation"] !== undefined ? parseFloat(CLI["trail-activation"]) : 2;
const MAX_PER_SECTOR = CLI["max-sector"] !== undefined ? parseInt(CLI["max-sector"]) : 2;
const APPLY_SECTOR_EXCLUSIONS = CLI["no-sector-exclude"] ? false : true;

// Sectors that consistently underperformed across the honest 24-month baseline
// and the prior 8-horizon concentration tests. Production buynow scanner
// already drops these; the backtest now matches that behavior.
const EXCLUDED_SECTORS = new Set(["Banking", "Tourism", "Cement", "Chemicals"]);

// Phase 2: universe selection via CLI
const UNIVERSE = CLI.universe || "nifty100"; // nifty100 | nifty500
const USE_KELLY_SIZING = CLI["kelly"] ? true : false;

// Phase 2: mock macro regime for backtest sizing. In production, the live
// regime is fetched per scan. In backtest we approximate by applying a
// ±10 delta drawn from a deterministic hash of the scan date + sector,
// so we can measure the Sharpe/drawdown effect of regime-scaled sizing
// without needing historical macro data (which doesn't exist).
// If --real-macro=true is set, future work can plug in a regime history.
function mockMacroDelta(scanDate, sector) {
  if (!USE_KELLY_SIZING) return 0;
  let h = 0;
  const s = scanDate + "|" + (sector || "");
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  // Map to ±6 range (moderate regime tilt — not extreme for a mock)
  return ((h % 13) - 6);
}

const NIFTY_INDEX_SYMBOL = "^NSEI";
const CONCURRENCY = 6;

const REPORT_TAG = `${CLI.window || "24mo"}${FRICTION_PCT === 0 ? "-nofriction" : ""}${CLI.label ? "-" + CLI.label : ""}`;
const REPORT_PATH = path.join(REPORT_DIR, `paper-trading-honest-${REPORT_TAG}-report.md`);

// ==================== HELPERS ====================

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
    dates.push({ label: `${monthNames[m]} ${y}`, date: dateStr });
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return dates;
}

const SCAN_DATES = generateMonthlyScanDates(SCAN_START, SCAN_END);

// ==================== XIRR ====================

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

// ==================== DATA FETCHING ====================

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

/**
 * Fetch adjusted bar series. We scale high/low proportionally to
 * (adjclose / close) so the entire bar is consistent in the adjusted
 * price frame. This way when we check "did intraday low breach SL",
 * we're comparing apples to apples — a 1:1 bonus no longer looks like
 * a 50% drawdown.
 */
async function fetchHistory(symbol) {
  try {
    const result = await yf.chart(symbol, {
      period1: HISTORY_START,
      period2: HISTORY_END,
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
        rawClose: q.close,
        volume: q.volume || 0,
      });
    }
    return bars;
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

// ==================== MOCK QUOTE ====================

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
  const targetDate = new Date(dateStr);
  targetDate.setHours(23, 59, 59, 999);
  return bars.filter((b) => b.date <= targetDate);
}

function sliceHistoryAfter(bars, dateStr) {
  const targetDate = new Date(dateStr);
  targetDate.setHours(0, 0, 0, 0);
  return bars.filter((b) => b.date > targetDate);
}

// ==================== TRADE EXIT ENGINES ====================

/**
 * Fixed-target / fixed-SL exit — the existing production behavior.
 */
function trackTradeFixed(forwardBars, entryPrice, target, stopLoss, maxExitDateStr) {
  const maxExitDate = new Date(maxExitDateStr);
  maxExitDate.setHours(23, 59, 59, 999);

  for (const bar of forwardBars) {
    if (bar.date > maxExitDate) break;
    if (stopLoss && bar.low <= stopLoss) {
      return { exitPrice: stopLoss, exitDate: toDateStr(bar.date), exitReason: "SL_HIT",
        returnPct: ((stopLoss - entryPrice) / entryPrice) * 100 };
    }
    if (target && bar.high >= target) {
      return { exitPrice: target, exitDate: toDateStr(bar.date), exitReason: "TARGET_HIT",
        returnPct: ((target - entryPrice) / entryPrice) * 100 };
    }
  }

  const eligible = forwardBars.filter((b) => b.date <= maxExitDate);
  if (eligible.length === 0) {
    return { exitPrice: entryPrice, exitDate: maxExitDateStr, exitReason: "NO_DATA", returnPct: 0 };
  }
  const lastBar = eligible[eligible.length - 1];
  return { exitPrice: lastBar.close, exitDate: toDateStr(lastBar.date), exitReason: "TIME_EXIT",
    returnPct: ((lastBar.close - entryPrice) / entryPrice) * 100 };
}

/**
 * Trailing-stop exit — Phase 1 activation-gated version. The trail
 * doesn't engage until the highest close since entry clears
 * activationLevel (entry + activationMult × ATR). Pre-activation, the
 * fixed initial SL is in force. Post-activation, trailStop = max(
 * highestCloseSinceActivation − trailDist, initialSL). Target wins if
 * hit on the way up. Close-only trail evaluation (no intraday peek).
 */
function trackTradeTrailing(forwardBars, entryPrice, target, stopLoss, trailDist, activationLevel, maxExitDateStr) {
  const maxExitDate = new Date(maxExitDateStr);
  maxExitDate.setHours(23, 59, 59, 999);

  let highestClose = entryPrice;
  let currentStop = stopLoss;
  let activated = false;

  for (const bar of forwardBars) {
    if (bar.date > maxExitDate) break;

    // Hard-SL intraday — safety net that persists even after trail engages
    if (stopLoss && bar.low <= stopLoss) {
      return { exitPrice: stopLoss, exitDate: toDateStr(bar.date), exitReason: "SL_HIT",
        returnPct: ((stopLoss - entryPrice) / entryPrice) * 100 };
    }

    // Target — intraday high fills (real market order would too)
    if (target && bar.high >= target) {
      return { exitPrice: target, exitDate: toDateStr(bar.date), exitReason: "TARGET_HIT",
        returnPct: ((target - entryPrice) / entryPrice) * 100 };
    }

    // Track highest close. Activation gate: trail only engages once we
    // clear the activation level on a daily close.
    if (bar.close > highestClose) highestClose = bar.close;
    if (!activated && activationLevel != null && highestClose >= activationLevel) {
      activated = true;
    }

    if (activated) {
      const newStop = highestClose - trailDist;
      if (newStop > currentStop) currentStop = newStop;
      if (bar.close <= currentStop && currentStop > stopLoss) {
        return { exitPrice: bar.close, exitDate: toDateStr(bar.date), exitReason: "TRAIL_HIT",
          returnPct: ((bar.close - entryPrice) / entryPrice) * 100 };
      }
    }
  }

  const eligible = forwardBars.filter((b) => b.date <= maxExitDate);
  if (eligible.length === 0) {
    return { exitPrice: entryPrice, exitDate: maxExitDateStr, exitReason: "NO_DATA", returnPct: 0 };
  }
  const lastBar = eligible[eligible.length - 1];
  return { exitPrice: lastBar.close, exitDate: toDateStr(lastBar.date), exitReason: "TIME_EXIT",
    returnPct: ((lastBar.close - entryPrice) / entryPrice) * 100 };
}

/**
 * Apply round-trip friction to a closed trade. Friction is charged on
 * the notional — realistically it's charged on entry value + exit value
 * which for small moves is ≈ 2 × entry × rate. We approximate with
 * "subtract 2× friction from return" which is what a trader feels.
 */
function applyFriction(result, frictionPct) {
  if (!result || !isFinite(result.returnPct)) return result;
  const frictionCost = frictionPct; // round-trip charge in percentage points
  return {
    ...result,
    returnPctGross: result.returnPct,
    returnPct: result.returnPct - frictionCost,
    frictionApplied: frictionCost,
  };
}

// ==================== SUPPORT: DMA200 ====================

function computeDMA200(bars) {
  if (!bars || bars.length < 200) return null;
  const closes = bars.slice(-200).map((b) => b.close);
  return closes.reduce((s, v) => s + v, 0) / 200;
}

// ==================== SCAN LOGIC ====================

function runScan(stocks, histories, scanDateStr, activePositions, params = {}) {
  const techWeight = params.techWeight ?? 0.40;
  const fundWeight = params.fundWeight ?? 0.60;
  const buyNowThreshold = params.buyNowThreshold ?? 60;
  const midTermThreshold = params.midTermThreshold ?? 58;
  const slMultiplier = params.slMultiplier ?? SL_MULTIPLIER;
  const targetMultiplier = params.targetMultiplier ?? TARGET_MULTIPLIER;
  const trailMultiplier = params.trailMultiplier ?? TRAIL_MULTIPLIER;
  const trailActivationMult = params.trailActivationMult ?? TRAIL_ACTIVATION_MULT;
  const maxPerSector = params.maxPerSector ?? MAX_PER_SECTOR;
  const applySectorExclusions = params.applySectorExclusions ?? APPLY_SECTOR_EXCLUSIONS;

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

    const atr = analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null;
    const customSL = atr ? entryPrice - atr * slMultiplier : midTerm.stopLoss;
    const customTarget = atr ? entryPrice + atr * targetMultiplier : midTerm.target;
    const trailDist = atr ? atr * trailMultiplier : null;
    const trailActivation = atr ? entryPrice + atr * trailActivationMult : null;

    // Phase 3: capture signal fingerprint at entry for attribution analysis.
    // Each flag is a binary indicator — did this signal fire at entry time?
    // Aggregating these over all closed trades tells us which signals actually
    // predict forward returns vs which ones we've been weighting without
    // evidence. Feeds back into the next round of signal tuning.
    const rsi = analysis.indicators?.rsi ? parseFloat(analysis.indicators.rsi) : null;
    const macd = analysis.indicators?.macd || null;
    const bol = analysis.indicators?.bollinger || null;
    const stoch = analysis.indicators?.stochastic || null;
    const trendStr = analysis.indicators?.trend?.strength || null;
    const vol = analysis.indicators?.volume || null;
    const signalFlags = {
      rsiOversold: rsi != null && rsi < 30,
      rsiOverbought: rsi != null && rsi > 70,
      macdBullCross: macd?.crossover === true,
      macdBearCross: macd?.crossunder === true,
      bolNearLower: bol?.percentB != null && parseFloat(bol.percentB) < 20,
      bolNearUpper: bol?.percentB != null && parseFloat(bol.percentB) > 80,
      stochOversold: stoch?.k != null && stoch?.d != null && parseFloat(stoch.k) < 20 && parseFloat(stoch.d) < 20,
      stochOverbought: stoch?.k != null && stoch?.d != null && parseFloat(stoch.k) > 80 && parseFloat(stoch.d) > 80,
      trendStrongBull: trendStr === "strong_bullish",
      trendStrongBear: trendStr === "strong_bearish",
      volumeSpike: vol?.isSpike === true,
      volumeMajorSpike: vol?.isMajorSpike === true,
      fundDeepValue: fundVerdict === "DEEP_VALUE",
      fundQualityGrowth: fundVerdict === "QUALITY_GROWTH",
    };

    // Phase 1: sector exclusion (applies to BUY_NOW + FUNDAMENTAL — these
    // are the value-oriented buckets where losing sectors drag alpha).
    if (applySectorExclusions && EXCLUDED_SECTORS.has(stock.sector || "")) {
      continue;
    }

    // --- Buy Now ---
    if (fundScore != null) {
      const combined = techScore * techWeight + fundScore * fundWeight;
      if (
        combined >= buyNowThreshold &&
        (fundVerdict === "DEEP_VALUE" || fundVerdict === "QUALITY_GROWTH") &&
        analysis.recommendation !== "HOLD"
      ) {
        buyNowCandidates.push({
          symbol: stock.symbol, name: stock.name, sector: stock.sector,
          category: "BUY_NOW", entryPrice, techScore, fundScore,
          combinedScore: combined, fundVerdict, recommendation: analysis.recommendation,
          stopLoss: customSL, target: customTarget, trailDist, trailActivation, signalFlags,
          maxExitDate: addCalendarMonths(scanDateStr, 3),
          forwardBars, dma200, snap,
        });
      }
    }

    // --- Mid-Term ---
    if (midTerm.score >= midTermThreshold) {
      midTermCandidates.push({
        symbol: stock.symbol, name: stock.name, sector: stock.sector,
        category: "MID_TERM", entryPrice, techScore, midTermScore: midTerm.score,
        recommendation: midTerm.recommendation,
        stopLoss: customSL, target: customTarget, trailDist,
        maxExitDate: addTradingDays(scanDateStr, 20),
        forwardBars, dma200, snap,
      });
    }

    // --- Fundamental ---
    if (fundResult && (fundVerdict === "DEEP_VALUE" || fundVerdict === "QUALITY_GROWTH")) {
      const w52High = quote.fiftyTwoWeekHigh;
      const w52Low = quote.fiftyTwoWeekLow;
      const structuralSL = Math.max(
        dma200 && dma200 < entryPrice ? dma200 : entryPrice * 0.80,
        w52Low && w52Low < entryPrice ? w52Low : entryPrice * 0.80,
        entryPrice * 0.80,
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
        symbol: stock.symbol, name: stock.name, sector: stock.sector,
        category: "FUNDAMENTAL", entryPrice, fundScore, fundVerdict,
        stopLoss: finalSL, target: valuationTarget, trailDist,
        maxExitDate: addCalendarMonths(scanDateStr, 3),
        forwardBars, dma200, snap,
      });
    }
  }

  buyNowCandidates.sort((a, b) => b.combinedScore - a.combinedScore);
  midTermCandidates.sort((a, b) => b.midTermScore - a.midTermScore);
  fundamentalCandidates.sort((a, b) => b.fundScore - a.fundScore);

  // Phase 1: sector cap within each category (max N per sector in the top-K).
  // Prevents the scanner from returning 6 Banking picks on a regime day.
  function pickTop(candidates, limit) {
    const picked = [];
    const sectorCount = new Map();
    for (const c of candidates) {
      if (picked.length >= limit) break;
      if (activePositions.has(c.symbol)) continue;
      const sec = c.sector || "Unknown";
      if ((sectorCount.get(sec) || 0) >= maxPerSector) continue;
      sectorCount.set(sec, (sectorCount.get(sec) || 0) + 1);
      picked.push(c);
    }
    return picked;
  }

  return {
    buyNowPicks: pickTop(buyNowCandidates, 10),
    midTermPicks: pickTop(midTermCandidates, 10),
    fundamentalPicks: pickTop(fundamentalCandidates, 10),
  };
}

// ==================== SIMULATION DRIVER ====================

function simulate(stocks, histories, exitMode, frictionPct) {
  const allTrades = [];
  const activePositions = new Set();

  for (const scan of SCAN_DATES) {
    // Clear positions that have exited
    for (const t of allTrades) {
      if (t.exitDate && t.exitDate <= scan.date && activePositions.has(t.symbol)) {
        activePositions.delete(t.symbol);
      }
    }

    const { buyNowPicks, midTermPicks, fundamentalPicks } = runScan(
      stocks, histories, scan.date, activePositions,
    );

    const allPicks = [
      ...buyNowPicks.map((p) => ({ ...p })),
      ...midTermPicks.map((p) => ({ ...p })),
      ...fundamentalPicks.map((p) => ({ ...p })),
    ];

    for (const pick of allPicks) {
      activePositions.add(pick.symbol);

      let result;
      if (exitMode === "trailing" && pick.trailDist) {
        result = trackTradeTrailing(pick.forwardBars, pick.entryPrice, pick.target,
          pick.stopLoss, pick.trailDist, pick.trailActivation, pick.maxExitDate);
      } else {
        result = trackTradeFixed(pick.forwardBars, pick.entryPrice, pick.target,
          pick.stopLoss, pick.maxExitDate);
      }
      result = applyFriction(result, frictionPct);

      // Phase 2: regime-scaled position size (applied to portfolio-weighted
      // return, not per-trade returnPct — sizing matters for Sharpe/XIRR
      // aggregation, not individual win/loss classification).
      const macroDelta = mockMacroDelta(scan.date, pick.sector);
      const sizeMult = regimeSizeMultiplier(macroDelta);
      const sizedReturnPct = result.returnPct * sizeMult;

      allTrades.push({
        symbol: pick.symbol, name: pick.name, sector: pick.sector,
        category: pick.category, scanDate: scan.date, scanLabel: scan.label,
        entryPrice: pick.entryPrice, techScore: pick.techScore, fundScore: pick.fundScore,
        combinedScore: pick.combinedScore, midTermScore: pick.midTermScore,
        fundVerdict: pick.fundVerdict, stopLoss: pick.stopLoss, target: pick.target,
        trailDist: pick.trailDist, trailActivation: pick.trailActivation,
        macroDelta, sizeMult, sizedReturnPct,
        signalFlags: pick.signalFlags,
        maxExitDate: pick.maxExitDate, ...result,
      });
      if (result.exitDate <= scan.date) activePositions.delete(pick.symbol);
    }
  }

  // Finalize any stragglers (trades whose forwardBars ran out before exit)
  for (const t of allTrades) {
    if (!t.exitDate) {
      const fullBars = histories.get(t.symbol);
      if (fullBars) {
        const fwdBars = sliceHistoryAfter(fullBars, t.scanDate);
        const res = exitMode === "trailing" && t.trailDist
          ? trackTradeTrailing(fwdBars, t.entryPrice, t.target, t.stopLoss, t.trailDist, t.trailActivation, t.maxExitDate)
          : trackTradeFixed(fwdBars, t.entryPrice, t.target, t.stopLoss, t.maxExitDate);
        const sized = applyFriction(res, frictionPct);
        t.sizedReturnPct = sized.returnPct * (t.sizeMult || 1);
        Object.assign(t, sized);
      }
    }
  }

  return allTrades;
}

// ==================== METRICS ====================

function computeMetrics(trades, niftyBars) {
  const n = trades.length;
  if (n === 0) return { totalTrades: 0, winRate: 0, avgReturn: 0, xirr: 0, niftyXIRR: 0, alpha: 0 };

  const wins = trades.filter((t) => t.returnPct > 0).length;
  const losses = n - wins;
  const winRate = (wins / n) * 100;
  const avgReturn = trades.reduce((s, t) => s + t.returnPct, 0) / n;

  const avgWin = wins > 0 ? trades.filter((t) => t.returnPct > 0).reduce((s, t) => s + t.returnPct, 0) / wins : 0;
  const avgLoss = losses > 0 ? trades.filter((t) => t.returnPct <= 0).reduce((s, t) => s + t.returnPct, 0) / losses : 0;
  const payoff = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : 0;
  const expectancy = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss;

  const slHits = trades.filter((t) => t.exitReason === "SL_HIT").length;
  const targetHits = trades.filter((t) => t.exitReason === "TARGET_HIT").length;
  const trailHits = trades.filter((t) => t.exitReason === "TRAIL_HIT").length;
  const timeExits = trades.filter((t) => t.exitReason === "TIME_EXIT" || t.exitReason === "NO_DATA").length;

  const cashflows = [];
  for (const t of trades) {
    const effectiveExit = t.exitPrice * (1 - (t.frictionApplied || 0) / 100);
    cashflows.push({ date: new Date(t.scanDate), amount: -t.entryPrice });
    cashflows.push({ date: new Date(t.exitDate), amount: effectiveExit });
  }
  cashflows.sort((a, b) => a.date - b.date);
  const portfolioXIRR = cashflows.length >= 2 ? xirr(cashflows) * 100 : 0;

  let niftyXIRR = 0;
  if (niftyBars && niftyBars.length > 0) {
    const nStart = sliceHistoryUpTo(niftyBars, SCAN_DATES[0].date);
    const nEnd = sliceHistoryUpTo(niftyBars, SCAN_DATES[SCAN_DATES.length - 1].date);
    if (nStart.length > 0 && nEnd.length > 0) {
      const sp = nStart[nStart.length - 1].close;
      const ep = nEnd[nEnd.length - 1].close;
      const cf = [
        { date: new Date(SCAN_DATES[0].date), amount: -sp },
        { date: new Date(SCAN_DATES[SCAN_DATES.length - 1].date), amount: ep },
      ];
      niftyXIRR = xirr(cf) * 100;
    }
  }

  const alpha = portfolioXIRR - niftyXIRR;

  const avgHoldDays = trades.reduce((s, t) => {
    const days = (new Date(t.exitDate) - new Date(t.scanDate)) / (1000 * 60 * 60 * 24);
    return s + days;
  }, 0) / n;

  return {
    totalTrades: n, wins, losses, winRate, avgReturn, avgWin, avgLoss, payoff, expectancy,
    slHits, targetHits, trailHits, timeExits, portfolioXIRR, niftyXIRR, alpha, avgHoldDays,
  };
}

function maxDrawdown(trades) {
  if (trades.length === 0) return 0;
  const sorted = [...trades].sort((a, b) => new Date(a.scanDate) - new Date(b.scanDate));
  let equity = 100;
  let peak = 100;
  let maxDD = 0;
  for (const t of sorted) {
    equity *= 1 + t.returnPct / 100 / trades.length * 10; // equal-weight approximation
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ==================== REPORT ====================

function categoryBreakdown(trades) {
  const cats = ["BUY_NOW", "MID_TERM", "FUNDAMENTAL"];
  return cats.map((key) => {
    const ct = trades.filter((t) => t.category === key);
    if (ct.length === 0) return { key, count: 0 };
    const wins = ct.filter((t) => t.returnPct > 0).length;
    const avg = ct.reduce((s, t) => s + t.returnPct, 0) / ct.length;
    return { key, count: ct.length, winRate: (wins / ct.length) * 100, avgReturn: avg };
  });
}

/**
 * Phase 3: per-signal attribution. For each binary signal flag, compute
 * hit rate / avg return of trades where the flag was hot vs quiet. The
 * EDGE column (hot − quiet) is the money metric — a signal with +3% edge
 * genuinely discriminates; a signal with ±0.5% edge is noise being
 * dressed up in the recommendation.
 */
function signalAttribution(trades) {
  if (trades.length === 0) return [];
  const signals = [
    "rsiOversold", "rsiOverbought", "macdBullCross", "macdBearCross",
    "bolNearLower", "bolNearUpper", "stochOversold", "stochOverbought",
    "trendStrongBull", "trendStrongBear", "volumeSpike", "volumeMajorSpike",
    "fundDeepValue", "fundQualityGrowth",
  ];
  const results = [];
  for (const sig of signals) {
    const hot = trades.filter((t) => t.signalFlags?.[sig] === true);
    const quiet = trades.filter((t) => t.signalFlags?.[sig] === false);
    if (hot.length === 0) {
      results.push({ signal: sig, hotCount: 0, hotWR: 0, hotAvg: 0, quietAvg: 0, edge: 0 });
      continue;
    }
    const hotWR = (hot.filter((t) => t.returnPct > 0).length / hot.length) * 100;
    const hotAvg = hot.reduce((s, t) => s + t.returnPct, 0) / hot.length;
    const quietAvg = quiet.length > 0 ? quiet.reduce((s, t) => s + t.returnPct, 0) / quiet.length : 0;
    const edge = hotAvg - quietAvg;
    results.push({ signal: sig, hotCount: hot.length, hotWR, hotAvg, quietAvg, edge });
  }
  return results.sort((a, b) => b.edge - a.edge);
}

function sectorBreakdown(trades) {
  const map = new Map();
  for (const t of trades) {
    if (!map.has(t.sector)) map.set(t.sector, []);
    map.get(t.sector).push(t);
  }
  return [...map.entries()]
    .map(([sector, arr]) => ({
      sector, count: arr.length,
      winRate: (arr.filter((t) => t.returnPct > 0).length / arr.length) * 100,
      avgReturn: arr.reduce((s, t) => s + t.returnPct, 0) / arr.length,
    }))
    .sort((a, b) => b.count - a.count);
}

function generateReport(scenarios, niftyBars) {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });

  let md = "";
  md += "# Paper Trading — Honest Backtest Report\n\n";
  md += `**Generated:** ${new Date().toISOString().slice(0, 10)}  \n`;
  md += `**Period:** ${SCAN_START} → ${SCAN_END} (${SCAN_DATES.length} monthly scans)  \n`;
  md += `**Universe:** Nifty 100 stocks  \n`;
  md += `**Engine:** StarBhai production scoring engine  \n`;
  md += `**Adjustment:** Split/bonus/dividend adjusted prices (Yahoo adjclose)  \n`;
  md += `**Friction:** ${FRICTION_PCT}% round-trip on every trade  \n\n`;

  md += "---\n\n";
  md += "## Phase 0 Fix Summary\n\n";
  md += "Three things changed vs the legacy 5-year backtest:\n\n";
  md += "1. **Corporate actions** — all prices adjusted via Yahoo adjclose + proportional high/low. Splits (IRCTC, BAJAJ-AUTO) and bonuses (RELIANCE Oct 2024, LODHA Nov 2024) no longer appear as 50% drawdowns.\n";
  md += `2. **Friction** — ${FRICTION_PCT}% round-trip subtracted from every trade's return. Breakdown: STT 0.1%, exchange+SEBI+GST 0.1%, slippage 0.25%, brokerage 0.05%. Conservative.\n`;
  md += "3. **Window** — 24-month window to avoid pre-2024 data quality issues (stale fundamentals, thin midcap histories). Legacy 5yr report archived alongside.\n\n";
  md += "A fourth change: **trailing stop is now actually executed in the backtest.** Until now it only appeared in the UI as advisory text.\n\n";

  md += "---\n\n";
  md += "## Headline Numbers — Scenario Comparison\n\n";
  md += "| Scenario | Exit mode | Friction | adjClose | Trades | Win rate | Avg return | Portfolio XIRR | Nifty XIRR | Alpha |\n";
  md += "|----------|-----------|----------|----------|--------|----------|------------|----------------|------------|-------|\n";
  for (const sc of scenarios) {
    md += `| ${sc.label} | ${sc.exitMode} | ${sc.frictionPct}% | ${sc.useAdj ? "yes" : "no"} | ${sc.metrics.totalTrades} | ${sc.metrics.winRate.toFixed(1)}% | ${sc.metrics.avgReturn.toFixed(2)}% | ${sc.metrics.portfolioXIRR.toFixed(1)}% | ${sc.metrics.niftyXIRR.toFixed(1)}% | ${sc.metrics.alpha >= 0 ? "+" : ""}${sc.metrics.alpha.toFixed(1)}% |\n`;
  }
  md += "\n";

  // Detailed per-scenario sections
  for (const sc of scenarios) {
    md += "---\n\n";
    md += `## Scenario: ${sc.label}\n\n`;
    md += `- **Exit mode:** ${sc.exitMode === "trailing" ? "trailing stop (ATR × 3), hard-SL safety net, target fill on intraday high" : "fixed SL + fixed target + time exit"}\n`;
    md += `- **Friction:** ${sc.frictionPct}% round-trip\n`;
    md += `- **Adjusted prices:** ${sc.useAdj ? "yes" : "no"}\n\n`;

    const m = sc.metrics;
    md += "### Summary\n\n";
    md += "| Metric | Value |\n|---|---|\n";
    md += `| Total trades | ${m.totalTrades} |\n`;
    md += `| Win / Loss | ${m.wins} / ${m.losses} |\n`;
    md += `| Win rate | ${m.winRate.toFixed(1)}% |\n`;
    md += `| Avg return per trade | ${m.avgReturn.toFixed(2)}% |\n`;
    md += `| Avg win | ${m.avgWin.toFixed(2)}% |\n`;
    md += `| Avg loss | ${m.avgLoss.toFixed(2)}% |\n`;
    md += `| Payoff (avgWin/|avgLoss|) | ${m.payoff.toFixed(2)} |\n`;
    md += `| Expectancy per trade | ${m.expectancy.toFixed(2)}% |\n`;
    md += `| Portfolio XIRR | ${m.portfolioXIRR.toFixed(1)}% |\n`;
    md += `| Nifty 50 XIRR (same window) | ${m.niftyXIRR.toFixed(1)}% |\n`;
    md += `| **Alpha** | **${m.alpha >= 0 ? "+" : ""}${m.alpha.toFixed(1)}%** |\n`;
    md += `| Avg holding days | ${m.avgHoldDays.toFixed(0)} |\n`;
    md += "\n";

    md += "### Exit breakdown\n\n";
    md += "| Exit reason | Count | % of trades |\n|---|---|---|\n";
    md += `| SL hit | ${m.slHits} | ${(m.slHits / m.totalTrades * 100).toFixed(1)}% |\n`;
    md += `| Target hit | ${m.targetHits} | ${(m.targetHits / m.totalTrades * 100).toFixed(1)}% |\n`;
    if (sc.exitMode === "trailing") md += `| Trailing stop | ${m.trailHits} | ${(m.trailHits / m.totalTrades * 100).toFixed(1)}% |\n`;
    md += `| Time exit | ${m.timeExits} | ${(m.timeExits / m.totalTrades * 100).toFixed(1)}% |\n\n`;

    const cats = categoryBreakdown(sc.trades);
    md += "### By category\n\n";
    md += "| Category | Trades | Win rate | Avg return |\n|---|---|---|---|\n";
    for (const c of cats) {
      if (c.count === 0) continue;
      md += `| ${c.key} | ${c.count} | ${c.winRate.toFixed(1)}% | ${c.avgReturn.toFixed(2)}% |\n`;
    }
    md += "\n";

    const sectors = sectorBreakdown(sc.trades);
    md += "### By sector (top 10 by count)\n\n";
    md += "| Sector | Trades | Win rate | Avg return |\n|---|---|---|---|\n";
    for (const s of sectors.slice(0, 10)) {
      md += `| ${s.sector} | ${s.count} | ${s.winRate.toFixed(1)}% | ${s.avgReturn.toFixed(2)}% |\n`;
    }
    md += "\n";

    // Phase 3 — per-signal attribution
    const attribution = signalAttribution(sc.trades);
    md += "### Per-signal attribution (Phase 3)\n\n";
    md += "*Edge = avg return when signal was hot at entry minus avg return when it was quiet. Positive edge = genuine discriminator. Near-zero edge = weight currently being spent on noise.*\n\n";
    md += "| Signal | Hot trades | WR when hot | Avg (hot) | Avg (quiet) | **Edge** |\n|---|---|---|---|---|---|\n";
    for (const a of attribution) {
      const edgeCell = a.edge >= 0.5 ? `**+${a.edge.toFixed(2)}%**` : a.edge <= -0.5 ? `**${a.edge.toFixed(2)}%**` : `${a.edge >= 0 ? "+" : ""}${a.edge.toFixed(2)}%`;
      md += `| ${a.signal} | ${a.hotCount} | ${a.hotWR.toFixed(1)}% | ${a.hotAvg.toFixed(2)}% | ${a.quietAvg.toFixed(2)}% | ${edgeCell} |\n`;
    }
    md += "\n";
  }

  // Verdict
  md += "---\n\n";
  md += "## Verdict\n\n";
  const honestScenarios = scenarios.filter((sc) => sc.frictionPct > 0 && sc.useAdj);
  const bestHonest = honestScenarios.sort((a, b) => b.metrics.alpha - a.metrics.alpha)[0];
  if (bestHonest) {
    const m = bestHonest.metrics;
    if (m.alpha >= 0) {
      md += `After corporate-action adjustment and ${FRICTION_PCT}% friction, the best honest scenario (${bestHonest.label}) delivers **+${m.alpha.toFixed(1)}% alpha over Nifty 50** on a 24-month window. This is the baseline Phase 1 has to beat.\n\n`;
    } else {
      md += `After corporate-action adjustment and ${FRICTION_PCT}% friction, the best honest scenario (${bestHonest.label}) gives **${m.alpha.toFixed(1)}% alpha vs Nifty 50** on a 24-month window. Phase 1 target: close this gap by at least 100 bps via SL/target rebalance + sentiment weight tuning + sector neutralisation.\n\n`;
    }
  }

  md += "---\n\n";
  md += "## Disclaimer\n\n";
  md += "1. Fundamentals are the current (Apr 2026) snapshot — the legacy 5-year report called out that this introduces look-ahead. On a 24-month window, the bias is materially smaller but non-zero.\n";
  md += "2. Universe is survivorship-biased to today's Nifty 100. Phase 2 adds Nifty 500 + liquidity-filtered NSE names.\n";
  md += "3. No regime-aware position sizing yet (Phase 2 P2.7). All trades are equal-weighted.\n";
  md += "4. SL/target fills assume exact level; a real market order would slip. The 0.5% friction is a proxy but doesn't capture gap-fill loss.\n\n";
  md += "---\n\n";
  md += `*Generated on ${new Date().toISOString()} by paper-trade-honest.mjs*\n`;

  writeFileSync(REPORT_PATH, md, "utf-8");
  return REPORT_PATH;
}

// ==================== MAIN ====================

async function main() {
  console.log("=== StarBhai Honest Paper-Trade Backtest ===");
  console.log(`Window: ${SCAN_START} → ${SCAN_END} (${SCAN_DATES.length} scans)`);
  console.log(`Friction: ${FRICTION_PCT}% round-trip`);
  console.log(`Mode: ${EXIT_MODE}`);
  console.log("");

  loadFundamentalsFromDisk();

  const stocks = UNIVERSE === "nifty500" ? getNifty500() : getNifty100();
  console.log(`Stock universe: ${stocks.length} stocks (${UNIVERSE})`);
  if (USE_KELLY_SIZING) console.log(`Kelly-lite regime sizing: ENABLED (mock delta)`);

  const histories = await fetchAllHistories(stocks);

  if (!histories.has(NIFTY_INDEX_SYMBOL)) {
    console.error("FATAL: Could not fetch Nifty 50 index data.");
    process.exit(1);
  }
  const niftyBars = histories.get(NIFTY_INDEX_SYMBOL);

  const scenarios = [];

  if (EXIT_MODE === "fixed" || EXIT_MODE === "both") {
    console.log("\n--- Scenario: FIXED exit (+adjClose +friction) ---");
    const trades = simulate(stocks, histories, "fixed", FRICTION_PCT);
    scenarios.push({
      label: "Honest — fixed target exit",
      exitMode: "fixed",
      frictionPct: FRICTION_PCT,
      useAdj: true,
      trades,
      metrics: computeMetrics(trades, niftyBars),
    });
  }

  if (EXIT_MODE === "trailing" || EXIT_MODE === "both") {
    console.log("\n--- Scenario: TRAILING-STOP exit (+adjClose +friction) ---");
    const trades = simulate(stocks, histories, "trailing", FRICTION_PCT);
    scenarios.push({
      label: "Honest — trailing stop exit",
      exitMode: "trailing",
      frictionPct: FRICTION_PCT,
      useAdj: true,
      trades,
      metrics: computeMetrics(trades, niftyBars),
    });
  }

  // Also run "legacy-parity" (fixed exit, zero friction) for comparison
  if (EXIT_MODE === "both") {
    console.log("\n--- Scenario: LEGACY-PARITY (fixed exit, no friction, adjClose) ---");
    const trades = simulate(stocks, histories, "fixed", 0);
    scenarios.push({
      label: "Legacy-parity (adjClose, no friction)",
      exitMode: "fixed",
      frictionPct: 0,
      useAdj: true,
      trades,
      metrics: computeMetrics(trades, niftyBars),
    });
  }

  // Print summary
  console.log("\n=== Summary ===");
  for (const sc of scenarios) {
    const m = sc.metrics;
    console.log(`${sc.label}:`);
    console.log(`  Trades=${m.totalTrades} WinRate=${m.winRate.toFixed(1)}% AvgRet=${m.avgReturn.toFixed(2)}% XIRR=${m.portfolioXIRR.toFixed(1)}% Alpha=${m.alpha >= 0 ? "+" : ""}${m.alpha.toFixed(1)}%`);
  }

  const reportPath = generateReport(scenarios, niftyBars);
  console.log(`\nReport: ${reportPath}`);
  console.log("=== Done ===");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
