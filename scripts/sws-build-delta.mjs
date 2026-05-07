#!/usr/bin/env node
/**
 * Build the merge-ready universe delta from the SWS sitemap probe.
 *
 * Inputs (run these first):
 *   1. node scripts/coverage-gap-analysis.mjs
 *   2. node scripts/sws-probe-availability.mjs
 *
 * Outputs:
 *   data/coverage/sws_universe_delta.json
 *     Stocks SWS has + we don't yet, formatted for:
 *       node scripts/sws-build-universe.mjs --merge --from-stdin < <delta>
 *
 *   data/coverage/sws_unavailable.json
 *     Stocks Groww supports that SWS does NOT have a page for. The portfolio
 *     analyzer reads this so it can render "no SWS data" instead of failing
 *     silently when a user uploads a holding from this list.
 *
 * Dedup logic (the bit the inline analysis taught us):
 *   • Skip BSE-only sitemap entries whose ISIN matches an NSE-listed stock
 *     already in our universe — they're the same company, NSE listing wins.
 *   • Skip BSE-only sitemap entries already in universe under their bare
 *     numeric code OR the `BSE_<code>` prefixed form.
 *   • Skip NSE-only sitemap entries already in universe.
 *   • Skip BSE entries SWS has but BSE active master doesn't — these are
 *     stale SWS pages for delisted stocks (would scrape to 404 anyway).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const PROBE_PATH = path.join(ROOT, "data/coverage/sws_availability_probe.json");
const GAP_PATH = path.join(ROOT, "data/coverage/coverage_gap.json");
const UNIVERSE_PATH = path.join(ROOT, "data/sws/universe.json");
const BSE_MASTER_PATH = path.join(ROOT, "data/coverage/bse_equity_active.json");
const NSE_CSV_PATH = path.join(ROOT, "data/coverage/nse_equity_l.csv");
const NSE_SUPPLEMENT_PATH = path.join(ROOT, "nseUniverseSupplement.json");

const OUT_DELTA = path.join(ROOT, "data/coverage/sws_universe_delta.json");
const OUT_UNAVAILABLE = path.join(ROOT, "data/coverage/sws_unavailable.json");

// ─────────────────────────────────────────────────────────── Loaders ─────────

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function loadNseIsinIndex() {
  // ISIN → bare NSE symbol. Combines EQUITY_L + nseUniverseSupplement so we
  // can match BSE-listed stocks back to their NSE counterpart even when the
  // NSE listing is in the supplement (long-tail / smallcap not in EQUITY_L).
  const map = new Map();
  const text = fs.readFileSync(NSE_CSV_PATH, "utf-8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const [sym, , , , , , isin] = cols;
    if (sym && isin) map.set(isin.toUpperCase(), sym.toUpperCase());
  }
  if (fs.existsSync(NSE_SUPPLEMENT_PATH)) {
    const supp = loadJson(NSE_SUPPLEMENT_PATH);
    for (const [isin, sym] of Object.entries(supp.isinToSymbol || {})) {
      if (!map.has(isin)) map.set(isin.toUpperCase(), sym.toUpperCase());
    }
  }
  return map;
}

// ─────────────────────────────────────────── Build the merge delta ───────────

function bucketIndexFromBseGroup(group) {
  // Used as the "indices" tag so prioritiseAndIndex() in sws-build-universe.mjs
  // places these new entries in the correct tier (low priority). Existing
  // universe entries use tags like "NSE-EQ", "MICROCAP 250", etc., so we
  // follow that convention.
  switch ((group || "").toUpperCase()) {
    case "A":
      return "BSE-A";
    case "B":
      return "BSE-B";
    case "T":
    case "TS":
      return "BSE-T";
    case "X":
    case "XT":
      return "BSE-X";
    case "Z":
    case "ZP":
      return "BSE-Z";
    case "M":
    case "MS":
    case "MT":
      return "BSE-SME";
    case "P":
    case "R":
    case "IP":
    case "Y":
      return "BSE-SPECIAL";
    default:
      return `BSE-${group || "OTHER"}`;
  }
}

function buildDelta() {
  const probe = loadJson(PROBE_PATH);
  const universe = loadJson(UNIVERSE_PATH);
  const bseRows = loadJson(BSE_MASTER_PATH);
  const nseByIsin = loadNseIsinIndex();

  const haveTickers = new Set();
  for (const s of universe) haveTickers.add(String(s.ticker).toUpperCase());

  const bseByCode = new Map();
  for (const r of bseRows) bseByCode.set(String(r.SCRIP_CD), r);

  const delta = [];
  const stats = {
    consideredNse: 0,
    consideredBse: 0,
    skippedAlreadyHave: 0,
    skippedDualListed: 0,
    skippedStaleBseSwsPage: 0,
    addedNse: 0,
    addedBse: 0,
  };

  // NSE-only sitemap entries
  for (const [ticker, meta] of Object.entries(probe.byNseTicker || {})) {
    stats.consideredNse++;
    const upper = ticker.toUpperCase();
    if (haveTickers.has(upper)) {
      stats.skippedAlreadyHave++;
      continue;
    }
    delta.push({
      ticker: upper,
      name: titleCaseFromSlug(meta.slug),
      exchange: "NSE",
      sector: sectorFromSwsSlug(meta.sector),
      industry: null,
      indices: ["NSE-SITEMAP"], // discovered via SWS sitemap, not in our NSE master
      market_cap_inr: null,
      sws_url: meta.url, // canonical URL — saves runtime redirect resolution
      seed_only: true,
      curated: false,
      isin: null,
      _source: "sws-sitemap-nse",
    });
    stats.addedNse++;
  }

  // BSE-only sitemap entries
  for (const [code, meta] of Object.entries(probe.byBseCode || {})) {
    stats.consideredBse++;
    if (haveTickers.has(code) || haveTickers.has(`BSE_${code}`)) {
      stats.skippedAlreadyHave++;
      continue;
    }
    const bseRow = bseByCode.get(code);
    if (!bseRow) {
      stats.skippedStaleBseSwsPage++;
      continue;
    }
    const isin = (bseRow.ISIN_NUMBER || "").toUpperCase();
    if (isin && isin.startsWith("IN")) {
      const nseSym = nseByIsin.get(isin);
      if (nseSym && haveTickers.has(nseSym)) {
        stats.skippedDualListed++;
        continue;
      }
    }
    delta.push({
      ticker: code, // bare numeric — matches dominant existing convention
      name: bseRow.Issuer_Name || bseRow.Scrip_Name || code,
      exchange: "BSE",
      sector: bseRow.INDUSTRY || sectorFromSwsSlug(meta.sector),
      industry: bseRow.INDUSTRY || null,
      indices: [bucketIndexFromBseGroup(bseRow.GROUP)],
      market_cap_inr: bseRow.Mktcap ? Math.round(Number(bseRow.Mktcap) * 1e7) : null,
      sws_url: meta.url,
      seed_only: true,
      curated: false,
      isin,
      bse_code: code,
      bse_group: bseRow.GROUP,
      _source: "sws-sitemap-bse",
    });
    stats.addedBse++;
  }

  return { delta, stats };
}

function titleCaseFromSlug(slug) {
  return (slug || "")
    .replace(/-shares$/i, "")
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

function sectorFromSwsSlug(slug) {
  // SWS uses kebab-case slugs like "consumer-durables" → "Consumer Durables".
  return (slug || "")
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

// ────────────────────────────────────────── Build the unavailable list ───────

function buildUnavailable() {
  // Stocks in the gap (Groww-tradeable but missing from SWS) that the probe
  // could not match to any SWS sitemap entry. The portfolio analyzer should
  // render "no SWS data" for these instead of failing silently.
  const probe = loadJson(PROBE_PATH);
  return (probe.probeResults || [])
    .filter((r) => !r.swsAvailable)
    .map((r) => ({
      isin: r.isin,
      nseSymbol: r.nseSymbol,
      bseSymbol: r.bseSymbol,
      bseCode: r.bseCode,
      bseGroup: r.bseGroup,
      name: r.name,
      mktCapCr: r.mktCapCr,
      reason: "Not present in SWS Asia sitemap",
    }));
}

// ──────────────────────────────────────────────────────────── Main ───────────

function main() {
  for (const p of [PROBE_PATH, GAP_PATH, UNIVERSE_PATH, BSE_MASTER_PATH, NSE_CSV_PATH]) {
    if (!fs.existsSync(p)) {
      console.error(`Missing prerequisite: ${p}`);
      process.exit(2);
    }
  }

  const { delta, stats } = buildDelta();
  const unavailable = buildUnavailable();

  fs.writeFileSync(
    OUT_DELTA,
    JSON.stringify(delta, null, 2)
  );
  fs.writeFileSync(
    OUT_UNAVAILABLE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count: unavailable.length,
        note:
          "Groww-tradeable Indian equities not present in the SWS Asia sitemap. The recommendation engine has no SWS data for these — analyzer should render 'no SWS data' rather than failing silently.",
        stocks: unavailable,
      },
      null,
      2
    )
  );

  console.log("=== Delta build summary ===");
  console.log(`NSE sitemap entries considered : ${stats.consideredNse}`);
  console.log(`BSE sitemap entries considered : ${stats.consideredBse}`);
  console.log(`Skipped (already in universe)  : ${stats.skippedAlreadyHave}`);
  console.log(`Skipped (NSE counterpart held) : ${stats.skippedDualListed}`);
  console.log(`Skipped (stale BSE SWS page)   : ${stats.skippedStaleBseSwsPage}`);
  console.log(`Added (NSE)                    : ${stats.addedNse}`);
  console.log(`Added (BSE)                    : ${stats.addedBse}`);
  console.log(`Total delta                    : ${delta.length}`);
  console.log(`\n✓ Wrote ${OUT_DELTA}`);
  console.log(`✓ Wrote ${OUT_UNAVAILABLE} (${unavailable.length} stocks)`);
  console.log(`\nNext step:`);
  console.log(`  node scripts/sws-build-universe.mjs --merge --from-stdin < ${path.relative(ROOT, OUT_DELTA)}`);
}

main();
