#!/usr/bin/env node
/**
 * Surveillance Snapshot Refresh — CLI entrypoint.
 *
 * Pulls the latest ASM + GSM lists from NSE and writes surveillance.json
 * at the repo root. The canonical refresh path is the nightly chain
 * (scripts/sws-nightly.sh step 3c) running from an Indian-IP machine —
 * the Vercel cron at /api/cron/refresh-surveillance silently no-ops
 * because NSE blocks Vercel datacenter IPs.
 *
 * Usage:
 *   node scripts/refresh-surveillance.mjs
 */

import { buildSurveillance, saveSurveillance } from "../surveillance.js";

async function main() {
  console.log("Fetching NSE ASM + GSM lists...");
  const snap = await buildSurveillance();

  const result = await saveSurveillance(snap);

  const counts = snap.counts || { ASM: 0, GSM: 0 };
  const total = Object.keys(snap.flagged || {}).length;
  console.log(
    `✓ Wrote ${result.target}${result.path ? " → " + result.path : ""}`
  );
  console.log(
    `  ${total} unique flagged (ASM: ${counts.ASM}, GSM: ${counts.GSM}) · fetchedAt=${snap.fetchedAt}`
  );

  if (total === 0) {
    console.warn(
      "\n  ⚠  Zero flagged stocks — possible NSE outage. Not overwriting cache if one exists on next run should be verified."
    );
  }
}

main().catch((err) => {
  console.error("Refresh failed:", err);
  process.exit(1);
});
