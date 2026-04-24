#!/usr/bin/env node
/**
 * Survey Yahoo's heavier statement modules for NSE tickers.
 *
 * The Health pillar in Simply Wall St-style scoring needs:
 *   - currentRatio           → balanceSheetHistory (currentAssets / currentLiabilities)
 *   - OCF / Net Income       → cashflowStatementHistory + incomeStatementHistory
 *   - interestCoverage       → incomeStatementHistory (ebit / interestExpense)
 *
 * These modules are ~5× the payload of financialData. Before adding them to
 * the weekly enrichment cron, verify:
 *   1. Coverage across large/mid/small-cap NSE tickers
 *   2. Latency impact per request (budget is 60s cron / 112 stocks)
 *   3. Field shape stability (Yahoo has schema drift on these — the yearly
 *      statements sometimes return [] for recently-listed tickers)
 */
import YahooFinance from "yahoo-finance2";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

const SAMPLE = ["RELIANCE.NS", "TCS.NS", "SBIN.NS", "PERSISTENT.NS", "MASTEK.NS"];

for (const sym of SAMPLE) {
  const t0 = Date.now();
  try {
    const q = await yf.quoteSummary(sym, {
      modules: [
        "financialData",
        "defaultKeyStatistics",
        "summaryDetail",
        "balanceSheetHistory",
        "cashflowStatementHistory",
        "incomeStatementHistory",
      ],
    });
    const ms = Date.now() - t0;

    const bs = q?.balanceSheetHistory?.balanceSheetStatements?.[0] || null;
    const cf = q?.cashflowStatementHistory?.cashflowStatements?.[0] || null;
    const is = q?.incomeStatementHistory?.incomeStatementHistory?.[0] || null;

    console.log(`\n── ${sym} (${ms}ms) ──`);
    console.log(`  balanceSheet years: ${q?.balanceSheetHistory?.balanceSheetStatements?.length ?? 0}`);
    console.log(`  cashflow years:     ${q?.cashflowStatementHistory?.cashflowStatements?.length ?? 0}`);
    console.log(`  income years:       ${q?.incomeStatementHistory?.incomeStatementHistory?.length ?? 0}`);

    if (bs) {
      const ca = bs.totalCurrentAssets;
      const cl = bs.totalCurrentLiabilities;
      const cr = ca != null && cl != null && cl > 0 ? ca / cl : null;
      console.log(`  currentAssets=${ca}  currentLiab=${cl}  currentRatio=${cr?.toFixed(2) ?? "—"}`);
    }
    if (is && cf) {
      const ebit = is.ebit;
      const intExp = is.interestExpense;
      const ic = ebit != null && intExp != null && intExp !== 0 ? ebit / Math.abs(intExp) : null;
      const ni = is.netIncome;
      const ocf = cf.totalCashFromOperatingActivities;
      const ocfToNi = ni != null && ocf != null && ni !== 0 ? ocf / ni : null;
      console.log(`  ebit=${ebit}  interestExpense=${intExp}  interestCoverage=${ic?.toFixed(2) ?? "—"}`);
      console.log(`  netIncome=${ni}  ocf=${ocf}  OCF/NI=${ocfToNi?.toFixed(2) ?? "—"}`);
    }
  } catch (e) {
    console.log(`\n✗ ${sym}  ERROR: ${e.message}`);
  }
}
