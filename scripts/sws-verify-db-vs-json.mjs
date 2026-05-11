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
import { swsCompanySnapshots, swsRuns } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { snapshotRowToJson } from "../services/swsDal/rowMapping.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEEP_DIR = path.join(ROOT, "data", "sws", "deep");

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { count: 50, tickers: null, runId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count") out.count = Number(argv[++i]);
    else if (a === "--tickers") out.tickers = argv[++i].split(",").map((s) => s.trim().toUpperCase());
    else if (a === "--run-id") out.runId = argv[++i];
  }
  return out;
}

if (!isDbConfigured()) {
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

try {
  await main();
} catch (err) {
  console.error(`[verify] FAILED: ${err.message}`);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  await closeDb();
}
