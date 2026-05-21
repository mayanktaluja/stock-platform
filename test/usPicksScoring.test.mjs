/**
 * Unit tests for the US batch scorer (scripts/sws-scoring-us.mjs).
 *
 * The underlying scoring MATH is the India implementation (covered by
 * test/swsScoring.test.mjs + test/swsCategorise.test.mjs). This file targets
 * the US-specific behaviour layered on top:
 *   • currency carriage onto cards
 *   • surveillance explicitly OFF (no NSE GSM/ASM for US tickers)
 *   • USD market-cap gates ($50M hygiene floor, $2B small-cap ceiling)
 *   • no `avoid` section
 *   • robustness to the negative/null inputs US data hits far more than NSE:
 *     unprofitable (neg margin), price-above-FV (neg upside), missing Snowflake
 *     axes, junk FV (price≫FV), Infinity/NaN, zero-coverage momentum, dotted
 *     tickers + negative P/B.
 *
 * Run with: node test/usPicksScoring.test.mjs
 */

import {
  scoreStockUS,
  buildLeaderboardUS,
  categoriseStockUS,
  MIN_MCAP_USD,
  SMALLCAP_CEILING_USD,
} from "../scripts/sws-scoring-us.mjs";
import assert from "node:assert/strict";

let pass = 0,
  fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ✓", name);
  } catch (e) {
    fail++;
    console.log("  ✗", name, "→", e.message);
  }
}

// Minimal US deep-stock fixture; `overrides.overview` shallow-merges over the
// defaults (pass a full `snowflake` object when overriding it).
function stock(overrides = {}) {
  const ov = {
    snowflake: { financial_health: 4, future: 4, valuation: 4, past: 4, dividends: 3 },
    snowflake_total: 19,
    current_price_inr: 100,
    fair_value_inr: 120,
    upside_pct: 20,
    market_cap_inr: 5_000_000_000,
    net_margin_pct: 15,
    returns_pct: { "1M": 2, "3M": 6, "1Y": 18 },
    multiples: { pe: 25, pb: 4 },
    dividend: { yield_pct: 1.0, payout_pct: 30 },
    risks: [],
    rewards: [],
    ...(overrides.overview || {}),
  };
  return {
    ticker: overrides.ticker || "TEST",
    name: overrides.name || "Test",
    sector: "tech",
    currency: overrides.currency || "USD",
    overview: ov,
  };
}

const universe = { r1m: [-5, 0, 5, 10], r3m: [-10, 0, 10, 20], r1y: [-20, 0, 20, 40] };
const cardOf = (s, section = "best_fundamentals") =>
  buildLeaderboardUS([s])[section].find((c) => c.ticker === s.ticker);

console.log("\nUS scorer — currency / surveillance / sections\n");

check("currency USD flows onto the card", () => {
  const s = scoreStockUS(stock({ ticker: "AAPL" }), { universe });
  assert.equal(cardOf(s).currency, "USD");
});

check("non-USD listing currency is carried, not forced to USD", () => {
  const s = scoreStockUS(stock({ ticker: "TORO", currency: "CAD" }), { universe });
  assert.equal(cardOf(s).currency, "CAD");
});

check("surveillance is OFF (v2 + v3 breakdown surveillance null)", () => {
  const s = scoreStockUS(stock({ ticker: "X" }), { universe });
  assert.equal(s.v3_breakdown.surveillance, null);
  assert.equal(s.v2_breakdown.surveillance, null);
});

check("no `avoid` section in the US leaderboard", () => {
  const lb = buildLeaderboardUS([scoreStockUS(stock(), { universe })]);
  assert.ok(!("avoid" in lb), "US leaderboard must not surface an avoid list");
});

console.log("\nUSD market-cap gates\n");

check("constants are USD ($50M floor, $2B small-cap ceiling)", () => {
  assert.equal(MIN_MCAP_USD, 50_000_000);
  assert.equal(SMALLCAP_CEILING_USD, 2_000_000_000);
});

check("smallcap_gems: $1B qualifies (< $2B ceiling)", () => {
  const s = scoreStockUS(
    stock({
      ticker: "SMALL",
      overview: {
        market_cap_inr: 1_000_000_000,
        snowflake_total: 23,
        upside_pct: 20,
        snowflake: { financial_health: 5, future: 5, valuation: 4, past: 5, dividends: 4 },
      },
    }),
    { universe },
  );
  assert.ok(s.categories.includes("smallcap_gems"));
});

check("smallcap_gems: $3B excluded (> $2B ceiling)", () => {
  const s = scoreStockUS(
    stock({
      ticker: "MID",
      overview: {
        market_cap_inr: 3_000_000_000,
        snowflake_total: 23,
        upside_pct: 20,
        snowflake: { financial_health: 5, future: 5, valuation: 4, past: 5, dividends: 4 },
      },
    }),
    { universe },
  );
  assert.ok(!s.categories.includes("smallcap_gems"));
});

check("hygiene floor: <$50M excluded from top30, ≥$50M included", () => {
  const tiny = scoreStockUS(stock({ ticker: "TINY", overview: { market_cap_inr: 40_000_000 } }), { universe });
  const okay = scoreStockUS(stock({ ticker: "OKAY", overview: { market_cap_inr: 60_000_000 } }), { universe });
  const top = buildLeaderboardUS([tiny, okay]).top_ranked_30_v3.map((c) => c.ticker);
  assert.ok(!top.includes("TINY"));
  assert.ok(top.includes("OKAY"));
});

console.log("\nNegative / null robustness (US hits these far more than NSE)\n");

check("(a) unprofitable + null FV → imputed, finite score, no throw", () => {
  const s = scoreStockUS(
    stock({
      ticker: "LOSS",
      overview: { net_margin_pct: -120, fair_value_inr: null, upside_pct: null, latest_eps: -5, multiples: { pe: null, pb: -2 } },
    }),
    { universe },
  );
  assert.ok(Number.isFinite(s.v3_score_100));
  assert.equal(s.v3_breakdown.fv_imputed, true);
  assert.equal(s.v3_breakdown.pts_fv_upside, 6);
});

check("(b) negative upside −45% → pts_fv_upside 0, card upside negative", () => {
  const s = scoreStockUS(
    stock({ ticker: "EXP", overview: { current_price_inr: 200, fair_value_inr: 110, upside_pct: -45 } }),
    { universe },
  );
  assert.ok(Number.isFinite(s.v3_score_100));
  assert.equal(s.v3_breakdown.pts_fv_upside, 0);
  assert.ok(cardOf(s).upside_pct < 0);
});

check("(c) price 8× FV → junk suppressed (upside + FV null)", () => {
  const s = scoreStockUS(
    stock({ ticker: "JNK", overview: { current_price_inr: 100, fair_value_inr: 800, upside_pct: 700 } }),
    { universe },
  );
  const card = cardOf(s);
  assert.equal(card.upside_pct, null);
  assert.equal(card.fair_value_inr, null);
  assert.equal(card.fv_reconcile_reason, "junk_ratio_high");
});

check("(d) 2 missing Snowflake axes → num→0, no throw", () => {
  const s = scoreStockUS(
    stock({ ticker: "GAP", overview: { snowflake: { financial_health: 3, valuation: 4 }, snowflake_total: 7 } }),
    { universe },
  );
  assert.ok(Number.isFinite(s.v3_score_100));
  assert.equal(s.v3_breakdown.pts_future, 0);
  assert.equal(s.v3_breakdown.pts_dividends, 0);
});

check("(e) Infinity / NaN inputs → clamped, finite scores, no throw", () => {
  const s = scoreStockUS(
    stock({
      ticker: "NAN",
      overview: {
        market_cap_inr: Infinity,
        upside_pct: NaN,
        net_margin_pct: Infinity,
        returns_pct: { "1M": NaN, "3M": Infinity, "1Y": -Infinity },
      },
    }),
    { universe },
  );
  assert.ok(Number.isFinite(s.v3_score_100));
  assert.ok(Number.isFinite(s.composite_score_100));
  // Infinity mcap → num()→0 → below hygiene floor → not in top30
  assert.ok(!buildLeaderboardUS([s]).top_ranked_30_v3.some((c) => c.ticker === "NAN"));
});

check("(f) no universe → momentum imputed at p50", () => {
  const s = scoreStockUS(stock({ ticker: "NOUNI" }), {});
  assert.equal(s.v3_breakdown.momentum_imputed, true);
  assert.equal(s.v3_breakdown.pts_mom_1y, 4); // 0.5 × 8
});

check("(g) dotted ticker + negative P/B + USD → no throw, fields carried", () => {
  const s = scoreStockUS(
    stock({ ticker: "BRK.B", currency: "USD", overview: { multiples: { pe: null, pb: -3 } } }),
    { universe },
  );
  assert.ok(Number.isFinite(s.v3_score_100));
  const card = cardOf(s);
  assert.equal(card.ticker, "BRK.B");
  assert.equal(card.currency, "USD");
});

check("categoriseStockUS tolerates an empty overview", () => {
  assert.doesNotThrow(() => categoriseStockUS({ ticker: "EMPTY", overview: {} }));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
