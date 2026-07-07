// SWS V4 SHADOW scoring engine (Tier-3 candidate lab).
// =====================================================
//
// This is a SHADOW scorer. It exists to test candidate scoring changes WITHOUT
// touching the live, frozen `computeV4Score` in swsScoringV4.js. It does this by
// CALLING the live scorer for the baseline and then applying each candidate as a
// transparent, additive delta on top of the live score. Live V4 is therefore
// provably untouched — this module only imports and calls it, never mutates it
// (a test asserts byte-identity of the live output with the shadow module loaded,
// and that the shadow with zero variants selected == live exactly).
//
// Nothing here is wired into the live picks pipeline. It feeds the shadow
// comparison report + the Tier-0 backtest so a human can see, per candidate, how
// verdicts migrate and whether forward alpha improves BEFORE any promotion. A
// promotion to live is a separate, deliberate edit to swsScoringV4.js gated on
// out-of-sample evidence + explicit sign-off.
//
// Candidates implemented (each isolated, opt-in):
//   A4  fv_deinflation      — extend the analyst-range-MAX haircut beyond the
//                             thin-coverage (count<=5) case to any near-max FV.
//   A5  valuetrap_gradient  — replace the binary -4 value-trap brake with a
//                             continuous drawdown x quality penalty.
//   A2  momentum_divergence — penalise conflicting 1Y vs 1M momentum (reversals
//                             the bundled percentile masks).
//   A8  freshness_demotion  — haircut a score whose underlying brief is stale.
//   A1  reweight            — re-tune the four pillar weights (H/F/V/P).
//   A11 dcf_fallback        — use a DCF fair value when no analyst FV exists.
//                             INERT until the parser ingests dcf_fair_value_inr.

import { computeV4Score, verdictV4FromScore } from "./swsScoringV4.js";

// ── local numeric helpers (kept independent of the live module's privates) ──
function num(v, d = null) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function r1(v) { return v == null ? v : Math.round(v * 10) / 10; }

// Live pillar weights — the reweight candidate expresses new weights relative to
// these, and recovers each pillar's 0..1 fraction from the live breakdown pts.
// v4.1 (2026-07): live is now the H↔F swap — MUST track computeV4Score exactly
// or A1 recovers wrong fractions and every shadow report double-applies deltas.
export const LIVE_PILLAR_WEIGHTS = { health: 20, future: 22, valuation: 18, past: 16 };

// Default reweight candidate: IDENTITY (dormant, delta always 0). The previous
// candidate — the pure Health↔Future swap — was PROMOTED to live as v4.1 on
// 2026-07-07 after winning the point-in-time re-rank backtest at both 21d and
// 30d holds (scripts/backtest-pillar-reweight.mjs). Next candidate TBD from
// fresh out-of-sample evidence; do not seed a speculative one.
const DEFAULT_A1_WEIGHTS = { health: 20, future: 22, valuation: 18, past: 16 };

// A8: SWS fundamental briefs update on a quarterly cadence, so a week-old brief
// is not meaningfully stale. Start penalising only past 21 days, ramp gently, cap
// at 6. (The staggered scrape leaves ~half the universe 1–4 weeks old at any time,
// so an aggressive 7-day threshold would nuke half the book — the shadow lab
// surfaced exactly that, hence the more defensible default here.)
const STALE_FRESH_DAYS = 21;
const STALE_MAX_PENALTY = 6;
const STALE_RAMP_DAYS = 21;      // days over which the penalty ramps 0 → 3 before the cap
const VALUETRAP_MAX_PENALTY = 8; // A5: gradient ceiling — set above the binary -4
                                 //     so a SEVERE trap is penalised harder than the
                                 //     step rule, while a mild one is penalised less.

// Each variant: (ctx) -> { delta:Number, reason:String|null }. ctx carries the
// stock, its overview, the LIVE result, and opts (for params + injected clock).
const VARIANTS = {
  // A4 — the live haircut only fires when fv ≈ range.max AND count<=5 (or absent).
  // The shadow extends it to well-covered near-max targets too: many analysts
  // clustering at the top is still an optimistic upper bound, not a mean. Applies
  // the same ~one-bucket magnitude the live thin-coverage haircut uses.
  A4_fv_deinflation({ ov, live }) {
    const bd = live.v4_breakdown || {};
    if (bd.fv_max_inflation_haircut) return { delta: 0, reason: null }; // live already fired
    const range = ov.fair_value_range_inr || {};
    const fv = num(ov.fair_value_inr, null);
    const fvMax = num(range.max, null);
    const cnt = num(range.count, null);
    const nearMax = fv != null && fvMax != null && fvMax > 0 && Math.abs(fv - fvMax) / fvMax <= 0.05;
    if (nearMax && cnt != null && cnt > 5 && num(ov.upside_pct, null) != null) {
      return { delta: -2.0, reason: `FV≈range max with ${cnt} analysts — de-rated as optimistic consensus` };
    }
    return { delta: 0, reason: null };
  },

  // A5 — replace the binary value-trap brake with a gradient. We add back the
  // live binary penalty (if it fired) and subtract a continuous one, so the net
  // effect is "gradient instead of step". Gradient scales with drawdown depth and
  // low health, only for cheap (valuation>=4) names — the trap the value tilt rewards.
  A5_valuetrap_gradient({ ov, live }) {
    const snow = ov.snowflake || {};
    const vHealth = num(snow.financial_health ?? snow.health, 0);
    const vVal = num(snow.valuation ?? snow.value, 0);
    const ret3m = num((ov.returns_pct || {})["3M"], null);
    if (vVal < 4 || ret3m == null || ret3m >= -10) return { delta: 0, reason: null };
    // drawdown factor: 0 at -10%, 1 at -35%+.
    const dd = clamp((-ret3m - 10) / 25, 0, 1);
    // quality factor: 0 at health 4, 1 at health <=1.
    const q = clamp((4 - vHealth) / 3, 0, 1);
    const gradient = dd * q * VALUETRAP_MAX_PENALTY;
    const liveApplied = (live.v4_breakdown?.overlay_reasons || []).some((r) => /value trap/i.test(r)) ? 4 : 0;
    const delta = r1(liveApplied - gradient); // add back binary, subtract gradient
    if (delta === 0) return { delta: 0, reason: null };
    return { delta, reason: `Value-trap gradient (dd ${(-ret3m).toFixed(0)}% × health ${vHealth}/6) → ${(-gradient).toFixed(1)}, replacing binary ${liveApplied ? "-4" : "0"}` };
  },

  // A2 — 1Y and 1M momentum pulling opposite ways is a reversal the bundled
  // percentile hides. Penalise a material sign conflict.
  A2_momentum_divergence({ ov }) {
    const r = ov.returns_pct || {};
    const y = num(r["1Y"], null), m = num(r["1M"], null);
    if (y == null || m == null) return { delta: 0, reason: null };
    const conflict = (y > 10 && m < -5) || (y < -10 && m > 5);
    if (conflict) return { delta: -2.0, reason: `Momentum divergence: 1Y ${y.toFixed(0)}% vs 1M ${m.toFixed(0)}%` };
    return { delta: 0, reason: null };
  },

  // A8 — the live scorer ignores brief age. Haircut a score whose brief is stale,
  // graduated past STALE_FRESH_DAYS. Uses opts.now for testability; inert when no
  // freshness timestamp is present on the stock.
  A8_freshness_demotion({ stock, ov, opts }) {
    const nowMs = Number.isFinite(opts?.now) ? opts.now : (opts?.now ? Date.parse(opts.now) : null);
    if (nowMs == null) return { delta: 0, reason: null };
    const stampStr = stock.parsed_at || stock.data_freshness_at || ov.last_updated || ov.as_of || null;
    const stampMs = stampStr ? Date.parse(stampStr) : NaN;
    if (!Number.isFinite(stampMs)) return { delta: 0, reason: null };
    const ageDays = (nowMs - stampMs) / 86400000;
    if (ageDays <= STALE_FRESH_DAYS) return { delta: 0, reason: null };
    const pen = clamp(((ageDays - STALE_FRESH_DAYS) / STALE_RAMP_DAYS) * 3, 0, STALE_MAX_PENALTY);
    return { delta: r1(-pen), reason: `Stale brief: ${ageDays.toFixed(0)}d old → ${(-pen).toFixed(1)}` };
  },

  // A1 — re-tune the four pillar weights. Recovers each pillar's 0..1 fraction
  // from the live breakdown pts and re-scales to the candidate weights.
  A1_reweight({ live, opts }) {
    const bd = live.v4_breakdown || {};
    const w = { ...DEFAULT_A1_WEIGHTS, ...(opts?.a1Weights || {}) };
    let delta = 0;
    for (const [k, oldW] of Object.entries(LIVE_PILLAR_WEIGHTS)) {
      const pts = num(bd[`pts_${k}`], 0);
      const frac = oldW > 0 ? pts / oldW : 0; // 0..1
      delta += frac * (w[k] - oldW);
    }
    delta = r1(delta);
    if (delta === 0) return { delta: 0, reason: null };
    return { delta, reason: `Reweight H/F/V/P ${w.health}/${w.future}/${w.valuation}/${w.past}` };
  },

  // A11 — DCF fair-value fallback. INERT: the parser does not yet ingest a DCF
  // fair value (dcf_fair_value_inr), so there is nothing to fall back to. Wired
  // here so the promotion path is a one-field change once ingestion lands.
  A11_dcf_fallback({ ov, live }) {
    const dcf = num(ov.dcf_fair_value_inr, null);
    if (dcf == null) return { delta: 0, reason: "DCF fair value not ingested (inert)" };
    if (!live.v4_breakdown?.fv_imputed) return { delta: 0, reason: null }; // analyst FV already present
    // If/when DCF exists: score its upside like the analyst upside would have.
    const px = num(ov.current_price_inr, null);
    if (px == null || px <= 0) return { delta: 0, reason: null };
    const dcfUpside = ((dcf - px) / px) * 100;
    const frac = dcfUpside >= 30 ? 1 : dcfUpside >= 15 ? 0.75 : dcfUpside >= 0 ? 0.5 : dcfUpside >= -10 ? 0.25 : 0;
    const dcfPts = 12 * frac;            // full-block, matching renorm-to-12 when only one sub
    const imputedPts = num(live.v4_breakdown?.pts_fv_total, 6); // what the neutral impute gave
    return { delta: r1(dcfPts - imputedPts), reason: `DCF fallback: ${dcfUpside.toFixed(0)}% upside → ${dcfPts.toFixed(1)} vs imputed ${imputedPts}` };
  },
};

export const SHADOW_VARIANT_KEYS = Object.keys(VARIANTS);

// Compute the shadow score for a stock under a chosen set of variants.
// `selected` defaults to ALL variants (the full candidate engine). Pass a single
// key (as [key]) to isolate one candidate's effect.
export function computeV4ShadowScore(stock, opts = {}, selected = SHADOW_VARIANT_KEYS) {
  const live = computeV4Score(stock, opts); // <-- live, unmodified
  const ov = stock.overview || {};
  const ctx = { stock, ov, live, opts };
  const applied = [];
  let delta = 0;
  for (const key of selected) {
    const fn = VARIANTS[key];
    if (!fn) continue;
    const res = fn(ctx) || { delta: 0 };
    if (Number.isFinite(res.delta) && res.delta !== 0) {
      delta += res.delta;
      applied.push({ key, delta: r1(res.delta), reason: res.reason || null });
    }
  }
  const liveScore = live.v4_score_100;
  const shadowScore = clamp(r1(liveScore + delta), 0, 100);
  return {
    live_score: liveScore,
    live_verdict: verdictV4FromScore(liveScore),
    shadow_score: shadowScore,
    shadow_verdict: verdictV4FromScore(shadowScore),
    delta: r1(delta),
    verdict_changed: verdictV4FromScore(liveScore) !== verdictV4FromScore(shadowScore),
    applied,
    v4_breakdown: live.v4_breakdown, // the LIVE breakdown, untouched
  };
}

// Per-variant isolated scores — one entry per variant, each applied alone, so a
// report can attribute the effect of each candidate independently.
export function computeShadowVariantMatrix(stock, opts = {}) {
  const out = {};
  for (const key of SHADOW_VARIANT_KEYS) {
    out[key] = computeV4ShadowScore(stock, opts, [key]);
  }
  out.__combined = computeV4ShadowScore(stock, opts, SHADOW_VARIANT_KEYS);
  return out;
}
