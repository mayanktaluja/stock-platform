/**
 * Unit tests for the region batch scorer (scripts/sws-scoring-region.mjs) +
 * the region parser currency stamp (scripts/sws-api-parser-region.mjs),
 * exercised for Korea (KRW) and Taiwan (TWD).
 *
 * The underlying scoring MATH is the India implementation (covered by
 * test/swsScoring.test.mjs + test/swsCategorise.test.mjs). This file targets the
 * region-specific behaviour layered on top:
 *   • the canonical dotted ticker key (a-prefix KR / bare-numeric TW)
 *   • currency carriage onto cards — incl. the C1 case: a currency-LESS stock
 *     still cards as the region ISO (the parser + scorer both stamp it, so the
 *     US "always defaults to USD" trap can't recur)
 *   • surveillance explicitly OFF (no NSE GSM/ASM for KR/TW tickers)
 *   • native market-cap gates (region floor / small-cap ceiling)
 *   • no `avoid` section
 *   • the no-pure-numeric invariant: no leaderboard section ever holds a
 *     pure-numeric ticker (so the India BSE filters stay inert)
 *   • robustness to negative/null inputs (loss-makers, neg book→neg P/B, junk FV,
 *     Infinity/NaN, missing axes, zero-coverage momentum)
 *
 * Run with: node test/regionPicksScoring.test.mjs
 */

import {
  scoreStockRegion,
  buildLeaderboardRegion,
  categoriseStockRegion,
  regionCardFields,
} from "../scripts/sws-scoring-region.mjs";
import { parseStockRegion } from "../scripts/sws-api-parser-region.mjs";
import { getRegion } from "../scripts/sws-regions.mjs";
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

// Minimal region deep-stock fixture; native numeric values live in the *_inr-named
// keys (the scorer reads them currency-blind). `currency` is set ONLY when passed,
// so the C1 currency-less path is testable. market cap defaults to 4× the region
// floor so the fixture clears hygiene unless overridden.
function stock(region, overrides = {}) {
  const ov = {
    snowflake: { financial_health: 4, future: 4, valuation: 4, past: 4, dividends: 3 },
    snowflake_total: 19,
    current_price_inr: 100,
    fair_value_inr: 120,
    upside_pct: 20,
    market_cap_inr: region.mcapFloorNative * 4,
    net_margin_pct: 15,
    returns_pct: { "1M": 2, "3M": 6, "1Y": 18 },
    multiples: { pe: 25, pb: 4 },
    dividend: { yield_pct: 1.0, payout_pct: 30 },
    risks: [],
    rewards: [],
    ...(overrides.overview || {}),
  };
  const s = { ticker: overrides.ticker || "TEST", name: overrides.name || "Test", sector: "tech", overview: ov };
  if ("currency" in overrides) s.currency = overrides.currency;
  return s;
}

const universe = { r1m: [-5, 0, 5, 10], r3m: [-10, 0, 10, 20], r1y: [-20, 0, 20, 40] };
const cardOf = (region, s, section = "best_fundamentals") =>
  buildLeaderboardRegion([s], region)[section].find((c) => c.ticker === s.ticker);

// ─── Canonical ticker keys (registry-level) ───
console.log("\nRegion registry — canonical ticker keys\n");
check("KR kose a-prefix stripped → .KS", () => assert.equal(getRegion("kr").tickerKey("kose", "a005930"), "005930.KS"));
check("KR kosdaq → .KQ", () => assert.equal(getRegion("kr").tickerKey("kosdaq", "a355390"), "355390.KQ"));
check("KR konex → .KN", () => assert.equal(getRegion("kr").tickerKey("xkon", "a299480"), "299480.KN"));
check("KR embedded-letter id preserved", () => assert.equal(getRegion("kr").tickerKey("kose", "a0054v0"), "0054v0.KS"));
check("TW twse bare numeric → .TW", () => assert.equal(getRegion("tw").tickerKey("twse", "2330"), "2330.TW"));
check("TW tpex → .TWO", () => assert.equal(getRegion("tw").tickerKey("tpex", "6643"), "6643.TWO"));
check("TW trailing-letter id preserved", () => assert.equal(getRegion("tw").tickerKey("twse", "8349a"), "8349a.TW"));

for (const code of ["kr", "tw"]) {
  const region = getRegion(code);
  const ISO = region.currencyIso;
  const dot = code === "kr" ? ".KS" : ".TW";

  console.log(`\n[${code.toUpperCase()}] currency / surveillance / sections\n`);

  check(`[${code}] explicit ${ISO} flows onto the card`, () => {
    const s = scoreStockRegion(stock(region, { ticker: "AAA" + dot, currency: ISO }), region, { universe });
    assert.equal(cardOf(region, s).currency, ISO);
  });

  check(`[${code}] C1: currency-less stock still cards as ${ISO}`, () => {
    const s = scoreStockRegion(stock(region, { ticker: "BBB" + dot }), region, { universe });
    assert.equal("currency" in s, false); // fixture truly has no currency
    assert.equal(cardOf(region, s).currency, ISO);
  });

  check(`[${code}] surveillance OFF (v2 + v4 breakdown null)`, () => {
    const s = scoreStockRegion(stock(region, { ticker: "X" + dot }), region, { universe });
    assert.equal(s.v4_breakdown.surveillance, null);
    assert.equal(s.v2_breakdown.surveillance, null);
  });

  check(`[${code}] no avoid section`, () => {
    const lb = buildLeaderboardRegion([scoreStockRegion(stock(region), region, { universe })], region);
    assert.ok(!("avoid" in lb), "region leaderboard must not surface an avoid list");
  });

  console.log(`\n[${code.toUpperCase()}] native market-cap gates\n`);

  check(`[${code}] smallcap_gems: half the ceiling qualifies`, () => {
    const s = scoreStockRegion(
      stock(region, {
        ticker: "SMALL" + dot,
        overview: {
          market_cap_inr: region.smallcapCeilingNative * 0.5,
          snowflake_total: 23,
          upside_pct: 20,
          snowflake: { financial_health: 5, future: 5, valuation: 4, past: 5, dividends: 4 },
        },
      }),
      region,
      { universe },
    );
    assert.ok(s.categories.includes("smallcap_gems"));
  });

  check(`[${code}] smallcap_gems: above the ceiling excluded`, () => {
    const s = scoreStockRegion(
      stock(region, {
        ticker: "MID" + dot,
        overview: {
          market_cap_inr: region.smallcapCeilingNative * 1.5,
          snowflake_total: 23,
          upside_pct: 20,
          snowflake: { financial_health: 5, future: 5, valuation: 4, past: 5, dividends: 4 },
        },
      }),
      region,
      { universe },
    );
    assert.ok(!s.categories.includes("smallcap_gems"));
  });

  check(`[${code}] hygiene floor: under-floor excluded from top30, over-floor included`, () => {
    const tiny = scoreStockRegion(stock(region, { ticker: "TINY" + dot, overview: { market_cap_inr: region.mcapFloorNative * 0.8 } }), region, { universe });
    const okay = scoreStockRegion(stock(region, { ticker: "OKAY" + dot, overview: { market_cap_inr: region.mcapFloorNative * 1.2 } }), region, { universe });
    const top = buildLeaderboardRegion([tiny, okay], region).top_ranked_30_v3.map((c) => c.ticker);
    assert.ok(!top.includes("TINY" + dot));
    assert.ok(top.includes("OKAY" + dot));
  });

  console.log(`\n[${code.toUpperCase()}] negative / null robustness\n`);

  check(`[${code}] (a) unprofitable + null FV → imputed, finite`, () => {
    const s = scoreStockRegion(
      stock(region, { ticker: "LOSS" + dot, overview: { net_margin_pct: -120, fair_value_inr: null, upside_pct: null, latest_eps: -5, multiples: { pe: null, pb: -2 } } }),
      region,
      { universe },
    );
    assert.ok(Number.isFinite(s.v4_score_100));
    assert.equal(s.v4_breakdown.fv_imputed, true);
  });

  check(`[${code}] (b) negative upside −45% → pts_fv_total 0`, () => {
    const s = scoreStockRegion(stock(region, { ticker: "EXP" + dot, overview: { current_price_inr: 200, fair_value_inr: 110, upside_pct: -45 } }), region, { universe });
    // V4 renamed pts_fv_upside → pts_fv_total; upside ≤ −10 → 0/12.
    assert.equal(s.v4_breakdown.pts_fv_total, 0);
    assert.ok(cardOf(region, s).upside_pct < 0);
  });

  check(`[${code}] (c) price 8× FV → junk suppressed (upside + FV null)`, () => {
    const s = scoreStockRegion(stock(region, { ticker: "JNK" + dot, overview: { current_price_inr: 100, fair_value_inr: 800, upside_pct: 700 } }), region, { universe });
    const card = cardOf(region, s);
    assert.equal(card.upside_pct, null);
    assert.equal(card.fair_value_inr, null);
  });

  check(`[${code}] (d) missing Snowflake axes → 0, no throw`, () => {
    const s = scoreStockRegion(stock(region, { ticker: "GAP" + dot, overview: { snowflake: { financial_health: 3, valuation: 4 }, snowflake_total: 7 } }), region, { universe });
    assert.ok(Number.isFinite(s.v4_score_100));
    assert.equal(s.v4_breakdown.pts_future, 0);
    // V4 dropped the dividend pillar — there is no pts_dividends key.
    assert.ok(!("pts_dividends" in s.v4_breakdown));
  });

  check(`[${code}] (e) Infinity / NaN → clamped finite, mcap→0 drops from top30`, () => {
    const s = scoreStockRegion(
      stock(region, { ticker: "NAN" + dot, overview: { market_cap_inr: Infinity, upside_pct: NaN, net_margin_pct: Infinity, returns_pct: { "1M": NaN, "3M": Infinity, "1Y": -Infinity } } }),
      region,
      { universe },
    );
    assert.ok(Number.isFinite(s.v4_score_100));
    assert.ok(Number.isFinite(s.composite_score_100));
    assert.ok(!buildLeaderboardRegion([s], region).top_ranked_30_v3.some((c) => c.ticker === "NAN" + dot));
  });

  check(`[${code}] (f) no universe → momentum imputed at p50`, () => {
    const s = scoreStockRegion(stock(region, { ticker: "NOUNI" + dot }), region, {});
    assert.equal(s.v4_breakdown.momentum_imputed, true);
  });

  check(`[${code}] (g) neg P/B + dotted id → no throw, fields carried`, () => {
    const t = code === "kr" ? "005930.KS" : "2330.TW";
    const s = scoreStockRegion(stock(region, { ticker: t, currency: ISO, overview: { multiples: { pe: null, pb: -3 } } }), region, { universe });
    assert.ok(Number.isFinite(s.v4_score_100));
    const card = cardOf(region, s);
    assert.equal(card.ticker, t);
    assert.equal(card.currency, ISO);
  });

  check(`[${code}] categoriseStockRegion tolerates an empty overview`, () => {
    assert.doesNotThrow(() => categoriseStockRegion({ ticker: "EMPTY" + dot, overview: {} }, region));
  });

  check(`[${code}] no leaderboard section holds a pure-numeric ticker`, () => {
    const t = code === "kr" ? "005930.KS" : "2330.TW";
    const s = scoreStockRegion(stock(region, { ticker: t }), region, { universe });
    const lb = buildLeaderboardRegion([s], region);
    for (const [k, arr] of Object.entries(lb)) {
      if (!Array.isArray(arr)) continue;
      for (const c of arr) assert.ok(!/^\d+$/.test(c.ticker), `pure-numeric '${c.ticker}' leaked into ${k}`);
    }
  });
}

// ─── C1 at the parser level: a parser-produced (currency-less) payload gets ISO ───
console.log("\nParser currency stamp (C1 — parser-produced, not hand-injected)\n");
check("parseStockRegion stamps KRW on a currency-less payload", () => {
  const out = parseStockRegion({ ticker: "005930.KS" }, getRegion("kr"), {});
  assert.equal(out.currency, "KRW");
  assert.equal(out.overview?.currency, "KRW");
  assert.equal(out.ticker, "005930.KS"); // dotted key wins, no numeric fallback
});
check("parseStockRegion stamps TWD on a currency-less payload", () => {
  const out = parseStockRegion({ ticker: "2330.TW" }, getRegion("tw"), {});
  assert.equal(out.currency, "TWD");
  assert.equal(out.ticker, "2330.TW");
});

check("V4 surface — scoreStockRegion emits finite v4 fields, no v3 residue, card carries v4", () => {
  const region = getRegion("kr");
  const s = scoreStockRegion(stock(region), region, { universe });
  assert.ok(Number.isFinite(s.v4_score_100));
  // V4 is the sole composite score — the V3 fields were deleted in the migration.
  assert.ok(!("v3_score_100" in s) && !("v3_breakdown" in s) && !("v3_verdict" in s));
  // V4 breakdown uses pts_fv_total; the old pts_fv_upside name is gone.
  assert.ok("pts_fv_total" in s.v4_breakdown && !("pts_fv_upside" in s.v4_breakdown));
  assert.equal(cardOf(region, s).v4_score_100, s.v4_score_100); // regionCardFields spreads pickCardFields → v4 carried
});

check("regionCardFields emits compact finite returns_pct for 1D/7D/1M/3M/1Y", () => {
  const region = getRegion("tw");
  const card = regionCardFields(
    stock(region, {
      ticker: "RET.TW",
      overview: {
        returns_pct: {
          "1D": -0.75,
          "7D": 1.5,
          "1M": 5,
          "3M": 11.25,
          "1Y": 31,
          "5Y": 70,
          bad_null: null,
          bad_nan: NaN,
          bad_inf: Infinity,
        },
      },
    }),
    region,
  );
  assert.deepEqual(card.returns_pct, {
    "1D": -0.75,
    "7D": 1.5,
    "1M": 5,
    "3M": 11.25,
    "1Y": 31,
  });
});

check("regionCardFields drops NaN/Infinity/null returns_pct values", () => {
  const region = getRegion("kr");
  const card = regionCardFields(
    stock(region, {
      ticker: "BADRET.KS",
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
    region,
  );
  assert.deepEqual(card.returns_pct, {});
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
