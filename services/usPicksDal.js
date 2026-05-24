// JSON-file-backed DAL for the US picks pipeline (data/sws-us/).
//
// Mirrors the relevant readers of services/swsDal/jsonBackend.js but for the
// isolated US namespace, reusing the shared mtime-cache helpers. Read-only;
// the US batch scorer (scripts/sws-scoring-us.mjs) is the sole writer.
//
// Deep-file serving in prod: data/sws-us/deep/ is gitignored (≈5.4k files); the
// Vercel bundle ships only the packed deep-us.tar.gz. To avoid a full 5.4k-file
// extract blocking cold-start, deep files are extracted PER-TICKER on demand
// into /tmp (the leaderboard itself reads only picks-latest.json, so the tar is
// touched only when a modal opens).

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mtimeCached, mtimeCachedByKey } from "./swsDal/cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data", "sws-us");
const DEEP_DIR = path.join(DATA_DIR, "deep");
const DEEP_TARBALL = path.join(DATA_DIR, "deep-us.tar.gz");
const DEEP_EXTRACT_BASE = "/tmp/sws-us-deep";

const PICKS_LATEST_PATH = path.join(DATA_DIR, "picks-latest.json");
const SCORED_UNIVERSE_PATH = path.join(DATA_DIR, "sws-scored-universe.json");
const LAST_REFRESH_PATH = path.join(DATA_DIR, "last-refresh.json");
const V3_UNIVERSE_PATH = path.join(DATA_DIR, "v3-universe-stats.json");

export const US_PATHS = {
  dataDir: DATA_DIR,
  panicStop: path.join(DATA_DIR, "panic-stop.flag"),
  refreshRequested: path.join(DATA_DIR, "refresh-requested.json"),
};

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, "utf-8"));
}

const readPicks = mtimeCached(PICKS_LATEST_PATH, readJson);
const readScoredUniverse = mtimeCached(SCORED_UNIVERSE_PATH, readJson);
const readLastRefresh = mtimeCached(LAST_REFRESH_PATH, readJson);
const readV3 = mtimeCached(V3_UNIVERSE_PATH, readJson);

// US tickers are alphabetic + dotted share classes (BRK.B). Uppercase + trim;
// keep the dot. No .NS/.BO stripping — that's an India concern.
function normaliseTickerKey(ticker) {
  if (!ticker) return null;
  return String(ticker).trim().toUpperCase();
}

// Local/nightly: data/sws-us/deep is populated → use it directly. Prod: dir is
// empty → extract per-ticker from the tarball into /tmp on demand.
let _deepDirHasFiles = null;
function deepDirHasFiles() {
  if (_deepDirHasFiles !== null) return _deepDirHasFiles;
  try {
    _deepDirHasFiles = fs.readdirSync(DEEP_DIR).some((f) => f.endsWith(".json"));
  } catch {
    _deepDirHasFiles = false;
  }
  return _deepDirHasFiles;
}

const _extractedTickers = new Set();
function extractOneFromTarball(key) {
  if (!fs.existsSync(DEEP_TARBALL)) return null;
  const member = `deep/${key}.json`;
  const outPath = path.join(DEEP_EXTRACT_BASE, member);
  if (_extractedTickers.has(key) && fs.existsSync(outPath)) return outPath; // already extracted; no re-exec
  try {
    fs.mkdirSync(DEEP_EXTRACT_BASE, { recursive: true });
    execSync(`tar -xzf "${DEEP_TARBALL}" -C "${DEEP_EXTRACT_BASE}" "${member}"`, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    _extractedTickers.add(key);
    return fs.existsSync(outPath) ? outPath : null;
  } catch {
    return null;
  }
}

const readDeepByKey = mtimeCachedByKey((key) => {
  if (!key) return null;
  if (deepDirHasFiles()) return path.join(DEEP_DIR, `${key}.json`);
  return extractOneFromTarball(key);
}, readJson);

export function getUsPicksLatest() {
  return readPicks();
}

export function getUsScoredUniverse() {
  return readScoredUniverse();
}

export function getUsLastRefresh() {
  return readLastRefresh();
}

export function getUsV3UniverseStats() {
  const r = readV3();
  return r ? {
    r1m: r.r1m || [],
    r3m: r.r3m || [],
    r1y: r.r1y || [],
    fvBenchmark: r.fv_benchmark || r.fvBenchmark || null,
  } : null;
}

export function getUsStockByTicker(ticker) {
  const key = normaliseTickerKey(ticker);
  if (!key) return null;
  return readDeepByKey(key);
}

let _universeIndexCache = null; // { source, map }
export function getUsUniverseIndex() {
  const raw = readScoredUniverse();
  if (!raw) {
    _universeIndexCache = null;
    return null;
  }
  if (_universeIndexCache && _universeIndexCache.source === raw) return _universeIndexCache.map;
  const stocks = Array.isArray(raw) ? raw : raw.stocks || [];
  const byTicker = new Map();
  for (const s of stocks) {
    if (s && s.ticker) byTicker.set(String(s.ticker).toUpperCase(), s);
  }
  _universeIndexCache = { source: raw, map: byTicker };
  return byTicker;
}

function readProgressApi(n) {
  const fp = path.join(DATA_DIR, `progress-api-${n}.json`);
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return null;
  }
}

export function getUsShardProgressApi(n) {
  return readProgressApi(n);
}

export function getUsAllShardProgressApi() {
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
    };
  });
}
