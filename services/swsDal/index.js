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
// These remain sync even after Phase 4 activation. The SQL backend
// provides async siblings (see exports at the bottom of this file)
// which Phase 4 will route here once consumers are updated to await.

export function getStockByTicker(ticker) {
  return _backend.getStockByTicker(ticker);
}

export function listDeepTickers() {
  return _backend.listDeepTickers();
}

export function getScoredUniverse() {
  return _backend.getScoredUniverse();
}

export function getUniverseIndex() {
  return _backend.getUniverseIndex();
}

export function getUniverseIndexMtime() {
  return _backend.getUniverseIndexMtime?.() ?? null;
}

export function getV3UniverseStats() {
  return _backend.getV3UniverseStats();
}

export function getPicksLatest() {
  return _backend.getPicksLatest();
}

export function getLastRefresh() {
  return _backend.getLastRefresh();
}

export function getShardProgressApi(n) {
  return _backend.getShardProgressApi(n);
}

export function getAllShardProgressApi() {
  return _backend.getAllShardProgressApi();
}

// Returns { map: Map<sector, { avg_1m_pct, sample_size }>, scanned: number }.
// Phase 4 SQL backend replaces the O(5,517) deep-file scan with one SQL
// aggregate. See sqlBackend.getSectorMomentum.
export function getSectorMomentum() {
  return _backend.getSectorMomentum();
}

export function invalidateAll() {
  if (typeof _backend.invalidateAll === "function") _backend.invalidateAll();
  if (isDbConfigured()) {
    sqlBackend.invalidateAll();
  }
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
