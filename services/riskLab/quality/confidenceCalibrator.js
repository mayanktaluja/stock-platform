/**
 * Risk Lab — Quality Lens / Confidence Calibrator.
 *
 * Optional helper: when a stock has a prediction confidence (e.g. from
 * the earnings predictor, attached in PR 7's orchestrator extension),
 * subtract per-flag confidence penalties so the lab reports a "deserved"
 * confidence rather than the optimistic original.
 *
 * Per-flag penalties (derived from the KEC investigation, see project
 * memory project_kec_failure_2026_05_18.md):
 *   - consecutive_miss        → -15 pct (largest — the most powerful signal)
 *   - imputation_inflation    → -10 pct (high-score on imputed data)
 *   - cost_pressure (any risk_text or counter_thesis flag with severity ≤ -2)
 *                             → -8 pct
 *   - sector_overlay          → -5 pct
 *
 * Combined penalties are subtracted from the original confidence. The
 * result is then clamped to [50, originalConf] — we never lift confidence,
 * and we never drop it below the predictor's V1 50% floor.
 *
 * For picks rows (no original confidence), returns null. The lab UI
 * shows quality_adjusted_confidence only when set.
 */

const CONFIDENCE_FLOOR = 50;

const PENALTY_TABLE = {
  consecutive_miss: -15,
  imputation_inflation: -10,
  cost_pressure: -8,
  sector_overlay: -5,
};

/**
 * Determine which broad "penalty bucket" a flag belongs to.
 *
 * @param {object} flag — { type?, category?, overlay?, severity? }
 * @returns {string|null}
 */
function classifyFlag(flag) {
  if (!flag) return null;
  if (flag.type === "consecutive_miss") return "consecutive_miss";
  // Imputation flags use type === "fv_imputed" / "momentum_imputed"
  if (flag.type === "fv_imputed" || flag.type === "momentum_imputed") return "imputation_inflation";
  // Sector overlays use overlay
  if (flag.overlay) return "sector_overlay";
  // Generic quality flags (risk_text, counter_thesis) — penalty bucket is
  // gated by severity. -2 and below counts as cost_pressure.
  if (flag.category && Number(flag.severity || 0) <= -2) return "cost_pressure";
  return null;
}

/**
 * Calibrate a prediction confidence given the set of quality flags.
 *
 * @param {number|null} originalConfidence — predictor's reported confidence
 *   (e.g. 65 for KEC). Pass null/undefined to indicate "no prediction
 *   context" — function returns null.
 * @param {object[]} flags — array of quality flag objects from any of
 *   the quality modules (consecutiveMissDetector, imputationPenalty,
 *   riskTextClassifier, counterThesisParser, sectorQualityOverlay).
 * @returns {object|null} {
 *   original_confidence,
 *   penalty_applied,
 *   adjusted_confidence,
 *   buckets: { consecutive_miss: bool, imputation_inflation: bool, ... }
 * }
 *   or null when originalConfidence is not provided.
 */
export function calibrateConfidence(originalConfidence, flags) {
  if (originalConfidence == null || !Number.isFinite(Number(originalConfidence))) {
    return null;
  }
  const orig = Number(originalConfidence);
  if (!Array.isArray(flags) || flags.length === 0) {
    return {
      original_confidence: orig,
      penalty_applied: 0,
      adjusted_confidence: orig,
      buckets: {},
    };
  }

  // Determine which buckets fired (each fires once even if multiple flags
  // map to it — the penalty is per-bucket, not per-flag)
  const buckets = {};
  for (const flag of flags) {
    const bucket = classifyFlag(flag);
    if (bucket) buckets[bucket] = true;
  }

  let penalty = 0;
  for (const bucket of Object.keys(buckets)) {
    penalty += PENALTY_TABLE[bucket] || 0;
  }

  const adjusted = Math.max(orig + penalty, CONFIDENCE_FLOOR);
  // Never lift above the original
  const final = Math.min(adjusted, orig);

  return {
    original_confidence: orig,
    penalty_applied: penalty,
    adjusted_confidence: final,
    buckets,
  };
}
