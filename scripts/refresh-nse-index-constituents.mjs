#!/usr/bin/env node
/**
 * Refresh NSE index constituents (Nifty 100 / Midcap 150 / Smallcap 250 / 500).
 *
 * Pulls four CSVs from nsearchives.nseindia.com and writes a single
 * lookup file at data/nse-index-constituents.json. Powers the
 * universe-filter dropdown on the SWS Picks tab.
 *
 * Runs LOCALLY (not on Vercel cron). Chained into scripts/sws-nightly.sh.
 *
 * Usage:
 *   node scripts/refresh-nse-index-constituents.mjs
 *   node scripts/refresh-nse-index-constituents.mjs --dry-run
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const OUTPUT_PATH = join(REPO_ROOT, "data", "nse-index-constituents.json");

const INDICES = [
  { key: "nifty100",         file: "ind_nifty100list.csv",         nominal: 100 },
  { key: "niftyMidcap150",   file: "ind_niftymidcap150list.csv",   nominal: 150 },
  { key: "niftySmallcap250", file: "ind_niftysmallcap250list.csv", nominal: 250 },
  { key: "nifty500",         file: "ind_nifty500list.csv",         nominal: 500 },
];

const ARCHIVE_BASE = "https://nsearchives.nseindia.com/content/indices";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DRY_RUN = process.argv.includes("--dry-run");

async function fetchCsv(file) {
  const url = `${ARCHIVE_BASE}/${file}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/csv,*/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = await res.text();
  if (body.trim().startsWith("<")) throw new Error(`got HTML page from ${url} (likely Cloudflare block)`);
  return body;
}

export function parseConstituentCsv(csvText) {
  const lines = csvText.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV has no data rows");
  const header = lines.shift().toLowerCase();
  if (!header.includes("symbol")) throw new Error(`CSV missing Symbol column: ${header}`);
  const symbolIdx = header.split(",").findIndex((c) => c.trim() === "symbol");
  if (symbolIdx < 0) throw new Error(`could not locate Symbol column in: ${header}`);

  const symbols = [];
  for (const line of lines) {
    const parts = line.split(",");
    const sym = parts[symbolIdx]?.trim().replace(/^"|"$/g, "").toUpperCase();
    if (sym) symbols.push(sym);
  }
  return symbols;
}

export function evaluateGuards(current, previous, nominal) {
  // Returns { write: bool, warn: bool, reason: string }.
  // Refuse to write only if list dropped >40% from previous AND is now
  // below 50% of the nominal target (100/150/250/500). That pattern
  // indicates an HTML error page parsed as CSV — a real NSE rebalance
  // never shrinks a list by more than ~10-20%.
  const newCount = current.length;
  const oldCount = previous ?? 0;
  const dropPct = oldCount > 0 ? ((oldCount - newCount) / oldCount) * 100 : 0;
  const belowHalfNominal = newCount < nominal * 0.5;
  if (oldCount > 0 && dropPct > 40 && belowHalfNominal) {
    return { write: false, warn: false, reason: `count ${newCount} dropped ${dropPct.toFixed(1)}% from ${oldCount} AND is <50% of nominal ${nominal} — refusing (probable HTML error page)` };
  }
  if (oldCount > 0 && dropPct > 10) {
    return { write: true, warn: true, reason: `count ${newCount} dropped ${dropPct.toFixed(1)}% from ${oldCount} (likely NSE rebalance) — warning, writing anyway` };
  }
  return { write: true, warn: false, reason: "ok" };
}

async function main() {
  const previous = existsSync(OUTPUT_PATH)
    ? JSON.parse(readFileSync(OUTPUT_PATH, "utf-8"))
    : null;
  const previousCounts = previous?.counts ?? {};

  const result = {
    fetched_at: new Date().toISOString(),
    source: ARCHIVE_BASE,
    counts: {},
    previous_counts: previousCounts,
  };

  for (const { key, file, nominal } of INDICES) {
    console.log(`[nse-idx] fetching ${file} …`);
    const csv = await fetchCsv(file);
    const symbols = parseConstituentCsv(csv);
    const guard = evaluateGuards(symbols, previousCounts[key], nominal);
    if (guard.warn) console.warn(`[nse-idx] WARN ${key}: ${guard.reason}`);
    if (!guard.write) {
      console.error(`[nse-idx] FAIL ${key}: ${guard.reason}`);
      process.exit(2);
    }
    result[key] = symbols;
    result.counts[key] = symbols.length;
    console.log(`[nse-idx]   ${key}: ${symbols.length} symbols`);
  }

  if (DRY_RUN) {
    console.log("[nse-idx] --dry-run, skipping write");
    console.log(JSON.stringify(result.counts, null, 2));
    return;
  }

  const tmpPath = `${OUTPUT_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(result, null, 2) + "\n");
  renameSync(tmpPath, OUTPUT_PATH);
  console.log(`[nse-idx] wrote ${OUTPUT_PATH}`);
}

// Only run main() when invoked as a script, not when imported by tests.
const invokedDirectly = fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[nse-idx] FAILED: ${err.message}`);
    process.exit(1);
  });
}
