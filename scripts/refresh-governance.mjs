#!/usr/bin/env node
/**
 * Governance Snapshot Refresh — CLI entrypoint for local dev.
 *
 * Pulls NSE shareholding data (promoter holding, pledge %, FII/DII splits,
 * QoQ deltas) for every symbol in the enriched fundamentals universe and
 * writes governance.json at the repo root.
 *
 * Production uses the Vercel cron endpoint at /api/cron/refresh-governance
 * which writes to KV instead.
 *
 * Usage:
 *   node scripts/refresh-governance.mjs              # enriched universe
 *   node scripts/refresh-governance.mjs --sample 20  # first 20 stocks (smoke)
 *
 * NSE requires an Indian IP, so this only works from a machine in India or
 * via a Mumbai VPN. The Vercel bom1 cron works in production without that
 * caveat.
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
  // getAllFundamentals() returns Object.values(snapshots) — an array of
  // {symbol, ...} entries, NOT a keyed map. Object.keys() on an array
  // would give numeric indexes ("0","1","2",...) which then get sent to
  // NSE as bogus tickers and return zero records every time. This bug
  // caused governance.json to sit at counts: { ok: 0, empty: 744 } for
  // months on both local + Vercel paths until 2026-05-13. Extract the
  // symbol field directly and filter out anything malformed (BSE-numeric
  // codes, missing-symbol entries) before sending to NSE.
  const enriched = (getAllFundamentals() || [])
    .map((s) => s?.symbol)
    .filter((sym) => typeof sym === "string" && sym.length > 0);
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
