/**
 * Regression tests for riskMetrics.js
 *
 * Run with: node test/riskMetrics.test.mjs
 *
 * Covers the statistical primitives that feed the portfolio-level risk
 * block and the CAPM-style stress scenarios in portfolioAnalyzer.js:
 * beta, max drawdown, historical VaR, correlation matrix, and the stress
 * projection. No external deps — pure math against hand-chosen inputs.
 */

import {
  computeBeta,
  maxDrawdown,
  historicalVaR,
  stressScenario,
  averagePairwiseCorrelation,
  correlationMatrix,
  dailyReturns,
  annualizedVolatility,
} from "../riskMetrics.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", name);
  } else {
    fail++;
    console.log("  \u2717", name, "\u2192 got", got);
  }
}

console.log("riskMetrics.js regression\n");

// ──── beta identity: if stock = 2 × benchmark, beta must be exactly 2 ────
{
  const market = Array.from({ length: 60 }, (_, i) => Math.sin(i / 5) * 0.01);
  const stock = market.map((r) => r * 2);
  const beta = computeBeta(stock, market);
  assert("beta identity = 2.00", Math.abs(beta - 2) < 0.01, beta);
}

// ──── beta guards: <30 samples → null ────
{
  const short = [0.01, -0.02, 0.03];
  assert(
    "beta returns null for <30 samples",
    computeBeta(short, short) === null,
    computeBeta(short, short),
  );
}

// ──── max drawdown: 120 → 50 = -58.33% (returned as decimal) ────
{
  const dd = maxDrawdown([100, 120, 80, 90, 50, 60]);
  assert("max DD -0.5833 (decimal form)", Math.abs(dd - -0.5833) < 0.01, dd);
}

// ──── max drawdown: monotonically rising series = 0 ────
{
  const dd = maxDrawdown([100, 101, 102, 103]);
  assert("max DD of rising series = 0", dd === 0, dd);
}

// ──── historical VaR: 5%-quantile of 10 sorted returns = sorted[0] = worst day ────
{
  const returns = [-0.05, -0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04, 0.05];
  const var05 = historicalVaR(returns, 0.05);
  assert("VaR alpha=0.05 = -0.05", Math.abs(var05 - -0.05) < 0.001, var05);
}

// ──── correlation: identical rising series → 1.0 ────
{
  const m = correlationMatrix([
    [1, 2, 3, 4, 5],
    [2, 3, 4, 5, 6],
  ]);
  const corr = averagePairwiseCorrelation(m);
  assert("corr identical series = 1.0", Math.abs(corr - 1) < 0.001, corr);
}

// ──── correlation: opposite-direction series → -1.0 ────
{
  const m = correlationMatrix([
    [1, 2, 3, 4, 5],
    [5, 4, 3, 2, 1],
  ]);
  const corr = averagePairwiseCorrelation(m);
  assert("corr inverse series = -1.0", Math.abs(corr - -1) < 0.001, corr);
}

// ──── CAPM stress: beta=1, -10% shock → portfolio -10% exactly ────
{
  const s = stressScenario([{ beta: 1, currentValue: 100 }], -0.1);
  assert(
    "CAPM stress beta=1 shock=-10% -> -10.00%",
    Math.abs(s.projectedLossPct - -10) < 0.001,
    s.projectedLossPct,
  );
}

// ──── CAPM stress: mixed betas weighted, beta avg=1 → shock passes through ────
{
  const s = stressScenario(
    [
      { beta: 1.5, currentValue: 100 },
      { beta: 0.5, currentValue: 100 },
    ],
    -0.2,
  );
  assert(
    "CAPM stress weighted avg beta=1 shock=-20% -> -20.00%",
    Math.abs(s.projectedLossPct - -20) < 0.001,
    s.projectedLossPct,
  );
}

// ──── CAPM stress: missing beta defaults to 1 (conservative) ────
{
  const s = stressScenario([{ beta: null, currentValue: 100 }], -0.3);
  assert(
    "CAPM stress null beta defaults to 1 -> -30.00%",
    Math.abs(s.projectedLossPct - -30) < 0.001,
    s.projectedLossPct,
  );
}

// ──── dailyReturns: basic integrity ────
{
  const rs = dailyReturns([100, 110, 99]);
  assert(
    "dailyReturns [100,110,99] = [0.10, -0.10]",
    Math.abs(rs[0] - 0.1) < 1e-9 && Math.abs(rs[1] - -0.1) < 1e-9,
    rs,
  );
}

// ──── annualizedVolatility: scales stdev by sqrt(252) ────
{
  const rs = [0.01, -0.01, 0.01, -0.01, 0.01, -0.01, 0.01, -0.01, 0.01, -0.01];
  const vol = annualizedVolatility(rs);
  // stdev(rs) ≈ 0.01054 (sample), ×√252 ≈ 0.1673
  assert("annualized vol ≈ 0.167", Math.abs(vol - 0.167) < 0.01, vol);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
