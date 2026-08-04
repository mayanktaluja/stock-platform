// Single source of truth for how the SWS universe is split across scrape shards.
//
// Why this file exists
// --------------------
// The partition scheme was re-implemented in three places and two of them
// disagreed with the one that actually runs:
//
//   scripts/sws-api-scrape.mjs      contiguous alphabetical blocks   ← live
//   scripts/sws-api-scrape-us.mjs   contiguous alphabetical blocks   (copy)
//   scripts/sws-universe-from-sitemap.mjs   `index % 3`              (mismatch)
//
// `--reset-progress` in the sitemap rebuilder derived each shard's slice
// modularly and then wrote `next_local_index` cursors computed against slices
// the api scraper never uses. A cursor is just an integer offset into a slice —
// point it at a different slice and it silently means a different set of
// stocks. Some get re-scraped, others are skipped entirely and go stale. The
// same class of failure as the 2026-07-23 truncation (#1166): not a crash, just
// wrong data served confidently.
//
// The two schemes, and why BOTH still exist
// -----------------------------------------
// CONTIGUOUS (this module's `shardSliceContiguous`) — the api pipeline.
//   Sort the universe alphabetically by ticker, cut it into `totalShards`
//   contiguous blocks, remainder to the last shard. Read/written against
//   `data/sws/progress-api-<n>.json`. `scripts/sws-refresh-api.sh` runs this,
//   and `sws-refresh-api.sh` is what the nightly runs — so this is the scheme
//   that governs live data freshness.
//
// MODULAR (`shardSliceLegacyModular`, delegating to `indicesForShard`) — the
//   legacy Chrome-MCP DOM pipeline in `scripts/sws-deep-scrape.mjs`. Stride
//   `SHARD_COUNT` over universe.json's STORED order. Read/written against
//   `data/sws/progress-<n>.json`. Still reachable via `/sws-scan-shard`,
//   `/sws-resume-shard` and `scripts/sws-refresh.sh`.
//
// The old `index % SHARD_COUNT` filter was in fact a *correct* derivation of
// the legacy slice — `mergeAndSort()` re-indexes `merged[i].index = i`, so
// `index % 3` and `indicesForShard` select byte-identical entries (verified on
// the live 6025-entry universe). It was aimed at the pipeline that no longer
// runs. That is why the fix keeps both derivations rather than replacing one
// with the other: writing a contiguous cursor into `progress-<n>.json` would
// reintroduce exactly the same bug pointing the other way.
//
// The two orderings are unrelated, not merely offset. `mergeAndSort()` sorts by
// priorityScore FIRST (curated entries lead), then ticker; the contiguous
// scheme re-sorts purely alphabetically. So the modular slice is a stride over
// a curated-first list while the contiguous slice is a block of an alphabetical
// one — no cursor is transferable between them.
//
// Adding entries re-partitions BOTH schemes, so any universe growth invalidates
// every live cursor regardless of scheme. See `rewriteProgressFromDeep()` in
// sws-universe-from-sitemap.mjs (rebuild from disk) and
// scripts/restore-universe-lost-entries.mjs (reset to 0).

import { SHARD_COUNT, indicesForShard } from "./sws-config.mjs";

export { SHARD_COUNT };

/**
 * The api pipeline's partition: alphabetical sort, contiguous blocks.
 *
 * Reproduces `scripts/sws-api-scrape.mjs` exactly, including its rounding:
 * `sliceSize = floor(total / totalShards)` means the LAST shard absorbs the
 * entire remainder (up to `totalShards - 1` extra entries), and when
 * `total < totalShards` every shard but the last is empty. Both are load-
 * bearing — cursors persisted under the current arithmetic must keep resolving
 * to the same stocks, so do not "fix" the distribution here without also
 * invalidating every `progress-api-<n>.json`.
 *
 * `Array.prototype.sort` is stable (required since ES2019), so entries sharing
 * a ticker keep their input order and the partition is reproducible run to run.
 *
 * @param {Array<{ticker?: string}>} universe
 * @param {number} shardId 1-based
 * @param {number} [totalShards] defaults to the India SHARD_COUNT; pass the
 *   region's own count for non-India universes (US uses its own config).
 * @returns {Array} the shard's slice, in the order the scraper walks it
 */
export function shardSliceContiguous(universe, shardId, totalShards = SHARD_COUNT) {
  if (!Number.isInteger(totalShards) || totalShards < 1) {
    throw new Error(`shardSliceContiguous: totalShards must be >= 1, got ${totalShards}`);
  }
  if (!Number.isInteger(shardId) || shardId < 1 || shardId > totalShards) {
    // Unreachable from the scrapers (both validate argv first). Guarded anyway
    // because the silent alternative is an out-of-range slice() returning [] or
    // a wrong block — the exact failure mode this module exists to prevent.
    throw new Error(`shardSliceContiguous: shardId must be 1..${totalShards}, got ${shardId}`);
  }
  const sorted = universe.slice().sort((a, b) =>
    (a.ticker || "").localeCompare(b.ticker || ""),
  );
  const total = sorted.length;
  const sliceSize = Math.floor(total / totalShards);
  const startIdx = (shardId - 1) * sliceSize;
  const endIdx = shardId === totalShards ? total : startIdx + sliceSize;
  return sorted.slice(startIdx, endIdx);
}

/**
 * The legacy DOM pipeline's partition: stride `SHARD_COUNT` over the universe's
 * STORED order (no re-sort). Delegates to `indicesForShard` in sws-config.mjs
 * so that scheme keeps exactly one definition too.
 *
 * Shard count is fixed at the config's `SHARD_COUNT` — `indicesForShard` reads
 * the module constant rather than taking a parameter, and the legacy pipeline
 * has no multi-region variant, so there is nothing to parameterise.
 *
 * @param {Array} universe in stored order — do NOT pre-sort
 * @param {number} shardId 1-based
 */
export function shardSliceLegacyModular(universe, shardId) {
  if (!Number.isInteger(shardId) || shardId < 1 || shardId > SHARD_COUNT) {
    throw new Error(`shardSliceLegacyModular: shardId must be 1..${SHARD_COUNT}, got ${shardId}`);
  }
  return indicesForShard(shardId, universe.length).map((i) => universe[i]);
}
