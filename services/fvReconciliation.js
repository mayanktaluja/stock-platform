// Canonical reconciliation for SWS fair-value / upside fields.
//
// SWS is the primary source for analyst fair value. This helper preserves any
// finite raw SWS FV, computes display upside from FV + price when possible, and
// uses the historic 0.1x-10x ratio band only as telemetry for unusually large
// or small SWS-supplied values. It does not suppress finite SWS FV values.

export const FV_RATIO_MIN = 0.1;
export const FV_RATIO_MAX = 10;

const num = (v, fallback = null) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

// Apply a precomputed display-haircut factor to a raw upside %. The factor is
// decided at scoring time (services/swsScoringV4.js `_fvCompositeV4`), where the
// full deep-brief overview — analyst range + count — is in hand; the serve path
// only sees a slim FV map, so it can't re-derive suspicion and must re-apply the
// stored factor instead. Only POSITIVE upside is de-rated: haircutting a negative
// (overvalued) upside would make it read LESS bearish — the wrong direction.
// Factor defaults to a no-op (1) for anything outside (0,1).
export function applyUpsideHaircut(upsidePct, factor) {
  const f = typeof factor === "number" && Number.isFinite(factor) && factor > 0 && factor < 1 ? factor : 1;
  if (f === 1) return upsidePct;
  if (typeof upsidePct !== "number" || !Number.isFinite(upsidePct) || upsidePct <= 0) return upsidePct;
  return Math.round(upsidePct * f * 10) / 10;
}

export function valuationBandFromUpside(upside) {
  if (upside == null || !Number.isFinite(upside)) return null;
  if (upside >= 25) return "DEEP_DISCOUNT";
  if (upside >= 10) return "DISCOUNT";
  if (upside >= -5) return "FAIR";
  if (upside >= -20) return "PREMIUM";
  return "EXPENSIVE";
}

function result({ upside_pct, fair_value_inr, reason, confidence, source, upsideSource }) {
  const roundedUpside = round1(upside_pct);
  return {
    upside_pct: roundedUpside,
    fair_value_inr: Number.isFinite(fair_value_inr) ? fair_value_inr : null,
    valuation_band: valuationBandFromUpside(roundedUpside),
    fv_reconcile_reason: reason,
    fair_value_confidence: confidence,
    fair_value_source: source,
    upside_source: roundedUpside != null ? upsideSource : null,
  };
}

export function reconcileFairValue(overview = {}) {
  const price = num(overview?.current_price_inr);
  const rawFv = num(overview?.fair_value_inr);
  const rawUp = num(overview?.upside_pct);

  const priceOk = price != null && price > 0;
  const fvPresent = rawFv != null;

  if (priceOk && fvPresent) {
    const ratio = rawFv / price;
    const computed = ((rawFv - price) / price) * 100;
    return result({
      upside_pct: computed,
      fair_value_inr: rawFv,
      reason: ratio < FV_RATIO_MIN || ratio > FV_RATIO_MAX ? "ok_sws_raw_fv" : "ok",
      confidence: "HIGH",
      source: "sws_raw_fv",
      upsideSource: "computed_from_sws_fv_price",
    });
  }

  return result({
    upside_pct: rawUp,
    fair_value_inr: fvPresent ? rawFv : null,
    reason: !priceOk ? "source_price_missing" : !fvPresent ? "source_fv_missing" : "ok",
    confidence: rawUp != null || fvPresent ? "MEDIUM_QUOTED" : "NONE",
    source: rawUp != null ? "quoted_upside_no_fv" : fvPresent ? "sws_raw_fv_no_price" : "missing",
    upsideSource: rawUp != null ? "sws_quoted_upside" : null,
  });
}

export function withReconciledFairValue(stock = {}) {
  const overview = stock?.overview || {};
  const fv = reconcileFairValue(overview);
  return {
    ...stock,
    overview: {
      ...overview,
      fair_value_inr: fv.fair_value_inr,
      upside_pct: fv.upside_pct,
      valuation_band: fv.valuation_band,
      fv_reconcile_reason: fv.fv_reconcile_reason,
      fair_value_confidence: fv.fair_value_confidence,
      fair_value_source: fv.fair_value_source,
      upside_source: fv.upside_source,
    },
  };
}
