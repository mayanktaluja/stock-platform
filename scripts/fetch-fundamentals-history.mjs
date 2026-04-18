#!/usr/bin/env node
/**
 * Historical Fundamentals Fetcher (point-in-time)
 *
 * Fixes the look-ahead-bias problem in backtests by pulling each stock's
 * historical annual + quarterly financial statements from Yahoo Finance and
 * storing them keyed by statement end-date. The backtest can then ask
 * "what were the fundamentals as-of 2023-06-15?" and get the most recent
 * report whose endDate <= 2023-06-15.
 *
 * Output: fundamentalsHistory.json
 *
 * Shape:
 *   {
 *     "generatedAt": "...",
 *     "source": "yahoo-finance2",
 *     "coverage": { "earliest": "2022-03-31", "latest": "2025-12-31" },
 *     "stocks": {
 *       "RELIANCE.NS": {
 *         "sector": "Energy",
 *         "annual":    [{ endDate, totalRevenue, netIncome, equity, totalDebt,
 *                         dilutedEPS, dilutedAverageShares }, ...],
 *         "quarterly": [{ endDate, totalRevenue, netIncome, equity, totalDebt,
 *                         dilutedEPS, dilutedAverageShares }, ...]
 *       }, ...
 *     }
 *   }
 *
 * Run: node scripts/fetch-fundamentals-history.mjs
 *
 * Yahoo coverage for Indian equities (empirically observed Apr 2026):
 *   • Annual:    4 fiscal years (2022-03 → 2025-03)  — reliable
 *   • Quarterly: ~5-6 irregular quarters (2024-Q3 → 2025-Q4)  — patchy
 *
 * The consumer (getFundamentalsAsOf) prefers quarterly when available
 * and falls back to annual for older scan dates. For scan dates before
 * 2022-03 we return null — the backtest must skip fundamental scoring
 * rather than peek at future data.
 */

import YahooFinance from "yahoo-finance2";
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAllStocks } from "../stockList.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "fundamentalsHistory.json");

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

// Period window: 10 years back is generous — Yahoo will cap to what it has.
const PERIOD1 = "2016-01-01";
const PERIOD2 = new Date().toISOString().slice(0, 10);

const CONCURRENCY = 4;
const DELAY_MS = 250; // polite pacing between batches

/**
 * Normalize Yahoo's date (sometimes number seconds, sometimes Date) into
 * an ISO YYYY-MM-DD string.
 */
function normalizeDate(d) {
  if (d == null) return null;
  if (typeof d === "number") return new Date(d * 1000).toISOString().slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === "string") {
    const dt = new Date(d);
    return Number.isFinite(dt.getTime()) ? dt.toISOString().slice(0, 10) : null;
  }
  return null;
}

/**
 * Merge a timeseries of financials + balance-sheet rows (both keyed by endDate)
 * into a single row per endDate containing everything the scorer needs.
 */
function mergeByDate(rows) {
  const byDate = new Map();
  for (const r of rows) {
    const endDate = normalizeDate(r.date);
    if (!endDate) continue;
    if (!byDate.has(endDate)) byDate.set(endDate, { endDate });
    Object.assign(byDate.get(endDate), r);
  }
  return Array.from(byDate.values()).sort((a, b) => a.endDate.localeCompare(b.endDate));
}

/**
 * Extract the 7 fields the backtest needs from a merged row. Returns null if
 * the row doesn't carry the income-statement minimum (revenue + net income).
 */
function extractFields(row) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const totalRevenue = num(row.totalRevenue ?? row.operatingRevenue);
  const netIncome = num(
    row.netIncome ??
      row.netIncomeCommonStockholders ??
      row.netIncomeContinuousOperations
  );
  const equity = num(row.stockholdersEquity ?? row.commonStockEquity);
  const totalDebt = num(row.totalDebt);
  const dilutedEPS = num(row.dilutedEPS ?? row.basicEPS);
  const dilutedAverageShares = num(row.dilutedAverageShares ?? row.basicAverageShares);

  if (totalRevenue == null && netIncome == null && equity == null) return null;

  return {
    endDate: row.endDate,
    totalRevenue,
    netIncome,
    equity,
    totalDebt,
    dilutedEPS,
    dilutedAverageShares,
  };
}

/**
 * Fetch one stock's full annual+quarterly history. Uses separate calls for
 * financials and balance-sheet modules because fundamentalsTimeSeries returns
 * them as separate row types; merging by endDate yields complete rows.
 */
async function fetchHistory(symbol) {
  // Run the 4 calls in parallel — they're independent.
  const opts = { validateResult: false };

  const [annualFin, annualBS, qFin, qBS] = await Promise.all([
    yf.fundamentalsTimeSeries(symbol, {
      period1: PERIOD1, period2: PERIOD2, type: "annual", module: "financials",
    }, opts).catch(() => []),
    yf.fundamentalsTimeSeries(symbol, {
      period1: PERIOD1, period2: PERIOD2, type: "annual", module: "balance-sheet",
    }, opts).catch(() => []),
    yf.fundamentalsTimeSeries(symbol, {
      period1: PERIOD1, period2: PERIOD2, type: "quarterly", module: "financials",
    }, opts).catch(() => []),
    yf.fundamentalsTimeSeries(symbol, {
      period1: PERIOD1, period2: PERIOD2, type: "quarterly", module: "balance-sheet",
    }, opts).catch(() => []),
  ]);

  const annualMerged = mergeByDate([...(annualFin || []), ...(annualBS || [])]);
  const quarterlyMerged = mergeByDate([...(qFin || []), ...(qBS || [])]);

  return {
    annual: annualMerged.map(extractFields).filter(Boolean),
    quarterly: quarterlyMerged.map(extractFields).filter(Boolean),
  };
}

async function main() {
  const stocks = getAllStocks();
  console.log(`Fetching historical fundamentals for ${stocks.length} stocks...`);
  console.log(`Window: ${PERIOD1} → ${PERIOD2}`);
  console.log(`Concurrency: ${CONCURRENCY}\n`);

  const results = {};
  let earliest = null;
  let latest = null;
  let ok = 0, failed = 0, empty = 0;

  let cursor = 0;
  const started = Date.now();

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= stocks.length) return;
      const stock = stocks[i];
      const tag = `[${String(i + 1).padStart(3)}/${stocks.length}]`;

      try {
        const hist = await fetchHistory(stock.symbol);
        const annualCount = hist.annual.length;
        const quarterlyCount = hist.quarterly.length;

        if (annualCount === 0 && quarterlyCount === 0) {
          empty++;
          console.log(`  ${tag} ${stock.symbol.padEnd(22)} EMPTY — no history`);
        } else {
          results[stock.symbol] = {
            sector: stock.sector,
            indices: stock.indices,
            annual: hist.annual,
            quarterly: hist.quarterly,
          };
          const allDates = [
            ...hist.annual.map((r) => r.endDate),
            ...hist.quarterly.map((r) => r.endDate),
          ];
          const min = allDates.sort()[0];
          const max = allDates.sort()[allDates.length - 1];
          if (!earliest || min < earliest) earliest = min;
          if (!latest || max > latest) latest = max;
          ok++;
          console.log(
            `  ${tag} ${stock.symbol.padEnd(22)} annual=${annualCount} quarterly=${quarterlyCount} (${min} → ${max})`
          );
        }
      } catch (err) {
        failed++;
        console.error(`  ${tag} ${stock.symbol.padEnd(22)} FAILED: ${err.message}`);
      }

      if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const output = {
    generatedAt: new Date().toISOString(),
    source: "yahoo-finance2",
    coverage: { earliest, latest },
    counts: { ok, failed, empty, total: stocks.length },
    stocks: results,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), "utf-8");

  console.log(
    `\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s. ` +
      `OK: ${ok}, Failed: ${failed}, Empty: ${empty}`
  );
  console.log(`Coverage: ${earliest} → ${latest}`);
  console.log(`Saved to ${OUT_PATH}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
