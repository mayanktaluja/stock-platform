#!/usr/bin/env node
/**
 * One-shot migration: earnings-history any prior version → current.
 *
 * The archive row schema has grown over several PRs:
 *   v2 — provenance + restatement audit trail (actual_source, …)
 *   v3 — llm_signal provenance
 *   v4 — score_breakdown (per-component points, for the weight tuner)
 *
 * refresh-earnings.mjs re-archives only TODAY's file, and resolved
 * past-event files drop out of the calendar — so older files get
 * stranded on an old schema. This script stamps ALL existing files to
 * the CURRENT schema in one pass: it null-fills every missing field
 * (an honest representation — a v1-era row genuinely had no
 * score_breakdown) and bumps the file's schema_version.
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

// Null-fill every field the current archive row schema expects. A
// missing field on an old row is honest — a v1-era prediction genuinely
// had no score_breakdown — so we fill with null/[]/false, never invent
// data. Kept inline so the migration has no cross-script coupling.
function normalizeRowToCurrent(row) {
  let changed = false;
  const ensure = (key, def) => {
    if (row[key] === undefined) { row[key] = def; changed = true; }
  };
  // v2 — provenance + restatement audit trail.
  ensure("actual_source", null);
  ensure("actual_evidence", null);
  ensure("actual_revised_iso", null);
  ensure("actual_history", []);
  ensure("backfilled", false);
  // v3 — LLM qualitative signal provenance.
  ensure("llm_signal", null);
  // v4 — per-component points for the weight tuner.
  ensure("score_breakdown", null);
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
      if (normalizeRowToCurrent(row)) changed = true;
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
