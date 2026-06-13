#!/usr/bin/env node
/**
 * Quota-aware incremental refresh of fundamentalsHistory.json.
 *
 * Why this exists: fundamentalsHistory.json was a one-time snapshot —
 * 494 stocks, only ~10 with quarterly data fresher than 90 days, and
 * 373 of the 488 Earnings Watch stocks not in it at all. The earnings
 * predictor's YoY-EPS-trajectory component (±15 pts) was therefore
 * dead for ~95% of events. Neither existing script fixes this:
 * fetch-fundamentals-history.mjs does a blind full re-fetch (4 Yahoo
 * calls/stock — blows the ~2,000/day soft ceiling); expand-fundamentals-
 * history.mjs only ADDS missing Nifty-500 names, never refreshes.
 *
 * This script:
 *   - Universe = curated stockList ∪ fresh catalysts events ∪ current Earnings Watch symbols.
 *   - NEW stocks (coverage) are fetched before STALE ones (freshness).
 *   - Yahoo calls are budget-capped (--max-fetches, default 1800);
 *     overflow is queued for the next nightly run.
 *   - A fetch that 429s aborts the run cleanly — partial progress is
 *     still written atomically.
 *   - Per-stock 24h failure backoff so a throttled/delisted symbol
 *     doesn't burn the budget every run.
 *   - data/fundamentals-history-overrides.json is reapplied last, so a
 *     re-fetch can never clobber a hand-correction.
 *
 * Runs LOCALLY on its own nightly schedule — NOT chained into
 * refresh-earnings.mjs (a ~30-min Yahoo job has no business inside a
 * Vercel cron).
 *
 * Usage:
 *   node scripts/refresh-fundamentals-history.mjs
 *   node scripts/refresh-fundamentals-history.mjs --max-fetches 1800
 *   node scripts/refresh-fundamentals-history.mjs --module all      # force 4-call fetch
 *   node scripts/refresh-fundamentals-history.mjs --dry-run
 *
 * Exit codes:
 *   0  ran (including a clean 429 abort with partial progress saved)
 *   1  fatal error
 */

import fs from "node:fs";
import path from "node:path";
import YahooFinance from "yahoo-finance2";

import { getAllStocks } from "../stockList.js";
import {
  toNseSymbol,
  selectRefreshTargets,
  mergeOverrides,
  computeDrift,
} from "../services/fundamentals/fundamentalsRefreshPlanner.js";

const ROOT = process.cwd();
const HISTORY_PATH = path.join(ROOT, "fundamentalsHistory.json");
const EVENTS_PATH = path.join(ROOT, "data", "catalysts", "events-latest.json");
const EARNINGS_PATH = path.join(ROOT, "data", "catalysts", "earnings-watch-latest.json");
const OVERRIDES_PATH = path.join(ROOT, "data", "fundamentals-history-overrides.json");

const PERIOD1 = "2016-01-01";
const PERIOD2 = new Date().toISOString().slice(0, 10);

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

/* ──────────────────────────── args ──────────────────────────────── */

function parseArgs(argv) {
  const out = {
    maxFetches: 1800,
    staleAfterDays: 90,
    concurrency: 4,
    delayMs: 250,
    module: "auto", // auto | all | quarterly-only
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--max-fetches") out.maxFetches = Number(argv[++i]);
    else if (a.startsWith("--max-fetches=")) out.maxFetches = Number(a.split("=")[1]);
    else if (a === "--stale-after-days") out.staleAfterDays = Number(argv[++i]);
    else if (a.startsWith("--stale-after-days=")) out.staleAfterDays = Number(a.split("=")[1]);
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a.startsWith("--concurrency=")) out.concurrency = Number(a.split("=")[1]);
    else if (a === "--module") out.module = argv[++i];
    else if (a.startsWith("--module=")) out.module = a.split("=")[1];
  }
  if (!Number.isFinite(out.maxFetches) || out.maxFetches <= 0) out.maxFetches = 1800;
  if (!Number.isFinite(out.staleAfterDays) || out.staleAfterDays <= 0) out.staleAfterDays = 90;
  if (!Number.isFinite(out.concurrency) || out.concurrency <= 0) out.concurrency = 4;
  return out;
}

/* ─────────────────────── Yahoo fetch helpers ────────────────────── */

// Adapted from scripts/fetch-fundamentals-history.mjs — kept inline
// because that script self-executes main() at import time.

function normalizeDate(d) {
  if (d == null) return null;
  if (typeof d === "number") return new Date(d * 1000).toISOString().slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === "string") {
    const dt = new Date(d);
    return Number.isFinite(dt.getTime()) ? dt.toISOString().slice(0, 10) : null;
  }
  return null;
}

function mergeByDate(rows) {
  const byDate = new Map();
  for (const r of rows) {
    const endDate = normalizeDate(r.date);
    if (!endDate) continue;
    if (!byDate.has(endDate)) byDate.set(endDate, { endDate });
    Object.assign(byDate.get(endDate), r);
  }
  return [...byDate.values()].sort((a, b) => a.endDate.localeCompare(b.endDate));
}

function extractFields(row) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const totalRevenue = num(row.totalRevenue ?? row.operatingRevenue);
  const netIncome = num(
    row.netIncome ?? row.netIncomeCommonStockholders ?? row.netIncomeContinuousOperations,
  );
  const equity = num(row.stockholdersEquity ?? row.commonStockEquity);
  const totalDebt = num(row.totalDebt);
  const dilutedEPS = num(row.dilutedEPS ?? row.basicEPS);
  const dilutedAverageShares = num(row.dilutedAverageShares ?? row.basicAverageShares);
  if (totalRevenue == null && netIncome == null && equity == null) return null;
  return { endDate: row.endDate, totalRevenue, netIncome, equity, totalDebt, dilutedEPS, dilutedAverageShares };
}

function isRateLimitError(err) {
  const msg = String((err && err.message) || "").toLowerCase();
  return /429|too many requests|rate.?limit/.test(msg) || (err && err.response && err.response.status === 429);
}

/**
 * Fetch a stock's history. mode "all" pulls annual + quarterly (4
 * calls); mode "quarterly" pulls quarterly only (2 calls) for a stale
 * refresh where the annual baseline is already on file.
 * Throws on a rate-limit error so the caller can abort the run.
 */
async function fetchHistory(symbol, mode) {
  const opts = { validateResult: false };
  const ts = (type, module) =>
    yf.fundamentalsTimeSeries(symbol, { period1: PERIOD1, period2: PERIOD2, type, module }, opts);

  let annual = null;
  if (mode === "all") {
    let annualFin, annualBS;
    try {
      [annualFin, annualBS] = await Promise.all([ts("annual", "financials"), ts("annual", "balance-sheet")]);
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      annualFin = []; annualBS = [];
    }
    annual = mergeByDate([...(annualFin || []), ...(annualBS || [])]).map(extractFields).filter(Boolean);
  }

  let qFin, qBS;
  try {
    [qFin, qBS] = await Promise.all([ts("quarterly", "financials"), ts("quarterly", "balance-sheet")]);
  } catch (err) {
    if (isRateLimitError(err)) throw err;
    qFin = []; qBS = [];
  }
  const quarterly = mergeByDate([...(qFin || []), ...(qBS || [])]).map(extractFields).filter(Boolean);

  return { annual, quarterly };
}

/* ─────────────────────────── universe ───────────────────────────── */

function buildUniverse() {
  const meta = new Map(); // Yahoo symbol → { sector, indices }
  const order = [];
  const add = (sym, sector, indices) => {
    const y = toNseSymbol(sym);
    if (!y) return;
    if (!meta.has(y)) {
      meta.set(y, { sector: sector || null, indices: indices || [] });
      order.push(y);
    } else if (sector && !meta.get(y).sector) {
      meta.get(y).sector = sector;
    }
  };

  // 1. Curated stockList — stable core.
  for (const s of getAllStocks()) add(s.symbol, s.sector, s.indices);

  // 2. Fresh catalysts calendar — this file is refreshed before the nightly
  //    fundamentalsHistory step, while earnings-watch-latest is produced later.
  try {
    const events = JSON.parse(fs.readFileSync(EVENTS_PATH, "utf8"));
    const rows = Array.isArray(events?.events) ? events.events
      : Array.isArray(events?.items) ? events.items
        : Array.isArray(events) ? events
          : [];
    for (const e of rows) {
      if (e && e.symbol) add(e.symbol, e.sector || e.signals?.sector, []);
    }
  } catch {
    console.warn(`[refresh-fundamentals] could not read ${path.relative(ROOT, EVENTS_PATH)} — continuing with curated/watch universe`);
  }

  // 3. Current Earnings Watch symbols — kept as a fallback/supplement for
  //    manual runs where events-latest has not just been refreshed.
  try {
    const ew = JSON.parse(fs.readFileSync(EARNINGS_PATH, "utf8"));
    for (const e of ew.events || []) {
      if (e && e.symbol) add(e.symbol, e.signals?.sector || e.sector, []);
    }
  } catch {
    console.warn(`[refresh-fundamentals] could not read ${path.relative(ROOT, EARNINGS_PATH)} — curated universe only`);
  }

  return { order, meta };
}

/* ──────────────────────── atomic write ──────────────────────────── */

function writeJsonAtomic(p, obj) {
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

/* ──────────────────────────── main ──────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv);
  const todayIso = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  console.log(
    `[refresh-fundamentals] maxFetches=${args.maxFetches} staleAfterDays=${args.staleAfterDays} ` +
      `module=${args.module} concurrency=${args.concurrency} dryRun=${args.dryRun}`,
  );

  // Load existing — never start from scratch, never shrink the file.
  let history = { generatedAt: null, source: "yahoo-finance2", stocks: {} };
  if (fs.existsSync(HISTORY_PATH)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
      if (!history.stocks) history.stocks = {};
    } catch (err) {
      console.error(`[refresh-fundamentals] existing file unreadable — refusing to overwrite: ${err.message}`);
      process.exit(1);
    }
  }
  const stocks = history.stocks;
  const startCount = Object.keys(stocks).length;

  const { order, meta } = buildUniverse();
  const plan = selectRefreshTargets({
    universe: order,
    stocks,
    opts: { todayIso, staleAfterDays: args.staleAfterDays, maxFetches: args.maxFetches },
  });
  console.log(
    `[refresh-fundamentals] universe=${order.length} · new=${plan.counts.new} stale=${plan.counts.stale} ` +
      `fresh=${plan.skipped.fresh} backoff=${plan.skipped.backoff}`,
  );
  console.log(
    `[refresh-fundamentals] planned ${plan.targets.length} fetch(es) (~${plan.plannedCalls} Yahoo calls)` +
      (plan.budgetCapped ? ` · ${plan.skipped.over_budget} deferred to next run (budget cap)` : ""),
  );

  if (args.dryRun) {
    for (const t of plan.targets.slice(0, 40)) {
      console.log(`  ${t.symbol.padEnd(20)} ${t.status.padEnd(6)} ${t.reason}`);
    }
    if (plan.targets.length > 40) console.log(`  ... and ${plan.targets.length - 40} more`);
    console.log("[refresh-fundamentals] dry-run — no writes.");
    return;
  }
  if (plan.targets.length === 0) {
    console.log("[refresh-fundamentals] nothing to refresh — universe is fresh.");
    return;
  }

  // ── Fetch (worker pool, abortable on 429) ──
  let aborted = false;
  let ok = 0, empty = 0, failed = 0, skippedAbort = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < plan.targets.length) {
      if (aborted) { skippedAbort += plan.targets.length - cursor; cursor = plan.targets.length; return; }
      const t = plan.targets[cursor++];
      const mode = args.module === "all" ? "all"
        : args.module === "quarterly-only" ? "quarterly"
        : (t.status === "new" ? "all" : "quarterly"); // auto
      const existing = stocks[t.symbol];
      try {
        const hist = await fetchHistory(t.symbol, mode);
        const annual = hist.annual != null ? hist.annual : (existing && existing.annual) || [];
        const quarterly = hist.quarterly || [];
        if (annual.length === 0 && quarterly.length === 0) {
          empty += 1;
          stocks[t.symbol] = {
            ...(existing || {}),
            ...(meta.get(t.symbol) || {}),
            annual: (existing && existing.annual) || [],
            quarterly: (existing && existing.quarterly) || [],
            _meta: {
              ...((existing && existing._meta) || {}),
              last_attempted_at: new Date().toISOString(),
              last_failed_at: new Date().toISOString(),
              last_error: "empty",
            },
          };
        } else {
          ok += 1;
          const m = meta.get(t.symbol) || {};
          stocks[t.symbol] = {
            sector: m.sector || (existing && existing.sector) || null,
            indices: (m.indices && m.indices.length ? m.indices : (existing && existing.indices)) || [],
            annual,
            quarterly,
            _meta: {
              refreshed_at: new Date().toISOString(),
              last_attempted_at: new Date().toISOString(),
              source: "yahoo-finance2",
              fetch_mode: mode,
            },
          };
        }
      } catch (err) {
        if (isRateLimitError(err)) {
          aborted = true;
          console.warn(`[refresh-fundamentals] 429 from Yahoo on ${t.symbol} — aborting run, saving partial progress`);
          return;
        }
        failed += 1;
        stocks[t.symbol] = {
          ...(existing || {}),
          ...(existing ? {} : meta.get(t.symbol) || {}),
          annual: (existing && existing.annual) || [],
          quarterly: (existing && existing.quarterly) || [],
          _meta: {
            ...((existing && existing._meta) || {}),
            last_attempted_at: new Date().toISOString(),
            last_failed_at: new Date().toISOString(),
            last_error: String(err.message || err).slice(0, 200),
          },
        };
      }
      if (args.delayMs > 0 && !aborted) await new Promise((r) => setTimeout(r, args.delayMs));
    }
  }

  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));

  // ── Manual overrides win, always reapplied ──
  let overrideCount = 0;
  if (fs.existsSync(OVERRIDES_PATH)) {
    try {
      const overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"));
      const merged = mergeOverrides(stocks, overrides);
      history.stocks = merged;
      overrideCount = Object.keys(overrides || {}).length;
    } catch (err) {
      console.warn(`[refresh-fundamentals] overrides file unreadable, skipping: ${err.message}`);
    }
  }

  // ── Universe drift (reported, never deleted) ──
  const universeSet = new Set(order);
  const drift = computeDrift(history.stocks, universeSet);

  history.generatedAt = new Date().toISOString();
  history.source = "yahoo-finance2 (incremental)";
  history.counts = {
    total: Object.keys(history.stocks).length,
    refreshed_ok: ok,
    empty,
    failed,
    skipped_abort: skippedAbort,
    overrides_applied: overrideCount,
    drift_symbols: drift.length,
  };
  history.refresh_meta = {
    refreshed_at: history.generatedAt,
    today_iso: todayIso,
    planned: plan.targets.length,
    planned_calls: plan.plannedCalls,
    budget_capped: plan.budgetCapped,
    deferred_over_budget: plan.skipped.over_budget,
    aborted_429: aborted,
  };

  writeJsonAtomic(HISTORY_PATH, history);

  console.log(
    `[refresh-fundamentals] ${aborted ? "ABORTED (429) — partial saved" : "done"} · ` +
      `ok=${ok} empty=${empty} failed=${failed}` +
      (skippedAbort ? ` skipped=${skippedAbort}` : "") +
      ` · total ${startCount} → ${Object.keys(history.stocks).length} stocks`,
  );
  if (overrideCount) console.log(`[refresh-fundamentals] reapplied ${overrideCount} manual override(s)`);
  if (drift.length) console.log(`[refresh-fundamentals] ${drift.length} drift symbol(s) in file but not in current universe (kept)`);
  if (plan.budgetCapped) {
    console.log(`[refresh-fundamentals] ${plan.skipped.over_budget} stock(s) deferred — re-run to continue.`);
  }
}

main().catch((err) => {
  console.error("[refresh-fundamentals] FAILED:", err.stack || err.message);
  process.exit(1);
});
