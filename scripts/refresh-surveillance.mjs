#!/usr/bin/env node
/**
 * Surveillance Snapshot Refresh — CLI entrypoint for local dev.
 *
 * Pulls the latest ASM + GSM lists from NSE and writes surveillance.json
 * at the repo root. Production uses the Vercel cron endpoint at
 * /api/cron/refresh-surveillance which writes to KV instead.
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
