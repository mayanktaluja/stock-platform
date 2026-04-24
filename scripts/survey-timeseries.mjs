#!/usr/bin/env node
/**
 * Survey Yahoo's fundamentalsTimeSeries endpoint for health-pillar metrics.
 *
 * Correct API shape (from yahoo-finance2 source):
 *   fundamentalsTimeSeries(symbol, { period1, type, module })
 *     type:   "quarterly" | "annual" | "trailing"
 *     module: "financials" | "balance-sheet" | "cash-flow" | "all"
 *
 * Returns array of {date, TYPE, periodType, ...lineItems}. Line items are
 * camelCased without the "annual"/"quarterly" prefix.
 */
import YahooFinance from "yahoo-finance2";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

const SAMPLE = ["RELIANCE.NS", "TCS.NS", "SBIN.NS", "PERSISTENT.NS", "MASTEK.NS"];
const period1 = new Date(Date.now() - 3 * 365 * 86400 * 1000);

for (const sym of SAMPLE) {
  const t0 = Date.now();
  try {
    const rows = await yf.fundamentalsTimeSeries(sym, {
      period1,
      type: "annual",
      module: "all",
    });
    const ms = Date.now() - t0;

    // Most recent period first.
    const sorted = [...rows].sort((a, b) => new Date(b.date) - new Date(a.date));
    const latest = sorted[0] || {};

    const bs = latest.currentAssets ?? latest.totalCurrentAssets;
    const cl = latest.currentLiabilities ?? latest.totalCurrentLiabilities;
    const ebit = latest.EBIT;
    const intExp = latest.interestExpense;
    const ni = latest.netIncome;
    const ocf = latest.operatingCashFlow;
    const fcf = latest.freeCashFlow;
    const totalDebt = latest.totalDebt;
    const equity = latest.stockholdersEquity ?? latest.commonStockEquity;

    const fmt = (v) => {
      if (v == null) return "—";
      if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B";
      if (Math.abs(v) >= 1e7) return (v / 1e7).toFixed(2) + "Cr";
      return v.toFixed(2);
    };

    console.log(`\n── ${sym} (${ms}ms, ${rows.length} rows, latest ${latest.date?.toISOString?.().slice(0,10)}) ──`);
    console.log(`  currentAssets      ${fmt(bs)}`);
    console.log(`  currentLiabilities ${fmt(cl)}`);
    console.log(`  EBIT               ${fmt(ebit)}`);
    console.log(`  interestExpense    ${fmt(intExp)}`);
    console.log(`  netIncome          ${fmt(ni)}`);
    console.log(`  operatingCashFlow  ${fmt(ocf)}`);
    console.log(`  freeCashFlow       ${fmt(fcf)}`);
    console.log(`  totalDebt          ${fmt(totalDebt)}`);
    console.log(`  stockholdersEquity ${fmt(equity)}`);

    const cr = bs != null && cl != null && cl > 0 ? bs / cl : null;
    const ic = ebit != null && intExp != null && Math.abs(intExp) > 0 ? ebit / Math.abs(intExp) : null;
    const ocfToNi = ni != null && ocf != null && ni !== 0 ? ocf / ni : null;
    const de = totalDebt != null && equity != null && equity > 0 ? totalDebt / equity : null;

    console.log(`  ── derived ──`);
    console.log(`  currentRatio       ${cr?.toFixed(2) ?? "—"}`);
    console.log(`  interestCoverage   ${ic?.toFixed(2) ?? "—"}`);
    console.log(`  OCF/NI             ${ocfToNi?.toFixed(2) ?? "—"}`);
    console.log(`  D/E (sanity)       ${de?.toFixed(2) ?? "—"}`);
  } catch (e) {
    console.log(`\n✗ ${sym}  ERROR: ${e.message}`);
  }
}
