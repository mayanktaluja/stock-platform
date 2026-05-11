// Phase 4 — in-memory cache that backs the sync DAL surface when reading
// from Postgres. Async `warmUp()` populates the cache from the SQL
// backend; sync reads (getStockByTicker, getPicksLatest, etc.) then
// serve from this cache. The warmup contract means callers above the
// DAL never have to await.
//
// When SWS_READ_FROM_DB != 1 OR DATABASE_URL is unset, this whole module
// is inert — `dbCache.read*` returns null and the DAL falls back to the
// JSON backend.

import * as sqlBackend from "./sqlBackend.js";
import { isDbConfigured } from "../../db/client.js";

const TTL_MS = 5 * 60 * 1000; // single warmup good for 5 min before re-fetch

const cache = {
  picksLatest: { value: null, fetchedAt: 0 },
  scoredUniverse: { value: null, fetchedAt: 0 },
  universeIndex: { value: null, fetchedAt: 0 },
  v3UniverseStats: { value: null, fetchedAt: 0 },
  lastRefresh: { value: null, fetchedAt: 0 },
  sectorMomentum: { value: null, fetchedAt: 0 },
  snapshots: new Map(), // ticker -> { value, fetchedAt }
  shardProgress: new Map(),
};

export function isEnabled() {
  return process.env.SWS_READ_FROM_DB === "1" && isDbConfigured();
}

function fresh(entry) {
  return entry && entry.fetchedAt && Date.now() - entry.fetchedAt < TTL_MS;
}

// ── Sync readers (called by jsonBackend.js's wrapper when DB mode is on) ──

export function readPicksLatest() {
  return fresh(cache.picksLatest) ? cache.picksLatest.value : null;
}

export function readScoredUniverse() {
  return fresh(cache.scoredUniverse) ? cache.scoredUniverse.value : null;
}

export function readUniverseIndex() {
  return fresh(cache.universeIndex) ? cache.universeIndex.value : null;
}

export function readUniverseIndexMtime() {
  if (!fresh(cache.lastRefresh)) return null;
  const ts = cache.lastRefresh.value?.finished_at;
  return ts ? new Date(ts).getTime() : null;
}

export function readV3UniverseStats() {
  return fresh(cache.v3UniverseStats) ? cache.v3UniverseStats.value : null;
}

export function readLastRefresh() {
  return fresh(cache.lastRefresh) ? cache.lastRefresh.value : null;
}

export function readStockByTicker(ticker) {
  if (!ticker) return null;
  const key = String(ticker).trim().replace(/\.(NS|BO|BSE|NSE)$/i, "").toUpperCase();
  const entry = cache.snapshots.get(key);
  return fresh(entry) ? entry.value : null;
}

export function readSectorMomentum() {
  return fresh(cache.sectorMomentum) ? cache.sectorMomentum.value : null;
}

export function readShardProgressApi(n) {
  const entry = cache.shardProgress.get(n);
  return fresh(entry) ? entry.value : null;
}

export function readAllShardProgressApi() {
  return [1, 2, 3].map((n) => {
    const e = cache.shardProgress.get(n);
    return fresh(e) ? e.value : { id: n };
  });
}

export function readDeepTickers() {
  if (!fresh(cache.scoredUniverse)) return [];
  const stocks = cache.scoredUniverse.value?.stocks || [];
  return stocks.map((s) => s.ticker).filter(Boolean);
}

// ── Async warmups — populate the cache from the SQL backend ───────────

/**
 * Warm the lightweight top-level objects everyone needs (picks, universe,
 * universe-stats, last-refresh, sector momentum). Cheap — ~5 round-trips
 * to Neon. Idempotent within TTL.
 *
 * Per-ticker snapshots are NOT pulled here; use `warmUpSnapshots(tickers)`
 * when you have a known working set (e.g., portfolio holdings).
 */
export async function warmUpEssentials() {
  if (!isEnabled()) return;
  const [picks, scored, lr, v3, sm] = await Promise.all([
    sqlBackend.getPicksLatest(),
    sqlBackend.getScoredUniverse(),
    sqlBackend.getLastRefresh(),
    sqlBackend.getV3UniverseStats(),
    sqlBackend.getSectorMomentum(),
  ]);
  const now = Date.now();
  cache.picksLatest = { value: picks, fetchedAt: now };
  cache.scoredUniverse = { value: scored, fetchedAt: now };
  cache.lastRefresh = { value: lr, fetchedAt: now };
  cache.v3UniverseStats = { value: v3, fetchedAt: now };
  cache.sectorMomentum = { value: sm, fetchedAt: now };

  // Build universe index from scored stocks while we have it in memory.
  if (scored?.stocks) {
    const byTicker = new Map();
    for (const s of scored.stocks) {
      if (s?.ticker) byTicker.set(String(s.ticker).toUpperCase(), s);
    }
    cache.universeIndex = { value: byTicker, fetchedAt: now };
  }
}

/**
 * Warm the per-ticker snapshot cache for a known set. Used by portfolio
 * routes that score a list of holdings — one bulk SQL `WHERE ticker IN
 * (...)` populates the sync `loadSWSDeep` cache.
 */
export async function warmUpSnapshots(tickers) {
  if (!isEnabled() || !Array.isArray(tickers) || tickers.length === 0) return;
  // Filter to tickers not already fresh in cache.
  const need = [];
  for (const t of tickers) {
    if (!t) continue;
    const key = String(t).trim().replace(/\.(NS|BO|BSE|NSE)$/i, "").toUpperCase();
    if (!fresh(cache.snapshots.get(key))) need.push(key);
  }
  if (!need.length) return;
  const rows = await sqlBackend.getStocksByTickers(need);
  const now = Date.now();
  for (const r of rows) {
    if (r?.ticker) cache.snapshots.set(r.ticker, { value: r, fetchedAt: now });
  }
  // Negative-cache misses so we don't re-query non-existent tickers every call.
  const have = new Set(rows.map((r) => r?.ticker).filter(Boolean));
  for (const t of need) {
    if (!have.has(t)) cache.snapshots.set(t, { value: null, fetchedAt: now });
  }
}

/**
 * Combined warmup — call once at server boot and after each canonical flip.
 * Optionally takes a tickers list to also prime per-ticker cache.
 */
export async function warmUp({ tickers } = {}) {
  if (!isEnabled()) return;
  await warmUpEssentials();
  if (tickers?.length) await warmUpSnapshots(tickers);
}

export function invalidateAll() {
  for (const k of Object.keys(cache)) {
    if (cache[k] instanceof Map) cache[k].clear();
    else cache[k] = { value: null, fetchedAt: 0 };
  }
}
