// Canonical reconciliation for SWS fair-value / upside fields.
//
// Raw SWS deep JSON is preserved for audit, but any score/card/API consumer
// should use this helper before trusting fair_value_inr or upside_pct. The
// ratio band intentionally matches the holding-engine policy: below 0.1x or
// above 10x price, the FV is treated as a scraper artefact and suppressed.

export const FV_RATIO_MIN = 0.1;
export const FV_RATIO_MAX = 10;
export const QUOTED_UPSIDE_MIN = -95;
export const QUOTED_UPSIDE_MAX = 500;

const num = (v, fallback = null) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

export function valuationBandFromUpside(upside) {
  if (upside == null || !Number.isFinite(upside)) return null;
  if (upside >= 25) return "DEEP_DISCOUNT";
  if (upside >= 10) return "DISCOUNT";
  if (upside >= -5) return "FAIR";
  if (upside >= -20) return "PREMIUM";
  return "EXPENSIVE";
}

function result({ upside_pct, fair_value_inr, reason, confidence, source }) {
  const roundedUpside = round1(upside_pct);
  return {
    upside_pct: roundedUpside,
    fair_value_inr: Number.isFinite(fair_value_inr) ? fair_value_inr : null,
    valuation_band: valuationBandFromUpside(roundedUpside),
    fv_reconcile_reason: reason,
    fair_value_confidence: confidence,
    fair_value_source: source,
  };
}

export function reconcileFairValue(overview = {}) {
  const price = num(overview?.current_price_inr);
  const rawFv = num(overview?.fair_value_inr);
  const rawUp = num(overview?.upside_pct);
  const inSaneQuotedRange = (v) =>
    v != null && Number.isFinite(v) && v >= QUOTED_UPSIDE_MIN && v <= QUOTED_UPSIDE_MAX;

  const priceOk = price != null && price > 0;
  const fvOk = rawFv != null && rawFv > 0;

  if (priceOk && fvOk) {
    const ratio = rawFv / price;
    if (ratio >= FV_RATIO_MIN && ratio <= FV_RATIO_MAX) {
      const computed = ((rawFv - price) / price) * 100;
      if (Math.abs(computed) <= 1 && inSaneQuotedRange(rawUp)) {
        return result({
          upside_pct: rawUp,
          fair_value_inr: rawFv,
          reason: "ok_using_provided_upside",
          confidence: "MEDIUM_QUOTED",
          source: "quoted_upside_placeholder_fv",
        });
      }
      return result({
        upside_pct: computed,
        fair_value_inr: rawFv,
        reason: "ok",
        confidence: "HIGH",
        source: "computed_fv_price",
      });
    }
    return result({
      upside_pct: null,
      fair_value_inr: null,
      reason: ratio < FV_RATIO_MIN ? "junk_ratio_low" : "junk_ratio_high",
      confidence: "LOW",
      source: "implausible_fv",
    });
  }

  return result({
    upside_pct: inSaneQuotedRange(rawUp) ? rawUp : null,
    fair_value_inr: fvOk ? rawFv : null,
    reason: !priceOk ? "source_price_missing" : !fvOk ? "source_fv_missing" : "ok",
    confidence: inSaneQuotedRange(rawUp) ? "MEDIUM_QUOTED" : "NONE",
    source: inSaneQuotedRange(rawUp) ? "quoted_upside_no_fv" : "missing",
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
    },
  };
}
