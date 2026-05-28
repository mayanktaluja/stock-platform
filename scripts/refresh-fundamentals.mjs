#!/usr/bin/env node
/**
 * Fundamentals Snapshot Scraper — merge-safe expanded universe
 *
 * Scrapes NSE quote-equity for:
 *   • The curated stockList.js universe (Nifty 50 + Next 50 + midcaps)
 *   • OPTIONALLY the small-cap supplement (Smallcap 250 + Microcap 250)
 *
 * Writes fundamentals.json with merge semantics: existing snapshots are
 * preserved across runs, so a partial failure doesn't shrink the file.
 * Checkpoints to disk every CHECKPOINT_EVERY batches so an abort still
 * saves progress.
 *
 * Must be run from a machine with Indian IP access (NSE blocks non-IN IPs).
 *
 * Usage:
 *   node scripts/refresh-fundamentals.mjs              # curated only (~504)
 *   node scripts/refresh-fundamentals.mjs --supplement # curated + smallcap/microcap
 *   node scripts/refresh-fundamentals.mjs --full       # curated + full NSE supplement (~2181)
 *
 * Cadence: daily via scripts/sws-nightly.sh step 3c (8h freshness gate).
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { fetchNseQuoteRaw } from "../nse.js";
import { getAllStocks } from "../stockList.js";
import { ENRICHED_FIELDS } from "../enrichFundamentals.js";
import { resolveCurrentNseSymbol } from "../services/nseTickerAliases.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_PATH = path.join(__dirname, "..", "fundamentals.json");
const TMP_PATH = OUT_PATH + ".tmp";
const SUPPLEMENT_PATH = path.join(__dirname, "..", "nseUniverseSupplement.json");

const args = new Set(process.argv.slice(2));
const INCLUDE_SUPPLEMENT = args.has("--supplement") || args.has("--full");
const FULL_UNIVERSE = args.has("--full");

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 300;
const CHECKPOINT_EVERY = 20; // write to disk every N batches

function loadExistingSnapshots() {
  if (!existsSync(OUT_PATH)) return {};
  try {
    const data = JSON.parse(readFileSync(OUT_PATH, "utf-8"));
    return data.snapshots || {};
  } catch (err) {
    console.warn(`  Could not parse existing ${OUT_PATH}: ${err.message}`);
    return {};
  }
}

function buildSymbolList() {
  const seen = new Set();
  const list = [];

  // Apply NSE corporate-action renames at the boundary so curated entries
  // like TATAMOTORS.NS / LTIM.NS / ZOMATO.NS fold into their renamed
  // successors (TMPV / LTM / ETERNAL) instead of producing permanent
  // `no_data` failures every nightly refresh. The successors are also
  // listed in the NIFTY500 supplement; the `seen` dedup absorbs the
  // overlap so we don't double-fetch.
  const pushIfNew = (symbol, rec) => {
    const current = resolveCurrentNseSymbol(symbol);
    if (!current || seen.has(current)) return;
    seen.add(current);
    list.push({ symbol: current, name: rec.name, sector: rec.sector, source: rec.source });
  };

  // 1. Curated (ALL_STOCKS from stockList.js) — full shape with name/sector
  for (const s of getAllStocks()) {
    if (!s.symbol) continue;
    pushIfNew(s.symbol, { name: s.name, sector: s.sector, source: "curated" });
  }

  // 2. Supplement — only if flagged
  if (INCLUDE_SUPPLEMENT && existsSync(SUPPLEMENT_PATH)) {
    const supp = JSON.parse(readFileSync(SUPPLEMENT_PATH, "utf-8"));
    const bySymbol = supp.bySymbol || {};
    for (const [bare, rec] of Object.entries(bySymbol)) {
      const symbol = rec.symbol || `${bare}.NS`;
      // Default mode: only pull Smallcap 250 + Microcap 250 (what the SME scanner ranks).
      // --full adds the long-tail 1,431 names from the NSE EQ master.
      const inSmallcap = (rec.indices || []).some((i) => /SMALLCAP 250|MICROCAP 250/.test(i));
      if (!FULL_UNIVERSE && !inSmallcap) continue;
      pushIfNew(symbol, { name: rec.name, sector: rec.sector, source: "supplement" });
    }
  }

  return list;
}

function writeOutput(snapshots, failures) {
  const output = {
    generatedAt: new Date().toISOString(),
    source: FULL_UNIVERSE ? "nse-full" : INCLUDE_SUPPLEMENT ? "nse-expanded" : "nse",
    stockCount: Object.keys(snapshots).length,
    failureCount: failures.length,
    failures,
    snapshots,
  };
  // Atomic write: tmp file then rename, so a mid-write crash doesn't
  // corrupt fundamentals.json.
  writeFileSync(TMP_PATH, JSON.stringify(output, null, 2), "utf-8");
  renameSync(TMP_PATH, OUT_PATH);
}

async function main() {
  const stocks = buildSymbolList();
  const existing = loadExistingSnapshots();
  const snapshots = { ...existing }; // merge-safe: start from existing
  const failures = [];

  const mode = FULL_UNIVERSE ? "full NSE" : INCLUDE_SUPPLEMENT ? "curated + Smallcap 250 + Microcap 250" : "curated only";
  console.log(`Mode: ${mode}`);
  console.log(`Existing snapshots: ${Object.keys(existing).length}`);
  console.log(`To scrape: ${stocks.length}`);
  console.log("");

  let batchCount = 0;
  for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
    const batch = stocks.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (stock) => {
        try {
          const raw = await fetchNseQuoteRaw(stock.symbol);
          if (!raw || !raw.priceInfo) {
            failures.push({ symbol: stock.symbol, reason: "no_data" });
            return null;
          }

          const p = raw.priceInfo || {};
          const meta = raw.metadata || {};
          const sec = raw.securityInfo || {};
          const info = raw.info || {};
          const ind = raw.industryInfo || {};

          const snapshot = {
            symbol: stock.symbol,
            name: info.companyName || stock.name,
            sector: ind.sector || meta.industry || stock.sector || null,
            industry: ind.industry || meta.industry || null,
            macro: ind.macro || null,
            pe: meta.pdSymbolPe || null,
            sectorPe: meta.pdSectorPe || null,
            price: p.lastPrice || null,
            previousClose: p.previousClose || null,
            faceValue: sec.faceValue || null,
            issuedSize: sec.issuedSize || null,
            marketCap:
              p.lastPrice && sec.issuedSize ? p.lastPrice * sec.issuedSize : null,
            week52High: p.weekHighLow?.max || null,
            week52Low: p.weekHighLow?.min || null,
            week52HighDate: p.weekHighLow?.maxDate || null,
            week52LowDate: p.weekHighLow?.minDate || null,
            vwap: p.vwap || null,
            upperCircuit: p.upperCP || null,
            lowerCircuit: p.lowerCP || null,
            isin: info.isin || null,
          };

          // Preserve Yahoo-enriched fields (ROE, D/E, dividends, health metrics,
          // forward-looking inputs, etc.) if the existing snapshot has them —
          // enrich-fundamentals.mjs runs separately and we don't want to clobber
          // its work. The canonical field list is exported by enrichFundamentals.js
          // so the set never drifts out of sync.
          const prior = existing[stock.symbol];
          if (prior) {
            for (const field of ENRICHED_FIELDS) {
              if (prior[field] != null) snapshot[field] = prior[field];
            }
          }

          return { symbol: stock.symbol, snapshot };
        } catch (err) {
          failures.push({ symbol: stock.symbol, reason: err.message });
          return null;
        }
      })
    );

    for (const r of results) {
      if (r) snapshots[r.symbol] = r.snapshot;
    }

    batchCount++;
    const processed = Math.min(i + BATCH_SIZE, stocks.length);
    const pctBar = `[${"#".repeat(Math.floor((processed / stocks.length) * 20)).padEnd(20)}]`;
    console.log(
      `  ${pctBar} ${processed}/${stocks.length} (${Object.keys(snapshots).length} ok, ${failures.length} failed)`
    );

    // Checkpoint periodically so an abort still saves progress
    if (batchCount % CHECKPOINT_EVERY === 0) {
      writeOutput(snapshots, failures);
    }

    if (i + BATCH_SIZE < stocks.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // Final write
  writeOutput(snapshots, failures);

  console.log(`\n✓ Wrote ${OUT_PATH}`);
  console.log(`  ${Object.keys(snapshots).length} snapshots, ${failures.length} failures`);
  if (failures.length > 0) {
    console.log(`\n  Failed (first 10):`);
    failures.slice(0, 10).forEach((f) => console.log(`    ${f.symbol}: ${f.reason}`));
    if (failures.length > 10) console.log(`    ... and ${failures.length - 10} more`);
  }
}

main().catch((err) => {
  console.error("Scraper failed:", err);
  process.exit(1);
});
