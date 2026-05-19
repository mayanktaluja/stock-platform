// 30-day average daily value gate — auto-PASS a candidate if exiting
// the position would move the book. Hard gate: position must be ≤ 1/5
// of the stock's 30d ADV in ₹.
//
// Prevents the failsafe (§5.2 of the plan) from getting trapped in
// micro-caps that can't absorb a same-day exit at -40% portfolio
// drawdown.

const ADV_MULTIPLE_FLOOR = 5;
const MIN_ADV_INR = 50_000; // ₹50k absolute floor — below this we can't size anything

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// Verdict shape: { pass, reason, adv_inr_30d, headroom_multiple }.
// `adv_inr_30d` may be null when the stock lacks volume data — we then
// FAIL closed unless `allow_unknown` is true.
export function evaluateLiquidity({ position_size_inr, adv_inr_30d, allow_unknown = false } = {}) {
  if (!isFiniteNumber(position_size_inr) || position_size_inr <= 0) {
    return { pass: false, reason: "invalid_position_size", adv_inr_30d: null, headroom_multiple: null };
  }
  if (!isFiniteNumber(adv_inr_30d)) {
    if (allow_unknown) {
      return { pass: true, reason: "adv_unknown_allowed", adv_inr_30d: null, headroom_multiple: null };
    }
    return { pass: false, reason: "adv_unknown", adv_inr_30d: null, headroom_multiple: null };
  }
  if (adv_inr_30d < MIN_ADV_INR) {
    return { pass: false, reason: "adv_below_floor", adv_inr_30d, headroom_multiple: null };
  }
  const required = position_size_inr * ADV_MULTIPLE_FLOOR;
  const headroom = adv_inr_30d / position_size_inr;
  if (adv_inr_30d < required) {
    return {
      pass: false,
      reason: `adv_${Math.round(headroom * 10) / 10}x_lt_${ADV_MULTIPLE_FLOOR}x_position`,
      adv_inr_30d,
      headroom_multiple: Number(headroom.toFixed(2)),
    };
  }
  return {
    pass: true,
    reason: "ok",
    adv_inr_30d,
    headroom_multiple: Number(headroom.toFixed(2)),
  };
}

// Derive ADV from SWS overview when available. Returns null if any
// required field is missing or non-finite. SWS reports
// average_daily_volume_30d (shares); we multiply by current price.
export function deriveAdvFromSws(overview) {
  if (!overview || typeof overview !== "object") return null;
  const vol = overview.average_daily_volume_30d;
  const price = overview.last_close_inr ?? overview.current_price_inr;
  if (!isFiniteNumber(vol) || vol <= 0) return null;
  if (!isFiniteNumber(price) || price <= 0) return null;
  return Number((vol * price).toFixed(0));
}

export const LIQUIDITY_GATE_CONFIG = Object.freeze({
  ADV_MULTIPLE_FLOOR,
  MIN_ADV_INR,
});
