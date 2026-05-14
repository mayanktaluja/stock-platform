#!/usr/bin/env node
/**
 * One-shot migration: earnings-history v1 → v2.
 *
 * v1 per-day files carry only the original five `actual_*` fields. v2
 * adds provenance + restatement audit-trail fields. The actuals
 * resolver tops up rows it touches, and the next refresh-earnings run
 * re-archives every file as v2 anyway — but that leaves untouched
 * files on v1 in the interim. This script stamps ALL existing files to
 * v2 in one pass so the corpus never holds a mix of shapes.
 *
 * Idempotent — re-running is a no-op. Runs locally; commit the result.
 *
 * Usage:
 *   node scripts/migrate-earnings-history-schema.mjs
 *   node scripts/migrate-earnings-history-schema.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import { HISTORY_SCHEMA_VERSION } from "../services/earnings/earningsHistoryArchive.js";

const ROOT = process.cwd();
const HISTORY_DIR = path.join(ROOT, "data", "catalysts", "earnings-history");
const DRY_RUN = process.argv.includes("--dry-run");

function writeJsonAtomic(p, obj) {
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

// Mirror of resolve-earnings-actuals.mjs:normalizeRowToV2 — kept inline
// so the migration has no cross-script coupling.
function normalizeRowToV2(row) {
  let changed = false;
  if (row.actual_source === undefined) { row.actual_source = null; changed = true; }
  if (row.actual_evidence === undefined) { row.actual_evidence = null; changed = true; }
  if (row.actual_revised_iso === undefined) { row.actual_revised_iso = null; changed = true; }
  if (row.actual_history === undefined) { row.actual_history = []; changed = true; }
  if (row.backfilled === undefined) { row.backfilled = false; changed = true; }
  return changed;
}

function main() {
  if (!fs.existsSync(HISTORY_DIR)) {
    console.log(`[migrate-history] no history dir at ${HISTORY_DIR} — nothing to do.`);
    return;
  }
  const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json"));
  let migrated = 0, alreadyOk = 0, errors = 0;

  for (const f of files.sort()) {
    const fp = path.join(HISTORY_DIR, f);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch (err) {
      console.warn(`[migrate-history] ${f}: unreadable — ${err.message}`);
      errors += 1;
      continue;
    }
    let changed = payload.schema_version !== HISTORY_SCHEMA_VERSION;
    for (const row of payload.predictions || []) {
      if (normalizeRowToV2(row)) changed = true;
    }
    if (!changed) {
      alreadyOk += 1;
      continue;
    }
    payload.schema_version = HISTORY_SCHEMA_VERSION;
    if (!DRY_RUN) writeJsonAtomic(fp, payload);
    migrated += 1;
    console.log(`[migrate-history] ${DRY_RUN ? "[dry-run] would migrate" : "migrated"} ${f}`);
  }

  console.log(
    `[migrate-history] done — ${migrated} migrated, ${alreadyOk} already ${HISTORY_SCHEMA_VERSION}, ${errors} error(s)`,
  );
}

try {
  main();
} catch (err) {
  console.error("[migrate-history] FAILED:", err.stack || err.message);
  process.exit(1);
}
