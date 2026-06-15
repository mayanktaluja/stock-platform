/**
 * India Market actionability / entry-band policy.
 *
 * Run with: node test/swsIndiaSectionPolicy.test.mjs
 */

import assert from "node:assert/strict";
import {
  ENTRY_BAND_VERSION,
  buildEntryBand,
  compareIndiaSectionRank,
  isActionableTodayCandidate,
} from "../services/swsIndiaSectionPolicy.js";
import { buildLeaderboard } from "../services/swsScoring.js";

let pass = 0;
let fail = 0;
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

const now = new Date("2026-06-15T09:30:00.000Z");

function stock(ticker, overrides = {}) {
  return {
    ticker,
    name: `${ticker} Ltd`,
    sector: "Industrials",
    parsed_at: overrides.parsed_at || "2026-06-15T06:00:00.000Z",
    v4_score_100: overrides.v4_score_100 ?? 62,
    v4_verdict: overrides.v4_verdict || "STRONG",
    v4_breakdown: {
      pts_health: overrides.pts_health ?? 18,
      pts_future: overrides.pts_future ?? 16,
      pts_valuation: overrides.pts_valuation ?? 14,
      pts_past: overrides.pts_past ?? 12,
      pts_fv_total: overrides.pts_fv_total ?? 8,
      ...(overrides.v4_breakdown || {}),
    },
    regulatory_flags: overrides.regulatory_flags || {},
    risk_overlay: overrides.risk_overlay || {},
    overview: {
      current_price_inr: overrides.price ?? 100,
      fair_value_inr: overrides.fairValue ?? 140,
      market_cap_inr: overrides.marketCap ?? 1e11,
      snowflake_total: overrides.snowflakeTotal ?? 22,
      snowflake: {
        financial_health: 5,
        future: 4,
        valuation: 4,
        past: 4,
        dividends: 3,
      },
      returns_pct: { "1Y": 12, "3M": 4, "1M": 1 },
      risks: [],
      ...(overrides.overview || {}),
    },
    categories: overrides.categories || [],
  };
}

console.log("swsIndiaSectionPolicy\n");

check("clean BUY_ZONE candidate is fresh-buy eligible", () => {
  const band = buildEntryBand(stock("CLEAN"), { now });
  assert.equal(band.version, ENTRY_BAND_VERSION);
  assert.equal(band.entry_state, "BUY_ZONE");
  assert.equal(band.fresh_buy_eligible, true);
  assert.equal(band.buy_zone_low_inr, 105);
  assert.equal(band.buy_zone_high_inr, 119);
  assert.equal(band.no_buy_above_inr, 126);
});

check("above no-buy cap is not eligible", () => {
  const band = buildEntryBand(stock("WAIT", { price: 130, fairValue: 140 }), { now });
  assert.equal(band.entry_state, "NO_BUY_ABOVE");
  assert.equal(band.fresh_buy_eligible, false);
  assert.ok(band.reasons.some((r) => r.code === "above_no_buy_cap"));
});

check("FV outlier is warning-only data but excluded from Best Stocks to Buy Now", () => {
  const s = stock("OUTLIER", { price: 100, fairValue: 2_000 });
  const band = buildEntryBand(s, { now });
  assert.equal(band.available, true);
  assert.equal(band.fresh_buy_eligible, false);
  assert.ok(band.reasons.some((r) => r.code === "fv_outlier"));
  assert.equal(isActionableTodayCandidate(s, { now }), false);
});

check("missing FV produces UNAVAILABLE and no crash", () => {
  const band = buildEntryBand(stock("NOFV", { overview: { fair_value_inr: null, upside_pct: 30 } }), { now });
  assert.equal(band.available, false);
  assert.equal(band.entry_state, "UNAVAILABLE");
  assert.equal(band.fresh_buy_eligible, false);
  assert.ok(band.reasons.some((r) => r.code === "fair_value_missing"));
});

check("ASM surveillance excludes fresh-buy eligibility", () => {
  const band = buildEntryBand(stock("ASM", { regulatory_flags: { surveillance: { list: "ASM", timeframe: "shortterm" } } }), { now });
  assert.equal(band.entry_state, "BUY_ZONE");
  assert.equal(band.fresh_buy_eligible, false);
  assert.ok(band.reasons.some((r) => r.code === "surveillance_asm"));
});

check("comparison tie-break uses fundamentals before ticker", () => {
  const weaker = stock("AAA", { pts_health: 12, pts_future: 10, pts_valuation: 10, pts_past: 8, pts_fv_total: 4 });
  const stronger = stock("ZZZ", { pts_health: 18, pts_future: 16, pts_valuation: 14, pts_past: 12, pts_fv_total: 8 });
  assert.equal([weaker, stronger].sort(compareIndiaSectionRank)[0].ticker, "ZZZ");
});

check("buildLeaderboard keeps best_to_buy_now key but only strict actionable rows", () => {
  const good = stock("GOOD");
  const wait = stock("WAIT", { price: 130, fairValue: 140 });
  const asm = stock("ASM", { regulatory_flags: { surveillance: { list: "ASM" } } });
  const sections = buildLeaderboard([wait, asm, good], { now });
  assert.ok(Array.isArray(sections.best_to_buy_now));
  assert.deepEqual(sections.best_to_buy_now.map((s) => s.ticker), ["GOOD"]);
  assert.equal(sections.best_to_buy_now[0].entry_band.fresh_buy_eligible, true);
  assert.equal(sections.__section_audit.best_to_buy_now.policy_version, ENTRY_BAND_VERSION);
});

if (fail) {
  console.error(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n${pass} passed`);
