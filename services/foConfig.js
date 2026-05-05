/**
 * F&O OI-Delta Swing Screener — thresholds and tunables.
 *
 * Single source of truth for every numeric knob. Changing a value here is
 * the only place you should ever need to touch when tuning the screener.
 */

export const FO_CONFIG = Object.freeze({
  // Signal-classification thresholds (percent)
  PRICE_DELTA_MIN: 0.5, // |Δ price| above this → directional, below → flat
  OI_DELTA_MIN: 1.0, // |Δ OI|    above this → meaningful, below → noise

  // Decoupling co-flag — OI moving big while price barely budges
  DECOUPLE_OI_MIN: 20.0,
  DECOUPLE_PRICE_MAX: 0.5,

  // Volume confirmation
  VOLUME_AVG_DAYS: 20, // baseline window for vol_ratio = today / mean(N days)
  VOLUME_CONFIRM: 1.5, // vol_ratio ≥ this → "confirmed"
  VOLUME_NORMAL: 1.0, // vol_ratio ≥ this (and < confirm) → "normal", else "thin"

  // Score caps and weights (see foScore.js for the formula)
  SCORE_RAW_OI_CAP: 50, // |OI Δ| beyond this is treated the same as 50
  SCORE_VOL_CAP: 3.0,
  SCORE_DECOUPLE_BOOST: 1.25,
  SCORE_DIRECTION_INCONSISTENT_PENALTY: 0.85, // OI and price move opposite ways

  // History retention (days) — for vol_ratio + sparkline context
  HISTORY_RETENTION_DAYS: 30,

  // Universe — how many "Broader F&O" cards to surface beyond Book + Picks
  BROADER_TOP_N: 15,

  // How far back to walk when no prior bhavcopy exists (cold start)
  PRIOR_DAY_LOOKBACK_SESSIONS: 5,

  // Bhavcopy file mtime grace — re-running within this window skips the
  // network fetch and only recomputes deltas. Useful for threshold tweaks.
  REFETCH_GRACE_MS: 10 * 60 * 1000,
});

/**
 * Classify (price Δ%, OI Δ%) into one of five signals.
 * Decoupling is a separate co-fired flag, computed in foOiDelta.
 */
export function classifySignal(priceDeltaPct, oiDeltaPct) {
  const { PRICE_DELTA_MIN, OI_DELTA_MIN } = FO_CONFIG;
  const priceUp = priceDeltaPct > PRICE_DELTA_MIN;
  const priceDn = priceDeltaPct < -PRICE_DELTA_MIN;
  const oiUp = oiDeltaPct > OI_DELTA_MIN;
  const oiDn = oiDeltaPct < -OI_DELTA_MIN;

  if (priceUp && oiUp) return "long_buildup";
  if (priceDn && oiUp) return "short_buildup";
  if (priceDn && oiDn) return "long_unwinding";
  if (priceUp && oiDn) return "short_covering";
  return "neutral";
}

export function isDecoupled(priceDeltaPct, oiDeltaPct) {
  return (
    Math.abs(oiDeltaPct) >= FO_CONFIG.DECOUPLE_OI_MIN &&
    Math.abs(priceDeltaPct) < FO_CONFIG.DECOUPLE_PRICE_MAX
  );
}

export function volumeBucket(volumeRatio) {
  if (!Number.isFinite(volumeRatio)) return "unknown";
  if (volumeRatio >= FO_CONFIG.VOLUME_CONFIRM) return "confirmed";
  if (volumeRatio >= FO_CONFIG.VOLUME_NORMAL) return "normal";
  return "thin";
}
