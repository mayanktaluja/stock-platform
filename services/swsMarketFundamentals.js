// Offline Yahoo/SWS market-fundamentals enrichment helpers.
//
// This module is safe for the server runtime: it contains only normalization,
// snapshot lookup, and cached file-reader helpers. The yahoo-finance2 dependency
// is intentionally imported only by scripts/refresh-sws-market-fundamentals.mjs.

import fs from "node:fs";
import { mtimeCached } from "./swsDal/cache.js";

export const MARKET_FUNDAMENTALS_SCHEMA_VERSION = "sws-market-fundamentals-v1";
export const MARKET_FUNDAMENTALS_FILE = "fundamentals-latest.json";
export const DEFAULT_FUNDAMENTALS_TTL_DAYS = 30;

const METADATA_KEYS = new Set([
  "ticker",
  "yahoo_symbol",
  "source",
  "fetched_at",
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function normaliseTickerKey(ticker) {
  const key = String(ticker || "").trim().toUpperCase();
  return key || null;
}

export function yahooSymbolCandidates(ticker, regionCode = "us") {
  const key = normaliseTickerKey(ticker);
  if (!key) return [];
  const code = String(regionCode || "").toLowerCase();
  if (code !== "us") return [key];
  const out = [key];
  if (key.includes(".")) out.push(key.replace(/\./g, "-"));
  return [...new Set(out)];
}

function finiteNumber(v) {
  if (v && typeof v === "object" && "raw" in v) return finiteNumber(v.raw);
  if (v && typeof v === "object" && "value" in v) return finiteNumber(v.value);
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function percentFromRatio(v) {
  const n = finiteNumber(v);
  return n == null ? null : n * 100;
}

function pickNumber(...values) {
  for (const value of values) {
    const n = finiteNumber(value);
    if (n != null) return n;
  }
  return null;
}

function latestSeriesValue(timeSeriesRows, aliases) {
  const wanted = new Set(aliases);
  const hits = [];

  const visit = (node, contextDate = null) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, contextDate);
      return;
    }
    if (typeof node !== "object") return;

    const nextDate =
      node.asOfDate ||
      node.reportedDate ||
      node.periodEndDate ||
      node.endDate ||
      node.date ||
      contextDate;

    for (const [key, value] of Object.entries(node)) {
      if (wanted.has(key)) {
        const n = finiteNumber(value);
        if (n != null) hits.push({ value: n, date: nextDate || "" });
      }
      if (value && typeof value === "object") visit(value, nextDate);
    }
  };

  visit(timeSeriesRows);
  if (!hits.length) return null;
  hits.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return hits[0].value;
}

export function normalizeYahooFundamentals({
  ticker,
  yahooSymbol,
  summary = {},
  timeSeriesRows = null,
  fetchedAt = new Date().toISOString(),
} = {}) {
  const financialData = summary.financialData || {};
  const defaultKeyStatistics = summary.defaultKeyStatistics || {};
  const summaryDetail = summary.summaryDetail || {};
  const price = summary.price || {};

  const latestRevenue = pickNumber(
    financialData.totalRevenue,
    latestSeriesValue(timeSeriesRows, ["annualTotalRevenue", "totalRevenue", "TotalRevenue"]),
  );
  const latestNetIncome = pickNumber(
    latestSeriesValue(timeSeriesRows, ["annualNetIncome", "netIncome", "NetIncome"]),
  );
  const totalDebt = pickNumber(
    financialData.totalDebt,
    latestSeriesValue(timeSeriesRows, ["annualTotalDebt", "totalDebt", "TotalDebt"]),
  );
  const totalCash = pickNumber(
    financialData.totalCash,
    latestSeriesValue(timeSeriesRows, [
      "annualCashCashEquivalentsAndShortTermInvestments",
      "cashCashEquivalentsAndShortTermInvestments",
      "cashAndCashEquivalents",
      "cash",
    ]),
  );
  const currentAssets = latestSeriesValue(timeSeriesRows, [
    "annualCurrentAssets",
    "currentAssets",
    "totalCurrentAssets",
  ]);
  const currentLiabilities = latestSeriesValue(timeSeriesRows, [
    "annualCurrentLiabilities",
    "currentLiabilities",
    "totalCurrentLiabilities",
  ]);
  const ebit = latestSeriesValue(timeSeriesRows, ["annualEBIT", "ebit", "EBIT"]);
  const interestExpense = latestSeriesValue(timeSeriesRows, [
    "annualInterestExpense",
    "interestExpense",
    "InterestExpense",
  ]);
  const interestCover = ebit != null && interestExpense ? Math.abs(ebit / interestExpense) : null;
  const currentRatio = currentAssets != null && currentLiabilities ? currentAssets / currentLiabilities : null;
  const operatingCashFlow = latestSeriesValue(timeSeriesRows, [
    "annualOperatingCashFlow",
    "operatingCashFlow",
    "OperatingCashFlow",
  ]);
  const freeCashFlow = pickNumber(
    financialData.freeCashflow,
    financialData.freeCashFlow,
    latestSeriesValue(timeSeriesRows, ["annualFreeCashFlow", "freeCashFlow", "FreeCashFlow"]),
  );
  const reportingPeriodEnd = (() => {
    let latest = null;
    const visit = (node) => {
      if (node == null) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (typeof node !== "object") return;
      for (const key of ["asOfDate", "reportedDate", "periodEndDate", "endDate", "date"]) {
        if (node[key] && (!latest || String(node[key]) > latest)) latest = String(node[key]);
      }
      for (const value of Object.values(node)) if (value && typeof value === "object") visit(value);
    };
    visit(timeSeriesRows);
    return latest;
  })();

  return {
    source: "yahoo-finance2",
    ticker: normaliseTickerKey(ticker),
    yahoo_symbol: yahooSymbol || normaliseTickerKey(ticker),
    fetched_at: fetchedAt,
    pe: pickNumber(defaultKeyStatistics.trailingPE, summaryDetail.trailingPE, financialData.trailingPE),
    forward_pe: pickNumber(defaultKeyStatistics.forwardPE, summaryDetail.forwardPE, financialData.forwardPE),
    pb: pickNumber(defaultKeyStatistics.priceToBook, summaryDetail.priceToBook),
    ps: pickNumber(defaultKeyStatistics.priceToSalesTrailing12Months, summaryDetail.priceToSalesTrailing12Months),
    ev_ebitda: pickNumber(defaultKeyStatistics.enterpriseToEbitda, financialData.enterpriseToEbitda),
    peg_ratio: pickNumber(defaultKeyStatistics.pegRatio),
    eps: pickNumber(defaultKeyStatistics.trailingEps, financialData.trailingEps),
    forward_eps: pickNumber(defaultKeyStatistics.forwardEps, financialData.forwardEps),
    roe_pct: percentFromRatio(financialData.returnOnEquity),
    roa_pct: percentFromRatio(financialData.returnOnAssets),
    gross_margin_pct: percentFromRatio(financialData.grossMargins),
    operating_margin_pct: percentFromRatio(financialData.operatingMargins),
    net_margin_pct: percentFromRatio(financialData.profitMargins),
    revenue_growth_pct: percentFromRatio(financialData.revenueGrowth),
    earnings_growth_yoy_pct: percentFromRatio(financialData.earningsGrowth),
    debt_to_equity_pct: pickNumber(financialData.debtToEquity),
    current_ratio: pickNumber(financialData.currentRatio, currentRatio),
    interest_cover_x: interestCover,
    ocf_to_net_income: pickNumber(
      financialData.ocfToNetIncome,
      latestNetIncome && operatingCashFlow != null ? operatingCashFlow / latestNetIncome : null,
    ),
    free_cash_flow: freeCashFlow,
    total_debt: totalDebt,
    total_cash: totalCash,
    net_cash: totalCash != null && totalDebt != null ? totalCash - totalDebt : null,
    beta: pickNumber(summaryDetail.beta, defaultKeyStatistics.beta),
    dividend_yield_pct: percentFromRatio(summaryDetail.dividendYield),
    payout_pct: percentFromRatio(summaryDetail.payoutRatio),
    annual_dividend: pickNumber(summaryDetail.dividendRate, summaryDetail.trailingAnnualDividendRate),
    latest_revenue: latestRevenue,
    latest_net_income: latestNetIncome,
    reporting_period_end: reportingPeriodEnd,
    market_cap: pickNumber(price.marketCap, summaryDetail.marketCap),
    week52_high_inr: pickNumber(summaryDetail.fiftyTwoWeekHigh),
    week52_low_inr: pickNumber(summaryDetail.fiftyTwoWeekLow),
    shares_outstanding: pickNumber(defaultKeyStatistics.sharesOutstanding, price.sharesOutstanding),
  };
}

export function compactFundamentalsRecord(record) {
  if (!record || typeof record !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value == null || value === "") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out;
}

export function hasAnyFundamentalMetric(record) {
  if (!record || typeof record !== "object") return false;
  for (const [key, value] of Object.entries(record)) {
    if (METADATA_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) return true;
    if (value != null && typeof value !== "number" && value !== "") return true;
  }
  return false;
}

export function isMarketFundamentalsSnapshotFresh(snapshot, { nowMs = Date.now(), maxAgeDays = null } = {}) {
  if (!snapshot || typeof snapshot !== "object") return false;
  const generatedAt = snapshot.generatedAt || snapshot.generated_at;
  const generatedMs = Date.parse(generatedAt || "");
  if (!Number.isFinite(generatedMs)) return false;
  const ttlDays = Number.isFinite(Number(snapshot.ttl_days))
    ? Number(snapshot.ttl_days)
    : Number.isFinite(Number(snapshot.ttlDays))
      ? Number(snapshot.ttlDays)
      : (maxAgeDays ?? DEFAULT_FUNDAMENTALS_TTL_DAYS);
  return nowMs - generatedMs <= ttlDays * 24 * 60 * 60 * 1000;
}

export function lookupMarketFundamentals(snapshot, ticker, opts = {}) {
  const key = normaliseTickerKey(ticker);
  if (!key || !isMarketFundamentalsSnapshotFresh(snapshot, opts)) return null;
  const stocks = snapshot.stocks;
  if (!stocks) return null;
  if (Array.isArray(stocks)) {
    return stocks.find((s) => normaliseTickerKey(s && s.ticker) === key) || null;
  }
  if (typeof stocks !== "object") return null;
  return stocks[key] || stocks[normaliseTickerKey(key)] || null;
}

export function createMarketFundamentalsFallbackReader(
  filePath,
  { nowMsProvider = () => Date.now(), maxAgeDays = DEFAULT_FUNDAMENTALS_TTL_DAYS } = {},
) {
  const readSnapshot = mtimeCached(filePath, readJson);
  return function getFundamentalsFallback(ticker) {
    return lookupMarketFundamentals(readSnapshot(), ticker, {
      nowMs: nowMsProvider(),
      maxAgeDays,
    });
  };
}
