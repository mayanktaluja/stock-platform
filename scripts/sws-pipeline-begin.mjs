#!/usr/bin/env node
/**
 * Create a new sws_runs row (is_canonical = false, status = running).
 * Echoes the run_id on stdout for downstream pipeline scripts.
 *
 *   $ RUN_ID=$(node scripts/sws-pipeline-begin.mjs)
 *
 * No-op when DATABASE_URL is unset OR SWS_DB_DUAL_WRITE != 1 — exits 0
 * with an empty stdout, so the wrapping shell can still cleanly source it.
 */

import "dotenv/config";
import { isDbConfigured, closeDb } from "../db/client.js";
import { beginRun } from "../services/swsDal/index.js";

if (!isDbConfigured() || process.env.SWS_DB_DUAL_WRITE !== "1") {
  // Silent no-op. Pipeline shell scripts source this and tolerate empty
  // output (RUN_ID becomes "").
  process.exit(0);
}

try {
  const runId = await beginRun({ pipeline: "api", startedAt: new Date() });
  if (runId) process.stdout.write(runId);
} catch (err) {
  console.error(`[pipeline-begin] failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
