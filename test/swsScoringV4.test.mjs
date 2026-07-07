/**
 * Unit tests for the isolated V4 score (services/swsScoringV4.js).
 *
 * Covers:
 *   • V4_SCORING_VERSION stamp
 *   • pillar scaling H20/F22/V18/P16 (v4.1 H↔F swap) + dividend dropped (zero weight)
 *   • _fvCompositeV4 — renormalised over present subs, industry fallback for
 *     missing analyst FV, MAX-inflation guard, both-absent neutral
 *   • momentum 7/3/2 + imputation
 *   • V4-only value-trap brake + falling-knife precedence
 *   • surveillance overlay parity with the old V3 overlay
 *   • verdictV4FromScore — ABSOLUTE cutoffs (59/47/37/28), null-safe
 *   • score clamps + component-sum reconciliation
 *   • v4_breakdown carries pts_fv_total (V3's pts_fv_upside is gone)
 *   • drift guard: scripts/swsScoringV4.mjs re-export === services module
 *   • integration: India scoreStock emits the v4 score + absolute verdict
 *
 * Run with: node test/swsScoringV4.test.mjs
 */

import {
  computeV4Score,
  _fvCompositeV4,
  buildFvCompositeIndustryAverages,
  verdictV4FromScore,
  V4_SCORING_VERSION,
} from "../services/swsScoringV4.js";
import { computeV4Score as computeV4ScoreViaScript } from "../scripts/swsScoringV4.mjs";
import { buildFvUpsideBenchmark } from "../services/scoring/fvUpsideRelative.js";
import { buildUniverseStats } from "../services/swsScoring.js";
import { pickCardFields, scoreStock as scoreStockIndia } from "../scripts/sws-scoring.mjs";

import assert from "node:assert/strict";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.log("  ✗", name, "→", e.message); }
}
const approx = (a, b, eps = 0.06) => Math.abs(a - b) <= eps;
const mk = (snow, extra = {}) => ({ ticker: "T", overview: { snowflake: snow, ...extra } });

console.log("\nversion stamp\n");
check("V4_SCORING_VERSION is sws-v4(.x)-100pt", () => assert.ok(/sws-v4(\.\d+)?-100pt/.test(V4_SCORING_VERSION)));

console.log("\npillar scaling + dividend dropped\n");
check("all pillars 6/6, no FV/momentum data → 88 (76 pillars + 6 FV + 6 mom)", () => {
  const s = mk({ financial_health: 6, future: 6, valuation: 6, past: 6, dividends: 6 });
  const { v4_score_100, v4_breakdown } = computeV4Score(s, { surveillanceFlag: null });
  assert.equal(v4_breakdown.pts_health, 20);   // v4.1: was 22
  assert.equal(v4_breakdown.pts_future, 22);   // v4.1: was 20
  assert.equal(v4_breakdown.pts_valuation, 18);
  assert.equal(v4_breakdown.pts_past, 16);
  assert.equal(v4_score_100, 88); // 76 + 6 (FV imputed) + 6 (momentum imputed) — block sum unchanged
});
check("dividend pillar has ZERO weight (two stocks differing only in dividends score equal)", () => {
  const base = { financial_health: 4, future: 3, valuation: 5, past: 4 };
  const a = computeV4Score(mk({ ...base, dividends: 0 }), { surveillanceFlag: null }).v4_score_100;
  const b = computeV4Score(mk({ ...base, dividends: 6 }), { surveillanceFlag: null }).v4_score_100;
  assert.equal(a, b);
});

console.log("\n_fvCompositeV4 — upside sub alone (weight carries full 12)\n");
check("+30% upside → 12", () => assert.equal(_fvCompositeV4({ upside_pct: 30 }).pts_fv_total, 12));
check("+20% upside → 9",  () => assert.equal(_fvCompositeV4({ upside_pct: 20 }).pts_fv_total, 9));
check("+5% upside → 6",   () => assert.equal(_fvCompositeV4({ upside_pct: 5 }).pts_fv_total, 6));
check("-5% upside → 3",   () => assert.equal(_fvCompositeV4({ upside_pct: -5 }).pts_fv_total, 3));
check("-20% upside → 0",  () => assert.equal(_fvCompositeV4({ upside_pct: -20 }).pts_fv_total, 0));
check("no value signal at all → neutral 6, fv_imputed", () => {
  const fv = _fvCompositeV4({});
  assert.equal(fv.pts_fv_total, 6);
  assert.equal(fv.fv_imputed, true);
  assert.equal(fv.fv_subsignals_present, 0);
});

console.log("\n_fvCompositeV4 — relative P/E sub + blend\n");
check("cheap-vs-industry P/E alone → 12", () =>
  assert.equal(_fvCompositeV4({ multiples: { pe: 10 }, industry_benchmarks: { pe: 20 } }).pts_fv_total, 12));
check("missing analyst FV can use industry-average fallback instead of P/E-only max", () => {
  const fv = _fvCompositeV4(
    { fair_value_inr: null, upside_pct: null, multiples: { pe: 10 }, industry_benchmarks: { pe: 20 } },
    null,
    { industryFallback: { pts: 4.8, count: 154, key: "industry_code:7110000", label: "Diversified Financials" } },
  );
  assert.equal(fv.pts_fv_total, 4.8);
  assert.equal(fv.fv_imputed, true);
  assert.equal(fv.fv_industry_imputed, true);
  assert.equal(fv.fv_industry_average_count, 154);
  assert.equal(fv.fv_subsignals_present, 1);
  assert.equal(fv.pts_fv_pe_effective, null);
});
check("expensive P/E drags a +20% upside down to 6", () =>
  assert.equal(_fvCompositeV4({ upside_pct: 20, multiples: { pe: 30 }, industry_benchmarks: { pe: 20 } }).pts_fv_total, 6));
check("in-line P/E + +20% upside → 8", () => {
  // 12 * (8*0.75 + 4*0.5)/12 = 12 * 8/12 = 8
  assert.equal(_fvCompositeV4({ upside_pct: 20, multiples: { pe: 21 }, industry_benchmarks: { pe: 20 } }).pts_fv_total, 8);
  assert.equal(_fvCompositeV4({ upside_pct: 20, multiples: { pe: 21 }, industry_benchmarks: { pe: 20 } }).fv_subsignals_present, 2);
});
check("zero and negative P/E are displayable inputs but do not earn relative-P/E points", () => {
  for (const pe of [0, -12.3]) {
    const fv = _fvCompositeV4({ multiples: { pe }, industry_benchmarks: { pe: 20 } });
    assert.equal(fv.fv_subsignals_present, 0);
    assert.equal(fv.pts_fv_pe_effective, null);
    assert.equal(fv.fv_pe_bucket, null);
    assert.equal(fv.pts_fv_total, 6);
    assert.equal(fv.fv_imputed, true);
  }
});
check("computeV4Score resolves exact industry-code fallback before broad sector fallback", () => {
  const stock = {
    ticker: "UYFINCORP",
    sector: "Diversified Financials",
    overview: {
      fair_value_inr: null,
      upside_pct: null,
      multiples: { pe: 8.88 },
      industry_benchmarks: { pe: 22.75 },
      pe_benchmark_audit: {
        sws_industry_api: { industry_code: "7110000" },
        internal_median: { industry_code: "7110000", industry_name: "Diversified Financials" },
      },
    },
  };
  const universe = {
    fvCompositeIndustryAverages: {
      by_key: {
        "industry_code:7110000": { pts: 4.8, count: 154, label: "Diversified Financials", scope: "industry_code" },
        "sector:Diversified Financials": { pts: 5.1, count: 486, label: "Diversified Financials", scope: "sector" },
      },
    },
  };
  const b = computeV4Score(stock, { universe, surveillanceFlag: null }).v4_breakdown;
  assert.equal(b.pts_fv_total, 4.8);
  assert.equal(b.fv_industry_imputed, true);
  assert.equal(b.fv_industry_average_key, "industry_code:7110000");
  assert.equal(b.fv_industry_average_count, 154);
});
check("industry averages are built only from analyst-covered peers", () => {
  const averages = buildFvCompositeIndustryAverages([
    { ticker: "A", sector: "Finance", overview: { upside_pct: 30, multiples: { pe: 10 }, industry_benchmarks: { pe: 20 } } },
    { ticker: "B", sector: "Finance", overview: { upside_pct: -20, multiples: { pe: 30 }, industry_benchmarks: { pe: 20 } } },
    { ticker: "C", sector: "Finance", overview: { upside_pct: null, multiples: { pe: 10 }, industry_benchmarks: { pe: 20 } } },
  ], null, { minCount: 2 });
  assert.equal(averages.by_key["sector:Finance"].count, 2);
  assert.equal(averages.by_key["sector:Finance"].pts, 6);
});

console.log("\n_fvCompositeV4 — MAX-inflation guard\n");
check("FV≈range.max with count≤5 haircuts one bucket (+30% → 9)", () => {
  const fv = _fvCompositeV4({ upside_pct: 30, fair_value_inr: 155, fair_value_range_inr: { min: 100, max: 155, count: 3 } });
  assert.equal(fv.pts_fv_total, 9); // 1.0 → 0.75 → 12*0.75 = 9
  assert.equal(fv.fv_max_inflation_haircut, true);
});
check("guard does NOT fire when analyst count is high", () => {
  const fv = _fvCompositeV4({ upside_pct: 30, fair_value_inr: 155, fair_value_range_inr: { min: 100, max: 155, count: 30 } });
  assert.equal(fv.pts_fv_total, 12);
  assert.equal(fv.fv_max_inflation_haircut, false);
});
check("guard emits a DISPLAY haircut factor (0.75) + max-target basis when it fires", () => {
  const fv = _fvCompositeV4({ upside_pct: 30, fair_value_inr: 155, fair_value_range_inr: { min: 100, max: 155, count: 3 } });
  assert.equal(fv.upside_haircut_factor, 0.75);
  assert.equal(fv.upside_display_basis, "haircut_max_target");
});
check("no-histogram path: FV≈max with ABSENT count still fires (factor 0.75, thin_coverage)", () => {
  const fv = _fvCompositeV4({ upside_pct: 30, fair_value_inr: 155, fair_value_range_inr: { min: 100, max: 155 } });
  assert.equal(fv.fv_max_inflation_haircut, true);
  assert.equal(fv.upside_haircut_factor, 0.75);
  assert.equal(fv.upside_display_basis, "haircut_thin_coverage");
});
check("well-covered near-max leaves the displayed upside intact (factor 1, basis null)", () => {
  const fv = _fvCompositeV4({ upside_pct: 30, fair_value_inr: 155, fair_value_range_inr: { min: 100, max: 155, count: 30 } });
  assert.equal(fv.upside_haircut_factor, 1);
  assert.equal(fv.upside_display_basis, null);
});

console.log("\nrelative FV-upside — adopts #426 universe benchmark (magnitude-aware)\n");
const _bmRows = [5, 8, 10, 12, 14, 18, 25, 40, 80, 150].map((u) => ({ upside_pct: u, market_cap_inr: 1e10 }));
check("WITH benchmark: magnitude preserved (+150% beats +35%; absolute saturates both at 12)", () => {
  const bm = buildFvUpsideBenchmark(_bmRows, { microCapFloorInr: 5e9 });
  assert.equal(bm.degenerate, false);
  const hi = _fvCompositeV4({ upside_pct: 150 }, bm).pts_fv_total;
  const mid = _fvCompositeV4({ upside_pct: 35 }, bm).pts_fv_total;
  assert.ok(hi > mid, `relative must preserve magnitude: 150%→${hi} should beat 35%→${mid}`);
  assert.equal(_fvCompositeV4({ upside_pct: 150 }).pts_fv_total, 12); // absolute fallback saturates
  assert.equal(_fvCompositeV4({ upside_pct: 35 }).pts_fv_total, 12);
});
check("below-median upside scores below above-median (relative)", () => {
  const bm = buildFvUpsideBenchmark(_bmRows, { microCapFloorInr: 5e9 });
  assert.ok(_fvCompositeV4({ upside_pct: 2 }, bm).pts_fv_total < _fvCompositeV4({ upside_pct: 60 }, bm).pts_fv_total);
});
check("no benchmark → absolute-band fallback unchanged (graceful on-demand path)", () => {
  assert.equal(_fvCompositeV4({ upside_pct: 30 }).pts_fv_total, 12);
  assert.equal(_fvCompositeV4({ upside_pct: 20 }).pts_fv_total, 9);
});
check("computeV4Score threads universe.fvBenchmark (relative < saturated absolute at +35%)", () => {
  const bm = buildFvUpsideBenchmark(_bmRows, { microCapFloorInr: 5e9 });
  const stock = () => mk({ financial_health: 5 }, { upside_pct: 35 });
  const relFv = computeV4Score(stock(), { surveillanceFlag: null, universe: { fvBenchmark: bm } }).v4_breakdown.pts_fv_total;
  const absFv = computeV4Score(stock(), { surveillanceFlag: null }).v4_breakdown.pts_fv_total;
  assert.ok(relFv < absFv, `threaded relative FV (${relFv}) should sit below the saturated absolute (${absFv})`);
});
const JSLL_FV_BENCH = { median_slog: 2.0422336508053425, robust_sigma: 3.785644883188037, degenerate: false };
check("JSLL-like: high upside + expensive P/E can land near 5/12", () => {
  const fv = _fvCompositeV4({
    upside_pct: 84.68641785302039,
    multiples: { pe: 37.94520670342898 },
    industry_benchmarks: { pe: 22.616750576 },
  }, JSLL_FV_BENCH);
  assert.equal(fv.pts_fv_total, 5);
  assert.equal(fv.pts_fv_pe_effective, 0);
  assert.equal(fv.fv_pe_bucket, "expensive");
  assert.equal(fv.fv_benchmark_used, true);
});
check("JSLL-like with Groww/Refinitiv P/E is inline, not expensive", () => {
  const fv = _fvCompositeV4({
    upside_pct: 84.68641785302039,
    multiples: { pe: 39.58 },
    industry_benchmarks: { pe: 45.29762059479049 },
    pe_benchmark_source: {
      provider: "groww_refinitiv",
      label: "Groww/Refinitiv",
      industry_name: "Pharmaceuticals",
      company_pe: 39.58,
      industry_pe: 45.29762059479049,
      fetched_at: "2026-05-24T12:00:00.000Z",
    },
  }, JSLL_FV_BENCH);
  assert.equal(fv.fv_pe_bucket, "inline");
  assert.equal(fv.pts_fv_pe_effective, 2);
  assert.equal(fv.pts_fv_total, 7);
  assert.equal(fv.fv_pe_source, "groww_refinitiv");
  assert.equal(fv.fv_pe_industry_name, "Pharmaceuticals");
  assert.equal(fv.fv_pe_company_pe, 39.58);
  assert.equal(fv.fv_pe_industry_pe, 45.298);
});
check("IMFA-like: missing P/E renormalises over upside only, so it can beat JSLL FV", () => {
  const jsll = _fvCompositeV4({
    upside_pct: 84.68641785302039,
    multiples: { pe: 37.94520670342898 },
    industry_benchmarks: { pe: 22.616750576 },
  }, JSLL_FV_BENCH);
  const imfa = _fvCompositeV4({ upside_pct: 29.698068448227737 }, JSLL_FV_BENCH);
  assert.equal(imfa.pts_fv_total, 6.9);
  assert.ok(imfa.pts_fv_total > jsll.pts_fv_total);
  assert.equal(imfa.fv_subsignals_present, 1);
});

console.log("\nmomentum 7/3/2 + imputation\n");
check("no universe → momentum imputed at 0.5 (3.5/1.5/1.0), flagged", () => {
  const b = computeV4Score(mk({}), { surveillanceFlag: null }).v4_breakdown;
  assert.equal(b.pts_mom_1y, 3.5);
  assert.equal(b.pts_mom_3m, 1.5);
  assert.equal(b.pts_mom_1m, 1);
  assert.equal(b.momentum_imputed, true);
});
check("top-of-universe returns earn near-full 12 momentum", () => {
  const peers = [-30, -10, 0, 10, 30].map((x) => ({ overview: { returns_pct: { "1Y": x, "3M": x, "1M": x } } }));
  const universe = buildUniverseStats(peers);
  const hot = mk({}, { returns_pct: { "1Y": 30, "3M": 30, "1M": 30 } });
  const b = computeV4Score(hot, { universe, surveillanceFlag: null }).v4_breakdown;
  assert.ok(b.pts_mom_1y > 5 && b.pts_mom_3m > 2 && b.pts_mom_1m > 1);
  assert.equal(b.momentum_imputed, false);
});
check("universe present + missing 1Y return → that window scores 0, not median (no free 3.5)", () => {
  const peers = [-30, -10, 0, 10, 30].map((x) => ({ overview: { returns_pct: { "1Y": x, "3M": x, "1M": x } } }));
  const universe = buildUniverseStats(peers);
  // Stock has strong 3M/1M but NO 1Y history (e.g. a recent listing).
  const noHist1y = mk({}, { returns_pct: { "3M": 30, "1M": 30 } });
  const b = computeV4Score(noHist1y, { universe, surveillanceFlag: null }).v4_breakdown;
  assert.equal(b.pts_mom_1y, 0);          // was 3.5 under the 0.5 median gift
  assert.ok(b.pts_mom_3m > 2 && b.pts_mom_1m > 1); // windows it DOES have still score
  assert.equal(b.momentum_imputed, true);  // flagged because 1Y is missing
});
check("populated universe + NO returns at all → 0 momentum, not a free 5.5 (anti-phantom-quality lock)", () => {
  // A thinly-traded / no-price-history name against a real universe must earn
  // ZERO momentum, not the 0.5-median 5.5/12 gift. The 0.5 fallback is ONLY for
  // an absent stats file (infra gap), never for a stock that simply has no data.
  const peers = [-30, -10, 0, 10, 30].map((x) => ({ overview: { returns_pct: { "1Y": x, "3M": x, "1M": x } } }));
  const universe = buildUniverseStats(peers);
  const noHist = mk({}, { returns_pct: {} }); // populated universe, empty stock returns
  const b = computeV4Score(noHist, { universe, surveillanceFlag: null }).v4_breakdown;
  assert.equal(b.pts_mom_1y, 0);
  assert.equal(b.pts_mom_3m, 0);
  assert.equal(b.pts_mom_1m, 0);
  assert.equal(b.momentum_imputed, true);
});

console.log("\nvalue-trap brake + falling-knife precedence\n");
check("cheap + 3M bleed + mediocre health → -4 value-trap", () => {
  const s = mk({ financial_health: 2, valuation: 5 }, { returns_pct: { "1M": -10, "3M": -25 } });
  const b = computeV4Score(s, { surveillanceFlag: null }).v4_breakdown;
  assert.equal(b.pts_overlay, -4);
  assert.ok(b.overlay_reasons.some((r) => /Value trap/.test(r)));
});
check("falling-knife fires and SUPPRESSES the value-trap (no double-count)", () => {
  const s = mk({ financial_health: 2, valuation: 5 }, { returns_pct: { "1M": -30, "3M": -25 } });
  const b = computeV4Score(s, { surveillanceFlag: null }).v4_breakdown;
  assert.equal(b.pts_overlay, -5); // falling-knife only, not -9
  assert.ok(b.overlay_reasons.some((r) => /Falling knife/.test(r)));
  assert.ok(!b.overlay_reasons.some((r) => /Value trap/.test(r)));
});
check("no brake when valuation isn't cheap", () => {
  const s = mk({ financial_health: 2, valuation: 2 }, { returns_pct: { "1M": -10, "3M": -25 } });
  assert.equal(computeV4Score(s, { surveillanceFlag: null }).v4_breakdown.pts_overlay, 0);
});

console.log("\nv4.1 growth-trap brake\n");
check("high-future (5+) + 1M <= -15 → -4 growth-trap", () => {
  const s = mk({ financial_health: 5, future: 6, valuation: 3 }, { returns_pct: { "1M": -18, "3M": -8 } });
  const b = computeV4Score(s, { surveillanceFlag: null }).v4_breakdown;
  assert.equal(b.pts_overlay, -4);
  assert.ok(b.overlay_reasons.some((r) => /Growth trap/.test(r)));
  assert.ok(!b.overlay_reasons.some((r) => /Value trap/.test(r))); // distinct reason, won't match shadow A5 /value trap/i
});
check("does NOT fire below the future gate (future 4)", () => {
  const s = mk({ financial_health: 5, future: 4, valuation: 3 }, { returns_pct: { "1M": -18 } });
  assert.equal(computeV4Score(s, { surveillanceFlag: null }).v4_breakdown.pts_overlay, 0);
});
check("does NOT fire above the 1M threshold (-14.9%)", () => {
  const s = mk({ financial_health: 5, future: 6, valuation: 3 }, { returns_pct: { "1M": -14.9 } });
  assert.equal(computeV4Score(s, { surveillanceFlag: null }).v4_breakdown.pts_overlay, 0);
});
check("falling-knife SUPPRESSES growth-trap (no stack with knife)", () => {
  const s = mk({ financial_health: 2, future: 6, valuation: 3 }, { returns_pct: { "1M": -30, "3M": -10 } });
  const b = computeV4Score(s, { surveillanceFlag: null }).v4_breakdown;
  assert.equal(b.pts_overlay, -5); // knife only
  assert.ok(!b.overlay_reasons.some((r) => /Growth trap/.test(r)));
});
check("growth-trap DELIBERATELY stacks with value-trap → -8", () => {
  // cheap (val 5) + high future (6) + 3M<-20 + health<=3 + 1M<=-15, but NOT a knife (health 3 > 2)
  const s = mk({ financial_health: 3, future: 6, valuation: 5 }, { returns_pct: { "1M": -18, "3M": -25 } });
  const b = computeV4Score(s, { surveillanceFlag: null }).v4_breakdown;
  assert.equal(b.pts_overlay, -8);
  assert.ok(b.overlay_reasons.some((r) => /Growth trap/.test(r)));
  assert.ok(b.overlay_reasons.some((r) => /Value trap/.test(r)));
});
check("overlay stays clamped at -15 even with stacked brakes + surveillance", () => {
  const s = mk({ financial_health: 3, future: 6, valuation: 5 }, { returns_pct: { "1M": -18, "3M": -25 } });
  const b = computeV4Score(s, { surveillanceFlag: { list: "GSM" } }).v4_breakdown;
  assert.equal(b.pts_overlay, -15); // -15 GSM -4 -4 → clamped to -15
});

console.log("\nsurveillance overlay parity with V3\n");
check("GSM → -15", () =>
  assert.equal(computeV4Score(mk({}), { surveillanceFlag: { list: "GSM" } }).v4_breakdown.pts_overlay, -15));
check("ASM shortterm → -12", () =>
  assert.equal(computeV4Score(mk({}), { surveillanceFlag: { list: "ASM", timeframe: "shortterm" } }).v4_breakdown.pts_overlay, -12));

console.log("\nscore clamp + component-sum reconciliation\n");
check("score clamps to [0,100]", () => {
  const s = computeV4Score(mk({ financial_health: 6, future: 6, valuation: 6, past: 6 }, { upside_pct: 30 }), { surveillanceFlag: null });
  assert.ok(s.v4_score_100 >= 0 && s.v4_score_100 <= 100);
});
check("breakdown components sum to the score", () => {
  const s = mk({ financial_health: 5, future: 4, valuation: 5, past: 3 }, { upside_pct: 18, returns_pct: { "1Y": 5, "3M": 2, "1M": 1 } });
  const { v4_score_100, v4_breakdown: b } = computeV4Score(s, { surveillanceFlag: null });
  const sum = b.pts_health + b.pts_future + b.pts_valuation + b.pts_past + b.pts_fv_total
    + b.pts_mom_1y + b.pts_mom_3m + b.pts_mom_1m + b.pts_overlay;
  // 0.5 tolerance absorbs per-component decimal rounding while still catching a
  // dropped pillar/FV/momentum term (all >= 3 pts).
  assert.ok(approx(Math.round(sum * 10) / 10, v4_score_100, 0.5));
});

console.log("\nv4_breakdown carries pts_fv_total (V3's pts_fv_upside is gone)\n");
check("v4 has pts_fv_total and NO pts_fv_upside", () => {
  const s = mk({ financial_health: 5, future: 4, valuation: 5, past: 3 }, { upside_pct: 18 });
  const v4b = computeV4Score(s, { surveillanceFlag: null }).v4_breakdown;
  assert.ok("pts_fv_total" in v4b && !("pts_fv_upside" in v4b));
});

console.log("\nverdictV4FromScore — absolute cutoffs (59/47/37/28)\n");
check("≥59 → TOP_PICK",   () => assert.equal(verdictV4FromScore(59), "TOP_PICK"));
check("=47 → STRONG",     () => assert.equal(verdictV4FromScore(47), "STRONG"));
check("=37 → ACCEPTABLE", () => assert.equal(verdictV4FromScore(37), "ACCEPTABLE"));
check("=28 → WATCH",      () => assert.equal(verdictV4FromScore(28), "WATCH"));
check("=27.9 → AVOID",    () => assert.equal(verdictV4FromScore(27.9), "AVOID"));
check("non-finite → null (thin-coverage / no-score path)", () =>
  assert.equal(verdictV4FromScore(NaN), null));
check("verdicts are monotonic across the range", () => {
  const order = ["AVOID", "WATCH", "ACCEPTABLE", "STRONG", "TOP_PICK"];
  const rank = (v) => order.indexOf(v);
  assert.ok(rank(verdictV4FromScore(90)) >= rank(verdictV4FromScore(50)));
  assert.ok(rank(verdictV4FromScore(50)) >= rank(verdictV4FromScore(10)));
});

console.log("\ndrift guard — script re-export === service module\n");
check("computeV4Score via scripts/swsScoringV4.mjs matches services module", () => {
  const s = mk({ financial_health: 5, future: 4, valuation: 5, past: 3 }, { upside_pct: 18, returns_pct: { "1Y": 5, "3M": 2, "1M": 1 } });
  const a = computeV4Score(s, { surveillanceFlag: null });
  const b = computeV4ScoreViaScript(JSON.parse(JSON.stringify(s)), { surveillanceFlag: null });
  assert.equal(a.v4_score_100, b.v4_score_100);
  assert.deepEqual(a.v4_breakdown, b.v4_breakdown);
});

console.log("\nintegration — India scoreStock emits the v4 score + absolute verdict\n");
check("scoreStock sets v4_score_100 + absolute v4_verdict and drops all v3 fields", () => {
  const peers = [-20, 0, 20].map((x) => ({ overview: { returns_pct: { "1Y": x, "3M": x, "1M": x } } }));
  const universe = buildUniverseStats(peers);
  const fixture = () => mk({ financial_health: 5, future: 4, valuation: 5, past: 3 }, { upside_pct: 18, returns_pct: { "1Y": 20, "3M": 5, "1M": 2 } });
  const scored = scoreStockIndia(fixture(), { universe, surveillanceFlag: null });
  assert.ok(Number.isFinite(scored.v4_score_100));
  assert.ok("pts_fv_total" in scored.v4_breakdown);
  // V3 is fully deleted — none of its fields should survive on the scored stock.
  assert.ok(!("v3_score_100" in scored) && !("v3_breakdown" in scored) && !("v3_verdict" in scored));
  // Verdict is absolute now (no bands threaded) — a real label, never null for a finite score.
  assert.equal(scored.v4_verdict, verdictV4FromScore(scored.v4_score_100));
  assert.ok(scored.v4_verdict !== null);
});

check("scoreStock preserves extreme raw SWS FV before V4 FV scoring", () => {
  const fixture = () => mk(
    { financial_health: 5, future: 4, valuation: 5, past: 3 },
    { current_price_inr: 100, fair_value_inr: 1100, upside_pct: 1000 },
  );
  const scored = scoreStockIndia(fixture(), { surveillanceFlag: null });
  const card = pickCardFields(scored);
  assert.equal(card.fair_value_inr, 1100);
  assert.equal(card.upside_pct, 1000);
  assert.equal(card.fv_reconcile_reason, "ok_sws_raw_fv");
  assert.equal(scored.v4_breakdown.fv_imputed, false);
  assert.equal(scored.v4_breakdown.pts_fv_total, 12);
});

check("scoreStock keeps Alembic-like FV before V4 FV scoring", () => {
  const fixture = () => mk(
    { financial_health: 5, future: 5, valuation: 5, past: 2 },
    { current_price_inr: 87.91, fair_value_inr: 724.17623, upside_pct: 723.7700261631214 },
  );
  const scored = scoreStockIndia(fixture(), { surveillanceFlag: null });
  const card = pickCardFields(scored);
  assert.equal(card.fair_value_inr, 724.17623);
  assert.equal(card.upside_pct, 723.8);
  assert.equal(card.fv_reconcile_reason, "ok");
  assert.equal(scored.v4_breakdown.fv_imputed, false);
  assert.equal(scored.v4_breakdown.pts_fv_total, 12);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
