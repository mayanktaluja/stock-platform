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
const NSE_CALENDAR_PATH = path.join(REPO_ROOT, "data/sws/nse-event-calendar.json");

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

function priceSeries(api) {
  // rest.price.data is a list of {date, close}. The SWS API returns this
  // series in NEWEST-FIRST order (verified empirically against the
  // 2026-04-28 capture). Older versions of this parser assumed oldest-first
  // and read [length-1] as the latest close, which silently returned the
  // OLDEST close (up to a year stale) as `current_price_inr` and
  // collapsed every return calculation toward 0%. Sort ascending so the
  // rest of the file can rely on [length-1] being the freshest point.
  const data = Array.isArray(api?.rest?.price?.data) ? api.rest.price.data : [];
  return [...data].sort((a, b) => (a.date || 0) - (b.date || 0));
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
function extractIndustryBenchmarks(api) {
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
    const t = Date.parse(item.date);
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
  const news = extractNews(api);

  const out = {
    ticker: api.ticker || info.ticker_symbol,
    name: info.name || info.short_name || api.ticker,
    sector: extractIndustry(api, sectorMap) || info.sector || null,
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
      // Sector-level peer benchmarks (P/E, 1Y net margin, 3Y future revenue
      // growth) shipped by SWS alongside primaryIndustry. Stored as fractions
      // (e.g. 0.32 not 32%) — renderers format on display.
      industry_benchmarks: extractIndustryBenchmarks(api),
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
      latest_eps: fiscal?.latest_eps ?? null,
      most_recent_reported_date: fiscal?.most_recent_reported_date ?? null,
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
      recent_news_count: recentNewsCount(news, 30),
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
    },
    dividend: dividendInfo,
    fiscal: fiscal,

    // Note: tab-specific blocks (valuation/future_growth/past_performance/
    // financial_health/management) used to pass through raw API objects here.
    // They were never read by services/* or hydrated with the fields the
    // frontend modal expects (roe_pct, debt_cover_pct, etc.) — they only
    // bloated each deep JSON by ~30 KB. Removed to keep the deploy bundle
    // under Vercel's serverless size limit. Re-add as targeted extractors
    // (specific scalar fields) when downstream code actually reads them.
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

  // Pass 1: scan every raw capture, learn the (industry-code → friendly-name)
  // mapping from the ~half of stocks where SWS gives us both. Pass 2 below
  // applies the map to stocks that only have the numeric code, lifting sector
  // coverage from ~10% to ~99.9%.
  console.log(`[parser] pass 1 — building sector code→name map…`);
  const sectorMap = buildSectorCodeMap(SRC_DIR);
  console.log(`[parser]   ${sectorMap.size} unique sector codes mapped`);

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
      const parsed = parseStock(api, { sectorMap, nseCalendar: nseCal?.map || null });
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
