// services/swsDal — the single Data Access Layer for the SWS data tier.
//
// Reads are sync and served from on-disk JSON via jsonBackend. Writes are
// async no-op stubs that preserve their prior call signatures and return
// shapes; pipeline scripts keep calling them so they stay one-codepath.
//
// History: this DAL anchored a JSON → Postgres migration that targeted
// Neon. The migration was decommissioned on 2026-05-19 (see
// ~/.claude/plans/create-a-plan-to-precious-dongarra.md). The
// `__setBackend()` test seam is preserved so a future migration can swap
// the backend wholesale.

import * as jsonBackend from "./jsonBackend.js";

let _backend = jsonBackend;

export function __setBackend(impl) {
  _backend = impl ?? jsonBackend;
}

export function __getBackend() {
  return _backend;
}

// ── Read-side flags ─────────────────────────────────────────────────────
// Kept for caller compatibility. Both always return false post-decommission.

export function isReadingFromDb() {
  return false;
}

export function isDualWriteEnabled() {
  return false;
}

// ── Reads (sync) ────────────────────────────────────────────────────────

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

export function getSectorMomentum() {
  return _backend.getSectorMomentum();
}

export function invalidateAll() {
  if (typeof _backend.invalidateAll === "function") _backend.invalidateAll();
}

// ── Warmup (async) — no-op shims kept for callers that still await them. ──

export async function warmUp() {
  return;
}

export async function warmUpEssentials() {
  return;
}

export async function warmUpSnapshots() {
  return;
}

// Path constants — used by a few callers that still need raw paths.
export const DATA_DIR = jsonBackend.DATA_DIR;
export const DEEP_DIR = jsonBackend.DEEP_DIR;

// ────────────────────────────────────────────────────────────────────────
// Writes — async no-op stubs. Pipeline scripts keep calling these so they
// stay backend-agnostic; the JSON files are written directly by the
// pipeline scripts themselves, not through this layer.
// ────────────────────────────────────────────────────────────────────────

export async function beginRun() {
  return null;
}

export async function recordRunProgress() {
  return null;
}

export async function finaliseRun() {
  return null;
}

export async function getCanonicalRunId() {
  return null;
}

export async function getPriorCanonicalRunId() {
  return null;
}

export async function upsertCompany() {
  return null;
}

export async function upsertCompanySnapshot() {
  return null;
}

export async function replacePicksForRun() {
  return null;
}

export async function applyNarrativeAcrossSections() {
  return null;
}

export async function stampSectionStatus() {
  return null;
}

export async function updatePickEarningsBeat() {
  return null;
}

export async function upsertUniverseEntries() {
  return null;
}

export async function upsertUniverseStats() {
  return null;
}

export async function recordSanityReport() {
  return null;
}

export async function recordScrapeFailure() {
  return null;
}

export async function listScrapeFailuresForTicker() {
  return [];
}

export async function upsertShardProgress() {
  return null;
}

export async function getShardProgressApiAsync(n) {
  return _backend.getShardProgressApi(n);
}

export async function setControlFlag() {
  return null;
}

export async function getControlFlag() {
  return null;
}

export async function acquirePipelineLock() {
  return { acquired: false, reason: "DAL is JSON-only; use the file-based lock at data/sws/pipeline.lock" };
}

export async function releasePipelineLock() {
  return null;
}

// ── Async-aware read siblings ───────────────────────────────────────────

export async function getStockByTickerAsync(ticker) {
  return jsonBackend.getStockByTicker(ticker);
}

export async function getPicksLatestAsync() {
  return jsonBackend.getPicksLatest();
}

export async function getSectorMomentumAsync() {
  return jsonBackend.getSectorMomentum();
}

export async function getLastRefreshAsync() {
  return jsonBackend.getLastRefresh();
}

// Returns Map<bareTicker, {fair_value_inr, current_price_inr, upside_pct}>
// from the on-disk deep files for the requested tickers. Used at
// /api/sws-picks response time to overwrite each pick card's FV with the
// snapshot's freshest value (closes the picks-vs-snapshots drift gap).
export async function getSnapshotFvMap(tickers) {
  return jsonBackend.getSnapshotFvMap(tickers);
}
