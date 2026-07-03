// Staged-buy tranche-plan builder — Two-Key Entry (plan: ~/.claude/plans/entry-timing-final.md).
//
// Turns a persisted anchor price into a staged-buy ladder with explicit ₹
// trigger levels the user drops straight into Groww price alerts. Buy-side
// mirror of the EXIT-staged sell vocabulary in services/actionLadder.js.
//
// Contract invariants (prior findings baked in — do NOT relax):
//   1. The ladder anchors at anchorPriceInr, captured ONCE when the plan
//      became eligible. It never re-anchors to a moving price; callers
//      persist the anchor + anchoredAt and replay them verbatim.
//   2. ~48% of current picks trade BELOW 0.75×FV. In that case a T3 rung at
//      0.75×FV would sit ABOVE the anchor, so the ladder collapses to
//      2 tranches (DEEP_BELOW_BAND) instead of emitting an impossible rung.
//   3. Every tranche trigger is ≤ anchor and strictly decreasing — a staged
//      BUY plan never instructs an "add" above the initial entry.
//   4. If the invalidation level sits at/above the lowest rung there is no
//      room to stage — the plan is REFUSED outright, never silently clamped.
//
// Pure module: no I/O, no Date.now, never mutates inputs.
// All ₹ values rounded to 2dp; pct values pass through exactly as configured.

import { TRANCHES, INVALIDATION, ENTRY_TIMING_VERSION } from "./entryTimingConfig.js";
import { atrStopPrice } from "../multibagger/atrCalculator.js";

// A degenerate measured MAE (near-zero or huge) must not produce absurd
// ladders — clamp whatever PR-1 measures into a sane staging band.
const MAE_CLAMP_MIN_PCT = 3;
const MAE_CLAMP_MAX_PCT = 20;

// Default no-chase ceiling when the caller has no explicit level: 90% of FV
// (the top of the buy zone). It is a CEILING, never a rung.
const NO_CHASE_FV_MULT = 0.9;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isPositive(v) {
  return isFiniteNumber(v) && v > 0;
}

function r2(v) {
  return Number(v.toFixed(2));
}

// ── Config guard ────────────────────────────────────────────────────────
// A split that doesn't sum to 1.0 is a programmer error in
// entryTimingConfig.js, not a runtime state — fail loudly at import time.
function assertSplitSumsToOne(name, split) {
  const sum = (Array.isArray(split) ? split : []).reduce((acc, x) => acc + x, 0);
  if (!(Math.abs(sum - 1) < 1e-9)) {
    throw new Error(`entryTimingConfig ${name} must sum to 1.0 — got ${sum}`);
  }
}
assertSplitSumsToOne("TRANCHES.SPLIT", TRANCHES.SPLIT);
assertSplitSumsToOne("TRANCHES.DEEP_SPLIT", TRANCHES.DEEP_SPLIT);

// ── Invalidation ────────────────────────────────────────────────────────
// Tier-2 (preferred): ATR stop off the anchor — NOT capped; an ATR stop above the
// ladder is a genuine volatility-incoherence refusal signal.
// Tier-1 fallback: the tighter of the 0.92×anchor floor and the 52-week low, but
// CAPPED below the lowest rung (INVALIDATION.BELOW_LADDER_MULT) — a stop above the
// final planned add would refuse every seed-MAE plan (real-data smoke 2026-07-03:
// 25/25 live buy-now plans refused without the cap).
function resolveInvalidation({ anchorPriceInr, atr14, fiftyTwoWeekLow, lowestRungInr }) {
  if (isPositive(atr14)) {
    const stop = atrStopPrice(anchorPriceInr, atr14, INVALIDATION.ATR_MULT);
    // atrStopPrice returns null when the stop would be ≤ 0 (ATR wider than
    // the price itself) — fall through to the floor tier rather than refuse.
    if (isFiniteNumber(stop)) {
      return { invalidation_inr: stop, invalidation_basis: "atr" };
    }
  }
  const ladderCap = isPositive(lowestRungInr)
    ? r2(INVALIDATION.BELOW_LADDER_MULT * lowestRungInr)
    : Infinity;
  const anchorFloor = r2(INVALIDATION.ANCHOR_MULT * anchorPriceInr);
  if (isPositive(fiftyTwoWeekLow)) {
    const low = r2(fiftyTwoWeekLow);
    if (low < anchorFloor) {
      return low <= ladderCap
        ? { invalidation_inr: low, invalidation_basis: "52w_low" }
        : { invalidation_inr: ladderCap, invalidation_basis: "ladder_floor" };
    }
  }
  return anchorFloor <= ladderCap
    ? { invalidation_inr: anchorFloor, invalidation_basis: "anchor_floor" }
    : { invalidation_inr: ladderCap, invalidation_basis: "ladder_floor" };
}

// ── Ladder ──────────────────────────────────────────────────────────────
function buildLadder({ anchorInr, fairValueInr, mae }) {
  // Deep/normal comparison is on RAW values, before any 2dp rounding:
  // NORMAL only when 0.75×FV sits strictly below the anchor.
  const t3FvLevel = TRANCHES.T3_FV_MULT * fairValueInr;
  const deepBelowBand = t3FvLevel >= anchorInr;

  let tranches;
  if (deepBelowBand) {
    // 0.75×FV at/above the anchor — the deep-value rung would sit above the
    // entry. Collapse to the 2-rung DEEP_SPLIT ladder.
    tranches = [
      {
        pct: TRANCHES.DEEP_SPLIT[0],
        trigger_type: "market",
        trigger_price_inr: r2(anchorInr),
        label: "Initiate at anchor",
      },
      {
        pct: TRANCHES.DEEP_SPLIT[1],
        trigger_type: "limit",
        trigger_price_inr: r2(anchorInr * (1 - TRANCHES.DEEP_T2_MAE_MULT * mae)),
        label: "Add on measured pullback",
      },
    ];
  } else {
    tranches = [
      {
        pct: TRANCHES.SPLIT[0],
        trigger_type: "market",
        trigger_price_inr: r2(anchorInr),
        label: "Initiate at anchor",
      },
      {
        pct: TRANCHES.SPLIT[1],
        trigger_type: "limit",
        trigger_price_inr: r2(anchorInr * (1 - TRANCHES.T2_MAE_MULT * mae)),
        label: "Add on measured pullback",
      },
      {
        pct: TRANCHES.SPLIT[2],
        trigger_type: "limit",
        trigger_price_inr: r2(Math.min(t3FvLevel, anchorInr * (1 - TRANCHES.T3_MAE_MULT * mae))),
        label: "Final add at deep-value level",
      },
    ];
  }

  // Enforce monotonic non-increasing (strictly decreasing after rounding):
  // every rung ≤ anchor (T1 IS the anchor, so the decreasing chain covers
  // it) and each later rung strictly below the previous. If 2dp rounding
  // ever collides two rungs, nudge the LATER one down ₹0.01.
  for (let i = 1; i < tranches.length; i++) {
    if (tranches[i].trigger_price_inr >= tranches[i - 1].trigger_price_inr) {
      tranches[i].trigger_price_inr = Math.max(0, r2(tranches[i - 1].trigger_price_inr - 0.01));
    }
  }

  return { tranches, deepBelowBand };
}

/**
 * Build a staged-buy tranche plan off a persisted anchor.
 *
 * @param {object} input
 * @param {number} input.anchorPriceInr  Persisted anchor (₹) — required, finite positive.
 * @param {string} [input.anchoredAt]    ISO timestamp the anchor was captured — echoed through.
 * @param {number} input.fairValueInr    SWS fair value (₹) — required, finite positive.
 * @param {number} [input.noBuyAboveInr] Chase ceiling (₹); defaults to 0.90×FV.
 * @param {number} [input.fiftyTwoWeekLow] 52-week low (₹) for the Tier-1 invalidation floor.
 * @param {number} [input.atr14]         ATR (₹, price units) for the Tier-2 ATR stop.
 * @param {number} [input.medianMaePct]  Measured median post-flag MAE (%); defaults to the
 *                                       config seed; clamped to [3, 20].
 * @returns {object} eligible plan or { eligible: false, refusal_code, ... }.
 */
export function buildTranchePlan({
  anchorPriceInr,
  anchoredAt,
  fairValueInr,
  noBuyAboveInr,
  fiftyTwoWeekLow,
  atr14,
  medianMaePct,
} = {}) {
  if (!isPositive(anchorPriceInr) || !isPositive(fairValueInr)) {
    return {
      eligible: false,
      refusal_code: "missing_inputs",
      version: ENTRY_TIMING_VERSION,
      anchored_at: anchoredAt ?? null,
    };
  }

  const maePctRaw = isFiniteNumber(medianMaePct) ? medianMaePct : TRANCHES.MAE_SEED_PCT;
  const maePctUsed = Math.min(MAE_CLAMP_MAX_PCT, Math.max(MAE_CLAMP_MIN_PCT, maePctRaw));
  const mae = maePctUsed / 100;

  const { tranches, deepBelowBand } = buildLadder({
    anchorInr: anchorPriceInr,
    fairValueInr,
    mae,
  });

  // No-chase is a CEILING above the ladder, never a rung of it.
  const noChaseInr = isPositive(noBuyAboveInr)
    ? r2(noBuyAboveInr)
    : r2(NO_CHASE_FV_MULT * fairValueInr);

  const lowestTrancheInr = tranches[tranches.length - 1].trigger_price_inr;
  const { invalidation_inr, invalidation_basis } = resolveInvalidation({
    anchorPriceInr,
    atr14,
    fiftyTwoWeekLow,
    lowestRungInr: lowestTrancheInr,
  });

  // No room to stage: the thesis-invalidation level sits at/above the lowest
  // rung, so later tranches could only fill on an already-invalidated setup.
  // Only the (uncapped) ATR basis can land here — a vol-stop above the ladder is a
  // genuine "plan incoherent for this volatility" signal. Refuse — and deliberately
  // withhold the tranches array so a refused plan never leaks actionable rungs.
  if (invalidation_inr >= lowestTrancheInr) {
    return {
      eligible: false,
      refusal_code: "invalidation_above_ladder",
      version: ENTRY_TIMING_VERSION,
      anchor_price_inr: r2(anchorPriceInr),
      anchored_at: anchoredAt ?? null,
      deep_below_band: deepBelowBand,
      lowest_tranche_inr: lowestTrancheInr,
      no_chase_inr: noChaseInr,
      invalidation_inr,
      invalidation_basis,
      mae_pct_used: maePctUsed,
    };
  }

  return {
    eligible: true,
    version: ENTRY_TIMING_VERSION,
    anchor_price_inr: r2(anchorPriceInr),
    anchored_at: anchoredAt ?? null,
    deep_below_band: deepBelowBand,
    tranches,
    no_chase_inr: noChaseInr,
    invalidation_inr,
    invalidation_basis,
    mae_pct_used: maePctUsed,
  };
}
