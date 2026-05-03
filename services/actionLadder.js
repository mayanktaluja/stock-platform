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
  return process.env.SWS_LADDER_V2 === "1";
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
