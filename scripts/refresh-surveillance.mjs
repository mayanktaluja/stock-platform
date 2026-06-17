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
  const strict = process.argv.includes("--strict") || process.env.SWS_SURVEILLANCE_STRICT === "1";
  console.log("Fetching NSE ASM + GSM lists...");
  const snap = await buildSurveillance();
  const failedSources = Object.entries(snap.fetchStatus || {})
    .filter(([, status]) => status !== "ok")
    .map(([source]) => source);
  if (strict && failedSources.length > 0) {
    console.error(`Strict mode: ${failedSources.join(", ")} surveillance fetch failed; refusing to save partial snapshot.`);
    if (snap.fetchErrors) console.error(JSON.stringify(snap.fetchErrors, null, 2));
    process.exit(1);
  }

  const result = await saveSurveillance(snap);

  const counts = snap.counts || { ASM: 0, GSM: 0 };
  const total = Object.keys(snap.flagged || {}).length;
  if (result.skipped) {
    const status = result.status || "preserved-fresh";
    console.log(
      `${result.stale ? "✗" : "✓"} Preserved existing snapshot ` +
      `(${result.existingCount} flagged from ${result.priorDate}, ${result.priorAgeHours ?? "unknown"}h old)`
    );
    console.log(`  Reason: ${result.reason}`);
    console.log(`  Status: ${status}`);
    if (strict && result.stale) {
      console.error("  Strict mode: preserved snapshot is stale; failing refresh.");
      process.exit(1);
    }
    return;
  }

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
    if (strict) {
      console.error("  Strict mode: zero-row surveillance snapshot is not publishable.");
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Refresh failed:", err);
  process.exit(1);
});
