/**
 * Point-in-Time Fundamentals Resolver
 *
 * For a given (symbol, asOfDate), returns the fundamentals that would
 * have been PUBLICLY KNOWN on asOfDate — eliminating the look-ahead
 * bias from using the Apr 2026 fundamentals snapshot for 2023-2024
 * backtest trades.
 *
 * Data source: fundamentalsHistory.json (already collected in the
 * project) — contains annual and quarterly financial data per symbol
 * with endDates spanning 2022-03-31 → 2025-03-31.
 *
 * Reporting lag: Indian listed companies have 60 days from fiscal year
 * end to file audited annual results (SEBI LODR Regulation 33). We use
 * a conservative 90-day lag so announcements on the back-edge are
 * captured correctly. Q4 results (for FY ending Mar 31) are typically
 * out by end of May; we treat them as public from Jul 1 of that year.
 *
 * For quarterly results (45-day lag per SEBI), we use 75 days.
 *
 * Derived fields (match the shape scoreFundamentals expects):
 *   - pe              (current price / EPS-TTM from historical quarters)
 *   - roe             (net income / equity, from last available annual)
 *   - profitMargin    (net income / revenue, from last available annual)
 *   - debtToEquity    (total debt / equity, from last available annual)
 *   - revenueGrowthYoY (revenue vs prior year's annual, if both available)
 *
 * Not derivable from the historical dataset (use current snapshot fallback):
 *   - week52High / week52Low  (caller computes from price history)
 *   - marketCap              (can derive from price × sharesOutstanding)
 *   - sector                 (static)
 *   - sectorPe               (computed at scan time from the PIT cohort)
 */

import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HISTORY_PATH = path.join(__dirname, "fundamentalsHistory.json");

// SEBI-aligned reporting lags
const ANNUAL_LAG_DAYS = 90;   // Q4/annual: conservative 90-day
const QUARTERLY_LAG_DAYS = 75; // quarterly: conservative 75-day

let _historyCache = null;
function loadHistory() {
  if (_historyCache) return _historyCache;
  if (!existsSync(HISTORY_PATH)) {
    console.warn("[PIT] fundamentalsHistory.json not found — point-in-time analysis disabled");
    _historyCache = { stocks: {} };
    return _historyCache;
  }
  try {
    const raw = readFileSync(HISTORY_PATH, "utf-8");
    _historyCache = JSON.parse(raw);
    const count = Object.keys(_historyCache.stocks || {}).length;
    console.log(`[PIT] Loaded historical fundamentals for ${count} symbols`);
    return _historyCache;
  } catch (err) {
    console.warn("[PIT] Failed to load history:", err.message);
    _historyCache = { stocks: {} };
    return _historyCache;
  }
}

function addDays(dateLike, days) {
  const d = new Date(dateLike);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Returns the most recent annual record (sorted ascending by endDate) that
 * would have been publicly known by asOfDate. Null if nothing qualifies.
 */
function mostRecentPublicAnnual(annuals, asOfDate) {
  if (!annuals || annuals.length === 0) return null;
  const sorted = [...annuals].sort((a, b) => a.endDate.localeCompare(b.endDate));
  for (let i = sorted.length - 1; i >= 0; i--) {
    const a = sorted[i];
    if (addDays(a.endDate, ANNUAL_LAG_DAYS) <= asOfDate) return a;
  }
  return null;
}

/**
 * Same but for quarterly series. Uses a 75-day lag.
 */
function mostRecentPublicQuarters(quarters, asOfDate, count = 4) {
  if (!quarters || quarters.length === 0) return [];
  const sorted = [...quarters].sort((a, b) => a.endDate.localeCompare(b.endDate));
  const eligible = sorted.filter((q) => addDays(q.endDate, QUARTERLY_LAG_DAYS) <= asOfDate);
  return eligible.slice(-count);
}

/**
 * Derive TTM (trailing 12-month) EPS from the most recent 4 public
 * quarters. Falls back to last annual's dilutedEPS if quarters are
 * incomplete or missing.
 */
function computeTtmEps(quarters, fallbackAnnual) {
  if (quarters && quarters.length >= 4) {
    const sum = quarters.slice(-4).reduce((s, q) => s + (q.dilutedEPS || 0), 0);
    const nullCount = quarters.slice(-4).filter((q) => q.dilutedEPS == null).length;
    if (nullCount === 0 && isFinite(sum) && sum !== 0) return sum;
  }
  return fallbackAnnual?.dilutedEPS ?? null;
}

/**
 * Main entry: get the point-in-time fundamentals snapshot for a stock
 * as-of a given date.
 *
 * @param {string} symbol
 * @param {Date|string} asOfDate
 * @param {object} [priceContext] - optional live-context hints from caller
 *   { price, week52High, week52Low } — if provided, used to derive P/E
 *   and market-cap-related fields alongside the historical financials.
 * @returns {object|null} a snap compatible with scoreFundamentals, or
 *   null if no public data exists on that date (stock should be
 *   treated as UNRATED at that time).
 */
export function getPointInTimeFundamentals(symbol, asOfDate, priceContext = {}) {
  const history = loadHistory();
  const stock = history.stocks?.[symbol];
  if (!stock) return null;

  const asOf = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);

  const lastAnnual = mostRecentPublicAnnual(stock.annual, asOf);
  if (!lastAnnual) return null;

  // Find the prior-year annual for revenue-growth YoY calculation
  const allPublic = (stock.annual || [])
    .filter((a) => addDays(a.endDate, ANNUAL_LAG_DAYS) <= asOf)
    .sort((a, b) => a.endDate.localeCompare(b.endDate));
  const priorAnnual = allPublic.length >= 2 ? allPublic[allPublic.length - 2] : null;

  const recentQuarters = mostRecentPublicQuarters(stock.quarterly, asOf, 4);
  const ttmEps = computeTtmEps(recentQuarters, lastAnnual);

  // Derive fields
  const roe = (lastAnnual.equity && lastAnnual.equity > 0)
    ? lastAnnual.netIncome / lastAnnual.equity
    : null;
  const profitMargin = (lastAnnual.totalRevenue && lastAnnual.totalRevenue > 0)
    ? lastAnnual.netIncome / lastAnnual.totalRevenue
    : null;
  const debtToEquity = (lastAnnual.equity && lastAnnual.equity > 0)
    ? lastAnnual.totalDebt / lastAnnual.equity
    : null;
  const revenueGrowthYoY = (priorAnnual && priorAnnual.totalRevenue && priorAnnual.totalRevenue > 0)
    ? (lastAnnual.totalRevenue - priorAnnual.totalRevenue) / priorAnnual.totalRevenue
    : null;

  // Price-dependent fields — require caller to provide current price
  const price = priceContext.price ?? null;
  const pe = (price && ttmEps && ttmEps > 0) ? price / ttmEps : null;
  const marketCap = (price && lastAnnual.dilutedAverageShares)
    ? price * lastAnnual.dilutedAverageShares
    : null;

  return {
    symbol,
    name: null, // caller fills in from stockList
    sector: stock.sector,
    // numeric ratios / metrics
    pe,
    sectorPe: null, // caller MUST compute from PIT cohort at scan time
    price,
    week52High: priceContext.week52High ?? null,
    week52Low: priceContext.week52Low ?? null,
    marketCap,
    roe,
    profitMargin,
    debtToEquity,
    revenueGrowthYoY,
    // meta
    _pit: {
      asOf: asOf.toISOString().slice(0, 10),
      lastAnnualEndDate: lastAnnual.endDate,
      priorAnnualEndDate: priorAnnual?.endDate ?? null,
      quartersUsed: recentQuarters.length,
      ttmEps,
    },
  };
}

/**
 * Compute point-in-time sector P/E from the cohort of stocks that have
 * public fundamentals at asOfDate. Returns a Map of sector → median P/E.
 *
 * Matches how fundamentals.js computes "true" sector P/E from the
 * platform's own snapshot to defeat NSE's circular sector-P/E issue
 * for heavyweights.
 */
export function computePitSectorPeMedians(universe, asOfDate, priceBySymbol) {
  const peBySector = new Map();
  for (const stock of universe) {
    const snap = getPointInTimeFundamentals(stock.symbol, asOfDate, {
      price: priceBySymbol.get(stock.symbol),
    });
    if (!snap || !snap.pe || snap.pe <= 0 || snap.pe > 200) continue;
    if (!peBySector.has(stock.sector)) peBySector.set(stock.sector, []);
    peBySector.get(stock.sector).push(snap.pe);
  }
  const medians = new Map();
  for (const [sec, pes] of peBySector) {
    if (pes.length < 4) continue; // need statistical reliability
    const sorted = [...pes].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medians.set(sec, sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid]);
  }
  return medians;
}
