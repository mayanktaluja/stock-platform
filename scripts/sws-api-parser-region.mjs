#!/usr/bin/env node
/**
 * Region SWS parser — the generalization of sws-api-parser-us.mjs (a THIN wrapper).
 *
 * Reuses the India parser's exported `parseStock` + `buildSectorCodeMap` verbatim
 * (the extraction logic is region-agnostic), and changes only:
 *   - reads/writes the data/sws-<code>/ namespace,
 *   - skips the NSE calendar (KR/TW have no NSE board meetings → next_earnings_date
 *     stays null, which also avoids a dotted-key ticker accidentally matching an
 *     India NSE-calendar entry),
 *   - stamps `currency = region.currencyIso` AUTHORITATIVELY.
 *
 * Why the region ISO (not dividend.listing_currency || fallback, as the US wrapper
 * did): `parseStock` does NOT surface a currency, so the US wrapper effectively
 * always fell through to its "USD" fallback. A KR stock IS KRW and a TW stock IS
 * TWD — the region is the authority, so we stamp it directly. Native numeric values
 * keep living in the *_inr-named keys (the scorer reads them currency-blind); only
 * the `currency` string + the renderer symbol differ.
 *
 * No India parser code is edited or duplicated.
 *
 * Usage:
 *   node scripts/sws-api-parser-region.mjs --region kr                  # parse all deep-api/ → deep/
 *   node scripts/sws-api-parser-region.mjs --region kr --dest deep      # explicit
 *   node scripts/sws-api-parser-region.mjs --region tw 2330.TW 2454.TW  # specific tickers
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStock, buildSectorCodeMap } from "./sws-api-parser.mjs";
import { makeRegionConfig } from "./sws-config-region.mjs";
import { getRegion } from "./sws-regions.mjs";

// Decorate the India parse output for a region: skip the NSE calendar and stamp
// the region currency. `region` is a REGIONS entry (carries currencyIso + dataDir).
export function parseStockRegion(api, region, opts = {}) {
  const out = parseStock(api, { ...opts, nseCalendar: null });
  const currency = region.currencyIso;
  out.currency = currency;
  if (out.overview) out.overview.currency = currency;
  out._api_raw_path = `${region.dataDir}/deep-api/${api.ticker}.json`;
  return out;
}

function argVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const code = argVal(args, "--region");
  if (!code) {
    console.error("usage: --region <kr|tw> [--dest deep|<dir>] [TICKER ...]");
    process.exit(2);
  }
  const ri = args.indexOf("--region");
  args.splice(ri, 2);

  const region = getRegion(code);
  const cfg = makeRegionConfig(code);
  const SRC_DIR = cfg.PATHS.deepApiDir;

  const destIdx = args.indexOf("--dest");
  let destDir = cfg.PATHS.deepDir; // default: write parsed briefs straight to deep/
  if (destIdx >= 0) {
    const arg = args[destIdx + 1];
    destDir = arg === "deep" ? cfg.PATHS.deepDir : arg;
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
  console.log(`[parser-${code}] processing ${tickers.length} tickers → ${destDir}`);

  console.log(`[parser-${code}] pass 1 — building sector code→name map…`);
  const sectorMap = buildSectorCodeMap(SRC_DIR);
  console.log(`[parser-${code}]   ${sectorMap.size} unique sector codes mapped`);
  console.log(`[parser-${code}]   NSE calendar: skipped (next_earnings_date stays null); currency=${region.currencyIso}`);

  let ok = 0;
  let failed = 0;
  for (const t of tickers) {
    const srcPath = path.join(SRC_DIR, `${t}.json`);
    if (!fs.existsSync(srcPath)) {
      console.warn(`[parser-${code}]   skip ${t}: src missing`);
      failed++;
      continue;
    }
    try {
      const api = JSON.parse(fs.readFileSync(srcPath, "utf8"));
      const parsed = parseStockRegion(api, region, { sectorMap });
      fs.writeFileSync(path.join(destDir, `${t}.json`), JSON.stringify(parsed, null, 2));
      ok++;
    } catch (e) {
      console.error(`[parser-${code}]   err ${t}: ${e.message}`);
      failed++;
    }
  }
  console.log(`[parser-${code}] ✅ ${ok} parsed, ${failed} failed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
