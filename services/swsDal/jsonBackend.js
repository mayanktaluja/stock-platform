// JSON-file-backed DAL implementation — the only backend.
//
// All read methods point at the on-disk files under data/sws/ that the
// rest of the codebase reads directly: services/{swsHoldingEngine,
// combinedScore, swsPeerLayer, swsPortfolioAggregate}.js,
// services/earnings/signalAggregator.js, and the 5 SWS routes in server.js.
// The DAL preserves the exact return shapes those callers expect.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { mtimeCached, mtimeCachedByKey } from "./cache.js";
import { extractTarballWithNode } from "./deepTarball.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const DATA_DIR = path.join(REPO_ROOT, "data", "sws");
// DEEP_DIR is the initial "where I look for deep/ first" path. On Vercel
// cold-start the bundled deep/ tree isn't present (Vercel's 15k source-file
// cap rejects 5,517 individual JSONs); the function only ships the packed
// `deep.tar.gz`. ensureDeepExtracted() lazy-extracts that tarball into
// /tmp on first read and redirects subsequent lookups to the extract path.
export const DEEP_DIR = path.join(DATA_DIR, "deep");
const DEEP_TARBALL = path.join(DATA_DIR, "deep.tar.gz");
const DEEP_EXTRACT_BASE = "/tmp/sws-deep"; // Vercel /tmp is the only writable dir (~500 MB cap)

const PICKS_LATEST_PATH = path.join(DATA_DIR, "picks-latest.json");
const SCORED_UNIVERSE_PATH = path.join(DATA_DIR, "sws-scored-universe.json");
const LAST_REFRESH_PATH = path.join(DATA_DIR, "last-refresh.json");
const V3_UNIVERSE_PATH = path.join(DATA_DIR, "v3-universe-stats.json");
const V4_UNIVERSE_PATH = path.join(DATA_DIR, "v4-universe-stats.json");

let _runtimeDeepDir = DEEP_DIR;
let _deepExtracted = false;

// Resolve the runtime deep/ path. In local dev + nightly env the disk
// directory exists with 5,517 ticker JSONs — used as-is. On Vercel the
// directory is empty/missing; we extract the bundled tarball to /tmp once
// per container lifetime and serve from there.
function ensureDeepDir() {
  if (_deepExtracted) return _runtimeDeepDir;
  try {
    const entries = fs.readdirSync(DEEP_DIR);
    if (entries.some((f) => f.endsWith(".json"))) {
      _deepExtracted = true;
      return _runtimeDeepDir;
    }
  } catch {
    // dir missing — fall through to tarball extract
  }
  if (fs.existsSync(DEEP_TARBALL)) {
    try {
      // rm + mkdir is cheap and idempotent: handles a stale /tmp from a
      // recycled Vercel container where the previous deploy's extract lingered.
      fs.rmSync(DEEP_EXTRACT_BASE, { recursive: true, force: true });
      fs.mkdirSync(DEEP_EXTRACT_BASE, { recursive: true });
      execSync(`tar -xzf "${DEEP_TARBALL}" -C "${DEEP_EXTRACT_BASE}"`, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      _runtimeDeepDir = path.join(DEEP_EXTRACT_BASE, "deep");
      console.log(`[swsDal/jsonBackend] extracted deep tarball to ${_runtimeDeepDir}`);
    } catch (err) {
      try {
        if (extractTarballWithNode({ tarballPath: DEEP_TARBALL, extractBase: DEEP_EXTRACT_BASE })) {
          _runtimeDeepDir = path.join(DEEP_EXTRACT_BASE, "deep");
          console.log(`[swsDal/jsonBackend] extracted deep tarball with Node fallback to ${_runtimeDeepDir}`);
        } else {
          console.warn(`[swsDal/jsonBackend] tarball extract failed: ${err.message}`);
        }
      } catch (fallbackErr) {
        console.warn(`[swsDal/jsonBackend] tarball extract failed: ${err.message}; Node fallback failed: ${fallbackErr.message}`);
      }
    }
  }
  _deepExtracted = true;
  return _runtimeDeepDir;
}

function readJson(fp) {
  const raw = fs.readFileSync(fp, "utf-8");
  return JSON.parse(raw);
}

// ── File-backed readers (mtime-cached) ──

const readPicks = mtimeCached(PICKS_LATEST_PATH, readJson);
const readScoredUniverseRaw = mtimeCached(SCORED_UNIVERSE_PATH, readJson);
const readLastRefresh = mtimeCached(LAST_REFRESH_PATH, readJson);
const readV3UniverseRaw = mtimeCached(V3_UNIVERSE_PATH, readJson);
const readV4UniverseRaw = mtimeCached(V4_UNIVERSE_PATH, readJson);

const readDeepByKey = mtimeCachedByKey(
  (key) => (key ? path.join(ensureDeepDir(), `${key}.json`) : null),
  readJson,
);

// Tickers in SWS deep files use the bare NSE symbol (RELIANCE), but
// portfolioParser surfaces them with Yahoo-style suffixes (RELIANCE.NS,
// some ETFs as .BO). Strip those before file lookup. Ampersand symbols
// (ARE&M.json) are preserved as-is.
function normaliseTickerKey(ticker) {
  if (!ticker) return null;
  return String(ticker).trim().replace(/\.(NS|BO|BSE|NSE)$/i, "");
}

// ── Public read API (matches index.js exports) ──

export function getPicksLatest() {
  return readPicks();
}

export function getScoredUniverse() {
  return readScoredUniverseRaw();
}

// Bulk index keyed by upper-case ticker. Wraps getScoredUniverse() into a
// Map for O(1) lookups; cached against the underlying file's mtime via the
// reader, so a daily refresh propagates automatically without restart.
let _universeIndexCache = null; // { mtimeStamp, map }
export function getUniverseIndex() {
  const raw = readScoredUniverseRaw();
  if (!raw) {
    _universeIndexCache = null;
    return null;
  }
  // The raw reader is mtime-cached, so identity-comparison on the returned
  // object detects underlying file refreshes.
  if (_universeIndexCache && _universeIndexCache.source === raw) {
    return _universeIndexCache.map;
  }
  const stocks = Array.isArray(raw) ? raw : raw.stocks || [];
  const byTicker = new Map();
  for (const s of stocks) {
    if (!s || !s.ticker) continue;
    byTicker.set(String(s.ticker).toUpperCase(), s);
  }
  _universeIndexCache = { source: raw, map: byTicker };
  return byTicker;
}

export function getLastRefresh() {
  return readLastRefresh();
}

// Surface the underlying file's mtime as epoch-ms — combinedScore.lookupSwsScore
// returns this to callers as a data-freshness indicator. In Phase 4 this maps to
// Date.parse(canonical_run.finished_at) on the sws_runs row.
export function getUniverseIndexMtime() {
  try {
    return fs.statSync(SCORED_UNIVERSE_PATH).mtimeMs;
  } catch {
    return null;
  }
}

export function getStockByTicker(ticker) {
  const key = normaliseTickerKey(ticker);
  if (!key) return null;
  return readDeepByKey(key);
}

export function listDeepTickers() {
  try {
    return fs
      .readdirSync(ensureDeepDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

// Returns Map<bareTicker, {fair_value_inr, current_price_inr, upside_pct}>
// from the deep/<T>.json overview block for each requested ticker. Used
// at /api/sws-picks response time as the read-time picks/snapshot FV
// drift guard. We read only the requested tickers (not all ~5,500 deep
// files) so cold-call cost stays bounded by the picks-response
// cardinality (~250 tickers across 11
// sections). readDeepByKey is mtime-cached so repeat polls are free.
export async function getSnapshotFvMap(tickers) {
  const map = new Map();
  if (!Array.isArray(tickers) || tickers.length === 0) return map;
  const seen = new Set();
  for (const t of tickers) {
    const key = normaliseTickerKey(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let deep;
    try {
      deep = readDeepByKey(key);
    } catch {
      continue;
    }
    const ov = (deep && deep.overview) || {};
    map.set(key, {
      fair_value_inr: typeof ov.fair_value_inr === "number" ? ov.fair_value_inr : null,
      current_price_inr: typeof ov.current_price_inr === "number" ? ov.current_price_inr : null,
      upside_pct: typeof ov.upside_pct === "number" ? ov.upside_pct : null,
    });
  }
  return map;
}

export function getV3UniverseStats() {
  const raw = readV3UniverseRaw();
  if (!raw) return null;
  return {
    r1m: raw.r1m || [],
    r3m: raw.r3m || [],
    r1y: raw.r1y || [],
    fvBenchmark: raw.fv_benchmark || raw.fvBenchmark || null,
    fvCompositeIndustryAverages: raw.fv_composite_industry_averages || raw.fvCompositeIndustryAverages || null,
  };
}

// V4 rank-based verdict band cutoffs, persisted by the scorer to a dedicated
// file (kept out of v3-universe-stats.json so the metadata-only v3 rebuild
// can't wipe them). Returns null when V4 hasn't been scored yet.
export function getV4VerdictBands() {
  const raw = readV4UniverseRaw();
  return raw?.verdict_bands || null;
}

// Shard progress files live under data/sws/progress-api-{1,2,3}.json.
// Each refresh writes them per-tick; the API surfaces them on /api/sws-picks
// and /api/sws-scan/status. Phase 4 moves these to sws_shard_progress rows
// upserted every 50 ticks. Phase 1 keeps the per-call disk read — these
// endpoints are rarely hit and the files are tiny.
function readProgressApi(n) {
  const fp = path.join(DATA_DIR, `progress-api-${n}.json`);
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return null;
  }
}

export function getShardProgressApi(n) {
  return readProgressApi(n);
}

export function getAllShardProgressApi() {
  return [1, 2, 3].map((n) => {
    const p = readProgressApi(n);
    if (!p) return { id: n };
    return {
      id: n,
      done_count: p.done_count || 0,
      next_local_index: p.next_local_index || 0,
      last_ticker: p.last_ticker || null,
      last_run_at: p.last_run_at || null,
      today_count: p.today_count || 0,
      today_date: p.today_date || null,
    };
  });
}

// Sector momentum — scans every deep file and groups 1M returns by sector.
// O(5,517) per cold call; cached by the caller's context object today
// (signalAggregator passes ctx._sectorMomentumMap around). Phase 4 swaps
// this to a single `SELECT sector, avg(returns_1m_pct) ... GROUP BY sector`
// — the single biggest perf win in the migration.
export function getSectorMomentum() {
  const dir = ensureDeepDir();
  if (!fs.existsSync(dir)) return { map: new Map(), scanned: 0 };
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { map: new Map(), scanned: 0 };
  }
  const acc = new Map();
  let scanned = 0;
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    let stock;
    try {
      stock = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
    } catch {
      continue;
    }
    scanned += 1;
    const sector = stock?.sector;
    const ret1m = stock?.overview?.returns_pct?.["1M"];
    if (!sector || typeof ret1m !== "number" || !Number.isFinite(ret1m)) continue;
    const e = acc.get(sector) || { sum: 0, n: 0 };
    e.sum += ret1m;
    e.n += 1;
    acc.set(sector, e);
  }
  const out = new Map();
  for (const [sector, { sum, n }] of acc.entries()) {
    if (n < 3) continue; // signalAggregator's minimum-sample threshold
    out.set(sector, {
      avg_1m_pct: Math.round((sum / n) * 100) / 100,
      sample_size: n,
    });
  }
  return { map: out, scanned };
}

// Cache invalidation — called by Phase 3+ pipeline-finalise.mjs when a new
// canonical run is committed. In Phase 1 the mtime-cache invalidates
// automatically on file rewrites; this is a no-op safety hatch.
export function invalidateAll() {
  _universeIndexCache = null;
}
