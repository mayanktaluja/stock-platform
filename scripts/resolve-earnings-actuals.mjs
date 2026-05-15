#!/usr/bin/env node
/**
 * Earnings Watch — actuals resolver.
 *
 * Fills the `actual_*` fields on archived predictions so the backtest
 * harness (scripts/backtest-earnings-predictions.mjs) can compute
 * hit-rate, Brier, and the V1 confidence-cap lift gate.
 *
 * Pipeline:
 *   1. loadAllHistory()                — every data/catalysts/earnings-
 *                                        history/<date>.json file
 *   2. selectResolvableKeys()          — unique (symbol, event_iso_date)
 *                                        keys, deduped across snapshots
 *   3. resolveActualForEvent()         — SWS news brief → Yahoo fallback
 *   4. apply patches                   — write the actuals into EVERY
 *                                        snapshot file containing the
 *                                        row, so each file stays
 *                                        internally consistent; the
 *                                        backtest harness dedups on read
 *
 * Restatement handling: with --re-resolve, already-resolved events
 * within 90d are re-checked; if the verdict flips, the prior value is
 * pushed onto `actual_history[]` and `actual_revised_iso` is stamped.
 *
 * Runs LOCALLY (Yahoo + local SWS deep files) — never from a Vercel
 * cron. Commit the updated history JSON so production reads it.
 *
 * Usage:
 *   node scripts/resolve-earnings-actuals.mjs
 *   node scripts/resolve-earnings-actuals.mjs --dry-run
 *   node scripts/resolve-earnings-actuals.mjs --since-days 180 --backfill
 *   node scripts/resolve-earnings-actuals.mjs --symbol RELIANCE
 *   node scripts/resolve-earnings-actuals.mjs --re-resolve
 *
 * Exit codes:
 *   0  ran successfully
 *   1  fatal error
 */

import fs from "node:fs";
import path from "node:path";

import { loadAllHistory, HISTORY_SCHEMA_VERSION } from "../services/earnings/earningsHistoryArchive.js";
import { selectResolvableKeys, resolveActualForEvent } from "../services/earnings/actualsIngester.js";

const ROOT = process.cwd();
const HISTORY_DIR = path.join(ROOT, "data", "catalysts", "earnings-history");
const DEEP_DIR = path.join(ROOT, "data", "sws", "deep");

/* ──────────────────────────── args ──────────────────────────────── */

function parseArgs(argv) {
  const out = {
    dryRun: false,
    sinceDays: 120,
    symbol: null,
    backfill: false,
    reResolve: false,
    concurrency: 5,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--backfill") out.backfill = true;
    else if (a === "--re-resolve") out.reResolve = true;
    else if (a === "--since-days") out.sinceDays = Number(argv[++i]);
    else if (a.startsWith("--since-days=")) out.sinceDays = Number(a.split("=")[1]);
    else if (a === "--symbol") out.symbol = argv[++i];
    else if (a.startsWith("--symbol=")) out.symbol = a.split("=")[1];
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a.startsWith("--concurrency=")) out.concurrency = Number(a.split("=")[1]);
  }
  if (!Number.isFinite(out.sinceDays) || out.sinceDays <= 0) out.sinceDays = 120;
  if (!Number.isFinite(out.concurrency) || out.concurrency <= 0) out.concurrency = 5;
  return out;
}

/* ─────────────────────────── helpers ────────────────────────────── */

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function loadDeepNews(symbol) {
  const p = path.join(DEEP_DIR, `${symbol}.json`);
  if (!fs.existsSync(p)) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(j.news) ? j.news : undefined;
  } catch {
    return undefined;
  }
}

// Ensure a prediction row carries every v2 actuals field. v1 rows
// (written before this PR) only have the original five `actual_*`
// fields — top them up with the v2 additions so a file never holds a
// mix of shapes.
function normalizeRowToV2(row) {
  if (row.actual_source === undefined) row.actual_source = null;
  if (row.actual_evidence === undefined) row.actual_evidence = null;
  if (row.actual_revised_iso === undefined) row.actual_revised_iso = null;
  if (row.actual_history === undefined) row.actual_history = [];
  if (row.backfilled === undefined) row.backfilled = false;
  return row;
}

// Worker-pool batcher — same shape as scripts/sws-fetch-earnings-beat.mjs:107.
async function processInBatches(items, fn, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const my = idx++;
      try {
        results[my] = await fn(items[my]);
      } catch (e) {
        results[my] = { error: e && e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/* ──────────────────────────── main ──────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv);
  console.log(
    `[resolve-actuals] dryRun=${args.dryRun} sinceDays=${args.sinceDays} ` +
      `symbol=${args.symbol || "*"} backfill=${args.backfill} reResolve=${args.reResolve} ` +
      `concurrency=${args.concurrency}`,
  );

  const history = loadAllHistory();
  if (history.length === 0) {
    console.log("[resolve-actuals] no history files — run scripts/refresh-earnings.mjs first.");
    return;
  }

  const keys = selectResolvableKeys(history, {
    sinceDays: args.sinceDays,
    symbol: args.symbol,
    reResolve: args.reResolve,
  });
  console.log(
    `[resolve-actuals] ${keys.length} resolvable event(s) across ${history.length} history file(s)`,
  );
  if (keys.length === 0) {
    console.log("[resolve-actuals] nothing to resolve.");
    return;
  }

  // ── Resolve (network-bound — worker pool) ──
  const resolved = await processInBatches(
    keys,
    async (key) => {
      const swsNews = loadDeepNews(key.symbol);
      const patch = await resolveActualForEvent({
        symbol: key.symbol,
        fiscalQuarter: key.fiscal_quarter,
        eventIsoDate: key.event_iso_date,
        swsNews,
      });
      return { key, patch };
    },
    args.concurrency,
  );

  // key string → patch
  const patches = new Map();
  let bySws = 0, byYahoo = 0, unresolved = 0, errors = 0;
  for (const r of resolved) {
    if (!r || r.error) {
      errors += 1;
      continue;
    }
    if (!r.patch) {
      unresolved += 1;
      continue;
    }
    patches.set(`${r.key.symbol}|${r.key.event_iso_date}`, r.patch);
    if (r.patch.actual_source === "sws_news") bySws += 1;
    else if (r.patch.actual_source === "yahoo") byYahoo += 1;
  }
  console.log(
    `[resolve-actuals] resolved ${patches.size} (sws=${bySws} yahoo=${byYahoo}) · ` +
      `unresolved ${unresolved} · errors ${errors}`,
  );

  if (patches.size === 0) {
    console.log("[resolve-actuals] no new actuals — exiting without writes.");
    return;
  }

  // ── Apply patches into every snapshot file that holds the row ──
  let filesChanged = 0, rowsWritten = 0, restatements = 0;
  for (const day of history) {
    if (!day.filename || !Array.isArray(day.predictions)) continue;
    let changed = false;
    for (const row of day.predictions) {
      normalizeRowToV2(row);
      const patch = patches.get(`${row.symbol}|${row.event_iso_date}`);
      if (!patch) continue;

      // Restatement: a resolved row whose verdict the new patch flips.
      if (row.actual_verdict && row.actual_verdict !== patch.actual_verdict) {
        row.actual_history.push({
          prev_verdict: row.actual_verdict,
          prev_source: row.actual_source || null,
          prev_at: row.resolved_at_iso || null,
        });
        row.actual_revised_iso = patch.resolved_at_iso;
        restatements += 1;
      }

      row.actual_verdict = patch.actual_verdict;
      row.actual_source = patch.actual_source;
      row.actual_evidence = patch.actual_evidence;
      row.actual_t1_close_inr = patch.actual_t1_close_inr ?? row.actual_t1_close_inr ?? null;
      row.actual_t1_open_gap_pct = patch.actual_t1_open_gap_pct ?? row.actual_t1_open_gap_pct ?? null;
      row.resolved_at_iso = patch.resolved_at_iso;
      if (args.backfill) row.backfilled = true;
      changed = true;
      rowsWritten += 1;
    }
    if (changed) {
      filesChanged += 1;
      day.schema_version = HISTORY_SCHEMA_VERSION;
      if (!args.dryRun) {
        const { filename, ...payload } = day;
        writeJsonAtomic(path.join(HISTORY_DIR, filename), payload);
      }
    }
  }

  console.log(
    `[resolve-actuals] ${args.dryRun ? "[dry-run] would write" : "wrote"} ` +
      `${rowsWritten} row(s) across ${filesChanged} file(s)` +
      (restatements ? ` · ${restatements} restatement(s)` : ""),
  );
  if (args.dryRun) {
    for (const [k, p] of patches) {
      console.log(`  ${k.padEnd(30)} → ${p.actual_verdict.padEnd(7)} (${p.actual_source})`);
    }
  }
  console.log(
    `[resolve-actuals] done. Re-run scripts/backtest-earnings-predictions.mjs to refresh the report.`,
  );
}

main().catch((err) => {
  console.error("[resolve-actuals] FAILED:", err.stack || err.message);
  process.exit(1);
});
