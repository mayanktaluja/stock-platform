import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketInformationPayload,
  buildMarketInformationSnapshot,
  classifyMarketInformationItem,
  computeMarketInformationRuntimeAudit,
} from "../services/marketInformationService.js";

const ITEMS = [
  {
    stable_id: "i1",
    provider: "stockinsights",
    source_market: "india",
    source_kind: "corporate_announcement",
    ticker: "TCS",
    company_name: "TCS",
    category: "Financial Results",
    sentiment: "neutral",
    summary: "Quarterly results filed",
    source_url: "https://bse.test/tcs",
    published_at: "2026-06-21T02:00:00.000Z",
  },
  {
    stable_id: "i2",
    provider: "stockinsights",
    source_market: "india",
    source_kind: "corporate_announcement",
    ticker: "RELIANCE",
    company_name: "Reliance",
    category: "Credit Rating",
    sentiment: "negative",
    summary: "Rating action filed",
    source_url: "https://bse.test/reliance",
    published_at: "2026-06-21T02:10:00.000Z",
  },
  {
    stable_id: "u1",
    provider: "stockinsights",
    source_market: "us",
    source_kind: "sec_filing",
    ticker: "MSFT",
    company_name: "Microsoft",
    category: "8-K",
    sentiment: "neutral",
    summary: "Current report filed",
    source_url: "https://sec.test/msft",
    published_at: "2026-06-21T02:20:00.000Z",
  },
];

test("classifyMarketInformationItem labels material filings without action language", () => {
  assert.deepEqual(classifyMarketInformationItem(ITEMS[1]), {
    materiality: "high",
    why_it_matters: "Credit or compliance risk",
  });
  const result = classifyMarketInformationItem({ category: "Investor Presentation", summary: "general update" });
  assert.equal(result.materiality, "medium");
});

test("buildMarketInformationPayload groups sections and portfolio/watchlist matches", () => {
  const snapshot = buildMarketInformationSnapshot({
    generatedAt: "2026-06-21T02:30:00.000Z",
    items: ITEMS,
  });
  const payload = buildMarketInformationPayload(snapshot, {
    now: "2026-06-21T03:00:00.000Z",
    portfolioTickers: ["RELIANCE"],
    watchlistTickers: ["MSFT"],
  });
  assert.equal(payload.schema_version, "market-information-v1");
  assert.equal(payload.sections.breaking_filings.length, 3);
  assert.equal(payload.sections.portfolio_watchlist.length, 2);
  assert.equal(payload.sections.negative_or_material.length, 2);
  assert.equal(payload.sections.results_earnings.length, 1);
  assert.equal(payload.sections.us_sec_filings.length, 1);
  assert.equal(payload.sections.negative_or_material[0].provider_lag_minutes, 20);
  assert.ok(payload.caveats.some((line) => line.includes("does not update SWS scores")));
});

test("buildMarketInformationPayload applies ticker, sentiment, source, and scope filters", () => {
  const snapshot = buildMarketInformationSnapshot({
    generatedAt: "2026-06-21T02:30:00.000Z",
    items: ITEMS,
  });
  const payload = buildMarketInformationPayload(snapshot, {
    now: "2026-06-21T03:00:00.000Z",
    query: { sentiment: "negative", scope: "portfolio", source: "india" },
    portfolioTickers: ["RELIANCE"],
  });
  assert.equal(payload.stats.total, 1);
  assert.equal(payload.sections.breaking_filings[0].ticker, "RELIANCE");

  const searchPayload = buildMarketInformationPayload(snapshot, {
    query: { ticker: "microsoft", source: "us" },
    watchlistTickers: ["MSFT"],
  });
  assert.equal(searchPayload.stats.total, 1);
  assert.equal(searchPayload.sections.us_sec_filings[0].ticker, "MSFT");
});

test("runtime audit marks old snapshots stale but keeps response usable", () => {
  const audit = computeMarketInformationRuntimeAudit(
    { generated_at: "2026-06-20T00:00:00.000Z", provider: "stockinsights", mode: "manual_cached" },
    { now: "2026-06-21T18:00:00.000Z" },
  );
  assert.equal(audit.stale, true);
  assert.equal(audit.stale_threshold_hours, 12);
  assert.equal(Math.round(audit.age_hours), 42);
});

test("payload avoids recommendation fields", () => {
  const payload = buildMarketInformationPayload(
    buildMarketInformationSnapshot({ generatedAt: "2026-06-21T02:30:00.000Z", items: ITEMS }),
  );
  const keys = new Set();
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      walk(child);
    }
  };
  walk(payload);
  for (const key of ["recommendation", "action", "verdict", "target_price"]) {
    assert.equal(keys.has(key), false, `${key} must not be part of Market Radar rows`);
  }
});
