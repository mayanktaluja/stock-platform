#!/usr/bin/env node
/**
 * One-shot seed: load everything under data/sws/ into Postgres as a
 * single canonical sws_runs row. Idempotent — re-running produces the
 * same DB state (won't create duplicate runs unless --new-run is passed).
 *
 * Usage:
 *   $ node scripts/sws-seed-from-json.mjs                # idempotent
 *   $ node scripts/sws-seed-from-json.mjs --new-run      # force a new run row
 *   $ node scripts/sws-seed-from-json.mjs --dry-run      # plan only
 *
 * Prerequisites:
 *   1. Neon project provisioned, DATABASE_URL_UNPOOLED in .env.
 *   2. Migrations applied: `node db/migrate.mjs`.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDbConfigured, getDb, closeDb } from "../db/client.js";
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
  nseEventCalendar,
} from "../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { deepJsonToColumns, pickCardToRow } from "../services/swsDal/rowMapping.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data", "sws");

const argv = new Set(process.argv.slice(2));
const FORCE_NEW = argv.has("--new-run");
const DRY_RUN = argv.has("--dry-run");

if (!isDbConfigured()) {
  console.error("DATABASE_URL_UNPOOLED is required. See .env.example.");
  process.exit(1);
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return null;
  }
}

function readJsonRequired(fp, label) {
  const v = readJson(fp);
  if (!v) {
    console.error(`Required file missing or unparseable: ${label} (${fp})`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const lastRefresh = readJsonRequired(path.join(DATA, "last-refresh.json"), "last-refresh.json");
  const picksLatest = readJsonRequired(path.join(DATA, "picks-latest.json"), "picks-latest.json");
  const universe = readJsonRequired(path.join(DATA, "universe.json"), "universe.json");
  const v3Stats = readJsonRequired(path.join(DATA, "v3-universe-stats.json"), "v3-universe-stats.json");
  const failed = readJson(path.join(DATA, "failed.json"));
  const sanity = readJson(path.join(DATA, "_sanity", "_latest.json"));
  const nseCalendar = readJson(path.join(DATA, "nse-event-calendar.json"));
  const progressApi = [1, 2, 3].map((n) => readJson(path.join(DATA, `progress-api-${n}.json`)));

  const deepDir = path.join(DATA, "deep");
  const deepFiles = fs.readdirSync(deepDir).filter((f) => f.endsWith(".json"));

  console.log(`[seed] data inventory:`);
  console.log(`  - last_refresh.finished_at: ${lastRefresh.finished_at}`);
  console.log(`  - picks-latest: ${Object.keys(picksLatest.sections || {}).length} sections`);
  console.log(`  - universe.json: ${universe.length} rows`);
  console.log(`  - deep/: ${deepFiles.length} files`);
  console.log(`  - failed.json: ${failed?.entries?.length ?? 0} failures`);
  console.log(`  - sanity report: ${sanity ? "present" : "missing"}`);
  console.log(`  - nse calendar: ${nseCalendar?.events?.length ?? nseCalendar?.length ?? 0} events`);
  console.log(`  - shard progress: ${progressApi.filter(Boolean).length}/3 present`);

  if (DRY_RUN) {
    console.log("[seed] --dry-run: no DB writes performed.");
    return;
  }

  const db = await getDb({ driver: "pool" });

  // ─── Step 1: Resolve / create run ───────────────────────────────────
  let runId;
  if (!FORCE_NEW) {
    const existing = await db
      .select({ id: swsRuns.id, finishedAt: swsRuns.finishedAt })
      .from(swsRuns)
      .where(eq(swsRuns.isCanonical, true))
      .limit(1);
    if (existing[0]) {
      runId = existing[0].id;
      console.log(`[seed] reusing existing canonical run ${runId}`);
    }
  }

  if (!runId) {
    const inserted = await db
      .insert(swsRuns)
      .values({
        pipeline: lastRefresh.pipeline || "api",
        status: lastRefresh.pipeline_status === "success" ? "success" : "running",
        startedAt: new Date(
          new Date(lastRefresh.finished_at).getTime() -
            (lastRefresh.duration_seconds ?? 0) * 1000,
        ),
        finishedAt: new Date(lastRefresh.finished_at),
        durationSeconds: lastRefresh.duration_seconds ?? null,
        scoredCount: lastRefresh.scored_count ?? null,
        shardsFailed: lastRefresh.shards_failed ?? null,
        newsItemsTotal: lastRefresh.news_items_total ?? null,
        deepFilesScanned: lastRefresh.deep_files_scanned ?? null,
        newsPopulatedCount: lastRefresh.news_populated_count ?? null,
        scrapeSkipped: lastRefresh.scrape_skipped ?? false,
        sectionsCount: lastRefresh.sections_count ?? null,
        perShardProgress: lastRefresh.per_shard_progress ?? null,
        isCanonical: false,
      })
      .returning({ id: swsRuns.id });
    runId = inserted[0].id;
    console.log(`[seed] created run ${runId}`);
  }

  // ─── Step 2: Companies + snapshots ──────────────────────────────────
  console.log(`[seed] loading ${deepFiles.length} deep snapshots …`);
  // Batches sized to stay well under Postgres' 65,535-parameter ceiling
  // even with a wide snapshots row (~57 cols × 200 = 11,400).
  const COMPANY_BATCH = 200;
  const SNAP_BATCH = 100;
  const companyRows = [];
  const snapRows = [];

  // Dedupe in-memory: deep files OR seed are appended, so duplicate
  // tickers within the same INSERT would fire "cannot affect row a second
  // time" from ON CONFLICT DO UPDATE.
  const seenTickers = new Set();
  for (const f of deepFiles) {
    const deep = readJson(path.join(deepDir, f));
    if (!deep?.ticker) continue;
    if (seenTickers.has(deep.ticker)) continue;
    seenTickers.add(deep.ticker);
    companyRows.push({
      ticker: deep.ticker,
      name: deep.name ?? null,
      sector: deep.sector ?? null,
      swsUrl: deep.sws_url ?? null,
      swsCompanyId: deep.company_id ?? null,
      indices: deep.indices ?? null,
    });
    snapRows.push(deepJsonToColumns(deep, { runId }));
  }
  console.log(`[seed]   ${companyRows.length} unique tickers (${deepFiles.length - companyRows.length} duplicates skipped)`);

  for (let i = 0; i < companyRows.length; i += COMPANY_BATCH) {
    const batch = companyRows.slice(i, i + COMPANY_BATCH);
    try {
      await db
        .insert(swsCompanies)
        .values(batch)
        .onConflictDoUpdate({
          target: swsCompanies.ticker,
          set: {
            name: sql`excluded.name`,
            sector: sql`excluded.sector`,
            swsUrl: sql`excluded.sws_url`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    } catch (e) {
      console.error(`\n[seed] companies batch ${i}-${i + batch.length} failed: ${e.message}`);
      console.error(`        first ticker in batch: ${batch[0]?.ticker}`);
      throw e;
    }
    process.stdout.write(`\r  companies: ${Math.min(i + COMPANY_BATCH, companyRows.length)}/${companyRows.length}`);
  }
  process.stdout.write("\n");

  for (let i = 0; i < snapRows.length; i += SNAP_BATCH) {
    const batch = snapRows.slice(i, i + SNAP_BATCH);
    try {
      await db
        .insert(swsCompanySnapshots)
        .values(batch)
        .onConflictDoUpdate({
          target: [swsCompanySnapshots.ticker, swsCompanySnapshots.runId],
          set: { parsedAt: sql`excluded.parsed_at` },
        });
    } catch (e) {
      console.error(`\n[seed] snapshots batch ${i}-${i + batch.length} failed: ${e.message}`);
      console.error(`        first ticker in batch: ${batch[0]?.ticker}`);
      throw e;
    }
    process.stdout.write(`\r  snapshots: ${Math.min(i + SNAP_BATCH, snapRows.length)}/${snapRows.length}`);
  }
  process.stdout.write("\n");

  // ─── Step 3: Universe entries ───────────────────────────────────────
  console.log(`[seed] loading ${universe.length} universe entries …`);
  const uniRows = universe
    .filter((u) => u?.ticker)
    .map((u) => ({
      runId,
      ticker: u.ticker,
      universeIndex: u.index ?? null,
      name: u.name ?? null,
      sector: u.sector ?? null,
      industry: u.industry ?? null,
      exchange: u.exchange ?? null,
      swsShortId: u.sws_short_id ?? null,
      swsUrl: u.sws_url ?? null,
      slug: u.slug ?? null,
      indices: u.indices ?? null,
      seedOnly: u.seed_only ?? null,
      curated: u.curated ?? null,
      marketCapInr: u.market_cap_inr ?? null,
      source: u.source ?? null,
    }));
  for (let i = 0; i < uniRows.length; i += 500) {
    await db
      .insert(swsUniverseEntries)
      .values(uniRows.slice(i, i + 500))
      .onConflictDoNothing();
  }

  // ─── Step 4: Universe stats ─────────────────────────────────────────
  await db
    .insert(swsUniverseStats)
    .values({
      runId,
      generatedAt: v3Stats.generated_at ? new Date(v3Stats.generated_at) : new Date(),
      universeSize: v3Stats.universe_size ?? null,
      r1m: v3Stats.r1m ?? null,
      r3m: v3Stats.r3m ?? null,
      r1y: v3Stats.r1y ?? null,
      counts: v3Stats.counts ?? null,
    })
    .onConflictDoUpdate({
      target: swsUniverseStats.runId,
      set: { r1m: v3Stats.r1m ?? null, r3m: v3Stats.r3m ?? null, r1y: v3Stats.r1y ?? null },
    });

  // ─── Step 5: Picks ───────────────────────────────────────────────────
  console.log(`[seed] loading picks …`);
  const pickRows = [];
  for (const [section, items] of Object.entries(picksLatest.sections || {})) {
    if (!Array.isArray(items)) continue;
    items.forEach((card, idx) => {
      if (!card?.ticker) return;
      pickRows.push(pickCardToRow(card, { runId, section, rank: idx + 1 }));
    });
  }
  // Clear existing picks for this run, then insert.
  await db.delete(swsPicks).where(eq(swsPicks.runId, runId));
  for (let i = 0; i < pickRows.length; i += 500) {
    await db.insert(swsPicks).values(pickRows.slice(i, i + 500));
  }
  console.log(`[seed]   inserted ${pickRows.length} pick rows`);

  // ─── Step 6: Sanity report ──────────────────────────────────────────
  if (sanity) {
    await db
      .insert(swsSanityReports)
      .values({
        runId,
        verdict: sanity.verdict ?? null,
        blockCount: sanity.block_count ?? null,
        warnCount: sanity.warn_count ?? null,
        passCount: sanity.pass_count ?? null,
        totalChecks: sanity.total_checks ?? null,
        layers: sanity,
      })
      .onConflictDoUpdate({
        target: swsSanityReports.runId,
        set: { verdict: sanity.verdict ?? null, layers: sanity },
      });
  }

  // ─── Step 7: Scrape failures ────────────────────────────────────────
  if (failed?.entries?.length) {
    const failRows = failed.entries.map((e) => ({
      runId,
      ticker: e.ticker,
      failedTab: e.failed_tab ?? null,
      error: e.error ?? null,
      recordedAt: e.recorded_at ? new Date(e.recorded_at) : new Date(),
    }));
    for (let i = 0; i < failRows.length; i += 500) {
      await db.insert(swsScrapeFailures).values(failRows.slice(i, i + 500));
    }
    console.log(`[seed]   inserted ${failRows.length} scrape failure rows`);
  }

  // ─── Step 8: NSE event calendar ─────────────────────────────────────
  if (nseCalendar) {
    const events = Array.isArray(nseCalendar) ? nseCalendar : nseCalendar.events || [];
    const eventRows = events
      .filter((e) => e?.symbol && e?.date)
      .map((e) => ({
        ticker: String(e.symbol).toUpperCase().replace(/\.(NS|BO)$/, ""),
        eventDate: new Date(e.date),
        eventType: e.event_type || e.purpose || null,
        purpose: e.purpose ?? null,
        meta: e,
      }));
    for (let i = 0; i < eventRows.length; i += 500) {
      await db
        .insert(nseEventCalendar)
        .values(eventRows.slice(i, i + 500))
        .onConflictDoNothing();
    }
    if (eventRows.length) console.log(`[seed]   inserted ${eventRows.length} NSE calendar rows`);
  }

  // ─── Step 9: Shard progress ─────────────────────────────────────────
  for (let i = 0; i < 3; i++) {
    const p = progressApi[i];
    if (!p) continue;
    const shardId = i + 1;
    await db
      .insert(swsShardProgress)
      .values({
        shardId,
        nextLocalIndex: p.next_local_index ?? null,
        doneCount: p.done_count ?? null,
        todayCount: p.today_count ?? null,
        todayDate: p.today_date ? new Date(p.today_date) : null,
        startedAt: p.started_at ? new Date(p.started_at) : null,
        lastTicker: p.last_ticker ?? null,
        lastRunAt: p.last_run_at ? new Date(p.last_run_at) : null,
        lastDurationMs: p.last_duration_ms ?? null,
      })
      .onConflictDoUpdate({
        target: swsShardProgress.shardId,
        set: { doneCount: p.done_count ?? null, lastTicker: p.last_ticker ?? null },
      });
  }

  // ─── Step 10: Promote to canonical ──────────────────────────────────
  await db.transaction(async (tx) => {
    await tx.update(swsRuns).set({ isCanonical: false }).where(eq(swsRuns.isCanonical, true));
    await tx
      .update(swsRuns)
      .set({ isCanonical: true, status: "success" })
      .where(eq(swsRuns.id, runId));
  });
  console.log(`[seed] OK — run ${runId} is now canonical`);
}

try {
  await main();
} catch (err) {
  console.error(`[seed] FAILED: ${err.message}`);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  await closeDb();
}
