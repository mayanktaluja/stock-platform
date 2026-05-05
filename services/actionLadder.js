// Action ladder utilities for the SWS recommendation engine.
//
// Two coexisting label sets:
//   • LEGACY (always-on): EXIT · Reduction-50% · Reduction-25-33% · HOLD ·
//     Top-up-modest · Top-up · STRONG Top-up.
//   • LADDER_V2 (gated by SWS_LADDER_V2=1): EXIT-now · EXIT-staged ·
//     Reduction-66% · Reduction-50% · Reduction-33% · Reduction-25% · HOLD ·
//     Top-up-25% · Top-up-33% · Top-up-50% · Top-up-100%.
//
// Why both: downstream consumers (swsPortfolioAggregate, swsConvictionEngine,
// app.js color map, swsCoverageFallback) all read the action string literally.
// LADDER_V2 is additive — any v2 label round-trips to a legacy equivalent via
// `ladderToLegacy()` so existing readers keep working when v2 is on.
//
// All thresholds are calibrated against the v3 universe distribution
// (p25≈21, p50≈29, p75≈39, p95≈59). The factor stack — v3 score, position
// weight, sector weight, conviction proxy, NSE ASM/GSM surveillance, risks
// count — is the same set the v2 conviction engine reads.
//
// Pure functions: no I/O, no side effects, deterministic given inputs.

export const LEGACY_REDUCTION_ACTIONS = new Set([
  "EXIT",
  "Reduction-50%",
  "Reduction-25-33%",
]);

export const LEGACY_TOPUP_ACTIONS = new Set([
  "Top-up-modest",
  "Top-up",
  "STRONG Top-up",
]);

export const LADDER_V2_REDUCTION_ACTIONS = new Set([
  "EXIT-now",
  "EXIT-staged",
  "Reduction-66%",
  "Reduction-50%",
  "Reduction-33%",
  "Reduction-25%",
]);

export const LADDER_V2_TOPUP_ACTIONS = new Set([
  "Top-up-25%",
  "Top-up-33%",
  "Top-up-50%",
  "Top-up-100%",
]);

export const ALL_REDUCTION_ACTIONS = new Set([
  ...LEGACY_REDUCTION_ACTIONS,
  ...LADDER_V2_REDUCTION_ACTIONS,
]);

export const ALL_TOPUP_ACTIONS = new Set([
  ...LEGACY_TOPUP_ACTIONS,
  ...LADDER_V2_TOPUP_ACTIONS,
]);

// Trim fraction by action label. Drives _computeFreedCash in
// swsPortfolioAggregate so any new rung automatically influences fresh-capital
// math without a separate switch statement per rung.
//
// EXIT-staged is modeled as 0.5 because the user sells half today; the
// remaining 0.5 is a follow-on contingent on a confirmation break (T+5).
// Aggregate-level cash math freezes on what's actually realised today.
const TRIM_PCT_BY_ACTION = {
  "EXIT": 1.0,
  "EXIT-now": 1.0,
  "EXIT-staged": 0.5,
  "Reduction-66%": 0.66,
  "Reduction-50%": 0.50,
  "Reduction-33%": 0.33,
  "Reduction-25%": 0.25,
  "Reduction-25-33%": 0.30,
};

const TOPUP_PCT_OF_IDEAL_BY_ACTION = {
  "STRONG Top-up": 1.0,
  "Top-up-100%": 1.0,
  "Top-up": 0.5,
  "Top-up-50%": 0.5,
  "Top-up-33%": 0.33,
  "Top-up-modest": 0.25,
  "Top-up-25%": 0.25,
};

const LADDER_TO_LEGACY = {
  "EXIT-now": "EXIT",
  "EXIT-staged": "EXIT",
  "Reduction-66%": "Reduction-50%",
  "Reduction-50%": "Reduction-50%",
  "Reduction-33%": "Reduction-25-33%",
  "Reduction-25%": "Reduction-25-33%",
  "HOLD": "HOLD",
  "Top-up-25%": "Top-up-modest",
  "Top-up-33%": "Top-up-modest",
  "Top-up-50%": "Top-up",
  "Top-up-100%": "STRONG Top-up",
};

export function isLadderV2Enabled() {
  return process.env.SWS_LADDER_V2 !== "0";
}

/**
 * SWS_LADDER_V3 — continuous-severity rung picker.
 *
 * V2 was a categorical matrix that defaulted to Reduction-33% whenever no
 * specific factor combination matched. For typical retail books (most
 * positions at 2–4% weight) this produced a structural pile-up at 33% —
 * "every stock is trimmed by 33%" reads as engine bias, not as a per-stock
 * recommendation. V3 replaces the matrix with a continuous severity score
 * (0..1) computed from the same factor stack, then rounds to the nearest
 * available rung. Every input combination maps to a specific rung; no
 * default fallback. Flag is independent of V2 — V3 takes precedence when
 * both are on.
 */
export function isLadderV3Enabled() {
  return process.env.SWS_LADDER_V3 !== "0";
}

// ════════════════════════════════════════════════════════════════════════
// V3 CONTINUOUS SEVERITY MODEL
// ════════════════════════════════════════════════════════════════════════
//
// computeTrimSeverity returns a number in [0, 1] derived deterministically
// from the holding's factor stack. The components below are calibrated so
// a typical retail book of 30–50 holdings produces a real spread across
// every rung (25 / 33 / 50 / 66 / EXIT-staged / EXIT-now), not a 33%
// pile-up.
//
// Component weights sum to 1.0:
//
//   Weakness          0.30  | (50 − v3) / 50, clamped 0..1.   v3=15 → 0.70
//   Concentration     0.20  | position_weight / 20.            pw=4% → 0.20
//   Sector overweight 0.10  | sector_weight / 35.              sw=18% → 0.51
//   Conviction       0.15  | LOW=1.0..HIGH=0.0                LOW → 1.00
//   Drawdown depth   0.10  | -pnl / 50, clamped 0..1.          pnl=-32 → 0.64
//   Surveillance     0.10  | GSM=0.30+0.05·stage, ASM=0.10+0.05·stage
//   Risk flags       0.05  | risks_count / 5.                  rc=2 → 0.40
//
// Calibration anchors:
//   • Healthy stock (v3=80, pw=2%, sw=10%, MEDIUM-HIGH, pnl=+10, no surv, 0 risks)
//     → severity ≈ 0.05 → null (no trim) — pass to top-up logic.
//   • Mild WATCH (v3=20, pw=4%, sw=15%, MEDIUM, pnl=-10, no surv, 0 risks)
//     → severity ≈ 0.32 → Reduction-33%.
//   • Concentrated weak name (v3=18, pw=18%, sw=15%, LOW, pnl=-25, no surv, 1 risk)
//     → severity ≈ 0.65 → Reduction-66%.
//   • Broken thesis (v3=10, pw=4%, sw=12%, LOW, pnl=-45, no surv, 2 risks)
//     → severity ≈ 0.79 → EXIT-staged.
//   • GSM-3 surveillance overrides everything → EXIT-now (hard override below).
//
// All thresholds are pure functions of inputs — same inputs ⇒ same severity ⇒
// same rung. SEBI-defensible audit trail: every component contribution is
// emitted as a rationale string.

const TRIM_SEVERITY_WEIGHTS = {
  weakness: 0.30,
  concentration: 0.20,
  sectorOverweight: 0.10,
  conviction: 0.15,
  drawdown: 0.10,
  surveillance: 0.10,
  risks: 0.05,
};

const TOPUP_SEVERITY_WEIGHTS = {
  strength: 0.35,
  positionRoom: 0.20,
  sectorRoom: 0.15,
  upside: 0.20,
  cleanRisk: 0.10,
};

const CONVICTION_PENALTY = {
  LOW: 1.00,
  "MEDIUM-LOW": 0.75,
  MEDIUM: 0.50,
  "MEDIUM-HIGH": 0.25,
  HIGH: 0.00,
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Compute the trim severity score (0..1) for a holding. Returns:
 *   { severity, components, rationale }
 * where components is the per-factor breakdown (already weight-multiplied
 * and ready to display) and rationale is an array of strings describing
 * each contribution in plain English.
 */
export function computeTrimSeverity({
  v3,
  position_weight,
  sector_weight,
  conviction,
  surveillance,
  pnlPercent,
  risks_count,
}) {
  const v3n = Number.isFinite(v3) ? v3 : 50;
  const pw = Number.isFinite(position_weight) ? position_weight : 0;
  const sw = Number.isFinite(sector_weight) ? sector_weight : 0;
  const pnl = Number.isFinite(pnlPercent) ? pnlPercent : 0;
  const rc = Number.isFinite(risks_count) ? risks_count : 0;
  const survList = surveillance?.list || null;
  const survStage = Number(surveillance?.stage) || 0;

  const weaknessRaw = clamp01((50 - v3n) / 50);
  const concentrationRaw = clamp01(pw / 20);
  const sectorOverweightRaw = clamp01(sw / 35);
  const convictionRaw = CONVICTION_PENALTY[conviction] ?? 0.5;
  const drawdownRaw = clamp01(-pnl / 50);
  let surveillanceRaw = 0;
  if (survList === "GSM") surveillanceRaw = clamp01(0.30 + 0.05 * (survStage || 1));
  else if (survList === "ASM") surveillanceRaw = clamp01(0.10 + 0.05 * (survStage || 1));
  const risksRaw = clamp01(rc / 5);

  const components = {
    weakness:          weaknessRaw          * TRIM_SEVERITY_WEIGHTS.weakness,
    concentration:     concentrationRaw     * TRIM_SEVERITY_WEIGHTS.concentration,
    sectorOverweight:  sectorOverweightRaw  * TRIM_SEVERITY_WEIGHTS.sectorOverweight,
    conviction:        convictionRaw        * TRIM_SEVERITY_WEIGHTS.conviction,
    drawdown:          drawdownRaw          * TRIM_SEVERITY_WEIGHTS.drawdown,
    surveillance:      surveillanceRaw      * TRIM_SEVERITY_WEIGHTS.surveillance,
    risks:             risksRaw             * TRIM_SEVERITY_WEIGHTS.risks,
  };
  let severity = clamp01(
    components.weakness + components.concentration + components.sectorOverweight +
    components.conviction + components.drawdown + components.surveillance + components.risks
  );
  // Hard floors aligned with SWS v3 universe distribution: v3<8 is bottom-
  // tier (engine emits EXIT regardless of factors); v3<14 is the "WATCH" band
  // floor below which the model promises a staged-exit minimum. These match
  // the V2 categorical guarantees so the upgrade preserves SEBI-aligned
  // safety floors while gaining per-stock specificity above the floor.
  if (v3n < 8) severity = Math.max(severity, 0.90);
  else if (v3n < 14) severity = Math.max(severity, 0.75);

  // SEBI-aligned concentration escalators — single-stock weight above
  // these thresholds is a hard regulatory observation independent of the
  // thesis. A position at 30% of book is a risk-management problem even
  // for a high-conviction TOP_PICK. Escalators ensure the rung never
  // under-states the concentration risk, while staying below EXIT (a
  // concentrated WINNER trims for portfolio safety, doesn't exit).
  if (pw > 30) severity = Math.max(severity, 0.60);   // Reduction-66% min
  else if (pw > 25) severity = Math.max(severity, 0.55); // Reduction-50% min
  else if (pw > 20) severity = Math.max(severity, 0.45); // Reduction-50% min
  else if (pw > 15) severity = Math.max(severity, 0.30); // Reduction-33% min

  const pp = (n) => `${(n * 100).toFixed(0)}pp`;
  const rationale = [
    `v3 ${v3n.toFixed(0)}/100 → +${pp(components.weakness)} weakness signal`,
    `Position ${pw.toFixed(1)}% of book → +${pp(components.concentration)} concentration`,
    `Sector ${sw.toFixed(1)}% of book → +${pp(components.sectorOverweight)} sector overweight`,
    `Conviction ${conviction || "MEDIUM"} → +${pp(components.conviction)}`,
    `Drawdown ${pnl.toFixed(1)}% → +${pp(components.drawdown)}`,
    survList ? `${survList}${survStage ? "-" + survStage : ""} surveillance → +${pp(components.surveillance)}` : "No NSE surveillance → +0pp",
    `${rc} risk flag${rc === 1 ? "" : "s"} → +${pp(components.risks)}`,
    `Total severity ${pp(severity)} → maps to ${severityToTrimRung(severity, { gsmStage3Plus: survList === "GSM" && survStage >= 3 }) || "no trim (HOLD or top-up)"}`,
  ];

  return { severity, components, rationale };
}

/**
 * Map a severity score to a specific trim rung. GSM stage 3+ is a hard
 * regulatory override → EXIT-now regardless of score (matches V2 behaviour).
 * Bottom-tier v3 (handled at caller level) also maps to EXIT-now.
 */
export function severityToTrimRung(severity, { gsmStage3Plus = false } = {}) {
  if (gsmStage3Plus) return "EXIT-now";
  if (!Number.isFinite(severity) || severity < 0.15) return null;
  if (severity >= 0.90) return "EXIT-now";
  if (severity >= 0.75) return "EXIT-staged";
  if (severity >= 0.60) return "Reduction-66%";
  if (severity >= 0.45) return "Reduction-50%";
  if (severity >= 0.30) return "Reduction-33%";
  return "Reduction-25%";
}

/**
 * Compute the top-up severity score for a holding. Symmetric to the trim
 * model — produces a continuous value in [0, 1] that maps to a specific
 * top-up rung. Healthy + room + upside + clean risks → larger rung.
 */
export function computeTopUpSeverity({
  v3,
  position_weight,
  sector_weight,
  upside,
  risks_count,
}) {
  const v3n = Number.isFinite(v3) ? v3 : 50;
  const pw = Number.isFinite(position_weight) ? position_weight : 0;
  const sw = Number.isFinite(sector_weight) ? sector_weight : 0;
  const up = Number.isFinite(upside) ? upside : 0;
  const rc = Number.isFinite(risks_count) ? risks_count : 0;

  // v3 strength: 50 baseline, every point above adds proportionally; below
  // 50 = 0 (handled by caller's trim path). Tighter scaling than (v3-50)/50
  // so a TOP_PICK at v3=75 → 0.83 strength × 0.35 weight = 0.29 contribution,
  // making it possible to clear the 0.70 threshold for Top-up-100% when the
  // rest of the factor stack is clean.
  const strengthRaw = clamp01((v3n - 50) / 30);
  // Available position room: pw=0 → full room (1.0), pw=8% → no room (0).
  const positionRoomRaw = clamp01((8 - pw) / 8);
  const sectorRoomRaw = clamp01((25 - sw) / 25);
  // Upside: 5% → 0.0, 30% → 1.0, linear in between.
  const upsideRaw = clamp01((up - 5) / 25);
  // Clean-risk: 0 risks → 1.0, 5+ risks → 0.0.
  const cleanRiskRaw = clamp01((5 - rc) / 5);

  const components = {
    strength:     strengthRaw     * TOPUP_SEVERITY_WEIGHTS.strength,
    positionRoom: positionRoomRaw * TOPUP_SEVERITY_WEIGHTS.positionRoom,
    sectorRoom:   sectorRoomRaw   * TOPUP_SEVERITY_WEIGHTS.sectorRoom,
    upside:       upsideRaw       * TOPUP_SEVERITY_WEIGHTS.upside,
    cleanRisk:    cleanRiskRaw    * TOPUP_SEVERITY_WEIGHTS.cleanRisk,
  };
  const severity = clamp01(
    components.strength + components.positionRoom + components.sectorRoom +
    components.upside + components.cleanRisk
  );

  const pp = (n) => `${(n * 100).toFixed(0)}pp`;
  const rationale = [
    `v3 ${v3n.toFixed(0)}/100 → +${pp(components.strength)} strength`,
    `Position ${pw.toFixed(1)}% (room to ${(Math.max(0, 8 - pw)).toFixed(1)}pp) → +${pp(components.positionRoom)}`,
    `Sector ${sw.toFixed(1)}% (room to ${(Math.max(0, 25 - sw)).toFixed(1)}pp) → +${pp(components.sectorRoom)}`,
    `Upside ${up.toFixed(1)}% to FV → +${pp(components.upside)}`,
    `${rc} risk flag${rc === 1 ? "" : "s"} → +${pp(components.cleanRisk)} clean-risk`,
    `Total topup severity ${pp(severity)} → maps to ${severityToTopUpRung(severity) || "no top-up (HOLD)"}`,
  ];

  return { severity, components, rationale };
}

export function severityToTopUpRung(severity) {
  // Cutoffs calibrated against the topup-severity scale so a clean
  // TOP_PICK (v3≥70, full room, ≥20% upside, 0 risks) clears 0.70 → 100%,
  // a STRONG name with moderate room/upside (~0.40 severity) lands 33%,
  // and anything below 0.30 doesn't trigger a topup recommendation.
  if (!Number.isFinite(severity) || severity < 0.30) return null;
  if (severity >= 0.70) return "Top-up-100%";
  if (severity >= 0.50) return "Top-up-50%";
  if (severity >= 0.30) return "Top-up-33%";
  return "Top-up-25%";
}

/**
 * Return the realised-trim fraction (0..1) for any action label, legacy or v2.
 * EXIT-staged returns 0.5 (the part realised today). HOLD and top-ups return
 * 0. Unknown actions return 0 — fail-soft so the cash math never NaNs.
 */
export function parseTrimPct(action) {
  return TRIM_PCT_BY_ACTION[action] ?? 0;
}

/**
 * Return the top-up fraction (0..1) of the user's "ideal add" size for any
 * top-up action, legacy or v2. HOLD and reduction actions return 0.
 */
export function parseTopUpPct(action) {
  return TOPUP_PCT_OF_IDEAL_BY_ACTION[action] ?? 0;
}

/**
 * Round-trip any v2 action to its legacy equivalent. Consumers that only
 * understand legacy labels (older code paths, third-party tests) can call
 * this on the way in. Already-legacy labels pass through unchanged.
 */
export function ladderToLegacy(action) {
  if (!action) return action;
  return LADDER_TO_LEGACY[action] ?? action;
}

/**
 * Conviction proxy used when scoreBandAction needs a HIGH/MEDIUM/LOW band
 * BEFORE the v2 conviction engine runs (the conviction engine consumes the
 * action, so we can't read its output back here). Composite of v3 score
 * (60%) + snowflake total normalised to 100 (40%) with deterministic
 * penalties for surveillance flags and structural risks. Same direction
 * as conviction engine but cheaper.
 */
export function deriveConvictionProxy({ v3, snow_total, surveillance, risks_count }) {
  const v3num = Number.isFinite(v3) ? v3 : 0;
  const snowNorm = Number.isFinite(snow_total) ? (snow_total / 30) * 100 : 0;
  let score = v3num * 0.6 + snowNorm * 0.4;

  if (surveillance) {
    if (surveillance.list === "GSM") {
      const stage = Number(surveillance.stage) || 1;
      // GSM-1 ~ -18, GSM-6 ~ -33 — heavier penalty for higher stages
      score -= 15 + stage * 3;
    } else if (surveillance.list === "ASM") {
      // ASM is lighter than GSM but still a structural negative
      score -= 8;
    }
  }
  score -= (Number(risks_count) || 0) * 4;

  if (score >= 70) return "HIGH";
  if (score >= 55) return "MEDIUM-HIGH";
  if (score >= 40) return "MEDIUM";
  if (score >= 25) return "MEDIUM-LOW";
  return "LOW";
}

/**
 * Pick a trim rung from the v2 ladder.
 *
 * Inputs:
 *   v3              — v3_score_100, 0..100
 *   position_weight — % of book this holding represents
 *   sector_weight   — % of book this holding's sector represents
 *   conviction      — string, output of deriveConvictionProxy
 *   surveillance    — { list: "ASM"|"GSM", stage?, timeframe? } | null
 *
 * Returns null when v3 is too high to trigger a trim — caller falls
 * through to top-up logic.
 *
 * Rationale array is built alongside so the UI can show "why this rung"
 * step by step.
 */
export function pickTrimRung({ v3, position_weight, sector_weight, conviction, surveillance }) {
  const rationale = [];
  const v3n = Number.isFinite(v3) ? v3 : 0;
  const pw = Number.isFinite(position_weight) ? position_weight : 0;
  const sw = Number.isFinite(sector_weight) ? sector_weight : 0;
  const surv = surveillance || null;
  const survList = surv?.list || null;
  const survStage = Number(surv?.stage) || 0;

  // Tier 1 — EXIT-now (deepest-conviction sell): v3 below 8 OR
  // GSM-3+ surveillance regardless of v3.
  if (v3n < 8) {
    rationale.push(`v3 ${v3n.toFixed(0)} below 8/100 — bottom-tier score, exit floor.`);
    return { action: "EXIT-now", band: "AVOID", rationale };
  }
  if (survList === "GSM" && survStage >= 3) {
    rationale.push(`NSE GSM stage ${survStage} surveillance — regulatory red flag.`);
    return { action: "EXIT-now", band: "AVOID", rationale };
  }

  // Tier 2 — EXIT-staged: v3 8-14, no severe surveillance. Sell half now,
  // keep half pending a confirmation break (technical or fundamental
  // catalyst) over the next 5 sessions.
  if (v3n < 14) {
    rationale.push(`v3 ${v3n.toFixed(0)} between 8-14 — weak thesis, stage exit.`);
    return { action: "EXIT-staged", band: "AVOID", rationale };
  }

  // Tier 3 — Reduction band (v3 14-22). Granularity driven by position
  // weight × conviction × surveillance.
  if (v3n < 22) {
    rationale.push(`v3 ${v3n.toFixed(0)} between 14-22 — WATCH band.`);
    if (pw > 15 && conviction === "LOW") {
      rationale.push(`Weight ${pw.toFixed(1)}% > 15% with LOW conviction — escalate to 66%.`);
      return { action: "Reduction-66%", band: "WATCH", rationale };
    }
    if (pw >= 10 && pw <= 15 && sw > 25 && (conviction === "LOW" || conviction === "MEDIUM-LOW")) {
      rationale.push(`Weight ${pw.toFixed(1)}% + sector ${sw.toFixed(1)}% > 25% — 50%.`);
      return { action: "Reduction-50%", band: "WATCH", rationale };
    }
    if (pw > 15) {
      rationale.push(`Weight ${pw.toFixed(1)}% > 15% — concentration drives 50%.`);
      return { action: "Reduction-50%", band: "WATCH", rationale };
    }
    if (pw >= 8 && pw < 10 && conviction === "MEDIUM") {
      rationale.push(`Weight ${pw.toFixed(1)}% with MEDIUM conviction — 33%.`);
      return { action: "Reduction-33%", band: "WATCH", rationale };
    }
    if (pw < 8 && sw < 25 && (conviction === "MEDIUM" || conviction === "MEDIUM-HIGH" || conviction === "HIGH") && !survList) {
      rationale.push(`Weight ${pw.toFixed(1)}%, sector ${sw.toFixed(1)}%, conviction ${conviction}, no surveillance — light 25%.`);
      return { action: "Reduction-25%", band: "WATCH", rationale };
    }
    rationale.push(`WATCH-band default — 33%.`);
    return { action: "Reduction-33%", band: "WATCH", rationale };
  }

  // Tier 4 — overweight or surveillance-driven Reduction-25% even when
  // v3 is in the ACCEPTABLE band (22-40). The reasoning is structural —
  // single-name concentration risk or ASM-stage-2+ regulatory friction —
  // not a thesis call.
  if (v3n < 40) {
    if (pw > 15) {
      rationale.push(`v3 ${v3n.toFixed(0)} ACCEPTABLE but weight ${pw.toFixed(1)}% > 15% — overweight trim 25%.`);
      return { action: "Reduction-25%", band: "ACCEPTABLE", rationale };
    }
    if (survList === "ASM" && survStage >= 2) {
      rationale.push(`NSE ASM stage ${survStage} surveillance — regulatory caution, light trim 25%.`);
      return { action: "Reduction-25%", band: "ACCEPTABLE", rationale };
    }
  }

  return null;
}

/**
 * Promote a legacy action label to a ladder-v2 rung based on the full
 * factor stack. This is the final-stage rewrite: scoreBandAction +
 * conviction engine + position guardrail all work in legacy space, and
 * promoteToLadderV2 maps their output to a granular rung once.
 *
 * Inputs cover both reduction and top-up branches:
 *   legacyAction     — "EXIT" | "Reduction-50%" | "Reduction-25-33%" |
 *                      "HOLD" | "Top-up-modest" | "Top-up" | "STRONG Top-up"
 *   v3, snow_total   — score inputs
 *   position_weight  — % of book this holding represents
 *   sector_weight    — % of book this holding's sector represents
 *   upside           — % to AnalystConsensus FV
 *   risks_count      — count of risk flags
 *   surveillance     — { list, stage } | null
 *   pnlPercent       — used for EXIT-now vs EXIT-staged staging
 *
 * Returns { action, legacyAction, ladderRationale[], ladderV2: true,
 *           conviction }. When SWS_LADDER_V2 is off, returns the legacy
 * action unchanged (no-op promotion) so callers don't need to branch.
 */
export function promoteToLadderV2({
  legacyAction,
  v3,
  snow_total,
  position_weight,
  sector_weight,
  upside,
  risks_count,
  surveillance,
  pnlPercent,
}) {
  const rationale = [];
  const conviction = deriveConvictionProxy({ v3, snow_total, surveillance, risks_count });

  if (!isLadderV2Enabled()) {
    return {
      action: legacyAction,
      legacyAction,
      ladderRationale: null,
      ladderV2: false,
      conviction,
    };
  }

  // V3 path — continuous severity score replaces the categorical V2 matrix.
  // Default-fallback to Reduction-33% is gone; every input combination maps
  // to a specific rung based on its precise factor stack. Same SEBI-defensible
  // observational framing — engine emits a number, not an instruction.
  if (isLadderV3Enabled()) {
    return _promoteV3({
      legacyAction, v3, position_weight, sector_weight, upside, risks_count,
      surveillance, pnlPercent, conviction,
    });
  }

  const v3n = Number.isFinite(v3) ? v3 : 0;
  const pw = Number.isFinite(position_weight) ? position_weight : 0;
  const sw = Number.isFinite(sector_weight) ? sector_weight : 0;
  const up = Number.isFinite(upside) ? upside : 0;
  const rc = Number.isFinite(risks_count) ? risks_count : 0;
  const pnl = Number.isFinite(pnlPercent) ? pnlPercent : 0;
  const survList = surveillance?.list || null;
  const survStage = Number(surveillance?.stage) || 0;

  // ─── EXIT branch ───────────────────────────────────────────────
  // Legacy "EXIT" maps to either EXIT-now (severe regulatory red flag,
  // bottom-tier score, or extreme drawdown) or EXIT-staged (weak-thesis
  // exit where a partial sale today + technical-confirmation tail makes
  // sense). pnl threshold mirrors the conviction-engine guardrail at -40.
  if (legacyAction === "EXIT") {
    rationale.push(`Engine emitted legacy EXIT — promoting to ladder-v2 exit rung.`);
    if (survList === "GSM" && survStage >= 3) {
      rationale.push(`NSE GSM stage ${survStage} surveillance — exit immediately, no staging.`);
      return { action: "EXIT-now", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (v3n < 8) {
      rationale.push(`v3 ${v3n.toFixed(0)} below 8/100 — bottom-tier, exit immediately.`);
      return { action: "EXIT-now", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pnl <= -50) {
      rationale.push(`Drawdown ${pnl.toFixed(1)}% past -50% — thesis structurally broken, exit immediately.`);
      return { action: "EXIT-now", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    rationale.push(`Conviction ${conviction}, drawdown ${pnl.toFixed(1)}%, no GSM-3+ — stage exit (50% now, 50% on confirmation).`);
    return { action: "EXIT-staged", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
  }

  // ─── Reduction-50% branch ──────────────────────────────────────
  // Promote to 25/33/50/66 based on factor stack. Position weight is
  // the dominant driver — concentration risk amplifies the trim depth.
  if (legacyAction === "Reduction-50%") {
    rationale.push(`Engine emitted Reduction-50% — promoting to factor-driven ladder rung.`);
    if (pw > 15 && conviction === "LOW") {
      rationale.push(`Weight ${pw.toFixed(1)}% > 15% with LOW conviction — escalate to 66%.`);
      return { action: "Reduction-66%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pw > 15) {
      rationale.push(`Weight ${pw.toFixed(1)}% > 15% — concentration risk, hold 50% trim.`);
      return { action: "Reduction-50%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pw >= 10 && pw <= 15 && (sw > 25 || conviction === "LOW" || conviction === "MEDIUM-LOW")) {
      rationale.push(`Weight ${pw.toFixed(1)}%, sector ${sw.toFixed(1)}%, conviction ${conviction} — keep 50% trim.`);
      return { action: "Reduction-50%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pw >= 8 && pw < 10) {
      rationale.push(`Weight ${pw.toFixed(1)}% in 8-10 band — soften to 33%.`);
      return { action: "Reduction-33%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pw < 8 && (conviction === "MEDIUM" || conviction === "MEDIUM-HIGH" || conviction === "HIGH") && !survList) {
      rationale.push(`Weight ${pw.toFixed(1)}% < 8%, conviction ${conviction}, no surveillance — light 25% trim.`);
      return { action: "Reduction-25%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    rationale.push(`Default fallback — 33%.`);
    return { action: "Reduction-33%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
  }

  // ─── Reduction-25-33% branch (legacy mid-trim) ────────────────
  // Map to 25 or 33 based on weight + conviction. Anchors are the same
  // as the Reduction-50% branch but capped at 33 max.
  if (legacyAction === "Reduction-25-33%") {
    rationale.push(`Engine emitted Reduction-25-33% — choosing 25 vs 33 based on factors.`);
    if (pw >= 8 || conviction === "LOW" || conviction === "MEDIUM-LOW") {
      rationale.push(`Weight ${pw.toFixed(1)}%, conviction ${conviction} — 33% trim.`);
      return { action: "Reduction-33%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    rationale.push(`Weight ${pw.toFixed(1)}%, conviction ${conviction} — 25% trim.`);
    return { action: "Reduction-25%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
  }

  // ─── Top-up branch (legacy modest / normal / strong) ──────────
  // Symmetric ladder: 25 / 33 / 50 / 100% of an "ideal add" size.
  // Stronger upside + maximal room + clean risks → larger rung.
  if (legacyAction === "STRONG Top-up") {
    rationale.push(`Engine emitted STRONG Top-up — promoting to top-up ladder.`);
    if (pw < 5 && sw < 20 && up >= 15 && rc === 0) {
      rationale.push(`v3 ${v3n.toFixed(0)} + weight ${pw.toFixed(1)}% < 5% + sector ${sw.toFixed(1)}% < 20% + upside ${up.toFixed(1)}% ≥ 15% + 0 risks → 100%.`);
      return { action: "Top-up-100%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pw < 8 && sw < 25 && up >= 10 && rc <= 1) {
      rationale.push(`Moderate room (${pw.toFixed(1)}%/${sw.toFixed(1)}%) + upside ${up.toFixed(1)}% → 50%.`);
      return { action: "Top-up-50%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    rationale.push(`Constrained by room/risks — 25%.`);
    return { action: "Top-up-25%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
  }
  if (legacyAction === "Top-up") {
    rationale.push(`Engine emitted Top-up — choosing rung based on factors.`);
    if (pw < 6 && sw < 22 && up >= 15 && rc === 0) {
      rationale.push(`Ample room + upside ${up.toFixed(1)}% + 0 risks → 50%.`);
      return { action: "Top-up-50%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pw < 8 && sw < 25 && up >= 5 && rc <= 1) {
      rationale.push(`Room + upside ${up.toFixed(1)}% → 33%.`);
      return { action: "Top-up-33%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    rationale.push(`Room/upside thin — 25%.`);
    return { action: "Top-up-25%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
  }
  if (legacyAction === "Top-up-modest") {
    rationale.push(`Engine emitted Top-up-modest — promoting to 25% (smallest rung).`);
    return { action: "Top-up-25%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
  }

  // ─── HOLD / unknown — pass through ────────────────────────────
  return {
    action: legacyAction || "HOLD",
    legacyAction: legacyAction || "HOLD",
    ladderRationale: null,
    ladderV2: false,
    conviction,
  };
}

/**
 * V3 promotion path. The legacyAction tells us whether the engine is on
 * the trim or top-up side of the ladder; severity model picks the rung
 * within that side. Same return contract as the V2 path so callers don't
 * need to branch.
 */
function _promoteV3({
  legacyAction, v3, position_weight, sector_weight, upside, risks_count,
  surveillance, pnlPercent, conviction,
}) {
  const v3n = Number.isFinite(v3) ? v3 : 0;
  const survList = surveillance?.list || null;
  const survStage = Number(surveillance?.stage) || 0;
  const gsmStage3Plus = survList === "GSM" && survStage >= 3;

  // ─── EXIT branch (forced exit from engine) ─────────────────────
  if (legacyAction === "EXIT") {
    const trim = computeTrimSeverity({
      v3, position_weight, sector_weight, conviction,
      surveillance, pnlPercent, risks_count,
    });
    let exitRung;
    if (gsmStage3Plus) exitRung = "EXIT-now";
    else if (v3n < 8) exitRung = "EXIT-now";
    else if (Number.isFinite(pnlPercent) && pnlPercent <= -50) exitRung = "EXIT-now";
    else exitRung = trim.severity >= 0.85 ? "EXIT-now" : "EXIT-staged";
    return {
      action: exitRung,
      legacyAction: "EXIT",
      ladderRationale: [
        `Engine emitted EXIT — V3 severity model determines staging.`,
        ...trim.rationale,
        `Exit rung: ${exitRung}${exitRung === "EXIT-staged" ? " (50% now, 50% on confirmation T+5)" : ""}.`,
      ],
      ladderV2: true,
      conviction,
      severity: trim.severity,
      severityComponents: trim.components,
    };
  }

  // ─── Reduction branch (engine flagged a trim) ────────────────────
  if (legacyAction === "Reduction-50%" || legacyAction === "Reduction-25-33%") {
    const trim = computeTrimSeverity({
      v3, position_weight, sector_weight, conviction,
      surveillance, pnlPercent, risks_count,
    });
    const rung = severityToTrimRung(trim.severity, { gsmStage3Plus }) || "Reduction-25%";
    return {
      action: rung,
      legacyAction,
      ladderRationale: [
        `Engine emitted ${legacyAction} — V3 severity model selects the specific rung.`,
        ...trim.rationale,
      ],
      ladderV2: true,
      conviction,
      severity: trim.severity,
      severityComponents: trim.components,
    };
  }

  // ─── Top-up branch (engine flagged accumulation) ─────────────────
  if (legacyAction === "STRONG Top-up" || legacyAction === "Top-up" || legacyAction === "Top-up-modest") {
    const tu = computeTopUpSeverity({ v3, position_weight, sector_weight, upside, risks_count });
    // Floor on 25% — once the engine has decided to top-up, the smallest
    // recommended rung is 25% of an ideal add. Severity below 0.30 is unusual
    // when the engine pre-emitted Top-up; default to 25% in that case.
    const rung = severityToTopUpRung(tu.severity) || "Top-up-25%";
    return {
      action: rung,
      legacyAction,
      ladderRationale: [
        `Engine emitted ${legacyAction} — V3 severity model selects the specific rung.`,
        ...tu.rationale,
      ],
      ladderV2: true,
      conviction,
      severity: tu.severity,
      severityComponents: tu.components,
    };
  }

  // HOLD or unknown — pass through unchanged.
  return {
    action: legacyAction || "HOLD",
    legacyAction: legacyAction || "HOLD",
    ladderRationale: null,
    ladderV2: false,
    conviction,
  };
}

/**
 * Pick a top-up rung from the v2 ladder. Mirrors pickTrimRung — the
 * factor stack is symmetric (position room, sector room, upside, risks
 * count) and rationale is built step by step. Returns null when v3 is
 * too low to trigger a top-up — caller defaults to HOLD.
 */
export function pickTopUpRung({ v3, position_weight, sector_weight, upside, risks_count }) {
  const rationale = [];
  const v3n = Number.isFinite(v3) ? v3 : 0;
  const pw = Number.isFinite(position_weight) ? position_weight : 0;
  const sw = Number.isFinite(sector_weight) ? sector_weight : 0;
  const up = Number.isFinite(upside) ? upside : 0;
  const rc = Number.isFinite(risks_count) ? risks_count : 0;

  // Tier 1 — Top-up-100% (full ideal add): TOP_PICK band with maximal
  // room and clean risk profile.
  if (v3n >= 65) {
    if (pw < 5 && sw < 20 && up >= 15 && rc === 0) {
      rationale.push(`v3 ${v3n.toFixed(0)} TOP_PICK + weight ${pw.toFixed(1)}% < 5% + sector ${sw.toFixed(1)}% < 20% + upside ${up.toFixed(1)}% ≥ 15% + 0 risks → 100%.`);
      return { action: "Top-up-100%", band: "TOP_PICK", rationale };
    }
    if (pw < 8 && sw < 25 && up >= 10 && rc <= 1) {
      rationale.push(`v3 ${v3n.toFixed(0)} TOP_PICK with moderate room (${pw.toFixed(1)}%/${sw.toFixed(1)}%) + upside ${up.toFixed(1)}% → 50%.`);
      return { action: "Top-up-50%", band: "TOP_PICK", rationale };
    }
    rationale.push(`v3 ${v3n.toFixed(0)} TOP_PICK but room/risk constraints limit to 25%.`);
    return { action: "Top-up-25%", band: "TOP_PICK", rationale };
  }

  // Tier 2 — STRONG band (50-65). Granular by upside + risks.
  if (v3n >= 50) {
    if (pw < 6 && sw < 22 && up >= 15 && rc === 0) {
      rationale.push(`v3 ${v3n.toFixed(0)} STRONG + ample room + upside ${up.toFixed(1)}% + 0 risks → 50%.`);
      return { action: "Top-up-50%", band: "STRONG", rationale };
    }
    if (pw < 8 && sw < 25 && up >= 5 && rc <= 1) {
      rationale.push(`v3 ${v3n.toFixed(0)} STRONG + room + upside ${up.toFixed(1)}% → 33%.`);
      return { action: "Top-up-33%", band: "STRONG", rationale };
    }
    rationale.push(`v3 ${v3n.toFixed(0)} STRONG but room/upside thin — 25%.`);
    return { action: "Top-up-25%", band: "STRONG", rationale };
  }

  // Tier 3 — ACCEPTABLE-PLUS band (40-50). Modest add only when rules clear.
  if (v3n >= 40) {
    if (pw <= 8 && sw <= 25 && up >= 5) {
      rationale.push(`v3 ${v3n.toFixed(0)} ACCEPTABLE-PLUS + room + upside ${up.toFixed(1)}% → 25%.`);
      return { action: "Top-up-25%", band: "ACCEPTABLE-PLUS", rationale };
    }
  }

  return null;
}
