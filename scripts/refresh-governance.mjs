#!/usr/bin/env node
/**
 * Governance Snapshot Refresh — CLI entrypoint.
 *
 * Pulls NSE shareholding data (promoter holding, pledge %, FII/DII splits,
 * QoQ deltas) for every symbol in the enriched fundamentals universe and
 * writes governance.json at the repo root.
 *
 * The canonical refresh path is the nightly chain (scripts/sws-nightly.sh
 * step 3c) running from an Indian-IP machine. The Vercel cron at
 * /api/cron/refresh-governance silently no-ops — NSE blocks Vercel
 * datacenter IPs (see gated/app.js loadSnapshotHealth + CLAUDE.md).
 *
 * Usage:
 *   node scripts/refresh-governance.mjs              # enriched universe
 *   node scripts/refresh-governance.mjs --sample 20  # first 20 stocks (smoke)
 *
 * NSE requires an Indian IP, so this only works from a machine in India or
 * via a Mumbai VPN — which is exactly why it must run in the local nightly
 * chain rather than relying on the Vercel cron.
 *
 * Runtime: ~500 symbols × ~250ms per call with concurrency=3 ≈ 40-60s.
 */

import { buildGovernance, saveGovernance } from "../governance.js";
import { getAllFundamentals } from "../fundamentals.js";

function parseArg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

async function main() {
  const enriched = Object.keys(getAllFundamentals() || {});
  if (enriched.length === 0) {
    console.error("No enriched fundamentals found — run refresh-fundamentals first.");
    process.exit(1);
  }

  let symbols = enriched;
  const sample = parseInt(parseArg("sample"), 10);
  if (Number.isFinite(sample) && sample > 0) {
    symbols = enriched.slice(0, sample);
    console.log(`Sample mode: first ${symbols.length} symbols only.`);
  }

  console.log(`Fetching NSE shareholding for ${symbols.length} symbols...`);
  const startedAt = Date.now();
  const snap = await buildGovernance({
    symbols,
    concurrency: 3,
    delayMs: 250,
    onProgress: (done, total, sym) => {
      if (done % 25 === 0 || done === total) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
        process.stdout.write(`\r  [${done}/${total}] ${sym.padEnd(20)} (${elapsed}s)`);
      }
    },
  });
  process.stdout.write("\n");

  const result = await saveGovernance(snap);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const ok = snap.counts?.ok ?? 0;
  const empty = snap.counts?.empty ?? 0;

  console.log(
    `\n✓ Wrote ${result.target}${result.path ? " → " + result.path : ""} in ${elapsed}s`
  );
  console.log(
    `  ${ok} records populated, ${empty} empty/unavailable · fetchedAt=${snap.fetchedAt}`
  );

  if (ok < symbols.length * 0.2) {
    console.warn(
      "\n  ⚠  Low yield (<20%). Likely causes: non-Indian IP, expired NSE cookies, " +
      "or endpoint schema drift. Inspect 1-2 failing symbols manually before " +
      "trusting the snapshot."
    );
  }
}

main().catch((err) => {
  console.error("\nRefresh failed:", err);
  process.exit(1);
});
