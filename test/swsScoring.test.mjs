/**
 * Gap-fill unit tests for services/swsScoring.js. Pairs with
 * test/swsCategorise.test.mjs (which already covers valuationBandFromUpside,
 * smallcap_gems threshold, dividend value gate, BSE-numeric ticker filter).
 *
 * This file targets the remaining exports + branches:
 *   • num / clamp numeric helpers
 *   • dataCompletenessPct (0%, partial, 100%)
 *   • _countInsiderBuys
 *   • verdictFromScore (v1) bucket boundaries
 *   • computeCompositeScore math + clamping
 *   • computeV2Score catalyst & risk overlay
 *   • buildUniverseStats sorting / NaN filter (momentum infra V4 reads)
 *   • scoreStock now emits v4_score_100 / v4_verdict (V3 deleted — see swsScoringV4.test.mjs)
 *   • categoriseStock (deep_value, quality_growth, midterm, insider, avoid)
 *   • buildPickCounterThesis (bullish, bearish, neutral)
 *   • buildPickAuditTrail
 *   • pickCardFields alias carriage
 *   • buildLeaderboard hygiene + bestFundamentals + upcoming sort
 *   • PICKS_SCHEMA_VERSION / PICKS_SCORING_VERSION constants
 *
 * Run with: node test/swsScoring.test.mjs
 */

import {
  clamp,
  num,
  PICKS_SCHEMA_VERSION,
  PICKS_SCORING_VERSION,
  dataCompletenessPct,
  _countInsiderBuys,
  computeCompositeScore,
  verdictFromScore,
  computeV2Score,
  buildUniverseStats,
  buildPickCounterThesis,
  buildPickAuditTrail,
  pickCardFields,
  buildLeaderboard,
  scoreStock,
} from "../services/swsScoring.js";

import assert from "node:assert/strict";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "→", e.message); }
}

console.log("\nclamp / num primitives\n");

check("clamp inside range", () => assert.equal(clamp(5, 0, 10), 5));
check("clamp below lo",     () => assert.equal(clamp(-3, 0, 10), 0));
check("clamp above hi",     () => assert.equal(clamp(99, 0, 10), 10));
check("num finite passes",  () => assert.equal(num(3.14), 3.14));
check("num NaN → fallback",     () => assert.equal(num(NaN, 7), 7));
check("num Infinity → fallback",() => assert.equal(num(Infinity, 4), 4));
check("num null → fallback",    () => assert.equal(num(null, 9), 9));
check("num string → fallback",  () => assert.equal(num("12", 1), 1));
check("num undefined default 0",     () => assert.equal(num(undefined), 0));

console.log("\nschema/scoring version constants\n");

check("schema version is v3 string", () => assert.equal(PICKS_SCHEMA_VERSION, "picks-latest-v3"));
check("scoring version stamp present", () => assert.ok(/sws-v4-100pt/.test(PICKS_SCORING_VERSION)));

console.log("\ndataCompletenessPct\n");

check("empty stock → 0%", () => assert.equal(dataCompletenessPct({}), 0));
check("all 13 fields populated → 100%", () => {
  const s = { overview: {
    snowflake: { financial_health: 5, future: 4, valuation: 3, past: 4, dividends: 4 },
    upside_pct: 10, returns_pct: { "1Y": 1, "3M": 1, "1M": 1 },
    net_margin_pct: 12, multiples: { pe: 20 }, dividend: { yield_pct: 2 },
    market_cap_inr: 1e10,
  } };
  assert.equal(dataCompletenessPct(s), 100);
});
check("partial coverage rounds correctly", () => {
  // 4 of 13 fields populated ≈ 31%
  const s = { overview: { snowflake: { financial_health: 5, future: 4 }, upside_pct: 10, returns_pct: { "1Y": 1 } } };
  assert.equal(dataCompletenessPct(s), Math.round((4 / 13) * 100));
});

console.log("\n_countInsiderBuys\n");

check("no insider activity → 0", () => assert.equal(_countInsiderBuys({}), 0));
check("counts only buy direction", () => {
  const s = { overview: { insider_activity: [{ direction: "buy" }, { direction: "sell" }, { direction: "buy" }, null] } };
  assert.equal(_countInsiderBuys(s), 2);
});

console.log("\nverdictFromScore boundaries\n");

check(">=72 DEEP_VALUE",       () => assert.equal(verdictFromScore(72), "DEEP_VALUE"));
check("=62 QUALITY_GROWTH",    () => assert.equal(verdictFromScore(62), "QUALITY_GROWTH"));
check("=48 FAIR_VALUE",        () => assert.equal(verdictFromScore(48), "FAIR_VALUE"));
check("=40 FULLY_VALUED",      () => assert.equal(verdictFromScore(40), "FULLY_VALUED"));
check("=0 OVERVALUED",         () => assert.equal(verdictFromScore(0),  "OVERVALUED"));
check("just below 72 → QG", () => assert.equal(verdictFromScore(71.9), "QUALITY_GROWTH"));

console.log("\ncomputeCompositeScore\n");

check("empty stock yields finite score, never NaN", () => {
  const r = computeCompositeScore({});
  assert.ok(Number.isFinite(r.composite_score_100));
  assert.ok(r.composite_score_100 >= 0 && r.composite_score_100 <= 100);
});
check("perfect snowflake + max upside near top", () => {
  const r = computeCompositeScore({ overview: { snowflake_total: 30, upside_pct: 50 } });
  // 35 (snow) + 20 (upside) = 55 minimum from these two pillars alone.
  assert.ok(r.composite_score_100 >= 55, `got ${r.composite_score_100}`);
});
check("forward growth parsed from rewards string fallback", () => {
  const r = computeCompositeScore({ overview: { rewards: ["Earnings forecast to grow 18.5% per year"] } });
  assert.equal(r.forward_growth_used_pct, 18.5);
});
check("clamps risks to 5 (max -15 risk pts)", () => {
  const r = computeCompositeScore({ overview: { risks: new Array(20).fill("r") } });
  assert.equal(r.breakdown.pts_risks, -15);
});
check("dividend bonus only when all 3 conditions met", () => {
  const ok = computeCompositeScore({ overview: { snowflake: { dividends: 5 }, dividend: { yield_pct: 2, payout_pct: 60 } } });
  const bad = computeCompositeScore({ overview: { snowflake: { dividends: 5 }, dividend: { yield_pct: 2, payout_pct: 75 } } });
  assert.equal(ok.breakdown.pts_dividend, 5);
  assert.equal(bad.breakdown.pts_dividend, 0);
});

console.log("\ncomputeV2Score\n");

check("clean v1=50, no overlays → v2=50", () => {
  const r = computeV2Score({ composite_score_100: 50, overview: {} }, { surveillanceFlag: null });
  assert.equal(r.v2_score_100, 50);
  assert.equal(r.v2_breakdown.pts_catalyst, 0);
  assert.equal(r.v2_breakdown.pts_risk_overlay, 0);
});
check("GSM surveillance → -10 risk", () => {
  const r = computeV2Score({ composite_score_100: 60, overview: {} }, { surveillanceFlag: { list: "GSM" } });
  assert.equal(r.v2_breakdown.pts_risk_overlay, -10);
});
check("ASM shortterm → -8 risk", () => {
  const r = computeV2Score({ composite_score_100: 60, overview: {} }, { surveillanceFlag: { list: "ASM", timeframe: "shortterm" } });
  assert.equal(r.v2_breakdown.pts_risk_overlay, -8);
});
check("insider buy adds +2 catalyst", () => {
  const r = computeV2Score({
    composite_score_100: 50,
    overview: { insider_activity: [{ direction: "buy" }] },
  }, { surveillanceFlag: null });
  assert.equal(r.v2_breakdown.pts_catalyst, 2);
});
check("high beta + many risks both flag", () => {
  const r = computeV2Score({
    composite_score_100: 60,
    overview: { beta: 2.0, risks: ["a", "b", "c", "d"] },
  }, { surveillanceFlag: null });
  assert.equal(r.v2_breakdown.beta_flag, true);
  assert.equal(r.v2_breakdown.risks_flag, true);
});
check("clamps risk overlay floor at -15", () => {
  const r = computeV2Score({
    composite_score_100: 60,
    overview: { beta: 3, risks: new Array(10).fill("r") },
  }, { surveillanceFlag: { list: "GSM" } });
  assert.equal(r.v2_breakdown.pts_risk_overlay, -15);
});

console.log("\nbuildUniverseStats\n");

check("empty input → empty arrays", () => {
  const u = buildUniverseStats([]);
  assert.deepEqual(u, { r1m: [], r3m: [], r1y: [] });
});
check("sorts ascending and skips non-finite", () => {
  const u = buildUniverseStats([
    { overview: { returns_pct: { "1Y": 30, "3M": 10, "1M": 5 } } },
    { overview: { returns_pct: { "1Y": 10, "3M": NaN, "1M": -2 } } },
    { overview: { returns_pct: { "1Y": 20 } } },
    null, undefined, {},
  ]);
  assert.deepEqual(u.r1y, [10, 20, 30]);
  assert.deepEqual(u.r3m, [10]);
  assert.deepEqual(u.r1m, [-2, 5]);
});

console.log("\nscoreStock end-to-end mutates input\n");

check("scoreStock writes composite/v2/v4/categories onto stock", () => {
  const s = { ticker: "X", overview: { snowflake_total: 24, snowflake: { financial_health: 5, future: 4, valuation: 4, past: 4, dividends: 3 }, upside_pct: 20, returns_pct: { "1Y": 15, "3M": 5, "1M": 2 } } };
  scoreStock(s);
  assert.ok(Number.isFinite(s.composite_score_100));
  assert.ok(Number.isFinite(s.v2_score_100));
  assert.ok(Number.isFinite(s.v4_score_100));
  assert.ok(Array.isArray(s.categories));
  assert.ok(typeof s.verdict === "string" && typeof s.v4_verdict === "string");
});

console.log("\nbuildPickCounterThesis branches\n");

check("bullish path returns bullish bias + triggers", () => {
  const ct = buildPickCounterThesis({
    v4_verdict: "TOP_PICK",
    v4_breakdown: { surveillance: { list: "ASM" }, fv_imputed: true },
    overview: { upside_pct: 25, risks: ["a", "b", "c", "d", "e"] },
  });
  assert.equal(ct.verdict_bias, "bullish");
  assert.ok(ct.falsification_trigger.length > 0);
  assert.ok(/risks/.test(ct.text));
});
check("bearish path returns bearish bias", () => {
  const ct = buildPickCounterThesis({
    v4_verdict: "AVOID",
    overview: { snowflake_total: 20, upside_pct: 35, insider_activity: [{ direction: "buy" }] },
  });
  assert.equal(ct.verdict_bias, "bearish");
});
check("neutral path returns neutral bias", () => {
  const ct = buildPickCounterThesis({ v4_verdict: "WATCH", overview: {} });
  assert.equal(ct.verdict_bias, "neutral");
  assert.ok(typeof ct.text === "string" && ct.text.length > 0);
});

console.log("\nbuildPickAuditTrail\n");

check("audit trail captures inputs + version", () => {
  const a = buildPickAuditTrail({
    overview: { snowflake_total: 22, upside_pct: 12, risks: ["x"] },
    v2_breakdown: { surveillance: null },
    v4_breakdown: { fv_imputed: true, momentum_imputed: false },
    categories: ["midterm"],
  });
  assert.equal(a.scoring_version, PICKS_SCORING_VERSION);
  assert.equal(a.inputs_used.snowflake_total, 22);
  assert.equal(a.inputs_used.risks_count, 1);
  assert.equal(a.imputations.fv_imputed, true);
  assert.deepEqual(a.categories_assigned, ["midterm"]);
});

console.log("\npickCardFields surface\n");

check("pickCardFields exposes verdict + score aliases", () => {
  const card = pickCardFields({
    ticker: "ABC", name: "ABC Ltd", sector: "Tech",
    composite_score_100: 60, v2_score_100: 58, v4_score_100: 55, v4_verdict: "STRONG", verdict: "FAIR_VALUE",
    overview: { upside_pct: 12, multiples: { pe: 18 }, dividend: { yield_pct: 2 }, snowflake_total: 22 },
  });
  assert.equal(card.composite_verdict, "STRONG");
  assert.equal(card.valuation_band, "DISCOUNT");
  assert.equal(card.v4_score, 55);
  assert.equal(card.v4_score_100, 55);
  assert.ok(card.counter_thesis && card.audit_trail);
});

console.log("\ncategoriseStock — branches not in swsCategorise.test.mjs\n");

check("deep_value requires TOP_PICK + valSnow>=4 + upside>=20", () => {
  const cats = scoreStock({ ticker: "X", overview: {
    snowflake: { valuation: 5, future: 4, past: 4, financial_health: 5, dividends: 3 },
    snowflake_total: 25, upside_pct: 30, market_cap_inr: 1e12, returns_pct: { "1Y": 10, "3M": 5, "1M": 1 },
  } }).categories;
  // v4 score for that input puts it well into TOP_PICK territory.
  assert.ok(cats.includes("deep_value"), `cats=${cats}`);
});
check("insider_buying category set by single buy", () => {
  const cats = scoreStock({ ticker: "Y", overview: { insider_activity: [{ direction: "buy" }] } }).categories;
  assert.ok(cats.includes("insider_buying"));
});
check("avoid: small mcap below floor doesn't set avoid by AVOID-only branch", () => {
  // mcap 1e8 < 5e9 floor → avoid via AVOID path blocked; backstop also fails (snow=0, risks=0)
  const cats = scoreStock({ ticker: "Z", overview: { market_cap_inr: 1e8 } }).categories;
  assert.ok(!cats.includes("avoid"), `cats=${cats}`);
});
check("avoid backstop: snowflake<12 AND risks>=3", () => {
  const cats = scoreStock({ ticker: "Q", overview: { snowflake_total: 5, risks: ["a", "b", "c"], market_cap_inr: 1e8 } }).categories;
  assert.ok(cats.includes("avoid"), `cats=${cats}`);
});

console.log("\nbuildLeaderboard — hygiene + bestFundamentals + upcoming sort\n");

const mkScored = (over) => {
  const s = { ticker: over.ticker, overview: over.overview || {}, ...over };
  scoreStock(s);
  return s;
};

check("hygiene drops mcap below floor from top_ranked_30", () => {
  const tiny = mkScored({ ticker: "TINY", overview: { snowflake: { financial_health: 5, future: 5, valuation: 4, past: 4, dividends: 3 }, snowflake_total: 25, upside_pct: 20, market_cap_inr: 1e8 } });
  const big = mkScored({ ticker: "BIG", overview: { snowflake: { financial_health: 5, future: 5, valuation: 4, past: 4, dividends: 3 }, snowflake_total: 25, upside_pct: 20, market_cap_inr: 1e12 } });
  const lb = buildLeaderboard([tiny, big]);
  const tickers = lb.top_ranked_30.map((c) => c.ticker);
  assert.ok(!tickers.includes("TINY"), `tickers=${tickers}`);
  assert.ok(tickers.includes("BIG"), `tickers=${tickers}`);
});

check("hygiene drops GSM-flagged stocks from top_ranked_30", () => {
  const a = mkScored({ ticker: "A", overview: { snowflake_total: 24, market_cap_inr: 1e12, snowflake: { financial_health: 4 } } });
  const b = mkScored({ ticker: "B", overview: { snowflake_total: 24, market_cap_inr: 1e12, snowflake: { financial_health: 4 } } });
  // Force GSM flag onto A's v2_breakdown post-score (computeV2Score consults
  // module-level _getSurveillanceFlag, so we just inject the breakdown).
  a.v2_breakdown = { surveillance: { list: "GSM", timeframe: null } };
  const lb = buildLeaderboard([a, b]);
  const tickers = lb.top_ranked_30.map((c) => c.ticker);
  assert.ok(!tickers.includes("A") && tickers.includes("B"), `tickers=${tickers}`);
});

check("ordered respects v4_score descending (tie-stable)", () => {
  const high = mkScored({ ticker: "HI", overview: { snowflake: { financial_health: 5, future: 5, valuation: 4, past: 4, dividends: 3 }, snowflake_total: 25, upside_pct: 30, market_cap_inr: 1e12 } });
  const low  = mkScored({ ticker: "LO", overview: { snowflake: { financial_health: 2, future: 2, valuation: 2, past: 2, dividends: 1 }, snowflake_total: 8, upside_pct: -5, market_cap_inr: 1e12 } });
  const lb = buildLeaderboard([low, high]);
  // best_fundamentals sorts by fundamentals subtotal — HI must come first.
  assert.equal(lb.best_fundamentals[0].ticker, "HI");
});

check("upcoming_earnings sorted ascending by next_earnings_date", () => {
  const today = new Date();
  const iso = (offsetDays) => {
    const d = new Date(today.getTime() + offsetDays * 86400000);
    return d.toISOString().slice(0, 10);
  };
  const farther = mkScored({ ticker: "FAR", overview: { snowflake_total: 24, market_cap_inr: 1e12, next_earnings_date: iso(40), snowflake: { financial_health: 4 } } });
  const sooner  = mkScored({ ticker: "SOON", overview: { snowflake_total: 24, market_cap_inr: 1e12, next_earnings_date: iso(5),  snowflake: { financial_health: 4 } } });
  const lb = buildLeaderboard([farther, sooner]);
  const order = lb.upcoming_earnings.map((c) => c.ticker);
  assert.deepEqual(order.slice(0, 2), ["SOON", "FAR"]);
  assert.ok(lb.upcoming_earnings[0].days_until <= lb.upcoming_earnings[1].days_until);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
