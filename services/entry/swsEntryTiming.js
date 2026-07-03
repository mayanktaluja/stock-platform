// Pure entry-timing engine — Key 2 of the Two-Key entry design
// (plan: ~/.claude/plans/entry-timing-final.md).
//
// Key 1 ("Actionable now", price ≤ 0.85×FV) says a pick is CHEAP. It has
// zero timing input, so it systematically flags falling knives. This module
// is the timing key: given a nightly-scored pick row's momentum data it
// answers "safe to enter now?". sws-scoring.mjs stamps the result onto pick
// rows nightly (wiring lives there, not here).
//
// States:
//   FALLING_KNIFE   — at least one knife leg fires, or hysteresis holds a
//                     prior-night knife until 1M momentum recovers
//   STABILIZING     — not a knife, but confirmation evidence incomplete
//                     (the crashed-then-bounced forming-base lands here)
//   ENTRY_CONFIRMED — positive 1M + ≥ universe-median 3M + off-the-floor
//   MACRO_DEFER     — would be CONFIRMED, but the macro regime is severe
//                     AND working against this row's sector
//   NO_DATA         — returns block unusable (no finite 1M return)
//
// Same posture as services/timingObservation.js: pure function, no I/O,
// no LLM, no Date.now (caller passes asOf), deterministic given inputs,
// never mutates its inputs (nightly rows may be shared or frozen).
//
// ALL thresholds + reason codes live in entryTimingConfig.js — nothing
// numeric is hardcoded here, so a data-tune never diffs engine logic.

import {
  ENTRY_TIMING_VERSION,
  KNIFE,
  KNIFE_EXIT,
  CONFIRMED,
  MACRO_DEFER,
  TIER2_CONFIRM,
  REASON,
} from "./entryTimingConfig.js";

// State vocabulary — frozen, mirroring decisionContract.js's DECISION_STATES.
export const ENTRY_STATES = Object.freeze({
  FALLING_KNIFE: "FALLING_KNIFE",
  STABILIZING: "STABILIZING",
  ENTRY_CONFIRMED: "ENTRY_CONFIRMED",
  MACRO_DEFER: "MACRO_DEFER",
  NO_DATA: "NO_DATA",
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Fraction of a SORTED-ascending universe strictly below `value`.
 * Mirrors swsScoringV4.js::_percentileRank exactly (lower-bound binary
 * search → count-below / length) so the two percentile surfaces never drift.
 * Null-safe: non-finite value or missing/empty universe → null.
 */
export function percentileFractionBelow(value, sortedAsc) {
  if (value == null || !isNum(value) || !Array.isArray(sortedAsc) || sortedAsc.length === 0) return null;
  let lo = 0;
  let hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedAsc[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo / sortedAsc.length;
}

/**
 * Position of price inside the 52-week band: clamp((px−low)/(high−low), 0, 1).
 * Null when price is not finite, or the band is missing/degenerate (high ≤ low).
 */
export function fiftyTwoWeekPosition(currentPriceInr, fiftyTwoWeek) {
  if (!isNum(currentPriceInr)) return null;
  const low = fiftyTwoWeek?.low;
  const high = fiftyTwoWeek?.high;
  if (!isNum(low) || !isNum(high) || high <= low) return null;
  const pos = (currentPriceInr - low) / (high - low);
  return Math.min(1, Math.max(0, pos));
}

/**
 * Resolve a row's sector to its macro-regime impact. Case-insensitive,
 * trimmed match against sectorImpacts[].sector (macroRegime.sectorImpacts
 * is an ARRAY of {sector, impact, reason}). First match wins. Null when
 * the sector is blank, the array is missing, no row matches, or the
 * matched impact is not a finite number.
 */
export function resolveSectorImpact(sector, sectorImpacts) {
  if (typeof sector !== "string") return null;
  const key = sector.trim().toLowerCase();
  if (!key || !Array.isArray(sectorImpacts)) return null;
  for (const row of sectorImpacts) {
    const s = row?.sector;
    if (typeof s === "string" && s.trim().toLowerCase() === key) {
      return isNum(row.impact) ? row.impact : null;
    }
  }
  return null;
}

/**
 * Compute the entry-timing state for one nightly-scored pick row.
 *
 * @param {object}  input
 * @param {object}  [input.returnsPct]      {"1D","7D","1M","3M","6M","1Y"} percent returns; keys may be absent (6M usually is)
 * @param {object}  [input.fiftyTwoWeek]    {low, high} in INR, or null
 * @param {number}  [input.currentPriceInr] last close, or null
 * @param {number[]}[input.universeR3m]     SORTED-ascending universe 3M returns, or null
 * @param {object}  [input.macro]           {severity, sectorImpacts:[{sector,impact,reason}]}, or null
 * @param {string}  [input.sector]          row's sector string, or null
 * @param {string}  [input.prevState]       previous night's entry_timing.state, or null
 * @param {string}  [input.asOf]            caller-supplied timestamp (no Date.now here)
 * @returns {object} entry_timing — see module header for the state contract
 */
export function computeEntryTiming({
  returnsPct = null,
  fiftyTwoWeek = null,
  currentPriceInr = null,
  universeR3m = null,
  macro = null,
  sector = null,
  prevState = null,
  asOf = null,
  technicals = null,
} = {}) {
  const asOfOut = asOf ?? null;

  // 1. NO_DATA gate — a usable row needs at least a finite 1M return.
  const r1m = isNum(returnsPct?.["1M"]) ? returnsPct["1M"] : null;
  if (r1m == null) {
    return {
      version: ENTRY_TIMING_VERSION,
      state: ENTRY_STATES.NO_DATA,
      reasons: [REASON.NO_RETURNS],
      momentum_pct_3m: null,
      fiftytwo_week_position: null,
      tier: 1,
      as_of: asOfOut,
    };
  }

  const r7d = isNum(returnsPct?.["7D"]) ? returnsPct["7D"] : null;
  const r3m = isNum(returnsPct?.["3M"]) ? returnsPct["3M"] : null;
  const r6m = isNum(returnsPct?.["6M"]) ? returnsPct["6M"] : null;
  const px = isNum(currentPriceInr) ? currentPriceInr : null;

  // 2. Derived metrics. One validity rule for ALL 52w-dependent legs:
  // finite low+high with high > low (degenerate bands carry no signal).
  const momentum_pct_3m = percentileFractionBelow(r3m, universeR3m);
  const fiftytwo_week_position = fiftyTwoWeekPosition(px, fiftyTwoWeek);
  const fiftyTwoValid = isNum(fiftyTwoWeek?.low) && isNum(fiftyTwoWeek?.high)
    && fiftyTwoWeek.high > fiftyTwoWeek.low;

  // Degrade codes accumulate as legs are evaluated; appended after the
  // state reasons, deduped, so the primary signal always reads first.
  const degraded = [];
  // Percentile unavailable (null universe OR missing 3M return) degrades
  // every percentile-dependent leg the same way — one code covers both causes.
  if (momentum_pct_3m == null) degraded.push(REASON.DEGRADED_NO_PERCENTILE);

  // Tier-2 (PR-4): fresh technicals present with the fields the confirm gate
  // needs. Demote-only — technicals can veto a CONFIRMED, never mint one.
  const tier2 = !!(technicals && isNum(technicals.rsi14) && isNum(technicals.dma50) && px != null);

  const finish = (state, stateReasons) => {
    const seen = new Set();
    const reasons = [];
    for (const code of [...stateReasons, ...degraded]) {
      if (!seen.has(code)) {
        seen.add(code);
        reasons.push(code);
      }
    }
    return {
      version: ENTRY_TIMING_VERSION,
      state,
      reasons,
      momentum_pct_3m,
      fiftytwo_week_position,
      tier: tier2 ? 2 : 1,
      as_of: asOfOut,
    };
  };

  // 3. Knife legs — ANY firing leg makes it a FALLING_KNIFE; collect every
  // firing leg's code so the row shows the full case against entering.
  const knifeReasons = [];
  if (r1m <= KNIFE.R1M_MAX) knifeReasons.push(REASON.KNIFE_1M);
  if (r3m != null && r3m <= KNIFE.R3M_MAX) knifeReasons.push(REASON.KNIFE_3M);
  if (fiftyTwoValid && px != null) {
    if (px / fiftyTwoWeek.high < KNIFE.PX_OVER_52WH_MAX) knifeReasons.push(REASON.KNIFE_52W_HIGH);
  } else {
    // 52w-dependent leg evaluated without its data → skip + degrade.
    degraded.push(REASON.DEGRADED_NO_52W);
  }
  if (r7d != null && r7d <= KNIFE.R7D_MAX) knifeReasons.push(REASON.KNIFE_7D);
  // Slow-bleeder: steady slide that trips none of the sharp legs.
  // Skipped entirely when the percentile is null (no relative evidence).
  // 6M is optional on served rows: when absent, the leg degrades to
  // {1M,3M}+percentile and flags DEGRADED_NO_6M — only when the missing 6M
  // actually mattered (i.e. the leg fired without it); when 6M is present
  // and non-negative it VETOES the leg.
  if (momentum_pct_3m != null
    && r1m < 0
    && r3m != null && r3m < 0
    && momentum_pct_3m < KNIFE.SLOW_BLEEDER_PCT3M_MAX) {
    if (r6m != null) {
      if (r6m < 0) knifeReasons.push(REASON.KNIFE_SLOW_BLEEDER);
    } else {
      knifeReasons.push(REASON.KNIFE_SLOW_BLEEDER);
      degraded.push(REASON.DEGRADED_NO_6M);
    }
  }
  if (knifeReasons.length > 0) return finish(ENTRY_STATES.FALLING_KNIFE, knifeReasons);

  // 4. Hysteresis — once a knife, stay a knife until 1M has recovered to at
  // least KNIFE_EXIT.R1M_MIN (asymmetric vs the entry threshold; prevents
  // badge flip-flop around -12).
  if (prevState === ENTRY_STATES.FALLING_KNIFE && r1m < KNIFE_EXIT.R1M_MIN) {
    return finish(ENTRY_STATES.FALLING_KNIFE, [REASON.KNIFE_HELD_HYSTERESIS]);
  }

  // 5. ENTRY_CONFIRMED — all legs must hold (AND). A null percentile can
  // never confirm: CONFIRMED needs positive relative evidence, absence of
  // evidence doesn't qualify. The 52w-low clearance leg, by contrast, drops
  // out with a degrade code when the band is missing — it's a veto-style
  // check, and the two momentum legs still carry the confirmation.
  let confirmed = false;
  if (r1m > CONFIRMED.R1M_MIN
    && momentum_pct_3m != null
    && momentum_pct_3m >= CONFIRMED.PCT3M_MIN) {
    if (fiftyTwoValid && px != null) {
      confirmed = px >= CONFIRMED.PX_OVER_52WL_MIN * fiftyTwoWeek.low;
    } else {
      confirmed = true;
      degraded.push(REASON.DEGRADED_NO_52W); // deduped if the knife leg already flagged it
    }
  }

  if (confirmed) {
    // 5b. Tier-2 confirm gate (demote-only): with fresh technicals, CONFIRMED
    // additionally requires price above the 50-DMA and RSI-14 inside the
    // healthy band — oversold hasn't proven the turn, overbought is a chase.
    if (tier2
      && !(px > technicals.dma50
        && technicals.rsi14 >= TIER2_CONFIRM.RSI_MIN
        && technicals.rsi14 <= TIER2_CONFIRM.RSI_MAX)) {
      return finish(ENTRY_STATES.STABILIZING, [REASON.TIER2_UNCONFIRMED]);
    }
    // 6. MACRO_DEFER — only demotes a would-be CONFIRMED. Severe regime
    // (severity ≥ min) AND this row's sector resolving to a materially
    // negative impact. CONFIRMED_ALL is kept in the reasons so the row
    // shows what it would have been without the macro gate.
    const severity = macro?.severity;
    if (isNum(severity) && severity >= MACRO_DEFER.SEVERITY_MIN) {
      const impact = resolveSectorImpact(sector, macro?.sectorImpacts);
      if (impact != null && impact <= MACRO_DEFER.SECTOR_IMPACT_MAX) {
        return finish(ENTRY_STATES.MACRO_DEFER, [REASON.MACRO_DEFER, REASON.CONFIRMED_ALL]);
      }
    }
    return finish(ENTRY_STATES.ENTRY_CONFIRMED, [REASON.CONFIRMED_ALL]);
  }

  // 7. STABILIZING — not a knife, not confirmed. A low 52w position with a
  // rising 1M lands here by construction (the forming-base case): the sharp
  // knife legs need falling returns, and the crashed-then-bounced geometry
  // that clears px/52wHigh cannot simultaneously clear 1.05×52wLow.
  return finish(ENTRY_STATES.STABILIZING, []);
}
