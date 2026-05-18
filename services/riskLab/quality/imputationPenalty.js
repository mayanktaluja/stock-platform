/**
 * Risk Lab — Quality Lens / Imputation Penalty.
 *
 * The production v3 scorer (scripts/sws-scoring.mjs:computeV3Score, line 472+)
 * fills missing data with neutral midpoints rather than zeros:
 *
 *   - fair-value upside missing → pts_fv_upside = 6 (out of 0..12)
 *     flagged via breakdown.fv_imputed = true
 *   - momentum percentiles missing → momentum_imputed = true; per-window
 *     contributions average around their midpoints
 *
 * This prevents stocks with sparse SWS coverage from being scored as zero,
 * but it also means the composite score for those stocks carries built-in
 * optimism that isn't backed by real data. When the score is high (>50)
 * AND imputation is true, the headline score overstates the actual
 * fundamental signal.
 *
 * The KEC investigation surfaced this as a contributing factor (project
 * memory project_kec_failure_2026_05_18.md). KEC itself didn't have
 * fv_imputed at the prediction time, but the lab's quality lens
 * generalises the pattern: any TOP_PICK whose v3 score is inflated by
 * an imputed component deserves a haircut so the user knows part of the
 * score is data-fill, not analysis.
 *
 * Penalty: -2 pts if fv_imputed + score > 50; -1 pt if momentum_imputed
 * + score > 50; combined cap at -3 pts. Conservative — the lab is
 * informational, not punitive.
 */

const FV_PENALTY = -2;
const MOMENTUM_PENALTY = -1;
const PENALTY_CAP = -3;
const SCORE_THRESHOLD = 50;

/**
 * Compute the imputation penalty for a single stock row.
 *
 * @param {object} v3Breakdown — stock.v3_breakdown from picks-latest.json
 * @param {number} v3Score100  — stock.v3_score_100
 * @returns {object} { pts, flags[], reason }
 */
export function computeImputationPenalty(v3Breakdown, v3Score100) {
  const flags = [];
  if (!v3Breakdown || typeof v3Breakdown !== "object") {
    return { pts: 0, flags, reason: "no_breakdown" };
  }
  const score = Number(v3Score100 || 0);

  if (v3Breakdown.fv_imputed === true && score > SCORE_THRESHOLD) {
    flags.push({
      type: "fv_imputed",
      severity: FV_PENALTY,
      evidence: `Fair-value upside imputed at neutral (+6 pts of ~12 max); v3 score ${score} carries data-fill optimism`,
      source: "v3_breakdown.fv_imputed",
    });
  }

  if (v3Breakdown.momentum_imputed === true && score > SCORE_THRESHOLD) {
    flags.push({
      type: "momentum_imputed",
      severity: MOMENTUM_PENALTY,
      evidence: `Momentum percentiles imputed at neutral; v3 score ${score} not anchored on real price action`,
      source: "v3_breakdown.momentum_imputed",
    });
  }

  if (flags.length === 0) {
    return { pts: 0, flags: [], reason: "no_imputation_above_threshold" };
  }

  const rawSum = flags.reduce((acc, f) => acc + f.severity, 0);
  const pts = Math.max(rawSum, PENALTY_CAP);

  return { pts, flags, reason: "imputation_inflation" };
}
