#!/usr/bin/env node
/**
 * StarBhai · V1 vs V2 Backtest (Phase 3 gate)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Runs the same 3-date scan window as scripts/backtest.mjs but scores each
 * stock with BOTH the production V1 scorer AND the shadow V2 scorer, then
 * tracks two parallel portfolios:
 *
 *   • V1 portfolio — picks chosen by V1's score + verdict
 *   • V2 portfolio — picks chosen by V2's score + verdict
 *
 * Both portfolios use identical universe, identical scan dates, identical
 * entry prices, identical SL/target logic — only the selection signal
 * differs. This isolates the scorer's contribution to trade outcomes.
 *
 * What this answers:
 *   1. Does V2 pick better stocks than V1 over the same window?
 *      (Win rate, avg return, XIRR, alpha vs Nifty 50)
 *   2. How much overlap is there between V1 and V2 selections?
 *      (Are they fighting for the same stocks, or diverging?)
 *   3. Which V1 DEEP_VALUE picks did V2 correctly tag as lower-conviction,
 *      and did those pan out as value traps?
 *
 * Methodology caveat (same as backtest.mjs):
 *   Uses the current Apr 2026 fundamentals snapshot for all 3 scan dates.
 *   This is a look-ahead approximation — ROE/margins are stable QoQ for
 *   most large caps, but forward-looking fields (forwardEps, dividendYield)
 *   are strictly future-information at the earlier scan dates. Both scorers
 *   eat the same approximation, so the comparison remains apples-to-apples.
 *
 * Usage:
 *   node scripts/backtest-v2-compare.mjs
 *
 * Writes: scripts/output/backtest-v2-compare.json (detailed per-trade records)
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import YahooFinance from "yahoo-finance2";
import { analyzeStock, midTermAnalysis } from "../analysis.js";
import {
  scoreFundamentals,
  loadFundamentalsFromDisk,
  getFundamentals,
} from "../fundamentals.js";
import { scoreFundamentalsV2 } from "../fundamentalsV2.js";
import { getNifty100 } from "../stockList.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "output");
const OUT_PATH = path.join(OUT_DIR, "backtest-v2-compare.json");

const yf = new YahooFinance({
  suppressNotices: ["yahooSurvey", "ripHistorical"],
});

// ════════════════════ CONFIG ════════════════════
// Same scan dates and thresholds as scripts/backtest.mjs so results are
// directly comparable with the Phase 1 baseline.

const SCAN_DATES = [
  { label: "Nov 2025", date: "2025-11-03", historyStart: "2025-05-01", longExit: "2026-04-15" },
  { label: "Dec 2025", date: "2025-12-01", historyStart: "2025-06-01", longExit: "2026-04-15" },
  { label: "Jan 2026", date: "2026-01-02", historyStart: "2025-07-01", longExit: "2026-04-15" },
];

const SCANNER_TECH_WEIGHT = 0.40;
const SCANNER_FUND_WEIGHT = 0.60;
const SCANNER_MIN_SCORE = 60;
const MAX_PICKS_PER_SCAN = 10;
const CONCURRENCY = 6;

// V1 keeps its existing thresholds. V2 has its own verdict bands already
// defined in fundamentalsV2.js (75/65/50/38 vs V1's 72/62/48/40). For the
// fair comparison we select on verdict label equivalence — both scorers'
// {DEEP_VALUE, QUALITY_GROWTH} buckets are the "buy" buckets.
const BUY_VERDICTS = new Set(["DEEP_VALUE", "QUALITY_GROWTH"]);
// Category-3 "Fundamental" picks also require a minimum raw score — V1
// backtest uses 58 for QUALITY_GROWTH / 72 for DEEP_VALUE. We apply the
// same floors to both scorers so V2 isn't helped or hurt by the threshold
// choice itself — the question is verdict accuracy at equivalent cutoffs.
const FUND_MIN_SCORE = 58;

// ════════════════════ DATA FETCHING ════════════════════

async function fetchHistorical(symbol, startDate, endDate) {
  try {
    const result = await yf.chart(symbol, {
      period1: startDate,
      period2: endDate,
      interval: "1d",
    });
    if (!result?.quotes?.length) return null;
    return result.quotes
      .filter((q) => q.close != null && q.volume != null)
      .map((q) => ({
        date: new Date(q.date),
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume,
      }));
  } catch {
    return null;
  }
}

// ════════════════════ SCANNING ════════════════════

function buildMockQuote(historical, symbol) {
  const last = historical[historical.length - 1];
  const highs = historical.map((d) => d.high);
  const lows = historical.map((d) => d.low);
  return {
    symbol,
    regularMarketPrice: last.close,
    regularMarketDayHigh: last.high,
    regularMarketDayLow: last.low,
    regularMarketVolume: last.volume,
    regularMarketOpen: last.open,
    regularMarketPreviousClose: historical.length >= 2 ? historical[historical.length - 2].close : last.close,
    regularMarketChange: historical.length >= 2 ? last.close - historical[historical.length - 2].close : 0,
    regularMarketChangePercent: historical.length >= 2
      ? ((last.close - historical[historical.length - 2].close) / historical[historical.length - 2].close) * 100
      : 0,
    fiftyTwoWeekHigh: Math.max(...highs.slice(-252)),
    fiftyTwoWeekLow: Math.min(...lows.slice(-252)),
  };
}

/**
 * Score one stock at one scan date with BOTH V1 and V2.
 * Returns null if the tech analysis fails (scorers get skipped by convention).
 */
function runScanBoth(historical, symbol, fundSnap) {
  if (!historical || historical.length < 50) return null;

  const quote = buildMockQuote(historical, symbol);
  const analysis = analyzeStock(historical, quote);
  if (!analysis || analysis.score == null) return null;

  const techScore = analysis.score;
  const midTerm = midTermAnalysis(analysis, quote);

  let dma200 = null;
  if (historical.length >= 200) {
    const closes = historical.map((d) => d.close);
    dma200 = closes.slice(-200).reduce((s, v) => s + v, 0) / 200;
  }

  // ── V1 scorer ──
  let v1 = null;
  if (fundSnap) {
    try {
      v1 = scoreFundamentals(fundSnap, dma200);
    } catch (err) {
      // V1 must never throw — if it does that's a real regression
      console.warn(`[V1] ${symbol}: ${err.message}`);
    }
  }

  // ── V2 scorer (shadow) ──
  let v2 = null;
  if (fundSnap) {
    try {
      v2 = scoreFundamentalsV2(fundSnap);
    } catch (err) {
      console.warn(`[V2] ${symbol}: ${err.message}`);
    }
  }

  const price = quote.regularMarketPrice;

  // Shared SL/target derivation — uses whichever fund snapshot is richer.
  // Both scorers share the same snapshot data so this is identical for both.
  // We keep it on the outside (not per-scorer) so the trade mechanics are
  // controlled and only the selection signal is the experimental variable.
  const snap = v1?.snapshot || v2?.snapshot || fundSnap || {};
  const pe = snap.pe;
  const sectorPe = snap.sectorPe;
  const revGrowth = v1?.breakdown?.revenueGrowthValue;
  const w52High = quote.fiftyTwoWeekHigh;
  const w52Low = quote.fiftyTwoWeekLow;

  let longTermSL = parseFloat((price * 0.80).toFixed(2));
  if (dma200 && dma200 < price) longTermSL = Math.max(longTermSL, parseFloat(dma200.toFixed(2)));
  if (w52Low && w52Low < price) longTermSL = Math.max(longTermSL, parseFloat(w52Low.toFixed(2)));
  if (longTermSL >= price) longTermSL = parseFloat((price * 0.80).toFixed(2));

  let longTermTarget;
  if (pe && sectorPe && pe > 0 && sectorPe > 0 && pe < sectorPe && (sectorPe / pe) >= 1.10) {
    longTermTarget = parseFloat((price * Math.min(sectorPe / pe, 1.40)).toFixed(2));
  } else if (w52High && w52High > price) {
    const growthImplied = revGrowth != null ? price * (1 + revGrowth) : 0;
    longTermTarget = parseFloat(Math.max(w52High, growthImplied).toFixed(2));
  } else if (revGrowth != null && revGrowth > 0) {
    longTermTarget = parseFloat((price * (1 + revGrowth)).toFixed(2));
  } else {
    longTermTarget = parseFloat((price * 1.15).toFixed(2));
  }

  // Combined scanner score per scorer (40 tech + 60 fund) for Category-1 gating
  const scannerScoreV1 =
    v1?.score != null ? Math.round(techScore * SCANNER_TECH_WEIGHT + v1.score * SCANNER_FUND_WEIGHT) : null;
  const scannerScoreV2 =
    v2?.score != null ? Math.round(techScore * SCANNER_TECH_WEIGHT + v2.score * SCANNER_FUND_WEIGHT) : null;

  return {
    symbol,
    entryPrice: price,
    techScore,
    v1: v1
      ? { score: v1.score, verdict: v1.verdict, scannerScore: scannerScoreV1 }
      : null,
    v2: v2
      ? {
          score: v2.score,
          verdict: v2.verdict,
          scannerScore: scannerScoreV2,
          sectorKind: v2.sectorKind,
          naPillars: v2.composition?.naPillars || [],
        }
      : null,
    midTermScore: midTerm.score,
    midTermRec: midTerm.recommendation,
    longTermTarget,
    longTermSL,
  };
}

// ════════════════════ TRADE TRACKING ════════════════════

function trackTrade(forwardData, entryPrice, target, stopLoss, maxExitDate) {
  for (const bar of forwardData) {
    if (bar.date > maxExitDate) break;
    if (stopLoss != null && bar.low <= stopLoss) {
      return { exitPrice: stopLoss, exitDate: bar.date, reason: "SL" };
    }
    if (target != null && bar.high >= target) {
      return { exitPrice: target, exitDate: bar.date, reason: "TARGET" };
    }
  }
  const bars = forwardData.filter((d) => d.date <= maxExitDate);
  if (bars.length > 0) {
    const exit = bars[bars.length - 1];
    return { exitPrice: exit.close, exitDate: exit.date, reason: "EXPIRY" };
  }
  return { exitPrice: entryPrice, exitDate: maxExitDate, reason: "NO_DATA" };
}

// ════════════════════ XIRR ════════════════════

function xirr(cashflows) {
  if (cashflows.length < 2) return 0;
  const dayMs = 86400000;
  const d0 = cashflows[0].date;
  const npv = (rate) =>
    cashflows.reduce((sum, cf) => {
      const years = (cf.date - d0) / (365.25 * dayMs);
      return sum + cf.amount / Math.pow(1 + rate, years);
    }, 0);
  const dnpv = (rate) =>
    cashflows.reduce((sum, cf) => {
      const years = (cf.date - d0) / (365.25 * dayMs);
      if (years === 0) return sum;
      return sum - (years * cf.amount) / Math.pow(1 + rate, years + 1);
    }, 0);

  let rate = 0.10;
  for (let i = 0; i < 200; i++) {
    const f = npv(rate);
    const df = dnpv(rate);
    if (Math.abs(df) < 1e-12) break;
    const next = rate - f / df;
    if (Math.abs(next - rate) < 1e-8) break;
    rate = next;
    if (rate < -0.99) rate = -0.99;
  }
  return rate;
}

// ════════════════════ PICK FILTERS ════════════════════
// Applied per-scorer with identical logic. Each scorer produces its own
// pick set; SL/target/entry are identical across scorers by construction.

function isBuyNowPick(result, scorer /* "v1" | "v2" */) {
  const s = result[scorer];
  if (!s || s.scannerScore == null) return false;
  if (s.scannerScore < SCANNER_MIN_SCORE) return false;
  if (!BUY_VERDICTS.has(s.verdict)) return false;
  if (result.midTermRec === "HOLD") return false;
  return true;
}

function isFundamentalPick(result, scorer) {
  const s = result[scorer];
  if (!s || s.score == null) return false;
  if (!BUY_VERDICTS.has(s.verdict)) return false;
  if (s.score < FUND_MIN_SCORE) return false;
  return true;
}

// ════════════════════ AGGREGATION ════════════════════

function portfolioMetrics(trades, investPerTrade = 10000) {
  if (trades.length === 0) {
    return {
      n: 0, winRate: null, avgReturn: null, medianReturn: null,
      xirr: null, targetHits: 0, slHits: 0, expiries: 0,
      best: null, worst: null,
    };
  }
  const wins = trades.filter((t) => t.returnPct > 0);
  const sorted = trades.slice().sort((a, b) => a.returnPct - b.returnPct);
  const avgReturn = trades.reduce((s, t) => s + t.returnPct, 0) / trades.length;
  const medianReturn = sorted[Math.floor(sorted.length / 2)].returnPct;
  const best = sorted[sorted.length - 1];
  const worst = sorted[0];

  // Build cashflows in date order
  const cf = [];
  for (const t of trades) {
    cf.push({ date: t.entryDate, amount: -investPerTrade });
    cf.push({ date: t.exitDate, amount: investPerTrade * (1 + t.returnPct / 100) });
  }
  cf.sort((a, b) => a.date - b.date);
  let portXirr = null;
  try { portXirr = xirr(cf); } catch { portXirr = null; }

  return {
    n: trades.length,
    winRate: wins.length / trades.length,
    avgReturn,
    medianReturn,
    xirr: portXirr,
    targetHits: trades.filter((t) => t.reason === "TARGET").length,
    slHits: trades.filter((t) => t.reason === "SL").length,
    expiries: trades.filter((t) => t.reason === "EXPIRY").length,
    best: { symbol: best.symbol, scanDate: best.scanDate, returnPct: best.returnPct },
    worst: { symbol: worst.symbol, scanDate: worst.scanDate, returnPct: worst.returnPct },
  };
}

function fmtPct(v, digits = 1) {
  if (v == null) return "  N/A";
  return (v >= 0 ? "+" : "") + v.toFixed(digits) + "%";
}

// ════════════════════ MAIN ════════════════════

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   StarBhai · V1 vs V2 Backtest (Phase 3 gate)                ║");
  console.log("║   Same universe, same dates, two scorers, two portfolios     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  loadFundamentalsFromDisk();
  const stocks = getNifty100();
  console.log(`Universe: ${stocks.length} Nifty 100 stocks\n`);

  // ── Phase 1: Fetch historical prices ──
  console.log("Phase 1: Fetching historical data (May 2025 – Apr 2026)...");
  const allHistory = new Map();
  let fetched = 0, failed = 0;
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= stocks.length) return;
      const sym = stocks[i].symbol;
      const data = await fetchHistorical(sym, "2025-05-01", "2026-04-16");
      if (data && data.length >= 50) {
        allHistory.set(sym, data);
        fetched++;
      } else {
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`  Fetched: ${fetched}/${stocks.length}, Failed: ${failed}\n`);

  // ── Nifty 50 benchmark ──
  console.log("Phase 2: Fetching Nifty 50 benchmark...");
  const niftyHistory = await fetchHistorical("^NSEI", "2025-10-01", "2026-04-16");
  if (!niftyHistory) {
    console.error("  FATAL: Could not fetch Nifty 50 index data");
    process.exit(1);
  }
  console.log(`  Nifty 50: ${niftyHistory.length} bars\n`);

  // ── Phase 3: Scan each date with BOTH scorers ──
  // Bucket trades into 4 portfolios:
  //   v1.buyNow, v1.fundamental, v2.buyNow, v2.fundamental
  const buckets = {
    v1: { buyNow: [], fundamental: [] },
    v2: { buyNow: [], fundamental: [] },
  };
  const overlapStats = {
    v1Only: 0, v2Only: 0, both: 0, neither: 0, // union across BuyNow ∪ Fundamental per scan
  };

  for (const scan of SCAN_DATES) {
    console.log(`\n${"═".repeat(62)}`);
    console.log(`SCAN: ${scan.label} (${scan.date})`);
    console.log("═".repeat(62));

    const scanDate = new Date(scan.date + "T00:00:00");
    const longExitDate = new Date(scan.longExit + "T23:59:59");

    const scoredAll = [];

    for (const stock of stocks) {
      const sym = stock.symbol;
      const fullHistory = allHistory.get(sym);
      if (!fullHistory) continue;

      const historyUpToScan = fullHistory.filter((d) => d.date <= scanDate);
      if (historyUpToScan.length < 50) continue;
      const forwardData = fullHistory.filter((d) => d.date > scanDate);

      const fundSnap = getFundamentals(sym);
      const result = runScanBoth(historyUpToScan, sym, fundSnap);
      if (!result) continue;
      scoredAll.push({ ...result, forwardData });
    }

    // ── Category 1 (BuyNow) ──
    const v1BuyNow = scoredAll.filter((r) => isBuyNowPick(r, "v1"))
      .sort((a, b) => b.v1.scannerScore - a.v1.scannerScore)
      .slice(0, MAX_PICKS_PER_SCAN);
    const v2BuyNow = scoredAll.filter((r) => isBuyNowPick(r, "v2"))
      .sort((a, b) => b.v2.scannerScore - a.v2.scannerScore)
      .slice(0, MAX_PICKS_PER_SCAN);

    // ── Category 3 (Fundamental) ──
    const v1Fund = scoredAll.filter((r) => isFundamentalPick(r, "v1"))
      .sort((a, b) => b.v1.score - a.v1.score)
      .slice(0, MAX_PICKS_PER_SCAN);
    const v2Fund = scoredAll.filter((r) => isFundamentalPick(r, "v2"))
      .sort((a, b) => b.v2.score - a.v2.score)
      .slice(0, MAX_PICKS_PER_SCAN);

    // ── Overlap: union of picks per scorer (BuyNow ∪ Fundamental) ──
    const v1PickSet = new Set([...v1BuyNow, ...v1Fund].map((r) => r.symbol));
    const v2PickSet = new Set([...v2BuyNow, ...v2Fund].map((r) => r.symbol));
    for (const r of scoredAll) {
      const inV1 = v1PickSet.has(r.symbol);
      const inV2 = v2PickSet.has(r.symbol);
      if (inV1 && inV2) overlapStats.both++;
      else if (inV1) overlapStats.v1Only++;
      else if (inV2) overlapStats.v2Only++;
    }

    // ── Track trades ──
    const recordTrade = (pick, category, scorer) => {
      const exit = trackTrade(
        pick.forwardData,
        pick.entryPrice,
        pick.longTermTarget,
        pick.longTermSL,
        longExitDate,
      );
      const record = {
        scanDate: scan.label,
        category,
        scorer,
        symbol: pick.symbol,
        entryDate: scanDate,
        entryPrice: pick.entryPrice,
        score: pick[scorer].score,
        scannerScore: pick[scorer].scannerScore,
        verdict: pick[scorer].verdict,
        sectorKind: pick.v2?.sectorKind || null,
        ...exit,
        returnPct: ((exit.exitPrice - pick.entryPrice) / pick.entryPrice) * 100,
      };
      buckets[scorer][category === "BuyNow" ? "buyNow" : "fundamental"].push(record);
      return record;
    };

    for (const p of v1BuyNow) recordTrade(p, "BuyNow", "v1");
    for (const p of v2BuyNow) recordTrade(p, "BuyNow", "v2");
    for (const p of v1Fund) recordTrade(p, "Fundamental", "v1");
    for (const p of v2Fund) recordTrade(p, "Fundamental", "v2");

    console.log(`  V1 BuyNow picks: ${v1BuyNow.length}  |  V2 BuyNow picks: ${v2BuyNow.length}`);
    console.log(`  V1 Fund picks:   ${v1Fund.length}  |  V2 Fund picks:   ${v2Fund.length}`);
    const sharedBuyNow = v1BuyNow.filter((p) => v2BuyNow.some((q) => q.symbol === p.symbol)).length;
    const sharedFund = v1Fund.filter((p) => v2Fund.some((q) => q.symbol === p.symbol)).length;
    console.log(`  Shared (BuyNow): ${sharedBuyNow}/${Math.max(v1BuyNow.length, v2BuyNow.length)}`);
    console.log(`  Shared (Fund):   ${sharedFund}/${Math.max(v1Fund.length, v2Fund.length)}`);
  }

  // ── Phase 4: Metrics per portfolio ──
  const metrics = {
    v1: {
      buyNow: portfolioMetrics(buckets.v1.buyNow),
      fundamental: portfolioMetrics(buckets.v1.fundamental),
      combined: portfolioMetrics([...buckets.v1.buyNow, ...buckets.v1.fundamental]),
    },
    v2: {
      buyNow: portfolioMetrics(buckets.v2.buyNow),
      fundamental: portfolioMetrics(buckets.v2.fundamental),
      combined: portfolioMetrics([...buckets.v2.buyNow, ...buckets.v2.fundamental]),
    },
  };

  // ── Nifty 50 benchmark XIRR ──
  const niftyScanDates = SCAN_DATES.map((s) => new Date(s.date + "T00:00:00"));
  const niftyEntries = niftyScanDates
    .map((d) => niftyHistory.find((b) => b.date >= d))
    .filter(Boolean);
  const niftyExitBar = niftyHistory[niftyHistory.length - 1];
  const niftyCashflows = [];
  for (const bar of niftyEntries) {
    niftyCashflows.push({ date: bar.date, amount: -10000 });
    niftyCashflows.push({
      date: niftyExitBar.date,
      amount: 10000 * (niftyExitBar.close / bar.close),
    });
  }
  niftyCashflows.sort((a, b) => a.date - b.date);
  const niftyXIRR = xirr(niftyCashflows);
  const niftyReturn =
    niftyEntries.length > 0
      ? niftyEntries.reduce(
          (s, b) => s + (niftyExitBar.close - b.close) / b.close,
          0,
        ) / niftyEntries.length * 100
      : 0;

  // ── Phase 5: Print head-to-head ──
  console.log(`\n\n${"═".repeat(62)}`);
  console.log("RESULTS — V1 vs V2 HEAD-TO-HEAD");
  console.log("═".repeat(62));

  function printCategory(title, v1m, v2m) {
    console.log(`\n  ${title}`);
    console.log(`    ${"metric".padEnd(18)}  ${"V1".padEnd(12)}  ${"V2".padEnd(12)}  Δ`);
    console.log(`    ${"─".repeat(50)}`);
    const rows = [
      ["trades (n)", v1m.n, v2m.n],
      ["win rate", v1m.winRate != null ? (v1m.winRate * 100).toFixed(0) + "%" : "N/A",
        v2m.winRate != null ? (v2m.winRate * 100).toFixed(0) + "%" : "N/A"],
      ["avg return", fmtPct(v1m.avgReturn), fmtPct(v2m.avgReturn)],
      ["median return", fmtPct(v1m.medianReturn), fmtPct(v2m.medianReturn)],
      ["XIRR", v1m.xirr != null ? (v1m.xirr * 100).toFixed(1) + "%" : "N/A",
        v2m.xirr != null ? (v2m.xirr * 100).toFixed(1) + "%" : "N/A"],
      ["target hits", v1m.targetHits, v2m.targetHits],
      ["SL hits", v1m.slHits, v2m.slHits],
    ];
    for (const [label, a, b] of rows) {
      const aStr = String(a).padEnd(12);
      const bStr = String(b).padEnd(12);
      // Δ only makes sense for numeric rows where both are numbers
      let delta = "";
      if (typeof a === "number" && typeof b === "number") {
        const d = b - a;
        delta = (d > 0 ? "+" : "") + d;
      } else if (label === "avg return" || label === "median return") {
        const av = v1m[label === "avg return" ? "avgReturn" : "medianReturn"];
        const bv = v2m[label === "avg return" ? "avgReturn" : "medianReturn"];
        if (av != null && bv != null) {
          const d = bv - av;
          delta = (d > 0 ? "+" : "") + d.toFixed(1) + "pp";
        }
      } else if (label === "XIRR") {
        if (v1m.xirr != null && v2m.xirr != null) {
          const d = (v2m.xirr - v1m.xirr) * 100;
          delta = (d > 0 ? "+" : "") + d.toFixed(1) + "pp";
        }
      } else if (label === "win rate") {
        if (v1m.winRate != null && v2m.winRate != null) {
          const d = (v2m.winRate - v1m.winRate) * 100;
          delta = (d > 0 ? "+" : "") + d.toFixed(0) + "pp";
        }
      }
      console.log(`    ${label.padEnd(18)}  ${aStr}  ${bStr}  ${delta}`);
    }
    console.log(`    best:  V1 ${v1m.best ? v1m.best.symbol + " " + fmtPct(v1m.best.returnPct) : "N/A"}  |  V2 ${v2m.best ? v2m.best.symbol + " " + fmtPct(v2m.best.returnPct) : "N/A"}`);
    console.log(`    worst: V1 ${v1m.worst ? v1m.worst.symbol + " " + fmtPct(v1m.worst.returnPct) : "N/A"}  |  V2 ${v2m.worst ? v2m.worst.symbol + " " + fmtPct(v2m.worst.returnPct) : "N/A"}`);
  }

  printCategory("BUY-NOW CATEGORY (scanner ≥ 60, verdict ∈ {DV,QG})", metrics.v1.buyNow, metrics.v2.buyNow);
  printCategory("FUNDAMENTAL CATEGORY (score ≥ 58, verdict ∈ {DV,QG})", metrics.v1.fundamental, metrics.v2.fundamental);
  printCategory("COMBINED (BuyNow ∪ Fundamental)", metrics.v1.combined, metrics.v2.combined);

  console.log(`\n  Nifty 50 benchmark`);
  console.log(`    Avg return:  ${fmtPct(niftyReturn)}`);
  console.log(`    XIRR:        ${(niftyXIRR * 100).toFixed(1)}%`);

  // ── Overlap summary ──
  console.log(`\n  Selection overlap (across all 3 scans, union of categories):`);
  console.log(`    Picked by both V1 and V2: ${overlapStats.both}`);
  console.log(`    Picked by V1 only:        ${overlapStats.v1Only}`);
  console.log(`    Picked by V2 only:        ${overlapStats.v2Only}`);

  // ── Phase 6: Value-trap diagnostic ──
  // For stocks V1 tagged DEEP_VALUE but V2 didn't, check how V1's picks
  // actually performed. If they underperformed V2's replacements, that's
  // evidence V2 is catching value traps V1 is falling into.
  console.log(`\n  Value-trap analysis (V1 DEEP_VALUE picks NOT in V2 picks):`);
  const v1DV = [...buckets.v1.buyNow, ...buckets.v1.fundamental].filter(
    (t) => t.verdict === "DEEP_VALUE",
  );
  const v2Symbols = new Set(
    [...buckets.v2.buyNow, ...buckets.v2.fundamental].map((t) => t.symbol + "|" + t.scanDate),
  );
  const v1OnlyDV = v1DV.filter((t) => !v2Symbols.has(t.symbol + "|" + t.scanDate));
  if (v1OnlyDV.length > 0) {
    const avgV1OnlyDV = v1OnlyDV.reduce((s, t) => s + t.returnPct, 0) / v1OnlyDV.length;
    const winsV1OnlyDV = v1OnlyDV.filter((t) => t.returnPct > 0).length;
    console.log(`    V1 DEEP_VALUE trades V2 rejected: ${v1OnlyDV.length}`);
    console.log(`    → avg return:  ${fmtPct(avgV1OnlyDV)}`);
    console.log(`    → win rate:    ${winsV1OnlyDV}/${v1OnlyDV.length} = ${((winsV1OnlyDV / v1OnlyDV.length) * 100).toFixed(0)}%`);
    console.log(`    (if avg < combined V1 avg, V2's rejection was correct)`);
    // Top 5 worst V1-only DV picks
    const worstV1OnlyDV = v1OnlyDV.slice().sort((a, b) => a.returnPct - b.returnPct).slice(0, 5);
    console.log(`    Worst V1-only DV picks:`);
    for (const t of worstV1OnlyDV) {
      console.log(`      ${t.symbol.padEnd(18)} ${t.scanDate.padEnd(10)} V1=${t.score}  ${fmtPct(t.returnPct)} [${t.reason}]`);
    }
  } else {
    console.log(`    (no V1 DEEP_VALUE picks were rejected by V2)`);
  }

  // ── Persist detailed records ──
  const out = {
    generatedAt: new Date().toISOString(),
    scanDates: SCAN_DATES,
    universeSize: stocks.length,
    fetchedPriceHistory: fetched,
    buckets,
    metrics,
    nifty: { xirr: niftyXIRR, avgReturn: niftyReturn },
    overlap: overlapStats,
    v1OnlyDV,
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\n  Wrote detailed records to ${OUT_PATH}\n`);

  // ── Phase 7: Gate verdict ──
  console.log(`${"═".repeat(62)}`);
  console.log("PHASE 3 GATE VERDICT");
  console.log("═".repeat(62));
  const combinedDelta =
    metrics.v2.combined.xirr != null && metrics.v1.combined.xirr != null
      ? (metrics.v2.combined.xirr - metrics.v1.combined.xirr) * 100
      : null;
  if (combinedDelta == null) {
    console.log(`  INCONCLUSIVE — one or both portfolios had no trades.`);
  } else if (combinedDelta >= 2.0) {
    console.log(`  ✓ V2 BEATS V1 by ${combinedDelta.toFixed(1)}pp XIRR. Proceed to Phase 4 (prod gate).`);
  } else if (combinedDelta <= -2.0) {
    console.log(`  ✗ V2 UNDERPERFORMS V1 by ${Math.abs(combinedDelta).toFixed(1)}pp XIRR. Iterate on V2 before gating.`);
  } else {
    console.log(`  ≈ V1 and V2 within ±2pp XIRR (Δ=${combinedDelta.toFixed(1)}pp). Too close to call — extend the backtest window or tighten V2's verdict bands.`);
  }
  console.log();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
