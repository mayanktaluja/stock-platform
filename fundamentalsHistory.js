/**
 * Point-in-time Fundamentals Lookup
 *
 * The missing half of the backtest: answers "what were stock X's fundamentals
 * as-of date Y?" using the quarterly/annual history produced by
 * scripts/fetch-fundamentals-history.mjs (saved to fundamentalsHistory.json).
 *
 * Replaces direct getFundamentals(symbol) calls in the backtest, which
 * previously returned the latest April-2026 snapshot for every historical
 * scan date — severe look-ahead bias.
 *
 * Usage pattern for a backtest:
 *
 *     import { loadFundamentalsHistory, buildSnapshotAsOf, computeSectorMediansAsOf }
 *       from "./fundamentalsHistory.js";
 *     loadFundamentalsHistory();
 *     const sectorMedians = computeSectorMediansAsOf(scanDateStr, priceMap);
 *     const snap = buildSnapshotAsOf(symbol, scanDateStr, quote, sectorMedians);
 *     const result = scoreFundamentals(snap, dma200);
 *
 * Returns `null` from buildSnapshotAsOf when no historical fundamentals are
 * available as-of the scan date — caller MUST treat this as "skip the
 * fundamental-scored trade for this date" rather than falling back to the
 * current snapshot (that's the bug we're fixing).
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.join(__dirname, "fundamentalsHistory.json");

// Filing lag in days. Indian SEBI listing regs require:
//   • Quarterly results (unaudited) within 45 days of quarter-end
//   • Annual results (audited)      within 60 days of fiscal year-end
// We use 90 days for annuals to be safe — some companies file at the deadline,
// and we want a report to be genuinely "public and digestible" before the
// backtest uses it. Using 45 for quarterlies is the SEBI deadline itself.
const ANNUAL_LAG_DAYS = 90;
const QUARTERLY_LAG_DAYS = 45;

let _history = null;

export function loadFundamentalsHistory() {
  if (_history) return _history;
  try {
    const raw = readFileSync(HISTORY_PATH, "utf-8");
    _history = JSON.parse(raw);
    return _history;
  } catch (err) {
    console.error("[FUNDAMENTALS_HISTORY] load failed:", err.message);
    return null;
  }
}

/** YYYY-MM-DD string math. */
function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toISODate(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Most recent report whose availability date (endDate + lag) is <= scanDate.
 * Returns { row, prior } — prior is the report immediately before `row`, used
 * for YoY growth. Either can be null.
 */
function pickAsOf(rows, scanDateStr, lagDays) {
  if (!rows || rows.length === 0) return { row: null, prior: null };
  // Rows are already sorted ascending by endDate.
  let chosenIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const availOn = addDays(rows[i].endDate, lagDays);
    if (availOn <= scanDateStr) chosenIdx = i;
    else break;
  }
  if (chosenIdx < 0) return { row: null, prior: null };
  return {
    row: rows[chosenIdx],
    prior: chosenIdx > 0 ? rows[chosenIdx - 1] : null,
  };
}

/**
 * Find the 4 most recent consecutive quarters whose availability date is
 * <= scanDate. Returns null if we can't assemble 4 quarters.
 */
function pickLastFourQuarters(quarterly, scanDateStr) {
  if (!quarterly || quarterly.length < 4) return null;
  // Walk backwards from the latest available quarter.
  let endIdx = -1;
  for (let i = 0; i < quarterly.length; i++) {
    const availOn = addDays(quarterly[i].endDate, QUARTERLY_LAG_DAYS);
    if (availOn <= scanDateStr) endIdx = i;
    else break;
  }
  if (endIdx < 3) return null;
  return quarterly.slice(endIdx - 3, endIdx + 1); // 4 rows, oldest → newest
}

/**
 * Compute a derived metrics block for one symbol as-of scanDateStr.
 *
 * Strategy:
 *   1. If 4 consecutive quarterly reports are available, compute TTM from them.
 *   2. Otherwise fall back to the most recent annual report (TTM proxy).
 *   3. If neither is available, return null.
 *
 * Returns {
 *   source: "quarterly_ttm" | "annual",
 *   asOfReportEnd: "YYYY-MM-DD",
 *   epsTTM: number | null,
 *   sharesOutstanding: number | null,
 *   netIncomeTTM: number | null,
 *   revenueTTM: number | null,
 *   equity: number | null,        // point-in-time balance sheet
 *   totalDebt: number | null,     // point-in-time balance sheet
 *   revenueGrowthYoY: number | null,
 * }
 */
function computeMetrics(stockHist, scanDateStr) {
  if (!stockHist) return null;

  // Try quarterly TTM first
  const q4 = pickLastFourQuarters(stockHist.quarterly, scanDateStr);
  if (q4) {
    const sum = (key) =>
      q4.every((r) => r[key] != null)
        ? q4.reduce((s, r) => s + r[key], 0)
        : null;
    const revenueTTM = sum("totalRevenue");
    const netIncomeTTM = sum("netIncome");
    const epsTTM = sum("dilutedEPS");
    const latest = q4[q4.length - 1];

    // Prior 4 quarters for YoY growth (we need 8 total)
    let revenuePriorTTM = null;
    if (stockHist.quarterly.length >= 8) {
      const latestIdx = stockHist.quarterly.indexOf(latest);
      if (latestIdx >= 7) {
        const prior4 = stockHist.quarterly.slice(latestIdx - 7, latestIdx - 3);
        if (prior4.every((r) => r.totalRevenue != null)) {
          revenuePriorTTM = prior4.reduce((s, r) => s + r.totalRevenue, 0);
        }
      }
    }

    return {
      source: "quarterly_ttm",
      asOfReportEnd: latest.endDate,
      epsTTM,
      sharesOutstanding: latest.dilutedAverageShares,
      netIncomeTTM,
      revenueTTM,
      equity: latest.equity,
      totalDebt: latest.totalDebt,
      revenueGrowthYoY:
        revenuePriorTTM && revenueTTM && revenuePriorTTM > 0
          ? revenueTTM / revenuePriorTTM - 1
          : null,
    };
  }

  // Fall back to annual
  const { row: annual, prior: priorAnnual } = pickAsOf(
    stockHist.annual,
    scanDateStr,
    ANNUAL_LAG_DAYS
  );
  if (!annual) return null;

  return {
    source: "annual",
    asOfReportEnd: annual.endDate,
    epsTTM: annual.dilutedEPS,
    sharesOutstanding: annual.dilutedAverageShares,
    netIncomeTTM: annual.netIncome,
    revenueTTM: annual.totalRevenue,
    equity: annual.equity,
    totalDebt: annual.totalDebt,
    revenueGrowthYoY:
      priorAnnual && priorAnnual.totalRevenue && annual.totalRevenue && priorAnnual.totalRevenue > 0
        ? annual.totalRevenue / priorAnnual.totalRevenue - 1
        : null,
  };
}

/**
 * Compute point-in-time P/E for all stocks using each stock's historical
 * TTM EPS and a price-at-scan-date map, then return sector medians (min 4
 * stocks per sector, matching the current logic in fundamentals.js).
 *
 * priceMap: Map<symbol, { price: number, sector: string }>
 *           — the caller already has this from buildMockQuote per stock.
 */
export function computeSectorMediansAsOf(scanDateStr, priceMap) {
  const history = loadFundamentalsHistory();
  if (!history) return {};

  const bySector = new Map();
  for (const [symbol, { price, sector }] of priceMap.entries()) {
    if (!sector || !Number.isFinite(price) || price <= 0) continue;
    const stockHist = history.stocks[symbol];
    if (!stockHist) continue;
    const m = computeMetrics(stockHist, scanDateStr);
    if (!m || !m.epsTTM || m.epsTTM <= 0) continue;
    const pe = price / m.epsTTM;
    if (!Number.isFinite(pe) || pe <= 0 || pe > 500) continue; // sanity cap
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector).push(pe);
  }

  const MIN_SECTOR_SIZE = 4;
  const medians = {};
  for (const [sector, pes] of bySector) {
    if (pes.length < MIN_SECTOR_SIZE) continue;
    const sorted = [...pes].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medians[sector] =
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
  }
  return medians;
}

/**
 * Build a snapshot object in the shape scoreFundamentals() expects, using
 * point-in-time data. Returns null when historical fundamentals aren't
 * available for this date — caller MUST skip the fundamental-scored trade.
 *
 * @param {string} symbol
 * @param {string} scanDateStr       YYYY-MM-DD
 * @param {object} quote             from buildMockQuote — has regularMarketPrice,
 *                                    fiftyTwoWeekHigh/Low
 * @param {Object<string, number>} sectorMedians  from computeSectorMediansAsOf
 * @param {object} [stockMeta]       { name, sector } from stockList — optional
 */
export function buildSnapshotAsOf(symbol, scanDateStr, quote, sectorMedians = {}, stockMeta = {}) {
  const history = loadFundamentalsHistory();
  if (!history) return null;

  const stockHist = history.stocks[symbol];
  if (!stockHist) return null;

  const m = computeMetrics(stockHist, scanDateStr);
  if (!m) return null;

  const price = quote?.regularMarketPrice;
  if (!Number.isFinite(price) || price <= 0) return null;

  const sector = stockMeta.sector || stockHist.sector || null;

  // Derived financial ratios.
  const pe = m.epsTTM && m.epsTTM > 0 ? price / m.epsTTM : null;
  const roe =
    m.netIncomeTTM != null && m.equity != null && m.equity > 0
      ? m.netIncomeTTM / m.equity
      : null;
  const debtToEquity =
    m.totalDebt != null && m.equity != null && m.equity > 0
      ? m.totalDebt / m.equity
      : null;
  const profitMargin =
    m.netIncomeTTM != null && m.revenueTTM != null && m.revenueTTM > 0
      ? m.netIncomeTTM / m.revenueTTM
      : null;
  const marketCap =
    m.sharesOutstanding != null && price > 0 ? m.sharesOutstanding * price : null;

  // Sector P/E — prefer computed-at-date median; if not enough peers in sector
  // at this date, the scorer's sectorPe falls back inside scoreFundamentals
  // via getSectorMedianPe. We pass null here to let its null-handling kick in.
  const sectorPe = sector && sectorMedians[sector] ? sectorMedians[sector] : null;

  return {
    symbol,
    name: stockMeta.name || symbol,
    sector,
    industry: stockMeta.industry || null,
    pe,
    sectorPe,
    price,
    week52High: quote?.fiftyTwoWeekHigh ?? null,
    week52Low: quote?.fiftyTwoWeekLow ?? null,
    marketCap,
    roe,
    debtToEquity,
    profitMargin,
    revenueGrowthYoY: m.revenueGrowthYoY,
    // Diagnostic fields — not consumed by scoring, useful for reports.
    _source: m.source,
    _asOfReportEnd: m.asOfReportEnd,
  };
}

/**
 * Earliest scan date for which at least `minCoverage` fraction of stocks have
 * usable historical fundamentals. Used by backtest runners to decide the
 * honest start date.
 */
export function getUsableStartDate(minCoveragePct = 0.7) {
  const history = loadFundamentalsHistory();
  if (!history) return null;

  const stockSymbols = Object.keys(history.stocks);
  if (stockSymbols.length === 0) return null;

  // For each year in coverage window, count how many stocks have data
  // available by Jun 30 of that year.
  const earliestYear = new Date(history.coverage.earliest).getUTCFullYear();
  const latestYear = new Date(history.coverage.latest).getUTCFullYear();

  for (let year = earliestYear; year <= latestYear; year++) {
    const testDate = `${year}-06-30`;
    let withData = 0;
    for (const sym of stockSymbols) {
      const h = history.stocks[sym];
      const m = computeMetrics(h, testDate);
      if (m) withData++;
    }
    const coverage = withData / stockSymbols.length;
    if (coverage >= minCoveragePct) {
      return { scanDate: testDate, coverage, stockCount: withData, total: stockSymbols.length };
    }
  }
  return null;
}
