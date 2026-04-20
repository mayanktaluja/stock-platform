#!/usr/bin/env node
/**
 * Expands fundamentalsHistory.json from Nifty 100 (114 stocks) to full
 * Nifty 500 by fetching historical annual + quarterly financial data
 * from Yahoo Finance (quoteSummary endpoint).
 *
 * Strategy:
 *   1. Load existing fundamentalsHistory.json
 *   2. For each Nifty 500 stock not yet in the file, call
 *      yf.quoteSummary(symbol, { modules: ['incomeStatementHistory',
 *      'balanceSheetHistory', 'incomeStatementHistoryQuarterly',
 *      'balanceSheetHistoryQuarterly'] })
 *   3. Extract annual + quarterly rows with the fields PIT needs
 *   4. Merge and write back
 *
 * Network budget: ~400 new symbols × ~1.5s each = ~10 min total.
 * Concurrency 6.
 */

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import YahooFinance from "yahoo-finance2";
import { getNifty500 } from "../stockList.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_PATH = path.join(__dirname, "..", "fundamentalsHistory.json");

const CONCURRENCY = 6;
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

function extractAnnual(q) {
  return {
    endDate: (q.endDate instanceof Date ? q.endDate : new Date(q.endDate)).toISOString().slice(0, 10),
    totalRevenue: q.totalRevenue?.raw ?? q.totalRevenue ?? null,
    netIncome: q.netIncome?.raw ?? q.netIncome ?? null,
    equity: q.totalStockholderEquity?.raw ?? q.totalStockholderEquity ?? null,
    totalDebt: q.totalDebt?.raw ?? q.totalDebt ?? null,
    dilutedEPS: q.dilutedEPS?.raw ?? q.dilutedEPS ?? null,
    dilutedAverageShares: q.dilutedAverageShares?.raw ?? q.dilutedAverageShares ?? null,
  };
}

async function fetchOne(symbol) {
  try {
    const res = await yf.quoteSummary(symbol, {
      modules: ["incomeStatementHistory", "balanceSheetHistory", "summaryProfile",
                "incomeStatementHistoryQuarterly", "balanceSheetHistoryQuarterly"],
    });
    const annualIS = res.incomeStatementHistory?.incomeStatementHistory || [];
    const annualBS = res.balanceSheetHistory?.balanceSheetStatements || [];
    const qIS = res.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
    const qBS = res.balanceSheetHistoryQuarterly?.balanceSheetStatements || [];

    // Merge IS + BS by endDate for annual
    const annualMap = new Map();
    for (const s of annualIS) {
      const d = (s.endDate instanceof Date ? s.endDate : new Date(s.endDate)).toISOString().slice(0, 10);
      annualMap.set(d, { ...annualMap.get(d), ...extractAnnual(s) });
    }
    for (const s of annualBS) {
      const d = (s.endDate instanceof Date ? s.endDate : new Date(s.endDate)).toISOString().slice(0, 10);
      const prev = annualMap.get(d) || { endDate: d };
      annualMap.set(d, { ...prev, equity: s.totalStockholderEquity?.raw ?? s.totalStockholderEquity ?? prev?.equity,
        totalDebt: s.totalDebt?.raw ?? s.totalDebt ?? prev?.totalDebt });
    }
    const qMap = new Map();
    for (const s of qIS) {
      const d = (s.endDate instanceof Date ? s.endDate : new Date(s.endDate)).toISOString().slice(0, 10);
      qMap.set(d, { ...qMap.get(d), ...extractAnnual(s) });
    }
    for (const s of qBS) {
      const d = (s.endDate instanceof Date ? s.endDate : new Date(s.endDate)).toISOString().slice(0, 10);
      const prev = qMap.get(d) || { endDate: d };
      qMap.set(d, { ...prev, equity: s.totalStockholderEquity?.raw ?? s.totalStockholderEquity ?? prev?.equity,
        totalDebt: s.totalDebt?.raw ?? s.totalDebt ?? prev?.totalDebt });
    }

    const sector = res.summaryProfile?.sector || null;
    return {
      annual: [...annualMap.values()].sort((a, b) => a.endDate.localeCompare(b.endDate)),
      quarterly: [...qMap.values()].sort((a, b) => a.endDate.localeCompare(b.endDate)),
      sector,
    };
  } catch (err) {
    return null;
  }
}

async function main() {
  const history = JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
  if (!history.stocks) history.stocks = {};
  const existing = new Set(Object.keys(history.stocks));

  const n500 = getNifty500();
  const missing = n500.filter((s) => !existing.has(s.symbol));
  console.log(`Current: ${existing.size} covered. Nifty 500 total: ${n500.length}. Missing: ${missing.length}`);

  if (missing.length === 0) {
    console.log("All covered. Nothing to do.");
    return;
  }

  const queue = [...missing];
  let done = 0, ok = 0, empty = 0, failed = 0;

  async function worker() {
    while (queue.length) {
      const stock = queue.shift(); if (!stock) break;
      const result = await fetchOne(stock.symbol);
      done++;
      if (!result) { failed++; }
      else if (!result.annual.length && !result.quarterly.length) { empty++; }
      else {
        ok++;
        history.stocks[stock.symbol] = {
          sector: stock.sector,
          indices: stock.indices,
          annual: result.annual,
          quarterly: result.quarterly,
        };
      }
      if (done % 25 === 0 || done === missing.length) {
        console.log(`  ${done}/${missing.length}  ok=${ok}  empty=${empty}  failed=${failed}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  history.generatedAt = new Date().toISOString();
  history.source = "yahoo-finance2 (expanded)";
  history.counts = { ok: Object.keys(history.stocks).length, failed, empty, total: existing.size + missing.length };

  writeFileSync(HISTORY_PATH, JSON.stringify(history), "utf-8");
  console.log(`\nSaved. Total coverage now: ${Object.keys(history.stocks).length} / ${n500.length} Nifty 500 stocks.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
