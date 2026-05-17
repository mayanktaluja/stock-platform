// services/swsDal — the single Data Access Layer for the SWS data tier.
//
// SHAPE OF THIS LAYER:
//
//   Reads (sync) — default JSON backend, swappable via SWS_READ_FROM_DB=1
//     when callers can be made async. See "Phase 4 activation" in
//     services/swsDal/README.md before flipping the env flag.
//
//   Writes (async) — always go to the SQL backend, but only fire when
//     DATABASE_URL is set AND SWS_DB_DUAL_WRITE=1 (else they're no-ops so
//     callers stay one-codepath across enabled/disabled environments).
//
// See /Users/mayanktaluja/.claude/plans/sws-json-indexed-stroustrup.md
// for the migration plan this DAL anchors.

import * as jsonBackend from "./jsonBackend.js";
import * as sqlBackend from "./sqlBackend.js";
import * as dbCache from "./dbCache.js";
import { isDbConfigured } from "../../db/client.js";

// Env flags are read FRESH on every check so tests + pipeline shells can
// flip them mid-process. Cheap (string compare); no caching trade-off.
const readFromDb = () => process.env.SWS_READ_FROM_DB === "1";
const dualWrite = () => process.env.SWS_DB_DUAL_WRITE === "1";

// Tests can swap the entire backend; Phase 4 read activation will swap
// the default at boot.
let _backend = jsonBackend;

export function __setBackend(impl) {
  _backend = impl ?? jsonBackend;
}

export function __getBackend() {
  return _backend;
}

// ── Read-side flags ─────────────────────────────────────────────────────

export function isReadingFromDb() {
  return readFromDb();
}

export function isDualWriteEnabled() {
  return dualWrite() && isDbConfigured();
}

// ── Reads (sync) — Phase 1+ ─────────────────────────────────────────────
// These stay sync. When SWS_READ_FROM_DB=1 and the in-memory dbCache has
// fresh data (populated by `await warmUp(...)`), reads serve from there;
// otherwise they fall through to the JSON backend. The dbCache fallback
// means callers never have to await individual lookups.

function fromDbOr(cacheRead, jsonRead) {
  if (dbCache.isEnabled()) {
    const v = cacheRead();
    if (v != null) return v;
  }
  return jsonRead();
}

export function getStockByTicker(ticker) {
  return fromDbOr(
    () => dbCache.readStockByTicker(ticker),
    () => _backend.getStockByTicker(ticker),
  );
}

export function listDeepTickers() {
  if (dbCache.isEnabled()) {
    const cached = dbCache.readDeepTickers();
    if (cached.length) return cached;
  }
  return _backend.listDeepTickers();
}

export function getScoredUniverse() {
  return fromDbOr(dbCache.readScoredUniverse, () => _backend.getScoredUniverse());
}

export function getUniverseIndex() {
  return fromDbOr(dbCache.readUniverseIndex, () => _backend.getUniverseIndex());
}

export function getUniverseIndexMtime() {
  if (dbCache.isEnabled()) {
    const m = dbCache.readUniverseIndexMtime();
    if (m != null) return m;
  }
  return _backend.getUniverseIndexMtime?.() ?? null;
}

export function getV3UniverseStats() {
  return fromDbOr(dbCache.readV3UniverseStats, () => _backend.getV3UniverseStats());
}

export function getPicksLatest() {
  return fromDbOr(dbCache.readPicksLatest, () => _backend.getPicksLatest());
}

export function getLastRefresh() {
  return fromDbOr(dbCache.readLastRefresh, () => _backend.getLastRefresh());
}

export function getShardProgressApi(n) {
  return fromDbOr(
    () => dbCache.readShardProgressApi(n),
    () => _backend.getShardProgressApi(n),
  );
}

export function getAllShardProgressApi() {
  if (dbCache.isEnabled()) {
    const cached = dbCache.readAllShardProgressApi();
    // If any shard has data from cache, prefer cache; else fall back.
    if (cached.some((s) => s.done_count != null)) return cached;
  }
  return _backend.getAllShardProgressApi();
}

// Returns { map: Map<sector, { avg_1m_pct, sample_size }>, scanned: number }.
// Phase 4 SQL backend replaces the O(5,517) deep-file scan with one SQL
// aggregate. See sqlBackend.getSectorMomentum.
export function getSectorMomentum() {
  return fromDbOr(dbCache.readSectorMomentum, () => _backend.getSectorMomentum());
}

export function invalidateAll() {
  if (typeof _backend.invalidateAll === "function") _backend.invalidateAll();
  if (isDbConfigured()) {
    sqlBackend.invalidateAll();
    dbCache.invalidateAll();
  }
}

// ── Warmup (async) — populates the in-memory cache that backs sync reads
//    when SWS_READ_FROM_DB=1. No-op otherwise so callers can be unconditional. ──

export async function warmUp(opts = {}) {
  if (!dbCache.isEnabled()) return;
  return dbCache.warmUp(opts);
}

export async function warmUpEssentials() {
  if (!dbCache.isEnabled()) return;
  return dbCache.warmUpEssentials();
}

export async function warmUpSnapshots(tickers) {
  if (!dbCache.isEnabled()) return;
  return dbCache.warmUpSnapshots(tickers);
}

// Path constants — used by a few callers that still need raw paths during
// the migration. Removed in Phase 5 cleanup.
export const DATA_DIR = jsonBackend.DATA_DIR;
export const DEEP_DIR = jsonBackend.DEEP_DIR;

// ────────────────────────────────────────────────────────────────────────
// Writes (async) — dispatch to SQL backend when dual-write is on.
// ────────────────────────────────────────────────────────────────────────
//
// Pipeline scripts call these alongside their existing JSON writes. When
// SWS_DB_DUAL_WRITE=0 (or DATABASE_URL is unset), every write below is a
// no-op so production behaviour is unchanged.

function gated(fn) {
  return async (...args) => {
    if (!isDualWriteEnabled()) return null;
    try {
      return await fn(...args);
    } catch (err) {
      // Dual-write failures should NOT take down a pipeline run; they
      // surface as warnings and verify-db-vs-json catches the drift.
      console.warn(`[dal] write failed (${fn.name || "anon"}): ${err.message}`);
      return null;
    }
  };
}

// Run lifecycle
export const beginRun = gated(sqlBackend.beginRun);
export const recordRunProgress = gated(sqlBackend.recordRunProgress);
export const finaliseRun = gated(sqlBackend.finaliseRun);

// Run reads (always SQL — these don't have a JSON equivalent)
export const getCanonicalRunId = async () => {
  if (!isDbConfigured()) return null;
  return sqlBackend.getCanonicalRunId();
};
export const getPriorCanonicalRunId = async () => {
  if (!isDbConfigured()) return null;
  return sqlBackend.getPriorCanonicalRunId();
};

// Company + snapshot writes
export const upsertCompany = gated(sqlBackend.upsertCompany);
export const upsertCompanySnapshot = gated(sqlBackend.upsertCompanySnapshot);

// Pick writes
export const replacePicksForRun = gated(sqlBackend.replacePicksForRun);
export const applyNarrativeAcrossSections = gated(sqlBackend.applyNarrativeAcrossSections);
export const stampSectionStatus = gated(sqlBackend.stampSectionStatus);
export const updatePickEarningsBeat = gated(sqlBackend.updatePickEarningsBeat);

// Universe writes
export const upsertUniverseEntries = gated(sqlBackend.upsertUniverseEntries);
export const upsertUniverseStats = gated(sqlBackend.upsertUniverseStats);

// Sanity + failures
export const recordSanityReport = gated(sqlBackend.recordSanityReport);
export const recordScrapeFailure = gated(sqlBackend.recordScrapeFailure);
export const listScrapeFailuresForTicker = async (...args) => {
  if (!isDbConfigured()) return [];
  return sqlBackend.listScrapeFailuresForTicker(...args);
};

// Shard progress
export const upsertShardProgress = gated(sqlBackend.upsertShardProgress);
export const getShardProgressApiAsync = async (n) => {
  if (!isDbConfigured()) return null;
  return sqlBackend.getShardProgressApi(n);
};

// Control flags
export const setControlFlag = gated(sqlBackend.setControlFlag);
export const getControlFlag = async (...args) => {
  if (!isDbConfigured()) return null;
  return sqlBackend.getControlFlag(...args);
};
export const acquirePipelineLock = async (...args) => {
  if (!isDbConfigured()) return { acquired: false, reason: "DATABASE_URL not set" };
  return sqlBackend.acquirePipelineLock(...args);
};
export const releasePipelineLock = gated(sqlBackend.releasePipelineLock);

// ────────────────────────────────────────────────────────────────────────
// Async-aware READ siblings — Phase 4 will swap the sync read methods
// above to use these once consumers are awaited.
// ────────────────────────────────────────────────────────────────────────

export const getStockByTickerAsync = async (ticker) => {
  if (readFromDb() && isDbConfigured()) return sqlBackend.getStockByTicker(ticker);
  return jsonBackend.getStockByTicker(ticker);
};

export const getPicksLatestAsync = async () => {
  if (readFromDb() && isDbConfigured()) return sqlBackend.getPicksLatest();
  return jsonBackend.getPicksLatest();
};

export const getSectorMomentumAsync = async () => {
  if (readFromDb() && isDbConfigured()) return sqlBackend.getSectorMomentum();
  return jsonBackend.getSectorMomentum();
};

export const getLastRefreshAsync = async () => {
  if (readFromDb() && isDbConfigured()) return sqlBackend.getLastRefresh();
  return jsonBackend.getLastRefresh();
};

// Returns Map<bareTicker, {fair_value_inr, current_price_inr, upside_pct}>
// for the snapshot side of the canonical run. Used at /api/sws-picks
// response time so a pick card's FV can be overwritten with the snapshot's
// freshest value — closes the picks-vs-snapshots drift gap (the bug where
// the homepage Earnings card and the stock modal disagreed on STAR's Fair
// Value). SQL backend ignores the `tickers` arg and returns the whole
// canonical map (one query, memoised). JSON backend uses `tickers` to
// limit per-file deep-JSON reads to ~250 entries per response.
export const getSnapshotFvMap = async (tickers) => {
  if (readFromDb() && isDbConfigured()) return sqlBackend.getSnapshotFvMap(tickers);
  return jsonBackend.getSnapshotFvMap(tickers);
};
