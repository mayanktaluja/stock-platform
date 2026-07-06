/**
 * Regression tests for Groww/Refinitiv P/E overlay in sws-api-parser.
 *
 * Run with: node test/swsApiParserGrowwPe.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStock, extractSnowflakeDataQuality, extractSnowflakeCheckMatrix } from "../scripts/sws-api-parser.mjs";
import { parseStockUS } from "../scripts/sws-api-parser-us.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BASE_COMPANY_ID = "11111111-1111-1111-1111-111111111111";

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
  statementRows = null,
} = {}) {
  const rows = Array.isArray(statementRows) ? statementRows : statementDescription ? [{
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
          id: BASE_COMPANY_ID,
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
      statements: { data: { statements: { data: rows } } },
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

check("SWS API client passes companyId to NarrativeValuationHistory", () => {
  const clientSrc = fs.readFileSync(path.join(REPO_ROOT, "scripts/sws-api-client.mjs"), "utf8");
  assert.match(clientSrc, /NarrativeValuationHistory:\s*\{\s*companyId\s*\}/);
  assert.doesNotMatch(clientSrc, /NarrativeValuationHistory:\s*\{\s*id:\s*companyId\s*\}/);
});

check("AnalystConsensusTarget valuation history beats unstable non-consensus default narrative", () => {
  const api = baseApi();
  api.graphql.getNarrativeValuation.Company.defaultNarrative = {
    id: "community-default",
    owner: { displayName: "Community Analyst", classification: "community" },
    latestPublishedUpdate: {
      publishedAt: "2026-06-12T00:00:00.000Z",
      valuation: { fairValue: 418.45 },
    },
  };
  api.graphql.NarrativeValuationHistory = {
    company: {
      valuationOptions: [{
        type: "AnalystConsensusTarget",
        narrative: {
          id: "consensus-narrative",
          companyId: BASE_COMPANY_ID,
          owner: { displayName: "AnalystConsensusTarget", classification: "system" },
          latestPublishedUpdate: {
            publishedAt: "2026-06-13T00:00:00.000Z",
            valuation: { fairValue: 750 },
          },
        },
      }],
    },
  };
  const parsed = parseStock(api, { growwPeMap: new Map(), internalIndustryPeMap: new Map() });
  assert.equal(parsed.overview.fair_value_inr, 750);
  assert.equal(parsed.overview.fair_value_source_detail.method, "narrative_history_consensus");
  assert.equal(parsed.overview.fair_value_source_detail.owner_name, "AnalystConsensusTarget");
  assert.equal(parsed.overview.source_map.fair_value_inr.method, "narrative_history_consensus");
});

check("matched AnalystPriceTarget valuation history is trusted", () => {
  const api = baseApi({ priceData: [{ date: "2026-06-10", close: 100 }] });
  api.graphql.getNarrativeValuation.Company.defaultNarrative = {
    id: "community-default",
    owner: { displayName: "Community Analyst", classification: "community" },
    latestPublishedUpdate: { valuation: { fairValue: 418.45 } },
  };
  api.graphql.NarrativeValuationHistory = {
    company: {
      valuationOptions: [{
        type: "ANALYSTS",
        narrative: {
          id: "matched-analyst-target",
          companyId: BASE_COMPANY_ID,
          owner: { displayName: "AnalystPriceTarget", classification: null },
          latestPublishedUpdate: {
            publishedAt: "2026-06-13T00:00:00.000Z",
            valuation: { fairValue: 150 },
          },
        },
      }],
    },
  };
  const parsed = parseStock(api, { growwPeMap: new Map(), growwStockMap: new Map(), internalIndustryPeMap: new Map() });
  assert.equal(parsed.overview.fair_value_inr, 150);
  assert.equal(Number(parsed.overview.upside_pct.toFixed(1)), 50);
  assert.equal(parsed.overview.fair_value_source_detail.method, "narrative_history_analyst_price_target");
  assert.equal(parsed.overview.source_map.fair_value_inr.company_id, BASE_COMPANY_ID);
});

check("mismatched valuation history is rejected even when it looks like AnalystPriceTarget", () => {
  const api = baseApi({ priceData: [{ date: "2026-06-10", close: 100 }] });
  api.graphql.getNarrativeValuation.Company.defaultNarrative = {
    id: "community-default",
    owner: { displayName: "Community Analyst", classification: "community" },
    latestPublishedUpdate: { valuation: { fairValue: 418.45 } },
  };
  api.graphql.NarrativeValuationHistory = {
    company: {
      valuationOptions: [{
        type: "ANALYSTS",
        narrative: {
          id: "sample-company-analyst-target",
          companyId: "00bbeeda-992e-40f0-90dd-dd33576eff05",
          owner: { displayName: "AnalystPriceTarget", classification: null },
          latestPublishedUpdate: {
            publishedAt: "2026-06-13T00:00:00.000Z",
            valuation: { fairValue: 1039.79487 },
          },
        },
      }],
    },
  };
  const parsed = parseStock(api, { growwPeMap: new Map(), growwStockMap: new Map(), internalIndustryPeMap: new Map() });
  assert.equal(parsed.overview.fair_value_inr, null);
  assert.equal(parsed.overview.upside_pct, null);
  assert.equal(parsed.overview.fair_value_source_detail.method, "non_consensus_default_narrative");
  assert.equal(parsed.overview.source_map.fair_value_inr, undefined);
});

check("matched histogram AnalystConsensusTarget beats default AnalystHighTarget", () => {
  const api = baseApi({ priceData: [{ date: "2026-06-10", close: 100 }] });
  api.graphql.getNarrativeValuation.Company.defaultNarrative = {
    id: "default-high-target",
    companyId: BASE_COMPANY_ID,
    owner: { displayName: "AnalystHighTarget", classification: null },
    latestPublishedUpdate: {
      publishedAt: "2026-06-10T00:00:00.000Z",
      valuation: { fairValue: 450 },
    },
  };
  api.graphql.CompanyNarrativesWithHistogram.narratives.edges = [
    {
      node: {
        id: "default-high-target",
        companyId: BASE_COMPANY_ID.toLowerCase(),
        owner: { displayName: "AnalystHighTarget", classification: null },
        latestPublishedUpdate: { valuation: { fairValue: 450 } },
      },
    },
    {
      node: {
        id: "matched-consensus-target",
        companyId: BASE_COMPANY_ID.toLowerCase(),
        owner: { displayName: "AnalystConsensusTarget", classification: null },
        latestPublishedUpdate: {
          publishedAt: "2026-06-11T00:00:00.000Z",
          valuation: { fairValue: 386.3 },
        },
      },
    },
  ];
  const parsed = parseStock(api, { growwPeMap: new Map(), growwStockMap: new Map(), internalIndustryPeMap: new Map() });
  assert.equal(parsed.overview.fair_value_inr, 386.3);
  assert.equal(Number(parsed.overview.upside_pct.toFixed(1)), 286.3);
  assert.equal(parsed.overview.fair_value_source_detail.method, "narrative_histogram_consensus");
  assert.equal(parsed.overview.source_map.fair_value_inr.narrative_id, "matched-consensus-target");
});

check("histogram AnalystHighTarget/AnalystLowTarget remain rejected without consensus", () => {
  const api = baseApi({ priceData: [{ date: "2026-06-10", close: 100 }] });
  api.graphql.getNarrativeValuation.Company.defaultNarrative = {
    id: "default-high-target",
    companyId: BASE_COMPANY_ID,
    owner: { displayName: "AnalystHighTarget", classification: null },
    latestPublishedUpdate: { valuation: { fairValue: 450 } },
  };
  api.graphql.CompanyNarrativesWithHistogram.narratives.edges = [
    {
      node: {
        id: "matched-high-target",
        companyId: BASE_COMPANY_ID,
        owner: { displayName: "AnalystHighTarget", classification: null },
        latestPublishedUpdate: { valuation: { fairValue: 450 } },
      },
    },
    {
      node: {
        id: "matched-low-target",
        companyId: BASE_COMPANY_ID,
        owner: { displayName: "AnalystLowTarget", classification: null },
        latestPublishedUpdate: { valuation: { fairValue: 300 } },
      },
    },
  ];
  const parsed = parseStock(api, { growwPeMap: new Map(), growwStockMap: new Map(), internalIndustryPeMap: new Map() });
  assert.equal(parsed.overview.fair_value_inr, null);
  assert.equal(parsed.overview.upside_pct, null);
  assert.equal(parsed.overview.fair_value_source_detail.method, "non_consensus_default_narrative");
  assert.equal(parsed.overview.source_map.fair_value_inr, undefined);
});

check("default AnalystPriceTarget narrative is trusted for MANORAMA-style fair value", () => {
  const api = baseApi({
    ticker: "MANORAMA",
    priceData: [{ date: "2026-06-10", close: 1540.7 }],
  });
  api.graphql.NarrativeValuationHistory = {
    company: {
      valuationOptions: [
        {
          type: "DCF",
          narrative: {
            owner: { displayName: "Future Cash Flow Value", classification: "DCF" },
            latestPublishedUpdate: { valuation: { fairValue: 479.836742 } },
          },
        },
        {
          type: "ANALYSTS",
          narrative: {
            owner: { displayName: "AnalystPriceTarget", classification: null },
            latestPublishedUpdate: { valuation: { fairValue: 1039.79487 } },
          },
        },
      ],
    },
  };
  api.graphql.getNarrativeValuation.Company.defaultNarrative = {
    id: "manorama-analyst-target",
    owner: { displayName: "AnalystPriceTarget", classification: null },
    latestPublishedUpdate: {
      publishedAt: "2026-06-08T16:31:59.016Z",
      valuation: { fairValue: 1832.010715 },
    },
  };
  const parsed = parseStock(api, { growwPeMap: new Map(), growwStockMap: new Map(), internalIndustryPeMap: new Map() });
  assert.equal(parsed.overview.fair_value_inr, 1832.010715);
  assert.equal(Number(parsed.overview.upside_pct.toFixed(1)), 18.9);
  assert.equal(parsed.overview.fair_value_source_detail.method, "default_narrative_analyst_price_target");
  assert.equal(parsed.overview.source_map.fair_value_inr.owner_name, "AnalystPriceTarget");
});

check("default AnalystPriceTarget narrative is trusted for ARTEMISMED-style fair value", () => {
  const api = baseApi({
    ticker: "ARTEMISMED",
    priceData: [{ date: "2026-06-10", close: 258.25 }],
  });
  api.graphql.NarrativeValuationHistory = {
    company: {
      valuationOptions: [{
        type: "ANALYSTS",
        narrative: {
          owner: { displayName: "AnalystPriceTarget", classification: null },
          latestPublishedUpdate: { valuation: { fairValue: 1039.79487 } },
        },
      }],
    },
  };
  api.graphql.getNarrativeValuation.Company.defaultNarrative = {
    id: "artemismed-analyst-target",
    owner: { displayName: "AnalystPriceTarget", classification: null },
    latestPublishedUpdate: {
      publishedAt: "2026-06-08T16:31:59.016Z",
      valuation: { fairValue: 335 },
    },
  };
  const parsed = parseStock(api, { growwPeMap: new Map(), growwStockMap: new Map(), internalIndustryPeMap: new Map() });
  assert.equal(parsed.overview.fair_value_inr, 335);
  assert.equal(Number(parsed.overview.upside_pct.toFixed(1)), 29.7);
  assert.equal(parsed.overview.fair_value_source_detail.method, "default_narrative_analyst_price_target");
  assert.equal(parsed.overview.source_map.fair_value_inr.owner_name, "AnalystPriceTarget");
});

check("Non-consensus default narrative is not treated as alertable fair value", () => {
  const api = baseApi();
  api.graphql.getNarrativeValuation.Company.defaultNarrative = {
    id: "community-default",
    owner: { displayName: "Community Analyst", classification: "community" },
    latestPublishedUpdate: {
      publishedAt: "2026-06-12T00:00:00.000Z",
      valuation: { fairValue: 418.45 },
    },
  };
  api.graphql.NarrativeValuationHistory = {
    company: { valuationOptions: [] },
  };
  api.graphql.getNarrativeValuation.Company.analysisValue = { npvPerShare: 999 };
  const parsed = parseStock(api, { growwPeMap: new Map(), internalIndustryPeMap: new Map() });
  assert.equal(parsed.overview.fair_value_inr, null);
  assert.equal(parsed.overview.upside_pct, null);
  assert.equal(parsed.overview.fair_value_source_detail.method, "non_consensus_default_narrative");
  assert.equal(parsed.overview.source_map.fair_value_inr, undefined);
});

check("current raw cache parses trusted default AnalystPriceTarget fair values", () => {
  const dir = path.join(REPO_ROOT, "data/sws/deep-api");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  let trustedCount = 0;
  const failures = [];
  for (const file of files) {
    const api = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const defaultNarrative = api?.graphql?.getNarrativeValuation?.Company?.defaultNarrative;
    const owner = String(defaultNarrative?.owner?.displayName || "").trim().toLowerCase();
    const latestFv = defaultNarrative?.latestPublishedUpdate?.valuation?.fairValue;
    const historyFv = Array.isArray(defaultNarrative?.valuations) ? defaultNarrative.valuations[0]?.fairValue : null;
    const trustedFv = typeof latestFv === "number" && latestFv > 0 ? latestFv : historyFv;
    if (owner !== "analystpricetarget" || !(typeof trustedFv === "number" && trustedFv > 0)) continue;
    trustedCount++;
    const parsed = parseStock(api, { growwPeMap: new Map(), growwStockMap: new Map(), internalIndustryPeMap: new Map() });
    if (!Number.isFinite(parsed.overview.fair_value_inr)) failures.push(file.replace(/\.json$/, ""));
  }
  assert.ok(trustedCount > 0, "expected at least one trusted AnalystPriceTarget fixture");
  assert.deepEqual(failures.slice(0, 10), []);
});

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

check("Groww negative own P/E is retained for display while peer P/E still comes from Groww", () => {
  const parsed = parseStock(baseApi(), {
    growwPeMap: new Map([["JSLL", {
      searchId: "jeena-sikho-lifecare-ltd",
      industryName: "Pharmaceuticals",
      peRatio: -12.3,
      industryPe: 45.29762059479049,
      fetchedAt: "2026-05-24T12:00:00.000Z",
      url: "https://groww.in/stocks/jeena-sikho-lifecare-ltd",
    }]]),
    internalIndustryPeMap: new Map(),
  });
  assert.equal(parsed.overview.multiples.pe, -12.3);
  assert.equal(parsed.overview.industry_benchmarks.pe, 45.29762059479049);
  assert.equal(parsed.overview.multiples_meta.pe_source, "groww_refinitiv");
  assert.equal(parsed.overview.pe_benchmark_source.provider, "groww_refinitiv");
});

check("Groww zero own P/E is retained for display", () => {
  const parsed = parseStock(baseApi(), {
    growwPeMap: new Map([["JSLL", {
      searchId: "jeena-sikho-lifecare-ltd",
      industryName: "Pharmaceuticals",
      peRatio: 0,
      industryPe: 45.29762059479049,
      fetchedAt: "2026-05-24T12:00:00.000Z",
      url: "https://groww.in/stocks/jeena-sikho-lifecare-ltd",
    }]]),
    internalIndustryPeMap: new Map(),
  });
  assert.equal(parsed.overview.multiples.pe, 0);
  assert.equal(parsed.overview.industry_benchmarks.pe, 45.29762059479049);
  assert.equal(parsed.overview.source_map["multiples.pe"].provider, "groww_refinitiv");
});

check("Groww null own P/E remains unavailable while Groww industry P/E still populates the peer benchmark", () => {
  const parsed = parseStock(baseApi({ ticker: "WALCHANNAG", statementDescription: null, includeIndustryApi: false, includePrimaryIndustryPe: false }), {
    growwPeMap: new Map([["WALCHANNAG", {
      searchId: "walchandnagar-industries-ltd",
      industryName: "Capital Goods",
      peRatio: null,
      industryPe: 44.85265749196877,
      epsTtm: -2.16,
      fetchedAt: "2026-05-24T12:00:00.000Z",
      url: "https://groww.in/stocks/walchandnagar-industries-ltd",
    }]]),
    internalIndustryPeMap: new Map(),
  });
  assert.equal(parsed.overview.multiples.pe, null);
  assert.equal(parsed.overview.industry_benchmarks.pe, 44.85265749196877);
  assert.equal(parsed.overview.multiples_meta.pe_source, null);
  assert.equal(parsed.overview.pe_benchmark_source.provider, "groww_refinitiv");
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
  assert.equal(parsed.overview.source_map["multiples.peg"].provider, "groww_refinitiv");
  assert.equal(parsed.overview.source_map["multiples.peg"].value, 1.4);
  assert.equal(parsed.overview.source_map["multiples.peg"].fetched_at, "2026-05-24T12:00:00.000Z");
  assert.equal(parsed.overview.source_map["multiples.peg"].url, "https://groww.in/stocks/jeena-sikho-lifecare-ltd");
  assert.equal(parsed.ownership.promoter_pct, 55);
  assert.equal(parsed.ownership.insider_ownership_pct, null);
  assert.equal(parsed.financials.groww.yearly.revenue["2025"], 100);
  assert.equal(parsed.events.groww[0].type, "DIVIDEND");
  assert.equal(parsed.groww.news[0].title, "JSLL expands");
  assert.ok(parsed.overview.recent_news_count >= 1);
});

check("SWS price history derives 52w range when Groww is absent", () => {
  const parsed = parseStock(baseApi({
    priceData: [
      { date: "2026-05-24", close: 25 },
      { date: "2026-05-23", close: 40 },
      { date: "2026-05-22", close: 12.5 },
      { date: "2026-05-21", close: 31 },
    ],
  }), {
    growwPeMap: new Map(),
    internalIndustryPeMap: new Map(),
  });
  assert.deepEqual(parsed.overview.fifty_two_week, { low: 12.5, high: 40 });
  assert.equal(parsed.overview.source_map.fifty_two_week.provider, "sws_price_history");
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

check("SWS visible statement is the fallback when Groww and SWS REST benchmarks are missing", () => {
  const parsed = parseStock(baseApi({ includeIndustryApi: false }), {
    growwPeMap: new Map(),
    internalIndustryPeMap: new Map(),
  });
  assert.equal(parsed.overview.multiples.pe, 37.9);
  assert.equal(parsed.overview.industry_benchmarks.pe, 38.7);
  assert.equal(parsed.overview.pe_benchmark_source.provider, "sws_statement");
});

check("SWS REST fills peer net margin and future revenue growth when primary industry averages are absent", () => {
  const api = baseApi({
    statementDescription: null,
    includeIndustryApi: true,
    includePrimaryIndustryPe: false,
    includeFiscal: true,
  });
  api.rest.industry.data.company.data = [
    { industry: 3070000 },
    { name: "pe", value: 26.36236382, count: 216, industry: 3070000, type: "median_profitable", source: { name: "India" } },
    { name: "net_income_margin_1y", value: 0.1061182964, count: 44, industry: 3070000, type: "median_profitable", source: { name: "India" } },
    { name: "future_revenue_growth_3y", value: 0.5701956747, count: 29, industry: 3070000, type: "avg_weighted_market_cap", source: { name: "India" } },
  ];
  const parsed = parseStock(api, {
    growwPeMap: new Map(),
    internalIndustryPeMap: new Map(),
  });
  assert.equal(parsed.overview.industry_benchmarks.pe, 26.36236382);
  assert.equal(parsed.overview.industry_benchmarks.net_income_margin_1y, 0.1061182964);
  assert.equal(parsed.overview.industry_benchmarks.future_revenue_growth_3y, 0.5701956747);
  assert.equal(parsed.overview.source_map["industry_benchmarks.net_income_margin_1y"].provider, "sws_industry_api");
  assert.equal(parsed.overview.source_map["industry_benchmarks.future_revenue_growth_3y"].provider, "sws_industry_api");
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

console.log("\nsnowflake data-quality metadata\n");

const insufficientRows = [
  {
    name: "IsExpectedRevenueGrowthAboveMarket",
    title: "Revenue vs Market",
    area: "Future",
    public: true,
    state: "no_data",
    outcome_name: "OUTCOME_NULL",
    description: "Insufficient data to determine if revenue is forecast to grow faster than market.",
  },
  {
    name: "IsUndervaluedBasedOnPEG",
    title: "PEG Ratio",
    area: "Value",
    public: true,
    outcome_name: "OUTCOME_NULL",
    description: "Not enough data to determine if the stock is good value.",
  },
  {
    name: "IsGoodValueComparingRatioToFairRatio",
    title: "Price-To-Earnings vs Fair Ratio",
    area: "Value",
    public: false,
    outcome_name: "OUTCOME_NULL",
    description: "Insufficient data in a non-UI valuation row should not count.",
  },
  {
    name: "HasSufficientFinancialData",
    title: "Has Sufficient Financial Data",
    area: "Risks",
    state: "pass",
    outcome_name: "OUTCOME_TRUE",
    description: "At least 3 years of financial data is available.",
  },
];

check("extractSnowflakeDataQuality returns compact pillar metadata for insufficient rows", () => {
  const dq = extractSnowflakeDataQuality(baseApi({ statementRows: insufficientRows }));
  assert.equal(dq.insufficient, true);
  assert.equal(dq.insufficient_count, 2);
  assert.equal(dq.checked_count, 30);
  assert.deepEqual(dq.affected_pillars, ["Value", "Future"]);
  assert.equal(dq.by_pillar.Future.insufficient, 1);
  assert.equal(dq.by_pillar.Future.checked, 6);
  assert.equal(dq.by_pillar.Value.insufficient, 1);
  assert.equal(dq.by_pillar.Value.checked, 6);
  assert.equal(dq.by_pillar.Past.insufficient, 0);
  assert.equal(dq.samples.length, 2);
  assert.ok(!("description" in dq.samples[0]), "samples must not persist long descriptions");
});

check("extractSnowflakeCheckMatrix persists full visible check states", () => {
  const matrix = extractSnowflakeCheckMatrix(baseApi({ statementRows: insufficientRows }));
  assert.equal(matrix.version, "sws-visible-snowflake-checks-v1");
  assert.equal(matrix.checked_count, 30);
  assert.equal(matrix.health_check_set, "Health");
  assert.equal(matrix.checks.length, 30);
  const future = matrix.checks.find((c) => c.name === "IsExpectedRevenueGrowthAboveMarket");
  assert.equal(future.pillar, "Future");
  assert.equal(future.result, "no_data");
  assert.equal(future.available, false);
  assert.equal(future.insufficient, true);
  const peg = matrix.checks.find((c) => c.name === "IsUndervaluedBasedOnPEG");
  assert.equal(peg.result, "no_data");
  assert.equal(matrix.checks.some((c) => c.name === "IsGoodValueComparingRatioToFairRatio"), false);
});

check("extractSnowflakeCheckMatrix separates bank-health check set", () => {
  const matrix = extractSnowflakeCheckMatrix(baseApi({
    statementRows: [{
      name: "HasAppropriateNonPerformingLoans",
      title: "Level of Bad Loans",
      area: "BankHealth",
      public: true,
      value: true,
      outcome_name: "OUTCOME_TRUE",
      description: "Bad loans are appropriate.",
    }],
  }));
  assert.equal(matrix.health_check_set, "BankHealth");
  assert.equal(matrix.checks.filter((c) => c.pillar === "Health").length, 6);
  const bankRow = matrix.checks.find((c) => c.name === "HasAppropriateNonPerformingLoans");
  assert.equal(bankRow.result, "pass");
  assert.equal(bankRow.available, true);
  assert.equal(matrix.checks.some((c) => c.name === "IsDebtLevelAppropriate"), false);
});

check("parseStock persists snowflake_data_quality only when insufficient data exists", () => {
  const thin = parseStock(baseApi({ statementRows: insufficientRows }), {
    growwPeMap: new Map(),
    internalIndustryPeMap: new Map(),
  });
  assert.equal(thin.overview.snowflake_data_quality.insufficient, true);
  const normal = parseStock(baseApi({
    statementRows: [{
      name: "IsExpectedRevenueGrowthAboveMarket",
      title: "Revenue vs Market",
      area: "Future",
      public: true,
      state: "pass",
      outcome_name: "OUTCOME_TRUE",
      description: "Revenue is forecast to grow faster than market.",
    }],
  }), {
    growwPeMap: new Map(),
    internalIndustryPeMap: new Map(),
  });
  assert.equal(normal.overview.snowflake_data_quality, undefined);
  assert.equal(Array.isArray(normal.overview.snowflake_check_matrix.checks), true);
});

check("extractSnowflakeDataQuality is null-safe for missing or malformed statements", () => {
  assert.equal(extractSnowflakeDataQuality({ ticker: "X" }), null);
  assert.equal(extractSnowflakeDataQuality({ rest: { statements: { data: { statements: { data: { bad: true } } } } } }), null);
});

check("US parser wrapper inherits compact snowflake data-quality metadata", () => {
  const us = parseStockUS(baseApi({ ticker: "AAPL", statementRows: insufficientRows }), {});
  assert.equal(us.currency, "USD");
  assert.equal(us.overview.snowflake_data_quality.insufficient, true);
});

check("UMESLTD real SWS payload counts only the 30 visible Snowflake checks", () => {
  const fixturePath = "data/sws/deep-api/UMESLTD.json";
  if (!fs.existsSync(fixturePath)) return;
  const api = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const dq = extractSnowflakeDataQuality(api);
  assert.equal(dq.insufficient, true);
  assert.equal(dq.insufficient_count, 10);
  assert.equal(dq.checked_count, 30);
  assert.deepEqual(dq.affected_pillars, ["Value", "Future", "Dividends"]);
  assert.equal(dq.by_pillar.Value.insufficient, 1);
  assert.equal(dq.by_pillar.Future.insufficient, 6);
  assert.equal(dq.by_pillar.Health.insufficient, 0);
  assert.equal(dq.by_pillar.Dividends.insufficient, 3);
});

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
