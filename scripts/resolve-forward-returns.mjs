#!/usr/bin/env node
/**
 * resolve-forward-returns.mjs
 *
 * CLI driver for the SEBI-RA Track Record forward-returns resolver.
 *
 * Walks every paper-trade entry, finds horizons whose anniversary has
 * arrived, fetches the close at that anniversary plus the matching
 * benchmark NAV, and writes return + alpha back into the trade log.
 *
 * Usage:
 *   node scripts/resolve-forward-returns.mjs               # resolve as of today
 *   node scripts/resolve-forward-returns.mjs --json        # machine-readable
 *   node scripts/resolve-forward-returns.mjs --as-of=YYYY-MM-DD
 *
 * Idempotent: rows already at status="closed" are skipped on re-run.
 */

import { resolveOpenHorizons } from "../services/trackRecord/forwardReturnsResolver.js";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const asOfArg = args.find((a) => a.startsWith("--as-of="));
const todayIso = asOfArg
  ? new Date(asOfArg.split("=")[1] + "T12:00:00Z").toISOString()
  : new Date().toISOString();

const result = await resolveOpenHorizons({ todayIso });

if (jsonOut) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
}

console.log("Forward returns resolver");
console.log("─────────────────────────");
console.log(`As of:     ${result.todayIso}`);
console.log(`Due:       ${result.due}`);
console.log(`Processed: ${result.processed}`);
console.log("Resolved by horizon:");
for (const [h, n] of Object.entries(result.resolved)) {
  console.log(`  ${h}: ${n}`);
}
if (result.processed === 0) {
  console.log("\n(No anniversaries due — try again after the first 1m horizon lands.)");
}
