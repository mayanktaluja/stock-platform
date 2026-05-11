// Contract tests for the SQL backend + DAL write surface.
//
// These tests run in TWO modes:
//   1. NO DATABASE_URL → assert that the gated writes are no-ops and
//      reads return null. Default for `npm test`.
//   2. WITH DATABASE_URL → smoke-test live writes against the configured
//      DB. Opt-in via SWS_TEST_LIVE_DB=1 to avoid mutating a real DB
//      by accident.
//
// To run with a live DB:
//   $ SWS_TEST_LIVE_DB=1 DATABASE_URL_UNPOOLED=postgres://... \
//       node test/swsDalSql.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import * as dal from "../services/swsDal/index.js";
import { isDbConfigured, closeDb } from "../db/client.js";
import { deepJsonToColumns, snapshotRowToJson, pickCardToRow } from "../services/swsDal/rowMapping.js";

const LIVE = process.env.SWS_TEST_LIVE_DB === "1" && isDbConfigured();

test("rowMapping: deepJsonToColumns + snapshotRowToJson round-trip", () => {
  const deep = {
    ticker: "TESTCO",
    name: "Test Co Ltd",
    sector: "Test Sector",
    parsed_at: "2026-05-10T01:00:00.000Z",
    overview: {
      snowflake: { valuation: 4, future_growth: 3, past_performance: 5, financial_health: 6, dividends: 2 },
      snowflake_total: 20,
      current_price_inr: 1234.5,
      market_cap_inr: 9.8e9,
      fair_value_inr: 1500.0,
      upside_pct: 21.5,
      multiples: { pe: 18.4, pb: 2.1, ps: 1.6, ev_ebitda: 11.2 },
      returns_pct: { "1M": 3.2, "3M": 8.5, "6M": 11.0, "1Y": 22.0, "5Y": 110.0 },
      dividend_yield_pct: 1.4,
      net_margin_pct: 12.5,
      rewards: ["a", "b"],
      risks: ["x"],
      industry_benchmarks: { pe: 22, future_revenue_growth_3y: 15 },
    },
    ownership: { top_holders: [{ pct: 35, shares: 100, is_insider: true }] },
    fiscal: { latest_revenue: 5e9, latest_net_income: 6e8 },
    news: [{ id: "n1", title: "Test news" }],
    indices: ["NIFTY 50"],
  };
  const cols = deepJsonToColumns(deep, { runId: "test-run" });
  assert.equal(cols.ticker, "TESTCO");
  assert.equal(cols.snowflakeTotal, 20);
  assert.equal(cols.returns1mPct, 3.2);
  assert.equal(cols.pe, 18.4);

  const round = snapshotRowToJson(cols);
  assert.equal(round.ticker, "TESTCO");
  assert.equal(round.overview.snowflake_total, 20);
  assert.equal(round.overview.returns_pct["1M"], 3.2);
  assert.equal(round.overview.multiples.pe, 18.4);
  assert.equal(round.news.length, 1);
});

test("rowMapping: pickCardToRow with all fields", () => {
  const card = {
    ticker: "RELIANCE",
    name: "Reliance Industries",
    sector: "Energy",
    score: 78.5,
    v2_score: 72.0,
    v3_score: 70.1,
    v3_score_100: 70.1,
    v3_verdict: "TOP_PICK",
    verdict: "TOP_PICK",
    upside_pct: 12.4,
    snowflake: { total: 22 },
    v3_breakdown: { pts_health: 4 },
    narrative: { card_one_line: "Strong play" },
  };
  const row = pickCardToRow(card, { runId: "r1", section: "top_ranked_30_v3", rank: 1 });
  assert.equal(row.ticker, "RELIANCE");
  assert.equal(row.section, "top_ranked_30_v3");
  assert.equal(row.rankInSection, 1);
  assert.equal(row.v3Score100, 70.1);
  assert.deepEqual(row.narrative, { card_one_line: "Strong play" });
});

test("DAL write methods are no-ops when DATABASE_URL is unset", { skip: isDbConfigured() }, async () => {
  assert.equal(await dal.beginRun({ pipeline: "api" }), null);
  assert.equal(await dal.upsertCompany({ ticker: "X" }), null);
  assert.equal(await dal.upsertCompanySnapshot("run-1", { ticker: "X" }), null);
  assert.equal(await dal.replacePicksForRun("run-1", {}), null);
  assert.equal(await dal.recordSanityReport("run-1", { verdict: "PASS" }), null);
  assert.equal(dal.isDualWriteEnabled(), false);
});

test("isDbConfigured matches DATABASE_URL presence", () => {
  if (process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED) {
    assert.equal(isDbConfigured(), true);
  } else {
    assert.equal(isDbConfigured(), false);
  }
});

test("LIVE: beginRun → upsertCompanySnapshot → finaliseRun cycle", { skip: !LIVE }, async () => {
  process.env.SWS_DB_DUAL_WRITE = "1"; // force-enable for this test
  const runId = await dal.beginRun({ pipeline: "test" });
  assert.ok(runId, "beginRun returned null");

  await dal.upsertCompany({ ticker: "TESTCO", name: "Test Co", sector: "Test" });
  await dal.upsertCompanySnapshot(runId, {
    ticker: "TESTCO",
    name: "Test Co",
    sector: "Test",
    overview: {
      snowflake_total: 18,
      current_price_inr: 100,
      returns_pct: { "1M": 5.5 },
    },
  });

  await dal.finaliseRun(runId, {
    status: "success",
    finishedAt: new Date().toISOString(),
    scoredCount: 1,
  });

  const canonical = await dal.getCanonicalRunId();
  assert.equal(canonical, runId, "newly finalised run should be canonical");

  // Sector momentum query — single SQL aggregate.
  const sm = await dal.getSectorMomentumAsync();
  assert.ok(sm.map instanceof Map);

  await closeDb();
});
