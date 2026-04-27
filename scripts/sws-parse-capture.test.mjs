// Smoke test for sws-parse-capture.mjs.
// Uses a synthetic snippet that mirrors actual SWS overview-page structure
// (captured from real get_page_text calls in the planning conversation).
// Run: node scripts/sws-parse-capture.test.mjs

import {
  parseOverview,
  extractSnowflake,
  extractFairValue,
  extractReturns,
  extractRisks,
  extractRewards,
  extractMarketCap,
  extractMultiples,
  extractMarginsAndLeverage,
  extractDividend,
  extractNextEarningsDate,
  extractLastQuarterResult,
  extractAnalystRevisions,
  extractInsiderActivity,
} from "./sws-parse-capture.mjs";

let pass = 0, fail = 0;
function expect(label, actual, expected) {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      got:      ${JSON.stringify(actual)}\n      expected: ${JSON.stringify(expected)}`); }
}
function expectClose(label, actual, expected, tol = 0.01) {
  const eq = typeof actual === "number" && Math.abs(actual - expected) < tol;
  if (eq) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      got:      ${actual}\n      expected: ~${expected}`); }
}

// Snippet derived from the real TCS get_page_text response captured during planning
const tcsLikeText = `
Tata Consultancy Services (TCS) Stock Overview
Provides information technology (IT) and IT enabled services in the Americas, Europe, India, and internationally.
TCS fundamental analysis
Snowflake Score
Valuation 4/6
Future Growth 2/6
Past Performance 3/6
Financial Health 6/6
Dividends 6/6
Snowflake Analysis
Solid track record with excellent balance sheet and pays a dividend.
Rewards
Price-To-Earnings ratio (17.6x) is below the Indian market (23.5x)
Earnings are forecast to grow 7.75% per year
Earnings have grown 7.7% per year over the past 5 years
Pays a high and reliable dividend of 4.59%
Trading at good value compared to peers and industry
Analysts in good agreement that stock price will rise by 23%
Risk Analysis
No risks detected for TCS from our risk checks.
See All Risk Checks
Last Share Price ₹2.40k
AnalystConsensusTarget 18.7% undervalued ₹2.95k
Current Share Price ₹2,396.90
52 Week High ₹3,630.50
52 Week Low ₹2,346.20
Beta 0.27
1 Month Change 0.82%
3 Month Change -24.21%
1 Year Change -30.48%
3 Year Change -25.54%
5 Year Change -21.04%
Founded Employees CEO Website
1968 607,979 K. Krithivasan www.tcs.com
Market cap ₹8.67t
Earnings (TTM) ₹492.10b
Revenue (TTM) ₹2.67t
17.6x P/E Ratio
3.2x P/S Ratio
Earnings per share (EPS) 136.01
Gross Margin 40.31%
Net Profit Margin 18.43%
Debt/Equity Ratio 0%
Dividends 4.6% Current Dividend Yield 47% Payout Ratio
Last Reported Earnings Mar 31, 2026
Next Earnings Date Apr 30, 2026
Price target decreased by 7.6% to ₹2,960 Apr 11
Price target decreased by 7.2% to ₹3,026 Apr 10
Full year 2026 earnings: EPS misses analyst expectations Apr 10
`;

// Snippet derived from real ICICIBANK response — has insider buying
const iciciLikeText = `
ICICI Bank (ICICIBANK) Stock Overview
Snowflake Analysis
Excellent balance sheet average dividend payer.
Rewards
Price-To-Earnings ratio (17.5x) is below the Indian market (23.8x)
Earnings are forecast to grow 9.64% per year
Earnings have grown 20.8% per year over the past 5 years
Analysts in good agreement that stock price will rise by 25.7%
Risk Analysis
Unstable dividend track record
See All Risk Checks
AnalystConsensusTarget 20.3% undervalued ₹1.66k
MD, CEO & Executive Director exercised options to buy ₹292m worth of stock. Apr 26
Market cap ₹9.50t
17.5x P/E Ratio
2.6x P/B Ratio
Earnings per share (EPS) 75.66
Net Profit Margin 24.93%
Debt/Equity Ratio 58.0%
Dividends 0.9% Current Dividend Yield 16% Payout Ratio
`;

console.log("\n[1] Snowflake extraction (TCS)");
expect("snowflake.valuation", extractSnowflake(tcsLikeText).valuation, 4);
expect("snowflake.future_growth", extractSnowflake(tcsLikeText).future_growth, 2);
expect("snowflake.past_performance", extractSnowflake(tcsLikeText).past_performance, 3);
expect("snowflake.financial_health", extractSnowflake(tcsLikeText).financial_health, 6);
expect("snowflake.dividends", extractSnowflake(tcsLikeText).dividends, 6);

console.log("\n[2] Returns (TCS — 5Y is heavily negative)");
expect("returns.1Y", extractReturns(tcsLikeText)["1Y"], -30.48);
expect("returns.5Y", extractReturns(tcsLikeText)["5Y"], -21.04);

console.log("\n[3] Fair value & upside (TCS)");
const fv = extractFairValue(tcsLikeText);
expect("upside_pct (positive = undervalued)", fv.upside_pct, 18.7);

console.log("\n[4] Market cap & multiples (TCS)");
expect("market_cap_inr (₹8.67t)", extractMarketCap(tcsLikeText), 8.67e12);
expect("multiples.pe", extractMultiples(tcsLikeText).pe, 17.6);
expect("multiples.ps", extractMultiples(tcsLikeText).ps, 3.2);

console.log("\n[5] Margins & leverage (TCS)");
const ml = extractMarginsAndLeverage(tcsLikeText);
expect("net_margin_pct", ml.net_margin_pct, 18.43);
expect("debt_to_equity_pct (zero)", ml.debt_to_equity_pct, 0);
expect("gross_margin_pct", ml.gross_margin_pct, 40.31);

console.log("\n[6] Dividend (TCS)");
const d = extractDividend(tcsLikeText);
expect("dividend.yield_pct", d.yield_pct, 4.6);
expect("dividend.payout_pct", d.payout_pct, 47);

console.log("\n[7] Rewards (TCS — 6 expected, may dedupe)");
const rew = extractRewards(tcsLikeText);
console.log(`  ℹ rewards parsed (${rew.length}):`);
rew.forEach((r) => console.log(`     · ${r.slice(0, 80)}`));
if (rew.length >= 4) { pass++; console.log("  ✓ rewards.length >= 4"); }
else { fail++; console.log(`  ✗ rewards.length >= 4 (got ${rew.length})`); }

console.log("\n[8] Risks — TCS has none");
expect("risks (TCS = empty)", extractRisks(tcsLikeText), []);

console.log("\n[9] Risks — ICICIBANK has 'Unstable dividend track record'");
const iciciRisks = extractRisks(iciciLikeText);
console.log(`  ℹ risks parsed (${iciciRisks.length}):`, iciciRisks);
if (iciciRisks.some((r) => /unstable dividend/i.test(r))) {
  pass++; console.log("  ✓ risks contains 'Unstable dividend track record'");
} else { fail++; console.log("  ✗ risks did not include 'Unstable dividend track record'"); }

console.log("\n[10] Next earnings date (TCS)");
expect("next_earnings_date (TCS Apr 30, 2026)", extractNextEarningsDate(tcsLikeText), "2026-04-30");

console.log("\n[11] Last quarter result (TCS — missed)");
expect("last_quarter_result (TCS = miss)", extractLastQuarterResult(tcsLikeText), "miss");

console.log("\n[12] Analyst revisions (TCS — 2 cuts)");
const revs = extractAnalystRevisions(tcsLikeText);
console.log(`  ℹ revisions parsed (${revs.length}):`, revs);
if (revs.length >= 2 && revs[0].direction === "decreased") {
  pass++; console.log("  ✓ analyst revisions captured (decreased)");
} else { fail++; console.log("  ✗ analyst revisions miss"); }

console.log("\n[13] Insider buying (ICICIBANK — CEO bought ₹292m)");
const ins = extractInsiderActivity(iciciLikeText);
console.log(`  ℹ insider entries (${ins.length}):`, ins);
if (ins.length >= 1 && ins[0].direction === "buy" && ins[0].value_inr >= 290e6) {
  pass++; console.log("  ✓ insider buy of ₹292m captured");
} else { fail++; console.log("  ✗ insider buy not captured correctly"); }

console.log("\n[14] Top-level parseOverview (TCS) — sanity check on aggregation");
const ov = parseOverview(tcsLikeText);
expect("overview.snowflake_total (sum)", ov.snowflake_total, 21);
expect("overview.fair_value upside +18.7%", ov.upside_pct, 18.7);
expect("overview.last_quarter_result", ov.last_quarter_result, "miss");

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
