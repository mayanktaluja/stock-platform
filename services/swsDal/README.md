# services/swsDal — SWS Data Access Layer

Single read/write gateway for the SWS data tier. Anchors the JSON → Postgres
migration documented in [`sws-json-indexed-stroustrup.md`](../../.claude/plans/sws-json-indexed-stroustrup.md).

```
services/swsDal/
├── index.js          ← public API; backend dispatch
├── jsonBackend.js    ← reads on-disk JSON (Phase 1+)
├── sqlBackend.js     ← Drizzle/Neon reads + writes (Phase 4+)
├── rowMapping.js     ← deep-file JSON ↔ DB column shape
├── cache.js          ← mtime-cache helper for the JSON backend
├── test-fixtures.js  ← fake backend builder for tests
└── README.md         ← this file
```

## Public API (selected — full surface is in `index.js`)

```js
// Reads (sync — backed by jsonBackend by default)
dal.getPicksLatest()              → { sections, last_refresh, … } | null
dal.getStockByTicker(ticker)      → deep JSON | null  (normalises .NS/.BO)
dal.getUniverseIndex()            → Map<TICKER, stock> | null
dal.getScoredUniverse()           → { generated_at, stocks } | null
dal.getLastRefresh()              → run metadata | null
dal.getSectorMomentum()           → { map, scanned }
dal.getV3UniverseStats()          → { r1m, r3m, r1y } | null
dal.listDeepTickers()             → string[]
dal.getAllShardProgressApi()      → [{id, …}, {id, …}, {id, …}]

// Writes (async — gated by SWS_DB_DUAL_WRITE + DATABASE_URL)
dal.beginRun({pipeline, startedAt}) → runId
dal.finaliseRun(runId, fields)       → flips is_canonical atomically
dal.upsertCompany(deep)
dal.upsertCompanySnapshot(runId, deep)
dal.replacePicksForRun(runId, sections)
dal.applyNarrativeAcrossSections(runId, ticker, narrative)
dal.stampSectionStatus(runId, ticker, section, statusObj)
dal.updatePickEarningsBeat(runId, ticker, beat)
dal.upsertUniverseStats(runId, stats)
dal.upsertUniverseEntries(runId, entries)
dal.recordSanityReport(runId, report)
dal.recordScrapeFailure({runId, ticker, failedTab, error})
dal.upsertShardProgress(shardId, fields)
dal.setControlFlag(key, value, {ttlSec, holderId})
dal.acquirePipelineLock({holderId, ttlSec})
dal.releasePipelineLock({holderId})

// Async-aware READ siblings (Phase 4 swaps the sync reads to these)
dal.getStockByTickerAsync(ticker)
dal.getPicksLatestAsync()
dal.getSectorMomentumAsync()
dal.getLastRefreshAsync()

// Cache + backend
dal.invalidateAll()       // called by sws-pipeline-finalise
dal.__setBackend(impl)    // test seam
```

## Environment flags

| Flag | Default | Effect |
|---|---|---|
| `DATABASE_URL` | unset | Pooled Neon URL — used by Vercel routes via HTTP driver. |
| `DATABASE_URL_UNPOOLED` | unset | Direct URL — used by long-lived pipeline scripts + migrations. |
| `SWS_DB_DUAL_WRITE` | `0` | When `1`, pipeline scripts mirror every write into Postgres. JSON files remain authoritative. |
| `SWS_READ_FROM_DB` | `0` | Phase 4 read-cutover flag. Routes async-aware reads through `sqlBackend` instead of JSON. |
| `SWS_DB_DRIVER` | `http` | Set to `pool` inside `sws-refresh-api.sh` to use `pg.Pool` for long-running pipeline scripts. |
| `SWS_RUN_ID` | unset | Set by `sws-pipeline-begin.mjs`; consumed by every pipeline child script for the DAL writes. |

## Activation roadmap

### Phase 0 — Provision Neon (one-time, manual)
1. Sign in to [console.neon.tech](https://console.neon.tech) and create a project.
   Region: `ap-southeast-1` (closest to Vercel `bom1`).
2. Copy the **pooled** and **direct** connection strings into `.env`:
   ```bash
   DATABASE_URL=postgres://USER:PASS@HOST.pooler.neon.tech/neondb?sslmode=require
   DATABASE_URL_UNPOOLED=postgres://USER:PASS@HOST.neon.tech/neondb?sslmode=require
   ```
3. Apply migrations:
   ```bash
   node db/migrate.mjs
   ```

### Phase 2 — Seed from JSON
Loads everything under `data/sws/` into a fresh canonical run.
```bash
node scripts/sws-seed-from-json.mjs
node scripts/sws-verify-db-vs-json.mjs --count 50
```
Verify exits 0 → DB is a faithful mirror.

### Phase 3 — Dual-write
Set `SWS_DB_DUAL_WRITE=1` in the env used by `scripts/sws-refresh-api.sh`. The pipeline now:
1. Opens a new `sws_runs` row at start, exports `SWS_RUN_ID` to child scripts.
2. Every JSON write also fires the corresponding DAL upsert.
3. After sanity passes, `sws-pipeline-finalise.mjs` flips `is_canonical` in a transaction.
4. `sws-verify-db-vs-json.mjs --run-id $SWS_RUN_ID --count 50` runs and warns on drift.

Run dual-write for at least one full pipeline cycle. Watch the verify step.

### Phase 4 — Read switch (warmup-then-sync, no consumer refactor)

The DAL keeps its sync read surface. When `SWS_READ_FROM_DB=1`, sync reads
serve from an in-memory cache (`services/swsDal/dbCache.js`) that's
populated by an async `dal.warmUp*()` call at server boot. Result: zero
ripple through the ~40 sync callers in `services/*.js` and `server.js`.

**Activation**:
1. Set `SWS_READ_FROM_DB=1` in the env (Vercel: Project Settings → Env Vars → Production).
2. Ensure `DATABASE_URL` is set (was wired in Phase 0). The DAL's `warmUpEssentials()` is already called inside `server.js`'s startup paths (both `app.listen` for local and the `if (process.env.VERCEL)` cold-start block).
3. Redeploy. First-request cold start hydrates the cache (~2s). Subsequent reads serve from memory.

**What's cached** (TTL = 5 min, periodic re-warm every 10 min on long-lived processes):
* `picks-latest`, `scored-universe`, `universe-index`, `v3-universe-stats`, `last-refresh`, `sector-momentum`
* Per-ticker `snapshots` — lazily filled via `dal.warmUpSnapshots(tickers)`; intended for portfolio routes that know the working set up-front.

**Fallback behaviour**: when the cache is empty (cold start, mid-refresh), sync reads fall through to the JSON backend. No 500s.

**The perf win in numbers**:
* `signalAggregator.ensureSectorMomentum`: 5,517-file scan (~880ms cold) → single SQL `GROUP BY sector` aggregate (~30ms).
* `/api/sws-picks`: served from in-memory cache in <20ms (vs ~100-200ms reading + post-processing the 2.2MB JSON).

### Phase 5 — Drop JSON commits
Only after ~1 week of stable Phase 4 in prod. Edit `scripts/sws-refresh-api.sh`:
* Remove the `git add data/sws/*.json data/sws/deep/` lines.
* Replace with:
  ```bash
  node scripts/sws-emit-summary.mjs
  pg_dump --data-only --table='sws_*' --table='nse_event_calendar' \
    --format=custom $DATABASE_URL_UNPOOLED \
    | gzip -9 > data/sws/snapshots/$(date -u +%Y-%m-%d).pg.dump.gz
  git add data/sws/snapshots/$(date -u +%Y-%m-%d).pg.dump.gz
  git add data/sws/snapshots/$(date -u +%Y-%m-%d).summary.json
  ```
* The local disk writes stay — `scripts/sws-news-scrape.mjs` (out of scope per the plan)
  still reads them. A follow-up PR converts news-scrape and then disk writes can be dropped.

### Phase 6 — Stragglers
The following standalone scripts read disk JSON directly and will continue to
work until the local disk writes are stopped (which awaits the news-scrape
follow-up):
* `scripts/sws-backfill-trade-log.mjs` — one-shot, already-run history replay
* `scripts/sws-build-delta.mjs` — universe-delta tooling
* `scripts/coverage-gap-analysis.mjs` — universe-coverage analysis
* `scripts/combined-shadow-summary.mjs` — combined-score shadow log
* `scripts/sws-shard-watchdog.mjs` — shard process management

Convert these alongside the news-scrape follow-up.

## Restore from snapshot

To inspect any committed snapshot in a scratch DB:
```bash
SCRATCH_DATABASE_URL=postgres://... \
  node scripts/sws-load-snapshot.mjs 2026-05-11
```
The script refuses to load into a URL that matches `DATABASE_URL` or contains `prod`.

## Emergency rollback

| Phase | Rollback |
|---|---|
| Dual-write (Phase 3) | `SWS_DB_DUAL_WRITE=0` — JSON writes continue as before. |
| Read switch (Phase 4) | `SWS_READ_FROM_DB=0` — reads fall back to disk. |
| Post-Phase 5 git revert | Revert the commit + restore the latest known-good `.pg.dump.gz` via `sws-load-snapshot.mjs` against `DATABASE_URL_UNPOOLED`. |

## Manually clearing the pipeline lock

If a refresh died with the lock held:
```sql
DELETE FROM sws_control_flags WHERE key = 'pipeline_lock';
```
or wait — the lock self-clears after 30 min via `expires_at`.

## Storage budget

Free-tier Neon = 0.5 GB. The current 2-canonical-runs-retained model produces:
* `sws_company_snapshots`: 2 × 5,517 rows × ~6 KB ≈ 66 MB
* `sws_universe_entries`: 2 × 5,517 × ~500 B ≈ 5 MB
* `sws_picks`: 2 × 628 × ~10 KB ≈ 13 MB
* Indexes + WAL + vacuum overhead: ~100-150 MB
* **Total: ~200-300 MB live** — fits with headroom.

Prune older runs nightly:
```sql
DELETE FROM sws_runs
WHERE is_canonical = false
  AND id NOT IN (
    SELECT id FROM sws_runs
    WHERE status = 'success'
    ORDER BY finished_at DESC NULLS LAST
    LIMIT 2
  );
```
(All foreign-keyed rows cascade-delete via `onDelete: cascade`.)
