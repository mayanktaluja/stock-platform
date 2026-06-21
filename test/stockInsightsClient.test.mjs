import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStockInsightsUrl,
  dedupeStockInsightsItems,
  fetchIndiaAnnouncements,
  fetchStockInsightsPage,
  normalizeStockInsightsRows,
} from "../services/stockInsightsClient.js";

test("buildStockInsightsUrl builds India query params without empty values", () => {
  const url = buildStockInsightsUrl({
    baseUrl: "https://example.test",
    path: "/api/in/v0/documents/announcement",
    params: { ticker: "NSE:TCS", sentiment: "", limit: 50, page: 2 },
  });
  assert.equal(url.toString(), "https://example.test/api/in/v0/documents/announcement?ticker=NSE%3ATCS&limit=50&page=2");
});

test("fetchStockInsightsPage sends Bearer auth and parses rows", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.toString(), options });
    return new Response(JSON.stringify({ data: [{ id: "a1", ticker: "NSE:TCS" }], meta: { page: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await fetchStockInsightsPage({
    apiKey: "test-key",
    baseUrl: "https://example.test",
    params: { limit: 1 },
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
  assert.equal(result.rows[0].ticker, "NSE:TCS");
  assert.equal(result.meta.page, 1);
});

test("fetchIndiaAnnouncements caps pagination and normalizes India rows", async () => {
  const pages = [];
  const fetchImpl = async (url) => {
    pages.push(url.searchParams.get("page"));
    const page = Number(url.searchParams.get("page"));
    const rows =
      page === 1
        ? [
            { id: "a1", ticker: "NSE:TCS", company_name: "TCS", published_date: "2026-06-21T02:00:00Z", ai_insights: { announcement_type: "Financial Results", summary_text: "Result filed" } },
            { id: "a2", ticker: "BSE:500325", company_name: "Reliance", published_date: "2026-06-21T02:05:00Z", sentiment: "Negative", ai_insights: { announcement_type: "Credit Rating", summary_text: "Rating action" } },
          ]
        : [
            { id: "a3", ticker: "INFY.NS", company_name: "Infosys", published_date: "2026-06-21T02:10:00Z", ai_insights: { announcement_type: "Board Meeting", summary_text: "Meeting outcome" } },
          ];
    return new Response(JSON.stringify({ data: rows, meta: { page } }), { status: 200 });
  };
  const result = await fetchIndiaAnnouncements({
    apiKey: "test-key",
    baseUrl: "https://example.test",
    fromDate: "2026-06-20",
    toDate: "2026-06-21",
    limit: 2,
    maxPages: 2,
    fetchImpl,
  });
  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0].ticker, "TCS");
  assert.equal(result.rows[1].sentiment, "negative");
  assert.equal(result.rows[2].source_market, "india");
});

test("normalizeStockInsightsRows supports US filing-shaped rows and dedupes", () => {
  const rows = normalizeStockInsightsRows(
    [
      { id: "sec-1", symbol: "NASDAQ:MSFT", issuer: "Microsoft", form_type: "8-K", summary: "Current report", url: "https://sec.test/1", filing_date: "2026-06-21T01:00:00Z" },
      { id: "sec-1", symbol: "MSFT", issuer: "Microsoft", form_type: "8-K", summary: "Duplicate", url: "https://sec.test/1", filing_date: "2026-06-21T01:00:00Z" },
    ],
    { sourceMarket: "us", sourceKind: "sec_filing" },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, "MSFT");
  assert.equal(rows[0].source_market, "us");
  assert.equal(rows[0].source_kind, "sec_filing");
  assert.equal(rows[0].category, "8-K");
});

test("dedupeStockInsightsItems falls back to stable filing fields", () => {
  const items = dedupeStockInsightsItems([
    { ticker: "TCS", published_at: "2026-06-21", title: "A", source_url: "u" },
    { ticker: "TCS", published_at: "2026-06-21", title: "A", source_url: "u" },
    { ticker: "INFY", published_at: "2026-06-21", title: "B", source_url: "u2" },
  ]);
  assert.equal(items.length, 2);
});
