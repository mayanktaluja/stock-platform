// Portfolio liquidity-tail aggregation — buckets ₹ value by estimated
// time-to-exit so the user sees, at a glance, how much of the book is
// genuinely liquid vs. trapped in micro-cap or surveillance-flagged tail.
//
// Why this exists: SEBI's 2024 risk-disclosure guidance specifically
// flagged retail portfolios with concentrated illiquid tails as a
// systemic concern. The user's TKL187 sample has ~8 suspended/Z/T-trade
// scrips that the previous analyzer treated as live full-value
// holdings. A single visible "₹X is functionally stuck" line changes
// the size-decision calculus.
//
// Methodology: pure market-cap bucketing with surveillance escalation.
// SWS doesn't expose ADV; computing the textbook 20%-of-ADV days-to-exit
// requires historical volume which isn't in the SWS deep file. The
// market-cap proxy is conservative and well-correlated empirically:
// large-caps trade ~1% of cap daily, small-caps under 0.2%, micro-caps
// near zero. ASM/GSM surveillance always bumps the bucket one tier
// worse — that's the regulatory friction layer.
//
// Pure function. Testable with synthetic holding shapes.

import { num } from "./swsScoring.js";

// Market-cap thresholds in ₹. Calibrated against NSE's classification:
//   Large cap   ≥ ₹50,000 Cr   (top ~100 by mcap)
//   Mid-large   ₹15,000-50,000 Cr
//   Mid-small   ₹3,000-15,000 Cr
//   Small/micro < ₹3,000 Cr
const LARGE_CAP_INR = 50_000 * 1e7;
const MID_LARGE_INR = 15_000 * 1e7;
const MID_SMALL_INR = 3_000 * 1e7;

const BUCKETS = ["<1d", "1-5d", "5-10d", ">10d", "no-data"];

/**
 * Bucket a single holding's days-to-exit. Returns one of the BUCKETS.
 *
 * Inputs read from holding.sws (set by services/swsHoldingEngine.js):
 *   • market_cap_inr  — primary driver
 *   • surveillance    — { list, stage } | null; escalates bucket
 *
 * Holdings without SWS coverage land in "no-data".
 */
export function bucketHolding(holding) {
  const sws = holding?.sws;
  if (!sws || holding.swsCovered === false) return "no-data";
  const mc = num(sws.market_cap_inr, null);
  if (mc == null || mc <= 0) return "no-data";

  let bucket;
  if (mc >= LARGE_CAP_INR) bucket = "<1d";
  else if (mc >= MID_LARGE_INR) bucket = "1-5d";
  else if (mc >= MID_SMALL_INR) bucket = "5-10d";
  else bucket = ">10d";

  // Surveillance escalation — ASM/GSM bumps the bucket one tier worse.
  // GSM is more severe but the same single-tier bump applies; the
  // surveillance chip on the holding card already differentiates them.
  const surv = sws.surveillance || sws.v2_breakdown?.surveillance;
  if (surv && (surv.list === "ASM" || surv.list === "GSM")) {
    const idx = BUCKETS.indexOf(bucket);
    if (idx >= 0 && idx < BUCKETS.length - 2) {
      // Don't escalate past ">10d" (last real bucket; "no-data" is a
      // separate marker, not the end of the gradient).
      bucket = BUCKETS[idx + 1];
    }
  }

  return bucket;
}

/**
 * Aggregate ₹ value across the buckets for a portfolio.
 *
 * @param {object[]} scoredHoldings - SWS-engine output rows
 * @returns {{
 *   buckets: { "<1d", "1-5d", "5-10d", ">10d", "no-data": number },
 *   pct:     { "<1d", "1-5d", "5-10d", ">10d", "no-data": number },
 *   tickersByBucket: { ...same keys: string[] },
 *   totalValue: number,
 *   illiquidValue: number,    // 5-10d + >10d + no-data
 *   illiquidPct: number,
 *   methodology: string,
 * }}
 */
export function bucketByDaysToExit(scoredHoldings) {
  const buckets = { "<1d": 0, "1-5d": 0, "5-10d": 0, ">10d": 0, "no-data": 0 };
  const tickersByBucket = { "<1d": [], "1-5d": [], "5-10d": [], ">10d": [], "no-data": [] };
  let totalValue = 0;

  for (const h of scoredHoldings || []) {
    const v = num(h.currentValue, 0);
    if (v <= 0) continue;
    const b = bucketHolding(h);
    buckets[b] += v;
    totalValue += v;
    const tk = h.sws?.ticker || h.symbol || h.ticker || "?";
    tickersByBucket[b].push(tk);
  }

  const pct = {};
  for (const b of BUCKETS) {
    pct[b] = totalValue > 0 ? +((buckets[b] / totalValue) * 100).toFixed(1) : 0;
  }

  const illiquidValue = buckets["5-10d"] + buckets[">10d"] + buckets["no-data"];
  const illiquidPct = totalValue > 0 ? +((illiquidValue / totalValue) * 100).toFixed(1) : 0;

  return {
    buckets,
    pct,
    tickersByBucket,
    totalValue,
    illiquidValue,
    illiquidPct,
    methodology:
      "Bucketed by SWS market_cap_inr (large ≥₹50K Cr → <1d; mid-large ₹15-50K Cr → 1-5d; " +
      "mid-small ₹3-15K Cr → 5-10d; small/micro <₹3K Cr → >10d). NSE ASM/GSM surveillance " +
      "escalates one bucket worse. Conservative proxy — actual days-to-exit depends on " +
      "your position size vs ADV, which isn't in the SWS deep snapshot.",
  };
}
