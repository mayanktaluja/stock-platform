// Test fixture builder for the SWS DAL.
//
// Tests construct a fake backend with whatever subset of the API surface
// they need and inject it via dal.__setBackend(fake). Anything not
// overridden returns null / empty so the public API stays callable
// without crashing.
//
// Usage:
//
//   import * as dal from "../services/swsDal/index.js";
//   import { makeFakeBackend } from "../services/swsDal/test-fixtures.js";
//
//   beforeEach(() => dal.__setBackend(makeFakeBackend({
//     picksLatest: { sections: { top_ranked_30_v3: [...] } },
//     deepByTicker: { RELIANCE: { ticker: "RELIANCE", overview: {...} } },
//   })));
//   afterEach(() => dal.__setBackend(null));

export function makeFakeBackend(opts = {}) {
  const {
    picksLatest = null,
    scoredUniverse = null,
    universeIndex = null,
    lastRefresh = null,
    v3UniverseStats = null,
    deepByTicker = {},
    sectorMomentumMap = null,
    shardProgressApi = {},
    allShardProgressApi = null,
  } = opts;

  return {
    getPicksLatest: () => picksLatest,
    getScoredUniverse: () => scoredUniverse,
    getUniverseIndex: () => {
      if (universeIndex instanceof Map) return universeIndex;
      if (universeIndex && typeof universeIndex === "object") {
        return new Map(Object.entries(universeIndex));
      }
      if (scoredUniverse) {
        const stocks = Array.isArray(scoredUniverse)
          ? scoredUniverse
          : scoredUniverse.stocks || [];
        const m = new Map();
        for (const s of stocks) {
          if (s?.ticker) m.set(String(s.ticker).toUpperCase(), s);
        }
        return m;
      }
      return null;
    },
    getLastRefresh: () => lastRefresh,
    getUniverseIndexMtime: () => opts.universeIndexMtime ?? null,
    getV3UniverseStats: () => v3UniverseStats,
    getStockByTicker: (ticker) => {
      if (!ticker) return null;
      const key = String(ticker)
        .trim()
        .replace(/\.(NS|BO|BSE|NSE)$/i, "")
        .toUpperCase();
      const direct = deepByTicker[key] ?? deepByTicker[ticker];
      return direct ?? null;
    },
    listDeepTickers: () => Object.keys(deepByTicker),
    getShardProgressApi: (n) => shardProgressApi[n] ?? null,
    getAllShardProgressApi: () =>
      allShardProgressApi ??
      [1, 2, 3].map((n) => shardProgressApi[n] ?? { id: n }),
    getSectorMomentum: () => ({
      map: sectorMomentumMap instanceof Map ? sectorMomentumMap : new Map(),
      scanned: Object.keys(deepByTicker).length,
    }),
    getSnapshotFvMap: async (tickers) => {
      const map = new Map();
      if (!Array.isArray(tickers)) return map;
      for (const t of tickers) {
        if (!t) continue;
        const key = String(t).trim().replace(/\.(NS|BO|BSE|NSE)$/i, "").toUpperCase();
        const deep = deepByTicker[key] ?? deepByTicker[t];
        if (!deep) continue;
        const ov = deep.overview || {};
        map.set(key, {
          fair_value_inr: typeof ov.fair_value_inr === "number" ? ov.fair_value_inr : null,
          current_price_inr: typeof ov.current_price_inr === "number" ? ov.current_price_inr : null,
          upside_pct: typeof ov.upside_pct === "number" ? ov.upside_pct : null,
        });
      }
      return map;
    },
    invalidateAll: () => {},
    DATA_DIR: "/fake/data/sws",
    DEEP_DIR: "/fake/data/sws/deep",
  };
}
