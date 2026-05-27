/**
 * Regression tests for Track Record headline KPI math.
 *
 * Run with: node test/paperTradesPerformance.test.mjs
 */

import { aggregatePerformance, computeReturns } from "../paperTrades.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

function trade(overrides = {}) {
  return {
    id: "t",
    type: "sws_top30_v3",
    symbol: "TEST.NS",
    name: "Test Ltd",
    snapshotAt: "2026-05-01T04:00:00.000Z",
    priceAtSnapshot: 100,
    niftyAtSnapshot: 24000,
    ...overrides,
  };
}

console.log("paperTrades performance regression\n");

// ──── 1. Empty input stays honest-null ────
{
  const perf = aggregatePerformance([]);
  assert("empty aggregate keeps winRate null", perf.winRate === null, perf);
  assert("empty aggregate keeps avgAlpha null", perf.avgAlpha === null, perf);
  assert("empty aggregate keeps beatsNiftyRate null", perf.beatsNiftyRate === null, perf);
}

// ──── 2. Closed rows compute realised returns without a live current price ────
{
  const winner = trade({
    id: "winner",
    closedAt: "2026-05-03T04:00:00.000Z",
    closingPrice: 112,
    niftyAtClose: 24240,
  });
  const loser = trade({
    id: "loser",
    closedAt: "2026-05-03T04:00:00.000Z",
    closingPrice: 96,
    niftyAtClose: 24240,
  });
  const rows = [winner, loser].map((row) => ({ ...row, returns: computeReturns(row, null, null) }));
  const perf = aggregatePerformance(rows);
  assert("closed rows produce returnPct without current price", rows.every((row) => row.returns.returnPct != null), rows);
  assert("closed rows populate hit rate", perf.winRate === 50, perf);
  assert("closed rows populate avg alpha", perf.avgAlpha === 3, perf);
  assert("closed rows populate beat-Nifty rate", perf.beatsNiftyRate === 50, perf);
}

// ──── 3. Return-only rows populate hit rate but leave benchmark metrics null ────
{
  const rows = [
    { ...trade({ id: "up", niftyAtSnapshot: null }), returns: { returnPct: 10 } },
    { ...trade({ id: "down", niftyAtSnapshot: null }), returns: { returnPct: -4 } },
  ];
  const perf = aggregatePerformance(rows);
  assert("return-only rows populate hit rate", perf.winRate === 50, perf);
  assert("return-only rows populate avg return fallback", perf.avgReturn === 3, perf);
  assert("return-only rows keep avg alpha null", perf.avgAlpha === null, perf);
  assert("return-only rows keep beat-Nifty rate null", perf.beatsNiftyRate === null, perf);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
