#!/usr/bin/env node
// Append-only merge: reads universe_scraped.json, patches canonical URLs on existing
// entries in-place, then appends genuinely new tickers at the end (sorted among
// themselves by tier+market-cap). Existing positions 0-N are NEVER reordered —
// this preserves shard progress pointers (next_local_index).
//
// Usage:
//   node scripts/sws-merge-universe.mjs
//   node scripts/sws-merge-universe.mjs --dry-run   (prints stats, no writes)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const UNIVERSE_PATH = path.join(REPO_ROOT, "data/sws/universe.json");
const UNIVERSE_META_PATH = path.join(REPO_ROOT, "data/sws/universe-meta.json");
const SCRAPED_PATH = path.join(REPO_ROOT, "data/sws/universe_scraped.json");

function tier(s) {
  const idx = s.indices || [];
  if (idx.includes("NIFTY50")) return 1;
  if (idx.includes("NIFTY NEXT 50") || idx.includes("NIFTY_NEXT_50")) return 2;
  if (idx.includes("NIFTY 500") || idx.includes("NIFTY500")) return 3;
  if (idx.includes("MIDCAP 150") || idx.includes("MIDCAP150")) return 4;
  if (idx.includes("SMALLCAP 250") || idx.includes("SMALLCAP250")) return 5;
  if (idx.includes("MICROCAP 250") || idx.includes("MICROCAP250")) return 6;
  if (s.market_cap_inr) return 7;
  return 8;
}

function isCanonical(url) {
  return url && !url.includes("/search?");
}

function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (!fs.existsSync(SCRAPED_PATH)) {
    console.error(`Missing: ${SCRAPED_PATH}`);
    console.error("Run the SWS browser scrape first to produce universe_scraped.json");
    process.exit(1);
  }

  const existing = JSON.parse(fs.readFileSync(UNIVERSE_PATH, "utf-8"));
  const scraped  = JSON.parse(fs.readFileSync(SCRAPED_PATH, "utf-8"));

  // Index existing by ticker for O(1) lookup
  const existingByTicker = new Map(existing.map(s => [s.ticker.toUpperCase(), s]));

  let urlPatches = 0;
  let newStocks   = [];

  // Build name→ticker index for BSE numeric code resolution
  const existingByName = new Map(
    existing.map(s => [s.name?.toLowerCase().trim(), s]).filter(([k]) => k)
  );

  for (const s of scraped) {
    const rawTicker = String(s.ticker || "").toUpperCase().replace(/\.(NS|BO)$/i, "");
    if (!rawTicker) continue;

    // BSE numeric codes (e.g. "507685" for Wipro) — try to resolve to NSE ticker by name
    const isBseNumeric = /^\d+$/.test(rawTicker) && s.exchange === "BSE";
    let ticker = rawTicker;
    if (isBseNumeric && s.name) {
      const nameMatch = existingByName.get(s.name.toLowerCase().trim());
      if (nameMatch) ticker = nameMatch.ticker; // resolved to NSE ticker
    }

    const found = existingByTicker.get(ticker);
    if (found) {
      // Patch canonical URL in-place if existing one is a search fallback
      if (!isCanonical(found.sws_url) && isCanonical(s.sws_url)) {
        found.sws_url = s.sws_url;
        urlPatches++;
      }
      // Patch market cap if we now have it
      if (!found.market_cap_inr && s.market_cap_inr) {
        found.market_cap_inr = s.market_cap_inr;
      }
      // Merge indices
      if (s.indices?.length) {
        found.indices = [...new Set([...(found.indices || []), ...s.indices])];
      }
    } else {
      // Truly new ticker — queue for append
      newStocks.push({
        ticker,
        name:           s.name || null,
        exchange:       s.exchange || "NSE",
        sector:         s.sector || null,
        industry:       s.industry || null,
        indices:        s.indices || [],
        market_cap_inr: s.market_cap_inr || null,
        sws_url:        s.sws_url || `https://simplywall.st/search?query=${encodeURIComponent(ticker)}`,
        seed_only:      false,
        curated:        false,
      });
    }
  }

  // Sort new stocks among themselves (they start after existing, so their relative
  // order doesn't affect shard 1 — but nice to have large-caps first within the append)
  newStocks.sort((a, b) => {
    const ta = tier(a), tb = tier(b);
    if (ta !== tb) return ta - tb;
    return (b.market_cap_inr ?? -Infinity) - (a.market_cap_inr ?? -Infinity);
  });

  // Assign global indices — existing keep theirs; new start after
  const merged = [
    ...existing,      // positions 0-(N-1) UNCHANGED
    ...newStocks,     // positions N onwards
  ].map((s, i) => ({ ...s, index: i }));

  console.log(`Existing entries:   ${existing.length}`);
  console.log(`Scraped entries:    ${scraped.length}`);
  console.log(`URL patches:        ${urlPatches}`);
  console.log(`New tickers added:  ${newStocks.length}`);
  console.log(`Final universe:     ${merged.length}`);

  if (newStocks.length > 0) {
    console.log("\nFirst 10 new tickers:");
    newStocks.slice(0, 10).forEach(s =>
      console.log(`  ${s.ticker.padEnd(14)} ${s.name || ""}`)
    );
  }

  if (dryRun) {
    console.log("\n--dry-run: no files written.");
    return;
  }

  // Atomic write
  const tmp = UNIVERSE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, UNIVERSE_PATH);
  console.log(`\nWrote ${merged.length} entries → ${UNIVERSE_PATH}`);

  // Sidecar metadata so universe.json staleness is monitorable (the file
  // itself is a bare array with no room for a top-level timestamp).
  const metaTmp = UNIVERSE_META_PATH + ".tmp";
  fs.writeFileSync(metaTmp, JSON.stringify({ generatedAt: new Date().toISOString(), count: merged.length }, null, 2));
  fs.renameSync(metaTmp, UNIVERSE_META_PATH);
  console.log(`Wrote universe-meta.json (count=${merged.length})`);

  // Sanity-check: confirm first 3 positions unchanged
  const reread = JSON.parse(fs.readFileSync(UNIVERSE_PATH, "utf-8"));
  const ok = ["RELIANCE", "TCS", "HDFCBANK"].every((t, i) => reread[i].ticker === t);
  console.log(`Position integrity check (RELIANCE/TCS/HDFCBANK at 0/1/2): ${ok ? "✓ PASS" : "✗ FAIL"}`);
}

main();
