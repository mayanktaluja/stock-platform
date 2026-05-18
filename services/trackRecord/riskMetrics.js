// SEBI 10/10 — per-section risk-adjusted metrics. Pure functions, zero deps.
// Inputs are trade arrays carrying returns_by_horizon (V2 schema). Outputs:
// Sharpe (annualised), Sortino (annualised), max drawdown %, VaR(95%).
//
// Conventions:
//   • Risk-free rate: 0 (paper-trade environment; matches SEBI scorecard
//     practice for hypothetical performance).
//   • Annualisation factor: sqrt(252) for trading-day returns; the input
//     stream here is per-horizon (1m/3m/6m/12m) — we derive a per-trade
//     "annualised period return" and treat each as one sample. This is
//     less rigorous than a daily-return Sharpe but is the right metric
//     for a sparse paper-trade ledger where horizons matter more than
//     time-series continuity.
//   • Degenerate cases (n<3, zero variance, all positive): return null
//     for the offending field rather than NaN/Infinity. The UI treats
//     null as "—".

const ANNUALISATION = {
  "1m": 12,
  "3m": 4,
  "6m": 2,
  "12m": 1,
  "t1": 252, // T+1 earnings — treat as a single trading day
};

function annualisedFromHorizon(returnPct, horizonKey) {
  const factor = ANNUALISATION[horizonKey];
  if (!factor || returnPct == null || !Number.isFinite(returnPct)) return null;
  // Geometric annualisation: (1 + r/100)^factor - 1, expressed in %
  return (Math.pow(1 + returnPct / 100, factor) - 1) * 100;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr, mu) {
  if (arr.length < 2) return null;
  const variance = arr.reduce((s, x) => s + (x - mu) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function downsideStdev(arr, target = 0) {
  const downside = arr.filter((x) => x < target);
  if (downside.length < 2) return null;
  // Use target as the reference, not mean — Sortino convention
  const variance = downside.reduce((s, x) => s + (x - target) ** 2, 0) / (downside.length - 1);
  return Math.sqrt(variance);
}

function maxDrawdownPct(returnsPctSeries) {
  if (returnsPctSeries.length < 2) return null;
  let cumulative = 100;
  let peak = 100;
  let maxDD = 0;
  for (const r of returnsPctSeries) {
    cumulative *= 1 + r / 100;
    if (cumulative > peak) peak = cumulative;
    const dd = ((cumulative - peak) / peak) * 100;
    if (dd < maxDD) maxDD = dd;
  }
  return +maxDD.toFixed(2);
}

function var95(returnsPctSeries) {
  if (returnsPctSeries.length < 5) return null;
  const sorted = [...returnsPctSeries].sort((a, b) => a - b);
  const idx = Math.floor(0.05 * sorted.length);
  return +sorted[idx].toFixed(2);
}

/**
 * Compute risk metrics for one section's resolved trades.
 *
 * @param {Array} sectionTrades - trades belonging to one section, V2 shape
 *   (with returns_by_horizon and a primary horizon to read from).
 * @param {string} primaryHorizon - "1m" | "3m" | "6m" | "12m" | "t1"
 * @returns {{sharpe:number|null, sortino:number|null, max_drawdown_pct:number|null, var_95_pct:number|null, n_observations:number}}
 */
export function computeSectionRiskMetrics(sectionTrades, primaryHorizon = "3m") {
  if (!Array.isArray(sectionTrades) || sectionTrades.length === 0) {
    return { sharpe: null, sortino: null, max_drawdown_pct: null, var_95_pct: null, n_observations: 0 };
  }
  // Extract annualised returns for the primary horizon (or t1 fallback).
  const annualised = [];
  for (const t of sectionTrades) {
    const h = (t.returns_by_horizon && t.returns_by_horizon[primaryHorizon]) ||
              (t.returns_by_horizon && t.returns_by_horizon.t1);
    if (!h || h.return_pct == null) continue;
    const a = annualisedFromHorizon(h.return_pct, primaryHorizon in ANNUALISATION ? primaryHorizon : "t1");
    if (a != null && Number.isFinite(a)) annualised.push(a);
  }
  const n = annualised.length;
  if (n < 3) {
    return { sharpe: null, sortino: null, max_drawdown_pct: null, var_95_pct: null, n_observations: n };
  }
  const mu = mean(annualised);
  const sigma = stdev(annualised, mu);
  const dsigma = downsideStdev(annualised, 0);
  // Risk-free = 0 (paper-trade convention)
  const sharpe = sigma && sigma > 0 ? +(mu / sigma).toFixed(2) : null;
  const sortino = dsigma && dsigma > 0 ? +(mu / dsigma).toFixed(2) : null;
  // Drawdown uses RAW per-trade returns (not annualised) ordered by snapshot.
  // The caller passes ordered trades; we re-read raw return_pct here.
  const rawSeries = sectionTrades
    .filter((t) => t.returns_by_horizon?.[primaryHorizon]?.return_pct != null)
    .sort((a, b) => new Date(a.snapshotAt) - new Date(b.snapshotAt))
    .map((t) => t.returns_by_horizon[primaryHorizon].return_pct);
  const mdd = maxDrawdownPct(rawSeries);
  const v95 = var95(rawSeries);
  return {
    sharpe,
    sortino,
    max_drawdown_pct: mdd,
    var_95_pct: v95,
    n_observations: n,
  };
}
