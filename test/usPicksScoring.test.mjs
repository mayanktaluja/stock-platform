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
  usCardFields,
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

check("surveillance is OFF (v2 + v4 breakdown surveillance null)", () => {
  const s = scoreStockUS(stock({ ticker: "X" }), { universe });
  assert.equal(s.v4_breakdown.surveillance, null);
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
  const lb = buildLeaderboardUS([tiny, okay]);
  const top = lb.top_ranked_30_v4.map((c) => c.ticker);
  assert.ok(!top.includes("TINY"));
  assert.ok(top.includes("OKAY"));
  assert.equal(lb.top_ranked_30_v3, lb.top_ranked_30_v4);
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
  assert.ok(Number.isFinite(s.v4_score_100));
  assert.equal(s.v4_breakdown.fv_imputed, true);
  // V4 renamed the FV sub-field pts_fv_upside → pts_fv_total. Both value
  // sub-signals absent (no analyst upside, no industry P/E) → neutral 6/12.
  assert.equal(s.v4_breakdown.pts_fv_total, 6);
});

check("(b) negative upside −45% → pts_fv_total 0, card upside negative", () => {
  const s = scoreStockUS(
    stock({ ticker: "EXP", overview: { current_price_inr: 200, fair_value_inr: 110, upside_pct: -45 } }),
    { universe },
  );
  assert.ok(Number.isFinite(s.v4_score_100));
  // upside ≤ −10 → analyst-upside sub fraction 0 (the only present sub) → 0/12.
  assert.equal(s.v4_breakdown.pts_fv_total, 0);
  assert.ok(cardOf(s).upside_pct < 0);
});

check("(c) price to FV ratio 8× → valid under shared 10× reconcile policy", () => {
  const s = scoreStockUS(
    stock({ ticker: "JNK", overview: { current_price_inr: 100, fair_value_inr: 800, upside_pct: 700 } }),
    { universe },
  );
  const card = cardOf(s);
  assert.equal(card.upside_pct, 700);
  assert.equal(card.fair_value_inr, 800);
  assert.equal(card.fv_reconcile_reason, "ok");
});

check("(c2) price to FV ratio >10× → raw SWS FV preserved", () => {
  const s = scoreStockUS(
    stock({ ticker: "JNK2", overview: { current_price_inr: 100, fair_value_inr: 1100, upside_pct: 1000 } }),
    { universe },
  );
  const card = cardOf(s);
  assert.equal(card.upside_pct, 1000);
  assert.equal(card.fair_value_inr, 1100);
  assert.equal(card.fv_reconcile_reason, "ok_sws_raw_fv");
  assert.equal(card.fair_value_source, "sws_raw_fv");
  assert.equal(card.upside_source, "computed_from_sws_fv_price");
});

check("(d) 2 missing Snowflake axes → num→0, no throw", () => {
  const s = scoreStockUS(
    stock({ ticker: "GAP", overview: { snowflake: { financial_health: 3, valuation: 4 }, snowflake_total: 7 } }),
    { universe },
  );
  assert.ok(Number.isFinite(s.v4_score_100));
  // Missing `future` axis → its pillar scores 0.
  assert.equal(s.v4_breakdown.pts_future, 0);
  // V4 dropped the dividend pillar entirely — there is no pts_dividends key.
  assert.ok(!("pts_dividends" in s.v4_breakdown));
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
  assert.ok(Number.isFinite(s.v4_score_100));
  assert.ok(Number.isFinite(s.composite_score_100));
  // Infinity mcap → num()→0 → below hygiene floor → not in top30
  assert.ok(!buildLeaderboardUS([s]).top_ranked_30_v4.some((c) => c.ticker === "NAN"));
});

check("(f) no universe → momentum imputed at p50", () => {
  const s = scoreStockUS(stock({ ticker: "NOUNI" }), {});
  assert.equal(s.v4_breakdown.momentum_imputed, true);
  assert.equal(s.v4_breakdown.pts_mom_1y, 3.5); // 0.5 × 7 (V4 1Y momentum weight is 7, was 8 in V3)
});

check("(g) dotted ticker + negative P/B + USD → no throw, fields carried", () => {
  const s = scoreStockUS(
    stock({ ticker: "BRK.B", currency: "USD", overview: { multiples: { pe: null, pb: -3 } } }),
    { universe },
  );
  assert.ok(Number.isFinite(s.v4_score_100));
  const card = cardOf(s);
  assert.equal(card.ticker, "BRK.B");
  assert.equal(card.currency, "USD");
});

check("categoriseStockUS tolerates an empty overview", () => {
  assert.doesNotThrow(() => categoriseStockUS({ ticker: "EMPTY", overview: {} }));
});

check("V4 surface — scoreStockUS emits finite v4 fields, no v3 residue, card carries v4", () => {
  const s = scoreStockUS(
    stock({ overview: { snowflake: { financial_health: 5, future: 4, valuation: 4, past: 4, dividends: 3 }, upside_pct: 12, returns_pct: { "1Y": 10, "3M": 3, "1M": 1 } } }),
    { universe },
  );
  assert.ok(Number.isFinite(s.v4_score_100));
  // V4 is the sole composite score — the V3 fields were deleted in the migration.
  assert.ok(!("v3_score_100" in s) && !("v3_breakdown" in s) && !("v3_verdict" in s));
  // V4 breakdown uses pts_fv_total; the old pts_fv_upside name is gone.
  assert.ok("pts_fv_total" in s.v4_breakdown && !("pts_fv_upside" in s.v4_breakdown));
  assert.equal(s.canonical_score.version, "v4");
  assert.ok(s.regulatory_flags);
  assert.ok(s.risk_overlay);
  assert.equal(cardOf(s).v4_score_100, s.v4_score_100); // usCardFields spreads pickCardFields → v4 carried
});

check("usCardFields emits compact finite returns_pct for 1D/7D/1M/3M/1Y", () => {
  const card = usCardFields(
    stock({
      ticker: "USRET",
      overview: {
        returns_pct: {
          "1D": -0.5,
          "7D": 2.25,
          "1M": 6,
          "3M": 13.5,
          "1Y": 28,
          "5Y": 80,
          bad_null: null,
          bad_nan: NaN,
          bad_inf: Infinity,
        },
      },
    }),
  );
  assert.deepEqual(card.returns_pct, {
    "1D": -0.5,
    "7D": 2.25,
    "1M": 6,
    "3M": 13.5,
    "1Y": 28,
  });
});

check("usCardFields drops NaN/Infinity/null returns_pct values", () => {
  const card = usCardFields(
    stock({
      ticker: "USBADRET",
      overview: {
        returns_pct: {
          "1D": NaN,
          "7D": Infinity,
          "1M": -Infinity,
          "3M": null,
          "1Y": undefined,
        },
      },
    }),
  );
  assert.deepEqual(card.returns_pct, {});
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
