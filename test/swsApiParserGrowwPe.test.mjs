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
      price: { data: [{ date: "2026-05-24", close: 100 }] },
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
