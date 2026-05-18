#!/usr/bin/env node
// Refresh Nifty sector index daily closes from Yahoo Finance.
//
// Output: data/sector-indices/<key>.jsonl — append-only JSONL,
// one line per trading day:
//   { "date": "YYYY-MM-DD", "close": <number>, "volume": <number> }
//
// Idempotent — re-running the same day is a no-op for that bar.
// Use `--backfill-months=<N>` for the initial population (default 1 month
// incremental on subsequent runs).
//
// Source: query1.finance.yahoo.com/v8/finance/chart/<symbol>?range=...
// Yahoo returns intraday + daily; we pull daily bars only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SECTOR_INDEX_CATALOG } from "../services/macroThesis/sectorIndexCatalog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "data", "sector-indices");

const args = process.argv.slice(2);
const FLAG_DRY_RUN = args.includes("--dry-run");
const FLAG_QUIET = args.includes("--quiet");
const backfillMatch = args.find((a) => a.startsWith("--backfill-months="));
const backfillMonths = backfillMatch ? Math.max(1, parseInt(backfillMatch.split("=")[1], 10) || 1) : 1;
const range = backfillMonths >= 24 ? "5y" : backfillMonths >= 12 ? "2y" : backfillMonths >= 6 ? "1y" : backfillMonths >= 3 ? "6mo" : "1mo";

function log(...m) {
  if (!FLAG_QUIET) console.log("[refresh-sector-indices]", ...m);
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readExistingDates(file) {
  if (!fs.existsSync(file)) return new Set();
  const out = new Set();
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.date) out.add(obj.date);
    } catch {}
  }
  return out;
}

async function fetchYahoo(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=1d&events=history&includePrePost=false`;
  const res = await fetch(url, {
    headers: {
      // Yahoo's free chart endpoint requires a UA — anything realistic works.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`yahoo http ${res.status} ${res.statusText} for ${symbol}`);
  return await res.json();
}

function parseYahooBars(json) {
  const result = json?.chart?.result?.[0];
  if (!result) return [];
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const volumes = result.indicators?.quote?.[0]?.volume || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const close = closes[i];
    if (close == null) continue; // Yahoo emits nulls for non-trading slots
    const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    out.push({ date: d, close: Math.round(close * 100) / 100, volume: volumes[i] ?? null });
  }
  return out;
}

async function refreshOne(entry) {
  const file = path.join(DATA_DIR, `${entry.key}.jsonl`);
  const existing = readExistingDates(file);
  let json;
  try {
    json = await fetchYahoo(entry.yahoo);
  } catch (err) {
    log(`  ${entry.key}: SKIP (${err.message})`);
    return { key: entry.key, added: 0, skipped: 0, error: err.message };
  }
  const bars = parseYahooBars(json);
  const fresh = bars.filter((b) => !existing.has(b.date));
  if (FLAG_DRY_RUN) {
    log(`  ${entry.key}: would add ${fresh.length} bar(s) (have ${existing.size}, fetched ${bars.length})`);
    return { key: entry.key, added: 0, skipped: bars.length - fresh.length, would_add: fresh.length, error: null };
  }
  if (fresh.length === 0) {
    log(`  ${entry.key}: 0 new bars (have ${existing.size})`);
    return { key: entry.key, added: 0, skipped: bars.length, error: null };
  }
  // Append-only — sort fresh by date then append. The loader sorts again
  // on read so file order isn't strictly required, but writing in order
  // keeps the file diff-readable.
  fresh.sort((a, b) => a.date.localeCompare(b.date));
  const lines = fresh.map((b) => JSON.stringify(b)).join("\n") + "\n";
  fs.appendFileSync(file, lines);
  log(`  ${entry.key}: +${fresh.length} bars (total now ${existing.size + fresh.length})`);
  return { key: entry.key, added: fresh.length, skipped: bars.length - fresh.length, error: null };
}

async function main() {
  ensureDir();
  log(`range=${range} dryRun=${FLAG_DRY_RUN} catalog=${SECTOR_INDEX_CATALOG.length} sectors`);
  const summary = [];
  for (const entry of SECTOR_INDEX_CATALOG) {
    const r = await refreshOne(entry);
    summary.push(r);
    // Be polite to Yahoo — 250ms between requests.
    await new Promise((r) => setTimeout(r, 250));
  }
  const added = summary.reduce((a, s) => a + s.added, 0);
  const errored = summary.filter((s) => s.error).length;
  log(`done — added ${added} bars across ${SECTOR_INDEX_CATALOG.length} sectors (${errored} errored)`);
  if (errored > 0) {
    log("errors:");
    for (const s of summary.filter((s) => s.error)) log(`  ${s.key}: ${s.error}`);
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ range, summary }, null, 2));
  }
}

main().catch((err) => {
  console.error("[refresh-sector-indices] fatal:", err);
  process.exit(1);
});
