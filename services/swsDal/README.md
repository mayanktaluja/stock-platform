# services/swsDal — SWS Data Access Layer

Single read gateway for the SWS data tier. Reads on-disk JSON under
`data/sws/` via the `jsonBackend` and serves the SWS routes in `server.js`
plus the per-stock / sector / earnings consumers.

This DAL previously anchored a JSON → Postgres migration to Neon
(`sqlBackend.js` + `dbCache.js` + `db/`). The Neon migration was abandoned
on 2026-05-19; see [decommission plan](../../../../.claude/plans/create-a-plan-to-precious-dongarra.md).
JSON-on-disk is the only backend.

```
services/swsDal/
├── index.js          ← public API; thin re-export over jsonBackend
├── jsonBackend.js    ← reads on-disk JSON under data/sws/
├── cache.js          ← mtime-keyed cache helper
├── test-fixtures.js  ← fake backend builder for tests
└── README.md         ← this file
```

## Public API

```js
// Reads (sync — backed by jsonBackend)
dal.getPicksLatest()              → { sections, last_refresh, … } | null
dal.getStockByTicker(ticker)      → deep JSON | null  (normalises .NS/.BO)
dal.getUniverseIndex()            → Map<TICKER, stock> | null
dal.getScoredUniverse()           → { generated_at, stocks } | null
dal.getLastRefresh()              → run metadata | null
dal.getSectorMomentum()           → { map, scanned }
dal.getV3UniverseStats()          → { r1m, r3m, r1y } | null
dal.listDeepTickers()             → string[]
dal.getAllShardProgressApi()      → [{id, …}, {id, …}, {id, …}]
dal.invalidateAll()               → clears the mtime cache

// Async-aware read siblings
dal.getStockByTickerAsync(ticker)
dal.getPicksLatestAsync()
dal.getSectorMomentumAsync()
dal.getLastRefreshAsync()
dal.getSnapshotFvMap(tickers)     → Map<bareTicker, {fair_value_inr, current_price_inr, upside_pct}>

// Writes — async no-op stubs. Pipeline scripts may still call these; they
// return null/[]/false so callers stay backend-agnostic. The JSON files
// are written directly by the pipeline scripts (sws-scoring, sws-narrate-picks,
// sws-stamp-section-status, sws-api-parser) — not through this layer.
dal.beginRun(), dal.finaliseRun(), dal.upsertCompany(),
dal.upsertCompanySnapshot(), dal.replacePicksForRun(),
dal.applyNarrativeAcrossSections(), dal.stampSectionStatus(),
dal.updatePickEarningsBeat(), dal.upsertUniverseEntries(),
dal.upsertUniverseStats(), dal.recordSanityReport(),
dal.recordScrapeFailure(), dal.upsertShardProgress(),
dal.setControlFlag(), dal.releasePipelineLock()

// Read-side flag helpers — kept for caller compatibility; both return false.
dal.isReadingFromDb()             → false
dal.isDualWriteEnabled()          → false

// Test seam
dal.__setBackend(impl)            → swap the backend wholesale (used by
                                    test/swsDal.test.mjs + test-fixtures.js)
```

## Pipeline lock

The actual mutex used by the refresh pipeline is the **file-based** lock at
`data/sws/pipeline.lock`, claimed/released by
[scripts/sws-deep-scrape.mjs:293](../../scripts/sws-deep-scrape.mjs:293)
and inspected by [scripts/sws-status.sh:53](../../scripts/sws-status.sh:53).

`dal.acquirePipelineLock()` is a no-op stub returning
`{ acquired: false, reason: "…" }` for backward compatibility; it has zero
production callers.

## Why the DAL pattern stays

Even though there's only one backend now, the dispatcher + `__setBackend`
seam are preserved so a future migration can swap the backend wholesale
without touching the ~40 sync callers across `services/`, `server.js`,
and `scripts/`. The pattern carries ~50 LOC of overhead and keeps the
read surface a single grep target.
