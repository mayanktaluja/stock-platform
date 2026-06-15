import { reconcileFairValue } from "./fvReconciliation.js";

export const ENTRY_BAND_VERSION = "sws-entry-band-v1-2026-06";
export const MIN_ACTIONABLE_MCAP_INR = 5_000_000_000;
export const MIN_ACTIONABLE_V4_SCORE = 47;
export const MIN_ACTIONABLE_SNOWFLAKE = 18;
export const MIN_ACTIONABLE_UPSIDE_PCT = 10;
export const MAX_ACTIONABLE_UPSIDE_PCT = 150;
export const ACTIONABLE_FRESH_HOURS = 96;

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v, fallback = 0) => (isFiniteNumber(v) ? v : fallback);
const round2 = (v) => (isFiniteNumber(v) ? Math.round(v * 100) / 100 : null);

export function swsFundamentalsSubtotal(stock = {}) {
  const b = stock.v4_breakdown || {};
  return num(b.pts_health) + num(b.pts_future) + num(b.pts_valuation) + num(b.pts_past) + num(b.pts_fv_total);
}

function tickerSortValue(stock = {}) {
  return String(stock.ticker || stock.name || "").toUpperCase();
}

function actionabilityFvRank(stock = {}) {
  const fv = reconcileFairValue(stock.overview || {});
  if (fv.fair_value_confidence === "HIGH" && fv.fv_reconcile_reason === "ok" && isFiniteNumber(fv.upside_pct)) {
    if (fv.upside_pct > 0 && fv.upside_pct <= MAX_ACTIONABLE_UPSIDE_PCT) return 3;
    return 2;
  }
  if (fv.fair_value_confidence === "HIGH" && fv.fv_reconcile_reason === "ok_sws_raw_fv") return 1;
  return 0;
}

function saneUpsideForRank(stock = {}) {
  const upside = reconcileFairValue(stock.overview || {}).upside_pct;
  return isFiniteNumber(upside) && upside > 0 && upside <= MAX_ACTIONABLE_UPSIDE_PCT ? upside : -Infinity;
}

export function compareIndiaSectionRank(a = {}, b = {}) {
  return num(b.v4_score_100 ?? b.v4_score) - num(a.v4_score_100 ?? a.v4_score)
    || swsFundamentalsSubtotal(b) - swsFundamentalsSubtotal(a)
    || actionabilityFvRank(b) - actionabilityFvRank(a)
    || saneUpsideForRank(b) - saneUpsideForRank(a)
    || num(b.overview?.market_cap_inr ?? b.market_cap_inr) - num(a.overview?.market_cap_inr ?? a.market_cap_inr)
    || tickerSortValue(a).localeCompare(tickerSortValue(b));
}

function surveillanceFlag(stock = {}) {
  return stock.regulatory_flags?.surveillance ||
    stock.risk_overlay?.surveillance ||
    stock.v4_breakdown?.surveillance ||
    stock.v2_breakdown?.surveillance ||
    null;
}

function dataAgeHours(stock = {}, now = new Date()) {
  const raw = stock.parsed_at || stock.data_freshness_at || stock.overview?.parsed_at || null;
  const t = raw ? new Date(raw).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / 3600000;
}

function pushReason(reasons, code, message) {
  reasons.push({ code, message });
}

export function buildEntryBand(stock = {}, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const ov = stock.overview || {};
  const fv = reconcileFairValue(ov);
  const price = ov.current_price_inr;
  const fairValue = fv.fair_value_inr;
  const upside = fv.upside_pct;
  const reasons = [];

  if (!isFiniteNumber(price) || price <= 0) pushReason(reasons, "price_missing", "Current price unavailable.");
  if (!isFiniteNumber(fairValue) || fairValue <= 0) pushReason(reasons, "fair_value_missing", "SWS fair value unavailable.");
  if (fv.fair_value_confidence !== "HIGH") pushReason(reasons, "fv_low_confidence", "Fair value confidence is not high.");
  if (fv.fv_reconcile_reason === "ok_sws_raw_fv") pushReason(reasons, "fv_outlier", "SWS fair value is outside the normal price/FV telemetry band.");
  if (!isFiniteNumber(upside) || upside <= 0) pushReason(reasons, "upside_not_positive", "No positive fair-value upside.");
  if (isFiniteNumber(upside) && upside > MAX_ACTIONABLE_UPSIDE_PCT) pushReason(reasons, "upside_outlier", `Upside is above the ${MAX_ACTIONABLE_UPSIDE_PCT}% actionability cap.`);
  if (isFiniteNumber(upside) && upside > 0 && upside < MIN_ACTIONABLE_UPSIDE_PCT) pushReason(reasons, "upside_too_small", `Upside is below the ${MIN_ACTIONABLE_UPSIDE_PCT}% fresh-buy floor.`);

  const mcap = ov.market_cap_inr;
  if (!isFiniteNumber(mcap) || mcap < MIN_ACTIONABLE_MCAP_INR) pushReason(reasons, "market_cap_below_floor", "Market cap is below the Best Stocks to Buy Now liquidity floor.");
  const surv = surveillanceFlag(stock);
  if (surv?.list === "GSM") pushReason(reasons, "surveillance_gsm", "NSE GSM surveillance flag blocks fresh buys.");
  if (surv?.list === "ASM") pushReason(reasons, "surveillance_asm", "NSE ASM surveillance flag blocks fresh buys.");

  const ageHours = dataAgeHours(stock, now);
  if (ageHours == null) pushReason(reasons, "freshness_missing", "Deep-scrape freshness timestamp unavailable.");
  else if (ageHours > ACTIONABLE_FRESH_HOURS) pushReason(reasons, "data_stale", `Deep-scrape data is older than ${ACTIONABLE_FRESH_HOURS} hours.`);

  const v4 = num(stock.v4_score_100 ?? stock.v4_score, null);
  if (!isFiniteNumber(v4) || v4 < MIN_ACTIONABLE_V4_SCORE) pushReason(reasons, "score_below_floor", "V4 score is below the Best Stocks to Buy Now floor.");
  const snow = ov.snowflake_total;
  if (!isFiniteNumber(snow) || snow < MIN_ACTIONABLE_SNOWFLAKE) pushReason(reasons, "snowflake_below_floor", "Snowflake total is below the Best Stocks to Buy Now floor.");

  const available = isFiniteNumber(price) && price > 0 && isFiniteNumber(fairValue) && fairValue > 0;
  const buyZoneLow = available ? round2(fairValue * 0.75) : null;
  const buyZoneHigh = available ? round2(fairValue * 0.85) : null;
  const noBuyAbove = available ? round2(fairValue * 0.90) : null;
  let entryState = "UNAVAILABLE";
  if (available) {
    if (price <= buyZoneHigh) entryState = "BUY_ZONE";
    else if (price <= noBuyAbove) entryState = "STAGGER_ONLY";
    else entryState = "NO_BUY_ABOVE";
  }
  if (entryState === "NO_BUY_ABOVE") pushReason(reasons, "above_no_buy_cap", "Current price is above the no-buy-above band.");

  const hardCodes = new Set(reasons.map((r) => r.code));
  const freshBuyEligible = available &&
    (entryState === "BUY_ZONE" || entryState === "STAGGER_ONLY") &&
    ![
      "fv_low_confidence",
      "fv_outlier",
      "upside_not_positive",
      "upside_outlier",
      "upside_too_small",
      "market_cap_below_floor",
      "surveillance_gsm",
      "surveillance_asm",
      "data_stale",
      "freshness_missing",
      "score_below_floor",
      "snowflake_below_floor",
    ].some((code) => hardCodes.has(code));

  return {
    version: ENTRY_BAND_VERSION,
    available,
    entry_state: entryState,
    fresh_buy_eligible: freshBuyEligible,
    current_price_inr: isFiniteNumber(price) ? price : null,
    fair_value_inr: isFiniteNumber(fairValue) ? fairValue : null,
    upside_pct: isFiniteNumber(upside) ? upside : null,
    buy_zone_low_inr: buyZoneLow,
    buy_zone_high_inr: buyZoneHigh,
    no_buy_above_inr: noBuyAbove,
    pullback_below_inr: buyZoneHigh,
    data_age_hours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
    reasons,
  };
}

export function isActionableTodayCandidate(stock = {}, opts = {}) {
  return buildEntryBand(stock, opts).fresh_buy_eligible === true;
}

export function buildActionableTodayAudit(stocks = [], items = [], opts = {}) {
  const candidates = stocks.filter((s) => isActionableTodayCandidate(s, opts)).length;
  return {
    available: items.length > 0,
    reason: items.length > 0 ? "ok" : "strict_actionability_no_candidates",
    policy_version: ENTRY_BAND_VERSION,
    candidate_count: candidates,
    selected_count: items.length,
    min_market_cap_inr: MIN_ACTIONABLE_MCAP_INR,
    min_v4_score: MIN_ACTIONABLE_V4_SCORE,
    min_snowflake_total: MIN_ACTIONABLE_SNOWFLAKE,
    min_upside_pct: MIN_ACTIONABLE_UPSIDE_PCT,
    max_actionable_upside_pct: MAX_ACTIONABLE_UPSIDE_PCT,
    freshness_hours: ACTIONABLE_FRESH_HOURS,
    ui_warning_label: items.length > 0 ? null : "No fresh-buy candidates",
    ui_warning_message: items.length > 0
      ? null
      : "No stocks cleared the fair-value, freshness, liquidity, and surveillance gates for Best Stocks to Buy Now.",
  };
}

export default {
  buildActionableTodayAudit,
  buildEntryBand,
  compareIndiaSectionRank,
  isActionableTodayCandidate,
  swsFundamentalsSubtotal,
};
