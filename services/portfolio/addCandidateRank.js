import { num } from "../swsScoring.js";

// Own copy of the 8% position-weight ceiling. portfolioConstructionPlan.js
// exports MAX_POSITION_WEIGHT_PCT but imports this module, so reading the
// constant from there would create an import cycle.
export const RANK_MAX_POSITION_WEIGHT_PCT = 8;

// Moved verbatim from portfolioConstructionPlan.js so the construction-plan
// funding rank and the Top-up badge-cap rank stay one formula. Any change
// here re-ranks BOTH surfaces — that coupling is the point.
export function candidateBaseRank(c) {
  const v4 = num(c.v4_score, 0);
  const upside = Math.min(Math.max(num(c.upside_pct, 0), 0), 40);
  const sectorFit = num(c.sectorFitScore, 0);
  const lowerPositionBonus = Math.max(0, RANK_MAX_POSITION_WEIGHT_PCT - num(c.positionWeight, 0)) * 1.2;
  const sourceBonus = c.source === "holding" ? 2 : 0;
  return +(v4 + upside * 0.35 + sectorFit * 0.5 + lowerPositionBonus + sourceBonus).toFixed(2);
}

// The four core add-quality gates — ONE threshold source for the three
// surfaces that each duplicated them: the engine's badge-time raw-add gate
// (swsHoldingEngine._buildRawAddGate), the construction plan's funding
// rejection reasons (candidateRejectionReasons), and the measurement script.
// Returns failure CODES; each consumer maps codes to its own user-facing
// strings so this consolidation is byte-identical in every output.
export const ADD_V4_FLOOR = 53;
export const ADD_UPSIDE_FLOOR_PCT = 12;
export const ADD_FUNDABLE_VALUATION_BANDS = new Set(["DISCOUNT", "DEEP_DISCOUNT"]);

export function coreAddQualityFailures({ v4_score, valuation_confidence, valuation_band, upside_pct } = {}) {
  const failures = [];
  const v4 = num(v4_score, null);
  const upside = num(upside_pct, null);
  if (v4 == null || v4 < ADD_V4_FLOOR) failures.push("v4_below_floor");
  if (valuation_confidence !== "HIGH") failures.push("confidence_not_high");
  if (!ADD_FUNDABLE_VALUATION_BANDS.has(valuation_band)) failures.push("band_not_discount");
  if (upside == null || upside < ADD_UPSIDE_FLOOR_PCT) failures.push("upside_below_floor");
  return failures;
}

// Rank inputs for a scored holding, mirroring makeHoldingCandidate's fields:
// original scoredHoldings never carry _sectorFit (it is attached only to
// basket-row copies), so sectorFitScore resolves to 0 and source is always
// "holding" (+2 bonus) — ordering over holdings is identical to the
// construction plan's holding ranking.
export function holdingRankInputs(h) {
  const sws = h?.sws || {};
  return {
    v4_score: num(sws.v4_score, null),
    upside_pct: num(sws.upside_pct, null),
    sectorFitScore: num(h?._sectorFit?.score, 0),
    positionWeight: num(h?.positionWeight, 0),
    source: "holding",
  };
}
