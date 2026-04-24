#!/usr/bin/env node
/**
 * Phase 1 smoke test for the extended fetchMetrics() in enrichFundamentals.js.
 *
 * Purpose: verify the ~15 newly-added Yahoo fields (forwardEps, pegRatio,
 * dividendYield, payoutRatio, enterpriseToEbitda, etc.) populate for
 * large-caps, degrade gracefully to null for small-caps, and that we stay
 * well inside the 60s Vercel cron budget when wired in.
 *
 * Not a unit test — just prints a coverage matrix so we can eyeball which
 * fields are "thin" for SMID before we design Phase 2 tier-adaptive scoring.
 */
import { fetchMetrics } from "../enrichFundamentals.js";

// Mix of one Nifty 50 large-cap, one mid-cap, one small-cap, one PSU bank,
// and one IT smallcap — spans the tiers we care about for Phase 2.
const SAMPLE = [
  { symbol: "RELIANCE.NS", tier: "large" },
  { symbol: "TCS.NS", tier: "large" },
  { symbol: "SBIN.NS", tier: "large-psu" },
  { symbol: "PERSISTENT.NS", tier: "mid" },
  { symbol: "MASTEK.NS", tier: "small" },
];

const FIELDS = [
  // V1 baseline
  "roe", "debtToEquity", "profitMargin", "revenueGrowthYoY",
  // Future pillar
  "forwardEps", "trailingEps", "pegRatio", "earningsGrowthYoY",
  "forwardEpsGrowth", "analystCoverage",
  // Value supplements
  "priceToBook", "enterpriseToEbitda",
  // Dividend pillar
  "dividendYield", "payoutRatio", "fiveYearAvgDivYield",
  // Health/Quality supplements (summary)
  "ebitda", "totalDebt", "totalCash", "operatingMargins", "grossMargins",
  // Health/Quality (timeSeries — Phase 1.2)
  "currentRatio", "interestCoverage", "ocfToNetIncome", "freeCashFlow",
  "reportingPeriodEnd",
];

const fmt = (v) => {
  if (v == null) return "—";
  if (typeof v !== "number") return String(v);
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (Math.abs(v) >= 1e7) return (v / 1e7).toFixed(2) + "Cr";
  if (Math.abs(v) < 1 && v !== 0) return v.toFixed(4);
  return v.toFixed(2);
};

console.log("Phase 1 fetchMetrics() smoke test");
console.log("=".repeat(80));

const started = Date.now();
const results = {};

for (const { symbol, tier } of SAMPLE) {
  const t0 = Date.now();
  try {
    const m = await fetchMetrics(symbol);
    results[symbol] = { tier, metrics: m, ms: Date.now() - t0 };
    console.log(`✓ ${symbol.padEnd(16)} (${tier.padEnd(10)}) ${Date.now() - t0}ms`);
  } catch (e) {
    results[symbol] = { tier, error: e.message, ms: Date.now() - t0 };
    console.log(`✗ ${symbol.padEnd(16)} (${tier.padEnd(10)}) ERROR: ${e.message}`);
  }
}

console.log();
console.log(`Total: ${Date.now() - started}ms (serial) → ~${Math.round((Date.now() - started) / 4)}ms with concurrency=4`);
console.log();

// Coverage matrix — per-field, is it null?
console.log("Coverage matrix (✓ = populated, · = null):");
console.log();

const header = "field".padEnd(22) + SAMPLE.map((s) => s.symbol.replace(".NS", "").padEnd(14)).join("");
console.log(header);
console.log("─".repeat(header.length));

for (const field of FIELDS) {
  const row = field.padEnd(22) + SAMPLE.map(({ symbol }) => {
    const r = results[symbol];
    if (!r || r.error) return "ERR".padEnd(14);
    const v = r.metrics[field];
    if (v == null) return "·".padEnd(14);
    return fmt(v).padEnd(14);
  }).join("");
  console.log(row);
}

console.log();

// Coverage summary: how many of the 5 stocks got each field?
console.log("Field coverage across sample (n=5):");
for (const field of FIELDS) {
  const populated = SAMPLE.filter(({ symbol }) => {
    const r = results[symbol];
    return r && !r.error && r.metrics[field] != null;
  }).length;
  const bar = "█".repeat(populated) + "░".repeat(5 - populated);
  console.log(`  ${field.padEnd(22)} ${bar} ${populated}/5`);
}
