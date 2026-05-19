// Dynamic sector-tailwind multiplier — replaces a static "Defense=15"
// table with a 3-factor product:
//
//   tailwind_pts(sector) = base_weight(sector)
//                        × regime_multiplier(sector, macro_regime)
//                        × cohort_freshness(sector, ttm_index_return_pct)
//
// Where:
//   - base_weight: sector's intrinsic multibagger affinity (0–17)
//   - regime_multiplier: 0.5–1.0 depending on rate/risk regime
//   - cohort_freshness: 1.0 if TTM return ≤ 40%, 0.5 if 40–80%,
//                       0.0 if >80% (don't buy the top)
//
// The cohort-freshness term codifies the adversarial finding that
// defense-PSU = 15 is recency bias after a 3-year re-rating.

const MAX_PTS = 17;

const BASE_WEIGHTS = Object.freeze({
  "Defense": 17,
  "Renewables": 16,
  "EV": 15,
  "EMS": 15,
  "Railway PSU": 14,
  "Semiconductor": 14,
  "Capital Goods": 12,
  "Real Estate": 10,
  "Auto": 9,
  "Infrastructure": 9,
  "Chemicals": 8,
  "Pharma": 7,
  "IT": 6,
  "Banks": 5,
  "Metals": 5,
  "FMCG": 3,
  "Utilities": 3,
  "Insurance": 4,
  "Telecom": 4,
  "Energy": 6,
  "Textiles": 4,
});

const REGIME_MULTIPLIERS = Object.freeze({
  RISK_ON: {
    DEFAULT: 1.0,
  },
  RISK_OFF: {
    DEFAULT: 0.5,
    "Pharma": 1.0,
    "FMCG": 1.0,
    "Utilities": 1.0,
    "Defense": 0.8,
  },
  RATE_CUT: {
    DEFAULT: 1.0,
    "Capital Goods": 1.2,
    "Real Estate": 1.2,
    "Auto": 1.15,
    "Infrastructure": 1.15,
    "Banks": 1.1,
  },
  RATE_HIKE: {
    DEFAULT: 1.0,
    "Defense": 0.6,
    "Renewables": 0.7,
    "Railway PSU": 0.7,
    "Real Estate": 0.5,
    "NBFC": 0.5,
    "Auto": 0.7,
    "Pharma": 1.1,
    "FMCG": 1.1,
    "IT": 0.8,
  },
});

function cohortFreshness(ttmReturnPct) {
  if (typeof ttmReturnPct !== "number" || !Number.isFinite(ttmReturnPct)) {
    return 1.0; // unknown TTM → treat as fresh (most stocks the user is new to)
  }
  if (ttmReturnPct > 80) return 0.0;
  if (ttmReturnPct > 40) return 0.5;
  return 1.0;
}

function regimeMultiplier(sector, regimeKey) {
  const table = REGIME_MULTIPLIERS[regimeKey];
  if (!table) return 1.0;
  return Object.prototype.hasOwnProperty.call(table, sector) ? table[sector] : table.DEFAULT;
}

function normaliseRegime(r) {
  return String(r || "").toUpperCase();
}

// Returns { pts, base_weight, regime_multiplier, cohort_freshness,
//           cohort_exhausted, reasons }.
export function computeSectorTailwind({ sector, macroRegime, ttmReturnPct = null } = {}) {
  const base = Object.prototype.hasOwnProperty.call(BASE_WEIGHTS, sector) ? BASE_WEIGHTS[sector] : 5;
  const regimeKey = normaliseRegime(macroRegime?.regime);
  const regMul = regimeMultiplier(sector, regimeKey);
  const freshness = cohortFreshness(ttmReturnPct);
  const cohortExhausted = freshness === 0;
  const pts = Math.min(MAX_PTS, Math.round(base * regMul * freshness * 10) / 10);
  const reasons = [];
  if (cohortExhausted) reasons.push(`cohort_exhausted_ttm_${Math.round(ttmReturnPct)}pct`);
  if (freshness === 0.5) reasons.push(`cohort_warm_ttm_${Math.round(ttmReturnPct)}pct`);
  if (regMul !== 1.0) reasons.push(`regime_${regimeKey.toLowerCase()}_mul_${regMul}`);
  return {
    pts,
    base_weight: base,
    regime_multiplier: regMul,
    cohort_freshness: freshness,
    cohort_exhausted: cohortExhausted,
    reasons,
  };
}

export const SECTOR_TAILWIND_CONFIG = Object.freeze({
  MAX_PTS,
  BASE_WEIGHTS,
  REGIME_MULTIPLIERS,
});
