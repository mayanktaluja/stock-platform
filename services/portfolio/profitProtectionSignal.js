import { num } from "../swsScoring.js";
import { ALL_REDUCTION_ACTIONS } from "../actionLadder.js";

// Profit-protection trims for volatile winners (owner case: Jeena Sikho —
// ₹740 peak → ₹580-600s while still well in profit on cost).
//
// Every existing reduction path is fundamentals/valuation/loss-driven; the
// only price-path input (recoverableDrawdownRaw) uses the 52W range solely
// to SOFTEN loss-side trims. A volatile winner retracing off its peak while
// the holder is up on cost triggers nothing. This module is that missing
// signal — an OPTIONAL discipline suggestion, deliberately isolated:
//
//   • never mutates h.action (zero blast radius on tiers/bar/ledger/plan)
//   • attaches h.profitProtection; the UI renders a separate collapsible
//     "Profit booking — optional discipline trims" block under Reductions
//   • its notional ₹ is NOT added to tiers.A.freedRupees — risk-driven
//     freed capital stays honest
//
// Data source order (SWS-first): sws.fifty_two_week_high_inr from the
// nightly-refreshed deep brief; falls back to live-quote fields
// (holding.fiftyTwoWeekHigh) only for SWS-uncovered names, tagged in the
// rationale. Rows missing both self-skip.

export const PP_MIN_GAIN_ON_COST_PCT = 25;   // must be a real winner on cost
export const PP_MIN_RETRACE_PCT = 15;        // off the 52W high
export const PP_DEEP_RETRACE_PCT = 25;       // deeper retrace → bigger rung
export const PP_MIN_BETA = 1.2;              // volatility qualifier (covered)
export const PP_MIN_52W_RANGE_WIDTH_PCT = 60; // (high−low)/low — SME proxy

const STRONG_VERDICTS = new Set(["TOP_PICK", "STRONG"]);

export function evaluateProfitProtection(h) {
  if (!h || ALL_REDUCTION_ACTIONS.has(h.action)) return null; // Tier A owns those

  const sws = h.sws || {};
  const pnl = num(h.pnlPercent, null);
  if (pnl == null || pnl < PP_MIN_GAIN_ON_COST_PCT) return null;

  const fromSws = num(sws.fifty_two_week_high_inr, null) != null;
  const high = fromSws ? num(sws.fifty_two_week_high_inr, null) : num(h.fiftyTwoWeekHigh, null);
  const low = fromSws ? num(sws.fifty_two_week_low_inr, null) : num(h.fiftyTwoWeekLow, null);
  const price = num(h.livePrice ?? sws.current_price_inr ?? h.currentPrice, null);
  if (high == null || high <= 0 || price == null || price <= 0) return null;

  const retracePct = ((high - price) / high) * 100;
  if (retracePct < PP_MIN_RETRACE_PCT) return null;

  // Volatility qualifier: beta when the deep brief has one, else the 52W
  // range width — SWS-uncovered SME names have no beta but wear their
  // volatility in the range itself.
  const beta = num(sws.beta ?? h.beta, null);
  const rangeWidthPct = (low != null && low > 0) ? ((high - low) / low) * 100 : null;
  const volatile = (beta != null && beta >= PP_MIN_BETA)
    || (rangeWidthPct != null && rangeWidthPct >= PP_MIN_52W_RANGE_WIDTH_PCT);
  if (!volatile) return null;

  const deep = retracePct >= PP_DEEP_RETRACE_PCT;
  const suggestedTrimPct = deep ? 33 : 20;
  const currentValue = num(h.currentValue, 0);
  const notionalFreedInr = Math.round(currentValue * (suggestedTrimPct / 100));

  const strongFundamentals = STRONG_VERDICTS.has(sws.v4_verdict || sws.verdict);
  const qualifier = beta != null && beta >= PP_MIN_BETA
    ? `beta ${beta.toFixed(2)}`
    : `52W range ${Math.round(rangeWidthPct)}% wide`;

  return {
    eligible: true,
    retracePctFromHigh: +retracePct.toFixed(1),
    gainOnCostPct: +pnl.toFixed(1),
    week52HighInr: high,
    currentPriceInr: price,
    suggestedTrimPct,
    notionalFreedInr,
    volatilityQualifier: qualifier,
    source: fromSws ? "sws" : "quote",
    strongFundamentals,
    rationale: strongFundamentals
      ? `Up ${pnl.toFixed(0)}% on cost but ${retracePct.toFixed(0)}% off its 52W high of ₹${Math.round(high)} (${qualifier}). Fundamentals still rate ${sws.v4_verdict || "STRONG"} — consider trimming only the position excess rather than the full ${suggestedTrimPct}% discipline rung.`
      : `Up ${pnl.toFixed(0)}% on cost but ${retracePct.toFixed(0)}% off its 52W high of ₹${Math.round(high)} (${qualifier}). A ${suggestedTrimPct}% profit-booking trim locks in gains while the retracement plays out. Optional discipline rule, not a thesis change.`,
  };
}

// Attach h.profitProtection to qualifying holdings; returns the qualifying
// rows (post-attach) for the report block. Mutates in place like the other
// analyzer post-passes.
export function attachProfitProtection(scoredHoldings) {
  const rows = [];
  for (const h of Array.isArray(scoredHoldings) ? scoredHoldings : []) {
    const signal = evaluateProfitProtection(h);
    if (!signal) continue;
    h.profitProtection = signal;
    rows.push({
      ticker: String(h.sws?.ticker || h.symbol || "").toUpperCase(),
      name: h.sws?.name || h.name || null,
      ...signal,
    });
  }
  rows.sort((a, b) => (b.retracePctFromHigh - a.retracePctFromHigh) || a.ticker.localeCompare(b.ticker));
  return rows;
}
