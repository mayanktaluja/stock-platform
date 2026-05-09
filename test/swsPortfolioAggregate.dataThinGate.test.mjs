/**
 * Regression tests for the data-thin SWS gate in swsPortfolioAggregate.buildTiers.
 *
 * The gate diverts holdings from Tier A (Reductions) to Tier D (Watch) when
 * the SWS deep snapshot is a near-empty shell — Snowflake 0/30 AND every
 * valuation multiple null. This catches recently-demerged tickers like
 * TMCV.NS where the engine produces a low score from missing data, not
 * from a real thesis call.
 *
 * Run with: node --test test/swsPortfolioAggregate.dataThinGate.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTiers, _isSwsDataTooThinToReduce } from "../services/swsPortfolioAggregate.js";

// Build a holding shape compatible with buildTiers. Defaults model a
// "TMCV-shaped" data-thin holding (Snowflake 0/30, multiples all null).
function makeHolding(overrides = {}) {
  const sws = {
    ticker: "TEST",
    v3_score: 17,
    upside_pct: 10,
    next_earnings_date: null,
    snowflake: { total: 0, valuation: 0, future_growth: 0, past_performance: 0, financial_health: 0, dividends: 0 },
    multiples: { pe: null, ps: null, pb: null, ev_ebitda: null },
    ...(overrides.sws || {}),
  };
  return {
    symbol: overrides.symbol || "TEST",
    swsCovered: overrides.swsCovered ?? true,
    action: overrides.action ?? "Reduction-50%",
    currentValue: overrides.currentValue ?? 100000,
    sws,
  };
}

test("predicate: TMCV-shaped (snow=0, multiples all null) → too thin", () => {
  const h = makeHolding();
  assert.equal(_isSwsDataTooThinToReduce(h), true);
});

test("predicate: snow=0 but PE present → NOT too thin", () => {
  const h = makeHolding({ sws: {
    snowflake: { total: 0 },
    multiples: { pe: 22, ps: null, pb: null, ev_ebitda: null },
  }});
  assert.equal(_isSwsDataTooThinToReduce(h), false);
});

test("predicate: snow=4 (one non-zero pillar), no multiples → NOT too thin", () => {
  const h = makeHolding({ sws: {
    snowflake: { total: 4, dividends: 4 },
    multiples: { pe: null, ps: null, pb: null, ev_ebitda: null },
  }});
  assert.equal(_isSwsDataTooThinToReduce(h), false);
});

test("predicate: missing snowflake field defaults to 0 — falls back gracefully", () => {
  const h = { sws: { multiples: { pe: null, ps: null, pb: null, ev_ebitda: null } } };
  assert.equal(_isSwsDataTooThinToReduce(h), true);
});

test("predicate: snowflake_total flat field (no .total subkey) read correctly", () => {
  const h = { sws: { snowflake_total: 0, multiples: { pe: null, ps: null, pb: null, ev_ebitda: null } } };
  assert.equal(_isSwsDataTooThinToReduce(h), true);
});

test("buildTiers: TMCV-shaped Reduction → Tier D Watch with insufficient-coverage reason", () => {
  const h = makeHolding({ symbol: "TMCV", action: "Reduction-50%" });
  const r = buildTiers([h]);
  assert.equal(r.tierA.length, 0, "should not be in Tier A");
  assert.equal(r.tierD.length, 1, "should be in Tier D");
  assert.equal(r.tierD[0].symbol, "TMCV");
  assert.match(r.tierD[0].watchReason, /Insufficient SWS coverage/);
  assert.equal(r.freedRupees, 0, "no freed cash since nothing routed to Tier A");
});

test("buildTiers: data-thin EXIT-now also routes to Tier D (any reduction action)", () => {
  const h = makeHolding({ symbol: "TMCV", action: "EXIT-now" });
  const r = buildTiers([h]);
  assert.equal(r.tierA.length, 0);
  assert.equal(r.tierD.length, 1);
  assert.match(r.tierD[0].watchReason, /Insufficient SWS coverage/);
});

test("buildTiers: genuinely weak holding (snow=4, real multiples) STAYS in Tier A", () => {
  const h = makeHolding({
    symbol: "WEAKCO",
    action: "Reduction-50%",
    currentValue: 50000,
    sws: {
      snowflake: { total: 4, dividends: 4 },
      multiples: { pe: 80, ps: 5, pb: 12, ev_ebitda: 40 },
    },
  });
  const r = buildTiers([h]);
  assert.equal(r.tierA.length, 1, "should stay in Tier A");
  assert.equal(r.tierD.length, 0);
  assert.equal(r.tierA[0].symbol, "WEAKCO");
  assert.equal(r.freedRupees, 25000, "50% of ₹50k currentValue");
});

test("buildTiers: data-thin HOLD does NOT trigger gate (gate scoped to reductions)", () => {
  const h = makeHolding({ symbol: "TMCVHOLD", action: "HOLD" });
  const r = buildTiers([h]);
  // HOLD with v3=17 (< 25) lands in Tier D via the existing low-score watch
  // rule, NOT via the new data-thin gate. Reason text differs.
  assert.equal(r.tierA.length, 0);
  assert.equal(r.tierD.length, 1);
  assert.doesNotMatch(r.tierD[0].watchReason, /Insufficient SWS coverage/,
    "HOLD path should use the existing low-score reason, not the new gate reason");
  assert.match(r.tierD[0].watchReason, /Low score/);
});

test("buildTiers: data-thin Top-up (hypothetical) does NOT trigger gate", () => {
  // Top-up actions don't route through buildTiers' tierA path at all — they
  // flow into baskets via classifyBasket. The gate is by-design scoped only
  // to reductions, so a data-thin Top-up should be a no-op here (stays in
  // neither A, C, nor D).
  const h = makeHolding({ symbol: "WEIRD", action: "Top-up-25%" });
  const r = buildTiers([h]);
  assert.equal(r.tierA.length, 0);
  assert.equal(r.tierC.length, 0);
  assert.equal(r.tierD.length, 0);
});

test("buildTiers: !swsCovered path still uses original 'No SWS data' message", () => {
  const h = makeHolding({ symbol: "MISSING", swsCovered: false, action: "Reduction-50%" });
  const r = buildTiers([h]);
  assert.equal(r.tierA.length, 0);
  assert.equal(r.tierD.length, 1);
  assert.match(r.tierD[0].watchReason, /No SWS data/,
    "uncovered ticker must use the original message, not the new gate's text");
});

test("buildTiers: mixed book — TMCV→D, real-weak→A, healthy-HOLD→C", () => {
  const tmcv = makeHolding({ symbol: "TMCV", action: "Reduction-50%", currentValue: 100000 });
  const weakco = makeHolding({
    symbol: "WEAKCO",
    action: "Reduction-50%",
    currentValue: 60000,
    sws: {
      snowflake: { total: 8, dividends: 4, financial_health: 4 },
      multiples: { pe: 35, ps: 4, pb: 6, ev_ebitda: 22 },
    },
  });
  const healthy = makeHolding({
    symbol: "GOODCO",
    action: "HOLD",
    sws: {
      v3_score: 55,
      upside_pct: 8,
      snowflake: { total: 18, financial_health: 5, future_growth: 4, dividends: 4 },
      multiples: { pe: 18, ps: 2, pb: 3, ev_ebitda: 10 },
    },
  });
  const r = buildTiers([tmcv, weakco, healthy]);
  assert.equal(r.tierA.length, 1);
  assert.equal(r.tierA[0].symbol, "WEAKCO");
  assert.equal(r.tierC.length, 1);
  assert.equal(r.tierC[0].symbol, "GOODCO");
  assert.equal(r.tierD.length, 1);
  assert.equal(r.tierD[0].symbol, "TMCV");
  assert.equal(r.freedRupees, 30000, "only WEAKCO contributes (50% of 60k)");
});
