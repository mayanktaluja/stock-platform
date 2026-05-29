/**
 * Regression tests for services/swsScoring.js — PR 1.4 / 2.3 / 2.6 / 2.7.
 *
 * Covers:
 *   • Smallcap Gems threshold lowered from ₹50,000cr to ₹15,000cr (PR 1.4)
 *   • Dividend list value gate (PR 2.6)
 *   • valuationBandFromUpside helper buckets (PR 2.3)
 *   • BSE-numeric ticker filter in buildLeaderboard (PR 2.7)
 *
 * Run with: node test/swsCategorise.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  categoriseStock,
  buildLeaderboard,
  valuationBandFromUpside,
  scoreStock,
} from "../services/swsScoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Build a minimal scored-stock object that categoriseStock + buildLeaderboard
// can consume. Defaults are chosen so the stock fails every category gate
// unless overridden.
function makeStock(overrides = {}) {
  const ov = {
    snowflake: { valuation: 0, future_growth: 0, past_performance: 0, financial_health: 0, dividends: 0 },
    snowflake_total: 0,
    upside_pct: null,
    market_cap_inr: 0,
    risks: [],
    next_earnings_date: null,
    dividend: { yield_pct: 0, payout_pct: 100 },
    returns_pct: { "1Y": null, "3M": null },
    ...(overrides.overview || {}),
  };
  return {
    ticker: overrides.ticker || "TEST",
    v3_verdict: overrides.v3_verdict || "WATCH",
    v4_verdict: overrides.v4_verdict || overrides.v3_verdict || "WATCH",
    v3_score_100: overrides.v3_score_100 ?? 30,
    v4_score_100: overrides.v4_score_100 ?? overrides.v3_score_100 ?? 30,
    overview: ov,
    insider_activity: overrides.insider_activity || [],
  };
}

console.log("\nvaluationBandFromUpside — PR 2.3\n");

assert("upside +35 → DEEP_DISCOUNT", valuationBandFromUpside(35) === "DEEP_DISCOUNT", valuationBandFromUpside(35));
assert("upside +15 → DISCOUNT",       valuationBandFromUpside(15) === "DISCOUNT",      valuationBandFromUpside(15));
assert("upside  0  → FAIR",           valuationBandFromUpside(0)  === "FAIR",          valuationBandFromUpside(0));
assert("upside -10 → PREMIUM",        valuationBandFromUpside(-10) === "PREMIUM",      valuationBandFromUpside(-10));
assert("upside -25 → EXPENSIVE",      valuationBandFromUpside(-25) === "EXPENSIVE",    valuationBandFromUpside(-25));
assert("upside null → null",          valuationBandFromUpside(null) === null,          valuationBandFromUpside(null));
assert("upside NaN → null",           valuationBandFromUpside(NaN) === null,           valuationBandFromUpside(NaN));

console.log("\ncategoriseStock — smallcap gems threshold (PR 1.4)\n");

{
  // ₹14,000cr (true smallcap) + strong snow + upside → smallcap_gems
  const s = makeStock({
    v3_verdict: "TOP_PICK",
    overview: {
      snowflake: { valuation: 4, future_growth: 4, past_performance: 4, financial_health: 5, dividends: 4 },
      snowflake_total: 22,
      upside_pct: 20,
      market_cap_inr: 1.4e11, // ₹14,000cr
    },
  });
  const cats = categoriseStock(s);
  assert("mcap=14kcr → smallcap_gems", cats.includes("smallcap_gems"), cats);
}

{
  // ₹20,000cr (mid-cap) — same snow + upside but should NOT smallcap_gem.
  const s = makeStock({
    v3_verdict: "TOP_PICK",
    overview: {
      snowflake: { valuation: 4, future_growth: 4, past_performance: 4, financial_health: 5, dividends: 4 },
      snowflake_total: 22,
      upside_pct: 20,
      market_cap_inr: 2.0e11, // ₹20,000cr (mid-cap)
    },
  });
  const cats = categoriseStock(s);
  assert("mcap=20kcr → NOT smallcap_gems", !cats.includes("smallcap_gems"), cats);
}

{
  // Old threshold would have included ₹40,000cr. Confirm new threshold rejects.
  const s = makeStock({
    v3_verdict: "TOP_PICK",
    overview: {
      snowflake: { valuation: 4, future_growth: 4, past_performance: 4, financial_health: 5, dividends: 4 },
      snowflake_total: 22,
      upside_pct: 20,
      market_cap_inr: 4.0e11, // ₹40,000cr
    },
  });
  const cats = categoriseStock(s);
  assert("mcap=40kcr → NOT smallcap_gems", !cats.includes("smallcap_gems"), cats);
}

console.log("\ncategoriseStock — dividend value gate (PR 2.6)\n");

{
  // OVERVALUED + negative upside + low value snow → blocked even with strong dividend.
  const s = makeStock({
    overview: {
      snowflake: { valuation: 2, future_growth: 3, past_performance: 4, financial_health: 5, dividends: 5 },
      snowflake_total: 19,
      upside_pct: -10,
      dividend: { yield_pct: 4, payout_pct: 50 },
    },
  });
  const cats = categoriseStock(s);
  assert("dividend strong + upside -10% + valSnow=2 → blocked", !cats.includes("dividend_aristocrats"), cats);
}

{
  // Same dividend signal but valSnow=4 → passes via the value-snow branch.
  const s = makeStock({
    overview: {
      snowflake: { valuation: 4, future_growth: 3, past_performance: 4, financial_health: 5, dividends: 5 },
      snowflake_total: 21,
      upside_pct: -10,
      dividend: { yield_pct: 4, payout_pct: 50 },
    },
  });
  const cats = categoriseStock(s);
  assert("dividend strong + upside -10% + valSnow=4 → passes", cats.includes("dividend_aristocrats"), cats);
}

{
  // Positive upside passes irrespective of valSnow.
  const s = makeStock({
    overview: {
      snowflake: { valuation: 2, future_growth: 3, past_performance: 4, financial_health: 5, dividends: 5 },
      snowflake_total: 19,
      upside_pct: 5,
      dividend: { yield_pct: 4, payout_pct: 50 },
    },
  });
  const cats = categoriseStock(s);
  assert("dividend strong + upside +5% + valSnow=2 → passes", cats.includes("dividend_aristocrats"), cats);
}

console.log("\nscoreStock — FV-dependent gates use reconciled upside\n");

{
  const s = scoreStock(makeStock({
    ticker: "FVJUNK",
    overview: {
      current_price_inr: 100,
      fair_value_inr: 1100,
      upside_pct: 1000,
      snowflake: { valuation: 5, future_growth: 4, past_performance: 4, financial_health: 5, dividends: 3 },
      snowflake_total: 22,
      market_cap_inr: 1e12,
    },
  }), { surveillanceFlag: null });
  assert("FV ratio >10x → raw SWS upside remains deep_value eligible", s.categories.includes("deep_value"), s.categories);
}

{
  const s = scoreStock(makeStock({
    ticker: "FVOK",
    overview: {
      current_price_inr: 100,
      fair_value_inr: 800,
      upside_pct: 700,
      snowflake: { valuation: 5, future_growth: 4, past_performance: 4, financial_health: 5, dividends: 3 },
      snowflake_total: 22,
      market_cap_inr: 1e12,
    },
  }), { surveillanceFlag: null });
  assert("FV ratio 8x → deep_value remains eligible", s.categories.includes("deep_value"), s.categories);
}

console.log("\nbuildLeaderboard — BSE-numeric ticker filter (PR 2.7)\n");

{
  // Mix of NSE symbols and pure-numeric BSE codes — only NSE survive.
  const universe = [
    makeStock({ ticker: "RELIANCE", v3_verdict: "STRONG", v3_score_100: 60, overview: {
      snowflake: { valuation: 3, future_growth: 4, past_performance: 4, financial_health: 5, dividends: 3 },
      snowflake_total: 19,
      upside_pct: 10,
      market_cap_inr: 1.6e13, // very large cap, qualifies for top_ranked_30
      risks: [],
    }}),
    makeStock({ ticker: "538992", v3_verdict: "STRONG", v3_score_100: 55, overview: {
      snowflake: { valuation: 3, future_growth: 4, past_performance: 4, financial_health: 5, dividends: 3 },
      snowflake_total: 19,
      upside_pct: 10,
      market_cap_inr: 1.6e13,
      risks: [],
    }}),
    makeStock({ ticker: "ZOMATO", v3_verdict: "STRONG", v3_score_100: 50, overview: {
      snowflake: { valuation: 3, future_growth: 4, past_performance: 4, financial_health: 5, dividends: 3 },
      snowflake_total: 19,
      upside_pct: 10,
      market_cap_inr: 1.6e13,
      risks: [],
    }}),
  ];
  // categoriseStock is called inside scoreStock normally; the leaderboard
  // path requires a `categories` array — we set it manually so the cat()
  // gate doesn't drop everything.
  for (const s of universe) {
    s.categories = ["quality_growth"];
    s.composite_score_100 = 60;
    s.v2_score_100 = 60;
  }
  const lb = buildLeaderboard(universe);
  const tickers = (lb.top_ranked_30 || []).map((r) => r.ticker);
  assert("BSE-numeric '538992' filtered from top_ranked_30", !tickers.includes("538992"), tickers);
  assert("NSE symbols survive", tickers.includes("RELIANCE") && tickers.includes("ZOMATO"), tickers);
}

console.log("\nslimUniverseEntry — alias-field carriage on sws-scored-universe.json\n");

{
  // The slim universe rows feed off-section search hits on the SWS Picks
  // tab. Without composite_verdict + valuation_band, off-section cards
  // render blank score/verdict/chip while curated rows from picks-latest.json
  // render them populated — the bug visible in user-reported "search adani"
  // screenshot. Assert the data layer carries the aliases so the rendered
  // shape is byte-identical regardless of which JSON the row came from.
  const universePath = path.join(__dirname, "..", "data", "sws", "sws-scored-universe.json");
  if (!fs.existsSync(universePath)) {
    console.log("  (skip) sws-scored-universe.json not present — run `node scripts/sws-build-scored-universe.mjs`");
  } else {
    const data = JSON.parse(fs.readFileSync(universePath, "utf-8"));
    const stocks = Array.isArray(data?.stocks) ? data.stocks : [];
    assert("universe has stocks", stocks.length > 0, stocks.length);

    const withV3 = stocks.filter((s) => s && s.v3_verdict);
    const missingCv = withV3.filter((s) => !s.composite_verdict);
    assert(
      "every v3_verdict row carries composite_verdict",
      missingCv.length === 0,
      missingCv.slice(0, 3).map((s) => s.ticker)
    );

    const hasFiniteUpside = (s) => typeof s.upside_pct === "number" && Number.isFinite(s.upside_pct);
    const withUpside = stocks.filter((s) => s && hasFiniteUpside(s));
    const missingVb = withUpside.filter((s) => !s.valuation_band);
    assert(
      "every finite-upside row carries valuation_band",
      missingVb.length === 0,
      missingVb.slice(0, 3).map((s) => s.ticker)
    );

    // No-upside rows correctly leave valuation_band null — the card renderer
    // hides the chip on null, matching curated-section behaviour.
    const noUpside = stocks.filter((s) => s && !hasFiniteUpside(s));
    const wronglyBanded = noUpside.filter((s) => s.valuation_band);
    assert(
      "no-upside rows have null valuation_band",
      wronglyBanded.length === 0,
      wronglyBanded.slice(0, 3).map((s) => s.ticker)
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
