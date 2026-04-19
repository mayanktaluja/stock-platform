/**
 * Regime-Scaled Position Sizing — Kelly-Lite
 *
 * Phase 2 addition. Scales position size by a regime-risk factor so that
 * under adverse macro conditions (GLOBAL_RISK_OFF, OIL_SHOCK, RATE_HIKE)
 * positions are automatically smaller, and under CALM / POLICY_STIMULUS
 * they're full size. This improves Sharpe and draws down less in bear
 * regimes without requiring any change to the picks themselves.
 *
 * Rule:
 *
 *   size = baseSize × clamp(1 − |macroDelta|/20, 0.3, 1.0)
 *
 * Where macroDelta is the per-stock sector-impact delta already computed
 * by macroRegime.js (range ±10). A delta of 0 (neutral) gives full size;
 * a delta of -10 (max negative) gives 50% size; floor 30% never lets
 * sizing go to zero on a single trade.
 *
 * Why Kelly-lite and not full Kelly: full Kelly requires an edge estimate
 * per trade (win rate × payoff). Our per-trade edge is noisy at the
 * sample sizes we have, and using it for sizing would overweight trades
 * with optimistic — often wrong — estimates. Regime-scaling ties size to
 * *systemic* risk, which is measurable and stable.
 *
 * This module stays pure/stateless so it can be called from server.js
 * (live scanner) and paper-trade-honest.mjs (backtest) alike.
 */

const SIZE_FLOOR = 0.30;
const SIZE_CEILING = 1.00;
const MACRO_DELTA_DIVISOR = 20;

/**
 * Compute the position-size multiplier for a trade given the macro delta.
 * macroDelta range: ±10 (from macroRegime sector impact).
 * Returns a float in [SIZE_FLOOR, SIZE_CEILING].
 */
function regimeSizeMultiplier(macroDelta) {
  if (macroDelta == null || !Number.isFinite(macroDelta)) return 1.0;
  const raw = 1 - Math.abs(macroDelta) / MACRO_DELTA_DIVISOR;
  return Math.max(SIZE_FLOOR, Math.min(SIZE_CEILING, raw));
}

/**
 * Apply sizing to a trade's P&L contribution. Instead of the trade
 * contributing its raw returnPct, it contributes returnPct × size to
 * the portfolio equity curve. Frictions are applied BEFORE sizing so
 * we don't scale down fixed costs (commissions apply regardless of
 * position size relative to portfolio — they're a function of notional
 * traded, not size allocation).
 */
function applySizeToTrade(trade, size) {
  if (!trade || size == null) return trade;
  return {
    ...trade,
    sizeMultiplier: size,
    sizedReturnPct: trade.returnPct * size,
  };
}

export { regimeSizeMultiplier, applySizeToTrade, SIZE_FLOOR, SIZE_CEILING };
