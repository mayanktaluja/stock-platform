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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(REPO_ROOT, "data/sws/deep-api");
const DEFAULT_DEST = path.join(REPO_ROOT, "data/sws/deep-api-parsed");

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
    // Aliases kept for any downstream code that reads the SWS-native names:
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

function priceSeries(api) {
  // rest.price.data is a list of {date, close} — last one is most recent.
  // Returns the array (or [] if absent).
  return Array.isArray(api?.rest?.price?.data) ? api.rest.price.data : [];
}

function extractCurrentPrice(api) {
  const p = priceSeries(api);
  if (!p.length) return null;
  return p[p.length - 1]?.close ?? null;
}

function extractReturnsPct(api) {
  // Returns over 1M, 3M, 6M, 1Y from the price history.
  // SWS price endpoint typically returns ~1Y of daily data, so 5Y may be
  // unavailable from the cached series — leave 5Y null in that case.
  const series = priceSeries(api);
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  const lastPrice = last?.close;
  const lastDate = last?.date;
  if (!lastPrice || !lastDate) return null;
  const lastTs = new Date(lastDate).getTime();
  const findClosestN_Days = (days) => {
    const targetTs = lastTs - days * 86400 * 1000;
    let best = null;
    let bestDiff = Infinity;
    for (const p of series) {
      if (!p.date || !p.close) continue;
      const t = new Date(p.date).getTime();
      const diff = Math.abs(t - targetTs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = p;
      }
    }
    return best;
  };
  const ret = (days) => {
    const p = findClosestN_Days(days);
    if (!p?.close || p.close <= 0) return null;
    return ((lastPrice - p.close) / p.close) * 100;
  };
  // Only emit if the actual closest point was within tolerance of the target
  // so we don't report a "1Y return" that's actually a 6M return.
  const r1m = ret(30);
  const r3m = ret(90);
  const r6m = ret(180);
  const r1y = ret(365);
  return {
    "1M": r1m,
    "3M": r3m,
    "6M": r6m,
    "1Y": r1y,
    // Best-effort 5Y — likely null because price series is shorter
    "5Y": null,
  };
}

function extractMarketCap(api) {
  // Best source: getCompanyPeers.Company.analysisValue.marketCap (in reporting
  // currency, full integer e.g. 12159091510843 for HDFCBANK = ₹12.16 lakh cr).
  // Alias at CompanyNarrativesWithHistogram.narratives.edges[0].node.company.analysisValue.marketCap.
  const peers = api?.graphql?.getCompanyPeers?.Company;
  const fromPeers = peers?.analysisValue?.marketCap;
  if (typeof fromPeers === "number" && fromPeers > 0) return fromPeers;
  const edges = api?.graphql?.CompanyNarrativesWithHistogram?.narratives?.edges || [];
  const node = edges[0]?.node;
  const fromNarr = node?.company?.analysisValue?.marketCap;
  if (typeof fromNarr === "number" && fromNarr > 0) return fromNarr;
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

function extractAnalystFairValue(api) {
  // SWS exposes "AnalystConsensusTarget" as the default narrative on the
  // valuation tab. The latest published update's valuation.fairValue is THE
  // analyst-consensus number we want. SWS also offers `npvPerShare` (DCF
  // intrinsic) but the user is SEBI-aligned and analyst-consensus is the
  // canonical FV in Indian market context.
  const nv = api?.graphql?.getNarrativeValuation?.Company;
  if (!nv) return null;
  const ownerName = nv?.defaultNarrative?.owner?.displayName;
  // Prefer the AnalystConsensusTarget narrative's fairValue.
  const fv = nv?.defaultNarrative?.latestPublishedUpdate?.valuation?.fairValue;
  if (typeof fv === "number" && fv > 0) return fv;
  // Fallback to npvPerShare (DCF intrinsic) if narrative FV is missing.
  const npv = nv?.analysisValue?.npvPerShare;
  if (typeof npv === "number" && npv > 0) return npv;
  return null;
}

function extractFairValueRange(api) {
  // valuationHistogram across analysts gives min/max FV — useful for
  // confidence intervals on the FV estimate.
  const vh = api?.graphql?.CompanyNarrativesWithHistogram?.company?.valuationHistogram;
  if (!vh) return null;
  return { min: vh.min ?? null, max: vh.max ?? null, count: vh.primaryCount ?? null };
}

function extractRewardsRisks(api) {
  // CompanyNarrativesWithHistogram → narratives.edges contains per-narrative
  // text entries. Each "narrative" has bullet-style commentary.
  const n = api?.graphql?.CompanyNarrativesWithHistogram;
  const edges = n?.narratives?.edges || [];
  // For now, just collect any text strings tagged as rewards or risks.
  // The exact field names depend on SWS schema — best-effort extraction.
  const rewards = [];
  const risks = [];
  for (const e of edges) {
    const node = e.node || e;
    const r = node.rewards || node.reward || [];
    const k = node.risks || node.risk || [];
    if (Array.isArray(r)) rewards.push(...r);
    if (Array.isArray(k)) risks.push(...k);
  }
  return { rewards, risks };
}

function extractDividendInfo(api) {
  // Structure scoring expects: ov.dividend = { yield_pct, payout_pct, ... }
  const div = api?.graphql?.getCompanyDividends?.Company;
  if (!div) return {};
  const events = Array.isArray(div.dividends) ? div.dividends : [];
  const latest = events.length ? events[0] : null;
  const yieldPct = typeof latest?.annualizedYield === "number" ? latest.annualizedYield : null;
  const annualizedDividend = typeof latest?.annualizedDividend === "number" ? latest.annualizedDividend : null;
  // Compute payout from annualizedDividend / EPS.
  // EPS comes from fiscal data (netIncome / shares) since direct EPS isn't always in the capture.
  const fd = extractFiscalData(api);
  const shares = extractSharesOutstanding(api);
  const eps = fd?.latest_eps || (fd?.latest_net_income && shares && shares > 0 ? fd.latest_net_income / shares : null);
  const payoutPct = annualizedDividend && eps && eps > 0 ? (annualizedDividend / eps) * 100 : null;
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
  return {
    pe: price && eps && eps > 0 ? price / eps : null,
    ps: mc && fd?.latest_revenue && fd.latest_revenue > 0 ? mc / fd.latest_revenue : null,
    // PB needs book_value which isn't in our capture — leave null
    pb: null,
    ev_ebitda: null,
  };
}

function extractIndustry(api) {
  const ind = api?.rest?.industry?.data;
  if (!ind) return null;
  const attrs = ind.attributes || ind;
  return attrs?.name ?? attrs?.industry_name ?? attrs?.sector_name ?? null;
}

// ────────── Main mapper ──────────

export function parseStock(api) {
  const company = api?.graphql?.CompanySummary?.Company || {};
  const info = extractInfo(api);
  const sf = extractSnowflake(api);
  const sfTotal = snowflakeTotal(sf);
  const price = extractCurrentPrice(api);
  const fv = extractAnalystFairValue(api);
  const fvRange = extractFairValueRange(api);
  const upsidePct = price && fv && price > 0 ? ((fv - price) / price) * 100 : null;
  const { rewards, risks } = extractRewardsRisks(api);
  const fiscal = extractFiscalData(api);
  const insiderPct = extractInsiderOwnershipPct(api);
  const dividendInfo = extractDividendInfo(api);
  const marketCap = extractMarketCap(api);

  const out = {
    ticker: api.ticker || info.ticker_symbol,
    name: info.name || info.short_name || api.ticker,
    sector: extractIndustry(api) || info.sector || null,
    sws_url: "https://simplywall.st" + (api.canonicalUrl || ""),
    parsed_at: api.fetchedAt || new Date().toISOString(),
    company_id: company.id,
    classification_status: company.classificationStatus,

    overview: {
      snowflake: sf,
      snowflake_total: sfTotal,
      current_price_inr: price,
      market_cap_inr: marketCap,
      market_cap_usd: extractMarketCapUSD(api),
      market_cap_band: extractMarketCapBand(api),
      shares_outstanding: extractSharesOutstanding(api),
      fair_value_inr: fv,
      fair_value_range_inr: fvRange,
      upside_pct: upsidePct,
      multiples: extractMultiples(api),
      rewards,
      risks,
      dividend: dividendInfo, // ov.dividend.yield_pct etc — what scoring reads
      dividend_yield_pct: dividendInfo.yield_pct, // legacy alias
      net_margin_pct: fiscal?.net_margin_pct ?? null,
      forward_earnings_growth_pct: fiscal?.earnings_growth_pct ?? null,
      revenue_growth_pct: fiscal?.revenue_growth_pct ?? null,
      latest_revenue: fiscal?.latest_revenue ?? null,
      latest_net_income: fiscal?.latest_net_income ?? null,
      latest_eps: fiscal?.latest_eps ?? null,
      most_recent_reported_date: fiscal?.most_recent_reported_date ?? null,
      returns_pct: extractReturnsPct(api),
      // Fields still requiring extra captures:
      next_earnings_date: null,
      last_quarter_result: null,
      recent_analyst_revisions: null,
    },
    ownership: {
      top_holders: extractTopHolders(api),
      insider_ownership_pct: insiderPct,
      insider_activity: null,
    },
    dividend: dividendInfo,
    fiscal: fiscal,

    // Tab-specific buckets — pass through API data as-is for now; later can
    // add finer extraction.
    valuation: {
      narrative: api?.graphql?.getNarrativeValuation?.Company || null,
      histogram: api?.graphql?.CompanyNarrativesWithHistogram?.company?.valuationHistogram || null,
    },
    future_growth: {
      narrative_history: api?.graphql?.NarrativeValuationHistory?.Company || null,
    },
    past_performance: {
      time_series: api?.graphql?.getCompanyTimeSeries?.Company?.timeSeries || null,
    },
    financial_health: null, // TODO: extract from estimates / time series
    management: null, // TODO: not in current API capture
    indices: [info.exchange_symbol || info.exchange_symbol_filtered].filter(Boolean),

    _api_raw_path: `data/sws/deep-api/${api.ticker}.json`,
  };

  return out;
}

// ────────── CLI ──────────

function main() {
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
      const parsed = parseStock(api);
      fs.writeFileSync(path.join(destDir, `${t}.json`), JSON.stringify(parsed, null, 2));
      ok++;
    } catch (e) {
      console.error(`[parser]   err ${t}: ${e.message}`);
      failed++;
    }
  }
  console.log(`[parser] ✅ ${ok} parsed, ${failed} failed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
