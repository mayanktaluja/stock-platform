/**
 * Daily SWS section-performance service regression.
 *
 * Run with: node test/trackSectionPerformance.test.mjs
 */

import {
  SECTION_PERFORMANCE_COHORT_SIZES,
  SECTION_PERFORMANCE_WINDOW_DEFINITIONS,
  SWS_SECTION_PERFORMANCE_REGISTRY,
  buildDailySectionCohortRows,
  buildSectionPerformanceApiPayload,
  buildSectionPerformancePayload,
  buildStoredResolvedSectionPerformancePayload,
  computeEqualWeightSectionReturn,
  computeSectionPerformanceForTimeframe,
  getSectionRegistryByType,
  normalizeSectionPerformanceCohorts,
  selectBestOverall,
} from "../services/trackRecord/sectionPerformance.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "-> got", JSON.stringify(got));
  }
}

function pick(ticker, r7, r30, extra = {}) {
  const r3m = extra.r3m ?? r30;
  const r1y = extra.r1y ?? r30;
  return {
    ticker,
    name: `${ticker} Ltd`,
    sector: "Industrials",
    current_price_inr: extra.price ?? 100,
    v4_score_100: extra.score ?? 60,
    returns_pct: {
      "7D": r7,
      "1M": r30,
      "3M": r3m,
      "1Y": r1y,
    },
    ...extra,
  };
}

function numberedPicks(prefix, count, r7, r30, r3m = r30, r1y = r30) {
  return Array.from({ length: count }, (_, idx) => pick(`${prefix}${idx + 1}`, r7 + idx, r30 + idx, { r3m: r3m + idx, r1y: r1y + idx }));
}

function pricedPicks(prefix, prices) {
  return prices.map((price, idx) => pick(`${prefix}${idx + 1}`, 0, 0, { price }));
}

function storedConstituents(prefix, count, r7) {
  return Array.from({ length: count }, (_, idx) => ({
    ticker: `${prefix}${idx + 1}`,
    symbol: `${prefix}${idx + 1}.NS`,
    rank: idx + 1,
    price_inr: 100,
    returns_pct: { "7d": r7, "30d": r7, "3m": r7, "1y": r7 },
  }));
}

console.log("trackRecord/sectionPerformance.js regression\n");

// ──── 1. Registry includes Best Fundamentals for this new service ────
{
  const byType = getSectionRegistryByType();
  assert(
    "best_fundamentals maps to sws_best_fundamentals",
    SWS_SECTION_PERFORMANCE_REGISTRY.best_fundamentals?.type === "sws_best_fundamentals" &&
      byType.sws_best_fundamentals?.sectionKey === "best_fundamentals",
    byType.sws_best_fundamentals,
  );
  assert(
    "growing_sector_value maps to sws_growing_sector_value",
    SWS_SECTION_PERFORMANCE_REGISTRY.growing_sector_value?.type === "sws_growing_sector_value" &&
      byType.sws_growing_sector_value?.sectionKey === "growing_sector_value",
    byType.sws_growing_sector_value,
  );
  assert("upcoming_earnings is not a Section Alpha source", !SWS_SECTION_PERFORMANCE_REGISTRY.upcoming_earnings && !byType.sws_upcoming_earnings, byType.sws_upcoming_earnings);
  assert("avoid is not a Section Alpha source", !SWS_SECTION_PERFORMANCE_REGISTRY.avoid && !byType.sws_avoid, byType.sws_avoid);
}

// ──── 2. Daily cohort rows create official 3/5/10/20 cohorts ────
{
  const rows = buildDailySectionCohortRows({
    scanned_at: "2026-05-25T10:00:00.000Z",
    scoring_version: "test-v1",
    sections: {
      best_fundamentals: numberedPicks("BF", 12, 1, 2),
      growing_sector_value: numberedPicks("GSV", 12, 2, 4),
    },
  });
  const bfRows = rows.filter((r) => r.type === "sws_best_fundamentals");
  const sizes = bfRows.map((r) => r.requested_cohort_size).sort((a, b) => a - b);
  const top20 = bfRows.find((r) => r.requested_cohort_size === 20);
  const top10 = bfRows.find((r) => r.requested_cohort_size === 10);
  assert("cohort rows exist for all official sizes", JSON.stringify(sizes) === JSON.stringify(SECTION_PERFORMANCE_COHORT_SIZES), sizes);
  assert("top-10 cap is still available", top10.constituents.length === 10, top10.constituents.length);
  assert("rank 10 is BF10, not BF11", top10.constituents[9].ticker === "BF10", top10.constituents[9]);
  assert("partial top-20 uses all available names", top20.constituents.length === 12 && top20.actual_cohort_size === 12, top20);
  assert("partial top-20 label is honest", top20.cohort_label === "top 12 available", top20.cohort_label);
  assert("row id includes cohort size", top10.id.endsWith("|top10") && top20.id.endsWith("|top20"), { top10: top10.id, top20: top20.id });
  assert("service API helpers default omitted cohorts to legacy top-10", JSON.stringify(normalizeSectionPerformanceCohorts()) === JSON.stringify([10]), normalizeSectionPerformanceCohorts());
  const gsvRows = rows.filter((r) => r.type === "sws_growing_sector_value");
  const gsvSizes = gsvRows.map((r) => r.requested_cohort_size).sort((a, b) => a - b);
  assert("growing-sector rows exist for all official sizes", JSON.stringify(gsvSizes) === JSON.stringify(SECTION_PERFORMANCE_COHORT_SIZES), gsvSizes);
}

// ──── 2b. Context-only SWS buckets never produce new Section Alpha rows ────
{
  const rows = buildDailySectionCohortRows({
    scanned_at: "2026-05-25T10:00:00.000Z",
    scoring_version: "test-v1",
    sections: {
      upcoming_earnings: numberedPicks("UE", 10, 40, 50),
      avoid: numberedPicks("AV", 10, -40, -50),
      best_to_buy_now: numberedPicks("BUY", 10, 4, 8),
    },
  });
  const types = new Set(rows.map((r) => r.type));
  assert("daily rows exclude SWS Upcoming Earnings", !types.has("sws_upcoming_earnings"), [...types]);
  assert("daily rows exclude SWS Avoid", !types.has("sws_avoid"), [...types]);
  assert("daily rows still include public recommendation sections", types.has("sws_best_buynow"), [...types]);
}

// ──── 3. Equal-weight calculation uses only available returns ────
{
  const r = computeEqualWeightSectionReturn([
    { ticker: "A", returns_pct: { "7d": 10 } },
    { ticker: "B", returns_pct: { "7d": 0 } },
    { ticker: "C", returns_pct: { "7d": null } },
  ], "7d", "LONG");
  assert("equal-weight return averages non-missing constituents only", r.underlying_return_pct === 5, r);
  assert("missing return count is tracked", r.missing_return_count === 1, r);
}

// ──── 4. Shared benchmark return is reused across sections ────
{
  const rows = buildDailySectionCohortRows({
    scanned_at: "2026-05-25T10:00:00.000Z",
    sections: {
      best_to_buy_now: numberedPicks("BUY", 10, 4, 8),
      quality_growth: numberedPicks("QG", 10, 2, 20),
    },
  });
  const payload = buildSectionPerformancePayload(rows, {
    benchmarkReturnsByTimeframe: { "7d": 1.5, "30d": 5 },
  });
  const buy = payload.sections.find((s) => s.type === "sws_best_buynow" && s.requested_cohort_size === 10);
  const qg = payload.sections.find((s) => s.type === "sws_quality_growth" && s.requested_cohort_size === 10);
  assert(
    "both 7d rows carry the exact same benchmark return",
    buy.performance_by_timeframe["7d"].benchmark_return_pct === 1.5 &&
      qg.performance_by_timeframe["7d"].benchmark_return_pct === 1.5,
    { buy: buy.performance_by_timeframe["7d"], qg: qg.performance_by_timeframe["7d"] },
  );
}

// ──── 4b. Nifty 50 is the primary Section Alpha benchmark ────
{
  const rows = buildDailySectionCohortRows({
    scanned_at: "2026-05-25T10:00:00.000Z",
    sections: {
      best_to_buy_now: numberedPicks("BUY", 10, 4, 8),
      quality_growth: numberedPicks("QG", 10, 2, 20),
    },
  });
  const payload = buildSectionPerformanceApiPayload(rows, {
    windows: ["7d"],
    cohorts: [10],
    sampleStatus: "latest_available",
    benchmarkReturnsByTimeframe: { "7d": 20 },
  });
  const win = payload.windows[0];
  const buy = win.sections.find((s) => s.type === "sws_best_buynow");
  assert("window uses Nifty 50 as primary benchmarkReturnPct", win.benchmarkReturnPct === 20, win);
  assert("window does not expose benchmarkComparisons", !("benchmarkComparisons" in win), win);
  assert("section alpha is calculated directly vs Nifty 50", buy.benchmarkReturnPct === 20 && buy.alphaPct === -11.5 && buy.outperformed === false, buy);
  assert("section does not expose benchmarkComparisons", !("benchmarkComparisons" in buy), buy);
  assert("bestOverall selects from Nifty 50 primary alpha", payload.bestOverall.type === "sws_best_buynow" && payload.bestOverall.alphaPct === -11.5 && payload.bestOverall.outperformed === false, payload.bestOverall);
}

// ──── 4c. Missing Nifty 50 benchmark data prevents a positive-alpha claim ────
{
  const rows = buildDailySectionCohortRows({
    scanned_at: "2026-05-25T10:00:00.000Z",
    sections: {
      best_to_buy_now: numberedPicks("BUY", 10, 10, 5),
    },
  });
  const payload = buildSectionPerformanceApiPayload(rows, {
    windows: ["7d"],
    cohorts: [10],
    sampleStatus: "latest_available",
    benchmarkReturnsByTimeframe: { "7d": null },
  });
  assert("window is not eligible without Nifty 50 benchmark data", payload.windows[0].outperformed === false && payload.bestOverall === null, payload);
  assert("row records missing Nifty 50 benchmark as a quality flag", payload.windows[0].sections[0].qualityFlags.includes("missing_benchmark_7d"), payload.windows[0].sections[0]);
}

// ──── 4d. Longer enabled windows map to their own SWS return keys ────
{
  const rows = buildDailySectionCohortRows({
    scanned_at: "2026-05-25T10:00:00.000Z",
    sections: {
      best_to_buy_now: numberedPicks("BUY", 10, 1, 2, 20, 50),
    },
  });
  const payload = buildSectionPerformanceApiPayload(rows, {
    windows: ["3m", "1y"],
    cohorts: [10],
    sampleStatus: "latest_available",
    benchmarkReturnsByTimeframe: { "3m": 5, "1y": 10 },
  });
  const byWindow = Object.fromEntries(payload.windows.map((w) => [w.window, w]));
  const w3m = byWindow["3m"].sections.find((s) => s.type === "sws_best_buynow");
  const w1y = byWindow["1y"].sections.find((s) => s.type === "sws_best_buynow");
  assert("3m window uses the SWS 3M return key", w3m.underlyingReturnPct === 24.5 && w3m.alphaPct === 19.5, w3m);
  assert("1y window uses the SWS 1Y return key", w1y.underlyingReturnPct === 54.5 && w1y.alphaPct === 44.5, w1y);
  // 3m/1y in latest_available mode are trailing returns of TODAY's picks
  // projected backward (survivorship/look-ahead), not held cohorts — so they
  // are flagged hindsight, make no outperformance claim, and cannot be crowned.
  assert("3m and 1y latest samples are flagged hindsight backfills", w3m.hindsight === true && w1y.hindsight === true, { w3m, w1y });
  assert("hindsight backfills make no outperformance claim", w3m.outperformed === false && w1y.outperformed === false, { w3m, w1y });
  assert("hindsight backfills are not banner/spotlight eligible", w3m.eligibleForBanner === false && w1y.eligibleForBanner === false && w1y.spotlightEligible === false, { w3m, w1y });
  assert("hindsight backfill carries the hindsight_backfill quality flag", w3m.qualityFlags.includes("hindsight_backfill"), w3m);
  // bestOverall may still surface as the best *relative* cohort, but a
  // hindsight-only panel can never assert an outperformance claim or a
  // homepage spotlight.
  assert("hindsight-only panel makes no outperformance claim and no spotlight", payload.spotlightSection === null && payload.bestOverall.outperformed === false && payload.bestOverall.eligibleForBanner === false, payload);
  assert("payload is marked hypothetical in latest_available mode", payload.isHypothetical === true && payload.basis === "current_cohort_trailing", payload);
}

// ──── 4e. Disabled 3y/5y windows are visible status payloads, not winners ────
{
  const rows = buildDailySectionCohortRows({
    scanned_at: "2026-05-25T10:00:00.000Z",
    sections: {
      best_to_buy_now: numberedPicks("BUY", 10, 1, 2, 20, 50),
    },
  });
  const payload = buildSectionPerformanceApiPayload(rows, {
    windows: ["3y", "5y"],
    cohorts: [10],
    sampleStatus: "latest_available",
    benchmarkReturnsByTimeframe: {},
  });
  assert("3y/5y are accepted window definitions", SECTION_PERFORMANCE_WINDOW_DEFINITIONS["3y"].enabled === false && SECTION_PERFORMANCE_WINDOW_DEFINITIONS["5y"].enabled === false, SECTION_PERFORMANCE_WINDOW_DEFINITIONS);
  assert("disabled windows return status payloads", payload.windows.length === 2 && payload.windows.every((w) => w.enabled === false && w.sections.length === 0 && w.bestSection === null), payload.windows);
  assert("disabled windows cannot win Track tab or homepage selection", payload.bestOverall === null && payload.spotlightSection === null, payload);
}

// ──── 5. LONG and SHORT alpha signs match platform-call semantics ────
{
  const longPerf = computeSectionPerformanceForTimeframe({
    type: "sws_best_buynow",
    sectionKey: "best_to_buy_now",
    side: "LONG",
    constituents: [
      { ticker: "A", returns_pct: { "7d": 5 } },
      { ticker: "B", returns_pct: { "7d": 7 } },
    ],
  }, "7d", 2);
  assert("LONG alpha = section return - benchmark", longPerf.alpha_pct === 4, longPerf);

  const shortPerf = computeSectionPerformanceForTimeframe({
    type: "sws_avoid",
    sectionKey: "avoid",
    side: "SHORT",
    constituents: [
      { ticker: "X", returns_pct: { "7d": -4 } },
      { ticker: "Y", returns_pct: { "7d": -2 } },
    ],
  }, "7d", 1);
  assert("SHORT alpha = benchmark - underlying section return", shortPerf.alpha_pct === 4, shortPerf);
  assert("SHORT display return is side-adjusted", shortPerf.return_pct === 3, shortPerf);
  assert("SHORT section beats when avoided stocks underperform benchmark", shortPerf.beat_benchmark === true, shortPerf);
}

// ──── 6. Missing data produces quality flags, not crashes ────
{
  const rows = buildDailySectionCohortRows({
    scanned_at: "2026-05-25T10:00:00.000Z",
    sections: {
      best_to_buy_now: [
        pick("GOOD", 3, 5),
        pick("NOPRICE", 2, 4, { current_price_inr: null, price: null }),
        { ticker: "NORET", current_price_inr: 10, returns_pct: {} },
      ],
    },
  });
  const row = rows.find((r) => r.type === "sws_best_buynow" && r.requested_cohort_size === 3);
  const perf = computeSectionPerformanceForTimeframe(row, "7d", null);
  assert("row flags missing prices", row.data_quality_flags.some((f) => f.startsWith("missing_prices")), row.data_quality_flags);
  assert("performance flags missing 7d return", perf.data_quality_flags.some((f) => f.startsWith("missing_returns_7d")), perf.data_quality_flags);
  assert("performance flags missing benchmark", perf.data_quality_flags.includes("missing_benchmark_7d"), perf.data_quality_flags);
  assert("coverage pct reflects only 2 valid returns out of 3", perf.coverage_pct === 66.7, perf);
}

// ──── 7. bestOverall searches across 7d and 30d ────
{
  const rows = buildDailySectionCohortRows({
    scanned_at: "2026-05-25T10:00:00.000Z",
    sections: {
      best_to_buy_now: numberedPicks("BUY", 10, 3, 30),
      quality_growth: numberedPicks("QG", 10, 12, 8),
    },
  });
  const payload = buildSectionPerformancePayload(rows, {
    benchmarkReturnsByTimeframe: { "7d": 2, "30d": 4 },
  });
  const best = selectBestOverall(payload.sections);
  assert("bestOverall returns the highest alpha across 7d/30d/cohorts", best.type === "sws_best_buynow" && best.timeframe === "30d", best);
  assert("payload includes bestOverall", payload.bestOverall.type === best.type && payload.bestOverall.timeframe === best.timeframe, payload.bestOverall);
}

// ──── 8. API bestOverall can choose across cohort sizes with eligibility guardrails ────
{
  const rows = buildDailySectionCohortRows({
    scanned_at: "2026-05-25T10:00:00.000Z",
    sections: {
      best_to_buy_now: numberedPicks("BUY", 20, 10, 5),
      quality_growth: numberedPicks("QG", 20, 3, 4),
    },
  });
  const payload = buildSectionPerformanceApiPayload(rows, {
    windows: ["7d"],
    cohorts: [3, 5, 10, 20],
    sampleStatus: "latest_available",
    benchmarkReturnsByTimeframe: { "7d": 1 },
  });
  assert("API exposes requested cohort sizes", JSON.stringify(payload.cohorts) === JSON.stringify([3, 5, 10, 20]), payload.cohorts);
  assert("bestOverall includes cohort metadata", payload.bestOverall.requestedCohortSize === 20 && payload.bestOverall.cohortLabel === "top 20", payload.bestOverall);
  assert("bestOverall winner is banner eligible", payload.bestOverall.eligibleForBanner === true && payload.bestOverall.outperformed === true, payload.bestOverall);
}

// ──── 8b. Retired stored rows cannot win bestOverall ────
{
  const rows = [
    {
      dateKey: "2026-05-25",
      snapshotAt: "2026-05-25T10:00:00.000Z",
      sectionKey: "upcoming_earnings",
      type: "sws_upcoming_earnings",
      label: "SWS - Upcoming Earnings",
      side: "LONG",
      top_n: 10,
      constituents: storedConstituents("UE", 10, 80),
    },
    {
      dateKey: "2026-05-25",
      snapshotAt: "2026-05-25T10:00:00.000Z",
      sectionKey: "avoid",
      type: "sws_avoid",
      label: "SWS - Avoid",
      side: "SHORT",
      top_n: 10,
      constituents: storedConstituents("AV", 10, -60),
    },
    {
      dateKey: "2026-05-25",
      snapshotAt: "2026-05-25T10:00:00.000Z",
      sectionKey: "best_to_buy_now",
      type: "sws_best_buynow",
      label: "SWS - Best to Buy Now",
      side: "LONG",
      top_n: 10,
      constituents: storedConstituents("BUY", 10, 5),
    },
  ];
  const payload = buildSectionPerformanceApiPayload(rows, {
    windows: ["7d"],
    cohorts: [10],
    sampleStatus: "latest_available",
    benchmarkReturnsByTimeframe: { "7d": 1 },
  });
  const types = new Set(payload.windows[0].sections.map((s) => s.type));
  assert("API payload filters stored Upcoming Earnings rows", !types.has("sws_upcoming_earnings"), [...types]);
  assert("API payload filters stored Avoid rows", !types.has("sws_avoid"), [...types]);
  assert("bestOverall ignores retired high-alpha rows", payload.bestOverall.type === "sws_best_buynow" && payload.bestOverall.alphaPct === 4, payload.bestOverall);
}

// ──── 9. Ineligible positive cohorts do not create a brag claim ────
{
  const rows = buildDailySectionCohortRows({
    scanned_at: "2026-05-25T10:00:00.000Z",
    sections: {
      smallcap_gems: [pick("ONLY1", 40, 0)],
    },
  }, { cohorts: [3] });
  const payload = buildSectionPerformanceApiPayload(rows, {
    windows: ["7d"],
    cohorts: [3],
    sampleStatus: "latest_available",
    benchmarkReturnsByTimeframe: { "7d": 1 },
  });
  assert("ineligible positive cohort can be best relative but not outperformed", payload.bestOverall.alphaPct === 39 && payload.bestOverall.outperformed === false, payload.bestOverall);
  assert("ineligible positive cohort is flagged", payload.bestOverall.eligibleForBanner === false, payload.bestOverall);
}

// ──── 10. Duplicate partial cohorts cannot win over the smaller equivalent set ────
{
  const rows = buildDailySectionCohortRows({
    scanned_at: "2026-05-25T10:00:00.000Z",
    sections: {
      smallcap_gems: numberedPicks("SM", 3, 20, 0),
    },
  });
  const payload = buildSectionPerformanceApiPayload(rows, {
    windows: ["7d"],
    cohorts: [3, 5, 10, 20],
    sampleStatus: "latest_available",
    benchmarkReturnsByTimeframe: { "7d": 1 },
  });
  const smallcapRows = payload.windows[0].sections.filter((s) => s.type === "sws_smallcap_gems");
  const top3 = smallcapRows.find((s) => s.requestedCohortSize === 3);
  const duplicates = smallcapRows.filter((s) => s.requestedCohortSize > 3);
  assert("smallest equivalent actual cohort remains eligible", top3?.eligibleForBanner === true, top3);
  assert(
    "larger duplicate actual cohorts are not banner eligible",
    duplicates.length === 3 && duplicates.every((s) => s.eligibleForBanner === false && s.qualityFlags.some((f) => f === "duplicate_actual_cohort:top_3")),
    duplicates,
  );
  assert("bestOverall uses the smallest equivalent cohort label", payload.bestOverall.requestedCohortSize === 3, payload.bestOverall);
}

// ──── 11. Stored matured cohorts win over latest trailing fallback ────
{
  const startRows = buildDailySectionCohortRows({
    scanned_at: "2026-05-01T10:00:00.000Z",
    sections: {
      best_to_buy_now: pricedPicks("BUY", [100, 100]),
      quality_growth: pricedPicks("QG", [100, 100]),
    },
  }, { cohorts: [3], dateKey: "2026-05-01" });
  const exitRows = buildDailySectionCohortRows({
    scanned_at: "2026-05-08T10:00:00.000Z",
    sections: {
      best_to_buy_now: pricedPicks("BUY", [103, 103]),
      quality_growth: pricedPicks("QG", [110, 110]),
    },
  }, { cohorts: [3], dateKey: "2026-05-08" });
  const payload = await buildStoredResolvedSectionPerformancePayload([...startRows, ...exitRows], {
    windows: ["7d"],
    cohorts: [3],
    benchmarkSeriesByProxy: {
      nifty500_tri: [
        { date: "2026-05-01", nav: 100 },
        { date: "2026-05-08", nav: 101 },
      ],
      nifty50_tri: [
        { date: "2026-05-01", nav: 100 },
        { date: "2026-05-08", nav: 102 },
      ],
    },
  });
  const win = payload.windows[0];
  const benchmarks = new Set(win.sections.map((s) => s.benchmarkReturnPct));
  assert("stored matured window is marked resolved", win.sampleStatus === "resolved", win);
  assert("stored matured window uses the original date and exit date", win.fromDate === "2026-05-01" && win.toDate === "2026-05-08", win);
  assert("resolved sections share one Nifty 50 benchmark return", benchmarks.size === 1 && benchmarks.has(2), win.sections);
  assert("resolved window does not expose benchmarkComparisons", !("benchmarkComparisons" in win), win);
  assert("resolved bestOverall alpha is directly vs Nifty 50", payload.bestOverall.type === "sws_quality_growth" && payload.bestOverall.alphaPct === 8, payload.bestOverall);
}

// ──── 11b. Stored 3m cohorts use the 91-day maturity window, not 7d ────
{
  const startRows = buildDailySectionCohortRows({
    scanned_at: "2026-01-01T10:00:00.000Z",
    sections: {
      best_to_buy_now: pricedPicks("BUY", [100, 100, 100]),
    },
  }, { cohorts: [3], dateKey: "2026-01-01" });
  const earlyRows = buildDailySectionCohortRows({
    scanned_at: "2026-01-08T10:00:00.000Z",
    sections: {
      best_to_buy_now: pricedPicks("BUY", [120, 120, 120]),
    },
  }, { cohorts: [3], dateKey: "2026-01-08" });
  const maturedRows = buildDailySectionCohortRows({
    scanned_at: "2026-04-02T10:00:00.000Z",
    sections: {
      best_to_buy_now: pricedPicks("BUY", [130, 130, 130]),
    },
  }, { cohorts: [3], dateKey: "2026-04-02" });
  const payload = await buildStoredResolvedSectionPerformancePayload([...startRows, ...earlyRows, ...maturedRows], {
    windows: ["3m"],
    cohorts: [3],
    benchmarkSeriesByProxy: {
      nifty50_tri: [
        { date: "2026-01-01", nav: 100 },
        { date: "2026-01-08", nav: 105 },
        { date: "2026-04-02", nav: 110 },
      ],
    },
  });
  const win = payload.windows[0];
  assert("3m stored window resolves against the 91-day date", win.fromDate === "2026-01-01" && win.toDate === "2026-04-02", win);
  assert("3m stored window uses the 91-day exit prices", win.bestSection.sectionReturnPct === 30 && win.bestSection.alphaPct === 20, win.bestSection);
}

// ──── 12. Legacy top-10 row dedupes against official top-10 row ────
{
  const official = buildDailySectionCohortRows({
    scanned_at: "2026-05-01T10:00:00.000Z",
    sections: { best_to_buy_now: pricedPicks("BUY", [100, 100, 100, 100, 100, 100, 100, 100, 100, 100]) },
  }, { cohorts: [10], dateKey: "2026-05-01" });
  const officialBuy = official.find((r) => r.type === "sws_best_buynow");
  const legacy = { ...officialBuy, id: "2026-05-01|sws_best_buynow", requested_cohort_size: undefined, actual_cohort_size: undefined, cohort_label: undefined };
  const payload = buildSectionPerformanceApiPayload([legacy, officialBuy], {
    windows: ["7d"],
    cohorts: [10],
    sampleStatus: "latest_available",
    benchmarkReturnsByTimeframe: { "7d": 0 },
  });
  const rows = payload.windows[0].sections.filter((s) => s.type === "sws_best_buynow");
  assert("legacy and official top-10 rows render once", rows.length === 1 && rows[0].requestedCohortSize === 10, rows);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
