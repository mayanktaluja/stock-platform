// Trajectory tracker — ₹1L → ₹5L progress with tax-aware gross/net
// curves + Monte Carlo P(5x) estimator.
//
// Plan §0: "5x net" means ~6x gross under STCG 20% if turnover is high
// (most Pillar 2 + 3 hold <12m). LTCG-only path (Pillar 1 ≥12m) is
// ~12.5% with ₹1.25L exemption so 5x → 5.4x gross. Trajectory shows
// both curves so the user knows which target to optimise against.
//
// Monte Carlo: simulate N draws per position from sector-historical
// return distributions, sum the portfolio, count fraction ≥ 5×. Caller
// can supply the distribution OR fall back to a log-normal default.

const TARGET_MULTIPLE = 5;
const HORIZON_DAYS = 365;
const STCG_RATE = 0.20;
const LTCG_RATE = 0.125;
const LTCG_EXEMPTION_INR = 125_000;
const DEFAULT_SIMS = 1000;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(v, lo, hi) {
  if (!isFiniteNumber(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function daysBetween(aIso, bIso) {
  const a = new Date(aIso);
  const b = new Date(bIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

// Tax-aware: realised gross → net via STCG / LTCG mix.
// stcg_share defaults to 0.5 — caller can refine from churn data.
export function applyTax({ gross_pl_inr, stcg_share = 0.5 } = {}) {
  if (!isFiniteNumber(gross_pl_inr)) return null;
  if (gross_pl_inr <= 0) return gross_pl_inr;
  const stcg = gross_pl_inr * stcg_share;
  const ltcg = gross_pl_inr * (1 - stcg_share);
  const ltcg_taxable = Math.max(0, ltcg - LTCG_EXEMPTION_INR);
  const tax = stcg * STCG_RATE + ltcg_taxable * LTCG_RATE;
  return Number((gross_pl_inr - tax).toFixed(2));
}

// Required gross multiple to net 5× start: solve for target_gross_pl such
// that applyTax(target_gross_pl) = (target_multiple − 1) × starting_capital.
// Closed-form approximation: gross = (5L − exemption × ltcg_rate × (1-s) … too messy).
// Iterate with 50-step bisection in [1×, 12×].
export function requiredGrossMultiple({ starting_capital_inr, target_multiple = TARGET_MULTIPLE, stcg_share = 0.5 } = {}) {
  if (!isFiniteNumber(starting_capital_inr) || starting_capital_inr <= 0) return null;
  const target_net_pl = (target_multiple - 1) * starting_capital_inr;
  let lo = 0, hi = (target_multiple * 2 - 1) * starting_capital_inr;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const net = applyTax({ gross_pl_inr: mid, stcg_share });
    if (net < target_net_pl) lo = mid; else hi = mid;
  }
  const gross_pl = (lo + hi) / 2;
  return Number((1 + gross_pl / starting_capital_inr).toFixed(2));
}

export function projectTrajectory({
  starting_capital_inr,
  current_value_inr,
  started_at_iso,
  today_iso = null,
  target_multiple = TARGET_MULTIPLE,
  horizon_days = HORIZON_DAYS,
  stcg_share = 0.5,
} = {}) {
  if (!isFiniteNumber(starting_capital_inr) || starting_capital_inr <= 0) return null;
  if (!isFiniteNumber(current_value_inr)) return null;
  const today = today_iso || new Date().toISOString().slice(0, 10);
  const days_elapsed = clamp(daysBetween(started_at_iso, today), 0, horizon_days);
  const days_remaining = horizon_days - days_elapsed;

  // Current multiples
  const current_multiple = Number((current_value_inr / starting_capital_inr).toFixed(3));
  const net_pl_inr = current_value_inr - starting_capital_inr;
  // Approximate gross PL: caller already has gross in current_value_inr because
  // paper-book hasn't paid tax. Provide both lines.
  const net_after_tax_inr = applyTax({ gross_pl_inr: net_pl_inr, stcg_share });
  const net_after_tax_value = net_after_tax_inr === null ? null : starting_capital_inr + net_after_tax_inr;
  const net_after_tax_multiple = net_after_tax_value === null ? null : Number((net_after_tax_value / starting_capital_inr).toFixed(3));

  const gross_target_multiple = requiredGrossMultiple({ starting_capital_inr, target_multiple, stcg_share });
  // Required CAGR over remaining horizon
  const remaining_years = Math.max(0.001, days_remaining / 365);
  const elapsed_years = Math.max(0.001, days_elapsed / 365);
  const required_cagr_pct = days_remaining > 0
    ? Number((((Math.pow(gross_target_multiple / current_multiple, 1 / remaining_years) - 1) * 100)).toFixed(2))
    : null;
  // Expected curve at constant required CAGR (linear-in-log)
  const on_pace_multiple = elapsed_years > 0
    ? Number((Math.pow(gross_target_multiple, elapsed_years / 1)).toFixed(3))
    : 1;

  let status = "ON_TRACK";
  if (current_multiple > on_pace_multiple * 1.1) status = "AHEAD";
  else if (current_multiple < on_pace_multiple * 0.85) status = "BEHIND";

  return {
    starting_capital_inr,
    current_value_inr,
    current_multiple,
    target_multiple,
    gross_target_multiple,
    net_after_tax_value_inr: net_after_tax_value,
    net_after_tax_multiple,
    days_elapsed,
    days_remaining,
    required_cagr_pct,
    on_pace_multiple,
    status,
    today_iso: today,
  };
}

// Monte Carlo P(5x): sample N draws of forward-return for each position
// + cash, sum the portfolio, count fraction reaching ≥ target_multiple ×
// starting_capital.
//
// position_distributions: { ticker: { mean_log_return, std_log_return } }
// for log-normal. Defaults: mean=0.20, std=0.60 (small-cap empirics).
export function simulatePofTargetMultiple({
  positions = [],
  cash_inr = 0,
  starting_capital_inr,
  target_multiple = TARGET_MULTIPLE,
  position_distributions = {},
  default_mean = 0.20,
  default_std = 0.60,
  n_sims = DEFAULT_SIMS,
  seed = null,
} = {}) {
  if (!isFiniteNumber(starting_capital_inr) || starting_capital_inr <= 0) return null;
  const targetValue = starting_capital_inr * target_multiple;

  // Simple seeded LCG for reproducibility in tests.
  let s = isFiniteNumber(seed) ? Math.floor(seed) : Math.floor(Math.random() * 1e9);
  function rand() { s = (s * 1664525 + 1013904223) & 0xffffffff; return ((s >>> 0) / 0xffffffff); }
  function randn() {
    const u1 = Math.max(1e-9, rand()), u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  let hit = 0;
  let sumFinal = 0;
  const samples = [];
  for (let i = 0; i < n_sims; i++) {
    let value = cash_inr;
    for (const p of positions) {
      const dist = position_distributions[p.ticker] || {};
      const mean = isFiniteNumber(dist.mean_log_return) ? dist.mean_log_return : default_mean;
      const std = isFiniteNumber(dist.std_log_return) ? dist.std_log_return : default_std;
      const ret = Math.exp(mean + std * randn());
      const baseValue = p.current_value_inr ?? (p.qty * p.avg_entry_price_inr);
      value += baseValue * ret;
    }
    if (value >= targetValue) hit += 1;
    sumFinal += value;
    if (i < 200) samples.push(value); // keep a small sample for percentiles
  }
  samples.sort((a, b) => a - b);
  const pct = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  return {
    p_target_multiple: Number((hit / n_sims).toFixed(4)),
    mean_final_inr: Number((sumFinal / n_sims).toFixed(2)),
    p10_final_inr: pct(0.10),
    p50_final_inr: pct(0.50),
    p90_final_inr: pct(0.90),
    n_sims,
  };
}

export const TRAJECTORY_CONFIG = Object.freeze({
  TARGET_MULTIPLE,
  HORIZON_DAYS,
  STCG_RATE,
  LTCG_RATE,
  LTCG_EXEMPTION_INR,
});
