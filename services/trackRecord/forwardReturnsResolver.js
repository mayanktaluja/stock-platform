/**
 * forwardReturnsResolver.js
 *
 * Walks every paper-trade entry, finds horizons whose anniversary has
 * arrived, and writes the realised forward-return + benchmark-return +
 * alpha back into `returns_by_horizon[h]`. Patches are persisted via
 * paperTradesStorage.updateById — same JSONL line, mutable update.
 *
 * The resolver is idempotent: rows with `status: 'closed'` are skipped on
 * subsequent runs.
 *
 * Sources:
 *   • Stock close at anniversary  → Yahoo Finance v8/finance/chart, 1y range.
 *     Returns the bar whose date equals the anniversary, or the most recent
 *     trading-day before it (NSE-holiday backstep is implicit because Yahoo
 *     skips non-trading days in its bar array).
 *
 *   • Benchmark close at anniversary → AMFI mfapi.in (via fetchSchemeHistory
 *     in mfNavIngestion.js). Each `benchmark_proxy` maps to a Direct-Growth
 *     index-fund scheme code; we read NAV at snapshot-date and at anniversary-
 *     date.
 *
 *   • Earnings T+1 special path → mirror the verdict outcome from
 *     data/catalysts/earnings-history/<event_date>.json. alpha_pct = +1 (hit)
 *     or -1 (miss); the multi-horizon machinery is bypassed.
 */

import path from "node:path";
import fs from "node:fs";

import { readAllTrades, horizonDays, inferSideFromType } from "../../paperTrades.js";
import { getStorage } from "../../paperTradesStorage.js";
import { fetchSchemeHistory } from "../../mfNavIngestion.js";
import { PROXY_REGISTRY } from "../../benchmarkIndices.js";
import { earningsHistoryReadDir } from "../earnings/earningsHistoryStore.js";

const YF_BASE = "https://query1.finance.yahoo.com";
const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};

// In-memory bar cache for the duration of one resolver run. Each unique
// symbol fetched once. The resolver runs daily so a cold cache per run is fine.
const _historicalCache = new Map();

async function fetchHistoricalSelfContained(symbol, range = "1y") {
  const key = `${symbol}_${range}`;
  if (_historicalCache.has(key)) return _historicalCache.get(key);
  try {
    const url = `${YF_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
    const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) { _historicalCache.set(key, null); return null; }
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) { _historicalCache.set(key, null); return null; }
    const timestamps = r.timestamp || [];
    const q = r.indicators?.quote?.[0];
    if (!q) { _historicalCache.set(key, null); return null; }
    const bars = timestamps
      .map((ts, i) => ({
        date: new Date(ts * 1000),
        close: q.close?.[i],
      }))
      .filter((d) => d.close != null);
    _historicalCache.set(key, bars);
    return bars;
  } catch (err) {
    console.warn(`[trackRecord:resolver] historical fetch ${symbol} failed:`, err.message);
    _historicalCache.set(key, null);
    return null;
  }
}

/**
 * Find the close on the latest trading day on-or-before `target`. Yahoo
 * skips holidays in its bar array, so this naturally backs off to the
 * last trading day.
 */
function closeAtOrBefore(bars, target) {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const t = target.getTime();
  let chosen = null;
  for (const b of bars) {
    if (b.date.getTime() <= t) chosen = b;
    else break;
  }
  return chosen ? chosen.close : null;
}

function navAtOrBefore(series, target) {
  if (!Array.isArray(series) || series.length === 0) return null;
  const targetIso = target.toISOString().slice(0, 10);
  let chosen = null;
  for (const row of series) {
    if (row.date <= targetIso) chosen = row;
    else break;
  }
  return chosen ? chosen.nav : null;
}

function addDays(iso, n) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

// ──────────────────── Single-trade resolution ────────────────────

async function resolveStandardHorizonsForTrade(trade, todayMs) {
  const out = {};
  if (!trade.snapshotAt || !trade.priceAtSnapshot) return out;
  const horizons = trade.target_horizons || [];
  const dueHorizons = horizons.filter((h) => {
    const days = horizonDays(h);
    if (!days) return false;
    const anniv = addDays(trade.snapshotAt, days).getTime();
    if (anniv > todayMs) return false;
    const slot = trade.returns_by_horizon?.[h];
    return slot && slot.status === "open";
  });
  if (dueHorizons.length === 0) return out;

  const bars = await fetchHistoricalSelfContained(trade.symbol, "1y");
  if (!bars) return out;

  const proxyKey = trade.benchmark_proxy || "nifty50_tri";
  const proxy = PROXY_REGISTRY[proxyKey];
  let benchSeries = null;
  if (proxy?.schemeCode) {
    benchSeries = await fetchSchemeHistory(proxy.schemeCode);
  }
  const snapshotNav = benchSeries ? navAtOrBefore(benchSeries, new Date(trade.snapshotAt)) : null;

  const side = trade.side || inferSideFromType(trade.type);
  const isShort = side === "SHORT";

  for (const h of dueHorizons) {
    const days = horizonDays(h);
    const anniv = addDays(trade.snapshotAt, days);
    const exitClose = closeAtOrBefore(bars, anniv);
    if (exitClose == null) continue;

    let underlyingReturn = ((exitClose - trade.priceAtSnapshot) / trade.priceAtSnapshot) * 100;
    let returnPct = isShort ? -underlyingReturn : underlyingReturn;

    let benchReturn = null;
    if (benchSeries && snapshotNav) {
      const exitNav = navAtOrBefore(benchSeries, anniv);
      if (exitNav) benchReturn = ((exitNav - snapshotNav) / snapshotNav) * 100;
    }

    let alpha = null;
    if (Number.isFinite(returnPct) && Number.isFinite(benchReturn)) {
      // SHORT: profit when underlying lags; we subtract benchmark from the
      // already-inverted return so the sign carries through correctly.
      // (Equivalent to returnPct + benchReturn for SHORT, returnPct - benchReturn for LONG.)
      alpha = isShort ? (returnPct + benchReturn) : (returnPct - benchReturn);
    }

    out[h] = {
      exit_date: anniv.toISOString().slice(0, 10),
      exit_price: round2(exitClose),
      return_pct: round2(returnPct),
      benchmark_return_pct: round2(benchReturn),
      alpha_pct: round2(alpha),
      status: "closed",
    };
  }
  return out;
}

function round2(x) {
  if (!Number.isFinite(x)) return null;
  return +x.toFixed(2);
}

// ──────────────────── Earnings T+1 special path ────────────────────

function readEarningsHistoryForDate(eventDate) {
  if (!eventDate) return null;
  // Runs on Vercel via /api/cron/resolve-forward-returns, where the archive is
  // served from the packed tarball rather than the loose directory.
  const file = path.join(earningsHistoryReadDir(), `${eventDate}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

async function resolveEarningsT1ForTrade(trade) {
  if (!trade.target_horizons?.includes("t1")) return {};
  const slot = trade.returns_by_horizon?.t1;
  if (!slot || slot.status !== "open") return {};

  // Earnings event date is the snapshot date (event_iso_date == snapshot dateKey
  // when the snapshotter ran on the event day). Try the snapshot date first,
  // fall back to a 7-day forward scan in case snapshot ran ahead of the event.
  const candidates = [];
  candidates.push(trade.dateKey);
  for (let i = 1; i <= 7; i++) {
    candidates.push(addDays(trade.snapshotAt, i).toISOString().slice(0, 10));
  }
  let history = null;
  let usedDate = null;
  for (const d of candidates) {
    const h = readEarningsHistoryForDate(d);
    if (h && Array.isArray(h.events)) { history = h; usedDate = d; break; }
  }
  if (!history) return {};

  // Strip the .NS suffix back off — earnings history stores raw NSE symbols.
  const target = (trade.symbol || "").replace(/\.NS$/i, "");
  const event = history.events.find((e) => (e.symbol || "").toUpperCase() === target.toUpperCase());
  if (!event || event.actual_verdict == null) return {};

  const predicted = trade.recommendationAtSnapshot || (trade.type === "earnings_beat_top10" ? "BEAT" : "MISS");
  const hit = String(event.actual_verdict).toUpperCase() === String(predicted).toUpperCase();

  // Categorical alpha: +1 for hit, -1 for miss. Lets the scorecard treat
  // earnings sections with the same hit-rate / mean-alpha primitives as
  // multi-horizon sections without special-casing.
  return {
    t1: {
      exit_date: usedDate,
      exit_price: event.actual_t1_close_inr ?? null,
      return_pct: hit ? 1 : -1,
      benchmark_return_pct: 0,
      alpha_pct: hit ? 1 : -1,
      status: "closed",
    },
  };
}

// ──────────────────── Public API ────────────────────

/**
 * Resolve every open horizon whose anniversary has passed.
 *
 * @param {object} opts  { todayIso }
 * @returns {Promise<{ resolved: object, processed: number, due: number }>}
 */
export async function resolveOpenHorizons(opts = {}) {
  const todayIso = opts.todayIso || new Date().toISOString();
  const todayMs = new Date(todayIso).getTime();
  const trades = await readAllTrades();
  if (!Array.isArray(trades) || trades.length === 0) {
    return { resolved: {}, processed: 0, due: 0 };
  }

  const v2Trades = trades.filter((t) => t && t.returns_by_horizon && t.target_horizons);
  const due = v2Trades.filter((t) =>
    t.target_horizons.some((h) => {
      const slot = t.returns_by_horizon?.[h];
      if (!slot || slot.status !== "open") return false;
      if (h === "t1") {
        // earnings: due once event day passes
        return new Date(t.snapshotAt).getTime() <= todayMs;
      }
      const days = horizonDays(h);
      return days != null && addDays(t.snapshotAt, days).getTime() <= todayMs;
    })
  );

  const patches = [];
  const resolvedTally = {};

  for (const trade of due) {
    let updates;
    if (trade.target_horizons.includes("t1")) {
      updates = await resolveEarningsT1ForTrade(trade);
    } else {
      updates = await resolveStandardHorizonsForTrade(trade, todayMs);
    }
    if (Object.keys(updates).length === 0) continue;

    const merged = { ...(trade.returns_by_horizon || {}) };
    for (const [h, v] of Object.entries(updates)) {
      merged[h] = v;
      resolvedTally[h] = (resolvedTally[h] || 0) + 1;
    }
    patches.push({ id: trade.id, returns_by_horizon: merged });
  }

  if (patches.length > 0) {
    const storage = getStorage();
    await storage.updateById(patches);
  }

  return { resolved: resolvedTally, processed: patches.length, due: due.length, todayIso };
}
