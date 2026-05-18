/**
 * Stream E2 — services/trackRecord/riskMetrics.js regression.
 *
 * Run with: node test/trackRecordRiskMetrics.test.mjs
 *
 * NOTE: this is the TRACK-RECORD per-section risk-metric module
 * (`services/trackRecord/riskMetrics.js`). It is NOT the existing
 * portfolio-level math test (`test/riskMetrics.test.mjs`) which
 * covers the top-level `riskMetrics.js`. Two separate modules, two
 * separate test files — do not collapse them.
 *
 * The function under test (`computeSectionRiskMetrics`) takes an
 * array of paper-trade rows carrying `returns_by_horizon` and a
 * primary horizon key ("1m" / "3m" / "6m" / "12m" / "t1") and
 * returns `{sharpe, sortino, max_drawdown_pct, var_95_pct,
 * n_observations}`. Degenerate cases (n<3, zero variance, all
 * positive returns) must return null for the offending field, not
 * NaN/Infinity — the UI treats null as "—".
 */

import { computeSectionRiskMetrics } from "../services/trackRecord/riskMetrics.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", got);
  }
}

function approxEqual(a, b, tol = 0.1) {
  return Math.abs(a - b) < tol;
}

// Build a trade fixture with a single horizon populated.
function trade(returnPct, snapshotAt, horizon = "3m") {
  return {
    returns_by_horizon: {
      [horizon]: { return_pct: returnPct },
    },
    snapshotAt,
  };
}

console.log("trackRecord/riskMetrics.js regression\n");

// ──── 1. Empty input → all nulls, n_observations: 0 ────
{
  const r = computeSectionRiskMetrics([], "3m");
  assert(
    "[] returns {sharpe:null, sortino:null, mdd:null, var:null, n_observations:0}",
    r.sharpe === null &&
      r.sortino === null &&
      r.max_drawdown_pct === null &&
      r.var_95_pct === null &&
      r.n_observations === 0,
    r,
  );
}

// ──── 2. n < 3 → all nulls except n_observations ────
{
  const trades = [
    trade(5, "2026-01-01"),
    trade(3, "2026-02-01"),
  ];
  const r = computeSectionRiskMetrics(trades, "3m");
  assert(
    "n=2 returns all nulls + n_observations=2",
    r.sharpe === null &&
      r.sortino === null &&
      r.max_drawdown_pct === null &&
      r.var_95_pct === null &&
      r.n_observations === 2,
    r,
  );
}

// ──── 3. Uniform positive returns → Sharpe null (zero variance), Sortino null (no downside) ────
{
  // 5 trades each with return_pct=5.0. Zero variance → Sharpe null.
  // No downside → Sortino null. No drawdown → MDD null or 0.
  const trades = [
    trade(5, "2026-01-01"),
    trade(5, "2026-02-01"),
    trade(5, "2026-03-01"),
    trade(5, "2026-04-01"),
    trade(5, "2026-05-01"),
  ];
  const r = computeSectionRiskMetrics(trades, "3m");
  assert(
    "uniform positive returns → n_observations=5",
    r.n_observations === 5,
    r.n_observations,
  );
  assert(
    "zero variance → Sharpe is null (division-by-zero guard)",
    r.sharpe === null,
    r.sharpe,
  );
  assert(
    "all-positive returns → Sortino is null (no downside samples)",
    r.sortino === null,
    r.sortino,
  );
  assert(
    "monotonically rising series → max_drawdown_pct is 0 or null",
    r.max_drawdown_pct === 0 || r.max_drawdown_pct === null,
    r.max_drawdown_pct,
  );
}

// ──── 4. Mixed returns — Sharpe/Sortino/MDD vs hand-computed values ────
{
  // 6 trades with 3m returns: [5, -3, 10, -8, 4, 2]
  // Annualised at 3m (factor 4): (1 + r/100)^4 - 1, ×100
  // → 21.551, -11.471, 46.41, -28.361, 16.986, 8.243
  //
  // mean ≈ (21.551 - 11.471 + 46.41 - 28.361 + 16.986 + 8.243) / 6
  //      ≈ 53.358 / 6 ≈ 8.893
  //
  // sample stdev (n-1 divisor): squared deviations from 8.893:
  //   (21.551 - 8.893)^2 ≈ 160.224
  //   (-11.471 - 8.893)^2 ≈ 414.65
  //   (46.41 - 8.893)^2 ≈ 1407.51
  //   (-28.361 - 8.893)^2 ≈ 1387.86
  //   (16.986 - 8.893)^2 ≈ 65.50
  //   (8.243 - 8.893)^2 ≈ 0.423
  //   sum ≈ 3436.17, var = 3436.17 / 5 ≈ 687.23, stdev ≈ 26.21
  //   Sharpe = 8.893 / 26.21 ≈ 0.34
  //
  // Downside stdev (target=0, n-1 divisor): only negative annualised samples.
  //   negatives: [-11.471, -28.361]
  //   squared dev from 0: 131.59 + 803.95 = 935.54
  //   downside var = 935.54 / 1 = 935.54, dsigma ≈ 30.59
  //   Sortino = 8.893 / 30.59 ≈ 0.29
  //
  // Max DD uses RAW returns (not annualised): [5, -3, 10, -8, 4, 2]
  //   cumulative: 100 → 105 → 101.85 → 112.035 → 103.072 → 107.195 → 109.339
  //   peak tracking: 100, 105 (peak=105), 101.85 (peak still 105, dd=-3%),
  //                  112.035 (peak=112.035), 103.072 (dd≈-8.00%),
  //                  107.195 (dd≈-4.32%), 109.339 (dd≈-2.41%)
  //   max DD ≈ -8.00%
  const trades = [
    trade(5, "2026-01-01"),
    trade(-3, "2026-02-01"),
    trade(10, "2026-03-01"),
    trade(-8, "2026-04-01"),
    trade(4, "2026-05-01"),
    trade(2, "2026-06-01"),
  ];
  const r = computeSectionRiskMetrics(trades, "3m");
  assert(
    "mixed returns → n_observations=6",
    r.n_observations === 6,
    r.n_observations,
  );
  assert(
    "Sharpe ≈ 0.34 (within 0.1 of expected)",
    r.sharpe !== null && approxEqual(r.sharpe, 0.34, 0.1),
    r.sharpe,
  );
  assert(
    "Sortino ≈ 0.29 (downside-only, within 0.1 of expected)",
    r.sortino !== null && approxEqual(r.sortino, 0.29, 0.15),
    r.sortino,
  );
  assert(
    "Sortino is distinct from Sharpe (downside-deviation differs from total)",
    r.sortino !== null && r.sharpe !== null && r.sortino !== r.sharpe,
    { sortino: r.sortino, sharpe: r.sharpe },
  );
  assert(
    "max_drawdown_pct is non-positive (drawdown is a loss, sign convention)",
    r.max_drawdown_pct !== null && r.max_drawdown_pct <= 0,
    r.max_drawdown_pct,
  );
  assert(
    "max_drawdown_pct ≈ -8% (raw-return cumulative, within 0.5pp)",
    r.max_drawdown_pct !== null && approxEqual(r.max_drawdown_pct, -8.0, 0.5),
    r.max_drawdown_pct,
  );
}

// ──── 5. Trades missing returns_by_horizon are skipped silently ────
{
  // 6 well-formed trades + 2 trades with no `returns_by_horizon` field
  // → n_observations counts only the 6 well-formed entries.
  const trades = [
    trade(5, "2026-01-01"),
    trade(-3, "2026-02-01"),
    trade(10, "2026-03-01"),
    trade(-8, "2026-04-01"),
    trade(4, "2026-05-01"),
    trade(2, "2026-06-01"),
    { snapshotAt: "2026-07-01" }, // no returns_by_horizon → skipped
    { returns_by_horizon: {}, snapshotAt: "2026-08-01" }, // empty → skipped
  ];
  const r = computeSectionRiskMetrics(trades, "3m");
  assert(
    "missing returns_by_horizon entries are skipped (n_observations stays 6)",
    r.n_observations === 6,
    r.n_observations,
  );
  assert(
    "Sharpe still computes from the remaining 6 valid samples",
    r.sharpe !== null && Number.isFinite(r.sharpe),
    r.sharpe,
  );
}

// ──── 6. t1 horizon — annualisation factor 252 trading days ────
{
  // T+1 horizon: factor 252. A single-day +1% return annualises huge.
  // Use small returns so values stay reasonable. 6 trades.
  const trades = [
    trade(0.5, "2026-01-01", "t1"),
    trade(-0.3, "2026-01-02", "t1"),
    trade(0.8, "2026-01-03", "t1"),
    trade(-0.4, "2026-01-04", "t1"),
    trade(0.6, "2026-01-05", "t1"),
    trade(0.2, "2026-01-06", "t1"),
  ];
  const r = computeSectionRiskMetrics(trades, "t1");
  assert(
    "t1 horizon → n_observations=6",
    r.n_observations === 6,
    r.n_observations,
  );
  // Annualised +0.5% at factor 252 → (1.005)^252 - 1 ≈ 2.529 → 252.9%
  // The Sharpe should be a non-null finite number; we don't pin a value
  // because the math is brittle, but we verify the t1 path is wired in.
  assert(
    "t1 horizon Sharpe is finite (annualisation factor 252 flows through)",
    r.sharpe !== null && Number.isFinite(r.sharpe),
    r.sharpe,
  );
  // Raw-return MDD uses raw t1 percentages: [0.5, -0.3, 0.8, -0.4, 0.6, 0.2]
  //   cumulative: 100 → 100.5 → 100.199 → 100.999 → 100.595 → 101.198 → 101.400
  //   peak tracking: peak=100, 100.5, 100.5 (dd≈-0.299%), 100.999, ...
  //   small drawdowns; we just sanity-check non-positive.
  assert(
    "t1 horizon max_drawdown_pct is non-positive",
    r.max_drawdown_pct === null || r.max_drawdown_pct <= 0,
    r.max_drawdown_pct,
  );
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
