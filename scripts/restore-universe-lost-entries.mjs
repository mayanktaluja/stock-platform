#!/usr/bin/env node
// One-shot recovery for the 2026-07-23 universe truncation.
//
// What happened: sws-universe-from-sitemap.mjs built its merge output by walking
// ONLY the sitemap, so any existing entry the sitemap didn't return was deleted
// as a silent side effect. A short crawl (the fetch is ~580 MB across 12 shards
// and skips a shard on any error) cut data/sws/universe.json from 5500 → 3847
// entries, dropping 2178 tickers — 193 of them curated index members, including
// the NIFTY-50 names ICICIBANK, HINDUNILVR, BHARTIARTL, MARUTI, LT and KOTAKBANK.
// universe-meta.json was then stamped with the truncated count, so the nightly's
// 264h freshness gate skipped the rebuild every night and the truncated list
// froze. Meanwhile the scoring layer reads data/sws/deep/ directly, so all 6178
// briefs kept being scored and served — the 2331 orphans among them ageing out
// to 2-90 days while still appearing in user-facing picks.
//
// The forward fix (Pass 2 + the membership-loss guard) lives in
// sws-universe-from-sitemap.mjs and stops this recurring. This script repairs the
// damage already committed.
//
// Recovery source is a GIT REF, not the local universe-sitemap-dropped.json
// forensic file: the ref is in the repo, so the restore is reproducible by anyone
// and auditable in review. Both sources independently agree on 2178 lost / 193
// curated.
//
// Append-only. Existing positions 0..N-1 keep their order, so this never
// reshuffles entries that are already scraped.
//
// Shard cursors ARE reset to 0. sws-api-scrape.mjs:99 shards by ALPHABETICAL
// CONTIGUOUS BLOCK (sorted[0..N/3], [N/3..2N/3], rest) — not by index % 3 — so
// growing the universe re-partitions every block and leaves next_local_index
// pointing at unrelated stocks. Resetting to 0 makes the next run a true
// full-universe rescan, which is also what the stale data needs. (Note: the
// --reset-progress path in sws-universe-from-sitemap.mjs derives slices with
// index % 3 and therefore disagrees with the scraper; it is deliberately NOT
// used here.)
//
// Usage:
//   node scripts/restore-universe-lost-entries.mjs --dry-run
//   node scripts/restore-universe-lost-entries.mjs
//   node scripts/restore-universe-lost-entries.mjs --from-ref <sha>

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PATHS } from "./sws-config.mjs";
import { compareListingPreference, companySlugFromSwsUrl } from "../services/swsCanonicalListing.js";

// sws-api-scrape.mjs resolves its own progress path rather than using
// PATHS.progress; mirror it here so both pipelines' cursors get reset.
function progressApiPath(shardId) {
  return path.join(path.dirname(PATHS.universe), `progress-api-${shardId}.json`);
}

// data/sws/universe.json @ 2026-07-08 — the last commit before the truncation
// (chore(sws): auto-refresh 2026-07-08 07:46 — full universe rescan, #1002).
const DEFAULT_REF = "c1f9145824";
const SHARD_COUNT = 3;

function norm(t) {
  return String(t || "").toUpperCase().trim();
}

function readUniverseAtRef(ref) {
  const raw = execFileSync("git", ["show", `${ref}:data/sws/universe.json`], {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.stocks || parsed.universe || [];
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const refIdx = args.indexOf("--from-ref");
  const ref = refIdx >= 0 ? args[refIdx + 1] : DEFAULT_REF;

  const current = JSON.parse(fs.readFileSync(PATHS.universe, "utf-8"));
  const prior = readUniverseAtRef(ref);

  const currentTickers = new Set(current.map((s) => norm(s.ticker)).filter(Boolean));
  const seen = new Set();
  const lost = [];
  for (const e of prior) {
    const t = norm(e.ticker);
    if (!t || currentTickers.has(t) || seen.has(t)) continue;
    seen.add(t);
    // Verbatim, minus the forensic marker the sitemap script attaches. Keeping
    // curated/indices/name/market_cap_inr intact is the whole point — routing
    // this through sws-merge-universe.mjs instead would hardcode curated:false
    // and silently strip index membership from all 193 recovered blue chips.
    const { _drop_reason, ...rest } = e;
    lost.push({ ...rest, restored_from_ref: ref });
  }

  // Dedup by COMPANY, not just by ticker.
  //
  // The ticker-keyed filter above is not sufficient: SHANTIGOLD and BSE_544459 are
  // different tickers but one dual-listed company, so restoring purely by ticker put
  // 517 redundant entries back into universe.json. universe.json drives the scrape, so
  // each redundant row costs a second slot of the nightly budget on a company already
  // covered and mints a second deep brief the scorer then treats as its own stock.
  // Same comparator the scorer uses, so both paths agree on which listing is canonical.
  const beforeDedup = [...current, ...lost];
  const bySlug = new Map();
  for (const e of beforeDedup) {
    const k = e?.slug || companySlugFromSwsUrl(e?.sws_url) || `__ticker:${e?.ticker}`;
    if (!bySlug.has(k)) bySlug.set(k, []);
    bySlug.get(k).push(e);
  }
  const survivors = new Set();
  for (const [, members] of bySlug) {
    survivors.add(members.length === 1 ? members[0] : members.slice().sort(compareListingPreference)[0]);
  }
  const collapsed = beforeDedup.length - survivors.size;
  const merged = beforeDedup.filter((e) => survivors.has(e)).map((s, i) => ({ ...s, index: i }));
  const curatedRecovered = lost.filter((e) => e.curated).length;
  if (collapsed > 0) {
    console.log(`dual-listing collapse: ${beforeDedup.length} → ${merged.length} (${collapsed} redundant listing(s) dropped)`);
  }

  console.log(`recovery ref:        ${ref}`);
  console.log(`current universe:    ${current.length} entries (${current.filter((s) => s.curated).length} curated)`);
  console.log(`prior universe:      ${prior.length} entries (${prior.filter((s) => s.curated).length} curated)`);
  console.log(`lost → restoring:    ${lost.length} entries (${curatedRecovered} curated)`);
  console.log(`final universe:      ${merged.length} entries (${merged.filter((s) => s.curated).length} curated)`);

  if (lost.length === 0) {
    console.log("\nNothing to restore — current universe already covers the ref.");
    return;
  }

  const bellwethers = ["ICICIBANK", "HINDUNILVR", "BHARTIARTL", "MARUTI", "LT", "KOTAKBANK"];
  const restoredNames = new Set(lost.map((e) => norm(e.ticker)));
  console.log("\nNIFTY-50 bellwethers recovered:");
  for (const t of bellwethers) {
    console.log(`  ${t.padEnd(12)} ${restoredNames.has(t) ? "✓ restored" : "— not in lost set"}`);
  }

  console.log("\nFirst 10 restored:");
  for (const e of lost.slice(0, 10)) {
    console.log(`  ${String(e.ticker).padEnd(14)} curated=${e.curated ? "yes" : "no "}  ${e.name || ""}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: no files written.");
    return;
  }

  const tmp = `${PATHS.universe}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, PATHS.universe);
  console.log(`\n✓ ${PATHS.universe} → ${merged.length} entries.`);

  // Stamp the sidecar /api/health/snapshots reads for the "SWS universe (Nd old)"
  // banner. Also clears the 264h skip gate's stale count=3847 record.
  const metaTmp = `${PATHS.universeMeta}.tmp.${process.pid}`;
  fs.writeFileSync(metaTmp, JSON.stringify({ generatedAt: new Date().toISOString(), count: merged.length }, null, 2));
  fs.renameSync(metaTmp, PATHS.universeMeta);
  console.log(`✓ ${PATHS.universeMeta} stamped (count=${merged.length}).`);

  // Reset the cursors for BOTH pipelines' progress files. sws-api-scrape.mjs
  // keeps its own `progress-api-<n>.json` (it does not go through
  // PATHS.progress, which points at the legacy DOM scraper's `progress-<n>.json`),
  // and the api pipeline is the one the nightly runs today — so writing only one
  // of the two silently leaves the live cursor stale.
  //
  // These files are UNTRACKED runtime state, so this only affects the checkout it
  // runs in. Run this script in the tree that will actually do the scraping (the
  // nightly runs from its own worktree), not just wherever universe.json is
  // being committed from.
  let resetCount = 0;
  for (let shardId = 1; shardId <= SHARD_COUNT; shardId++) {
    for (const p of [progressApiPath(shardId), PATHS.progress(shardId)]) {
      if (!fs.existsSync(p)) { console.log(`· ${p} absent — nothing to reset.`); continue; }
      let progress = {};
      try { progress = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* rewrite wholesale */ }
      const before = progress.next_local_index;
      fs.writeFileSync(p, JSON.stringify({
        ...progress,
        shard_id: shardId,
        next_local_index: 0,
        complete: false,
        _rebuilt_at: new Date().toISOString(),
        _rebuilt_reason: "universe_restored_after_2026-07-23_truncation",
      }, null, 2));
      console.log(`✓ ${p} cursor ${before ?? "?"} → 0.`);
      resetCount++;
    }
  }
  if (resetCount === 0) {
    console.log("\n⚠ No progress files found in this checkout — the scraping tree's");
    console.log("  cursors are still stale. Re-run this script there before scraping.");
  }

  console.log("\nNext run is a full-universe rescan — the restored entries have");
  console.log("deep briefs 2-90 days old and need re-scraping before they are trustworthy.");
}

main();
