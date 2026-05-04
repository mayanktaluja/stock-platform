/**
 * combinedScoreMode.js — feature-flagged rollout switch for the
 * Tech + Fundamentals + SWS combined scanner score.
 *
 * Mirrors the proven SCORER_MODE / RECOMMENDER_VERSION pattern. Controlled
 * by COMBINED_SCORE_MODE:
 *
 *   COMBINED_SCORE_MODE=legacy   — kill switch. Combined score not computed.
 *                                   Scanners behave exactly as before.
 *   COMBINED_SCORE_MODE=shadow   — combined computed alongside legacy.
 *                                   Sort still uses adjustedScore. Diffs
 *                                   logged to combined-shadow-diff.json.
 *   COMBINED_SCORE_MODE=opt-in   — combined available, UI toggle controls
 *                                   whether each user opts into combined sort.
 *   COMBINED_SCORE_MODE=primary  — combined replaces adjustedScore as primary
 *                                   sort. legacyAdjustedScore kept on payload  (default)
 *                                   for one quarter for transparency.
 *
 * Phase gates (defended in /Users/mayanktaluja/.claude/plans/create-a-plan-to-witty-harp.md):
 *   shadow → opt-in:  verdict-flip rate < 30% AND surveillance regression
 *                     test passes.
 *   opt-in → primary: backtest gate (≥ 0bp alpha vs legacy on 5Y midterm
 *                     and 4Y small-cap windows after 50bp friction).
 *
 * Kill switch: set COMBINED_SCORE_MODE=legacy to revert behaviour without
 * a code deploy.
 */

const VALID_MODES = new Set(["legacy", "shadow", "opt-in", "primary"]);
// Default flipped 2026-05 from "shadow" → "primary" so the SWS-included
// 0.45/0.25/0.30 (buynow) and 0.35/0.30/0.35 (midterm) weights drive the
// scanner sort, instead of the legacy 50/50 tech+fund. legacyAdjustedScore
// remains on every payload for transparency, and COMBINED_SCORE_MODE=legacy
// is still the no-deploy kill switch.
const DEFAULT_MODE = "primary";
const RAW_MODE = process.env.COMBINED_SCORE_MODE || DEFAULT_MODE;
export const COMBINED_SCORE_MODE = VALID_MODES.has(RAW_MODE) ? RAW_MODE : DEFAULT_MODE;

if (!VALID_MODES.has(RAW_MODE)) {
  console.warn(
    `[combinedScoreMode] Unknown COMBINED_SCORE_MODE="${RAW_MODE}". Falling back to "${DEFAULT_MODE}".`
  );
}

console.log(`[combinedScoreMode] active: ${COMBINED_SCORE_MODE} (default: ${DEFAULT_MODE})`);

export function isLegacyMode() {
  return COMBINED_SCORE_MODE === "legacy";
}

export function isShadowMode() {
  return COMBINED_SCORE_MODE === "shadow";
}

export function isOptInMode() {
  return COMBINED_SCORE_MODE === "opt-in";
}

export function isPrimaryMode() {
  return COMBINED_SCORE_MODE === "primary";
}

// True whenever the combined score should be computed and attached to the
// scanner payload. Only the kill-switch suppresses computation entirely.
export function shouldComputeCombined() {
  return COMBINED_SCORE_MODE !== "legacy";
}

// True when combined score should be the authoritative sort key on the
// server side. UI may still expose a manual override under opt-in.
export function shouldSortByCombined() {
  return COMBINED_SCORE_MODE === "primary";
}
