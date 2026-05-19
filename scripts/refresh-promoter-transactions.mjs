#!/usr/bin/env node
/**
 * NSE SEBI Reg 7(2) PIT — promoter / insider transaction scraper.
 *
 * Fetches the 30-day window of insider/promoter transactions filed with
 * NSE, classifies BUY / SELL / PLEDGE / RELEASE, and merges into a
 * rolling deduped file consumed by the Earnings Edge filter (rejection
 * signal) and Compounder Lab (rank booster).
 *
 * MUST run from a local machine — same NSE cookie issue as
 * refresh-nse-corporate.mjs. Commit the JSON.
 *
 * Output:
 *   data/promoter-transactions/rolling-30d.json
 *   data/promoter-transactions/last-refresh-status.json  (staleness alert)
 *
 * Exit codes:
 *   0   success
 *   1   unexpected failure
 *   75  EX_TEMPFAIL — NSE fetch failed; existing rolling preserved
 */

import {
  fetchPitWindow,
  loadRolling,
  mergeIntoRolling,
  writeRolling,
  writeStatus,
} from "../services/promoter/nsePitIngester.js";

async function main() {
  const startedAt = new Date();
  console.log(`[promoter-pit] fetching last 30d window from NSE corporates-pit…`);

  let fresh;
  try {
    fresh = await fetchPitWindow(30);
  } catch (err) {
    console.error(`[promoter-pit] fetch threw: ${err.message}`);
    writeStatus({
      last_attempt_iso: startedAt.toISOString(),
      last_success_iso: null,
      error: err.message,
      result: "FAILED",
    });
    process.exit(75);
  }

  if (fresh == null) {
    console.error(`[promoter-pit] fetch returned null — preserving existing rolling cache`);
    const prev = (() => {
      try { return JSON.parse(require("node:fs").readFileSync(require("node:path").join(process.cwd(), "data", "promoter-transactions", "last-refresh-status.json"), "utf-8")).last_success_iso || null; } catch { return null; }
    })();
    writeStatus({
      last_attempt_iso: startedAt.toISOString(),
      last_success_iso: prev,
      error: "fetch-returned-null",
      result: "FAILED",
    });
    process.exit(75);
  }

  console.log(`[promoter-pit] fetched ${fresh.length} rows`);

  const existing = loadRolling();
  const merged = mergeIntoRolling(existing, fresh);
  writeRolling(merged);
  console.log(
    `[promoter-pit] rolling: ${merged.transaction_count} txns in last ${merged.window_days}d ` +
    `(was ${existing?.transactions?.length ?? 0}; net +${merged.transaction_count - (existing?.transactions?.length ?? 0)})`,
  );
  writeStatus({
    last_attempt_iso: startedAt.toISOString(),
    last_success_iso: startedAt.toISOString(),
    fresh_count: fresh.length,
    merged_count: merged.transaction_count,
    result: "OK",
  });
}

main().catch((err) => {
  console.error(`[promoter-pit] unexpected:`, err);
  process.exit(1);
});
