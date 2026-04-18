#!/usr/bin/env node
/**
 * Fundamentals Snapshot Scraper
 *
 * Fetches NSE quote-equity data for all tracked stocks (Nifty 50 + Nifty Next 50
 * + popular midcaps) and writes fundamentals.json in the project root.
 *
 * Must be run from a machine with Indian IP access (NSE blocks non-IN IPs).
 *
 * Usage:
 *   node scripts/refresh-fundamentals.mjs
 *
 * Cadence: run manually once a week (or whenever you want fresh P/E data),
 * then commit fundamentals.json and push. Vercel redeploys automatically.
 */

import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { fetchNseQuoteRaw } from "../nse.js";
import { getNifty100, getAllStocks } from "../stockList.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_PATH = path.join(__dirname, "..", "fundamentals.json");

async function main() {
  const stocks = getAllStocks(); // scrape everything we track
  console.log(`Scraping ${stocks.length} stocks from NSE...`);

  const snapshots = {};
  const failures = [];
  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 300;

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
              p.lastPrice && sec.issuedSize
                ? p.lastPrice * sec.issuedSize
                : null,
            week52High: p.weekHighLow?.max || null,
            week52Low: p.weekHighLow?.min || null,
            week52HighDate: p.weekHighLow?.maxDate || null,
            week52LowDate: p.weekHighLow?.minDate || null,
            vwap: p.vwap || null,
            upperCircuit: p.upperCP || null,
            lowerCircuit: p.lowerCP || null,
            isin: info.isin || null,
          };

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

    const processed = Math.min(i + BATCH_SIZE, stocks.length);
    console.log(`  ${processed}/${stocks.length} (${Object.keys(snapshots).length} ok, ${failures.length} failed)`);

    if (i + BATCH_SIZE < stocks.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    source: "nse",
    stockCount: Object.keys(snapshots).length,
    failureCount: failures.length,
    failures,
    snapshots,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log(`\n✓ Wrote ${OUT_PATH}`);
  console.log(`  ${Object.keys(snapshots).length} snapshots, ${failures.length} failures`);
  if (failures.length > 0) {
    console.log(`\n  Failed symbols:`);
    failures.slice(0, 10).forEach((f) => console.log(`    ${f.symbol}: ${f.reason}`));
    if (failures.length > 10) console.log(`    ... and ${failures.length - 10} more`);
  }
}

main().catch((err) => {
  console.error("Scraper failed:", err);
  process.exit(1);
});
