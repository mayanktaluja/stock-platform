#!/usr/bin/env node
/**
 * US fork of sws-api-parser.mjs — a THIN wrapper.
 *
 * Reuses the India parser's exported `parseStock` + `buildSectorCodeMap`
 * verbatim (the extraction logic is region-agnostic), and changes only:
 *   - reads/writes the data/sws-us/ namespace,
 *   - skips the NSE calendar (US has no NSE board meetings → next_earnings_date
 *     stays null),
 *   - stamps a `currency` field (from the listing currency, USD fallback) so the
 *     US renderer formats $ instead of ₹.
 *
 * No India parser code is edited or duplicated.
 *
 * Usage:
 *   node scripts/sws-api-parser-us.mjs                 # parse all of deep-api/ → deep-parsed/
 *   node scripts/sws-api-parser-us.mjs --dest deep     # write directly to data/sws-us/deep/
 *   node scripts/sws-api-parser-us.mjs AAPL MSFT       # specific tickers
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStock, buildSectorCodeMap } from "./sws-api-parser.mjs";
import { PATHS } from "./sws-config-us.mjs";

const SRC_DIR = PATHS.deepApiDir; // data/sws-us/deep-api
const DEFAULT_DEST = path.join(PATHS.dataDir, "deep-parsed");

// Decorate the India parse output for US: native values already live in the
// *_inr keys (the scorer reads them by name, currency-blind); we add `currency`
// so the renderer picks the right symbol, and fix the raw-path reference.
export function parseStockUS(api, opts = {}) {
  const out = parseStock(api, { ...opts, nseCalendar: null });
  const currency = out?.dividend?.listing_currency || "USD";
  out.currency = currency;
  if (out.overview) out.overview.currency = currency;
  out._api_raw_path = `data/sws-us/deep-api/${api.ticker}.json`;
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const destIdx = args.indexOf("--dest");
  let destDir = DEFAULT_DEST;
  if (destIdx >= 0) {
    const arg = args[destIdx + 1];
    destDir = arg === "deep" ? PATHS.deepDir : arg;
    args.splice(destIdx, 2);
  }
  fs.mkdirSync(destDir, { recursive: true });

  let tickers;
  if (args.length === 0) {
    tickers = fs
      .readdirSync(SRC_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } else {
    tickers = args;
  }
  console.log(`[parser-us] processing ${tickers.length} tickers → ${destDir}`);

  console.log(`[parser-us] pass 1 — building sector code→name map…`);
  const sectorMap = buildSectorCodeMap(SRC_DIR);
  console.log(`[parser-us]   ${sectorMap.size} unique sector codes mapped`);
  console.log(`[parser-us]   NSE calendar: skipped (US — next_earnings_date stays null)`);

  let ok = 0;
  let failed = 0;
  for (const t of tickers) {
    const srcPath = path.join(SRC_DIR, `${t}.json`);
    if (!fs.existsSync(srcPath)) {
      console.warn(`[parser-us]   skip ${t}: src missing`);
      failed++;
      continue;
    }
    try {
      const api = JSON.parse(fs.readFileSync(srcPath, "utf8"));
      const parsed = parseStockUS(api, { sectorMap });
      fs.writeFileSync(path.join(destDir, `${t}.json`), JSON.stringify(parsed, null, 2));
      ok++;
    } catch (e) {
      console.error(`[parser-us]   err ${t}: ${e.message}`);
      failed++;
    }
  }
  console.log(`[parser-us] ✅ ${ok} parsed, ${failed} failed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
