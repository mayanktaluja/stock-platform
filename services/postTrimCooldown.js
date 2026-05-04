// Post-trim cooldown — suppress repeat Reduction-* calls on holdings the
// user already trimmed.
//
// Without this, a stateless action engine keeps re-issuing the same
// "Reduction-25%" recommendation each run because its inputs (SWS verdict,
// v3 score, PnL%) don't change just because the user executed the trim.
// User actions in good faith would be met with the same instruction
// tomorrow — Groundhog Day.
//
// Mechanism (two complementary triggers):
//   1. Fresh-trim detection — currentQty <= priorQty * (1 - TRIM_PCT).
//   2. Recent-trim memory   — priorSnapshot row carries lastTrimmedAt and
//      it falls inside the cooldown window.
//
// When either trigger fires AND the engine wants a Reduction-*, the action
// is overridden to HOLD with a `recentlyTrimmedReason` badge. Top-ups,
// HOLDs and EXITs are never softened — the cooldown only suppresses
// follow-up trims, not direction reversals or terminal sell calls.

import { snapshotByTicker } from "./analyzerDiff.js";
import { ALL_REDUCTION_ACTIONS } from "./actionLadder.js";

// Treat any qty drop ≥ 10% as a deliberate trim (anything smaller is
// likely T+1 settlement noise, dividend re-investment, or a corporate
// action like a split).
const TRIM_DETECTION_PCT = 0.10;

// Days the cooldown stays active after a detected trim. 14 calendar days
// covers a typical "let the position settle, see how the next earnings
// /catalyst lands" window without becoming a permanent trim suppressant.
const COOLDOWN_DAYS = 14;

const MS_PER_DAY = 86400000;

function _daysSince(iso, now) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (now - t) / MS_PER_DAY;
}

/**
 * Decide whether a single holding is in cooldown right now.
 *
 * Returns { inCooldown: boolean, trimmedPct: number|null,
 *          trimmedAt: string|null, daysAgo: number|null,
 *          source: "fresh"|"memory"|null }.
 */
export function evaluateCooldown({ holding, priorRow, now = Date.now(), trimDetectionPct = TRIM_DETECTION_PCT, cooldownDays = COOLDOWN_DAYS }) {
  const result = { inCooldown: false, trimmedPct: null, trimmedAt: null, daysAgo: null, source: null };
  if (!priorRow) return result;

  const curQty = Number.isFinite(holding?.quantity) ? holding.quantity : null;
  const priorQty = Number.isFinite(priorRow.quantity) ? priorRow.quantity : null;

  // Trigger 1 — qty dropped this run vs the prior snapshot.
  if (curQty != null && priorQty != null && priorQty > 0 && curQty <= priorQty * (1 - trimDetectionPct)) {
    const trimmedFraction = (priorQty - curQty) / priorQty;
    return {
      inCooldown: true,
      trimmedPct: Math.round(trimmedFraction * 100),
      trimmedAt: new Date(now).toISOString(),
      daysAgo: 0,
      source: "fresh",
    };
  }

  // Trigger 2 — prior snapshot carried a lastTrimmedAt within the window.
  // Useful when the user trims once, then re-runs the analyzer multiple
  // times without trading further — the qty diff is zero, but the user
  // shouldn't see fresh Reduction calls repeatedly.
  const daysAgo = _daysSince(priorRow.lastTrimmedAt, now);
  if (daysAgo != null && daysAgo >= 0 && daysAgo <= cooldownDays) {
    return {
      inCooldown: true,
      trimmedPct: null,
      trimmedAt: priorRow.lastTrimmedAt,
      daysAgo: Math.round(daysAgo * 10) / 10,
      source: "memory",
    };
  }

  return result;
}

/**
 * Apply the cooldown across a list of scored holdings. Returns a new
 * array (does not mutate the input). For each holding in cooldown whose
 * action is a Reduction-*, replaces:
 *
 *   .action          -> "HOLD"
 *   .originalAction  -> the engine's pre-cooldown call
 *   .recentlyTrimmedReason -> human-readable badge text
 *   .cooldown        -> { source, trimmedPct, trimmedAt, daysAgo }
 *
 * Top-ups, EXITs and pre-existing HOLDs flow through untouched.
 *
 * @returns { holdings, cooledCount } — `cooledCount` is the number of
 *   reductions that got softened. The caller can surface this in the
 *   summary banner if it wants.
 */
export function applyPostTrimCooldown(scoredHoldings, priorSnapshot, opts = {}) {
  const now = opts.now instanceof Date ? opts.now.getTime() : (opts.now || Date.now());
  const priorByTicker = snapshotByTicker(priorSnapshot);
  let cooledCount = 0;

  const holdings = (scoredHoldings || []).map((h) => {
    const ticker = h?.sws?.ticker || h?.symbol || h?.ticker || null;
    const priorRow = ticker ? priorByTicker.get(ticker) : null;
    const ev = evaluateCooldown({ holding: h, priorRow, now, trimDetectionPct: opts.trimDetectionPct, cooldownDays: opts.cooldownDays });
    if (!ev.inCooldown) return h;
    if (!ALL_REDUCTION_ACTIONS.has(h.action)) return h; // never soften top-ups / HOLD / EXIT
    cooledCount++;

    const reason = ev.source === "fresh"
      ? `Trimmed ${ev.trimmedPct}% since last review — signal unchanged but you've already acted. Sit ${COOLDOWN_DAYS} days before re-evaluating.`
      : `Trimmed ${ev.daysAgo}d ago — within ${COOLDOWN_DAYS}-day cooldown. Engine wants ${h.action} again but you already acted; observe before further trim.`;

    return {
      ...h,
      action: "HOLD",
      originalAction: h.action,
      recentlyTrimmedReason: reason,
      cooldown: {
        source: ev.source,
        trimmedPct: ev.trimmedPct,
        trimmedAt: ev.trimmedAt,
        daysAgo: ev.daysAgo,
      },
    };
  });

  return { holdings, cooledCount };
}

export const _internals = { TRIM_DETECTION_PCT, COOLDOWN_DAYS };
