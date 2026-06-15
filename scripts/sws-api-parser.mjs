#!/usr/bin/env node
/**
 * Convert raw SWS API payloads (data/sws/deep-api/<TICKER>.json) into the
 * scraper-compatible shape (data/sws/deep/<TICKER>.json) so the existing
 * scoring + PDF pipeline can consume our output unchanged.
 *
 * Usage:
 *   node scripts/sws-api-parser.mjs                    # parse all in deep-api/
 *   node scripts/sws-api-parser.mjs HDFCBANK INFY      # parse specific tickers
 *   node scripts/sws-api-parser.mjs --dest deep        # write directly to deep/ (default: deep-api-parsed/)
 *
 * Output shape (matches what sws-scoring.mjs reads):
 *   {
 *     ticker, name, sector, sws_url, parsed_at,
 *     overview: {
 *       snowflake: { value, future, past, health, dividend },
 *       snowflake_total,
 *       current_price_inr, market_cap_inr, fair_value_inr,
 *       upside_pct, dividend_yield_pct,
 *       multiples: { pe, pb, ps, ev_ebitda },
 *       net_margin_pct, returns_pct,
 *       rewards: [...], risks: [...],
 *       ...
 *     },
 *     ownership: { insider_activity, top_holders, ... },
 *     dividend: { recent_payments, ... },
 *     valuation, future_growth, past_performance, financial_health, management,
 *     _api_raw: <reference back to the raw deep-api file>
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractSwsCurrentPrice,
  extractSwsFiftyTwoWeek,
  extractSwsReturnsPct,
  swsPriceSeries,
} from "./sws-price-utils.mjs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(REPO_ROOT, "data/sws/deep-api");
const DEFAULT_DEST = path.join(REPO_ROOT, "data/sws/deep-api-parsed");
const NSE_CALENDAR_PATH = path.join(REPO_ROOT, "data/sws/nse-event-calendar.json");
const GROWW_STOCK_PATH = process.env.SWS_GROWW_STOCK_CACHE || path.join(REPO_ROOT, "data/sws/groww-stock-latest.json");
const GROWW_PE_PATH = process.env.SWS_GROWW_PE_CACHE || path.join(REPO_ROOT, "data/sws/groww-pe-latest.json");

// Load the NSE corporate-actions calendar produced by
// scripts/sws-fetch-nse-calendar.mjs. Returns a Map(symbol → { date, purpose })
// keyed by NSE bare symbol. Used to populate overview.next_earnings_date for
// stocks with upcoming board meetings — the SWS API capture doesn't carry
// this field, so NSE's free /api/event-calendar is our canonical source.
// Returns null when the cache file is missing (treat as "no upcoming dates
// available" rather than failing the parser).
function loadNseCalendarMap() {
  try {
    const raw = JSON.parse(fs.readFileSync(NSE_CALENDAR_PATH, "utf-8"));
    const m = new Map();
    for (const [sym, ev] of Object.entries(raw.by_symbol || {})) {
      if (ev?.date) m.set(sym, ev);
    }
    return { map: m, fetchedAt: raw.fetched_at };
  } catch {
    return null;
  }
}

// ────────── Field extractors ──────────

function extractSnowflake(api) {
  // Use the field names that sws-scoring.mjs reads:
  //   valuation, future, past, financial_health, dividends
  // (vs SWS API's raw: value, future, past, health, dividend)
  const score = api?.graphql?.CompanySummary?.Company?.score;
  if (!score) return null;
  return {
    valuation: score.value ?? 0,
    future: score.future ?? 0,
    past: score.past ?? 0,
    financial_health: score.health ?? 0,
    dividends: score.dividend ?? 0,
    // Long-form aliases — the public/app.js modal reads future_growth /
    // past_performance directly. Without these aliases, the Snowflake hex
    // and pillar list rendered those two cells as "—/6" even though the
    // data was present under the short-form names.
    future_growth: score.future ?? 0,
    past_performance: score.past ?? 0,
    // SWS-native short names — kept for any downstream code that reads them.
    value: score.value ?? 0,
    health: score.health ?? 0,
    dividend: score.dividend ?? 0,
  };
}

function snowflakeTotal(sf) {
  if (!sf) return 0;
  return (sf.valuation || 0) + (sf.future || 0) + (sf.past || 0) + (sf.financial_health || 0) + (sf.dividends || 0);
}

function extractInfo(api) {
  return api?.graphql?.CompanySummary?.Company?.data?.info || {};
}

const priceSeries = swsPriceSeries;
const extractCurrentPrice = extractSwsCurrentPrice;
const extractReturnsPct = extractSwsReturnsPct;
const extractFiftyTwoWeekFromSwsPrice = extractSwsFiftyTwoWeek;

function extractMarketCap(api) {
  // Per-stock market cap lives at .narratives.edges[0].node.company.data
  // .marketCap.listing — the listing-level aggregate (shares × latest price).
  //
  // DO NOT use getCompanyPeers.Company.analysisValue.marketCap — that is a
  // PEER-GROUP aggregate, not the stock's own mcap. An older parser comment
  // claimed it was the right field after spot-checking HDFCBANK (whose peer
  // aggregate happens to coincide with its own mcap); for every smid-cap the
  // peer aggregate was hundreds of times too big. Verified empirically across
  // HDFCBANK / RELIANCE / TCS / JSLL / MPSLTD / BLUEJET on 2026-04-29.
  const edges = api?.graphql?.CompanyNarrativesWithHistogram?.narratives?.edges || [];
  const node = edges[0]?.node;
  const listing = node?.company?.data?.marketCap?.listing;
  if (typeof listing === "number" && listing > 0) return listing;
  // Fallback 1: shares_outstanding from the same narrative × lastSharePrice.
  const sharesNarr = node?.company?.data?.marketCap?.shares_outstanding;
  const price = api?.graphql?.CompanyNarrativesWithHistogram?.company?.analysisValue?.lastSharePrice
    || extractCurrentPrice(api);
  if (typeof sharesNarr === "number" && sharesNarr > 0 && typeof price === "number" && price > 0) {
    return sharesNarr * price;
  }
  // Fallback 2: derive total shares from any ownership row (rest.ownership.data)
  // that has both shares_held and percent_of_shares_outstanding > 0. The
  // largest holder gives the best numerical precision (largest numerator),
  // but any row works mathematically: total = held / (pct / 100). Most
  // narrative-light stocks (IMFA, SHAILY, ITC etc.) hit this fallback —
  // ownership data is populated for the whole NSE/BSE universe.
  const ownership = api?.rest?.ownership?.data;
  if (Array.isArray(ownership) && typeof price === "number" && price > 0) {
    for (const row of ownership) {
      const held = row?.shares_held;
      const pct = row?.percent_of_shares_outstanding;
      if (typeof held === "number" && held > 0 && typeof pct === "number" && pct > 0) {
        const totalShares = held / (pct / 100);
        return totalShares * price;
      }
    }
  }
  return null;
}

function extractMarketCapUSD(api) {
  const peers = api?.graphql?.getCompanyPeers?.Company;
  return peers?.analysisValue?.marketCapUSD ?? null;
}

function extractMarketCapBand(api) {
  // SWS classifies stocks by size: mega8/large/mid/small/micro
  const edges = api?.graphql?.CompanyNarrativesWithHistogram?.narratives?.edges || [];
  return edges[0]?.node?.company?.data?.marketCap?.market_cap_band ?? null;
}

function extractSharesOutstanding(api) {
  const edges = api?.graphql?.CompanyNarrativesWithHistogram?.narratives?.edges || [];
  return edges[0]?.node?.company?.data?.marketCap?.shares_outstanding ?? null;
}

function isAnalystConsensusNarrative(narrative, option = {}) {
  const fields = [
    narrative?.owner?.displayName,
    narrative?.owner?.classification,
    narrative?.type,
    option?.type,
  ].map((v) => String(v || "").trim().toLowerCase());
  return fields.some((v) => v === "analystconsensustarget" || v === "analyst_consensus_target");
}

function isAnalystPriceTargetNarrative(narrative) {
  const fields = [
    narrative?.owner?.displayName,
    narrative?.owner?.classification,
    narrative?.type,
  ].map((v) => String(v || "").trim().toLowerCase());
  return fields.some((v) => v === "analystpricetarget" || v === "analyst_price_target");
}

function sameCompanyId(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function isNarrativeForCompany(narrative, expectedCompanyId) {
  return sameCompanyId(narrative?.companyId, expectedCompanyId);
}

function latestNarrativeFairValue(narrative) {
  const latest = narrative?.latestPublishedUpdate;
  const latestFv = latest?.valuation?.fairValue;
  if (typeof latestFv === "number" && latestFv > 0) {
    return {
      fair_value_inr: latestFv,
      published_at: latest?.publishedAt || null,
    };
  }
  const valuations = Array.isArray(narrative?.valuations) ? narrative.valuations : [];
  const sorted = valuations
    .filter((v) => typeof v?.fairValue === "number" && v.fairValue > 0)
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  if (!sorted.length) return null;
  return {
    fair_value_inr: sorted[0].fairValue,
    published_at: sorted[0].publishedAt || null,
  };
}

function fairValueResult(narrative, option, method) {
  const fv = latestNarrativeFairValue(narrative);
  if (!fv) return null;
  return {
    ...fv,
    source_method: method,
    owner_name: narrative?.owner?.displayName || null,
    owner_classification: narrative?.owner?.classification || null,
    narrative_id: narrative?.id || null,
    company_id: narrative?.companyId || null,
    narrative_type: narrative?.type || option?.type || null,
  };
}

function trustedMatchedFairValue(narrative, option, expectedCompanyId, methodPrefix) {
  if (!isNarrativeForCompany(narrative, expectedCompanyId)) return null;
  const isConsensus = isAnalystConsensusNarrative(narrative, option);
  const isPriceTarget = isAnalystPriceTargetNarrative(narrative);
  if (!isConsensus && !isPriceTarget) return null;
  return fairValueResult(
    narrative,
    option,
    isConsensus ? `${methodPrefix}_consensus` : `${methodPrefix}_analyst_price_target`,
  );
}

function extractAnalystFairValue(api) {
  // `defaultNarrative` can point at arbitrary community narratives and has
  // flipped between min/max-ish values in production. Only explicit SWS
  // analyst-target narratives are allowed into alertable fair value.
  const expectedCompanyId = api?.graphql?.CompanySummary?.Company?.id || api?.companyId || null;
  let mismatchedHistoryCount = 0;
  const historyOptions = api?.graphql?.NarrativeValuationHistory?.company?.valuationOptions;
  if (Array.isArray(historyOptions)) {
    for (const option of historyOptions) {
      const narrative = option?.narrative;
      if (!isNarrativeForCompany(narrative, expectedCompanyId)) {
        if (narrative?.companyId) mismatchedHistoryCount++;
        continue;
      }
      const result = trustedMatchedFairValue(narrative, option, expectedCompanyId, "narrative_history");
      if (result) return result;
    }
  }

  const histogramEdges = api?.graphql?.CompanyNarrativesWithHistogram?.narratives?.edges;
  if (Array.isArray(histogramEdges)) {
    for (const edge of histogramEdges) {
      const result = trustedMatchedFairValue(
        edge?.node,
        null,
        expectedCompanyId,
        "narrative_histogram",
      );
      if (result) return result;
    }
  }

  const nv = api?.graphql?.getNarrativeValuation?.Company;
  const defaultNarrative = nv?.defaultNarrative;
  if (isAnalystConsensusNarrative(defaultNarrative)) {
    const result = fairValueResult(defaultNarrative, null, "default_narrative_consensus");
    if (result) return result;
  }
  if (isAnalystPriceTargetNarrative(defaultNarrative)) {
    const result = fairValueResult(defaultNarrative, null, "default_narrative_analyst_price_target");
    if (result) return result;
  }

  return {
    fair_value_inr: null,
    published_at: null,
    source_method: mismatchedHistoryCount > 0 && !defaultNarrative
      ? "mismatched_history_narrative"
      : defaultNarrative ? "non_consensus_default_narrative" : "missing_consensus_narrative",
    owner_name: defaultNarrative?.owner?.displayName || null,
    owner_classification: defaultNarrative?.owner?.classification || null,
    narrative_id: defaultNarrative?.id || null,
    company_id: defaultNarrative?.companyId || null,
    narrative_type: defaultNarrative?.type || null,
  };
}

function extractFairValueRange(api) {
  // valuationHistogram across analysts gives min/max FV — useful for
  // confidence intervals on the FV estimate.
  const vh = api?.graphql?.CompanyNarrativesWithHistogram?.company?.valuationHistogram;
  if (!vh) return null;
  return { min: vh.min ?? null, max: vh.max ?? null, count: vh.primaryCount ?? null };
}

export function extractRewardsRisks(api) {
  // Source: the /backend/statements REST endpoint (api.rest.statements) — SWS's
  // full ~160-row check list. The on-page "Rewards" and "Risk Analysis"
  // sections are the subset that is public with a definitive pass/fail state:
  //   reward = area "Rewards", public:true, state "pass"
  //   risk   = area "Risks",   public:true, state "fail"
  // Verified against the rendered SWS page — TCS (8 rewards / 0 risks) and
  // ICICIBANK (4 rewards / 2 risks incl. "Unstable dividend track record").
  //
  // The previous implementation read
  // CompanyNarrativesWithHistogram.narratives.edges[].node.rewards — a path
  // that does not exist anywhere in the API response, so every stock in the
  // universe came back with empty arrays (the regression this fixes).
  const list = api?.rest?.statements?.data?.statements?.data;
  if (!Array.isArray(list)) return { rewards: [], risks: [] };
  const pick = (area, state) =>
    list
      .filter((s) => s && s.area === area && s.public === true && s.state === state)
      .map((s) => String(s.description || "").trim())
      .filter(Boolean);
  return { rewards: pick("Rewards", "pass"), risks: pick("Risks", "fail") };
}

const SNOWFLAKE_DATA_PILLARS = ["Value", "Future", "Past", "Health", "Dividends"];
const SNOWFLAKE_UI_CHECK_COUNT = SNOWFLAKE_DATA_PILLARS.length * 6;
const SNOWFLAKE_UI_CHECKS = {
  Value: [
    "IsUndervaluedBasedOnPEG",
    "IsUndervaluedBasedOnDCF",
    "IsUndervaluedOnPERelativeToMarket",
    "IsUndervaluedBasedOnPB",
    "IsUndervaluedOnPERelativeToPeers",
    "IsHighlyUndervaluedBasedOnDCF",
  ],
  Future: [
    "IsReturnOnEquityForecastAboveBenchmark",
    "IsExpectedAnnualProfitGrowthHigh",
    "IsExpectedAnnualProfitGrowthAboveMarket",
    "IsExpectedRevenueGrowthHigh",
    "IsExpectedProfitGrowthAboveRiskFreeRate",
    "IsExpectedRevenueGrowthAboveMarket",
  ],
  Past: [
    "HasProfitGrowthAccelerated",
    "HasPastNetProfitMarginImprovedOverLastYear",
    "HasGrownProfitsOverPast5Years",
    "IsGrowingFasterThanIndustry",
    "HasHighQualityPastEarnings",
    "IsReturnOnEquityAboveThreshold",
  ],
  Health: [
    "IsInterestCoveredByProfit",
    "IsDebtLevelAppropriate",
    "HasDebtReducedOverTime",
    "AreShortTermLiabilitiesCovered",
    "IsDebtCoveredByCashflow",
    "AreLongTermLiabilitiesCovered",
  ],
  BankHealth: [
    "HasAppropriateBadLoanAllowance",
    "HasAppropriateNonPerformingLoans",
    "HasPrimarilyLowRiskFunding",
    "HasAppropriateLoanLevel",
    "HasPrimarilyDepositFunding",
    "HasAnAppropriateLevelOfAssets",
  ],
  Dividends: [
    "IsDividendGrowing",
    "IsDividendSignificant",
    "IsDividendStable",
    "IsDividendCovered",
    "IsDividendCoveredByFreeCashFlow",
    "IsDividendYieldTopTier",
  ],
  BankDividends: [
    "IsDividendCoveredIn3Years",
  ],
};
const INSUFFICIENT_DATA_TEXT_RE = /\b(insufficient data|not enough data|data is not available|no data)\b/i;

function compactText(value, maxLen = 80) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
}

function isInsufficientStatement(row) {
  if (!row || typeof row !== "object") return false;
  if (row.state === "no_data") return true;
  if (row.outcome_name === "OUTCOME_NULL") return true;
  return INSUFFICIENT_DATA_TEXT_RE.test(String(row.description || ""));
}

function classifySnowflakeCheckRow(row) {
  if (!row || typeof row !== "object") {
    return { result: "uncaptured", available: false, insufficient: false };
  }
  if (isInsufficientStatement(row)) {
    return { result: "no_data", available: false, insufficient: true };
  }
  const outcome = String(row.outcome_name || "").toUpperCase();
  if (row.value === true || row.state === "pass" || outcome.startsWith("OUTCOME_TRUE")) {
    return { result: "pass", available: true, insufficient: false };
  }
  if (row.value === false || row.state === "fail" || outcome.startsWith("OUTCOME_FALSE")) {
    return { result: "fail", available: true, insufficient: false };
  }
  return { result: "unknown", available: false, insufficient: false };
}

export function extractSnowflakeCheckMatrix(api) {
  const list = api?.rest?.statements?.data?.statements?.data;
  if (!Array.isArray(list)) return null;

  const rowsByName = new Map();
  for (const row of list) {
    if (row && typeof row === "object" && typeof row.name === "string" && row.public === true) {
      rowsByName.set(row.name, row);
    }
  }

  const healthCheckSet = SNOWFLAKE_UI_CHECKS.BankHealth.some((name) => rowsByName.has(name))
    ? "BankHealth"
    : "Health";
  const healthChecks = SNOWFLAKE_UI_CHECKS[healthCheckSet];
  const dividendChecks = [
    ...SNOWFLAKE_UI_CHECKS.Dividends.filter((name) => rowsByName.has(name)),
    ...SNOWFLAKE_UI_CHECKS.BankDividends.filter((name) => rowsByName.has(name)),
  ].slice(0, 6);
  const checksByPillar = {
    Value: SNOWFLAKE_UI_CHECKS.Value,
    Future: SNOWFLAKE_UI_CHECKS.Future,
    Past: SNOWFLAKE_UI_CHECKS.Past,
    Health: healthChecks,
    Dividends: dividendChecks.length ? dividendChecks : SNOWFLAKE_UI_CHECKS.Dividends,
  };

  const checks = [];
  for (const pillar of SNOWFLAKE_DATA_PILLARS) {
    for (const name of checksByPillar[pillar]) {
      const row = rowsByName.get(name);
      const classified = classifySnowflakeCheckRow(row);
      checks.push({
        pillar,
        name,
        title: compactText(row?.title || name, 64),
        result: classified.result,
        available: classified.available,
        insufficient: classified.insufficient,
        outcome_name: compactText(row?.outcome_name || row?.state || null, 64),
      });
    }
  }

  return {
    version: "sws-visible-snowflake-checks-v1",
    checked_count: SNOWFLAKE_UI_CHECK_COUNT,
    captured_count: checks.filter((c) => c.result !== "uncaptured").length,
    health_check_set: healthCheckSet,
    checks,
  };
}

export function extractSnowflakeDataQuality(api) {
  const list = api?.rest?.statements?.data?.statements?.data;
  if (!Array.isArray(list)) return null;

  const byPillar = Object.fromEntries(
    SNOWFLAKE_DATA_PILLARS.map((pillar) => [pillar, { checked: 6, insufficient: 0 }]),
  );
  const rowsByName = new Map();
  for (const row of list) {
    if (row && typeof row === "object" && typeof row.name === "string" && row.public === true) {
      rowsByName.set(row.name, row);
    }
  }
  const healthChecks = SNOWFLAKE_UI_CHECKS.BankHealth.some((name) => rowsByName.has(name))
    ? SNOWFLAKE_UI_CHECKS.BankHealth
    : SNOWFLAKE_UI_CHECKS.Health;
  const dividendChecks = [
    ...SNOWFLAKE_UI_CHECKS.Dividends.filter((name) => rowsByName.has(name)),
    ...SNOWFLAKE_UI_CHECKS.BankDividends.filter((name) => rowsByName.has(name)),
  ].slice(0, 6);
  const checksByPillar = {
    Value: SNOWFLAKE_UI_CHECKS.Value,
    Future: SNOWFLAKE_UI_CHECKS.Future,
    Past: SNOWFLAKE_UI_CHECKS.Past,
    Health: healthChecks,
    Dividends: dividendChecks.length ? dividendChecks : SNOWFLAKE_UI_CHECKS.Dividends,
  };
  const samples = [];
  let insufficientCount = 0;

  for (const pillar of SNOWFLAKE_DATA_PILLARS) {
    for (const name of checksByPillar[pillar]) {
      const row = rowsByName.get(name);
      if (!isInsufficientStatement(row)) continue;
      insufficientCount++;
      byPillar[pillar].insufficient++;
      if (samples.length < 3) {
        samples.push({
          pillar,
          title: compactText(row.title || row.name, 64),
          reason_code: compactText(row.outcome_name || row.state || row.name, 64),
        });
      }
    }
  }

  if (insufficientCount === 0) return null;

  const affectedPillars = SNOWFLAKE_DATA_PILLARS
    .filter((pillar) => byPillar[pillar].insufficient > 0);

  return {
    insufficient: true,
    insufficient_count: insufficientCount,
    checked_count: SNOWFLAKE_UI_CHECK_COUNT,
    affected_pillars: affectedPillars,
    by_pillar: byPillar,
    samples,
  };
}

function extractDividendInfo(api) {
  // Structure scoring expects: ov.dividend = { yield_pct, payout_pct, ... }
  const div = api?.graphql?.getCompanyDividends?.Company;
  if (!div) return {};
  const events = Array.isArray(div.dividends) ? div.dividends : [];
  const latest = events.length ? events[0] : null;
  const rawYield = typeof latest?.annualizedYield === "number" ? latest.annualizedYield : null;
  // Clamp to gate-sane range (0-50%). SWS occasionally ships stock-dividend
  // events with bps-scaled or stale yields (e.g. ticker 505685 = 460.8%).
  // Same upper bound the sanity gate's SANE.dividend_yield_pct enforces.
  const yieldPct = rawYield != null && rawYield >= 0 && rawYield <= 50 ? rawYield : null;
  const annualizedDividend = typeof latest?.annualizedDividend === "number" ? latest.annualizedDividend : null;
  // Compute payout from annualizedDividend / EPS.
  // EPS comes from fiscal data (netIncome / shares) since direct EPS isn't always in the capture.
  const fd = extractFiscalData(api);
  const shares = extractSharesOutstanding(api);
  const eps = fd?.latest_eps || (fd?.latest_net_income && shares && shares > 0 ? fd.latest_net_income / shares : null);
  // Floor EPS at 1 paisa — below that the ratio is meaningless and explodes
  // (e.g. ALLCARGO with eps≈1e-9 produced payout_pct=1.08e11). Then clamp
  // to the same range the gate's SANE.payout_pct enforces.
  const MIN_EPS_FOR_RATIO = 0.01;
  const rawPayout = annualizedDividend && eps && eps > MIN_EPS_FOR_RATIO ? (annualizedDividend / eps) * 100 : null;
  const payoutPct = rawPayout != null && rawPayout >= 0 && rawPayout <= 200 ? rawPayout : null;
  return {
    yield_pct: yieldPct,
    payout_pct: payoutPct,
    annualized_dividend: annualizedDividend,
    listing_currency: div.listingCurrencyISO,
    recent_payments: events.slice(0, 12),
    payment_count: events.length,
  };
}

function extractTopHolders(api) {
  // rest.ownership.data is a flat list of holder records, each with
  // percent_of_shares_outstanding. SWS doesn't include holder NAMES at this
  // endpoint — those are in a separate query we don't currently capture.
  // For now, return percent + entity_id which is enough for ownership-pct
  // metrics (e.g. insider_ownership_pct = sum of insider rows).
  const data = api?.rest?.ownership?.data;
  if (!Array.isArray(data)) return [];
  return data.slice(0, 20).map((h) => ({
    entity_id: h.holder_id ?? h.holdable_entity_id ?? h.entity_id,
    holder_type: h.holder_type ?? h.type,
    pct: h.percent_of_shares_outstanding ?? h.percent ?? null,
    shares: h.shares ?? h.shares_held,
    is_insider: h.is_insider ?? null,
  }));
}

function extractInsiderOwnershipPct(api) {
  const data = api?.rest?.ownership?.data;
  if (!Array.isArray(data)) return null;
  let total = 0;
  let any = false;
  for (const h of data) {
    if (h.is_insider === true || h.holder_type === "Insider" || h.holder_type === "INSIDER") {
      total += h.percent_of_shares_outstanding || 0;
      any = true;
    }
  }
  return any ? total : null;
}

function extractDividendYieldPct(api) {
  // Latest dividend event's annualizedYield is the current trailing yield.
  const events = api?.graphql?.getCompanyDividends?.Company?.dividends;
  if (!Array.isArray(events) || !events.length) return null;
  // Events are in DESC date order; take the most recent.
  const latest = events[0];
  return typeof latest?.annualizedYield === "number" ? latest.annualizedYield : null;
}

function extractFiscalData(api) {
  // valuation.fiscalData has yearlyTimeSeries with revenue, netIncome, etc.
  const edges = api?.graphql?.CompanyNarrativesWithHistogram?.narratives?.edges || [];
  const fd = edges[0]?.node?.latestPublishedUpdate?.valuation?.fiscalData;
  if (!fd) return null;
  const yearly = Array.isArray(fd.yearlyTimeSeries) ? fd.yearlyTimeSeries : [];
  // Sort newest first
  const sorted = yearly.slice().sort((a, b) => (b.year || 0) - (a.year || 0));
  const latest = sorted[0]?.data || {};
  const prior = sorted[1]?.data || {};
  return {
    most_recent_reported_date: fd.mostRecentReportedDate || null,
    latest_year: sorted[0]?.year || null,
    latest_revenue: latest.revenue ?? null,
    latest_net_income: latest.netIncome ?? null,
    latest_gross_profit: latest.grossProfit ?? null,
    latest_eps: latest.eps ?? null,
    revenue_growth_pct:
      latest.revenue && prior.revenue && prior.revenue > 0
        ? ((latest.revenue - prior.revenue) / prior.revenue) * 100
        : null,
    earnings_growth_pct:
      latest.netIncome && prior.netIncome && prior.netIncome > 0
        ? ((latest.netIncome - prior.netIncome) / prior.netIncome) * 100
        : null,
    net_margin_pct:
      latest.netIncome && latest.revenue && latest.revenue > 0
        ? (latest.netIncome / latest.revenue) * 100
        : null,
    yearly_history: sorted.slice(0, 5).map((y) => ({
      year: y.year,
      revenue: y.data?.revenue ?? null,
      netIncome: y.data?.netIncome ?? null,
      eps: y.data?.eps ?? null,
    })),
  };
}

function extractMultiples(api) {
  // SWS doesn't return PE/PB directly in the captured queries. Compute from
  // fiscal data + market cap.
  const fd = extractFiscalData(api);
  const price = extractCurrentPrice(api);
  const mc = extractMarketCap(api);
  const shares = extractSharesOutstanding(api);
  const eps =
    fd?.latest_eps ||
    (fd?.latest_net_income && shares && shares > 0 ? fd.latest_net_income / shares : null);
  // Floor EPS at 1 paisa — below that price/eps explodes (ABFRL, GMRAIRPORT
  // produced PE of 8e10, 1e12). Then clamp to the same range the gate's
  // SANE.pe enforces (0 < pe < 500). Same MIN_EPS_FOR_RATIO as
  // extractDividendInfo — keep them in sync if changed.
  const MIN_EPS_FOR_RATIO = 0.01;
  const rawPE = price && eps && eps > MIN_EPS_FOR_RATIO ? price / eps : null;
  return {
    pe: rawPE != null && rawPE > 0 && rawPE < 500 ? rawPE : null,
    ps: mc && fd?.latest_revenue && fd.latest_revenue > 0 ? mc / fd.latest_revenue : null,
    // PB needs book_value which isn't in our capture — leave null
    pb: null,
    ev_ebitda: null,
  };
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function sanePe(value) {
  const n = asNumber(value);
  return n != null && n > 0 && n < 500 ? n : null;
}

function finitePe(value) {
  return asNumber(value);
}

function parsePeText(value) {
  return finitePe(value);
}

// Visible SWS valuation statement, e.g.
// "JSLL is good value based on its Price-To-Earnings Ratio (37.9x)
//  compared to the Indian Healthcare industry average (38.7x)."
export function extractSwsStatementPe(api) {
  const list = api?.rest?.statements?.data?.statements?.data;
  if (!Array.isArray(list)) return null;
  const row = list.find((s) => {
    const name = String(s?.name || "");
    const title = String(s?.title || "");
    return name === "IsGoodValueComparingPreferredMultipleToIndustry" ||
      /Price-To-Earnings vs Industry/i.test(title);
  });
  const desc = String(row?.description || "");
  if (!desc) return null;
  const companyPe = parsePeText(
    desc.match(/Price-To-Earnings Ratio\s*\(([-+]?[\d,.]+)\s*x\)/i)?.[1],
  );
  const industryPe = parsePeText(
    desc.match(/industry average\s*\(([-+]?[\d,.]+)\s*x\)/i)?.[1],
  );
  const industryName =
    desc.match(/compared to the\s+(.+?)\s+industry average\s*\(/i)?.[1] ||
    null;
  if (companyPe == null && industryPe == null) return null;
  return {
    company_pe: companyPe,
    industry_pe: industryPe,
    industry_name: industryName,
    description: desc,
    title: row?.title || null,
    name: row?.name || null,
  };
}

export function extractSwsIndustryApiPe(api) {
  const rows = api?.rest?.industry?.data?.company?.data;
  if (!Array.isArray(rows)) return null;
  const peRows = rows.filter((r) => r?.name === "pe" && finitePe(r.value) != null);
  if (!peRows.length) return null;
  const preferred =
    peRows.find((r) => r.type === "median_profitable") ||
    peRows.find((r) => /median/i.test(String(r.type || ""))) ||
    peRows[0];
  return {
    industry_pe: finitePe(preferred.value),
    industry_code: preferred.industry != null ? String(preferred.industry) : null,
    type: preferred.type || null,
    count: preferred.count ?? null,
    source: preferred.source || null,
  };
}

// Numeric SWS industry classification code attached to every stock under
// rest.industry.data.company.data[0].industry. Codes look like 7-digit
// integers (7011000 = Banks, 5110000 = Food/Beverage/Tobacco, ...).
function extractIndustryCode(api) {
  const code = api?.rest?.industry?.data?.company?.data?.[0]?.industry;
  return code != null ? String(code) : null;
}

// Resolves to a friendlyName like "Banks" / "Materials" / "Pharmaceuticals
// & Biotech". Layered sources (most reliable first):
//   1. narratives.edges[0].node.company.primaryIndustry.friendlyName — set
//      for stocks with their own SWS narrative (~10% of universe).
//   2. CompanyNarrativesWithHistogram.company.sponsoredNarratives[0].company
//      .primaryIndustry.friendlyName — fallback when SWS uses a sponsored
//      narrative as the default; covers another big slice.
//   3. sectorMap.get(extractIndustryCode(api)) — fallback by numeric industry
//      code. Code is populated for 99.9% of stocks; the map is built in pass
//      one of the parser run by collecting every (code, friendlyName) pair
//      we find, then applied in pass two.
//   4. Legacy rest.industry.data.attributes.name — almost never populated
//      under the current capture, kept as a defensive last resort.
//
// Combined coverage on the 5,438-stock universe: 99.9%.
function extractIndustry(api, sectorMap = null) {
  const node = api?.graphql?.CompanyNarrativesWithHistogram?.narratives?.edges?.[0]?.node;
  const primary = node?.company?.primaryIndustry?.friendlyName;
  if (typeof primary === "string" && primary.length > 0) return primary;
  const sponsored = api?.graphql?.CompanyNarrativesWithHistogram?.company?.sponsoredNarratives?.[0]?.company?.primaryIndustry?.friendlyName;
  if (typeof sponsored === "string" && sponsored.length > 0) return sponsored;
  if (sectorMap) {
    const code = extractIndustryCode(api);
    if (code && sectorMap.has(code)) return sectorMap.get(code);
    // Prefix fallback — SWS sector codes are 7-digit hierarchical
    // (e.g. 5110000, 5120000, 5130000 are all "Food, Beverage & Tobacco").
    // When the exact code isn't in the discovered map, try shorter prefixes.
    if (code) {
      for (const len of [3, 2, 1]) {
        const prefix = code.slice(0, len);
        for (const [k, v] of sectorMap) {
          if (k.startsWith(prefix)) return v;
        }
      }
    }
  }
  const secondary = node?.company?.secondaryIndustry?.friendlyName;
  if (typeof secondary === "string" && secondary.length > 0) return secondary;
  const ind = api?.rest?.industry?.data;
  if (!ind) return null;
  const attrs = ind.attributes || ind;
  return attrs?.name ?? attrs?.industry_name ?? attrs?.sector_name ?? null;
}

// Pre-scan helper: walks all raw API files in SRC_DIR and collects every
// (industryCode, friendlyName) pair we can find — both from the stock's own
// primaryIndustry and from sponsoredNarratives. Returns a Map(code → name)
// for use as a fallback when extractIndustry can't resolve via direct paths.
export function buildSectorCodeMap(srcDir) {
  const map = new Map();
  let files;
  try {
    files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".json"));
  } catch {
    return map;
  }
  for (const f of files) {
    try {
      const api = JSON.parse(fs.readFileSync(path.join(srcDir, f), "utf-8"));
      const code = api?.rest?.industry?.data?.company?.data?.[0]?.industry;
      if (code == null) continue;
      const codeStr = String(code);
      if (map.has(codeStr)) continue;
      const direct = api?.graphql?.CompanyNarrativesWithHistogram?.narratives?.edges?.[0]?.node?.company?.primaryIndustry?.friendlyName;
      const sponsored = api?.graphql?.CompanyNarrativesWithHistogram?.company?.sponsoredNarratives?.[0]?.company?.primaryIndustry?.friendlyName;
      const name = direct || sponsored;
      if (typeof name === "string" && name.length > 0) map.set(codeStr, name);
    } catch {}
  }
  return map;
}

// Sector-level peer benchmarks SWS publishes alongside primaryIndustry. The
// raw shape is an array of { name, value } pairs; flatten into a flat object
// keyed by snake_case for easy downstream lookup. Values are in fractions
// (e.g. 0.32 not 32) — we keep them in fractions and let renderers format.
function extractPrimaryIndustryBenchmarks(api) {
  const node = api?.graphql?.CompanyNarrativesWithHistogram?.narratives?.edges?.[0]?.node;
  const arr = node?.company?.primaryIndustry?.industryAverages;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const out = {};
  for (const entry of arr) {
    if (entry?.name && typeof entry.value === "number" && Number.isFinite(entry.value)) {
      out[entry.name] = entry.value;
    }
  }
  return Object.keys(out).length ? out : null;
}

function extractSwsIndustryApiBenchmarks(api) {
  const rows = api?.rest?.industry?.data?.company?.data;
  if (!Array.isArray(rows)) return null;
  const pick = (name) => {
    const matches = rows.filter((r) => r?.name === name && finiteNumber(r.value) != null);
    if (!matches.length) return null;
    return matches.find((r) => /median/i.test(String(r.type || ""))) || matches[0];
  };
  const out = {};
  const peRow = pick("pe");
  if (peRow) out.pe = finiteNumber(peRow.value);
  const netMarginRow = pick("net_income_margin_1y");
  if (netMarginRow) out.net_income_margin_1y = finiteNumber(netMarginRow.value);
  const futureRevenueRow = pick("future_revenue_growth_3y");
  if (futureRevenueRow) out.future_revenue_growth_3y = finiteNumber(futureRevenueRow.value);
  return Object.keys(out).length ? out : null;
}

function extractIndustryBenchmarks(api) {
  return {
    primary: extractPrimaryIndustryBenchmarks(api) || {},
    rest: extractSwsIndustryApiBenchmarks(api) || {},
  };
}

export function buildInternalIndustryPeMap(srcDir, sectorMap = null) {
  const byIndustry = new Map();
  let files;
  try {
    files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".json"));
  } catch {
    return new Map();
  }
  for (const f of files) {
    try {
      const api = JSON.parse(fs.readFileSync(path.join(srcDir, f), "utf-8"));
      const code = extractIndustryCode(api);
      if (!code) continue;
      const statement = extractSwsStatementPe(api);
      const pe = sanePe(statement?.company_pe) ?? sanePe(extractMultiples(api).pe);
      if (pe == null) continue;
      if (!byIndustry.has(code)) {
        byIndustry.set(code, {
          values: [],
          industry_code: code,
          industry_name: extractIndustry(api, sectorMap),
        });
      }
      byIndustry.get(code).values.push(pe);
    } catch {}
  }
  const medians = new Map();
  for (const [code, bucket] of byIndustry) {
    const values = bucket.values.sort((a, b) => a - b);
    if (values.length < 3) continue;
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    medians.set(code, {
      industry_pe: median,
      sample_count: values.length,
      industry_code: code,
      industry_name: bucket.industry_name,
    });
  }
  return medians;
}

function normalizeTicker(value) {
  if (value == null) return null;
  return String(value).trim().toUpperCase()
    .replace(/^NSE:/, "")
    .replace(/^BSE:/, "")
    .replace(/\.NS$/, "")
    .replace(/\.BO$/, "") || null;
}

export function loadGrowwPeCache(file = GROWW_PE_PATH) {
  try {
    const cache = JSON.parse(fs.readFileSync(file, "utf-8"));
    const map = new Map();
    for (const [ticker, entry] of Object.entries(cache.by_ticker || {})) {
      const key = normalizeTicker(ticker);
      if (key) map.set(key, entry);
      const nse = normalizeTicker(entry?.nseScriptCode);
      const bse = normalizeTicker(entry?.bseScriptCode);
      if (nse && !map.has(nse)) map.set(nse, entry);
      if (bse && !map.has(bse)) map.set(bse, entry);
    }
    return { cache, map };
  } catch {
    return { cache: null, map: new Map() };
  }
}

export function loadGrowwStockCache(file = GROWW_STOCK_PATH) {
  try {
    const cache = JSON.parse(fs.readFileSync(file, "utf-8"));
    const map = new Map();
    for (const [ticker, entry] of Object.entries(cache.by_ticker || {})) {
      const key = normalizeTicker(ticker);
      if (key) map.set(key, entry);
      const nse = normalizeTicker(entry?.nseScriptCode);
      const bse = normalizeTicker(entry?.bseScriptCode);
      if (nse && !map.has(nse)) map.set(nse, entry);
      if (bse && !map.has(bse)) map.set(bse, entry);
    }
    return { cache, map };
  } catch {
    return { cache: null, map: new Map() };
  }
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function growwFinite(entry, key, { min = -Infinity, max = Infinity, inclusiveMin = true } = {}) {
  const n = finiteNumber(entry?.[key]);
  if (n == null) return null;
  if (inclusiveMin ? n < min : n <= min) return null;
  if (n > max) return null;
  return n;
}

function setSource(sourceMap, key, provider, value, meta = {}) {
  const { fetched_at, url, ...extra } = meta || {};
  sourceMap[key] = {
    provider,
    value,
    fetched_at: fetched_at || null,
    url: url || null,
    ...extra,
  };
}

function resolvePeBenchmark({
  ticker,
  api,
  growwEntry,
  swsMultiples,
  swsIndustryBenchmarks,
  internalIndustryPeMap,
  sectorMap,
}) {
  const swsStatement = extractSwsStatementPe(api);
  const swsIndustryApi = extractSwsIndustryApiPe(api);
  const industryCode = extractIndustryCode(api);
  const internalMedian = industryCode && internalIndustryPeMap?.get?.(industryCode)
    ? internalIndustryPeMap.get(industryCode)
    : null;
  const swsPrimary = swsIndustryBenchmarks?.pe != null
    ? {
        industry_pe: finitePe(swsIndustryBenchmarks.pe),
        industry_name: extractIndustry(api, sectorMap),
        source_path: "CompanyNarrativesWithHistogram.narratives[0].node.company.primaryIndustry.industryAverages.pe",
      }
    : null;

  const audit = {
    groww_refinitiv: growwEntry ? {
      company_pe: finitePe(growwEntry.peRatio),
      industry_pe: finitePe(growwEntry.industryPe),
      industry_name: growwEntry.industryName || null,
      industry_id: growwEntry.industryId ?? null,
      fetched_at: growwEntry.fetchedAt || null,
      url: growwEntry.url || null,
    } : null,
    sws_statement: swsStatement,
    sws_industry_api: swsIndustryApi,
    internal_median: internalMedian,
    sws_primary_industry: swsPrimary,
    sws_computed: { company_pe: finitePe(swsMultiples?.pe) },
  };

  const companySource = (() => {
    const growwPe = finitePe(growwEntry?.peRatio);
    if (growwPe != null) {
      return {
        provider: "groww_refinitiv",
        label: "Groww/Refinitiv",
        company_pe: growwPe,
        fetched_at: growwEntry.fetchedAt || null,
        url: growwEntry.url || null,
        search_id: growwEntry.searchId || null,
      };
    }
    const statementPe = finitePe(swsStatement?.company_pe);
    if (statementPe != null) {
      return {
        provider: "sws_statement",
        label: "SWS visible statement",
        company_pe: statementPe,
        fetched_at: api?.fetchedAt || null,
        url: api?.canonicalUrl ? `https://simplywall.st${api.canonicalUrl}` : null,
      };
    }
    const computedPe = finitePe(swsMultiples?.pe);
    if (computedPe != null) {
      return {
        provider: "sws_computed",
        label: "SWS computed",
        company_pe: computedPe,
        fetched_at: api?.fetchedAt || null,
        url: api?.canonicalUrl ? `https://simplywall.st${api.canonicalUrl}` : null,
      };
    }
    return null;
  })();
  const companyOnly = companySource?.company_pe ?? null;

  const sourceFrom = (provider, label, industryPe, extra = {}) => ({
    provider,
    label,
    company_pe: companyOnly,
    company_pe_source: companySource?.provider || null,
    company_pe_source_label: companySource?.label || null,
    industry_pe: finitePe(industryPe),
    ...extra,
  });

  let selected = null;
  if (finitePe(growwEntry?.industryPe) != null) {
    selected = sourceFrom(
      "groww_refinitiv",
      "Groww/Refinitiv",
      growwEntry.industryPe,
      {
        industry_name: growwEntry.industryName || null,
        industry_id: growwEntry.industryId ?? null,
        fetched_at: growwEntry.fetchedAt || null,
        url: growwEntry.url || null,
        search_id: growwEntry.searchId || null,
      },
    );
  } else if (finitePe(swsIndustryApi?.industry_pe) != null) {
    selected = sourceFrom(
      "sws_industry_api",
      "SWS industry API",
      swsIndustryApi.industry_pe,
      {
        industry_name: extractIndustry(api, sectorMap) || swsIndustryApi?.source?.name || null,
        industry_code: swsIndustryApi.industry_code,
        sample_count: swsIndustryApi.count ?? null,
        statistic: swsIndustryApi.type || null,
      },
    );
  } else if (finitePe(swsStatement?.industry_pe) != null) {
    selected = sourceFrom(
      "sws_statement",
      "SWS visible statement",
      swsStatement.industry_pe,
      { industry_name: swsStatement.industry_name || extractIndustry(api, sectorMap) || null },
    );
  } else if (sanePe(internalMedian?.industry_pe) != null) {
    selected = sourceFrom(
      "internal_industry_median",
      "Internal industry median",
      internalMedian.industry_pe,
      {
        industry_name: internalMedian.industry_name || extractIndustry(api, sectorMap) || null,
        industry_code: internalMedian.industry_code || industryCode || null,
        sample_count: internalMedian.sample_count ?? null,
      },
    );
  }

  if (!selected) {
    return {
      company_pe: companyOnly,
      industry_pe: null,
      company_source: companySource,
      source: {
        provider: "degraded",
        label: "No usable P/E benchmark",
        company_pe: companyOnly,
        company_pe_source: companySource?.provider || null,
        company_pe_source_label: companySource?.label || null,
        industry_pe: null,
        reason: "groww_sws_and_internal_benchmarks_missing",
      },
      audit,
    };
  }
  return {
    company_pe: selected.company_pe,
    industry_pe: selected.industry_pe,
    company_source: companySource,
    source: selected,
    audit,
  };
}

// ────────── News / activity extraction ──────────
//
// Primary source: the REST endpoint /dashboard/company<canonicalUrl> — the
// SWS frontend's own data feed for the "Recent News & Updates" section.
// Captured via Chrome MCP on 2026-05-09. Returns ~100 records mixing four
// types:
//   {type:"event"}            — corporate actions (headline, situation,
//                               key_dev_type, announcement_date)
//   {type:"brief"}            — analyst-style commentary (title, outcome,
//                               description, name)
//   {type:"narrative"|"narrative-update"} — SWS-published narratives
//                               (title, content, author_*, url)
//
// Fallback path: a GraphQL operation if any future SWS schema change exposes
// per-company activity through a public op. Kept as a forward-compat shim;
// today this branch never matches because no such op exists.
const NEWS_OP_NAMES = [
  "getCompanyUpdates",
  "getCompanyActivity",
  "getCompanyNews",
  "CompanyUpdates",
];
const NEWS_LIST_KEYS = ["updates", "activity", "activities", "news", "feed"];

function pickFirstArray(node, keys) {
  if (!node || typeof node !== "object") return null;
  for (const k of keys) {
    const v = node[k];
    if (Array.isArray(v) && v.length) return v;
    if (v && typeof v === "object" && Array.isArray(v.edges) && v.edges.length) {
      return v.edges.map((e) => (e && e.node) || e).filter(Boolean);
    }
  }
  return null;
}

function findActivityArray(api) {
  const gql = api?.graphql || {};
  for (const opName of NEWS_OP_NAMES) {
    const root = gql[opName];
    if (!root) continue;
    // Try Company.<listKey>, then root.<listKey>, then walk one extra level.
    const candidates = [root.Company, root.company, root, root.data].filter(Boolean);
    for (const c of candidates) {
      const arr = pickFirstArray(c, NEWS_LIST_KEYS);
      if (arr) return arr;
    }
  }
  return [];
}

// Best-effort field mapping. SWS's BriefActivity vs EventActivity carry slightly
// different field names; coerce to one consistent schema. `record` here is the
// already-unwrapped activity object (post Relay unwrap); `record.data` holds
// the type-specific payload when SWS wraps `{ time, type, data }`, otherwise
// the fields live directly on `record`.
function shapeActivity(record) {
  if (!record || typeof record !== "object") return null;
  const inner = (record.data && typeof record.data === "object") ? record.data : record;
  const __typename = inner.__typename || record.__typename || null;
  const isBrief = __typename === "BriefActivity" || record.type === "Brief";
  const isEvent = __typename === "EventActivity" || record.type === "Event";
  const type = isBrief ? "brief" : isEvent ? "event" : (record.type || null);

  // Date: prefer the activity wrapper's `time` (always present), fall back to
  // event-specific announcementDate, then any *Date / *At field on the inner.
  const rawDate =
    record.time ||
    inner.announcementDate ||
    inner.announcedAt ||
    inner.publishedAt ||
    inner.createdAt ||
    inner.updatedAt ||
    null;
  let date = null;
  if (rawDate) {
    const d = new Date(rawDate);
    date = Number.isNaN(d.getTime()) ? String(rawDate) : d.toISOString();
  }

  // Title: BriefActivity uses `title`, EventActivity also exposes `title`
  // (aliased from `headline` in the fragment). Fall back to `headline`/`name`.
  const title = inner.title || inner.headline || inner.name || null;

  // Body: EventActivity has `situation`, BriefActivity has `outcome`.
  const body = inner.situation || inner.outcome || inner.summary || null;

  return {
    id: record.id || inner.id || null,
    type,
    date,
    title,
    body,
    keyDevTypeId: inner.keyDevTypeId || null,
    source_url: inner.url || inner.sourceUrl || null,
    raw_subtype: __typename,
  };
}

// REST endpoint records (the primary path) come pre-typed and pre-flattened.
// Each record is `{activity_id, type, date, headline|title, situation|description, ...}`
// where `type` is already lowercase ("event"|"brief"|"narrative"|"narrative-update").
// Dates are unix-ms or ISO; coerce to ISO consistently.
function shapeRestActivity(rec) {
  if (!rec || typeof rec !== "object") return null;
  const type = rec.type ? String(rec.type).toLowerCase() : null;
  // Date — REST returns unix-ms in `date` and `announcement_date`. Numbers
  // and ISO strings are both possible; Date.parse handles both.
  const rawDate = rec.announcement_date ?? rec.date ?? null;
  let date = null;
  if (rawDate != null) {
    const ms = typeof rawDate === "number" ? rawDate : Date.parse(rawDate);
    if (Number.isFinite(ms)) date = new Date(ms).toISOString();
  }
  // Title precedence by type:
  //   event → headline
  //   brief → title
  //   narrative*-* → title
  // Fall through gracefully if a record doesn't follow the convention.
  const title = rec.headline || rec.title || rec.name || null;
  // Body: events use `situation`, briefs use `description`, narratives use
  // `content`, articles use `excerpt`. Cap at 800 chars to keep deep JSON small.
  let body = rec.situation || rec.description || rec.content || rec.excerpt || rec.outcome_name || null;
  if (typeof body === "string" && body.length > 800) body = body.slice(0, 800);
  if (typeof body !== "string") body = null;
  return {
    id: rec.activity_id || rec.event_id || rec.uuid || null,
    type,
    date,
    title,
    body,
    keyDevTypeId: rec.key_dev_type != null ? String(rec.key_dev_type) : null,
    source_url: rec.url || null,
    raw_subtype: type === "event" ? "EventActivity"
                : type === "brief" ? "BriefActivity"
                : (type || null),
  };
}

function extractNews(api) {
  // ── Primary: REST /dashboard/company endpoint
  const restEvents = api?.rest?.dashboard_company?.data?.events?.data;
  if (Array.isArray(restEvents) && restEvents.length) {
    const cutoff = Date.now() - 180 * 86400 * 1000;
    return restEvents
      .map(shapeRestActivity)
      .filter((n) => n && n.title && n.date)
      .filter((n) => {
        const t = Date.parse(n.date);
        return Number.isFinite(t) ? t >= cutoff : true;
      })
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, 30);
  }
  // ── Fallback: GraphQL activity (forward-compat; not currently used)
  const arr = findActivityArray(api);
  if (!arr.length) return [];
  const shaped = arr
    .map(shapeActivity)
    .filter((n) => n && n.date && n.title);
  const cutoff = Date.now() - 180 * 86400 * 1000;
  return shaped
    .filter((n) => {
      const t = Date.parse(n.date);
      return Number.isFinite(t) ? t >= cutoff : true;
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, 30);
}

function recentNewsCount(news, days = 30) {
  if (!Array.isArray(news) || !news.length) return 0;
  const cutoff = Date.now() - days * 86400 * 1000;
  let n = 0;
  for (const item of news) {
    const t = Date.parse(item.date || item.published_at);
    if (Number.isFinite(t) && t >= cutoff) n++;
  }
  return n;
}

// Gross margin extraction was attempted but the SWS API consistently reports
// grossProfit == revenue (with cogs == null) for the entire Indian-stock
// universe — a data limitation, not a parser bug. Computing margin from
// those two fields yields 100% for every stock, which is useless. Field
// removed; re-enable once a real cogs source is wired up (e.g., a new SWS
// query, or an external EDGAR-equivalent feed).

// ────────── Main mapper ──────────

export function parseStock(api, opts = {}) {
  const sectorMap = opts.sectorMap || null;
  const nseCalendar = opts.nseCalendar || null;
  const growwStockMap = opts.growwStockMap || null;
  const growwPeMap = opts.growwPeMap || null;
  const internalIndustryPeMap = opts.internalIndustryPeMap || null;
  const company = api?.graphql?.CompanySummary?.Company || {};
  const info = extractInfo(api);
  const sf = extractSnowflake(api);
  const sfTotal = snowflakeTotal(sf);
  const snowflakeDataQuality = extractSnowflakeDataQuality(api);
  const snowflakeCheckMatrix = extractSnowflakeCheckMatrix(api);
  const fvResult = extractAnalystFairValue(api);
  const fv = fvResult?.fair_value_inr ?? null;
  const fvRange = extractFairValueRange(api);
  const { rewards, risks } = extractRewardsRisks(api);
  const fiscal = extractFiscalData(api);
  const insiderPct = extractInsiderOwnershipPct(api);
  const swsDividendInfo = extractDividendInfo(api);
  const swsPrice = extractCurrentPrice(api);
  const swsMarketCap = extractMarketCap(api);
  const news = extractNews(api);
  const ticker = api.ticker || info.ticker_symbol;
  const tickerKey = normalizeTicker(ticker);
  const swsMultiples = extractMultiples(api);
  const industryBenchmarkSources = extractIndustryBenchmarks(api);
  const swsPrimaryIndustryBenchmarks = industryBenchmarkSources.primary || {};
  const swsRestIndustryBenchmarks = industryBenchmarkSources.rest || {};
  const swsIndustryBenchmarks = { ...swsRestIndustryBenchmarks, ...swsPrimaryIndustryBenchmarks };
  const growwStockEntry = tickerKey && growwStockMap?.get ? growwStockMap.get(tickerKey) : null;
  const growwPeEntry = tickerKey && growwPeMap?.get ? growwPeMap.get(tickerKey) : null;
  const growwEntry = growwStockEntry || growwPeEntry;
  const growwMeta = growwStockEntry ? {
    fetched_at: growwStockEntry.fetchedAt || growwStockEntry.fetched_at || null,
    url: growwStockEntry.url || null,
  } : {};
  const sourceMap = {};
  const growwPrice = growwFinite(growwStockEntry, "currentPriceInr", { min: 0, inclusiveMin: false });
  const price = swsPrice ?? growwPrice;
  if (swsPrice != null) {
    setSource(sourceMap, "current_price_inr", "sws_price", price, {
      fetched_at: api.fetchedAt || null,
      url: api.canonicalUrl ? `https://simplywall.st${api.canonicalUrl}` : null,
    });
  } else if (growwPrice != null) {
    setSource(sourceMap, "current_price_inr", "groww_refinitiv", price, growwMeta);
  }
  const growwMarketCap = growwFinite(growwStockEntry, "marketCapInr", { min: 0, inclusiveMin: false });
  const marketCap = growwMarketCap ?? swsMarketCap;
  if (growwMarketCap != null) setSource(sourceMap, "market_cap_inr", "groww_refinitiv", marketCap, growwMeta);
  const upsidePct = price && fv && price > 0 ? ((fv - price) / price) * 100 : null;
  const swsMeta = {
    fetched_at: api.fetchedAt || null,
    url: api.canonicalUrl ? `https://simplywall.st${api.canonicalUrl}` : null,
  };
  if (fv != null) setSource(sourceMap, "fair_value_inr", "sws_analyst_fair_value", fv, {
    ...swsMeta,
    method: fvResult?.source_method || null,
    owner_name: fvResult?.owner_name || null,
    owner_classification: fvResult?.owner_classification || null,
    narrative_id: fvResult?.narrative_id || null,
    company_id: fvResult?.company_id || null,
    narrative_type: fvResult?.narrative_type || null,
    published_at: fvResult?.published_at || null,
  });
  if (upsidePct != null) setSource(sourceMap, "upside_pct", "computed_from_sws_fv_price", upsidePct, swsMeta);
  const peResolution = resolvePeBenchmark({
    ticker: tickerKey,
    api,
    growwEntry,
    swsMultiples,
    swsIndustryBenchmarks: swsPrimaryIndustryBenchmarks,
    internalIndustryPeMap,
    sectorMap,
  });
  const multiples = {
    ...swsMultiples,
    pe: peResolution.company_pe ?? null,
    pb: growwFinite(growwStockEntry, "pbRatio", { min: 0, max: 100 }) ?? swsMultiples.pb ?? null,
    ps: growwFinite(growwStockEntry, "psRatio", { min: 0, max: 100 }) ?? swsMultiples.ps ?? null,
    ev_ebitda: growwFinite(growwStockEntry, "evToEbitda", { min: 0, max: 500 }) ?? swsMultiples.ev_ebitda ?? null,
  };
  const peg = growwFinite(growwStockEntry, "pegRatio", { min: -500, max: 500 });
  if (peg != null) multiples.peg = peg;
  if (peResolution.company_source?.company_pe != null) {
    setSource(sourceMap, "multiples.pe", peResolution.company_source.provider, peResolution.company_source.company_pe, {
      fetched_at: peResolution.company_source.fetched_at || null,
      url: peResolution.company_source.url || null,
    });
  }
  for (const [field, sourceValue, swsValue] of [
    ["multiples.pb", growwStockEntry ? multiples.pb : null, swsMultiples.pb],
    ["multiples.ps", growwStockEntry ? multiples.ps : null, swsMultiples.ps],
    ["multiples.ev_ebitda", growwStockEntry ? multiples.ev_ebitda : null, swsMultiples.ev_ebitda],
    ["multiples.peg", growwStockEntry ? multiples.peg : null, null],
  ]) {
    if (sourceValue != null) setSource(sourceMap, field, "groww_refinitiv", sourceValue, growwMeta);
  }
  const industryBenchmarks = { ...swsIndustryBenchmarks };
  if (peResolution.industry_pe != null) {
    industryBenchmarks.pe = peResolution.industry_pe;
    setSource(sourceMap, "industry_benchmarks.pe", peResolution.source.provider, peResolution.industry_pe, {
      fetched_at: peResolution.source.fetched_at || null,
      url: peResolution.source.url || null,
    });
  } else {
    delete industryBenchmarks.pe;
  }
  for (const key of ["net_income_margin_1y", "future_revenue_growth_3y"]) {
    if (industryBenchmarks[key] == null) continue;
    const provider = swsPrimaryIndustryBenchmarks[key] != null ? "sws_primary_industry" : "sws_industry_api";
    setSource(sourceMap, `industry_benchmarks.${key}`, provider, industryBenchmarks[key], {
      fetched_at: api.fetchedAt || null,
      url: api.canonicalUrl ? `https://simplywall.st${api.canonicalUrl}` : null,
    });
  }
  const sectorPe = growwFinite(growwStockEntry, "sectorPe", { min: 0, max: 500 });
  if (sectorPe != null) {
    industryBenchmarks.sector_pe = sectorPe;
    setSource(sourceMap, "industry_benchmarks.sector_pe", "groww_refinitiv", sectorPe, growwMeta);
  }
  const industryBenchmarksOrNull = Object.keys(industryBenchmarks).length ? industryBenchmarks : null;
  const dividendInfo = { ...swsDividendInfo };
  const growwDividendYield = growwFinite(growwStockEntry, "dividendYieldPct", { min: 0, max: 50 });
  if (growwDividendYield != null) {
    dividendInfo.yield_pct = growwDividendYield;
    setSource(sourceMap, "dividend.yield_pct", "groww_refinitiv", growwDividendYield, growwMeta);
  }
  const growwFiftyTwoWeek = growwStockEntry?.fiftyTwoWeek?.low != null || growwStockEntry?.fiftyTwoWeek?.high != null
    ? {
        low: growwFinite(growwStockEntry.fiftyTwoWeek, "low", { min: 0, inclusiveMin: false }),
        high: growwFinite(growwStockEntry.fiftyTwoWeek, "high", { min: 0, inclusiveMin: false }),
      }
    : null;
  const swsFiftyTwoWeek = growwFiftyTwoWeek ? null : extractFiftyTwoWeekFromSwsPrice(api);
  const fiftyTwoWeek = growwFiftyTwoWeek || swsFiftyTwoWeek;
  if (growwFiftyTwoWeek) {
    setSource(sourceMap, "fifty_two_week", "groww_refinitiv", growwFiftyTwoWeek, growwMeta);
  } else if (swsFiftyTwoWeek) {
    setSource(sourceMap, "fifty_two_week", "sws_price_history", swsFiftyTwoWeek, swsMeta);
  }
  for (const [field, value] of [
    ["latest_eps", growwFinite(growwStockEntry, "epsTtm", { min: 0.01, max: 1e6 })],
    ["book_value", growwFinite(growwStockEntry, "bookValue", { min: -1e9, max: 1e9 })],
    ["face_value", growwFinite(growwStockEntry, "faceValue", { min: 0, max: 1e6 })],
    ["sector_pe", sectorPe],
    ["roe_pct", growwFinite(growwStockEntry, "roePct", { min: -200, max: 500 })],
    ["roa_pct", growwFinite(growwStockEntry, "roaPct", { min: -200, max: 500 })],
    ["roic_pct", growwFinite(growwStockEntry, "roicPct", { min: -200, max: 500 })],
    ["net_margin_pct", growwFinite(growwStockEntry, "netMarginPct", { min: -200, max: 200 })],
    ["operating_margin_pct", growwFinite(growwStockEntry, "operatingMarginPct", { min: -200, max: 200 })],
    ["debt_to_equity_pct", growwFinite(growwStockEntry, "debtToEquityPct", { min: 0, max: 2000 })],
    ["debt_to_asset_pct", growwFinite(growwStockEntry, "debtToAssetPct", { min: 0, max: 100 })],
    ["current_ratio", growwFinite(growwStockEntry, "currentRatio", { min: 0, max: 1000 })],
    ["quick_ratio", growwFinite(growwStockEntry, "quickRatio", { min: 0, max: 1000 })],
    ["cash_ratio", growwFinite(growwStockEntry, "cashRatio", { min: 0, max: 1000 })],
  ]) {
    if (value != null) setSource(sourceMap, field, "groww_refinitiv", value, growwMeta);
  }

  const out = {
    ticker,
    name: info.name || info.short_name || api.ticker,
    sector: extractIndustry(api, sectorMap) || info.sector || null,
    sws_url: "https://simplywall.st" + (api.canonicalUrl || ""),
    parsed_at: api.fetchedAt || new Date().toISOString(),
    company_id: company.id,
    classification_status: company.classificationStatus,
    groww_source: growwStockEntry ? {
      provider: "groww_refinitiv",
      fetched_at: growwMeta.fetched_at,
      url: growwMeta.url,
      search_id: growwStockEntry.searchId || null,
      company_id: growwStockEntry.growwCompanyId || null,
      isin: growwStockEntry.isin || null,
    } : null,

    overview: {
      snowflake: sf,
      snowflake_total: sfTotal,
      ...(snowflakeDataQuality ? { snowflake_data_quality: snowflakeDataQuality } : {}),
      ...(snowflakeCheckMatrix ? { snowflake_check_matrix: snowflakeCheckMatrix } : {}),
      current_price_inr: price,
      market_cap_inr: marketCap,
      market_cap_usd: extractMarketCapUSD(api),
      market_cap_band: extractMarketCapBand(api),
      shares_outstanding: extractSharesOutstanding(api),
      fifty_two_week: fiftyTwoWeek,
      fair_value_inr: fv,
      fair_value_range_inr: fvRange,
      fair_value_source_detail: fvResult ? {
        method: fvResult.source_method || null,
        owner_name: fvResult.owner_name || null,
        owner_classification: fvResult.owner_classification || null,
        narrative_id: fvResult.narrative_id || null,
        narrative_type: fvResult.narrative_type || null,
        published_at: fvResult.published_at || null,
      } : null,
      upside_pct: upsidePct,
      multiples,
      multiples_meta: {
        pe_source: peResolution.company_source?.provider || null,
        pe_source_label: peResolution.company_source?.label || null,
        pe_source_text: peResolution.company_source?.provider === "groww_refinitiv"
          ? "Trailing P/E as shown by Groww; underlying data attributed to Refinitiv."
          : null,
        pe_as_of: peResolution.company_source?.fetched_at || null,
        pe_basis: "trailing_ttm",
        pe_source_url: peResolution.company_source?.url || null,
      },
      rewards,
      risks,
      dividend: dividendInfo, // ov.dividend.yield_pct etc — what scoring reads
      dividend_yield_pct: dividendInfo.yield_pct, // legacy alias
      // Sector-level peer benchmarks (P/E, 1Y net margin, 3Y future revenue
      // growth) shipped by SWS alongside primaryIndustry. Stored as fractions
      // (e.g. 0.32 not 32%) — renderers format on display.
      industry_benchmarks: industryBenchmarksOrNull,
      industry_benchmarks_meta: {
        pe_source: peResolution.source.provider,
        pe_source_label: peResolution.source.label,
        pe_as_of: peResolution.source.fetched_at || null,
        pe_basis: "provider_per_stock_benchmark",
        pe_industry_name: peResolution.source.industry_name || null,
        pe_industry_id: peResolution.source.industry_id ?? null,
        pe_source_url: peResolution.source.url || null,
      },
      pe_benchmark_source: peResolution.source,
      pe_benchmark_audit: peResolution.audit,
      source_map: sourceMap,
      // PAST YoY earnings growth (latest reported FY vs prior FY). The SWS
      // capture's yearlyTimeSeries holds only reported years, so this cannot
      // be "forward". v1's pts_growth used to read forward_earnings_growth_pct
      // from this field — that was a mislabel. Forward growth now comes only
      // from the rewards regex ("forecast to grow X% per year"), which is the
      // actual analyst forward signal that SWS surfaces.
      earnings_growth_yoy_pct: fiscal?.earnings_growth_pct ?? null,
      forward_earnings_growth_pct: null,
      revenue_growth_pct: fiscal?.revenue_growth_pct ?? null,
      latest_revenue: fiscal?.latest_revenue ?? null,
      latest_net_income: fiscal?.latest_net_income ?? null,
      latest_eps: growwFinite(growwStockEntry, "epsTtm", { min: 0.01, max: 1e6 }) ?? fiscal?.latest_eps ?? null,
      most_recent_reported_date: fiscal?.most_recent_reported_date ?? null,
      pb: multiples.pb ?? null,
      ps: multiples.ps ?? null,
      book_value: growwFinite(growwStockEntry, "bookValue", { min: -1e9, max: 1e9 }),
      face_value: growwFinite(growwStockEntry, "faceValue", { min: 0, max: 1e6 }),
      sector_pe: sectorPe,
      roe_pct: growwFinite(growwStockEntry, "roePct", { min: -200, max: 500 }),
      roa_pct: growwFinite(growwStockEntry, "roaPct", { min: -200, max: 500 }),
      roic_pct: growwFinite(growwStockEntry, "roicPct", { min: -200, max: 500 }),
      net_margin_pct: growwFinite(growwStockEntry, "netMarginPct", { min: -200, max: 200 }) ?? fiscal?.net_margin_pct ?? null,
      operating_margin_pct: growwFinite(growwStockEntry, "operatingMarginPct", { min: -200, max: 200 }),
      debt_to_equity_pct: growwFinite(growwStockEntry, "debtToEquityPct", { min: 0, max: 2000 }),
      debt_to_asset_pct: growwFinite(growwStockEntry, "debtToAssetPct", { min: 0, max: 100 }),
      current_ratio: growwFinite(growwStockEntry, "currentRatio", { min: 0, max: 1000 }),
      quick_ratio: growwFinite(growwStockEntry, "quickRatio", { min: 0, max: 1000 }),
      cash_ratio: growwFinite(growwStockEntry, "cashRatio", { min: 0, max: 1000 }),
      returns_pct: extractReturnsPct(api),
      // Fields still requiring extra captures:
      // NSE corporate-actions calendar lookup. Date is ISO YYYY-MM-DD when
      // the symbol has an upcoming Financial Results board meeting, null
      // otherwise. Source: nse.js::fetchNseEventCalendar (cached to
      // data/sws/nse-event-calendar.json by sws-fetch-nse-calendar.mjs).
      next_earnings_date: nseCalendar?.get?.((api.ticker || "").toUpperCase())?.date || null,
      // Number of news/activity items in the last 30 days. The full list lives
      // on out.news (top-level) — this scalar is the cheap signal for the
      // scoring/UI layer to badge a stock as "fresh news this month" without
      // pulling the full array.
      recent_news_count: Math.max(recentNewsCount(news, 30), recentNewsCount(growwStockEntry?.news, 30)),
      // last_quarter_result (beat/miss/inline) requires post-result analyst
      // commentary which neither the SWS capture nor the NSE feed surfaces.
      // Left null until a separate result-tracker pipeline lands.
      last_quarter_result: null,
      recent_analyst_revisions: null,
    },
    ownership: {
      top_holders: extractTopHolders(api),
      insider_ownership_pct: insiderPct,
      insider_activity: null,
      promoter_pct: growwFinite(growwStockEntry?.shareholding, "promoter_pct", { min: 0, max: 100 }),
      fii_pct: growwFinite(growwStockEntry?.shareholding, "fii_pct", { min: 0, max: 100 }),
      mutual_fund_pct: growwFinite(growwStockEntry?.shareholding, "mutual_fund_pct", { min: 0, max: 100 }),
      insurance_pct: growwFinite(growwStockEntry?.shareholding, "insurance_pct", { min: 0, max: 100 }),
      other_domestic_institution_pct: growwFinite(growwStockEntry?.shareholding, "other_domestic_institution_pct", { min: 0, max: 100 }),
      retail_pct: growwFinite(growwStockEntry?.shareholding, "retail_pct", { min: 0, max: 100 }),
      groww_period: growwStockEntry?.shareholding?.period || null,
    },
    dividend: dividendInfo,
    fiscal: fiscal,
    financials: growwStockEntry?.financials ? { groww: growwStockEntry.financials } : null,
    past_performance: growwStockEntry ? {
      roe_pct: growwFinite(growwStockEntry, "roePct", { min: -200, max: 500 }),
      roa_pct: growwFinite(growwStockEntry, "roaPct", { min: -200, max: 500 }),
      roic_pct: growwFinite(growwStockEntry, "roicPct", { min: -200, max: 500 }),
      net_margin_pct: growwFinite(growwStockEntry, "netMarginPct", { min: -200, max: 200 }),
      operating_margin_pct: growwFinite(growwStockEntry, "operatingMarginPct", { min: -200, max: 200 }),
      source: "groww_refinitiv",
    } : null,
    financial_health: growwStockEntry ? {
      debt_to_equity_pct: growwFinite(growwStockEntry, "debtToEquityPct", { min: 0, max: 2000 }),
      debt_to_asset_pct: growwFinite(growwStockEntry, "debtToAssetPct", { min: 0, max: 100 }),
      current_ratio: growwFinite(growwStockEntry, "currentRatio", { min: 0, max: 1000 }),
      quick_ratio: growwFinite(growwStockEntry, "quickRatio", { min: 0, max: 1000 }),
      cash_ratio: growwFinite(growwStockEntry, "cashRatio", { min: 0, max: 1000 }),
      source: "groww_refinitiv",
    } : null,
    events: growwStockEntry?.events?.length ? { groww: growwStockEntry.events } : null,
    groww: growwStockEntry ? {
      source: "groww_refinitiv",
      fetched_at: growwMeta.fetched_at,
      url: growwMeta.url,
      news: Array.isArray(growwStockEntry.news) ? growwStockEntry.news : [],
      events: Array.isArray(growwStockEntry.events) ? growwStockEntry.events : [],
      peers: Array.isArray(growwStockEntry.peers) ? growwStockEntry.peers : [],
      details: growwStockEntry.details || null,
    } : null,

    // Note: old raw tab-specific SWS blocks were removed because they bloated
    // each deep JSON by ~30 KB. The small past_performance/financial_health
    // blocks above now carry only targeted Groww scalar fields the modal reads.
    indices: [info.exchange_symbol || info.exchange_symbol_filtered].filter(Boolean),

    // SWS news/activity items (Brief + Event), sorted DESC by date, capped at
    // 30 entries within the last 180 days. Empty array when the news GraphQL
    // op wasn't captured for this stock or the company has no recent activity.
    // Surface: stock-detail modal "Recent news" section, daily PDF "What's
    // new this week" section, narration. See extractNews() above for shape.
    news,

    _api_raw_path: `data/sws/deep-api/${api.ticker}.json`,
  };

  return out;
}

// ────────── CLI ──────────

async function main() {
  const args = process.argv.slice(2);
  const destIdx = args.indexOf("--dest");
  let destDir = DEFAULT_DEST;
  if (destIdx >= 0) {
    const arg = args[destIdx + 1];
    destDir = arg === "deep" ? path.join(REPO_ROOT, "data/sws/deep") : arg;
    args.splice(destIdx, 2);
  }
  fs.mkdirSync(destDir, { recursive: true });

  let tickers;
  if (args.length === 0) {
    tickers = fs
      .readdirSync(SRC_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } else {
    tickers = args;
  }
  console.log(`[parser] processing ${tickers.length} tickers → ${destDir}`);

  // Pass 1: scan every raw capture, learn the (industry-code → friendly-name)
  // mapping from the ~half of stocks where SWS gives us both. Pass 2 below
  // applies the map to stocks that only have the numeric code, lifting sector
  // coverage from ~10% to ~99.9%.
  console.log(`[parser] pass 1 — building sector code→name map…`);
  const sectorMap = buildSectorCodeMap(SRC_DIR);
  console.log(`[parser]   ${sectorMap.size} unique sector codes mapped`);

  const growwPe = loadGrowwPeCache(GROWW_PE_PATH);
  const growwStock = loadGrowwStockCache(GROWW_STOCK_PATH);
  if (growwStock.cache) {
    const cov = growwStock.cache.coverage || {};
    console.log(`[parser]   Groww stock cache: ${growwStock.map.size} ticker keys, usable=${cov.usable_count ?? "?"}/${cov.target_count ?? "?"}, fetched ${growwStock.cache.fetched_at || "unknown"}`);
  } else {
    console.log(`[parser]   Groww stock cache: not loaded (canonical Groww fields will fall back to SWS/fundamentals)`);
  }
  if (growwPe.cache) {
    const cov = growwPe.cache.coverage || {};
    console.log(`[parser]   Groww/Refinitiv P/E cache: ${growwPe.map.size} ticker keys, usable=${cov.usable_count ?? "?"}/${cov.target_count ?? "?"}, fetched ${growwPe.cache.fetched_at || "unknown"}`);
  } else {
    console.log(`[parser]   Groww/Refinitiv P/E cache: not loaded (fallback hierarchy will use SWS/internal medians)`);
  }

  console.log(`[parser] pass 1b — building internal industry P/E median fallback…`);
  const internalIndustryPeMap = buildInternalIndustryPeMap(SRC_DIR, sectorMap);
  console.log(`[parser]   ${internalIndustryPeMap.size} industry P/E medians mapped`);

  // NSE event calendar (next earnings date per symbol). Optional — when the
  // cache file is missing, parser proceeds without next_earnings_date.
  const nseCal = loadNseCalendarMap();
  if (nseCal) {
    console.log(`[parser]   NSE calendar: ${nseCal.map.size} symbols with upcoming Financial Results (fetched ${nseCal.fetchedAt})`);
  } else {
    console.log(`[parser]   NSE calendar: not loaded (run scripts/sws-fetch-nse-calendar.mjs to enable next_earnings_date)`);
  }

  let ok = 0, failed = 0;
  for (const t of tickers) {
    const srcPath = path.join(SRC_DIR, `${t}.json`);
    if (!fs.existsSync(srcPath)) {
      console.warn(`[parser]   skip ${t}: src missing`);
      failed++;
      continue;
    }
    try {
      const api = JSON.parse(fs.readFileSync(srcPath, "utf8"));
      const parsed = parseStock(api, {
        sectorMap,
        nseCalendar: nseCal?.map || null,
        growwStockMap: growwStock.map,
        growwPeMap: growwPe.map,
        internalIndustryPeMap,
      });
      fs.writeFileSync(path.join(destDir, `${t}.json`), JSON.stringify(parsed, null, 2));
      ok++;
    } catch (e) {
      console.error(`[parser]   err ${t}: ${e.message}`);
      failed++;
    }
  }
  console.log(`[parser] ✅ ${ok} parsed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
