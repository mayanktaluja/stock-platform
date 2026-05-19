// Failsafe NIFTYBEES pivot — converts an open Pillar-1 + Pillar-2
// portfolio into a defensive parking allocation when the RED circuit
// breaker fires (-40% portfolio drawdown).
//
// The pivot doesn't execute trades — it produces a target allocation
// (NIFTYBEES + cash) and a list of exit instructions for the operator
// to place via broker. The decisionLog records every EXIT_FAILSAFE.
//
// Allocation policy:
//   - 60% to NIFTYBEES (Nifty 50 ETF — preserves equity exposure)
//   - 30% to GOLDBEES (gold ETF — diversifier)
//   - 10% to cash (dry powder for re-entry)

import { closePosition, readPortfolio, markToMarket } from "../paperTrade/multibaggerPortfolioService.js";

export const FAILSAFE_TARGET = Object.freeze({
  NIFTYBEES_PCT: 60,
  GOLDBEES_PCT: 30,
  CASH_PCT: 10,
});

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// Pure planning function — no I/O. Returns the instructions a caller
// (e.g. action generator) should surface to the user.
export function planFailsafePivot({ portfolio_value_inr, current_positions = [], price_map = {} } = {}) {
  if (!isFiniteNumber(portfolio_value_inr) || portfolio_value_inr <= 0) {
    return { instructions: [], reason: "invalid_portfolio_value" };
  }
  const instructions = [];
  for (const pos of current_positions) {
    const price = price_map[pos.ticker] ?? pos.avg_entry_price_inr;
    instructions.push({
      type: "SELL_AT_MARKET",
      ticker: pos.ticker,
      qty: pos.qty,
      estimated_price_inr: price,
      estimated_proceeds_inr: Number((pos.qty * price).toFixed(2)),
    });
  }
  const totalAfterLiquidation = portfolio_value_inr;
  instructions.push({
    type: "BUY_AT_MARKET",
    ticker: "NIFTYBEES",
    target_value_inr: Number((totalAfterLiquidation * FAILSAFE_TARGET.NIFTYBEES_PCT / 100).toFixed(2)),
  });
  instructions.push({
    type: "BUY_AT_MARKET",
    ticker: "GOLDBEES",
    target_value_inr: Number((totalAfterLiquidation * FAILSAFE_TARGET.GOLDBEES_PCT / 100).toFixed(2)),
  });
  return {
    instructions,
    reason: "drawdown_circuit_breaker_red",
    target_split: FAILSAFE_TARGET,
  };
}

// Side-effectful — closes every single-name position via the paper-book
// at the supplied prices, logging EXIT_FAILSAFE for each. Caller is
// expected to have already verified portfolio_risk.state === "RED".
export function executeFailsafePivot({ price_map = {} } = {}) {
  const book = readPortfolio();
  const closed = [];
  for (const pos of [...book.positions]) {
    const price = price_map[pos.ticker] ?? pos.avg_entry_price_inr;
    closed.push(closePosition({ ticker: pos.ticker, price_inr: price, reason: "failsafe" }));
  }
  const finalMtm = markToMarket(price_map);
  return {
    closed_positions: closed.length,
    final_cash_inr: finalMtm.cash_inr,
    portfolio_value_inr: finalMtm.portfolio_value_inr,
  };
}
