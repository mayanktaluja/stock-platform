/**
 * Regression tests for benchmarkIndices.js + the enrichment + alpha
 * integration in mfRecommendation.recommendBook.
 *
 * Run with: node test/benchmarkIndices.test.mjs
 *
 * Pure tests — no network. We inject a synthetic AMFI master via
 * mfNavIngestion._setTestMaster(), and we exercise alpha math directly
 * (the network-dependent enrichBenchmarkMetrics fetcher is integration-
 * tested by smoke runs against the live API; this file pins the
 * deterministic logic).
 */

import {
  benchmarkProxyForCategory,
  resolveProxyAgainstMaster,
  buildAlpha,
  alphaPp,
  PROXY_REGISTRY,
  CATEGORY_TO_PROXY,
} from "../benchmarkIndices.js";
import { recommendBook } from "../mfRecommendation.js";

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, "→ got", JSON.stringify(got)); }
}

console.log("benchmarkIndices.js regression\n");

// ──────────────────── 1. Category → proxy mapping ────────────────────
console.log("benchmarkProxyForCategory:");
{
  const largeCap = benchmarkProxyForCategory("large_cap");
  assert("large_cap → Nifty 50 TRI", largeCap?.indexName === "Nifty 50 TRI", largeCap);
  assert("flexi_cap → Nifty 500 TRI", benchmarkProxyForCategory("flexi_cap")?.indexName === "Nifty 500 TRI");
  assert("elss → Nifty 500 TRI (multi-cap behaviour)", benchmarkProxyForCategory("elss")?.indexName === "Nifty 500 TRI");
  assert("mid_cap → Nifty Midcap 150 TRI", benchmarkProxyForCategory("mid_cap")?.indexName === "Nifty Midcap 150 TRI");
  assert("small_cap → Nifty Smallcap 250 TRI", benchmarkProxyForCategory("small_cap")?.indexName === "Nifty Smallcap 250 TRI");
  // No proxy for hybrid/debt — comparing them to equity TRI would be a category error
  assert("hybrid_aggressive → null (no equity-only proxy)", benchmarkProxyForCategory("hybrid_aggressive") === null);
  assert("liquid → null (debt has no TRI proxy)", benchmarkProxyForCategory("liquid") === null);
  assert("unknown category → null", benchmarkProxyForCategory("totally_made_up") === null);
  assert("missing category → null", benchmarkProxyForCategory(null) === null);
}
console.log();

// ──────────────────── 2. Master resolver ────────────────────
console.log("resolveProxyAgainstMaster:");
{
  const proxy = PROXY_REGISTRY.nifty50_tri;

  // 2a. Registry path — exact code match
  const masterWithCode = [
    { schemeCode: "120716", name: "UTI Nifty 50 Index Fund - Direct Plan - Growth Option", fundHouse: "UTI Mutual Fund" },
    { schemeCode: "999999", name: "Other Fund", fundHouse: "Other AMC" },
  ];
  const r1 = resolveProxyAgainstMaster(proxy, masterWithCode);
  assert("registry path resolves by code", r1?.schemeCode === "120716" && r1?.source === "registry", r1);

  // 2b. Pattern fallback — code rotated, name still matches
  const masterCodeRotated = [
    { schemeCode: "888888", name: "UTI Nifty 50 Index Fund - Direct Plan - Growth", fundHouse: "UTI Mutual Fund" },
    { schemeCode: "777777", name: "Some Other Fund - Direct Growth", fundHouse: "Other AMC" },
  ];
  const r2 = resolveProxyAgainstMaster(proxy, masterCodeRotated);
  assert("pattern fallback resolves by name+AMC", r2?.schemeCode === "888888" && r2?.source === "pattern", r2);

  // 2c. Negative — empty master
  assert("empty master → null", resolveProxyAgainstMaster(proxy, []) === null);

  // 2d. Negative — no match anywhere
  const masterEmpty = [{ schemeCode: "111111", name: "HDFC Some Fund - Direct Growth", fundHouse: "HDFC Mutual Fund" }];
  assert("no AMC + no name match → null", resolveProxyAgainstMaster(proxy, masterEmpty) === null);

  // 2e. Pattern path picks the SHORTEST name (excludes regional/sub-plan variants)
  const masterMultiMatch = [
    { schemeCode: "AAA", name: "UTI Nifty 50 Index Fund - Direct Plan - Growth - Sub Plan A (Sub Variant)", fundHouse: "UTI Mutual Fund" },
    { schemeCode: "BBB", name: "UTI Nifty 50 Index Fund - Direct Plan - Growth", fundHouse: "UTI Mutual Fund" },
  ];
  const r3 = resolveProxyAgainstMaster(proxy, masterMultiMatch);
  assert("multi-match picks shortest name", r3?.schemeCode === "BBB", r3);
}
console.log();

// ──────────────────── 3. Alpha math ────────────────────
console.log("alphaPp + buildAlpha:");
{
  assert("alphaPp 14 vs 12 = +2", alphaPp(14, 12) === 2);
  assert("alphaPp negative case 1.6 vs 12.8 = -11.2", alphaPp(1.64, 12.84) === -11.2);
  assert("alphaPp null guard (left)", alphaPp(null, 12) === null);
  assert("alphaPp null guard (right)", alphaPp(12, null) === null);
  assert("alphaPp NaN guard", alphaPp(NaN, 12) === null);

  // buildAlpha picks 3y as primary
  const a1 = buildAlpha(
    { cagr1yPct: 8, cagr3yPct: 14, cagr5yPct: 13 },
    { cagr1yPct: 10, cagr3yPct: 12, cagr5yPct: 11 },
  );
  assert("buildAlpha primary window = 3y", a1.primaryWindow === "3y");
  assert("buildAlpha primary alpha = +2pp", a1.primaryAlphaPp === 2);
  assert("buildAlpha verdict = BEATS (+2pp ≥ 1.5)", a1.verdict === "BEATS");

  // Falls back to 5y when 3y missing
  const a2 = buildAlpha(
    { cagr1yPct: 8, cagr3yPct: null, cagr5yPct: 13 },
    { cagr1yPct: 10, cagr3yPct: 12, cagr5yPct: 11 },
  );
  assert("buildAlpha falls back to 5y when 3y missing", a2.primaryWindow === "5y");

  // TRACKS verdict at ±150bps
  const a3 = buildAlpha(
    { cagr1yPct: null, cagr3yPct: 12.8, cagr5yPct: null },
    { cagr1yPct: null, cagr3yPct: 12.0, cagr5yPct: null },
  );
  assert("buildAlpha TRACKS verdict (within ±150bps)", a3.verdict === "TRACKS", a3);

  // LAGS verdict
  const a4 = buildAlpha(
    { cagr1yPct: null, cagr3yPct: 8, cagr5yPct: null },
    { cagr1yPct: null, cagr3yPct: 12, cagr5yPct: null },
  );
  assert("buildAlpha LAGS verdict (-4pp ≤ -1.5)", a4.verdict === "LAGS", a4);

  assert("buildAlpha null guard (no metrics either side)", buildAlpha(null, null) === null);
}
console.log();

// ──────────────────── 4. recommendBook integration ────────────────────
console.log("recommendBook with synthetic benchmark blocks:");
{
  // Synthesise three holdings with pre-populated `metrics` and `benchmark`
  // blocks (as if enrichMfHoldings + enrichBenchmarkMetrics already ran).
  // This bypasses the network-dependent fetch so the test stays unit-pure.
  const book = [
    {
      name: "HDFC Mid Cap Opportunities Fund Direct Growth",
      folio: "31525914",
      category: "Equity",
      subCategory: "Mid Cap",
      invested: 269986,
      currentValue: 289722,
      publishedXirrPct: 4.38,
      amfi: { schemeCode: "118989", schemeName: "HDFC Mid Cap Opportunities Fund - Direct Plan - Growth", fundHouse: "HDFC Mutual Fund", score: 1, matchType: "isin" },
      metrics: { cagr1yPct: 22.0, cagr3yPct: 28.5, cagr5yPct: 24.0, sharpe3y: 1.1, maxDrawdownPct: -28, annualVolPct: 18, asOfDate: "2026-04-22", historyDays: 2400 },
      benchmark: {
        proxyKey: "midcap150_tri",
        indexName: "Nifty Midcap 150 TRI",
        schemeCode: "147625",
        schemeName: "Motilal Oswal Nifty Midcap 150 Index Fund - Direct Plan - Growth",
        metrics: { cagr1yPct: 19.5, cagr3yPct: 26.0, cagr5yPct: 22.0, sharpe3y: 1.0, maxDrawdownPct: -30, annualVolPct: 19, asOfDate: "2026-04-22" },
        alpha: { alpha1yPp: 2.5, alpha3yPp: 2.5, alpha5yPp: 2.0, primaryWindow: "3y", primaryAlphaPp: 2.5, verdict: "BEATS" },
      },
    },
    {
      name: "Nippon India Large Cap Fund Direct Growth",
      folio: "477359028343",
      category: "Equity",
      subCategory: "Large Cap",
      invested: 229988,
      currentValue: 236301,
      publishedXirrPct: 1.66,
      amfi: { schemeCode: "118693", schemeName: "Nippon India Large Cap Fund - Direct Plan - Growth", fundHouse: "Nippon India Mutual Fund", score: 1, matchType: "isin" },
      metrics: { cagr1yPct: 12, cagr3yPct: 18, cagr5yPct: 16, sharpe3y: 0.9, maxDrawdownPct: -22, annualVolPct: 15, asOfDate: "2026-04-22", historyDays: 2400 },
      benchmark: {
        proxyKey: "nifty50_tri",
        indexName: "Nifty 50 TRI",
        schemeCode: "120716",
        schemeName: "UTI Nifty 50 Index Fund - Direct Plan - Growth Option",
        metrics: { cagr1yPct: 14, cagr3yPct: 14, cagr5yPct: 13, sharpe3y: 0.7, maxDrawdownPct: -25, annualVolPct: 14, asOfDate: "2026-04-22" },
        alpha: { alpha1yPp: -2, alpha3yPp: 4, alpha5yPp: 3, primaryWindow: "3y", primaryAlphaPp: 4, verdict: "BEATS" },
      },
    },
    {
      name: "Quant Small Cap Fund Direct Plan Growth",
      folio: "51082967565",
      category: "Equity",
      subCategory: "Small Cap",
      invested: 112501,
      currentValue: 103829,
      publishedXirrPct: -7.56,
      amfi: { schemeCode: "120828", schemeName: "Quant Small Cap Fund - Direct Plan - Growth Option", fundHouse: "Quant Mutual Fund", score: 1, matchType: "isin" },
      metrics: { cagr1yPct: -10, cagr3yPct: 15, cagr5yPct: 28, sharpe3y: 0.6, maxDrawdownPct: -42, annualVolPct: 28, asOfDate: "2026-04-22", historyDays: 2400 },
      benchmark: {
        proxyKey: "smallcap250_tri",
        indexName: "Nifty Smallcap 250 TRI",
        schemeCode: "147622",
        schemeName: "Nippon India Nifty Smallcap 250 Index Fund - Direct Plan - Growth",
        metrics: { cagr1yPct: -5, cagr3yPct: 22, cagr5yPct: 26, sharpe3y: 0.7, maxDrawdownPct: -38, annualVolPct: 25, asOfDate: "2026-04-22" },
        alpha: { alpha1yPp: -5, alpha3yPp: -7, alpha5yPp: 2, primaryWindow: "3y", primaryAlphaPp: -7, verdict: "LAGS" },
      },
    },
  ];

  const result = recommendBook(book);

  // 4a. Block exists and is well-shaped
  assert("benchmarkAlpha block present", result.benchmarkAlpha?.present === true, result.benchmarkAlpha);
  assert("benchmarkAlpha coverage = 100% (all 3 have benchmarks)", result.benchmarkAlpha.coveragePct === 100, result.benchmarkAlpha?.coveragePct);
  assert("benchmarkAlpha primary window = 3y", result.benchmarkAlpha.primary?.window === "3y", result.benchmarkAlpha?.primary);

  // 4b. Per-position chip on the LAGS holding
  const quantPosition = result.positions.find((p) => p.name?.includes("Quant Small Cap"));
  assert("Quant Small Cap has LAGS_INDEX chip", quantPosition?.rec.reasons.some((r) => r.code === "LAGS_INDEX"), quantPosition?.rec.reasons.map((r) => r.code));

  // 4c. Per-position chip on the BEATS holding
  const hdfcPosition = result.positions.find((p) => p.name?.includes("HDFC Mid Cap"));
  assert("HDFC Mid Cap has BEATS_INDEX chip", hdfcPosition?.rec.reasons.some((r) => r.code === "BEATS_INDEX"), hdfcPosition?.rec.reasons.map((r) => r.code));

  // 4d. Index breakdown lists each unique index
  const indexNames = (result.benchmarkAlpha.indexBreakdown || []).map((b) => b.indexName);
  assert("indexBreakdown lists Nifty 50 TRI", indexNames.includes("Nifty 50 TRI"), indexNames);
  assert("indexBreakdown lists Nifty Midcap 150 TRI", indexNames.includes("Nifty Midcap 150 TRI"), indexNames);
  assert("indexBreakdown lists Nifty Smallcap 250 TRI", indexNames.includes("Nifty Smallcap 250 TRI"), indexNames);

  // 4e. Critical SEBI-RA invariant: alpha NEVER changes the action.
  //     Quant SC has groww_xirr (no AMFI fallback path here as we've set
  //     `metrics.cagr3yPct = 15`), so trailingXirr = 15 (above the -3 EXIT
  //     threshold). LAGS_INDEX must augment, not promote to SWITCH.
  assert("LAGS_INDEX does not promote Quant SC to EXIT", quantPosition?.rec.action !== "EXIT" || quantPosition.rec.reasons.some((r) => r.code === "XIRR_NEGATIVE"), { action: quantPosition?.rec.action, reasons: quantPosition?.rec.reasons.map((r) => r.code) });
}
console.log();

// ──────────────────── 5. Coverage edge cases ────────────────────
console.log("coverage edge cases:");
{
  // Book with ONE benchmark-eligible holding + ONE hybrid (no benchmark)
  const mixedBook = [
    {
      name: "HDFC Hybrid Equity Fund Direct Growth",
      folio: "X",
      category: "Hybrid",
      subCategory: "Aggressive Hybrid",
      invested: 100000,
      currentValue: 110000,
      publishedXirrPct: 8,
      amfi: null,
      metrics: null,
      benchmark: null, // no proxy for hybrid
    },
    {
      name: "Parag Parikh Flexi Cap Fund Direct Growth",
      folio: "Y",
      category: "Equity",
      subCategory: "Flexi Cap",
      invested: 200000,
      currentValue: 234801,
      publishedXirrPct: 4.04,
      amfi: { schemeCode: "122639", schemeName: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth", fundHouse: "PPFAS Mutual Fund", score: 1, matchType: "isin" },
      metrics: { cagr1yPct: 16, cagr3yPct: 20, cagr5yPct: 22, sharpe3y: 1.2, maxDrawdownPct: -20, annualVolPct: 14, asOfDate: "2026-04-22", historyDays: 2400 },
      benchmark: {
        proxyKey: "nifty500_tri",
        indexName: "Nifty 500 TRI",
        schemeCode: "147623",
        schemeName: "Motilal Oswal Nifty 500 Index Fund - Direct Plan - Growth",
        metrics: { cagr1yPct: 15, cagr3yPct: 17, cagr5yPct: 16, sharpe3y: 0.8, maxDrawdownPct: -28, annualVolPct: 15, asOfDate: "2026-04-22" },
        alpha: { alpha1yPp: 1, alpha3yPp: 3, alpha5yPp: 6, primaryWindow: "3y", primaryAlphaPp: 3, verdict: "BEATS" },
      },
    },
  ];
  const r = recommendBook(mixedBook);
  // Coverage = 234801 / (110000 + 234801) ≈ 68.1%
  const expectedCov = +((234801 / (110000 + 234801)) * 100).toFixed(1);
  assert(`mixed book coverage ≈ ${expectedCov}% (excludes hybrid)`, Math.abs(r.benchmarkAlpha.coveragePct - expectedCov) < 0.2, r.benchmarkAlpha.coveragePct);
  assert("mixed book blended 3y alpha = +3pp (single covered position)", r.benchmarkAlpha.blended.alpha3yPp === 3, r.benchmarkAlpha.blended);
}
console.log();

// ──────────────────── 6. No benchmark anywhere ────────────────────
console.log("zero-coverage book:");
{
  const debtOnlyBook = [
    {
      name: "ICICI Liquid Fund Direct Growth",
      folio: "Z",
      category: "Debt",
      subCategory: "Liquid",
      invested: 500000,
      currentValue: 535000,
      publishedXirrPct: 7,
      amfi: null,
      metrics: null,
      benchmark: null,
    },
  ];
  const r = recommendBook(debtOnlyBook);
  assert("debt-only book → benchmarkAlpha.present = false", r.benchmarkAlpha.present === false, r.benchmarkAlpha);
  assert("debt-only book → reason explains the empty result", typeof r.benchmarkAlpha.reason === "string" && r.benchmarkAlpha.reason.length > 0, r.benchmarkAlpha?.reason);
}
console.log();

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
