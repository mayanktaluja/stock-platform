/**
 * Risk Metrics — pure-function statistics over price history.
 *
 * Everything here is self-contained and deterministic. Given the same
 * inputs (closes array + benchmark closes array), every function returns
 * the same number. No I/O, no side effects.
 *
 * Convention:
 *   • "returns" means daily simple returns (P_t − P_{t−1}) / P_{t−1}
 *   • Vol, Sharpe, VaR are annualised using 252 trading days unless
 *     otherwise documented
 *   • Max drawdown is a NEGATIVE number (e.g. −0.32 = −32%)
 *   • Historical VaR is the loss at the given quantile (also negative)
 *   • Correlations are Pearson
 *
 * These primitives feed the portfolio-level risk block and the stress
 * test in portfolioAnalyzer.js.
 */

// ──────────────────── Basic stats ────────────────────

export function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

export function stdev(arr, m = null) {
  if (!arr || arr.length < 2) return 0;
  const avg = m ?? mean(arr);
  let sumSq = 0;
  for (const x of arr) sumSq += (x - avg) * (x - avg);
  return Math.sqrt(sumSq / (arr.length - 1));
}

export function covariance(xs, ys, mx = null, my = null) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const ax = mx ?? mean(xs);
  const ay = my ?? mean(ys);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (xs[i] - ax) * (ys[i] - ay);
  return sum / (n - 1);
}

// ──────────────────── Returns ────────────────────

/**
 * Daily simple returns from a closes array. Returns length = closes.length − 1.
 * Discards non-finite values to prevent NaN propagation.
 */
export function dailyReturns(closes) {
  const out = [];
  if (!closes || closes.length < 2) return out;
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0) continue;
    out.push((cur - prev) / prev);
  }
  return out;
}

// ──────────────────── Beta (vs. benchmark) ────────────────────

/**
 * Beta of a return series against a benchmark. Aligns both series from
 * the right (most recent bars) to the shorter length. Returns `null` if
 * there's not enough data (need at least 30 aligned return observations)
 * or if benchmark variance is zero.
 */
export function computeBeta(stockReturns, benchReturns) {
  const n = Math.min(stockReturns.length, benchReturns.length);
  if (n < 30) return null;
  const s = stockReturns.slice(-n);
  const b = benchReturns.slice(-n);
  const mS = mean(s);
  const mB = mean(b);
  const cov = covariance(s, b, mS, mB);
  const sdB = stdev(b, mB);
  const varB = sdB * sdB;
  if (varB === 0) return null;
  return cov / varB;
}

// ──────────────────── Drawdown ────────────────────

/**
 * Maximum drawdown over a closes series. Returns a NEGATIVE number (or 0
 * for a monotonically non-decreasing series).
 */
export function maxDrawdown(closes) {
  if (!closes || closes.length === 0) return 0;
  let peak = closes[0];
  let maxDD = 0;
  for (const c of closes) {
    if (!Number.isFinite(c)) continue;
    if (c > peak) peak = c;
    if (peak <= 0) continue;
    const dd = (c - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD;
}

// ──────────────────── Historical VaR ────────────────────

/**
 * Historical Value at Risk — the alpha-quantile daily return.
 * Returns a NEGATIVE number (e.g. −0.032 = losing 3.2% on the worst 5% day).
 * Default alpha = 0.05 (95% VaR).
 */
export function historicalVaR(returns, alpha = 0.05) {
  if (!returns || returns.length === 0) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(alpha * sorted.length)));
  return sorted[idx];
}

// ──────────────────── Annualised metrics ────────────────────

export const TRADING_DAYS = 252;

/**
 * Annualised volatility (stdev of daily returns × √252).
 */
export function annualizedVolatility(returns) {
  return stdev(returns) * Math.sqrt(TRADING_DAYS);
}

/**
 * Annualised Sharpe ratio with a default India 10Y ≈ 6.5% risk-free rate.
 * Returns null if volatility is 0 (no dispersion = undefined ratio).
 */
export function sharpeRatio(returns, riskFreeAnnual = 0.065) {
  if (!returns || returns.length < 30) return null;
  const annReturn = mean(returns) * TRADING_DAYS;
  const annVol = annualizedVolatility(returns);
  if (annVol === 0) return null;
  return (annReturn - riskFreeAnnual) / annVol;
}

// ──────────────────── Portfolio-level aggregation ────────────────────

/**
 * Build a weighted portfolio return series from per-holding return arrays
 * and weights (which should sum to 1 over the holdings present).
 * Aligns all return series from the right and drops weights whose series
 * are empty.
 */
export function portfolioReturnSeries(holdingReturns, weights) {
  const valid = [];
  for (let i = 0; i < holdingReturns.length; i++) {
    if (holdingReturns[i] && holdingReturns[i].length > 0) {
      valid.push({ r: holdingReturns[i], w: weights[i] });
    }
  }
  if (valid.length === 0) return [];
  const n = Math.min(...valid.map((v) => v.r.length));
  if (n === 0) return [];
  // Renormalize weights over the kept subset so they sum to 1
  const wSum = valid.reduce((s, v) => s + v.w, 0);
  if (wSum <= 0) return [];
  const out = new Array(n).fill(0);
  for (const { r, w } of valid) {
    const aligned = r.slice(-n);
    const nw = w / wSum;
    for (let j = 0; j < n; j++) out[j] += aligned[j] * nw;
  }
  return out;
}

// ──────────────────── Correlation matrix ────────────────────

/**
 * Pearson correlation matrix of N return series. Diagonal = 1.
 * Series are aligned from the right before correlating.
 * Returns an N×N matrix (array of arrays).
 */
export function correlationMatrix(returnsList) {
  const n = returnsList.length;
  if (n === 0) return [];
  const len = Math.min(...returnsList.map((r) => r.length || 0));
  if (len < 2) {
    // Not enough overlap — return identity
    return Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
    );
  }
  const aligned = returnsList.map((r) => r.slice(-len));
  const means = aligned.map((a) => mean(a));
  const stds = aligned.map((a, i) => stdev(a, means[i]));
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    m[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const cov = covariance(aligned[i], aligned[j], means[i], means[j]);
      const denom = stds[i] * stds[j];
      const corr = denom > 0 ? cov / denom : 0;
      m[i][j] = corr;
      m[j][i] = corr;
    }
  }
  return m;
}

/**
 * Average pairwise correlation (off-diagonal upper triangle). A useful
 * single number for "how diversified is this book really?" — 1.0 means
 * everything moves together, 0 means uncorrelated.
 */
export function averagePairwiseCorrelation(corrMatrix) {
  const n = corrMatrix.length;
  if (n < 2) return null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      sum += corrMatrix[i][j];
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

// ──────────────────── Stress tests ────────────────────

/**
 * Project a portfolio value change under a broad-market shock using the
 * CAPM-style relation: stock return ≈ beta × market return.
 *
 * @param {Array<{beta:number|null, currentValue:number}>} holdings
 * @param {number} marketShock - decimal, e.g. −0.20 for a −20% Nifty move
 * @returns {{projectedLossPct:number, projectedLossAmount:number, coveredValue:number}}
 *
 * For holdings with no beta, we assume beta = 1 (neutral) to avoid
 * under-stating risk — a brand-new listing without a history is usually
 * as volatile as the index, not less.
 */
export function stressScenario(holdings, marketShock) {
  let shockedValue = 0;
  let baseValue = 0;
  for (const h of holdings) {
    if (!Number.isFinite(h.currentValue) || h.currentValue <= 0) continue;
    const beta = Number.isFinite(h.beta) ? h.beta : 1;
    baseValue += h.currentValue;
    shockedValue += h.currentValue * (1 + beta * marketShock);
  }
  const projectedLossAmount = shockedValue - baseValue;
  const projectedLossPct = baseValue > 0 ? (projectedLossAmount / baseValue) * 100 : 0;
  return { projectedLossPct, projectedLossAmount, coveredValue: baseValue };
}
