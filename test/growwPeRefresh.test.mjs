/**
 * Unit tests for scripts/groww-pe-refresh.mjs.
 *
 * Run with: node test/growwPeRefresh.test.mjs
 */

import assert from "node:assert/strict";
import {
  parseGrowwNextData,
  parseGrowwScreenerRecords,
  isCacheFresh,
  isCacheUsable,
  buildTickerMap,
} from "../scripts/groww-pe-refresh.mjs";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "→", e.message); }
}

function htmlWithPageProps(pageProps) {
  return `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json" nonce="abc">${JSON.stringify({ props: { pageProps } })}</script></body></html>`;
}

console.log("\ngroww-pe-refresh parser/cache tests\n");

check("Groww stock page parser extracts Apollo P/E and industry P/E", () => {
  const html = htmlWithPageProps({
    livePriceData: {
      APOLLOHOSP: { ltp: 8372.5, close: 8350, yearLowPrice: 6000, yearHighPrice: 8500, volume: 12345 },
    },
    stockData: {
      header: {
        searchId: "apollo-hospitals-enterprise-ltd",
        growwCompanyId: "GSTK508869",
        isin: "INE437A01024",
        industryId: 30,
        industryName: "Healthcare",
        nseScriptCode: "APOLLOHOSP",
      },
      stats: {
        peRatio: 60.02,
        epsTtm: 139.28,
        industryPe: 60.45827539566765,
        sectorPe: 60.45827539566765,
        marketCap: 120000,
        pbRatio: 12.3,
        priceToSales: 7.2,
        evToEbitda: 33.4,
        dividendYieldInPercent: 0.2,
        roe: 16.4,
        returnOnAssets: 8.2,
        roic: 13.1,
        netProfitMargin: 9.5,
        operatingProfitMargin: 14.5,
        debtToEquity: 0.24,
        currentRatio: 1.8,
        quickRatio: 1.1,
        cashRatio: 0.3,
        bookValue: 681,
        faceValue: 5,
      },
      priceData: { nse: { yearLowPrice: 6000, yearHighPrice: 8500 } },
      shareHoldingPattern: {
        "Mar '26": {
          promoters: { individual: { percent: 30 }, government: { percent: 0 }, corporation: { percent: 0 } },
          mutualFunds: { percent: 12 },
          foreignInstitutions: { percent: 18 },
          otherDomesticInstitutions: { insurance: { percent: 6 }, otherFirms: { percent: 3 } },
          retailAndOthers: { percent: 31 },
        },
      },
      financialStatementV2: {
        CONSOLIDATED: [
          { title: "Revenue", yearly: { 2025: 100 }, quarterly: { "Mar '26": 30 } },
          { title: "Profit", yearly: { 2025: 10 }, quarterly: { "Mar '26": 3 } },
        ],
      },
    },
    newsData: [{ id: "n1", title: "Apollo news", summary: "Summary", pubDate: "2026-05-24T10:00:00", source: "Mint", url: "https://example.com" }],
    eventsData: [{ eventTitle: "Dividend", corporateEventFilter: "DIVIDEND", primaryDate: "2026-06-01T00:00:00", eventDetail: { value: "₹5.00" } }],
  });
  const parsed = parseGrowwNextData(html, "https://groww.in/stocks/apollo-hospitals-enterprise-ltd", "2026-05-24T12:00:00.000Z");
  assert.equal(parsed.searchId, "apollo-hospitals-enterprise-ltd");
  assert.equal(parsed.industryName, "Healthcare");
  assert.equal(parsed.peRatio, 60.02);
  assert.equal(parsed.industryPe, 60.45827539566765);
  assert.equal(parsed.epsTtm, 139.28);
  assert.equal(parsed.currentPriceInr, 8372.5);
  assert.equal(parsed.marketCapInr, 120000 * 1e7);
  assert.deepEqual(parsed.fiftyTwoWeek, { low: 6000, high: 8500 });
  assert.equal(parsed.pbRatio, 12.3);
  assert.equal(parsed.psRatio, 7.2);
  assert.equal(parsed.evToEbitda, 33.4);
  assert.equal(parsed.debtToEquityPct, 24);
  assert.equal(parsed.shareholding.promoter_pct, 30);
  assert.equal(parsed.shareholding.fii_pct, 18);
  assert.equal(parsed.financials.yearly.revenue["2025"], 100);
  assert.equal(parsed.news[0].source, "Mint");
  assert.equal(parsed.events[0].type, "DIVIDEND");
});

check("Groww parser tolerates bank-style NA debt/liquidity fields", () => {
  const html = htmlWithPageProps({
    livePriceData: { HDFCBANK: { ltp: 766.8, yearLowPrice: 726.65, yearHighPrice: 1020.5 } },
    stockData: {
      header: { searchId: "hdfc-bank-ltd", nseScriptCode: "HDFCBANK", industryName: "Banks" },
      stats: {
        peRatio: 14.9,
        epsTtm: 51.45,
        industryPe: 12.45,
        pbRatio: 2.03,
        debtToEquity: "NA",
        currentRatio: "NA",
        quickRatio: "NA",
      },
    },
  });
  const parsed = parseGrowwNextData(html);
  assert.equal(parsed.peRatio, 14.9);
  assert.equal(parsed.debtToEquityPct, null);
  assert.equal(parsed.currentRatio, null);
  assert.equal(parsed.quickRatio, null);
});

check("JSLL Groww parser extracts inline/non-expensive P/E inputs", () => {
  const html = htmlWithPageProps({
    stockData: {
      header: {
        searchId: "jeena-sikho-lifecare-ltd",
        growwCompanyId: "GSTKJSLL",
        isin: "INE0J5801011",
        industryId: 46,
        industryName: "Pharmaceuticals",
        nseScriptCode: "JSLL",
      },
      stats: {
        peRatio: 39.58,
        epsTtm: 39.4,
        industryPe: 45.29762059479049,
        sectorPe: 45.29762059479049,
      },
    },
  });
  const parsed = parseGrowwNextData(html);
  const ratio = parsed.peRatio / parsed.industryPe;
  assert.equal(parsed.peRatio, 39.58);
  assert.equal(parsed.industryPe, 45.29762059479049);
  assert.ok(ratio > 0.8 && ratio <= 1.2, `expected inline ratio, got ${ratio}`);
});

check("Groww screener parser extracts records and ticker map keys", () => {
  const html = htmlWithPageProps({
    screenerData: {
      totalRecords: 2,
      records: [
        { nseScriptCode: "APOLLOHOSP", bseScriptCode: 508869, searchId: "apollo-hospitals-enterprise-ltd" },
        { nseScriptCode: "JSLL", bseScriptCode: 544261, searchId: "jeena-sikho-lifecare-ltd" },
      ],
    },
  });
  const parsed = parseGrowwScreenerRecords(html);
  const map = buildTickerMap(parsed.records);
  assert.equal(parsed.totalRecords, 2);
  assert.equal(map.get("APOLLOHOSP").searchId, "apollo-hospitals-enterprise-ltd");
  assert.equal(map.get("508869").searchId, "apollo-hospitals-enterprise-ltd");
});

check("cache freshness respects TTL and force-stale grace helper", () => {
  const now = new Date("2026-05-24T00:00:00.000Z");
  const fresh = {
    fetched_at: "2026-05-20T00:00:00.000Z",
    expires_at: "2026-05-27T00:00:00.000Z",
    by_ticker: { JSLL: {} },
  };
  const staleButUsable = {
    fetched_at: "2026-05-10T00:00:00.000Z",
    expires_at: "2026-05-17T00:00:00.000Z",
    by_ticker: { JSLL: {} },
  };
  const ancient = {
    fetched_at: "2026-04-20T00:00:00.000Z",
    by_ticker: { JSLL: {} },
  };
  assert.equal(isCacheFresh(fresh, now, 7), true);
  assert.equal(isCacheFresh(staleButUsable, now, 7), false);
  assert.equal(isCacheUsable(staleButUsable, now, 21), true);
  assert.equal(isCacheUsable(ancient, now, 21), false);
});

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
