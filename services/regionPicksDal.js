// JSON-file-backed DAL factory for the region picks pipelines (data/sws-<code>/).
//
// makeRegionPicksDal(code) is the generalization of services/usPicksDal.js: it
// returns the same read API bound to a region's isolated namespace (data/sws-kr,
// data/sws-tw, …), reusing the shared mtime-cache helpers. Read-only; the region
// batch scorer (scripts/sws-scoring-region.mjs) is the sole writer.
//
// Deep-file serving in prod: data/sws-<code>/deep/ is gitignored (thousands of
// files); the Vercel bundle ships only the packed deep-<code>.tar.gz. To avoid a
// full extract blocking cold-start, deep files are extracted PER-TICKER on demand
// into /tmp/sws-<code>-deep (the leaderboard reads only picks-latest.json, so the
// tar is touched only when a modal opens). Dotted keys (005930.KS / 2330.TW) are
// preserved verbatim — the tarball member + filename carry the dot.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mtimeCached, mtimeCachedByKey } from "./swsDal/cache.js";
import { getRegion } from "../scripts/sws-regions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export function makeRegionPicksDal(code) {
  const region = getRegion(code);
  const DATA_DIR = path.join(REPO_ROOT, region.dataDir);
  const DEEP_DIR = path.join(DATA_DIR, "deep");
  const DEEP_TARBALL = path.join(DATA_DIR, `deep-${code}.tar.gz`);
  const DEEP_EXTRACT_BASE = `/tmp/sws-${code}-deep`;

  const PICKS_LATEST_PATH = path.join(DATA_DIR, "picks-latest.json");
  const SCORED_UNIVERSE_PATH = path.join(DATA_DIR, "sws-scored-universe.json");
  const LAST_REFRESH_PATH = path.join(DATA_DIR, "last-refresh.json");
  const V3_UNIVERSE_PATH = path.join(DATA_DIR, "v3-universe-stats.json");

  const readJson = (fp) => JSON.parse(fs.readFileSync(fp, "utf-8"));

  const readPicks = mtimeCached(PICKS_LATEST_PATH, readJson);
  const readScoredUniverse = mtimeCached(SCORED_UNIVERSE_PATH, readJson);
  const readLastRefresh = mtimeCached(LAST_REFRESH_PATH, readJson);
  const readV3 = mtimeCached(V3_UNIVERSE_PATH, readJson);

  // KR/TW canonical keys are uppercase + dotted (005930.KS / 2330.TW). Uppercase
  // + trim, keep the dot — no .NS/.BO/.KS stripping (the key IS the suffix).
  const normaliseTickerKey = (ticker) => (ticker ? String(ticker).trim().toUpperCase() : null);

  // Local/nightly: deep/ is populated → use it. Prod: dir empty → extract
  // per-ticker from the tarball into /tmp on demand.
  let _deepDirHasFiles = null;
  const deepDirHasFiles = () => {
    if (_deepDirHasFiles !== null) return _deepDirHasFiles;
    try {
      _deepDirHasFiles = fs.readdirSync(DEEP_DIR).some((f) => f.endsWith(".json"));
    } catch {
      _deepDirHasFiles = false;
    }
    return _deepDirHasFiles;
  };

  const _extractedTickers = new Set();
  const extractOneFromTarball = (key) => {
    if (!fs.existsSync(DEEP_TARBALL)) return null;
    const member = `deep/${key}.json`;
    const outPath = path.join(DEEP_EXTRACT_BASE, member);
    if (_extractedTickers.has(key) && fs.existsSync(outPath)) return outPath;
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
  };

  const readDeepByKey = mtimeCachedByKey((key) => {
    if (!key) return null;
    if (deepDirHasFiles()) return path.join(DEEP_DIR, `${key}.json`);
    return extractOneFromTarball(key);
  }, readJson);

  const readProgressApi = (n) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `progress-api-${n}.json`), "utf-8"));
    } catch {
      return null;
    }
  };

  let _universeIndexCache = null;
  const getUniverseIndex = () => {
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
  };

  return {
    code,
    currencyIso: region.currencyIso,
    label: region.label,
    PATHS: {
      dataDir: DATA_DIR,
      panicStop: path.join(DATA_DIR, "panic-stop.flag"),
      refreshRequested: path.join(DATA_DIR, "refresh-requested.json"),
    },
    getPicksLatest: () => readPicks(),
    getScoredUniverse: () => readScoredUniverse(),
    getLastRefresh: () => readLastRefresh(),
    getV3UniverseStats: () => {
      const r = readV3();
      return r ? { r1m: r.r1m || [], r3m: r.r3m || [], r1y: r.r1y || [] } : null;
    },
    getStockByTicker: (ticker) => {
      const key = normaliseTickerKey(ticker);
      return key ? readDeepByKey(key) : null;
    },
    getUniverseIndex,
    getShardProgressApi: (n) => readProgressApi(n),
    getAllShardProgressApi: () =>
      [1, 2, 3].map((n) => {
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
      }),
  };
}
