// Postgres-backed DAL implementation (Phase 4+).
//
// Mirrors the public API of jsonBackend.js — return shapes are identical
// so consumers don't notice the swap. Connects to Neon via db/client.js;
// uses the HTTP driver for short-lived Vercel routes and pg.Pool for
// long-lived pipeline scripts (selected via SWS_DB_DRIVER=pool env var).
//
// Activation:
//   * Read switch: SWS_READ_FROM_DB=1 in services/swsDal/index.js.
//   * Dual-write:  SWS_DB_DUAL_WRITE=1 in pipeline scripts.
//
// All writes are gated by `isDbConfigured()` at the call site — if no
// DATABASE_URL is set, writes are no-ops and reads return null.

import NodeCache from "node-cache";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  not,
  or,
  sql,
} from "drizzle-orm";

import { getDb, isDbConfigured } from "../../db/client.js";
import {
  swsRuns,
  swsCompanies,
  swsCompanySnapshots,
  swsPicks,
  swsUniverseEntries,
  swsUniverseStats,
  swsSanityReports,
  swsScrapeFailures,
  swsShardProgress,
  swsControlFlags,
} from "../../db/schema.js";
import {
  snapshotRowToJson,
  deepJsonToColumns,
  pickRowToCard,
  pickCardToRow,
} from "./rowMapping.js";

// ── In-process cache ────────────────────────────────────────────────────
// Short TTLs because pipeline-finalise invalidates this explicitly via
// `invalidateAll()`; the TTL is just a safety net for missed invalidations.
const cache = new NodeCache({
  stdTTL: 300, // 5 min default
  checkperiod: 60,
  useClones: false,
});
const inflight = new Map(); // request-coalescing for hot reads

function memoize(key, ttlSec, loader) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await loader();
      cache.set(key, value, ttlSec);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function invalidateAll() {
  cache.flushAll();
  inflight.clear();
}

// ── Run lifecycle (Phase 3) ─────────────────────────────────────────────

export async function getCanonicalRunId() {
  if (!isDbConfigured()) return null;
  return memoize("canonical_run_id", 60, async () => {
    const db = await getDb();
    const rows = await db
      .select({ id: swsRuns.id })
      .from(swsRuns)
      .where(eq(swsRuns.isCanonical, true))
      .limit(1);
    return rows[0]?.id ?? null;
  });
}

export async function getPriorCanonicalRunId() {
  if (!isDbConfigured()) return null;
  return memoize("prior_canonical_run_id", 60, async () => {
    const db = await getDb();
    // The two most recent successful runs, ordered by finished_at desc.
    // The first is current canonical; the second is the "prior canonical".
    const rows = await db
      .select({ id: swsRuns.id, isCanonical: swsRuns.isCanonical })
      .from(swsRuns)
      .where(and(eq(swsRuns.status, "success"), isNotNull(swsRuns.finishedAt)))
      .orderBy(desc(swsRuns.finishedAt))
      .limit(2);
    // Return whichever of the top 2 is NOT canonical (= immediately prior).
    for (const r of rows) {
      if (!r.isCanonical) return r.id;
    }
    return null;
  });
}

export async function beginRun({ pipeline = "api", startedAt } = {}) {
  if (!isDbConfigured()) return null;
  const db = await getDb({ driver: "pool" });
  const rows = await db
    .insert(swsRuns)
    .values({
      pipeline,
      status: "running",
      startedAt: startedAt ? new Date(startedAt) : new Date(),
      isCanonical: false,
    })
    .returning({ id: swsRuns.id });
  invalidateAll();
  return rows[0]?.id ?? null;
}

export async function recordRunProgress(runId, fields = {}) {
  if (!isDbConfigured() || !runId) return;
  const db = await getDb({ driver: "pool" });
  await db.update(swsRuns).set(fields).where(eq(swsRuns.id, runId));
}

export async function finaliseRun(runId, fields = {}) {
  if (!isDbConfigured() || !runId) return;
  const db = await getDb({ driver: "pool" });
  // Two-statement transaction: clear prior canonical, set this run canonical.
  // node-postgres driver supports db.transaction().
  await db.transaction(async (tx) => {
    await tx
      .update(swsRuns)
      .set({ isCanonical: false })
      .where(and(eq(swsRuns.isCanonical, true), not(eq(swsRuns.id, runId))));
    await tx
      .update(swsRuns)
      .set({
        isCanonical: true,
        status: fields.status || "success",
        finishedAt: fields.finishedAt ? new Date(fields.finishedAt) : new Date(),
        durationSeconds: fields.durationSeconds ?? null,
        scoredCount: fields.scoredCount ?? null,
        shardsFailed: fields.shardsFailed ?? null,
        newsItemsTotal: fields.newsItemsTotal ?? null,
        deepFilesScanned: fields.deepFilesScanned ?? null,
        newsPopulatedCount: fields.newsPopulatedCount ?? null,
        scrapeSkipped: fields.scrapeSkipped ?? false,
        sectionsCount: fields.sectionsCount ?? null,
        perShardProgress: fields.perShardProgress ?? null,
      })
      .where(eq(swsRuns.id, runId));
  });
  invalidateAll();
}

// ── Companies + snapshots ───────────────────────────────────────────────

export async function upsertCompany(company) {
  if (!isDbConfigured() || !company?.ticker) return;
  const db = await getDb({ driver: "pool" });
  await db
    .insert(swsCompanies)
    .values({
      ticker: company.ticker,
      name: company.name ?? null,
      sector: company.sector ?? null,
      swsUrl: company.sws_url ?? null,
      swsCompanyId: company.company_id ?? null,
      indices: company.indices ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: swsCompanies.ticker,
      set: {
        name: company.name ?? null,
        sector: company.sector ?? null,
        swsUrl: company.sws_url ?? null,
        swsCompanyId: company.company_id ?? null,
        indices: company.indices ?? null,
        updatedAt: new Date(),
      },
    });
}

export async function upsertCompanySnapshot(runId, deep) {
  if (!isDbConfigured() || !runId || !deep?.ticker) return;
  const db = await getDb({ driver: "pool" });
  const cols = deepJsonToColumns(deep, { runId });
  await db
    .insert(swsCompanySnapshots)
    .values(cols)
    .onConflictDoUpdate({
      target: [swsCompanySnapshots.ticker, swsCompanySnapshots.runId],
      set: {
        ...cols,
        runId: undefined,
        ticker: undefined,
      },
    });
}

function normaliseTickerKey(ticker) {
  if (!ticker) return null;
  return String(ticker).trim().replace(/\.(NS|BO|BSE|NSE)$/i, "");
}

export async function getStockByTicker(ticker) {
  if (!isDbConfigured()) return null;
  const key = normaliseTickerKey(ticker);
  if (!key) return null;
  return memoize(`snap:${key}`, 300, async () => {
    const runId = await getCanonicalRunId();
    if (!runId) return null;
    const db = await getDb();
    const rows = await db
      .select()
      .from(swsCompanySnapshots)
      .where(
        and(eq(swsCompanySnapshots.runId, runId), eq(swsCompanySnapshots.ticker, key)),
      )
      .limit(1);
    return snapshotRowToJson(rows[0]);
  });
}

export async function getStocksByTickers(tickers) {
  if (!isDbConfigured() || !Array.isArray(tickers) || tickers.length === 0) return [];
  const runId = await getCanonicalRunId();
  if (!runId) return [];
  const keys = [...new Set(tickers.map(normaliseTickerKey).filter(Boolean))];
  const db = await getDb();
  const rows = await db
    .select()
    .from(swsCompanySnapshots)
    .where(
      and(
        eq(swsCompanySnapshots.runId, runId),
        inArray(swsCompanySnapshots.ticker, keys),
      ),
    );
  return rows.map(snapshotRowToJson);
}

export async function listDeepTickers() {
  if (!isDbConfigured()) return [];
  return memoize("deep_tickers", 300, async () => {
    const runId = await getCanonicalRunId();
    if (!runId) return [];
    const db = await getDb();
    const rows = await db
      .select({ ticker: swsCompanySnapshots.ticker })
      .from(swsCompanySnapshots)
      .where(eq(swsCompanySnapshots.runId, runId));
    return rows.map((r) => r.ticker);
  });
}

// ── Universe ────────────────────────────────────────────────────────────

export async function getScoredUniverse() {
  if (!isDbConfigured()) return null;
  return memoize("scored_universe", 300, async () => {
    const runId = await getCanonicalRunId();
    if (!runId) return null;
    const db = await getDb();
    // Pull the lean view: picks + universe-entry join via ticker, plus
    // snapshot's score/verdict. We embed the v3 fields from sws_picks
    // (when a ticker has a top section row) OR fall back to a synthetic
    // record derived from the snapshot. For the universe API the snapshot
    // is enough; picks-overlay can be added later.
    const rows = await db
      .select({
        ticker: swsCompanySnapshots.ticker,
        name: swsCompanySnapshots.name,
        sector: swsCompanySnapshots.sector,
        swsUrl: swsUniverseEntries.swsUrl,
        snowflakeTotal: swsCompanySnapshots.snowflakeTotal,
        currentPriceInr: swsCompanySnapshots.currentPriceInr,
        fairValueInr: swsCompanySnapshots.fairValueInr,
        upsidePct: swsCompanySnapshots.upsidePct,
        marketCapInr: swsCompanySnapshots.marketCapInr,
      })
      .from(swsCompanySnapshots)
      .leftJoin(
        swsUniverseEntries,
        and(
          eq(swsUniverseEntries.runId, swsCompanySnapshots.runId),
          eq(swsUniverseEntries.ticker, swsCompanySnapshots.ticker),
        ),
      )
      .where(eq(swsCompanySnapshots.runId, runId));

    const run = await db.select().from(swsRuns).where(eq(swsRuns.id, runId)).limit(1);
    return {
      generated_at: run[0]?.finishedAt
        ? new Date(run[0].finishedAt).toISOString()
        : null,
      scored_count: rows.length,
      stocks: rows.map((r) => ({
        ticker: r.ticker,
        name: r.name,
        sector: r.sector,
        sws_url: r.swsUrl,
        snowflake_total: r.snowflakeTotal,
        current_price_inr: r.currentPriceInr,
        fair_value_inr: r.fairValueInr,
        upside_pct: r.upsidePct,
        market_cap_inr: r.marketCapInr,
      })),
    };
  });
}

export async function getUniverseIndex() {
  const raw = await getScoredUniverse();
  if (!raw) return null;
  const byTicker = new Map();
  for (const s of raw.stocks || []) {
    if (s?.ticker) byTicker.set(String(s.ticker).toUpperCase(), s);
  }
  return byTicker;
}

export async function getUniverseIndexMtime() {
  if (!isDbConfigured()) return null;
  const lr = await getLastRefresh();
  if (!lr?.finished_at) return null;
  return new Date(lr.finished_at).getTime();
}

// ── Picks ───────────────────────────────────────────────────────────────

export async function getPicksLatest() {
  if (!isDbConfigured()) return null;
  return memoize("picks_latest", 300, async () => {
    const runId = await getCanonicalRunId();
    if (!runId) return null;
    const db = await getDb();
    const rows = await db
      .select()
      .from(swsPicks)
      .where(eq(swsPicks.runId, runId))
      .orderBy(asc(swsPicks.section), asc(swsPicks.rankInSection));

    const sections = {};
    for (const r of rows) {
      const card = pickRowToCard(r);
      (sections[r.section] ||= []).push(card);
    }
    const run = await db.select().from(swsRuns).where(eq(swsRuns.id, runId)).limit(1);
    const universeStats = await db
      .select({ universeSize: swsUniverseStats.universeSize })
      .from(swsUniverseStats)
      .where(eq(swsUniverseStats.runId, runId))
      .limit(1);

    return {
      schema_version: "picks-latest-v2",
      scoring_version: "sws-v3-100pt-2026-05",
      scanned_at: run[0]?.finishedAt ? new Date(run[0].finishedAt).toISOString() : null,
      universe_size: universeStats[0]?.universeSize ?? null,
      scored_count: run[0]?.scoredCount ?? rows.length,
      failed_count: run[0]?.shardsFailed ?? 0,
      sections,
    };
  });
}

export async function getPicksFromPriorCanonicalRun() {
  if (!isDbConfigured()) return null;
  const priorId = await getPriorCanonicalRunId();
  if (!priorId) return null;
  const db = await getDb();
  const rows = await db
    .select()
    .from(swsPicks)
    .where(eq(swsPicks.runId, priorId))
    .orderBy(asc(swsPicks.section), asc(swsPicks.rankInSection));

  const sections = {};
  for (const r of rows) {
    (sections[r.section] ||= []).push(pickRowToCard(r));
  }
  const run = await db.select().from(swsRuns).where(eq(swsRuns.id, priorId)).limit(1);
  return {
    scanned_at: run[0]?.finishedAt ? new Date(run[0].finishedAt).toISOString() : null,
    sections,
  };
}

export async function replacePicksForRun(runId, sectionsObject) {
  if (!isDbConfigured() || !runId || !sectionsObject) return;
  const db = await getDb({ driver: "pool" });
  const inserts = [];
  for (const [section, items] of Object.entries(sectionsObject)) {
    if (!Array.isArray(items)) continue;
    items.forEach((card, idx) => {
      if (!card?.ticker) return;
      inserts.push(pickCardToRow(card, { runId, section, rank: idx + 1 }));
    });
  }
  await db.transaction(async (tx) => {
    await tx.delete(swsPicks).where(eq(swsPicks.runId, runId));
    if (inserts.length) {
      // Batch in chunks to avoid Postgres parameter limit (~65k).
      const chunkSize = 500;
      for (let i = 0; i < inserts.length; i += chunkSize) {
        await tx.insert(swsPicks).values(inserts.slice(i, i + chunkSize));
      }
    }
  });
}

export async function applyNarrativeAcrossSections(runId, ticker, narrative) {
  if (!isDbConfigured() || !runId || !ticker) return;
  const db = await getDb({ driver: "pool" });
  await db
    .update(swsPicks)
    .set({ narrative, updatedAt: new Date() })
    .where(and(eq(swsPicks.runId, runId), eq(swsPicks.ticker, ticker)));
}

export async function stampSectionStatus(runId, ticker, section, statusObj) {
  if (!isDbConfigured() || !runId || !ticker || !section) return;
  const db = await getDb({ driver: "pool" });
  await db
    .update(swsPicks)
    .set({ sectionStatus: statusObj, updatedAt: new Date() })
    .where(
      and(
        eq(swsPicks.runId, runId),
        eq(swsPicks.ticker, ticker),
        eq(swsPicks.section, section),
      ),
    );
}

export async function updatePickEarningsBeat(runId, ticker, beat) {
  if (!isDbConfigured() || !runId || !ticker) return;
  const db = await getDb({ driver: "pool" });
  await db
    .update(swsPicks)
    .set({ lastQuarterResult: beat, updatedAt: new Date() })
    .where(
      and(
        eq(swsPicks.runId, runId),
        eq(swsPicks.ticker, ticker),
        eq(swsPicks.section, "upcoming_earnings"),
      ),
    );
}

// ── Universe stats ──────────────────────────────────────────────────────

export async function upsertUniverseStats(runId, stats) {
  if (!isDbConfigured() || !runId) return;
  const db = await getDb({ driver: "pool" });
  await db
    .insert(swsUniverseStats)
    .values({
      runId,
      generatedAt: stats?.generated_at ? new Date(stats.generated_at) : new Date(),
      universeSize: stats?.universe_size ?? null,
      r1m: stats?.r1m ?? null,
      r3m: stats?.r3m ?? null,
      r1y: stats?.r1y ?? null,
      counts: stats?.counts ?? null,
    })
    .onConflictDoUpdate({
      target: swsUniverseStats.runId,
      set: {
        generatedAt: stats?.generated_at ? new Date(stats.generated_at) : new Date(),
        universeSize: stats?.universe_size ?? null,
        r1m: stats?.r1m ?? null,
        r3m: stats?.r3m ?? null,
        r1y: stats?.r1y ?? null,
        counts: stats?.counts ?? null,
      },
    });
}

export async function getV3UniverseStats() {
  if (!isDbConfigured()) return null;
  return memoize("v3_universe_stats", 300, async () => {
    const runId = await getCanonicalRunId();
    if (!runId) return null;
    const db = await getDb();
    const rows = await db
      .select()
      .from(swsUniverseStats)
      .where(eq(swsUniverseStats.runId, runId))
      .limit(1);
    if (!rows[0]) return null;
    return {
      r1m: rows[0].r1m || [],
      r3m: rows[0].r3m || [],
      r1y: rows[0].r1y || [],
    };
  });
}

// ── Universe entries (per-run roster) ───────────────────────────────────

export async function upsertUniverseEntries(runId, entries) {
  if (!isDbConfigured() || !runId || !Array.isArray(entries)) return;
  const db = await getDb({ driver: "pool" });
  const rows = entries
    .filter((e) => e?.ticker)
    .map((e) => ({
      runId,
      ticker: e.ticker,
      universeIndex: e.index ?? null,
      name: e.name ?? null,
      sector: e.sector ?? null,
      industry: e.industry ?? null,
      exchange: e.exchange ?? null,
      swsShortId: e.sws_short_id ?? null,
      swsUrl: e.sws_url ?? null,
      slug: e.slug ?? null,
      indices: e.indices ?? null,
      seedOnly: e.seed_only ?? null,
      curated: e.curated ?? null,
      marketCapInr: e.market_cap_inr ?? null,
      source: e.source ?? null,
    }));
  if (!rows.length) return;
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    await db
      .insert(swsUniverseEntries)
      .values(rows.slice(i, i + chunkSize))
      .onConflictDoNothing();
  }
}

// ── Run metadata ────────────────────────────────────────────────────────

export async function getLastRefresh() {
  if (!isDbConfigured()) return null;
  return memoize("last_refresh", 60, async () => {
    const db = await getDb();
    const rows = await db
      .select()
      .from(swsRuns)
      .where(eq(swsRuns.isCanonical, true))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      finished_at: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
      pipeline: r.pipeline,
      duration_seconds: r.durationSeconds,
      shards_failed: r.shardsFailed,
      scrape_skipped: r.scrapeSkipped,
      scored_count: r.scoredCount,
      sections_count: r.sectionsCount,
      per_shard_progress: r.perShardProgress,
      news_populated_count: r.newsPopulatedCount,
      news_items_total: r.newsItemsTotal,
      deep_files_scanned: r.deepFilesScanned,
      pipeline_status: r.status,
    };
  });
}

// ── Sector momentum — THE perf win ──────────────────────────────────────
// Single SQL aggregate. Replaces the O(5,517) deep-file scan in
// services/earnings/signalAggregator.js::ensureSectorMomentum.

export async function getSectorMomentum() {
  if (!isDbConfigured()) return { map: new Map(), scanned: 0 };
  return memoize("sector_momentum", 300, async () => {
    const runId = await getCanonicalRunId();
    if (!runId) return { map: new Map(), scanned: 0 };
    const db = await getDb();
    const rows = await db
      .select({
        sector: swsCompanySnapshots.sector,
        avg1m: sql`avg(${swsCompanySnapshots.returns1mPct})`.as("avg1m"),
        sampleSize: sql`count(*)`.as("sample_size"),
      })
      .from(swsCompanySnapshots)
      .where(
        and(
          eq(swsCompanySnapshots.runId, runId),
          isNotNull(swsCompanySnapshots.sector),
          isNotNull(swsCompanySnapshots.returns1mPct),
        ),
      )
      .groupBy(swsCompanySnapshots.sector);

    const map = new Map();
    let scanned = 0;
    for (const r of rows) {
      scanned += Number(r.sampleSize);
      const n = Number(r.sampleSize);
      if (n < 3) continue;
      map.set(r.sector, {
        avg_1m_pct: Math.round(Number(r.avg1m) * 100) / 100,
        sample_size: n,
      });
    }
    return { map, scanned };
  });
}

// ── Sanity reports ──────────────────────────────────────────────────────

export async function recordSanityReport(runId, report) {
  if (!isDbConfigured() || !runId || !report) return;
  const db = await getDb({ driver: "pool" });
  await db
    .insert(swsSanityReports)
    .values({
      runId,
      verdict: report.verdict ?? null,
      blockCount: report.block_count ?? null,
      warnCount: report.warn_count ?? null,
      passCount: report.pass_count ?? null,
      totalChecks: report.total_checks ?? null,
      layers: report.layers ?? null,
    })
    .onConflictDoUpdate({
      target: swsSanityReports.runId,
      set: {
        verdict: report.verdict ?? null,
        blockCount: report.block_count ?? null,
        warnCount: report.warn_count ?? null,
        passCount: report.pass_count ?? null,
        totalChecks: report.total_checks ?? null,
        layers: report.layers ?? null,
      },
    });
}

export async function getLatestSanityReport() {
  if (!isDbConfigured()) return null;
  const runId = await getCanonicalRunId();
  if (!runId) return null;
  const db = await getDb();
  const rows = await db
    .select()
    .from(swsSanityReports)
    .where(eq(swsSanityReports.runId, runId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    run_id: r.runId,
    generated_at: r.generatedAt ? new Date(r.generatedAt).toISOString() : null,
    verdict: r.verdict,
    block_count: r.blockCount,
    warn_count: r.warnCount,
    pass_count: r.passCount,
    total_checks: r.totalChecks,
    layers: r.layers,
  };
}

// ── Scrape failures ─────────────────────────────────────────────────────

export async function recordScrapeFailure({ runId, ticker, failedTab, error }) {
  if (!isDbConfigured() || !ticker) return;
  const db = await getDb({ driver: "pool" });
  await db.insert(swsScrapeFailures).values({
    runId: runId ?? null,
    ticker,
    failedTab: failedTab ?? null,
    error: error ?? null,
  });
}

export async function listScrapeFailuresForTicker(ticker, { since } = {}) {
  if (!isDbConfigured() || !ticker) return [];
  const db = await getDb();
  const conds = [eq(swsScrapeFailures.ticker, ticker)];
  if (since) {
    conds.push(sql`${swsScrapeFailures.recordedAt} >= ${new Date(since)}`);
  }
  return db
    .select()
    .from(swsScrapeFailures)
    .where(and(...conds))
    .orderBy(desc(swsScrapeFailures.recordedAt));
}

// ── Shard progress ──────────────────────────────────────────────────────

export async function upsertShardProgress(shardId, fields) {
  if (!isDbConfigured() || !shardId) return;
  const db = await getDb({ driver: "pool" });
  await db
    .insert(swsShardProgress)
    .values({
      shardId,
      nextLocalIndex: fields.next_local_index ?? null,
      doneCount: fields.done_count ?? null,
      todayCount: fields.today_count ?? null,
      todayDate: fields.today_date ? new Date(fields.today_date) : null,
      startedAt: fields.started_at ? new Date(fields.started_at) : null,
      lastTicker: fields.last_ticker ?? null,
      lastRunAt: fields.last_run_at ? new Date(fields.last_run_at) : new Date(),
      lastDurationMs: fields.last_duration_ms ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: swsShardProgress.shardId,
      set: {
        nextLocalIndex: fields.next_local_index ?? null,
        doneCount: fields.done_count ?? null,
        todayCount: fields.today_count ?? null,
        todayDate: fields.today_date ? new Date(fields.today_date) : null,
        startedAt: fields.started_at ? new Date(fields.started_at) : null,
        lastTicker: fields.last_ticker ?? null,
        lastRunAt: fields.last_run_at ? new Date(fields.last_run_at) : new Date(),
        lastDurationMs: fields.last_duration_ms ?? null,
        updatedAt: new Date(),
      },
    });
}

function shardRowToJson(r) {
  if (!r) return null;
  return {
    shard_id: r.shardId,
    next_local_index: r.nextLocalIndex ?? 0,
    done_count: r.doneCount ?? 0,
    today_count: r.todayCount ?? 0,
    today_date: r.todayDate ? new Date(r.todayDate).toISOString().slice(0, 10) : null,
    started_at: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    last_ticker: r.lastTicker,
    last_run_at: r.lastRunAt ? new Date(r.lastRunAt).toISOString() : null,
    last_duration_ms: r.lastDurationMs,
  };
}

export async function getShardProgressApi(n) {
  if (!isDbConfigured()) return null;
  const db = await getDb();
  const rows = await db
    .select()
    .from(swsShardProgress)
    .where(eq(swsShardProgress.shardId, n))
    .limit(1);
  return shardRowToJson(rows[0]);
}

export async function getAllShardProgressApi() {
  if (!isDbConfigured()) return [1, 2, 3].map((id) => ({ id }));
  const db = await getDb();
  const rows = await db.select().from(swsShardProgress);
  const byId = new Map(rows.map((r) => [r.shardId, r]));
  return [1, 2, 3].map((n) => {
    const r = byId.get(n);
    if (!r) return { id: n };
    return {
      id: n,
      done_count: r.doneCount || 0,
      next_local_index: r.nextLocalIndex || 0,
      last_ticker: r.lastTicker || null,
      last_run_at: r.lastRunAt ? new Date(r.lastRunAt).toISOString() : null,
      today_count: r.todayCount || 0,
      today_date: r.todayDate ? new Date(r.todayDate).toISOString().slice(0, 10) : null,
    };
  });
}

// ── Control flags ───────────────────────────────────────────────────────

export async function setControlFlag(key, value, { ttlSec, holderId } = {}) {
  if (!isDbConfigured() || !key) return;
  const db = await getDb({ driver: "pool" });
  const expiresAt = ttlSec ? new Date(Date.now() + ttlSec * 1000) : null;
  await db
    .insert(swsControlFlags)
    .values({ key, value, holderId: holderId ?? null, expiresAt })
    .onConflictDoUpdate({
      target: swsControlFlags.key,
      set: { value, holderId: holderId ?? null, expiresAt, createdAt: new Date() },
    });
}

export async function getControlFlag(key) {
  if (!isDbConfigured() || !key) return null;
  const db = await getDb();
  const rows = await db
    .select()
    .from(swsControlFlags)
    .where(eq(swsControlFlags.key, key))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  if (r.expiresAt && new Date(r.expiresAt) < new Date()) return null;
  return {
    key: r.key,
    value: r.value,
    holder_id: r.holderId,
    created_at: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    expires_at: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
  };
}

export async function acquirePipelineLock({ holderId, ttlSec = 1800 }) {
  if (!isDbConfigured()) return { acquired: false, reason: "DATABASE_URL not set" };
  const db = await getDb({ driver: "pool" });
  // Conditional insert: succeed if no row exists OR existing row has
  // expired. ON CONFLICT WHERE clauses are tricky in Drizzle; we do this
  // as a transaction with a DELETE-of-expired + INSERT.
  return db.transaction(async (tx) => {
    await tx
      .delete(swsControlFlags)
      .where(
        and(
          eq(swsControlFlags.key, "pipeline_lock"),
          isNotNull(swsControlFlags.expiresAt),
          lte(swsControlFlags.expiresAt, new Date()),
        ),
      );
    try {
      await tx.insert(swsControlFlags).values({
        key: "pipeline_lock",
        value: { acquired_at: new Date().toISOString() },
        holderId,
        expiresAt: new Date(Date.now() + ttlSec * 1000),
      });
      return { acquired: true };
    } catch (err) {
      // Unique-key conflict — someone else holds the lock.
      return { acquired: false, reason: "held by another holder" };
    }
  });
}

export async function releasePipelineLock({ holderId }) {
  if (!isDbConfigured()) return;
  const db = await getDb({ driver: "pool" });
  await db
    .delete(swsControlFlags)
    .where(
      and(eq(swsControlFlags.key, "pipeline_lock"), eq(swsControlFlags.holderId, holderId)),
    );
}

// ── Path constants — kept for API symmetry with jsonBackend ─────────────
// Phase 4 readers don't hit disk, but a few legacy callers still reference
// these (e.g. server.js, scripts that haven't been converted yet).

export const DATA_DIR = null;
export const DEEP_DIR = null;
