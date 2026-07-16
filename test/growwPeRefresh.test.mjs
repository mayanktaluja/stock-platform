/**
 * Unit tests for scripts/groww-pe-refresh.mjs.
 *
 * Run with: node test/growwPeRefresh.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseGrowwNextData,
  parseGrowwScreenerRecords,
  isCacheFresh,
  isCacheUsable,
  buildTickerMap,
  writeCacheOutputs,
  peAliasPreservable,
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
        pegRatio: 1.23,
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
  assert.equal(parsed.pegRatio, 1.23);
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

check("Groww fundamentals-ARRAY shape (2026-07-14 schema change) yields P/E when stats object is gone", () => {
  // Groww dropped stockData.stats and moved fundamentals to an array of
  // {name, shortName, value} display strings. Verbatim shape from the live
  // Reliance page. Before the fix this nulled every valuation field (pe 0%).
  const html = htmlWithPageProps({
    livePriceData: { RELIANCE: { ltp: 1295.5 } },
    stockData: {
      header: { searchId: "reliance-industries-ltd", nseScriptCode: "RELIANCE", bseScriptCode: 500325 },
      priceData: { nse: {} },
      fundamentals: [
        { name: "Market Cap", shortName: "Mkt Cap", value: "₹17,53,005Cr" },
        { name: "ROE", shortName: "ROE", value: "8.94%" },
        { name: "P/E Ratio(TTM)", shortName: "P/E Ratio(TTM)", value: "18.31" },
        { name: "EPS(TTM)", shortName: "EPS(TTM)", value: "70.76" },
        { name: "P/B Ratio", shortName: "P/B Ratio", value: "1.94" },
        { name: "Dividend Yield", shortName: "Div Yield", value: "0.46%" },
        { name: "Industry P/E", shortName: "Industry P/E", value: "13.35" },
        { name: "Book Value", shortName: "Book Value", value: "668.04" },
        { name: "Debt to Equity", shortName: "Debt to Equity", value: "0.44" },
        { name: "Face Value", shortName: "Face Value", value: "10" },
      ],
    },
  });
  const parsed = parseGrowwNextData(html, null, "2026-07-16T00:00:00.000Z");
  assert.equal(parsed.peRatio, 18.31, "P/E from fundamentals array");
  assert.equal(parsed.industryPe, 13.35, "Industry P/E from fundamentals array");
  assert.equal(parsed.epsTtm, 70.76);
  assert.equal(parsed.pbRatio, 1.94);
  assert.equal(parsed.marketCapCr, 1753005, "₹17,53,005Cr → 1753005 (Indian digit grouping stripped)");
  assert.equal(parsed.roePct, 8.94, "ROE % strips the % suffix");
  assert.equal(parsed.faceValue, 10);
});

check("legacy stats object still wins when Groww provides it (forward-compatible)", () => {
  const html = htmlWithPageProps({
    stockData: {
      header: { searchId: "x-ltd", nseScriptCode: "X" },
      stats: { peRatio: 22.5, industryPe: 18.0, epsTtm: 5 },
      fundamentals: [{ name: "P/E Ratio(TTM)", value: "99.9" }],
    },
  });
  const parsed = parseGrowwNextData(html);
  assert.equal(parsed.peRatio, 22.5, "stats.peRatio takes precedence over the fundamentals array");
  assert.equal(parsed.industryPe, 18.0);
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

// ---------------------------------------------------------------------------
// P/E last-good preservation (writeCacheOutputs + peAliasPreservable).
//
// Regression coverage for the 2026-07-14 Groww schema break: when peRatio parses
// to 0% but stock scraping stays healthy, the fresh 0-usable P/E alias must NOT
// clobber the last-good groww-pe-latest.json — else sws-sanity-gate.mjs's 21-day
// stale-grace net (staleFallbackUsable) has no input to fall back on and hard-
// blocks the whole nightly rescan. writeCacheOutputs is synchronous, so these run
// against a throwaway temp dir with no async.
// ---------------------------------------------------------------------------
const DAY_MS = 86400000;

// A groww-stock-v1 cache as refreshCache() builds it: `peUsable` tickers carry a
// valid peRatio+industryPe, plus one all-null ticker so buildPeAliasCache always
// has at least one row even at peUsable=0.
function makeStockCache({ fetchedAt, peUsable }) {
  const by_ticker = { NULLPE: { peRatio: null, industryPe: null, epsTtm: null, nseScriptCode: "NULLPE" } };
  for (let i = 0; i < peUsable; i++) {
    by_ticker["T" + i] = { peRatio: 20 + i, industryPe: 18, epsTtm: 5, nseScriptCode: "T" + i };
  }
  return {
    schema_version: "groww-stock-v1",
    source: "groww_refinitiv",
    fetched_at: fetchedAt,
    coverage: {
      target_count: 5500,
      usable_count: Object.keys(by_ticker).length,
      coverage_pct: 100,
      pe_usable_count: peUsable,
      pe_coverage_pct: peUsable,
    },
    by_ticker,
    missing: { unmapped: [], fetch_failed: [] },
  };
}

// Seed an on-disk groww-pe-v1 alias (the last-good file writeCacheOutputs reads).
function writeAlias(file, { fetchedAt, usable }) {
  const by_ticker = {};
  for (let i = 0; i < usable; i++) by_ticker["T" + i] = { peRatio: 20 + i, industryPe: 18 };
  fs.writeFileSync(file, JSON.stringify({
    schema_version: "groww-pe-v1",
    source: "groww_refinitiv",
    fetched_at: fetchedAt,
    coverage: { target_count: 5500, usable_count: usable, coverage_pct: usable },
    by_ticker,
    missing: { unmapped: [], fetch_failed: [] },
  }));
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "groww-pe-"));
  const opts = { out: path.join(dir, "stock.json"), peOut: path.join(dir, "pe.json"), peStaleGraceDays: 21 };
  try { fn(opts); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

check("P/E collapse + healthy in-grace alias → alias preserved untouched, stock ships fresh", () => {
  withTmp((opts) => {
    const seededAt = new Date(Date.now() - 3 * DAY_MS).toISOString(); // 3d old, within 21d grace
    writeAlias(opts.peOut, { fetchedAt: seededAt, usable: 621 });
    const res = writeCacheOutputs(opts, makeStockCache({ fetchedAt: new Date().toISOString(), peUsable: 0 }));
    assert.equal(res.pePreserved, true, "should report preservation");
    assert.equal(res.preservedUsable, 621);
    const pe = JSON.parse(fs.readFileSync(opts.peOut, "utf-8"));
    assert.equal(pe.coverage.usable_count, 621, "last-good P/E kept");
    assert.equal(pe.fetched_at, seededAt, "fetched_at untouched so grace keeps counting down");
    const stock = JSON.parse(fs.readFileSync(opts.out, "utf-8"));
    assert.equal(stock.coverage.pe_usable_count, 0, "stock cache still shipped fresh");
  });
});

check("P/E collapse + NO usable existing alias → no resurrection (fresh 0-usable written)", () => {
  // (i) alias file absent entirely
  withTmp((opts) => {
    const res = writeCacheOutputs(opts, makeStockCache({ fetchedAt: new Date().toISOString(), peUsable: 0 }));
    assert.equal(res.pePreserved, false);
    const pe = JSON.parse(fs.readFileSync(opts.peOut, "utf-8"));
    assert.equal(pe.coverage.usable_count, 0, "nothing invented when there was no good cache");
  });
  // (ii) alias present but already 0-usable
  withTmp((opts) => {
    writeAlias(opts.peOut, { fetchedAt: new Date(Date.now() - 2 * DAY_MS).toISOString(), usable: 0 });
    const res = writeCacheOutputs(opts, makeStockCache({ fetchedAt: new Date().toISOString(), peUsable: 0 }));
    assert.equal(res.pePreserved, false);
    assert.equal(JSON.parse(fs.readFileSync(opts.peOut, "utf-8")).coverage.usable_count, 0);
  });
});

check("healthy fresh P/E → normal overwrite still happens (fresh wins over old alias)", () => {
  withTmp((opts) => {
    writeAlias(opts.peOut, { fetchedAt: new Date(Date.now() - 5 * DAY_MS).toISOString(), usable: 621 });
    const freshAt = new Date().toISOString();
    const res = writeCacheOutputs(opts, makeStockCache({ fetchedAt: freshAt, peUsable: 300 }));
    assert.equal(res.pePreserved, false);
    const pe = JSON.parse(fs.readFileSync(opts.peOut, "utf-8"));
    assert.equal(pe.coverage.usable_count, 300, "fresh P/E overwrote the old alias");
    assert.equal(pe.fetched_at, freshAt);
  });
});

check("P/E collapse + existing alias older than grace → NOT preserved (gate should block)", () => {
  withTmp((opts) => {
    writeAlias(opts.peOut, { fetchedAt: new Date(Date.now() - 30 * DAY_MS).toISOString(), usable: 621 });
    const res = writeCacheOutputs(opts, makeStockCache({ fetchedAt: new Date().toISOString(), peUsable: 0 }));
    assert.equal(res.pePreserved, false, "expired grace must not resurrect a 30d-old cache");
    assert.equal(JSON.parse(fs.readFileSync(opts.peOut, "utf-8")).coverage.usable_count, 0);
  });
});

check("peAliasPreservable predicate — usable/grace/datability boundaries", () => {
  const NOW = Date.parse("2026-07-16T00:00:00.000Z");
  const at = (days) => new Date(NOW - days * DAY_MS).toISOString();
  assert.equal(peAliasPreservable({ coverage: { usable_count: 0 }, fetched_at: at(1) }, 21, NOW), false, "0 usable → false");
  assert.equal(peAliasPreservable({ coverage: { usable_count: 621 }, fetched_at: at(20) }, 21, NOW), true, "20d < 21 grace → true");
  assert.equal(peAliasPreservable({ coverage: { usable_count: 621 }, fetched_at: at(22) }, 21, NOW), false, "22d > 21 grace → false");
  assert.equal(peAliasPreservable(null, 21, NOW), false, "null → false");
  assert.equal(peAliasPreservable({ coverage: { usable_count: 621 }, fetched_at: "garbage" }, 21, NOW), false, "undatable → false");
});

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
