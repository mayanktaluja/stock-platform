// Confidence-calibrated position-size multiplier (PR A2, Phase 2).
//
// Pure helpers that turn a predictor confidence (0-100) into a sizing
// multiplier (0.2x-1.0x) that the 9-cell trading playbook can use. The
// model: the higher the predictor confidence, the more capital should
// be at risk; conversely, when the Risk Lab's quality overlay drops the
// effective confidence (e.g. KEC's 65% → ~48% after consecutive-miss +
// imputation flags) the same playbook cell ships at half the size.
//
// This is the highest single ₹-impact change in Phase 2: even before
// any verdict change, calibrating size cuts the per-event loss on
// catastrophic BEAT-predicted-actually-MISS calls by ~50%.
//
// SEBI Reg 16 framing: we don't claim "buy ₹100k of X". We surface a
// sizing multiplier ("0.6x — confidence-weighted") that the user
// multiplies against their own normal per-trade size. The multiplier
// is decision-support, not advice.

export const SIZING_TIERS = Object.freeze([
  { min: 65, multiplier: 1.0, label: "Full size", rationale: "Confidence at or above V1 cap — normal sizing applies." },
  { min: 48, multiplier: 0.6, label: "Reduced size", rationale: "Calibrated confidence material lower than headline — size down." },
  { min: 40, multiplier: 0.3, label: "Token size", rationale: "Confidence in low-conviction zone — trade size for information, not P&L." },
  { min: 0,  multiplier: 0.2, label: "Skip or token", rationale: "Confidence below floor — consider skipping; if entering, size for observation only." },
]);

export const SIZING_SCHEMA_VERSION = "sizing-v1";

export function computeSizeMultiplier(confidencePct) {
  if (typeof confidencePct !== "number" || !Number.isFinite(confidencePct)) return null;
  const c = Math.max(0, Math.min(100, confidencePct));
  for (const tier of SIZING_TIERS) {
    if (c >= tier.min) return tier.multiplier;
  }
  return SIZING_TIERS[SIZING_TIERS.length - 1].multiplier;
}

export function resolveSizingTier(confidencePct) {
  if (typeof confidencePct !== "number" || !Number.isFinite(confidencePct)) return null;
  const c = Math.max(0, Math.min(100, confidencePct));
  for (const tier of SIZING_TIERS) {
    if (c >= tier.min) return tier;
  }
  return SIZING_TIERS[SIZING_TIERS.length - 1];
}

// Returns the effective confidence to use for sizing — prefers the Risk
// Lab's quality_adjusted_confidence when present (it accounts for quality
// flags we know about), otherwise falls back to the production predictor's
// confidence_pct. Returns null if neither is available.
export function resolveCalibratedConfidence(event) {
  if (!event) return null;
  const labConf = event.lab_view?.quality_adjusted_confidence;
  if (typeof labConf === "number" && Number.isFinite(labConf)) return labConf;
  const prodConf = event.prediction?.confidence_pct;
  if (typeof prodConf === "number" && Number.isFinite(prodConf)) return prodConf;
  return null;
}

// Combined: returns the full sizing decision object — what to display in
// the UI and what to log to an audit trail. Returns null when there's
// nothing to size on.
export function buildSizingDecision(event) {
  if (!event) return null;
  const prodConf = typeof event.prediction?.confidence_pct === "number" ? event.prediction.confidence_pct : null;
  const labConf = typeof event.lab_view?.quality_adjusted_confidence === "number"
    ? event.lab_view.quality_adjusted_confidence
    : null;
  const effective = labConf !== null ? labConf : prodConf;
  if (effective === null) return null;
  const tier = resolveSizingTier(effective);
  if (!tier) return null;
  return {
    schema_version: SIZING_SCHEMA_VERSION,
    production_confidence_pct: prodConf,
    calibrated_confidence_pct: labConf,
    effective_confidence_pct: effective,
    multiplier: tier.multiplier,
    tier_label: tier.label,
    tier_rationale: tier.rationale,
    source: labConf !== null ? "lab_calibrated" : "production_only",
  };
}

export default {
  SIZING_TIERS,
  SIZING_SCHEMA_VERSION,
  computeSizeMultiplier,
  resolveSizingTier,
  resolveCalibratedConfidence,
  buildSizingDecision,
};
