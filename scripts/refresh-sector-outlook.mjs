#!/usr/bin/env node
/**
 * Reads classified-news JSONL files, joins them with picks-latest.json
 * for per-ticker market_cap_inr, aggregates by sector × window, and
 * synthesizes against the current macroRegime.json into the document
 * data/sectorOutlook/outlook-latest.json.
 *
 * Pure compute — no network calls. Chains into sws-nightly.sh AFTER
 * refresh-sector-news-themes.mjs (which produces the input JSONL) and
 * AFTER refresh-risk-lab.mjs (which may refresh macroRegime).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { aggregateAllSectors } from "../services/sectorOutlook/sectorNewsAggregator.js";
import { synthesizeAll } from "../services/sectorOutlook/outlookSynthesizer.js";
import { CLASSIFIER_VERSION } from "../services/sectorOutlook/themeTaxonomy.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const CLASSIFIED_DIR = path.join(ROOT, "data", "sectorOutlook", "classified-news");
const OUTLOOK_PATH = path.join(ROOT, "data", "sectorOutlook", "outlook-latest.json");
const PICKS_PATH = path.join(ROOT, "data", "sws", "picks-latest.json");
const MACRO_PATH = path.join(ROOT, "data", "macroRegime.json");

function parseArgs(argv) {
  const args = { dryRun: false, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: refresh-sector-outlook.mjs [options]\n" +
        "  --dry-run    don't write outlook-latest.json; preview only\n" +
        "  --json       emit machine-readable summary on stdout\n"
      );
      process.exit(0);
    }
  }
  return args;
}

function loadJsonOrNull(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function flattenPicksByTicker(picksDoc) {
  const out = new Map();
  if (!picksDoc?.sections) return out;
  for (const section of Object.values(picksDoc.sections)) {
    if (!Array.isArray(section)) continue;
    for (const row of section) {
      if (!row?.ticker) continue;
      out.set(row.ticker, row);
    }
  }
  return out;
}

function loadClassifiedEntries(picksByTicker) {
  if (!fs.existsSync(CLASSIFIED_DIR)) return [];
  const entries = [];
  const files = fs.readdirSync(CLASSIFIED_DIR).filter((f) => f.endsWith(".jsonl"));
  let stale = 0;
  for (const f of files) {
    const ticker = f.replace(/\.jsonl$/, "");
    const picksRow = picksByTicker.get(ticker);
    if (!picksRow) {
      // Ticker isn't in picks-latest — skip it (likely dropped from coverage).
      stale += 1;
      continue;
    }
    const mcap = Number(picksRow.market_cap_inr) || 0;
    const filePath = path.join(CLASSIFIED_DIR, f);
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.classifier_version !== CLASSIFIER_VERSION) continue; // skip cross-version
      entries.push({
        ticker,
        sourceSector: row.source_sector,
        mcap,
        date: row.date,
        title: row.title,
        body: "", // body not stored in JSONL; aggregator only needs title for conglomerate routing
        theme: row.theme,
        sign: row.sign,
        intensity: row.intensity,
        confidence: row.confidence,
        time_hint: row.time_hint,
      });
    }
  }
  return { entries, stale_tickers: stale };
}

async function main() {
  const args = parseArgs(process.argv);
  const t0 = Date.now();

  const picks = loadJsonOrNull(PICKS_PATH);
  if (!picks) {
    console.error(`[refresh-sector-outlook] FATAL: ${PICKS_PATH} not found`);
    process.exit(1);
  }
  const macroRegime = loadJsonOrNull(MACRO_PATH);
  if (!macroRegime) {
    console.warn(`[refresh-sector-outlook] WARN: ${MACRO_PATH} not found — top-down signal will be NEUTRAL`);
  }

  const picksByTicker = flattenPicksByTicker(picks);
  const { entries, stale_tickers } = loadClassifiedEntries(picksByTicker);

  console.log(`[refresh-sector-outlook] entries=${entries.length} stale_tickers=${stale_tickers}`);

  if (entries.length === 0) {
    console.error(`[refresh-sector-outlook] FATAL: no classified news entries found in ${CLASSIFIED_DIR}`);
    console.error(`  Run scripts/refresh-sector-news-themes.mjs first.`);
    process.exit(1);
  }

  const aggregator = aggregateAllSectors(entries);
  console.log(`[refresh-sector-outlook] aggregator: ${Object.keys(aggregator.sectors).length} sectors · orphaned=${aggregator.orphaned_tickers}`);
  const orphanRate = aggregator.total_entries > 0 ? aggregator.orphaned_tickers / aggregator.total_entries : 0;
  if (orphanRate > 0.15) {
    console.warn(`[refresh-sector-outlook] WARN: orphan rate ${(orphanRate * 100).toFixed(1)}% > 15% — review services/riskLab/macro/sectorOverrides.js`);
  }

  const outlook = synthesizeAll(aggregator, macroRegime);
  outlook.audit.stale_tickers = stale_tickers;
  outlook.audit.elapsed_ms = Date.now() - t0;

  if (args.dryRun) {
    console.log(`[refresh-sector-outlook] DRY RUN — would write ${OUTLOOK_PATH}`);
    if (args.json) console.log(JSON.stringify(outlook.audit, null, 2));
    return;
  }

  const tmp = OUTLOOK_PATH + ".tmp." + process.pid;
  fs.mkdirSync(path.dirname(OUTLOOK_PATH), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(outlook, null, 2));
  fs.renameSync(tmp, OUTLOOK_PATH);
  console.log(`[refresh-sector-outlook] wrote ${OUTLOOK_PATH} · ${outlook.sectors.length} sectors`);
  if (args.json) console.log(JSON.stringify(outlook.audit, null, 2));
}

main().catch((err) => {
  console.error(`[refresh-sector-outlook] FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
