/**
 * Daily SWS section-performance service regression.
 *
 * Run with: node test/trackSectionPerformance.test.mjs
 */

import {
  SWS_SECTION_PERFORMANCE_REGISTRY,
  buildDailySectionCohortRows,
  buildSectionPerformancePayload,
  buildStoredResolvedSectionPerformancePayload,
  computeEqualWeightSectionReturn,
  computeSectionPerformanceForTimeframe,
  getSectionRegistryByType,
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
  return {
    ticker,
    name: `${ticker} Ltd`,
    sector: "Industrials",
    current_price_inr: extra.price ?? 100,
    v4_score_100: extra.score ?? 60,
    returns_pct: {
      "7D": r7,
      "1M": r30,
    },
    ...extra,
  };
}

function numberedPicks(prefix, count, r7, r30) {
  return Array.from({ length: count }, (_, idx) => pick(`${prefix}${idx + 1}`, r7 + idx, r30 + idx));
}

function pricedPicks(prefix, prices) {
  return prices.map((price, idx) => pick(`${prefix}${idx + 1}`, 0, 0, { price }));
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
}

// ──── 2. Daily cohort rows cap each section at top 10 ────
{
  const rows = buildDailySectionCohortRows({
    scanned_at: "2026-05-25T10:00:00.000Z",
    scoring_version: "test-v1",
    sections: {
      best_fundamentals: numberedPicks("BF", 12, 1, 2),
    },
  });
  const row = rows.find((r) => r.type === "sws_best_fundamentals");
  assert("cohort row exists for Best Fundamentals", !!row, row);
  assert("top-10 cap is enforced", row.constituents.length === 10, row.constituents.length);
  assert("rank 10 is BF10, not BF11", row.constituents[9].ticker === "BF10", row.constituents[9]);
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
  const buy = payload.sections.find((s) => s.type === "sws_best_buynow");
  const qg = payload.sections.find((s) => s.type === "sws_quality_growth");
  assert(
    "both 7d rows carry the exact same benchmark return",
    buy.performance_by_timeframe["7d"].benchmark_return_pct === 1.5 &&
      qg.performance_by_timeframe["7d"].benchmark_return_pct === 1.5,
    { buy: buy.performance_by_timeframe["7d"], qg: qg.performance_by_timeframe["7d"] },
  );
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
  const row = rows.find((r) => r.type === "sws_best_buynow");
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
  assert("bestOverall returns the highest alpha across 7d/30d", best.type === "sws_best_buynow" && best.timeframe === "30d", best);
  assert("payload includes bestOverall", payload.bestOverall.type === best.type && payload.bestOverall.timeframe === best.timeframe, payload.bestOverall);
}

// ──── 8. Stored matured cohorts win over latest trailing fallback ────
{
  const startRows = buildDailySectionCohortRows({
    scanned_at: "2026-05-01T10:00:00.000Z",
    sections: {
      best_to_buy_now: pricedPicks("BUY", [100, 100]),
      quality_growth: pricedPicks("QG", [100, 100]),
    },
  }, { topN: 2, dateKey: "2026-05-01" });
  const exitRows = buildDailySectionCohortRows({
    scanned_at: "2026-05-08T10:00:00.000Z",
    sections: {
      best_to_buy_now: pricedPicks("BUY", [103, 103]),
      quality_growth: pricedPicks("QG", [110, 110]),
    },
  }, { topN: 2, dateKey: "2026-05-08" });
  const payload = await buildStoredResolvedSectionPerformancePayload([...startRows, ...exitRows], {
    windows: ["7d"],
    benchmarkSeries: [
      { date: "2026-05-01", nav: 100 },
      { date: "2026-05-08", nav: 101 },
    ],
  });
  const win = payload.windows[0];
  const benchmarks = new Set(win.sections.map((s) => s.benchmarkReturnPct));
  assert("stored matured window is marked resolved", win.sampleStatus === "resolved", win);
  assert("stored matured window uses the original date and exit date", win.fromDate === "2026-05-01" && win.toDate === "2026-05-08", win);
  assert("resolved sections share one benchmark return", benchmarks.size === 1 && benchmarks.has(1), win.sections);
  assert("bestOverall comes from resolved forward returns", payload.bestOverall.type === "sws_quality_growth" && payload.bestOverall.alphaPct === 9, payload.bestOverall);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
