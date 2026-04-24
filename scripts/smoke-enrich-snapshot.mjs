#!/usr/bin/env node
/**
 * End-to-end integration smoke test for enrichSnapshot().
 *
 * Spins up a tiny 3-stock snapshot object that mimics the shape
 * fundamentals.json expects, runs enrichSnapshot() over it, and verifies
 * the Phase 1 fields landed on each record. This catches regressions in
 * the Object.assign pathway that the field-level smoke test in
 * smoke-enrichment.mjs doesn't exercise.
 */
import { enrichSnapshot } from "../enrichFundamentals.js";

const snapshot = {
  generatedAt: "2026-04-24T00:00:00Z",
  source: "smoke-test",
  snapshots: {
    "RELIANCE.NS": { symbol: "RELIANCE.NS", name: "Reliance Industries", price: 1400 },
    "TCS.NS":      { symbol: "TCS.NS",      name: "Tata Consultancy",    price: 3500 },
    "MASTEK.NS":   { symbol: "MASTEK.NS",   name: "Mastek",              price: 2200 },
  },
};

console.log("Running enrichSnapshot() end-to-end...\n");
const result = await enrichSnapshot(snapshot, { concurrency: 3 });

console.log(`enriched=${result.enriched} skipped=${result.skipped} failed=${result.failed} duration=${result.durationMs}ms\n`);

const CHECK_FIELDS = [
  "roe", "profitMargin", "forwardEps", "dividendYield",
  "currentRatio", "interestCoverage", "ocfToNetIncome",
];

for (const sym of Object.keys(snapshot.snapshots)) {
  const rec = snapshot.snapshots[sym];
  const missing = CHECK_FIELDS.filter((f) => rec[f] == null);
  const present = CHECK_FIELDS.filter((f) => rec[f] != null);
  const status = missing.length === 0 ? "✓" : missing.length < CHECK_FIELDS.length ? "~" : "✗";
  console.log(`${status} ${sym}`);
  console.log(`    present: ${present.join(", ") || "(none)"}`);
  if (missing.length > 0) console.log(`    missing: ${missing.join(", ")}`);
}

console.log(`\nenrichedAt = ${snapshot.enrichedAt}`);
console.log(`enrichmentSource = ${snapshot.enrichmentSource}`);
