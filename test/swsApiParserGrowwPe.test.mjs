/**
 * Regression tests for Groww/Refinitiv P/E overlay in sws-api-parser.
 *
 * Run with: node test/swsApiParserGrowwPe.test.mjs
 */

import assert from "node:assert/strict";
import { parseStock } from "../scripts/sws-api-parser.mjs";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "→", e.message); }
}

function baseApi({
  ticker = "JSLL",
  statementDescription = "JSLL is good value based on its Price-To-Earnings Ratio (37.9x) compared to the Indian Healthcare industry average (38.7x).",
  includeIndustryApi = true,
  includePrimaryIndustryPe = true,
  includeFiscal = false,
  priceData = [{ date: "2026-05-24", close: 100 }],
} = {}) {
  const statementRows = statementDescription ? [{
    name: "IsGoodValueComparingPreferredMultipleToIndustry",
    title: "Price-To-Earnings vs Industry",
    area: "Value",
    public: false,
    description: statementDescription,
  }] : [];
  const node = {
    company: {
      data: {
        marketCap: {
          market_cap: 1000000000,
          shares_outstanding: includeFiscal ? 100 : null,
        },
      },
      primaryIndustry: {
        friendlyName: "Healthcare",
        industryAverages: includePrimaryIndustryPe
          ? [{ name: "pe", value: 22.616750576 }]
          : [],
      },
    },
  };
  if (includeFiscal) {
    node.latestPublishedUpdate = {
      valuation: {
        fiscalData: {
          mostRecentReportedDate: "2026-03-31",
          yearlyTimeSeries: [
            { year: 2026, data: { revenue: 1000, netIncome: 500, eps: 5 } },
            { year: 2025, data: { revenue: 900, netIncome: 450, eps: 4.5 } },
          ],
        },
      },
    };
  }
  return {
    ticker,
    canonicalUrl: `/stocks/in/healthcare/nse-${ticker.toLowerCase()}/sample-shares`,
    fetchedAt: "2026-05-24T12:00:00.000Z",
    graphql: {
      CompanySummary: {
        Company: {
          id: "11111111-1111-1111-1111-111111111111",
          classificationStatus: "PRIMARY",
          data: { info: { ticker_symbol: ticker, name: ticker } },
          score: { value: 4, future: 4, past: 4, health: 4, dividend: 4 },
        },
      },
      CompanyNarrativesWithHistogram: {
        narratives: { edges: [{ node }] },
        company: { valuationHistogram: { min: 100, max: 150, primaryCount: 10 } },
      },
      getNarrativeValuation: {
        Company: {
          defaultNarrative: {
            owner: { displayName: "AnalystConsensusTarget" },
            latestPublishedUpdate: { valuation: { fairValue: 180 } },
          },
        },
      },
    },
    rest: {
      price: { data: priceData },
      statements: { data: { statements: { data: statementRows } } },
      industry: {
        data: {
          company: {
            data: includeIndustryApi
              ? [{ industry: 6030000 }, { name: "pe", value: 38.686793244, count: 79, industry: 6030000, type: "median_profitable", source: { name: "India" } }]
              : [{ industry: 6030000 }],
          },
        },
      },
    },
  };
}

console.log("\nsws-api-parser Groww/Refinitiv P/E overlay\n");

check("Groww P/E is canonical over stale SWS primaryIndustry benchmark", () => {
  const parsed = parseStock(baseApi(), {
    growwPeMap: new Map([["JSLL", {
      searchId: "jeena-sikho-lifecare-ltd",
      industryName: "Pharmaceuticals",
      industryId: 46,
      peRatio: 39.58,
      industryPe: 45.29762059479049,
      fetchedAt: "2026-05-24T12:00:00.000Z",
      url: "https://groww.in/stocks/jeena-sikho-lifecare-ltd",
    }]]),
    internalIndustryPeMap: new Map(),
  });
  assert.equal(parsed.overview.multiples.pe, 39.58);
  assert.equal(parsed.overview.industry_benchmarks.pe, 45.29762059479049);
  assert.equal(parsed.overview.pe_benchmark_source.provider, "groww_refinitiv");
  assert.equal(parsed.overview.pe_benchmark_audit.sws_statement.industry_pe, 38.7);
  assert.equal(parsed.overview.pe_benchmark_audit.sws_primary_industry.industry_pe, 22.616750576);
});

check("Groww stock cache enriches fundamentals but SWS remains canonical for price", () => {
  const parsed = parseStock(baseApi({ includeFiscal: true }), {
    growwStockMap: new Map([["JSLL", {
      searchId: "jeena-sikho-lifecare-ltd",
      growwCompanyId: "GSTKJSLL",
      isin: "INE0J5801011",
      industryName: "Pharmaceuticals",
      industryId: 46,
      currentPriceInr: 125,
      marketCapInr: 2500_00_00_000,
      fiftyTwoWeek: { low: 80, high: 140 },
      peRatio: 39.58,
      industryPe: 45.29762059479049,
      pbRatio: 4.4,
      psRatio: 5.5,
      evToEbitda: 18.2,
      pegRatio: 1.4,
      epsTtm: 3.16,
      dividendYieldPct: 1.25,
      roePct: 18.5,
      roaPct: 8.1,
      roicPct: 15.4,
      netMarginPct: 12.2,
      operatingMarginPct: 20.1,
      debtToEquityPct: 24,
      currentRatio: 1.8,
      quickRatio: 1.1,
      cashRatio: 0.4,
      shareholding: {
        period: "Mar '26",
        promoter_pct: 55,
        fii_pct: 12,
        mutual_fund_pct: 8,
        retail_pct: 20,
      },
      financials: { basis: "CONSOLIDATED", yearly: { revenue: { 2025: 100 } }, quarterly: {} },
      news: [{ title: "JSLL expands", published_at: new Date().toISOString() }],
      events: [{ title: "Dividend", type: "DIVIDEND" }],
      fetchedAt: "2026-05-24T12:00:00.000Z",
      url: "https://groww.in/stocks/jeena-sikho-lifecare-ltd",
    }]]),
    growwPeMap: new Map(),
    internalIndustryPeMap: new Map(),
  });
  assert.equal(parsed.overview.current_price_inr, 100);
  assert.equal(parsed.overview.market_cap_inr, 2500_00_00_000);
  assert.deepEqual(parsed.overview.fifty_two_week, { low: 80, high: 140 });
  assert.equal(parsed.overview.upside_pct, 80);
  assert.equal(parsed.overview.multiples.pe, 39.58);
  assert.equal(parsed.overview.multiples.pb, 4.4);
  assert.equal(parsed.overview.multiples.ps, 5.5);
  assert.equal(parsed.overview.multiples.ev_ebitda, 18.2);
  assert.equal(parsed.overview.multiples.peg, 1.4);
  assert.equal(parsed.overview.latest_eps, 3.16);
  assert.equal(parsed.overview.roe_pct, 18.5);
  assert.equal(parsed.overview.debt_to_equity_pct, 24);
  assert.equal(parsed.overview.source_map.current_price_inr.provider, "sws_price");
  assert.equal(parsed.overview.source_map["multiples.pb"].provider, "groww_refinitiv");
  assert.equal(parsed.ownership.promoter_pct, 55);
  assert.equal(parsed.ownership.insider_ownership_pct, null);
  assert.equal(parsed.financials.groww.yearly.revenue["2025"], 100);
  assert.equal(parsed.events.groww[0].type, "DIVIDEND");
  assert.equal(parsed.groww.news[0].title, "JSLL expands");
  assert.ok(parsed.overview.recent_news_count >= 1);
});

check("SWS return horizons use the previous trading bar for 1D across weekends", () => {
  const parsed = parseStock(baseApi({
    includeFiscal: true,
    priceData: [
      { date: "2026-05-25", close: 730.95 },
      { date: "2026-05-22", close: 724.45 },
      { date: "2026-05-18", close: 685.95 },
      { date: "2026-04-24", close: 714.5 },
      { date: "2026-02-24", close: 699.5 },
      { date: "2025-11-26", close: 761.5 },
      { date: "2025-05-26", close: 807.2 },
    ],
  }), {
    growwPeMap: new Map(),
    internalIndustryPeMap: new Map(),
  });
  assert.equal(parsed.overview.current_price_inr, 730.95);
  assert.equal(Number(parsed.overview.returns_pct["1D"].toFixed(3)), 0.897);
  assert.equal(Number(parsed.overview.returns_pct["7D"].toFixed(3)), 6.56);
  assert.equal(Number(parsed.overview.returns_pct["1Y"].toFixed(3)), -9.446);
});

check("SWS visible statement is the first fallback when Groww is missing", () => {
  const parsed = parseStock(baseApi(), {
    growwPeMap: new Map(),
    internalIndustryPeMap: new Map(),
  });
  assert.equal(parsed.overview.multiples.pe, 37.9);
  assert.equal(parsed.overview.industry_benchmarks.pe, 38.7);
  assert.equal(parsed.overview.pe_benchmark_source.provider, "sws_statement");
});

check("SWS industry API fallback uses computed company P/E plus industry median", () => {
  const parsed = parseStock(baseApi({
    statementDescription: null,
    includeIndustryApi: true,
    includePrimaryIndustryPe: true,
    includeFiscal: true,
  }), {
    growwPeMap: new Map(),
    internalIndustryPeMap: new Map(),
  });
  assert.equal(parsed.overview.multiples.pe, 20);
  assert.equal(parsed.overview.industry_benchmarks.pe, 38.686793244);
  assert.equal(parsed.overview.pe_benchmark_source.provider, "sws_industry_api");
});

check("internal industry median fallback works when provider/SWS benchmark paths are absent", () => {
  const parsed = parseStock(baseApi({
    statementDescription: null,
    includeIndustryApi: false,
    includePrimaryIndustryPe: true,
    includeFiscal: true,
  }), {
    growwPeMap: new Map(),
    internalIndustryPeMap: new Map([["6030000", {
      industry_pe: 44.4,
      industry_code: "6030000",
      industry_name: "Healthcare",
      sample_count: 25,
    }]]),
  });
  assert.equal(parsed.overview.multiples.pe, 20);
  assert.equal(parsed.overview.industry_benchmarks.pe, 44.4);
  assert.equal(parsed.overview.pe_benchmark_source.provider, "internal_industry_median");
});

check("missing benchmark drops the P/E leg instead of retaining stale primaryIndustry.pe", () => {
  const parsed = parseStock(baseApi({
    statementDescription: null,
    includeIndustryApi: false,
    includePrimaryIndustryPe: true,
    includeFiscal: false,
  }), {
    growwPeMap: new Map(),
    internalIndustryPeMap: new Map(),
  });
  assert.equal(parsed.overview.multiples.pe, null);
  assert.equal(parsed.overview.industry_benchmarks?.pe, undefined);
  assert.equal(parsed.overview.pe_benchmark_source.provider, "degraded");
});

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
