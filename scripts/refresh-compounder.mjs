#!/usr/bin/env node
/**
 * Compounder Lab — refresh script.
 *
 * Walks the SWS scored universe (`data/sws/sws-scored-universe.json`),
 * enriches each candidate with the per-pillar Snowflake breakdown +
 * risks[] from `data/sws/deep/<TICKER>.json`, runs the Snowflake-quality
 * filter from services/compounder/compounderRanker.js, and writes a
 * basket of top-20 by upside_pct DESC to data/compounder/latest.json.
 *
 * Also reconciles the paper-trade ledger at data/paper-trades/compounder.json
 * — new basket members → OPEN trades; departures → CLOSED.
 *
 * Cadence: chained into scripts/sws-nightly.sh after refresh-earnings.mjs.
 * Never invoked from a Vercel cron (no NSE / external IO).
 *
 * Usage:
 *   node scripts/refresh-compounder.mjs
 *   node scripts/refresh-compounder.mjs --dry-run         # show plan, no writes
 *   node scripts/refresh-compounder.mjs --basket-size 30  # override
 *
 * Exit codes:
 *   0   success
 *   1   unexpected failure
 *   75  EX_TEMPFAIL — upstream scored-universe.json missing or empty
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPOUNDER_FILTER,
  rankCompounderCandidates,
} from "../services/compounder/compounderRanker.js";
import { reconcileBasket } from "../services/compounder/paperTradeLog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();

const UNIVERSE_PATH = path.join(ROOT, "data", "sws", "sws-scored-universe.json");
const DEEP_DIR = path.join(ROOT, "data", "sws", "deep");
const OUT_PATH = path.join(ROOT, "data", "compounder", "latest.json");

function parseArgs(argv) {
  const args = { dryRun: false, basketSize: COMPOUNDER_FILTER.basket_size };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--basket-size") args.basketSize = Number(argv[++i]);
  }
  return args;
}

function readDeepSnapshot(ticker) {
  const p = path.join(DEEP_DIR, `${ticker}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function pickPillar(snowflake, ...keys) {
  if (!snowflake || typeof snowflake !== "object") return null;
  for (const k of keys) {
    const v = snowflake[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

// Compose a normalised entry the ranker consumes. Combines the
// scored-universe row (price / mcap / upside / fv_reconcile_reason proxy)
// with the deep JSON's snowflake pillars + risks[].
function composeEntry(scoredRow, deep) {
  const sf = deep?.overview?.snowflake || {};
  const risks = Array.isArray(deep?.overview?.risks) ? deep.overview.risks : [];
  // The deep JSON exposes pillars under multiple naming styles; pickPillar
  // accepts the first that's a finite number. Both legacy and v2 names are
  // present on every entry we sampled.
  return {
    ticker: scoredRow.ticker,
    name: scoredRow.name,
    sector: scoredRow.sector,
    sws_url: scoredRow.sws_url,
    snowflake_past: pickPillar(sf, "past", "past_performance"),
    snowflake_health: pickPillar(sf, "health", "financial_health"),
    snowflake_dividend: pickPillar(sf, "dividend", "dividends"),
    risks,
    market_cap_inr: scoredRow.market_cap_inr,
    current_price_inr: scoredRow.current_price_inr,
    fair_value_inr: scoredRow.fair_value_inr,
    upside_pct: scoredRow.upside_pct,
    fv_reconcile_reason: scoredRow.fv_reconcile_reason || scoredRow.v3_breakdown?.fv_imputed
      ? "fv_imputed"
      : null,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date();

  if (!fs.existsSync(UNIVERSE_PATH)) {
    console.error(`[compounder] upstream missing: ${UNIVERSE_PATH}`);
    process.exit(75);
  }
  let universe;
  try {
    universe = JSON.parse(fs.readFileSync(UNIVERSE_PATH, "utf-8"));
  } catch (err) {
    console.error(`[compounder] failed to parse universe: ${err.message}`);
    process.exit(75);
  }
  const stocks = Array.isArray(universe?.stocks) ? universe.stocks : [];
  if (!stocks.length) {
    console.error("[compounder] empty universe");
    process.exit(75);
  }

  console.log(`[compounder] scanning ${stocks.length} stocks from scored universe…`);

  // Pre-filter on cheap signals before walking deep JSONs (mcap + finite
  // upside). Keeps the deep-file read count to ~1500 instead of 5,517.
  const preFiltered = stocks.filter((s) => {
    const mcap = Number(s.market_cap_inr);
    const upside = Number(s.upside_pct);
    return Number.isFinite(mcap) &&
      mcap >= COMPOUNDER_FILTER.min_market_cap_inr &&
      Number.isFinite(upside);
  });
  console.log(`[compounder] ${preFiltered.length} pass mcap+upside pre-filter`);

  const entries = [];
  let deepReadFailures = 0;
  for (const row of preFiltered) {
    const deep = readDeepSnapshot(row.ticker);
    if (!deep) {
      deepReadFailures++;
      continue;
    }
    entries.push(composeEntry(row, deep));
  }
  console.log(
    `[compounder] composed ${entries.length} entries (${deepReadFailures} deep-read failures)`,
  );

  const opts = { ...COMPOUNDER_FILTER, basket_size: args.basketSize };
  const rank = rankCompounderCandidates(entries, opts);
  console.log(
    `[compounder] ranker: ${rank.passed_count} passed, ${rank.rejected_count} rejected → basket ${rank.basket.length}`,
  );
  console.log("[compounder] rejection_tally:", rank.rejection_tally);

  const out = {
    schema_version: "compounder-latest-v1",
    generated_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    filter: opts,
    universe_size: stocks.length,
    pre_filtered_count: preFiltered.length,
    composed_count: entries.length,
    passed_count: rank.passed_count,
    rejected_count: rank.rejected_count,
    rejection_tally: rank.rejection_tally,
    rejected_sample: rank.rejected_sample,
    basket: rank.basket,
  };

  if (args.dryRun) {
    console.log("[compounder] DRY RUN — basket preview:");
    for (const b of rank.basket.slice(0, 10)) {
      console.log(
        `  ${b.ticker.padEnd(15)} sf(P${b.snowflake_past}/H${b.snowflake_health}/D${b.snowflake_dividend}) upside ${Number(b.upside_pct).toFixed(1)}%`,
      );
    }
    return;
  }

  if (!fs.existsSync(path.dirname(OUT_PATH))) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  }
  const tmp = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, OUT_PATH);
  console.log(`[compounder] wrote ${OUT_PATH}`);

  const recon = reconcileBasket("compounder", rank.basket, {
    today_iso: startedAt.toISOString().slice(0, 10),
  });
  console.log(`[compounder] paper-trade ledger: +${recon.opened} new, -${recon.closed} closed, ${recon.basket_size} total in basket`);
}

main().catch((err) => {
  console.error("[compounder] unexpected failure:", err);
  process.exit(1);
});
