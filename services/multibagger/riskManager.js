// Risk manager — tier-aware stops + portfolio drawdown circuit breakers.
//
// Original -20% absolute stop killed every Indian 10-bagger journey
// (median MDD ~56% across 2018-24 multibaggers per the research). This
// module replaces it with:
//   - Anchor/High: max(-2.5 × ATR, -35%)
//   - Conviction: -25%
//   - Catalyst (≤21d hold): -8% to -10%
//   - Sector tilt (ETF): -20%
//
// Plus a trailing ratchet that raises the stop as the position runs:
//   - +50%: stop → -10% from entry
//   - +100%: stop → -30% from running peak
//   - +200%: stop → -35% from peak
//   - +500%: trim 50%, trail rest at -40%
//
// Portfolio-level circuit breakers fire on cumulative drawdown from peak.

import { tierStopPrice } from "./atrCalculator.js";

export const TIER_STOPS = Object.freeze({
  anchor: { atr_mult: 2.5, absolute_floor_pct: 0.35 },
  high: { atr_mult: 2.5, absolute_floor_pct: 0.35 },
  conviction: { atr_mult: null, absolute_floor_pct: 0.25 },
  catalyst: { atr_mult: null, absolute_floor_pct: 0.08 },
  sector: { atr_mult: null, absolute_floor_pct: 0.20 },
});

export const CIRCUIT_BREAKERS = Object.freeze({
  PAUSE_ENTRIES: 0.25,
  TRIM_CATALYST_SECTOR: 0.35,
  FAILSAFE_NIFTYBEES: 0.40,
  SINGLE_DAY_FLASH: 0.10,
});

const TRAILING_BANDS = [
  { trigger_gain: 5.00, stop_pct_from_peak: 0.40, trim_pct: 0.50 },
  { trigger_gain: 2.00, stop_pct_from_peak: 0.35 },
  { trigger_gain: 1.00, stop_pct_from_peak: 0.30 },
  { trigger_gain: 0.50, stop_pct_from_entry: -0.10 },
];

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// Initial stop at entry for a given tier.
export function initialStopPrice({ entry_price_inr, tier, atr }) {
  if (!isFiniteNumber(entry_price_inr) || entry_price_inr <= 0) return null;
  const cfg = TIER_STOPS[tier];
  if (!cfg) return null;
  if (cfg.atr_mult && isFiniteNumber(atr) && atr > 0) {
    return tierStopPrice({
      entryPrice: entry_price_inr,
      atr,
      atrMultiplier: cfg.atr_mult,
      absoluteFloorPct: cfg.absolute_floor_pct,
    });
  }
  return Number((entry_price_inr * (1 - cfg.absolute_floor_pct)).toFixed(2));
}

// Trailing stop given the running peak. Returns { stop_price_inr,
// band_label, recommended_trim_pct }.
export function trailingStopPrice({ entry_price_inr, peak_price_inr, tier, atr }) {
  if (!isFiniteNumber(entry_price_inr) || !isFiniteNumber(peak_price_inr)) {
    return { stop_price_inr: null, band_label: "invalid", recommended_trim_pct: 0 };
  }
  if (peak_price_inr < entry_price_inr) {
    // Position underwater — return the initial stop.
    return {
      stop_price_inr: initialStopPrice({ entry_price_inr, tier, atr }),
      band_label: "underwater",
      recommended_trim_pct: 0,
    };
  }
  const gain_multiple = (peak_price_inr - entry_price_inr) / entry_price_inr;
  for (const band of TRAILING_BANDS) {
    if (gain_multiple >= band.trigger_gain) {
      if (isFiniteNumber(band.stop_pct_from_peak)) {
        return {
          stop_price_inr: Number((peak_price_inr * (1 - band.stop_pct_from_peak)).toFixed(2)),
          band_label: `+${Math.round(band.trigger_gain * 100)}%_peak_-${Math.round(band.stop_pct_from_peak * 100)}%`,
          recommended_trim_pct: band.trim_pct || 0,
        };
      }
      if (isFiniteNumber(band.stop_pct_from_entry)) {
        return {
          stop_price_inr: Number((entry_price_inr * (1 + band.stop_pct_from_entry)).toFixed(2)),
          band_label: `+${Math.round(band.trigger_gain * 100)}%_entry_${band.stop_pct_from_entry >= 0 ? "+" : ""}${Math.round(band.stop_pct_from_entry * 100)}%`,
          recommended_trim_pct: 0,
        };
      }
    }
  }
  return {
    stop_price_inr: initialStopPrice({ entry_price_inr, tier, atr }),
    band_label: "initial",
    recommended_trim_pct: 0,
  };
}

// Per-position state: returns { stop_price_inr, breached, action, gain_pct,
// recommended_trim_pct, band_label }.
export function evaluatePosition({
  entry_price_inr,
  current_price_inr,
  peak_price_inr,
  tier,
  atr,
}) {
  if (!isFiniteNumber(entry_price_inr) || !isFiniteNumber(current_price_inr)) {
    return { stop_price_inr: null, breached: false, action: "invalid", gain_pct: null, recommended_trim_pct: 0, band_label: "invalid" };
  }
  const peak = isFiniteNumber(peak_price_inr) ? peak_price_inr : Math.max(entry_price_inr, current_price_inr);
  const trail = trailingStopPrice({ entry_price_inr, peak_price_inr: peak, tier, atr });
  const gain_pct = Number((((current_price_inr - entry_price_inr) / entry_price_inr) * 100).toFixed(2));
  const breached = isFiniteNumber(trail.stop_price_inr) && current_price_inr <= trail.stop_price_inr;
  let action = "hold";
  if (breached) action = "exit_stop";
  else if (trail.recommended_trim_pct > 0) action = `trim_${Math.round(trail.recommended_trim_pct * 100)}pct`;
  return {
    stop_price_inr: trail.stop_price_inr,
    breached,
    action,
    gain_pct,
    recommended_trim_pct: trail.recommended_trim_pct,
    band_label: trail.band_label,
  };
}

// Portfolio-level circuit breaker. peak_value is the running max
// portfolio value since inception; current_value is today's mark.
// daily_pl_pct (optional) flags single-day flash crashes.
export function evaluatePortfolioRisk({ current_value_inr, peak_value_inr, daily_pl_pct = null } = {}) {
  if (!isFiniteNumber(current_value_inr) || !isFiniteNumber(peak_value_inr) || peak_value_inr <= 0) {
    return { state: "UNKNOWN", drawdown_pct: null, actions: [] };
  }
  const drawdown_pct = Number((((current_value_inr - peak_value_inr) / peak_value_inr) * 100).toFixed(2));
  const dd_mag = -drawdown_pct / 100;
  const actions = [];
  let state = "GREEN";
  if (dd_mag >= CIRCUIT_BREAKERS.FAILSAFE_NIFTYBEES) {
    state = "RED";
    actions.push("failsafe_pivot_to_niftybees_and_cash");
  } else if (dd_mag >= CIRCUIT_BREAKERS.TRIM_CATALYST_SECTOR) {
    state = "AMBER";
    actions.push("liquidate_catalyst_and_sector_tilt");
    actions.push("concentrate_to_anchor_high_only");
  } else if (dd_mag >= CIRCUIT_BREAKERS.PAUSE_ENTRIES) {
    state = "YELLOW";
    actions.push("pause_new_entries_7d");
    actions.push("defensive_review");
  }
  if (isFiniteNumber(daily_pl_pct) && daily_pl_pct <= -CIRCUIT_BREAKERS.SINGLE_DAY_FLASH * 100) {
    actions.push("flash_crash_audit_flag");
    actions.push("freeze_entries_48h");
  }
  return { state, drawdown_pct, actions };
}
