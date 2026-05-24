// V4 stock score — isolated, quality-value reweight of v3_score_100.
//
// This module is ADDITIVE and never mutates V3. It is the single canonical
// source of the V4 math; scripts/swsScoringV4.mjs re-exports it so the 4
// scoring scripts (India/US/KR/TW) and the server stay numerically identical.
//
// What changed vs V3 (services/swsScoring.js::computeV3Score):
//   - Dividend pillar removed (0); Valuation 12->18; Past 12->16. Pillar block
//     76 (was 74). A deliberate quality-value tilt: cheap AND proven-track-record.
//   - FV block (12) is now a COVERAGE-RENORMALISED composite of whatever value
//     sub-signals are present (capped analyst-upside + relative P/E), instead of
//     a single bucketed upside imputed to neutral. See _fvCompositeV4.
//   - Momentum 14->12 (1Y x7 + 3M x3 + 1M x2).
//   - Risk overlay = V3's verbatim + a V4-only value-trap brake (the heavier
//     value tilt needs a wider net than V3's narrow falling-knife).
//   - Verdict is RANK-BASED off the V4 universe distribution (percentile bands),
//     not the absolute 60/45/30/22 cutoffs. computeV4Score does NOT assign a
//     verdict (needs the distribution); the scorer assigns it two-pass via
//     buildV4VerdictBands + verdictV4FromScore.
//
// v4_breakdown uses field names DISTINCT from the now-deleted v3_breakdown
// (pts_fv_total not pts_fv_upside, fv_*_sub, fv_max_inflation_haircut, …) so
// the V3→V4 field rename was unambiguous across every downstream consumer.

// Self-contained primitives (duplicated from swsScoring.js's exports) so this
// module has NO import dependency on swsScoring.js — avoids a circular import
// now that swsScoring.js::scoreStock imports computeV4Score from here. The
// fvUpsideRelative import below is PURE (no imports of its own) — no cycle.
import { relativeFvPoints } from "./scoring/fvUpsideRelative.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
function _percentileRank(value, sorted) {
  if (value == null || !Number.isFinite(value) || !sorted?.length) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] < value) lo = mid + 1; else hi = mid; }
  return lo / sorted.length;
}

// Surveillance loader (infrastructure, not scoring math) — matches V3's overlay
// when opts.surveillanceFlag isn't supplied.
let _getSurveillanceFlag = () => null;
try {
  const mod = await import("../surveillance.js");
  if (typeof mod.getSurveillanceFlag === "function") _getSurveillanceFlag = mod.getSurveillanceFlag;
} catch {}

export const V4_SCORING_VERSION = "sws-v4-100pt-2026-05";

// FV composite (max 12). Renormalised weighted average of the value sub-signals
// that are actually present — an absent sub is DROPPED (excluded from both the
// numerator and the weight denominator), never imputed to neutral. This fixes
// two failure modes at once: a sub with thin coverage (relative-P/E, ~9% of the
// universe) can't compress the block to a constant for everyone, and a small-cap
// missing analyst upside isn't docked for data it simply lacks. Both subs
// absent -> neutral 6/12.
export function _fvCompositeV4(ov, fvBenchmark = null) {
  ov = ov || {};
  const subs = []; // { key, weight, fraction in [0,1] }
  let fv_max_inflation_haircut = false;
  let fv_benchmark_used = false;
  let fv_upside_relative_pts = null;
  let fv_upside_rz = null;

  // --- Analyst-upside sub (weight 8) ---
  // Relative, magnitude-aware upside (adopts PR #426): score the upside against
  // the universe benchmark (median/MAD of signed-log upside, micro-caps
  // excluded) so +150% still beats +35% instead of both pinning the old
  // absolute band's ceiling. Falls back to the legacy absolute band when no
  // benchmark is supplied (single-stock on-demand before it is built).
  const upside = num(ov.upside_pct, null);
  if (upside != null) {
    let frac;
    if (fvBenchmark && !fvBenchmark.degenerate && fvBenchmark.robust_sigma > 0) {
      const rel = relativeFvPoints(upside, fvBenchmark, { maxPts: 12 });
      frac = rel.pts / 12;
      fv_benchmark_used = true;
      fv_upside_relative_pts = rel.pts;
      fv_upside_rz = rel.rz;
    } else {
      if (upside >= 30) frac = 1.0;
      else if (upside >= 15) frac = 0.75;
      else if (upside >= 0) frac = 0.5;
      else if (upside >= -10) frac = 0.25;
      else frac = 0;
      fv_upside_relative_pts = 12 * frac;
    }
    // MAX-inflation guard: if the "consensus" FV is really the analyst-range
    // MAX with few analysts, the upside is likely one outlier target rather
    // than a true consensus — haircut one bucket (0.25).
    const range = ov.fair_value_range_inr || {};
    const fv = num(ov.fair_value_inr, null);
    const fvMax = num(range.max, null);
    const cnt = num(range.count, null);
    if (fv != null && fvMax != null && fvMax > 0 && cnt != null && cnt <= 5
        && Math.abs(fv - fvMax) / fvMax <= 0.05) {
      frac = Math.max(0, frac - 0.25);
      fv_max_inflation_haircut = true;
    }
    subs.push({ key: "upside", weight: 8, fraction: frac });
  }

  // --- Relative-P/E sub (weight 4) — cheap vs industry benchmark ---
  const pe = num(ov.multiples?.pe, null);
  const indPe = num(ov.industry_benchmarks?.pe, null);
  const peSource = ov.pe_benchmark_source || ov.industry_benchmarks_meta || ov.multiples_meta || null;
  let fv_pe_ratio = null;
  let fv_pe_bucket = null;
  if (pe != null && pe > 0 && indPe != null && indPe > 0) {
    const ratio = pe / indPe;
    let frac;
    if (ratio <= 0.8) {
      frac = 1.0;      // meaningfully cheaper than industry
      fv_pe_bucket = "cheap";
    } else if (ratio <= 1.2) {
      frac = 0.5; // in-line
      fv_pe_bucket = "inline";
    } else {
      frac = 0;                     // expensive
      fv_pe_bucket = "expensive";
    }
    fv_pe_ratio = ratio;
    subs.push({ key: "pe", weight: 4, fraction: frac });
  }

  let pts_fv_total, fv_imputed;
  let pts_fv_upside_effective = null;
  let pts_fv_pe_effective = null;
  if (subs.length === 0) {
    pts_fv_total = 6; // no value signal at all -> neutral
    fv_imputed = true;
  } else {
    const wsum = subs.reduce((a, s) => a + s.weight, 0);
    const fsum = subs.reduce((a, s) => a + s.weight * s.fraction, 0);
    pts_fv_total = 12 * (fsum / wsum);
    const upsideSub = subs.find((s) => s.key === "upside");
    const peSub = subs.find((s) => s.key === "pe");
    if (upsideSub) pts_fv_upside_effective = 12 * ((upsideSub.weight * upsideSub.fraction) / wsum);
    if (peSub) pts_fv_pe_effective = 12 * ((peSub.weight * peSub.fraction) / wsum);
    fv_imputed = false;
  }

  const r1 = (v) => v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
  const r3 = (v) => v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;

  return {
    pts_fv_total: r1(pts_fv_total),
    fv_imputed,
    fv_max_inflation_haircut,
    fv_subsignals_present: subs.length,
    fv_benchmark_used,
    pts_fv_upside_effective: r1(pts_fv_upside_effective),
    pts_fv_pe_effective: r1(pts_fv_pe_effective),
    fv_upside_relative_pts: r1(fv_upside_relative_pts),
    fv_upside_rz: r3(fv_upside_rz),
    fv_pe_ratio: r3(fv_pe_ratio),
    fv_pe_bucket,
    fv_pe_source: peSource?.provider || peSource?.pe_source || null,
    fv_pe_source_label: peSource?.label || peSource?.pe_source_label || null,
    fv_pe_industry_name: peSource?.industry_name || peSource?.pe_industry_name || null,
    fv_pe_company_pe: r3(pe),
    fv_pe_industry_pe: r3(indPe),
    fv_pe_fetched_at: peSource?.fetched_at || peSource?.pe_as_of || null,
    fv_pe_source_url: peSource?.url || peSource?.pe_source_url || null,
  };
}

export function computeV4Score(stock, opts = {}) {
  const ov = stock.overview || {};
  const snow = ov.snowflake || {};
  const universe = opts.universe || null;
  const surveillance = opts.surveillanceFlag ?? _getSurveillanceFlag(stock.ticker);

  const v_health = num(snow.financial_health ?? snow.health, 0);
  const v_future = num(snow.future ?? snow.future_growth, 0);
  const v_valuation = num(snow.valuation ?? snow.value, 0);
  const v_past = num(snow.past ?? snow.past_performance, 0);
  // Dividend pillar intentionally dropped in V4.
  const pts_health = (v_health / 6) * 22;
  const pts_future = (v_future / 6) * 20;
  const pts_valuation = (v_valuation / 6) * 18;
  const pts_past = (v_past / 6) * 16;

  const fvBenchmark = opts.fvBenchmark || universe?.fvBenchmark || null;
  const fv = _fvCompositeV4(ov, fvBenchmark);
  const pts_fv_total = fv.pts_fv_total;

  const r = ov.returns_pct || {};
  const ret1y = num(r["1Y"], null);
  const ret3m = num(r["3M"], null);
  const ret1m = num(r["1M"], null);
  const pct1y = universe ? _percentileRank(ret1y, universe.r1y) : null;
  const pct3m = universe ? _percentileRank(ret3m, universe.r3m) : null;
  const pct1m = universe ? _percentileRank(ret1m, universe.r1m) : null;
  const pts_mom_1y = (pct1y ?? 0.5) * 7;
  const pts_mom_3m = (pct3m ?? 0.5) * 3;
  const pts_mom_1m = (pct1m ?? 0.5) * 2;
  const momentum_imputed = !universe || pct1y == null || pct3m == null || pct1m == null;

  const continuous = pts_health + pts_future + pts_valuation + pts_past
    + pts_fv_total + pts_mom_1y + pts_mom_3m + pts_mom_1m;

  let pts_overlay = 0;
  const overlay_reasons = [];
  if (surveillance) {
    if (surveillance.list === "GSM") {
      pts_overlay -= 15;
      overlay_reasons.push("GSM surveillance");
    } else if (surveillance.list === "ASM") {
      const drop = surveillance.timeframe === "shortterm" ? 12 : 10;
      pts_overlay -= drop;
      overlay_reasons.push(`ASM surveillance (${surveillance.timeframe || "longterm"})`);
    }
  }
  let fellAsKnife = false;
  if (ret1m != null && ret1m < -25 && v_health <= 2) {
    pts_overlay -= 5;
    fellAsKnife = true;
    overlay_reasons.push(`Falling knife: 1M ${ret1m.toFixed(1)}% with health ${v_health}/6`);
  }
  if (ret1m != null && ret1m > 30 && v_valuation <= 2) {
    pts_overlay -= 3;
    overlay_reasons.push(`Catalyst chase: 1M +${ret1m.toFixed(1)}% with valuation ${v_valuation}/6`);
  }
  // V4-only value-trap brake: a cheap (valuation>=4) name bleeding over 3M with
  // mediocre health is the classic trap the heavier value tilt would otherwise
  // reward. Skipped when the falling-knife already fired, so the two don't stack.
  if (!fellAsKnife && ret3m != null && ret3m < -20 && v_health <= 3 && v_valuation >= 4) {
    pts_overlay -= 4;
    overlay_reasons.push(`Value trap: 3M ${ret3m.toFixed(1)}% on cheap (${v_valuation}/6) name with health ${v_health}/6`);
  }
  pts_overlay = clamp(pts_overlay, -15, 0);

  const v4_score_100 = clamp(Math.round((continuous + pts_overlay) * 10) / 10, 0, 100);

  return {
    v4_score_100,
    v4_breakdown: {
      pts_health: Math.round(pts_health * 10) / 10,
      pts_future: Math.round(pts_future * 10) / 10,
      pts_valuation: Math.round(pts_valuation * 10) / 10,
      pts_past: Math.round(pts_past * 10) / 10,
      pts_fv_total,
      fv_imputed: fv.fv_imputed,
      fv_max_inflation_haircut: fv.fv_max_inflation_haircut,
      fv_subsignals_present: fv.fv_subsignals_present,
      fv_benchmark_used: fv.fv_benchmark_used,
      pts_fv_upside_effective: fv.pts_fv_upside_effective,
      pts_fv_pe_effective: fv.pts_fv_pe_effective,
      fv_upside_relative_pts: fv.fv_upside_relative_pts,
      fv_upside_rz: fv.fv_upside_rz,
      fv_pe_ratio: fv.fv_pe_ratio,
      fv_pe_bucket: fv.fv_pe_bucket,
      fv_pe_source: fv.fv_pe_source,
      fv_pe_source_label: fv.fv_pe_source_label,
      fv_pe_industry_name: fv.fv_pe_industry_name,
      fv_pe_company_pe: fv.fv_pe_company_pe,
      fv_pe_industry_pe: fv.fv_pe_industry_pe,
      fv_pe_fetched_at: fv.fv_pe_fetched_at,
      fv_pe_source_url: fv.fv_pe_source_url,
      pts_mom_1y: Math.round(pts_mom_1y * 10) / 10,
      pts_mom_3m: Math.round(pts_mom_3m * 10) / 10,
      pts_mom_1m: Math.round(pts_mom_1m * 10) / 10,
      momentum_imputed,
      pts_overlay,
      overlay_reasons,
      surveillance: surveillance ? { list: surveillance.list, timeframe: surveillance.timeframe } : null,
    },
  };
}

// V4 verdict — ABSOLUTE cutoffs, frozen from the V4 universe distribution (the
// India-universe percentile cutoffs as of the 2026-05 V3→V4 migration:
// top-pick≈92nd pct, strong≈75th, acceptable≈50th, watch≈25th). Deliberately
// absolute, NOT rank-based: every scoring path — batch scorers, server
// on-demand, the real-money holding engine, categoriseStock — resolves a verdict
// with NO universe bands threaded in. (A rank-based verdict returned null on the
// paths that never loaded bands, silently collapsing the action ladder.) This
// mirrors how V3's verdictV3FromScore worked and how every downstream engine
// (action ladder, categories, calibration) consumes the verdict.
export function verdictV4FromScore(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 59) return "TOP_PICK";
  if (score >= 47) return "STRONG";
  if (score >= 37) return "ACCEPTABLE";
  if (score >= 28) return "WATCH";
  return "AVOID";
}
