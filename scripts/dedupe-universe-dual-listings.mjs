#!/usr/bin/env node
// Collapse dual-listed companies in data/sws/universe.json to one entry each.
//
// Why this exists: restore-universe-lost-entries.mjs (the 2026-07-23 truncation
// recovery) appended the recovered rows deduped by TICKER, while the sitemap builder's
// Pass 3 dedups by company SLUG. SHANTIGOLD and BSE_544459 are different tickers but
// one company, so 517 redundant entries went in. universe.json drives the scrape
// (scripts/sws-deep-scrape.mjs), so each of those spends a second slot of the nightly
// budget on a company already covered, and mints a second deep brief that the scorer
// then treats as a separate stock.
//
// It uses compareListingPreference from services/swsCanonicalListing.js — the SAME
// comparator scripts/sws-scoring.mjs uses to collapse duplicate briefs. That shared
// choice is load-bearing, not tidiness: if the universe kept SHANTIGOLD while the
// scorer preferred BSE_544459, the scraper would refresh one ticker and the
// leaderboard would show the other, so the visible row would never refresh again.
//
// Append-only in spirit: entries keep their existing relative order, losers are simply
// removed, and `index` is reassigned 0..n-1 afterwards. Since the scraper shards by
// alphabetical contiguous block (sws-api-scrape.mjs:99) rather than by index, removing
// entries re-partitions the blocks — so shard cursors must be reset after this runs.
//
// Usage:
//   node scripts/dedupe-universe-dual-listings.mjs --dry-run
//   node scripts/dedupe-universe-dual-listings.mjs

import fs from "node:fs";
import { PATHS } from "./sws-config.mjs";
import { compareListingPreference, companySlugFromSwsUrl } from "../services/swsCanonicalListing.js";

function groupKey(entry) {
  // universe.json entries carry an explicit `slug`; fall back to deriving it from
  // sws_url (same source the scorer uses), then to a row-unique key so an entry with
  // neither can never be collapsed away.
  return entry?.slug
    || companySlugFromSwsUrl(entry?.sws_url)
    || `__ticker:${entry?.ticker ?? Math.random()}`;
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const universe = JSON.parse(fs.readFileSync(PATHS.universe, "utf-8"));

  const groups = new Map();
  for (const entry of universe) {
    const k = groupKey(entry);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(entry);
  }

  const winners = new Set();
  const collapses = [];
  for (const [slug, members] of groups) {
    if (members.length === 1) { winners.add(members[0]); continue; }
    const sorted = members.slice().sort(compareListingPreference);
    winners.add(sorted[0]);
    collapses.push({
      slug,
      winner: sorted[0].ticker,
      winner_exchange: sorted[0].exchange,
      losers: sorted.slice(1).map((e) => `${e.ticker}(${e.exchange})`),
      curated_loser: sorted.slice(1).some((e) => e.curated),
    });
  }

  const kept = universe.filter((e) => winners.has(e)).map((e, i) => ({ ...e, index: i }));
  const curatedBefore = universe.filter((e) => e.curated).length;
  const curatedAfter = kept.filter((e) => e.curated).length;
  const curatedLost = collapses.filter((c) => c.curated_loser);

  console.log(`universe entries:   ${universe.length}`);
  console.log(`distinct companies: ${groups.size}`);
  console.log(`collapsing:         ${universe.length - kept.length} redundant entries across ${collapses.length} companies`);
  console.log(`final:              ${kept.length}`);
  console.log(`curated:            ${curatedBefore} → ${curatedAfter}`);

  if (collapses.length) {
    console.log("\nfirst 15 collapses:");
    for (const c of collapses.slice(0, 15)) {
      console.log(`  ${c.slug.padEnd(38)} keep ${String(c.winner).padEnd(14)} drop ${c.losers.join(", ")}`);
    }
  }

  // A curated entry losing would mean index membership (NIFTY50 etc.) is being decided
  // by the dedup, which it must never be. On the 2026-07-30 data this is zero.
  if (curatedLost.length > 0) {
    console.error(`\n✗ REFUSING: ${curatedLost.length} company/companies would drop a CURATED entry:`);
    for (const c of curatedLost.slice(0, 10)) console.error(`   ${c.slug}: keeping ${c.winner}, dropping ${c.losers.join(", ")}`);
    console.error("\nuniverse.json unchanged. Inspect before overriding — a curated row is an index member.");
    process.exit(3);
  }

  if (dryRun) { console.log("\n--dry-run: no files written."); return; }
  if (collapses.length === 0) { console.log("\nNothing to collapse — universe already has one entry per company."); return; }

  const tmp = `${PATHS.universe}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(kept, null, 2));
  fs.renameSync(tmp, PATHS.universe);
  console.log(`\n✓ ${PATHS.universe} → ${kept.length} entries.`);

  // Re-stamp the sidecar. /api/health/snapshots reads it for the "SWS universe (Nd
  // old)" banner and the nightly's 264h rebuild-skip gate keys on its count — leaving
  // a stale count there is exactly what froze the truncated universe for six days.
  const metaTmp = `${PATHS.universeMeta}.tmp.${process.pid}`;
  fs.writeFileSync(metaTmp, JSON.stringify({ generatedAt: new Date().toISOString(), count: kept.length }, null, 2));
  fs.renameSync(metaTmp, PATHS.universeMeta);
  console.log(`✓ ${PATHS.universeMeta} stamped (count=${kept.length}).`);

  console.log("\nShard cursors must be reset before the next scrape — the scraper shards by");
  console.log("alphabetical contiguous block, so removing entries re-partitions every block.");
}

main();
