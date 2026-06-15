/**
 * Sector Outlook — News Aggregator.
 *
 * Groups classified SWS news items by canonical sector across three
 * rolling windows (30d / 90d / 365d), with three correctness levers
 * the adversarial review specifically flagged:
 *
 *   1. CANONICAL TAXONOMY. Sector strings from SWS ("Materials",
 *      "Healthcare", "Software") don't match the production canonical
 *      list. We route through normalizeSector (macroRegime.js:89-224)
 *      and silently drop unclassifiable tickers (telemetry counter
 *      `orphaned_tickers` surfaces the rate to the caller).
 *
 *   2. CONGLOMERATE BODY-ROUTING. RELIANCE news titled
 *      "RELIANCE: Long Term Green Ammonia Offtake" should route 100%
 *      to Oil & Gas, NOT 1/3 each to Oil&Gas/Telecom/Retail. We scan
 *      each news body for sector-keyword groups; if exactly one group
 *      matches, the news is fully attributed to that sector. Multi-
 *      match or no-match falls back to equal 1/N weighting across the
 *      conglomerate's full sector list.
 *
 *   3. SINGLE-ISSUER BREADTH CAP. No one ticker can contribute more
 *      than 15% of a sector's breadth — without this, RELIANCE alone
 *      dominates "Telecom" breadth even after 1/N weighting (24 news
 *      items × 1/3 = 8 contributions vs ~20-30 from Bharti/Vi/Tata
 *      Comm combined).
 *
 * Output shape per (sector × window):
 *   {
 *     theme_distribution: { [theme]: pct },
 *     signed_index: number in [-1, +1],  // mcap-weighted
 *     breadth_pct: 0..1,  // post single-issuer cap
 *     catalyst_proximity_count: int,
 *     evidence_top5: Array,
 *     avg_confidence: number,
 *     n_tickers: int,
 *     n_news: int,
 *   }
 */

import { normalizeSector } from "../../macroRegime.js";
import { resolveSectorsForTicker } from "../riskLab/macro/sectorOverrides.js";
import { THEME_LABELS, THEME_TIME_WEIGHT } from "./themeTaxonomy.js";

const MS_PER_DAY = 86400000;
const WINDOW_DAYS = Object.freeze({
  "30d": 30,
  "90d": 90,
  "365d": 365,
});
const SINGLE_ISSUER_BREADTH_CAP = 0.15;
const EVIDENCE_TOP_N = 5;

/**
 * Conglomerate body-keyword routing. Each conglomerate gets a list of
 * (canonical sector, keyword pattern) tuples. If exactly ONE pattern
 * matches the news (title + body), the news is fully attributed to that
 * sector. Otherwise 1/N weighting kicks in.
 *
 * Keywords are deliberately broad-but-disjoint — a Reliance news body
 * about "petrochemicals" should match Oil&Gas alone, not also Retail.
 * If you add a new conglomerate to sectorOverrides.js, add a matching
 * entry here so its news routes meaningfully.
 */
const CONGLOMERATE_BODY_ROUTES = Object.freeze({
  RELIANCE: [
    { sector: "Telecom", re: /\b(?:jio|telecom|5g|broadband|wireless|reliance\s+communications|jio\s+platform)\b/i },
    { sector: "Oil & Gas", re: /\b(?:petrochemical|refining|refiner(?:y|ies)|oil\s+and\s+gas|crude|hydrocarbon|petroleum|green\s+ammonia|green\s+hydrogen|kg\s*[-]?d6)\b/i },
    { sector: "Retail", re: /\b(?:retail|jiomart|shopping|e[-\s]?commerce|ajio|reliance\s+retail|grocery)\b/i },
  ],
  ITC: [
    { sector: "FMCG", re: /\b(?:cigarette|tobacco|smokes|fmcg|aashirvaad|sunfeast|bingo|foods?|paperboard|noodles|biscuit)\b/i },
    { sector: "Pharma", re: /\b(?:pharma(?:ceutical)?|api|formulation|drug)\b/i },
    { sector: "Real Estate", re: /\b(?:hotel|hospitality|leisure|resort)\b/i },
  ],
  LT: [
    { sector: "Capital Goods", re: /\b(?:engineering|capital\s+goods|heavy\s+equipment|machinery)\b/i },
    { sector: "Infrastructure", re: /\b(?:construction|infrastructure|project|metro|highway|bridge|tunnel|port|airport|epc)\b/i },
    { sector: "IT Services", re: /\b(?:ltimindtree|lti|mindtree|technology\s+services|it\s+services|software\s+services|digital)\b/i },
  ],
  "M&M": [
    { sector: "Automobile", re: /\b(?:auto(?:mobile)?|suv|tractor|car|vehicle|electric\s+vehicle|ev|scorpio|thar|xuv|farm\s+equipment)\b/i },
    { sector: "Capital Goods", re: /\b(?:industrial|machinery|defence\s+systems|mahindra\s+heavy)\b/i },
  ],
  TATAMOTORS: [
    { sector: "Automobile", re: /\b(?:auto(?:mobile)?|car|truck|commercial\s+vehicle|cv|jaguar|land\s+rover|jlr|tata\s+nexon|harrier|safari|electric\s+vehicle|ev)\b/i },
    { sector: "IT Services", re: /\b(?:technology\s+services|it\s+services|software)\b/i },
  ],
  ADANIENT: [
    { sector: "Infrastructure", re: /\b(?:airport|port|logistics|sez|mining|coal\s+mine|infrastructure|construction)\b/i },
    { sector: "Power", re: /\b(?:adani\s+green|renewable|solar|wind|power\s+generation|transmission|electricity|hydro)\b/i },
    { sector: "Oil & Gas", re: /\b(?:gas|lng|crude|oil|petroleum|hydrocarbon|adani\s+total\s+gas)\b/i },
  ],
  GRASIM: [
    { sector: "Cement", re: /\b(?:cement|ultratech|clinker|grey\s+cement|white\s+cement)\b/i },
    { sector: "Chemicals", re: /\b(?:chemical|viscose|caustic\s+soda|epoxy|chlorine)\b/i },
    { sector: "FMCG", re: /\b(?:paint|fmcg|consumer)\b/i },
  ],
  KEC: [
    { sector: "Capital Goods", re: /\b(?:transmission|tower|cable|power\s+t\s*and\s*d|t\s*&\s*d|substation)\b/i },
    { sector: "Infrastructure", re: /\b(?:railway|civil|infrastructure|metro|telecom\s+tower)\b/i },
  ],
  KALPATPOWR: [
    { sector: "Capital Goods", re: /\b(?:transmission|tower|cable|power\s+t\s*and\s*d|t\s*&\s*d|substation)\b/i },
    { sector: "Infrastructure", re: /\b(?:civil|infrastructure|railway|oil\s+and\s+gas\s+pipeline)\b/i },
  ],
});

/* ──────────────────── sector resolution helpers ─────────────────── */

/**
 * For a single ticker, route a news item to exactly one canonical sector
 * (with a weight of 1) OR to multiple sectors with fractional weights
 * (when the conglomerate body-route doesn't match cleanly).
 *
 * @returns {Array<{sector: string, weight: number}>}
 *   weights sum to 1 across all returned entries
 *   empty array if the ticker's sector is unclassifiable
 */
export function routeNewsToSectors(ticker, sourceSector, newsItem, opts = {}) {
  if (opts.preserveSourceSector && typeof sourceSector === "string" && sourceSector.trim()) {
    const sector = sourceSector.trim();
    const universe = opts.sectorUniverse instanceof Set ? opts.sectorUniverse : null;
    if (!universe || universe.has(sector)) return [{ sector, weight: 1.0 }];
  }

  const sectorsRaw = resolveSectorsForTicker(ticker, sourceSector);
  // Resolve to canonical names
  let candidates = [];
  if (Array.isArray(sectorsRaw)) {
    for (const s of sectorsRaw) {
      candidates.push(s); // sectorOverrides.js already returns canonical names
    }
  } else if (typeof sectorsRaw === "string") {
    const canonical = normalizeSector(sectorsRaw);
    if (canonical) candidates.push(canonical);
  }
  if (candidates.length === 0) return []; // unclassifiable — drop

  // Single-sector ticker: full attribution
  if (candidates.length === 1) {
    return [{ sector: candidates[0], weight: 1.0 }];
  }

  // Multi-sector (conglomerate): check body-route rules
  const routes = CONGLOMERATE_BODY_ROUTES[String(ticker).toUpperCase()];
  if (routes && Array.isArray(routes)) {
    const haystack = [
      newsItem?.title || "",
      newsItem?.body || "",
      newsItem?.body_snippet || "",
      newsItem?.route_hint || "",
    ].join("\n");
    const matches = [];
    for (const r of routes) {
      if (r.re.test(haystack) && candidates.includes(r.sector)) {
        matches.push(r.sector);
      }
    }
    // Exactly one match: route 100% to that sector
    if (matches.length === 1) {
      return [{ sector: matches[0], weight: 1.0 }];
    }
    // Multiple matches: route equally among the matched sectors
    if (matches.length > 1) {
      const w = 1 / matches.length;
      return matches.map((s) => ({ sector: s, weight: w }));
    }
  }
  // Fallback: 1/N across all candidate sectors
  const w = 1 / candidates.length;
  return candidates.map((s) => ({ sector: s, weight: w }));
}

/* ──────────────────────── per-sector compute ───────────────────── */

function emptyWindowSummary() {
  return {
    theme_distribution: Object.fromEntries(THEME_LABELS.map((t) => [t, 0])),
    signed_index: 0,
    breadth_pct: 0,
    catalyst_proximity_count: 0,
    evidence_top5: [],
    avg_confidence: 0,
    n_tickers: 0,
    n_news: 0,
  };
}

/**
 * Given pre-grouped news entries for ONE sector and ONE window, compute
 * the summary stats. Each entry is shape:
 *   { ticker, mcap, date, theme, sign, intensity, confidence, time_hint,
 *     title, weight }
 * (weight from routeNewsToSectors)
 */
function computeWindowSummary(entries) {
  if (entries.length === 0) return emptyWindowSummary();

  const themeWeight = Object.fromEntries(THEME_LABELS.map((t) => [t, 0]));
  const tickerSignedSum = new Map();      // tickerSignedSum[ticker] = Σ(weighted signed signal)
  const tickerLogMcap = new Map();        // tickerLogMcap[ticker] = log10(mcap)
  const tickerLastDate = new Map();       // tickerLastDate[ticker] = ISO date
  const tickersWithSignal = new Set();
  const allEntriesScored = [];
  let confidenceNumer = 0;
  let confidenceDenom = 0;
  let totalWeightedSignal = 0;

  for (const e of entries) {
    const w = Number(e.weight) || 0;
    const sign = Number(e.sign) || 0;
    const intensity = Number(e.intensity) || 1;
    const signed = sign * intensity * w;
    const confidence = Number.isFinite(Number(e.confidence)) ? Number(e.confidence) : 0;
    themeWeight[e.theme] = (themeWeight[e.theme] || 0) + intensity * w;
    confidenceNumer += confidence * w;
    confidenceDenom += w;

    if (sign !== 0) {
      tickersWithSignal.add(e.ticker);
      tickerSignedSum.set(e.ticker, (tickerSignedSum.get(e.ticker) || 0) + signed);
    }
    const mcap = Number(e.mcap);
    if (Number.isFinite(mcap) && mcap > 0) {
      // Take MAX log-mcap per ticker (mcap is constant per ticker, but
      // entries may differ in stale data — be defensive)
      tickerLogMcap.set(e.ticker, Math.max(tickerLogMcap.get(e.ticker) || 0, Math.log10(mcap)));
    }
    tickerLastDate.set(e.ticker, e.date);
    allEntriesScored.push({ ...e, _signed: signed, _abs: Math.abs(signed) });
    totalWeightedSignal += Math.abs(signed);
  }

  // ── theme_distribution: normalize themeWeight to percentages ──
  const themeSum = Object.values(themeWeight).reduce((a, b) => a + b, 0);
  const theme_distribution = {};
  for (const t of THEME_LABELS) {
    theme_distribution[t] = themeSum > 0 ? themeWeight[t] / themeSum : 0;
  }

  // ── signed_index: mcap-weighted, capped per ticker ──
  // Σ(ticker_signed × log10(mcap)) / Σ(log10(mcap))
  let numer = 0;
  let denom = 0;
  for (const [ticker, signedSum] of tickerSignedSum.entries()) {
    const logMcap = tickerLogMcap.get(ticker) || 1;
    numer += signedSum * logMcap;
    denom += logMcap;
  }
  // Scale by max possible signed value (3 = max intensity) so result is
  // bounded in [-1, +1].
  let signed_index = denom > 0 ? numer / (denom * 3) : 0;
  // Bound — protect against weird mcap=0 / single-issuer skew
  signed_index = Math.max(-1, Math.min(1, signed_index));

  // ── breadth_pct with single-issuer cap ──
  // Each ticker contributes at most SINGLE_ISSUER_BREADTH_CAP to breadth.
  // breadth_pct itself is "unique signaled tickers / unique total tickers",
  // capped to enforce the rule that one ticker can't be >15% of breadth.
  const allTickers = new Set(entries.map((e) => e.ticker));
  const totalTickerCount = allTickers.size;
  let breadthContribution = 0;
  for (const t of tickersWithSignal) {
    // Each signaled ticker contributes min(1/totalTickerCount, 15% cap)
    const naturalShare = totalTickerCount > 0 ? 1 / totalTickerCount : 0;
    breadthContribution += Math.min(naturalShare, SINGLE_ISSUER_BREADTH_CAP);
  }
  // Re-normalize: if ALL tickers have signal, breadth would be 1.0 absent
  // the cap; with the cap it would be N × min(1/N, 0.15). We rescale so a
  // sector where every ticker has signal still hits breadth_pct = 1.0.
  const maxBreadthPossible = totalTickerCount * Math.min(
    1 / Math.max(1, totalTickerCount),
    SINGLE_ISSUER_BREADTH_CAP,
  );
  const breadth_pct = maxBreadthPossible > 0
    ? Math.min(1, breadthContribution / maxBreadthPossible)
    : 0;

  // ── catalyst_proximity_count: short-hint items in last 30d ──
  const cutoffMs = Date.now() - 30 * MS_PER_DAY;
  let catalyst_proximity_count = 0;
  for (const e of entries) {
    if (e.time_hint !== "short") continue;
    const ms = new Date(e.date).getTime();
    if (Number.isFinite(ms) && ms >= cutoffMs) catalyst_proximity_count += 1;
  }

  // ── evidence_top5: highest signed-magnitude entries ──
  const sortedEvidence = allEntriesScored
    .filter((e) => e._abs > 0)
    .sort((a, b) => b._abs - a._abs)
    .slice(0, EVIDENCE_TOP_N)
    .map((e) => ({
      ticker: e.ticker,
      date: e.date,
      title: e.title,
      body_snippet: e.body_snippet || "",
      route_hint: e.route_hint || "",
      theme: e.theme,
      sign: e.sign,
      intensity: e.intensity,
    }));

  return {
    theme_distribution,
    signed_index,
    breadth_pct,
    catalyst_proximity_count,
    evidence_top5: sortedEvidence,
    avg_confidence: confidenceDenom > 0 ? confidenceNumer / confidenceDenom : 0,
    n_tickers: allTickers.size,
    n_news: entries.length,
  };
}

/* ──────────────────────── public API ────────────────────────────── */

/**
 * Aggregate one ticker's classified news entries into the sector buckets
 * (a ticker can contribute to multiple sectors via fractional weighting).
 *
 * Each input `entry` is shape:
 *   { ticker, sourceSector, mcap, date, title, body, theme, sign,
 *     intensity, confidence, time_hint }
 */
function distributeEntryToSectors(entry, opts) {
  // Apply confidence floor — entries below threshold drop from aggregation
  const confidenceFloor = Number.isFinite(opts.confidenceFloor) ? opts.confidenceFloor : 0;
  if (Number(entry.confidence) < confidenceFloor) return [];

  const routes = routeNewsToSectors(entry.ticker, entry.sourceSector, entry, opts);
  if (routes.length === 0) return [];

  return routes.map((r) => ({
    sector: r.sector,
    entry: {
      ticker: entry.ticker,
      mcap: entry.mcap,
      date: entry.date,
      title: entry.title,
      body: entry.body || "",
      body_snippet: entry.body_snippet || "",
      route_hint: entry.route_hint || "",
      theme: entry.theme,
      sign: entry.sign,
      intensity: entry.intensity,
      confidence: Number(entry.confidence) || 0,
      time_hint: entry.time_hint,
      weight: r.weight,
    },
  }));
}

/**
 * Aggregate classified news across many tickers into per-sector × per-
 * window summaries.
 *
 * @param {Array<{ticker, sourceSector, mcap, date, title, body?, theme, sign, intensity, confidence, time_hint}>} entries
 * @param {object} [opts]
 * @param {number} [opts.nowMs]            override Date.now()
 * @param {number} [opts.confidenceFloor]  drop entries below this confidence (default 0)
 * @returns {{
 *   sectors: { [sector]: { sector, windows: {30d, 90d, 365d}, n_tickers_total } },
 *   orphaned_tickers: number,
 *   total_entries: number,
 * }}
 */
export function aggregateAllSectors(entries, opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { sectors: {}, orphaned_tickers: 0, total_entries: 0 };
  }
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const sectorUniverse = Array.isArray(opts.sectorUniverse)
    ? new Set(opts.sectorUniverse.map((s) => String(s).trim()).filter(Boolean))
    : null;
  const routingOpts = { ...opts, sectorUniverse };
  const orphanedTickers = new Set();
  // Per-sector buckets keyed by window
  const buckets = new Map();
  // Track unique tickers per sector (regardless of signal)
  const sectorTickers = new Map();

  for (const e of entries) {
    const distributed = distributeEntryToSectors(e, routingOpts);
    if (distributed.length === 0) {
      orphanedTickers.add(e.ticker);
      continue;
    }
    for (const { sector, entry } of distributed) {
      if (!sectorTickers.has(sector)) sectorTickers.set(sector, new Set());
      sectorTickers.get(sector).add(entry.ticker);

      if (!buckets.has(sector)) {
        buckets.set(sector, { "30d": [], "90d": [], "365d": [] });
      }
      const ms = new Date(entry.date).getTime();
      if (!Number.isFinite(ms)) continue;
      const ageDays = (nowMs - ms) / MS_PER_DAY;
      if (ageDays < 0) continue; // future dated
      for (const [windowKey, days] of Object.entries(WINDOW_DAYS)) {
        if (ageDays <= days) buckets.get(sector)[windowKey].push(entry);
      }
    }
  }

  const sectors = {};
  for (const [sector, windowEntries] of buckets.entries()) {
    sectors[sector] = {
      sector,
      n_tickers_total: sectorTickers.get(sector).size,
      windows: {
        "30d": computeWindowSummary(windowEntries["30d"]),
        "90d": computeWindowSummary(windowEntries["90d"]),
        "365d": computeWindowSummary(windowEntries["365d"]),
      },
    };
  }

  return {
    sectors,
    orphaned_tickers: orphanedTickers.size,
    total_entries: entries.length,
  };
}

export const TESTING_CONSTANTS = Object.freeze({
  SINGLE_ISSUER_BREADTH_CAP,
  WINDOW_DAYS,
  EVIDENCE_TOP_N,
  CONGLOMERATE_BODY_ROUTES,
});

export default {
  aggregateAllSectors,
  routeNewsToSectors,
  TESTING_CONSTANTS,
};
