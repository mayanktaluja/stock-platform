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
import { fileURLToPath } from "node:url";
import { mtimeCached, mtimeCachedByKey } from "./swsDal/cache.js";
import { makeDeepFileResolver } from "./swsDal/deepTarball.js";
import {
  MARKET_FUNDAMENTALS_FILE,
  createMarketFundamentalsFallbackReader,
} from "./swsMarketFundamentals.js";
import { getRegion } from "../scripts/sws-regions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SWS_REPO_ROOT_OVERRIDE
  ? path.resolve(process.cwd(), process.env.SWS_REPO_ROOT_OVERRIDE)
  : path.resolve(__dirname, "..");

export function makeRegionPicksDal(code) {
  const region = getRegion(code);
  const DATA_DIR = path.join(REPO_ROOT, region.dataDir);
  const DEEP_DIR = path.join(DATA_DIR, "deep");
  const DEEP_TARBALL = path.join(DATA_DIR, `deep-${code}.tar.gz`);
  const DEEP_EXTRACT_BASE = `/tmp/sws-${code}-deep`;

  const PICKS_LATEST_PATH = path.join(DATA_DIR, "picks-latest.json");
  const SCORED_UNIVERSE_PATH = path.join(DATA_DIR, "sws-scored-universe.json");
  const LAST_REFRESH_PATH = path.join(DATA_DIR, "last-refresh.json");
  const V4_UNIVERSE_PATH = path.join(DATA_DIR, "v4-universe-stats.json");
  const V3_UNIVERSE_PATH = path.join(DATA_DIR, "v3-universe-stats.json");
  const FUNDAMENTALS_LATEST_PATH = path.join(DATA_DIR, MARKET_FUNDAMENTALS_FILE);

  const readJson = (fp) => JSON.parse(fs.readFileSync(fp, "utf-8"));

  const readPicks = mtimeCached(PICKS_LATEST_PATH, readJson);
  const readScoredUniverse = mtimeCached(SCORED_UNIVERSE_PATH, readJson);
  const readLastRefresh = mtimeCached(LAST_REFRESH_PATH, readJson);
  const readV4 = mtimeCached(V4_UNIVERSE_PATH, readJson);
  const readV3 = mtimeCached(V3_UNIVERSE_PATH, readJson);
  const readFundamentalsFallback = createMarketFundamentalsFallbackReader(FUNDAMENTALS_LATEST_PATH);

  // KR/TW canonical keys are dotted and case-preserving. Most are uppercase
  // numeric keys (005930.KS / 2330.TW), but SWS also emits exchange ids with
  // lower-case letters (q500036.KS, 01001t.TW). Preserve the canonical case for
  // deep-file lookup, and resolve user/input variants case-insensitively.
  const normaliseTickerKey = (ticker) => (ticker ? String(ticker).trim() : null);

  // Local/nightly: deep/ is populated. Prod: the Vercel bundle ships
  // deep-<code>.tar.gz, extracted per-ticker into /tmp. When both exist, prefer
  // the newer tarball so stale loose files cannot hide fresher packed briefs.
  const resolveDeepFile = makeDeepFileResolver({
    deepDir: DEEP_DIR,
    tarballPath: DEEP_TARBALL,
    extractBase: DEEP_EXTRACT_BASE,
  });

  const readDeepByKey = mtimeCachedByKey(resolveDeepFile, readJson);

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

  const resolveCanonicalTicker = (ticker) => {
    const key = normaliseTickerKey(ticker);
    if (!key) return null;
    const idx = getUniverseIndex();
    const card = idx ? idx.get(String(key).toUpperCase()) : null;
    return card?.ticker ? String(card.ticker) : key;
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
    getV4UniverseStats: () => {
      const r = readV4() || readV3();
      return r ? {
        r1m: r.r1m || [],
        r3m: r.r3m || [],
        r1y: r.r1y || [],
        fvBenchmark: r.fv_benchmark || r.fvBenchmark || null,
        fvCompositeIndustryAverages: r.fv_composite_industry_averages || r.fvCompositeIndustryAverages || null,
      } : null;
    },
    getV3UniverseStats: () => {
      const r = readV4() || readV3();
      return r ? {
        r1m: r.r1m || [],
        r3m: r.r3m || [],
        r1y: r.r1y || [],
        fvBenchmark: r.fv_benchmark || r.fvBenchmark || null,
        fvCompositeIndustryAverages: r.fv_composite_industry_averages || r.fvCompositeIndustryAverages || null,
      } : null;
    },
    getStockByTicker: (ticker) => {
      const key = resolveCanonicalTicker(ticker);
      return key ? readDeepByKey(key) : null;
    },
    getFundamentalsFallback: (ticker) => {
      const key = normaliseTickerKey(ticker);
      return key ? readFundamentalsFallback(key) : null;
    },
    getUniverseIndex,
    resolveCanonicalTicker,
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
