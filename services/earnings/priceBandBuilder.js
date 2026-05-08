/**
 * priceBandBuilder.js
 *
 * Bull / Base / Bear price scenarios for a single earnings event.
 *
 * V1 approach: ground each scenario in (a) the predictor's confidence,
 * (b) the stock's realised volatility (proxied by 1M return magnitude),
 * and (c) historical median post-result moves for similar setups.
 *
 * Without a real historical-reactions dataset (lands in M-F via
 * earningsHistoryArchive), V1 uses a deliberately conservative
 * heuristic and caps moves at ±15% — better to be too tight than
 * suggest a 25% one-day move with no data to back it.
 *
 * The bands are anchored at `current_price_inr` from the SWS
 * upcoming-earnings row when available. When the row is missing
 * (MEDIUM tier), we still emit a band based on returns_pct only —
 * with `_anchored: false` so the UI knows to render it as a percentage
 * range, not a price target.
 */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const PRICE_BAND_VERSION = "earnings-bands-v1-2026-05";

// V1 cap: no scenario can claim more than this much one-day move from
// a single result print. Lifted only after backtest validates the
// underlying volatility estimate.
const MAX_BAND_PCT = 15;

/**
 * Estimate one-day post-result volatility as a percentage.
 *
 * Heuristic: half the absolute 1M return is a passable proxy for
 * one-day result-day volatility for Indian large/mid-caps. Stocks
 * with no momentum data fall back to a sector-typical 4%.
 */
function estimateResultDayVolPct(signals) {
  const r1m = num(signals?.momentum?.ret_1m_pct);
  if (r1m != null) {
    return clamp(Math.abs(r1m) * 0.5, 2.5, 12);
  }
  return 4;
}

/**
 * Build Bull/Base/Bear scenarios for one event.
 *
 * @param {{prediction, signals}} event — prediction must already be set
 *                                        by earningsPredictor.
 * @returns {{bull, base, bear, anchored, basis, version}}
 */
export function buildPriceBand(event) {
  const prediction = event?.prediction;
  const signals = event?.signals;

  // No band when we don't have a usable prediction.
  if (!prediction || prediction.verdict === "INSUFFICIENT_DATA") {
    return {
      anchored: false,
      basis: "insufficient_data",
      bull: null,
      base: null,
      bear: null,
      version: PRICE_BAND_VERSION,
    };
  }

  const verdict = prediction.verdict;
  const conf = num(prediction.confidence_pct) ?? 50;
  const vol = estimateResultDayVolPct(signals);
  const upside = num(signals?.upside_pct) ?? 0;

  // Confidence-scaled magnitude. A 50%-conf BEAT call should NOT push
  // bull as hard as a 65%-conf BEAT.
  const confScale = clamp((conf - 40) / 25, 0.4, 1.0);

  // Verdict-directional skew. BEAT pulls the centre upward, MISS down.
  // INLINE keeps centre at zero. The skew is small (≤4%) — V1 should
  // not pretend to know exact magnitudes; the band's job is to set
  // expectation, not predict price to the rupee.
  let skewPct = 0;
  if (verdict === "BEAT") skewPct = 1.5 + Math.min(upside / 25, 2);
  else if (verdict === "MISS") skewPct = -(1.5 + Math.max(-upside / 25, -2));

  // Final scenario percentages (vs current price). Bear and Bull are
  // ±vol around the skewed centre, scaled by confidence.
  const centerPct = skewPct * confScale;
  const bullPct = clamp(centerPct + vol * confScale, -MAX_BAND_PCT, MAX_BAND_PCT);
  const basePct = clamp(centerPct, -MAX_BAND_PCT, MAX_BAND_PCT);
  const bearPct = clamp(centerPct - vol * confScale, -MAX_BAND_PCT, MAX_BAND_PCT);

  const round1 = (x) => Math.round(x * 10) / 10;
  const pctBlock = (pct) => ({ pct: round1(pct), price_inr: null });

  // ── Anchor to a price when SWS has one ──
  const currentPrice = num(signals?.sws_upcoming_earnings?.current_price_inr);
  if (currentPrice == null) {
    return {
      anchored: false,
      basis: `pct_only · vol≈${round1(vol)}% · conf×${round1(confScale)}`,
      current_price_inr: null,
      bull: pctBlock(bullPct),
      base: pctBlock(basePct),
      bear: pctBlock(bearPct),
      version: PRICE_BAND_VERSION,
    };
  }

  const priceFrom = (pct) => Math.round(currentPrice * (1 + pct / 100) * 100) / 100;
  return {
    anchored: true,
    basis: `anchored ₹${currentPrice} · vol≈${round1(vol)}% · conf×${round1(confScale)}`,
    current_price_inr: currentPrice,
    bull: { pct: round1(bullPct), price_inr: priceFrom(bullPct) },
    base: { pct: round1(basePct), price_inr: priceFrom(basePct) },
    bear: { pct: round1(bearPct), price_inr: priceFrom(bearPct) },
    version: PRICE_BAND_VERSION,
  };
}

/**
 * Apply the band builder to every event with a prediction. Returns a
 * new array — never mutates input.
 */
export function buildBandsForCalendar(events) {
  if (!Array.isArray(events)) return [];
  return events.map((e) => ({ ...e, price_band: buildPriceBand(e) }));
}
