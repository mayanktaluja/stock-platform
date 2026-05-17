#!/usr/bin/env node
/**
 * Drift check between data/sws/ JSON files and the canonical run in
 * Postgres. Picks N random tickers (default 50), reads each from both
 * sides, and asserts every hot field matches within float epsilon.
 *
 * Used during Phase 3 dual-write to gate the pipeline: any drift exits
 * non-zero and the auto-PR step skips. Also runnable manually:
 *
 *   $ node scripts/sws-verify-db-vs-json.mjs
 *   $ node scripts/sws-verify-db-vs-json.mjs --tickers RELIANCE,TCS
 *   $ node scripts/sws-verify-db-vs-json.mjs --count 100
 *   $ node scripts/sws-verify-db-vs-json.mjs --run-id <uuid>
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDbConfigured, getDb, closeDb } from "../db/client.js";
import { swsCompanySnapshots, swsPicks, swsRuns } from "../db/schema.js";
import { and, eq, sql } from "drizzle-orm";
import { snapshotRowToJson } from "../services/swsDal/rowMapping.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEEP_DIR = path.join(ROOT, "data", "sws", "deep");
const HEALTH_DIR = path.join(ROOT, "data", "sws", "health");

// argv parsed only when invoked directly (not when imported by unit tests
// that only need formatPicksFvDriftReport).
const args = isEntryPoint() ? parseArgs(process.argv.slice(2)) : { count: 50, tickers: null, runId: null, check: null };

function isEntryPoint() {
  // Note: import.meta.url uses file:// URLs; process.argv[1] is a path.
  // The conversion goes the other way (fileURLToPath) — done at the
  // bottom of the file where the actual call lives.
  if (!process.argv[1]) return false;
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const out = { count: 50, tickers: null, runId: null, check: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count") out.count = Number(argv[++i]);
    else if (a === "--tickers") out.tickers = argv[++i].split(",").map((s) => s.trim().toUpperCase());
    else if (a === "--run-id") out.runId = argv[++i];
    else if (a === "--check") out.check = argv[++i];
  }
  return out;
}

// Formats a row set from checkPicksSnapshotFvAgreement into the JSON
// shape written to data/sws/health/picks-snapshot-fv-drift.json. Pure
// function for unit-testability — the SQL JOIN is unit-tested via this
// formatter rather than against a live DB.
export function formatPicksFvDriftReport({ runId, rows, checkedAt }) {
  return {
    run_id: runId,
    checked_at: checkedAt || new Date().toISOString(),
    drifted_count: rows.length,
    drifted_top: rows.slice(0, 20).map((r) => ({
      ticker: r.ticker,
      section: r.section,
      pick_fv: r.pickFv,
      snap_fv: r.snapFv,
      delta: Number((r.pickFv - r.snapFv).toFixed(2)),
    })),
  };
}

// DB check guarded so importing the module for unit-testing the pure
// formatter doesn't kill the process. The actual main() call still
// validates this before running any SQL.
if (isEntryPoint() && !isDbConfigured()) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

function nearEqual(a, b, epsilon = 1e-4) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < epsilon;
  return a === b;
}

function compareDeep(diskDeep, dbDeep) {
  const diffs = [];
  // Compare key hot fields. JSONB arrays are compared via length + a few
  // representative fields; full deep-equality would catch ordering noise
  // we don't actually care about.
  const fields = [
    ["ticker", "ticker"],
    ["name", "name"],
    ["sector", "sector"],
    ["overview.current_price_inr", null],
    ["overview.fair_value_inr", null],
    ["overview.upside_pct", null],
    ["overview.market_cap_inr", null],
    ["overview.snowflake_total", null],
    ["overview.snowflake.valuation", null],
    ["overview.snowflake.financial_health", null],
    ["overview.snowflake.future_growth", null],
    ["overview.snowflake.past_performance", null],
    ["overview.snowflake.dividends", null],
    ["overview.multiples.pe", null],
    ["overview.multiples.pb", null],
    ["overview.returns_pct.1M", null],
    ["overview.returns_pct.1Y", null],
    ["overview.dividend_yield_pct", null],
    ["overview.net_margin_pct", null],
  ];
  for (const [path] of fields) {
    const a = get(diskDeep, path);
    const b = get(dbDeep, path);
    if (!nearEqual(a, b)) {
      diffs.push({ path, disk: a, db: b });
    }
  }
  // Array lengths
  const aNews = diskDeep?.news?.length ?? 0;
  const bNews = dbDeep?.news?.length ?? 0;
  if (aNews !== bNews) diffs.push({ path: "news.length", disk: aNews, db: bNews });

  const aHolders = diskDeep?.ownership?.top_holders?.length ?? 0;
  const bHolders = dbDeep?.ownership?.top_holders?.length ?? 0;
  if (aHolders !== bHolders) diffs.push({ path: "top_holders.length", disk: aHolders, db: bHolders });

  return diffs;
}

function get(obj, dotPath) {
  return dotPath.split(".").reduce((o, k) => (o == null ? null : o[k]), obj);
}

// SQL JOIN between sws_picks and sws_company_snapshots for a given run,
// returning every (ticker, section) where the picks-side fair_value_inr
// differs from the snapshot-side by more than max(₹0.01, 0.1%·FV). The
// JOIN scans both tables once — ~2.5k picks rows × ~5.5k snapshots — so
// even on the full canonical run it returns in ms. This is the structural
// drift gate referenced in ~/.claude/plans/so-i-have-attached-virtual-
// sphinx.md (Layer 2) and called from scripts/sws-refresh-api.sh BEFORE
// scripts/sws-pipeline-finalise.mjs flips is_canonical, so a drifted
// run never becomes canonical and the picks card / stock modal can
// never disagree on Fair Value at the response layer.
async function checkPicksSnapshotFvAgreement(db, runId) {
  const rows = await db
    .select({
      ticker: swsPicks.ticker,
      section: swsPicks.section,
      pickFv: swsPicks.fairValueInr,
      snapFv: swsCompanySnapshots.fairValueInr,
    })
    .from(swsPicks)
    .innerJoin(
      swsCompanySnapshots,
      and(
        eq(swsCompanySnapshots.runId, swsPicks.runId),
        eq(swsCompanySnapshots.ticker, swsPicks.ticker),
      ),
    )
    .where(
      and(
        eq(swsPicks.runId, runId),
        sql`${swsPicks.fairValueInr} IS NOT NULL`,
        sql`${swsCompanySnapshots.fairValueInr} IS NOT NULL`,
        sql`ABS(${swsPicks.fairValueInr} - ${swsCompanySnapshots.fairValueInr}) > GREATEST(0.01, 0.001 * ABS(${swsCompanySnapshots.fairValueInr}))`,
      ),
    )
    .orderBy(
      sql`ABS(${swsPicks.fairValueInr} - ${swsCompanySnapshots.fairValueInr}) DESC`,
    );

  const report = formatPicksFvDriftReport({ runId, rows });
  // Always write the health file (success and failure both) so the daily
  // earnings-health-summary can pick it up without log-scraping.
  try {
    fs.mkdirSync(HEALTH_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(HEALTH_DIR, "picks-snapshot-fv-drift.json"),
      JSON.stringify(report, null, 2),
    );
  } catch (e) {
    console.warn(`[verify] could not write health file: ${e.message}`);
  }

  if (rows.length === 0) {
    console.log(`[verify] picks-snapshot-fv: 0 tickers drifted (run ${runId})`);
    return 0;
  }
  console.error(`[verify] PICKS-SNAPSHOT FV DRIFT: ${rows.length} tickers`);
  for (const r of rows.slice(0, 20)) {
    console.error(
      `  ${r.ticker}/${r.section}: pick=${r.pickFv} snap=${r.snapFv} (Δ=${(r.pickFv - r.snapFv).toFixed(2)})`,
    );
  }
  if (rows.length > 20) console.error(`  ... and ${rows.length - 20} more`);
  // Exit code 2 = drift detected (distinct from exit 1 used for the
  // disk/db field-level check above). Callers can branch on this.
  return 2;
}

async function main() {
  const db = await getDb();

  let runId = args.runId;
  if (!runId) {
    const rows = await db
      .select({ id: swsRuns.id })
      .from(swsRuns)
      .where(eq(swsRuns.isCanonical, true))
      .limit(1);
    if (!rows[0]) {
      console.error("No canonical run found.");
      process.exit(2);
    }
    runId = rows[0].id;
  }
  console.log(`[verify] run_id=${runId}`);

  // --check picks-snapshot-fv: standalone drift check between sws_picks
  // and sws_company_snapshots. Used by sws-refresh-api.sh before
  // finaliseRun so a drifted run never flips is_canonical.
  if (args.check === "picks-snapshot-fv") {
    const code = await checkPicksSnapshotFvAgreement(db, runId);
    process.exitCode = code;
    return;
  }

  let candidates;
  if (args.tickers) {
    candidates = args.tickers;
  } else {
    const all = fs.readdirSync(DEEP_DIR).filter((f) => f.endsWith(".json"));
    const shuffled = all.sort(() => Math.random() - 0.5).slice(0, args.count);
    candidates = shuffled.map((f) => f.replace(/\.json$/, ""));
  }

  let mismatches = 0;
  for (const ticker of candidates) {
    const diskDeep = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(DEEP_DIR, `${ticker}.json`), "utf-8"));
      } catch {
        return null;
      }
    })();
    if (!diskDeep) {
      console.log(`  ${ticker}: no disk file — skipping`);
      continue;
    }
    const dbRows = await db
      .select()
      .from(swsCompanySnapshots)
      .where(
        and(
          eq(swsCompanySnapshots.runId, runId),
          eq(swsCompanySnapshots.ticker, ticker),
        ),
      )
      .limit(1);
    const dbDeep = snapshotRowToJson(dbRows[0]);
    if (!dbDeep) {
      console.log(`  ${ticker}: MISSING in DB`);
      mismatches++;
      continue;
    }
    const diffs = compareDeep(diskDeep, dbDeep);
    if (diffs.length) {
      mismatches++;
      console.log(`  ${ticker}: ${diffs.length} field diffs:`);
      for (const d of diffs.slice(0, 5)) {
        console.log(`    - ${d.path}: disk=${JSON.stringify(d.disk)} db=${JSON.stringify(d.db)}`);
      }
    } else {
      console.log(`  ${ticker}: OK`);
    }
  }

  console.log(`\n[verify] ${candidates.length - mismatches}/${candidates.length} tickers match`);
  if (mismatches > 0) process.exitCode = 1;
}

if (isEntryPoint()) {
  try {
    await main();
  } catch (err) {
    console.error(`[verify] FAILED: ${err.message}`);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
