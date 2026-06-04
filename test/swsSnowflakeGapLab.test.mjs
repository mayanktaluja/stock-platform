/**
 * Unit tests for the experimental India-only Snowflake Gap Lab.
 *
 * Run with: node test/swsSnowflakeGapLab.test.mjs
 */

import assert from "node:assert/strict";
import { scoreStock, pickCardFields } from "../services/swsScoring.js";
import {
  buildSnowflakeGapLabSection,
  buildSnowflakeGapPeerAverages,
  classifySnowflakeGapMarketCap,
  computeSnowflakeGapLabForStock,
} from "../services/swsSnowflakeGapLab.js";
import { SWS_SECTION_TO_TYPE } from "../paperTrades.js";
import { ALL_SECTION_TYPES } from "../paperTrades.js";
import { SWS_SECTION_PERFORMANCE_REGISTRY } from "../services/trackRecord/sectionPerformance.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "→", e.message); }
}

function matrix(checks, healthSet = "Health") {
  return {
    version: "sws-visible-snowflake-checks-v1",
    checked_count: 30,
    captured_count: checks.length,
    health_check_set: healthSet,
    checks,
  };
}

function row(pillar, name, result, title = name) {
  return {
    pillar,
    name,
    title,
    result,
    available: result === "pass" || result === "fail",
    insufficient: result === "no_data",
  };
}

function stock(ticker, {
  snow = { financial_health: 6, future: 0, valuation: 0, past: 6, dividends: 0 },
  checks = [],
  mcap = 10_000_000_000,
  sector = "Capital Goods",
  surveillance = null,
} = {}) {
  const scored = scoreStock({
    ticker,
    name: ticker,
    sector,
    overview: {
      snowflake: {
        ...snow,
        health: snow.financial_health,
        future_growth: snow.future,
        value: snow.valuation,
        past_performance: snow.past,
        dividend: snow.dividends,
      },
      snowflake_total: snow.financial_health + snow.future + snow.valuation + snow.past + snow.dividends,
      market_cap_inr: mcap,
      current_price_inr: 100,
      fair_value_inr: 130,
      upside_pct: 30,
      returns_pct: { "1M": 0, "3M": 0, "1Y": 0 },
      risks: [],
      snowflake_check_matrix: matrix(checks),
    },
  }, { surveillanceFlag: surveillance || false });
  return scored;
}

function peer(i, overrides = {}) {
  return stock(`PEER${i}`, {
    snow: { financial_health: 4, future: 4, valuation: 4, past: 4, dividends: 0 },
    checks: [
      row("Future", "F1", "pass", "Future ROE"),
      row("Future", "F2", "pass", "High Growth Earnings"),
      row("Value", "V1", "pass", "PEG Ratio"),
    ],
    ...overrides,
  });
}

console.log("\nSnowflake Gap Lab helpers\n");

check("classifies market-cap buckets with 500cr floor", () => {
  assert.equal(classifySnowflakeGapMarketCap(4_999_999_999), "sub_500cr");
  assert.equal(classifySnowflakeGapMarketCap(10_000_000_000), "micro");
  assert.equal(classifySnowflakeGapMarketCap(60_000_000_000), "small");
});

check("builds a shadow V4 section without mutating canonical V4", () => {
  const candidate = stock("GAPLAB", {
    checks: [
      row("Future", "F1", "no_data", "Future ROE"),
      row("Future", "F2", "no_data", "High Growth Earnings"),
      row("Value", "V1", "no_data", "PEG Ratio"),
    ],
  });
  const canonicalScore = candidate.v4_score_100;
  const canonicalFuture = candidate.overview.snowflake.future;
  const peers = [peer(1), peer(2), peer(3), peer(4), peer(5)];
  const averages = buildSnowflakeGapPeerAverages([candidate, ...peers]);
  const lab = computeSnowflakeGapLabForStock(candidate, { snowflakeGapPeerAverages: averages }, {
    minPeerCheckCount: 5,
  });
  assert.ok(lab, "expected lab candidate");
  assert.equal(candidate.v4_score_100, canonicalScore);
  assert.equal(candidate.overview.snowflake.future, canonicalFuture);
  assert.equal(lab.canonical_v4_score_100, canonicalScore);
  assert.ok(lab.shadow_v4_score_100 > candidate.v4_score_100);
  assert.ok(lab.score_delta >= 6);
  assert.deepEqual(lab.affected_pillars.sort(), ["future", "valuation"]);

  const section = buildSnowflakeGapLabSection([candidate, ...peers], {
    pickCardFields,
    minPeerCheckCount: 5,
  });
  assert.equal(section.items.length, 1);
  assert.equal(section.items[0].ticker, "GAPLAB");
  assert.equal(section.items[0].v4_score_100, canonicalScore);
  assert.equal(section.items[0].snowflake_gap_lab.shadow_v4_score_100, lab.shadow_v4_score_100);
  assert.equal(section.audit.experimental, true);
});

check("does not impute dividend-only missing checks into V4", () => {
  const candidate = stock("DIVGAP", {
    checks: [
      row("Dividends", "D1", "no_data", "Dividend Growth"),
      row("Dividends", "D2", "no_data", "Dividend Yield"),
      row("Dividends", "D3", "no_data", "Dividend Stability"),
    ],
  });
  const peers = [1, 2, 3, 4, 5].map((i) => peer(i, {
    checks: [
      row("Dividends", "D1", "pass", "Dividend Growth"),
      row("Dividends", "D2", "pass", "Dividend Yield"),
      row("Dividends", "D3", "pass", "Dividend Stability"),
    ],
  }));
  const averages = buildSnowflakeGapPeerAverages([candidate, ...peers]);
  const lab = computeSnowflakeGapLabForStock(candidate, { snowflakeGapPeerAverages: averages }, {
    minPeerCheckCount: 5,
  });
  assert.equal(lab, null);
});

check("includes material same-verdict shadow uplifts for review-only discovery", () => {
  const candidate = stock("SAMEVERDICT", {
    snow: { financial_health: 6, future: 0, valuation: 6, past: 6, dividends: 0 },
    checks: [
      row("Future", "F1", "no_data", "Future ROE"),
      row("Future", "F2", "no_data", "High Growth Earnings"),
      row("Future", "F3", "no_data", "Revenue Growth Forecast"),
    ],
  });
  assert.equal(candidate.v4_verdict, "TOP_PICK");
  const peers = [1, 2, 3, 4, 5].map((i) => peer(i, {
    checks: [
      row("Future", "F1", "pass", "Future ROE"),
      row("Future", "F2", "pass", "High Growth Earnings"),
      row("Future", "F3", "pass", "Revenue Growth Forecast"),
    ],
  }));
  const averages = buildSnowflakeGapPeerAverages([candidate, ...peers]);
  const lab = computeSnowflakeGapLabForStock(candidate, { snowflakeGapPeerAverages: averages }, {
    minPeerCheckCount: 5,
  });
  assert.ok(lab, "expected same-verdict lab candidate");
  assert.equal(lab.canonical_v4_verdict, "TOP_PICK");
  assert.equal(lab.shadow_v4_verdict, "TOP_PICK");
  assert.ok(lab.score_delta >= 6);
  assert.deepEqual(lab.affected_pillars, ["future"]);
});

check("orders section rows by experimental shadow V4 score before delta", () => {
  const peers = [1, 2, 3, 4, 5].map((i) => peer(i, {
    checks: [
      row("Future", "F1", "pass", "Future ROE"),
      row("Future", "F2", "pass", "High Growth Earnings"),
      row("Future", "F3", "pass", "Revenue Growth Forecast"),
      row("Value", "V1", "pass", "PEG Ratio"),
    ],
  }));
  const higherShadowLowerDelta = stock("VALFUT", {
    snow: { financial_health: 6, future: 0, valuation: 0, past: 6, dividends: 0 },
    checks: [
      row("Future", "F1", "no_data", "Future ROE"),
      row("Future", "F2", "no_data", "High Growth Earnings"),
      row("Value", "V1", "no_data", "PEG Ratio"),
    ],
  });
  const lowerShadowHigherDelta = stock("MIDBASE", {
    snow: { financial_health: 4, future: 0, valuation: 4, past: 4, dividends: 0 },
    checks: [
      row("Future", "F1", "no_data", "Future ROE"),
      row("Future", "F2", "no_data", "High Growth Earnings"),
      row("Future", "F3", "no_data", "Revenue Growth Forecast"),
    ],
  });
  const section = buildSnowflakeGapLabSection([lowerShadowHigherDelta, higherShadowLowerDelta, ...peers], {
    pickCardFields,
    minPeerCheckCount: 5,
  });
  assert.equal(section.items.length, 2);
  assert.equal(section.items[0].ticker, "VALFUT");
  assert.ok(section.items[0].snowflake_gap_lab.shadow_v4_score_100 > section.items[1].snowflake_gap_lab.shadow_v4_score_100);
  assert.ok(section.items[0].snowflake_gap_lab.score_delta < section.items[1].snowflake_gap_lab.score_delta);
});

check("excludes low market cap, GSM, and numeric tickers from the section", () => {
  const checks = [
    row("Future", "F1", "no_data"),
    row("Future", "F2", "no_data"),
    row("Value", "V1", "no_data"),
  ];
  const peers = [peer(1), peer(2), peer(3), peer(4), peer(5)];
  const lowMcap = stock("LOWMCAP", { checks, mcap: 4_000_000_000 });
  const gsm = stock("GSMROW", { checks, surveillance: { list: "GSM" } });
  const numeric = stock("538992", { checks });
  const section = buildSnowflakeGapLabSection([lowMcap, gsm, numeric, ...peers], {
    pickCardFields,
    minPeerCheckCount: 5,
  });
  assert.equal(section.items.length, 0);
  assert.equal(section.audit.rejected.mcap_floor, 1);
  assert.equal(section.audit.rejected.gsm, 1);
  assert.equal(section.audit.rejected.ticker_hygiene, 1);
});

check("is not wired into Track Record or section performance registries", () => {
  assert.equal(SWS_SECTION_TO_TYPE.snowflake_gap_lab, undefined);
  assert.equal(ALL_SECTION_TYPES.sws_snowflake_gap_lab, undefined);
  assert.equal(SWS_SECTION_PERFORMANCE_REGISTRY.snowflake_gap_lab, undefined);
});

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
