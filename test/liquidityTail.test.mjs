/**
 * Regression tests for services/liquidityTail.js — the market-cap-based
 * days-to-exit bucketing that powers the liquidity-tail bar in the
 * analyzer report.
 *
 * Covers:
 *   • Market-cap thresholds (large / mid-large / mid-small / small/micro)
 *   • Surveillance escalation (ASM/GSM bumps one bucket worse)
 *   • No-SWS-coverage → "no-data" bucket
 *   • Aggregate ₹ math + percentages + illiquid roll-up
 *   • Empty portfolio → zero-everything (no NaN)
 *
 * Run with: node test/liquidityTail.test.mjs
 */

import { bucketHolding, bucketByDaysToExit } from "../services/liquidityTail.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", got);
  }
}

// Helpers — build a minimal holding shape the bucketer expects.
function holding(symbol, mcCr, currentValue, surveillance = null, swsCovered = true) {
  return {
    symbol,
    swsCovered,
    currentValue,
    sws: swsCovered ? {
      ticker: symbol,
      market_cap_inr: mcCr * 1e7, // ₹ Crores → ₹
      surveillance,
    } : null,
  };
}

// ──────────────────── bucketHolding ────────────────────

console.log("\nbucketHolding\n");
assert("Large cap (₹60k Cr) → <1d",   bucketHolding(holding("RELIANCE", 60000, 100000)) === "<1d",   bucketHolding(holding("RELIANCE", 60000, 100000)));
assert("Large cap (₹50k Cr exact) → <1d", bucketHolding(holding("X", 50000, 100000)) === "<1d", bucketHolding(holding("X", 50000, 100000)));
assert("Mid-large (₹20k Cr) → 1-5d",  bucketHolding(holding("Y", 20000, 100000)) === "1-5d",  bucketHolding(holding("Y", 20000, 100000)));
assert("Mid-small (₹5k Cr) → 5-10d",  bucketHolding(holding("Z", 5000, 100000)) === "5-10d", bucketHolding(holding("Z", 5000, 100000)));
assert("Small (₹1k Cr) → >10d",       bucketHolding(holding("A", 1000, 100000)) === ">10d",  bucketHolding(holding("A", 1000, 100000)));
assert("Micro (₹100 Cr) → >10d",      bucketHolding(holding("B", 100, 100000)) === ">10d",   bucketHolding(holding("B", 100, 100000)));

// Surveillance escalation
assert("ASM on large cap → 1-5d (bumped one tier)",
  bucketHolding(holding("X", 60000, 100000, { list: "ASM" })) === "1-5d",
  bucketHolding(holding("X", 60000, 100000, { list: "ASM" })));
assert("GSM on mid-small → >10d",
  bucketHolding(holding("X", 5000, 100000, { list: "GSM", stage: 3 })) === ">10d",
  bucketHolding(holding("X", 5000, 100000, { list: "GSM", stage: 3 })));
assert("GSM on small (already >10d) → stays >10d",
  bucketHolding(holding("X", 500, 100000, { list: "GSM", stage: 5 })) === ">10d",
  bucketHolding(holding("X", 500, 100000, { list: "GSM", stage: 5 })));

// No-data
assert("No SWS coverage → no-data",   bucketHolding(holding("X", 60000, 100000, null, false)) === "no-data", bucketHolding(holding("X", 60000, 100000, null, false)));
assert("Missing market cap → no-data",
  bucketHolding({ symbol: "X", swsCovered: true, currentValue: 100000, sws: { ticker: "X" } }) === "no-data",
  null);
assert("Zero market cap → no-data",
  bucketHolding({ symbol: "X", swsCovered: true, currentValue: 100000, sws: { ticker: "X", market_cap_inr: 0 } }) === "no-data",
  null);

// ──────────────────── bucketByDaysToExit ────────────────────

console.log("\nbucketByDaysToExit\n");

{
  // Mixed portfolio — one large, one mid-large, one small, one no-data.
  const r = bucketByDaysToExit([
    holding("RELIANCE", 60000, 100000),  // <1d
    holding("HDFCBANK", 25000, 50000),   // 1-5d (₹15-50k Cr)
    holding("SMALLCAP", 1500, 30000),    // >10d
    holding("STUCK", 60000, 20000, null, false), // no-data (despite mc, swsCovered=false)
  ]);
  assert("totalValue = 200K", r.totalValue === 200000, r.totalValue);
  assert("<1d = ₹100K (RELIANCE)", r.buckets["<1d"] === 100000, r.buckets["<1d"]);
  assert("1-5d = ₹50K (HDFCBANK)", r.buckets["1-5d"] === 50000, r.buckets["1-5d"]);
  assert(">10d = ₹30K (SMALLCAP)", r.buckets[">10d"] === 30000, r.buckets[">10d"]);
  assert("no-data = ₹20K (STUCK)", r.buckets["no-data"] === 20000, r.buckets["no-data"]);
  assert("<1d = 50%", r.pct["<1d"] === 50, r.pct["<1d"]);
  assert("1-5d = 25%", r.pct["1-5d"] === 25, r.pct["1-5d"]);
  assert("illiquid = ₹50K (>10d + no-data)", r.illiquidValue === 50000, r.illiquidValue);
  assert("illiquidPct = 25", r.illiquidPct === 25, r.illiquidPct);
}

{
  // Empty portfolio
  const r = bucketByDaysToExit([]);
  assert("empty → totalValue 0", r.totalValue === 0, r.totalValue);
  assert("empty → all buckets 0",
    r.buckets["<1d"] === 0 && r.buckets["1-5d"] === 0 && r.buckets["5-10d"] === 0 && r.buckets[">10d"] === 0 && r.buckets["no-data"] === 0,
    r.buckets);
  assert("empty → all pct 0 (no NaN)",
    r.pct["<1d"] === 0 && r.pct["1-5d"] === 0,
    r.pct);
}

{
  // Tickers list per bucket — used for drill-down on hover.
  const r = bucketByDaysToExit([
    holding("RELIANCE", 60000, 100000),
    holding("TCS", 100000, 80000),
  ]);
  assert("tickersByBucket['<1d'] has both names",
    r.tickersByBucket["<1d"].includes("RELIANCE") && r.tickersByBucket["<1d"].includes("TCS"),
    r.tickersByBucket["<1d"]);
}

{
  // Surveillance escalates a large cap → 1-5d, not <1d.
  const r = bucketByDaysToExit([
    holding("FLAGGED", 60000, 100000, { list: "GSM", stage: 3 }),
  ]);
  assert("GSM-3 large cap lands in 1-5d", r.buckets["1-5d"] === 100000, r.buckets);
}

// ──────────────────── Summary ────────────────────

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
