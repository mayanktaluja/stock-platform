#!/usr/bin/env node
/**
 * NSE Corporate Activity Refresh — local-only fetch script.
 *
 * Fetches:
 *   1. /api/corporate-announcements?index=equities      — latest 20
 *   2. /api/snapshot-capital-market-largedeal           — today's bulk + block
 *
 * Writes:
 *   data/catalysts/nse-announcements-rolling.json   (30-day rolling)
 *   data/catalysts/nse-bulk-block-rolling.json      (7-day rolling)
 *
 * Both files merge incrementally: each run pulls the latest tape and
 * folds it into the existing rolling window. So running this twice a
 * day (morning + evening) progressively builds a richer signal set
 * even though each individual fetch is small.
 *
 * MUST run from your local machine — NSE rejects Vercel datacenter
 * IPs from the cookie-source endpoint (see nse.js:76-83). Vercel cron
 * just reads the JSON files.
 *
 * Suggested cadence:
 *   - Morning  (~07:30 IST) — captures pre-market announcements + EOD
 *                              previous-day deals
 *   - Evening  (~17:00 IST) — captures intraday flow + late filings
 *
 * After running, COMMIT the JSON files. The earnings refresh script
 * (refresh-earnings.mjs) reads them at next run.
 *
 * Exit codes:
 *   0  full success (both endpoints returned data)
 *   3  partial success — one endpoint failed, the other landed
 *   75 EX_TEMPFAIL — both endpoints failed; existing JSONs preserved
 *   1  unexpected error
 */

import {
  fetchLatestAnnouncements,
  loadAnnouncementsRolling,
  mergeIntoRolling as mergeAnnouncementsIntoRolling,
  writeAnnouncementsRolling,
} from "../services/earnings/nseAnnouncementsIngester.js";
import {
  fetchTodaysDeals,
  loadDealsRolling,
  mergeIntoRolling as mergeDealsIntoRolling,
  writeDealsRolling,
} from "../services/earnings/nseBulkBlockIngester.js";

async function refreshAnnouncements() {
  console.log(`[nse-corp] fetching corporate announcements...`);
  const fresh = await fetchLatestAnnouncements();
  if (fresh == null) {
    console.error(`[nse-corp] announcements fetch FAILED — preserving existing rolling cache`);
    return false;
  }
  console.log(`[nse-corp] fetched ${fresh.length} fresh announcements`);

  const existing = loadAnnouncementsRolling();
  const merged = mergeAnnouncementsIntoRolling(existing, fresh);
  writeAnnouncementsRolling(merged);
  console.log(
    `[nse-corp] announcements rolling: ${merged.announcement_count} items in last ${merged.window_days}d ` +
      `(was ${existing?.announcement_count ?? 0}; net +${merged.announcement_count - (existing?.announcement_count ?? 0)})`,
  );
  return true;
}

async function refreshDeals() {
  console.log(`[nse-corp] fetching bulk/block deals...`);
  const fresh = await fetchTodaysDeals();
  if (fresh == null) {
    console.error(`[nse-corp] bulk/block fetch FAILED — preserving existing rolling cache`);
    return false;
  }
  console.log(
    `[nse-corp] fetched ${fresh.bulk.length} bulk + ${fresh.block.length} block deals (as_on_date=${fresh.as_on_date})`,
  );

  const existing = loadDealsRolling();
  const merged = mergeDealsIntoRolling(existing, fresh.bulk, fresh.block);
  writeDealsRolling(merged);
  console.log(
    `[nse-corp] deals rolling: ${merged.deal_count} items in last ${merged.window_days}d ` +
      `(was ${existing?.deal_count ?? 0}; net +${merged.deal_count - (existing?.deal_count ?? 0)})`,
  );
  return true;
}

async function main() {
  const annOk = await refreshAnnouncements();
  const dealOk = await refreshDeals();

  if (annOk && dealOk) {
    console.log(`[nse-corp] DONE — full success`);
    process.exitCode = 0;
  } else if (annOk || dealOk) {
    console.warn(`[nse-corp] DONE — partial success (announcements:${annOk}, deals:${dealOk})`);
    process.exitCode = 3;
  } else {
    console.error(`[nse-corp] FAILED — both endpoints failed; nothing committed`);
    process.exitCode = 75;
  }
}

try {
  await main();
} catch (err) {
  console.error(`[nse-corp] FATAL:`, err.stack || err.message);
  process.exitCode = 1;
}
