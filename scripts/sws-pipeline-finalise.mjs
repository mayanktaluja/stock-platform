#!/usr/bin/env node
/**
 * Flip a run to is_canonical = true (and clear the prior canonical row)
 * in a single transaction. Called by sws-refresh-api.sh after the
 * sanity gate passes.
 *
 *   $ node scripts/sws-pipeline-finalise.mjs <run_id>
 *
 * Also reads data/sws/last-refresh.json to populate the run's metadata
 * (duration, scored_count, sections_count, etc) at finalise time. This
 * keeps the JSON file authoritative during Phase 3 dual-write — the DB
 * is a faithful mirror, not the source of truth (yet).
 *
 * No-op when DATABASE_URL is unset OR SWS_DB_DUAL_WRITE != 1.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDbConfigured, closeDb } from "../db/client.js";
import { finaliseRun, invalidateAll } from "../services/swsDal/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const runId = process.argv[2];
if (!runId) {
  console.error("Usage: sws-pipeline-finalise.mjs <run_id>");
  process.exit(1);
}

if (!isDbConfigured() || process.env.SWS_DB_DUAL_WRITE !== "1") {
  console.log("[pipeline-finalise] dual-write disabled; no-op.");
  process.exit(0);
}

function readLastRefresh() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(ROOT, "data", "sws", "last-refresh.json"), "utf-8"),
    );
  } catch {
    return null;
  }
}

try {
  const lr = readLastRefresh();
  await finaliseRun(runId, {
    status: lr?.pipeline_status === "success" ? "success" : "sanity_failed",
    finishedAt: lr?.finished_at ?? new Date().toISOString(),
    durationSeconds: lr?.duration_seconds ?? null,
    scoredCount: lr?.scored_count ?? null,
    shardsFailed: lr?.shards_failed ?? null,
    newsItemsTotal: lr?.news_items_total ?? null,
    deepFilesScanned: lr?.deep_files_scanned ?? null,
    newsPopulatedCount: lr?.news_populated_count ?? null,
    scrapeSkipped: lr?.scrape_skipped ?? false,
    sectionsCount: lr?.sections_count ?? null,
    perShardProgress: lr?.per_shard_progress ?? null,
  });
  invalidateAll();
  console.log(`[pipeline-finalise] run ${runId} promoted to canonical`);
} catch (err) {
  console.error(`[pipeline-finalise] failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
