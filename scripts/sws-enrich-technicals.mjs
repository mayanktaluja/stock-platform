#!/usr/bin/env node
// Nightly technicals sidecar builder — Two-Key Entry PR-4.
//
// Role in the nightly: runs inside scripts/sws-refresh-api.sh between the
// deep-brief parse and seed scoring, behind an 18h freshness gate. It fetches
// Yahoo v8 daily bars (range=1y, interval=1d — the same URL/header/mapping
// pattern as server.js fetchHistorical) for the served pick universe, computes
// entry-timing technicals (Wilder RSI-14, 20/50/200-DMA + 5-bar reclaim flags,
// ATR-14, RS vs ^NSEI over ~3M/63 bars), and writes a SIDECAR ONLY:
//
//   data/technicals/indicators-latest.json
//
// The sidecar feeds services/entry/technicalStoreReader.js → stampEntryTiming
// (row.technicals?.atr14 is the Tier-2 invalidation basis; wired next PR).
//
// Why the rewrite (localhost removal): the previous version of this script
// fetched http://localhost:3005/api/stock/:symbol — a live-server dependency.
// NO server runs during the nightly, so that path could never execute there,
// and it wrote enrichment INTO data/sws/picks-latest.json in place (racing the
// scoring steps that own that file). This version talks to Yahoo directly and
// never touches picks-latest.json — it only READS it for section membership.
// Membership therefore lags one night (the previous night's picks) — accepted.
//
// Budget idioms mirror scripts/refresh-fundamentals-history.mjs:
//   - --max-fetches (default 600) caps Yahoo calls; overflow defers to the
//     next run (NEW-before-STALE ordering converges coverage across nights).
//   - NEW tickers (no sidecar entry) are fetched before STALE ones (oldest
//     per-ticker as_of first), so a 429-aborted run resumes where it left off.
//   - Per-ticker 24h failure backoff persisted in the sidecar's failures map.
//   - HTTP 429 aborts the run cleanly with a partial atomic write.
//
// Usage:
//   node scripts/sws-enrich-technicals.mjs                   # nightly default
//   node scripts/sws-enrich-technicals.mjs --max-fetches 3   # tiny smoke
//   node scripts/sws-enrich-technicals.mjs --dry-run         # plan only, no fetch
//   node scripts/sws-enrich-technicals.mjs --concurrency 2 --delay-ms 300
//
// ALWAYS exits 0 (including the clean 429 abort) — the nightly step is
// non-fatal by design; a missed night just means one-day-staler technicals.

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./sws-config.mjs";
import { TechnicalAnalysis } from "../analysis.js";
import { computeATR } from "../services/multibagger/atrCalculator.js";
import { getAllStocks } from "../stockList.js";

const SIDECAR_PATH = path.join(PATHS.repoRoot, "data", "technicals", "indicators-latest.json");
const SOURCE_TAG = "yahoo-v8-1y-1d";
const BENCHMARK_SYMBOL = "^NSEI";
const RET_3M_BARS = 63; // ~3 months of trading days
const RECLAIM_LOOKBACK_BARS = 5;
const FAILURE_BACKOFF_HOURS = 24;

// Same Yahoo constants as server.js (copied, not imported — importing
// server.js would boot the express app).
const YF_BASE = "https://query1.finance.yahoo.com";
const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
};

/* ──────────────────────────── args ──────────────────────────────── */

function parseArgs(argv) {
  const out = { maxFetches: 600, concurrency: 4, delayMs: 150, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--max-fetches") out.maxFetches = Number(argv[++i]);
    else if (a.startsWith("--max-fetches=")) out.maxFetches = Number(a.split("=")[1]);
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a.startsWith("--concurrency=")) out.concurrency = Number(a.split("=")[1]);
    else if (a === "--delay-ms") out.delayMs = Number(argv[++i]);
    else if (a.startsWith("--delay-ms=")) out.delayMs = Number(a.split("=")[1]);
  }
  if (!Number.isFinite(out.maxFetches) || out.maxFetches <= 0) out.maxFetches = 600;
  if (!Number.isFinite(out.concurrency) || out.concurrency <= 0) out.concurrency = 4;
  if (!Number.isFinite(out.delayMs) || out.delayMs < 0) out.delayMs = 150;
  return out;
}

/* ─────────────────────── Yahoo fetch helpers ────────────────────── */

// fetch wrapped in an AbortController timeout — same shape as server.js.
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error(`Timeout after ${timeoutMs}ms`);
      e.code = "TIMEOUT";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Mirrors server.js fetchWithRetry semantics (retry on network/5xx/429/timeout
// with exponential backoff, never on 404/other-4xx) — but returns the FINAL
// Response instead of null on exhaustion, so the caller can tell a terminal
// 429 (abort the whole run) from a per-ticker soft failure (24h backoff).
async function fetchWithRetry(url, options = {}, cfg = {}) {
  const { retries = 2, timeoutMs = 8000, backoffMs = 400 } = cfg;
  let attempt = 0;
  let lastRes = null;
  let lastErr = null;
  while (attempt <= retries) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      lastRes = res;
      if (res.status === 404 || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        return res;
      }
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
      lastErr.code = "HTTP_" + res.status;
    } catch (err) {
      lastErr = err;
    }
    attempt++;
    if (attempt <= retries) {
      await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt - 1)));
    }
  }
  if (lastRes) return lastRes;
  throw lastErr || new Error("fetch failed");
}

// One Yahoo v8 chart call → sorted daily OHLC bars (same mapping/filter as
// server.js fetchHistorical). Throws coded errors: RATE_LIMIT / HTTP_x / EMPTY.
async function fetchDailyBars(symbol) {
  const url = `${YF_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const res = await fetchWithRetry(url, { headers: YF_HEADERS }, { retries: 2, timeoutMs: 8000 });
  if (res.status === 429) {
    const e = new Error("HTTP 429");
    e.code = "RATE_LIMIT";
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.code = "HTTP_" + res.status;
    throw e;
  }
  const data = await res.json();
  const r = data.chart?.result?.[0];
  if (!r) {
    const e = new Error("empty chart result");
    e.code = "EMPTY";
    throw e;
  }
  const timestamps = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const bars = timestamps
    .map((ts, i) => ({
      date: new Date(ts * 1000),
      open: q.open?.[i],
      high: q.high?.[i],
      low: q.low?.[i],
      close: q.close?.[i],
      volume: q.volume?.[i] || 0,
    }))
    .filter((d) => d.close != null && d.high != null && d.low != null && d.open != null);
  if (bars.length === 0) {
    const e = new Error("no usable bars");
    e.code = "EMPTY";
    throw e;
  }
  return bars;
}

/* ─────────────────────── indicator computes ─────────────────────── */

function round2(v) {
  return Number.isFinite(v) ? Number(v.toFixed(2)) : null;
}

// Rolling SMA series aligned to closes (null until `period` bars exist).
function smaSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// True when the close crossed from at-or-below the DMA to above it on one of
// the last RECLAIM_LOOKBACK_BARS bars.
function reclaimedWithinLookback(closes, sma, lookback = RECLAIM_LOOKBACK_BARS) {
  const len = closes.length;
  for (let i = Math.max(1, len - lookback); i < len; i++) {
    if (sma[i] == null || sma[i - 1] == null) continue;
    if (closes[i - 1] <= sma[i - 1] && closes[i] > sma[i]) return true;
  }
  return false;
}

// ~3M return in % (last close vs RET_3M_BARS bars ago). Null when history is short.
function ret3mPct(closes) {
  const len = closes.length;
  if (len < RET_3M_BARS + 1) return null;
  const base = closes[len - 1 - RET_3M_BARS];
  if (!Number.isFinite(base) || base <= 0) return null;
  return ((closes[len - 1] / base) - 1) * 100;
}

function computeIndicators(bars, benchmarkRet3m) {
  const closes = bars.map((b) => b.close);
  const sma20 = smaSeries(closes, 20);
  const sma50 = smaSeries(closes, 50);
  const sma200 = smaSeries(closes, 200);
  const stockRet3m = ret3mPct(closes);
  const rs =
    Number.isFinite(stockRet3m) && Number.isFinite(benchmarkRet3m)
      ? stockRet3m - benchmarkRet3m
      : null;
  return {
    rsi14: round2(TechnicalAnalysis.RSI(closes, 14)),
    dma20: round2(sma20[sma20.length - 1]),
    dma50: round2(sma50[sma50.length - 1]),
    dma200: round2(sma200[sma200.length - 1]),
    reclaimed_20d: reclaimedWithinLookback(closes, sma20),
    reclaimed_50d: reclaimedWithinLookback(closes, sma50),
    reclaimed_200d: reclaimedWithinLookback(closes, sma200),
    atr14: computeATR(bars, 14),
    close: round2(closes[closes.length - 1]),
    rs_vs_nifty_pct: round2(rs),
    bars: bars.length,
    as_of: new Date().toISOString(),
  };
}

/* ─────────────────────────── universe ───────────────────────────── */

// Same normalization as services/portfolio/portfolioDividendService.js.
function normalizeTicker(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  return s.replace(/\.(NS|BO|BSE)$/i, "");
}

// Union of every section array's tickers in the served picks file, plus the
// curated stockList (both normalized). Order matters: picks sections first
// (the hottest, user-visible set), curated list after — the budget cap trims
// from the tail.
function buildUniverse() {
  const seen = new Set();
  const order = [];
  const add = (raw) => {
    const t = normalizeTicker(raw);
    if (t && !seen.has(t)) {
      seen.add(t);
      order.push(t);
    }
  };

  if (fs.existsSync(PATHS.picksLatest)) {
    try {
      const picks = JSON.parse(fs.readFileSync(PATHS.picksLatest, "utf-8"));
      for (const items of Object.values(picks.sections || {})) {
        if (!Array.isArray(items)) continue;
        for (const card of items) add(card?.ticker);
      }
    } catch (err) {
      console.warn(`[enrich-technicals] could not parse ${PATHS.picksLatest}: ${err.message}`);
    }
  } else {
    console.warn(`[enrich-technicals] no picks file at ${PATHS.picksLatest} — curated stockList only`);
  }

  for (const s of getAllStocks()) add(s?.symbol);

  return order;
}

/* ──────────────────── plan (budget + ordering) ──────────────────── */

function inFailureBackoff(failure, nowMs) {
  if (!failure || !failure.last_failed_at) return false;
  const t = Date.parse(failure.last_failed_at);
  if (!Number.isFinite(t)) return false;
  return nowMs - t < FAILURE_BACKOFF_HOURS * 3600 * 1000;
}

// NEW (no sidecar entry) before STALE (oldest as_of first). Just-refreshed
// tickers sort last, so a re-run after a 429 abort continues down the list.
function buildPlan({ universe, indicators, failures, maxFetches, nowMs }) {
  const fresh = []; // NEW
  const stale = [];
  let backoffSkipped = 0;
  for (const t of universe) {
    if (inFailureBackoff(failures[t], nowMs)) {
      backoffSkipped++;
      continue;
    }
    const entry = indicators[t];
    if (!entry) {
      fresh.push({ ticker: t, status: "new", asOfMs: 0 });
    } else {
      const asOfMs = Date.parse(entry.as_of) || 0;
      stale.push({ ticker: t, status: "stale", asOfMs });
    }
  }
  stale.sort((a, b) => a.asOfMs - b.asOfMs);
  const ordered = [...fresh, ...stale];
  const targets = ordered.slice(0, maxFetches);
  return {
    targets,
    counts: {
      new: fresh.length,
      stale: stale.length,
      backoff: backoffSkipped,
      deferred: Math.max(0, ordered.length - targets.length),
    },
  };
}

/* ──────────────────────── atomic write ──────────────────────────── */

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

/* ──────────────────────────── main ──────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv);
  const nowMs = Date.now();
  console.log(
    `[enrich-technicals] maxFetches=${args.maxFetches} concurrency=${args.concurrency} ` +
      `delayMs=${args.delayMs} dryRun=${args.dryRun}`,
  );

  // Load the existing sidecar — merge semantics, never start from scratch.
  let existing = { indicators: {}, failures: {}, benchmark: null };
  if (fs.existsSync(SIDECAR_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(SIDECAR_PATH, "utf-8"));
      existing.indicators = parsed.indicators && typeof parsed.indicators === "object" ? parsed.indicators : {};
      existing.failures = parsed.failures && typeof parsed.failures === "object" ? parsed.failures : {};
      existing.benchmark = parsed.benchmark || null;
    } catch (err) {
      console.warn(`[enrich-technicals] existing sidecar unreadable (${err.message}) — rebuilding from empty`);
    }
  }

  const universe = buildUniverse();
  if (universe.length === 0) {
    console.warn("[enrich-technicals] empty universe — nothing to do.");
    return;
  }

  const plan = buildPlan({
    universe,
    indicators: existing.indicators,
    failures: existing.failures,
    maxFetches: args.maxFetches,
    nowMs,
  });
  console.log(
    `[enrich-technicals] universe=${universe.length} · new=${plan.counts.new} stale=${plan.counts.stale} ` +
      `backoff=${plan.counts.backoff} · planned=${plan.targets.length}` +
      (plan.counts.deferred ? ` · ${plan.counts.deferred} deferred to next run (budget cap)` : ""),
  );

  if (args.dryRun) {
    for (const t of plan.targets.slice(0, 40)) {
      console.log(`  ${t.ticker.padEnd(20)} ${t.status}`);
    }
    if (plan.targets.length > 40) console.log(`  ... and ${plan.targets.length - 40} more`);
    console.log("[enrich-technicals] dry-run — no fetches, no writes.");
    return;
  }
  if (plan.targets.length === 0) {
    console.log("[enrich-technicals] nothing to fetch — universe is fresh or backing off.");
    return;
  }

  // ── Benchmark: one cached ^NSEI fetch per run ──
  let benchmark = existing.benchmark && existing.benchmark.symbol === BENCHMARK_SYMBOL
    ? existing.benchmark
    : { symbol: BENCHMARK_SYMBOL, ret_3m_pct: null };
  let benchmarkRet3m = null;
  try {
    const idxBars = await fetchDailyBars(BENCHMARK_SYMBOL);
    benchmarkRet3m = ret3mPct(idxBars.map((b) => b.close));
    benchmark = { symbol: BENCHMARK_SYMBOL, ret_3m_pct: round2(benchmarkRet3m) };
    console.log(`[enrich-technicals] benchmark ${BENCHMARK_SYMBOL} 3M return: ${benchmark.ret_3m_pct}%`);
  } catch (err) {
    if (err.code === "RATE_LIMIT") {
      console.warn("[enrich-technicals] 429 on the benchmark fetch — aborting before ticker fetches (nothing to write)");
      return;
    }
    console.warn(
      `[enrich-technicals] benchmark fetch failed (${err.message}) — rs_vs_nifty_pct will be null this run`,
    );
  }

  // ── Ticker fetches (worker pool, abortable on 429) ──
  const indicators = { ...existing.indicators };
  const failures = { ...existing.failures };
  let aborted = false;
  let ok = 0;
  let failed = 0;
  let skippedAbort = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < plan.targets.length) {
      if (aborted) {
        skippedAbort += plan.targets.length - cursor;
        cursor = plan.targets.length;
        return;
      }
      const t = plan.targets[cursor++];
      try {
        const bars = await fetchDailyBars(`${t.ticker}.NS`);
        indicators[t.ticker] = computeIndicators(bars, benchmarkRet3m);
        delete failures[t.ticker];
        ok++;
      } catch (err) {
        if (err.code === "RATE_LIMIT") {
          aborted = true;
          console.warn(`[enrich-technicals] 429 from Yahoo on ${t.ticker} — aborting run, saving partial progress`);
          return;
        }
        failed++;
        failures[t.ticker] = {
          last_failed_at: new Date().toISOString(),
          code: err.code || String(err.message || err).slice(0, 80),
        };
      }
      if (args.delayMs > 0 && !aborted) await new Promise((r) => setTimeout(r, args.delayMs));
    }
  }

  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));

  // ── Merge + atomic write (SIDECAR ONLY — picks-latest.json is never touched) ──
  const out = {
    generatedAt: new Date().toISOString(),
    source: SOURCE_TAG,
    universe_size: universe.length,
    benchmark,
    failures,
    indicators,
  };
  writeJsonAtomic(SIDECAR_PATH, out);

  console.log(
    `[enrich-technicals] ${aborted ? "ABORTED (429) — partial saved" : "done"} · ` +
      `ok=${ok} failed=${failed}` +
      (skippedAbort ? ` skipped=${skippedAbort}` : "") +
      ` · sidecar now covers ${Object.keys(indicators).length} tickers → ${path.relative(PATHS.repoRoot, SIDECAR_PATH)}`,
  );
  if (plan.counts.deferred) {
    console.log(`[enrich-technicals] ${plan.counts.deferred} ticker(s) deferred — next run continues.`);
  }
}

// Always exit 0 — this is a non-fatal nightly enrich; a failed run just means
// technicals stay one day staler and stampEntryTiming degrades to Tier-1.
main().catch((err) => {
  console.error("[enrich-technicals] FAILED (non-fatal):", err.stack || err.message);
  process.exit(0);
});
