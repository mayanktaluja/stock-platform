// Detect recent trims (qty drop ≥ 10% vs prior snapshot, or
// `lastTrimmedAt` within N days) for **informational chip rendering only**.
// Does NOT gate engine actions.
//
// User policy (2026-05-06): today's SWS signal must always be visible.
// A holding the user trimmed yesterday still gets today's V3 rung —
// the chip is a passive nudge, not a suppressor.

import { snapshotByTicker } from "./analyzerDiff.js";

// Treat any qty drop ≥ 10% as a deliberate trim (anything smaller is
// likely T+1 settlement noise, dividend re-investment, or a corporate
// action like a split).
const TRIM_DETECTION_PCT = 0.10;

// Look-back window for the informational chip. Past this, the trim is
// considered "old news" and the chip stops rendering.
const RECENT_TRIM_WINDOW_DAYS = 14;

const MS_PER_DAY = 86400000;

function _daysSince(iso, now) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (now - t) / MS_PER_DAY;
}

/**
 * Decide whether a single holding was recently trimmed.
 *
 * Returns { isRecent: boolean, trimmedPct: number|null,
 *          trimmedAt: string|null, daysAgo: number|null,
 *          source: "fresh"|"memory"|null }.
 */
export function detectFreshTrim({ holding, priorRow, now = Date.now(), trimDetectionPct = TRIM_DETECTION_PCT, windowDays = RECENT_TRIM_WINDOW_DAYS }) {
  const result = { isRecent: false, trimmedPct: null, trimmedAt: null, daysAgo: null, source: null };
  if (!priorRow) return result;

  const curQty = Number.isFinite(holding?.quantity) ? holding.quantity : null;
  const priorQty = Number.isFinite(priorRow.quantity) ? priorRow.quantity : null;

  // Trigger 1 — qty dropped this run vs the prior snapshot.
  if (curQty != null && priorQty != null && priorQty > 0 && curQty <= priorQty * (1 - trimDetectionPct)) {
    const trimmedFraction = (priorQty - curQty) / priorQty;
    return {
      isRecent: true,
      trimmedPct: Math.round(trimmedFraction * 100),
      trimmedAt: new Date(now).toISOString(),
      daysAgo: 0,
      source: "fresh",
    };
  }

  // Trigger 2 — prior snapshot carried a lastTrimmedAt within the window.
  const daysAgo = _daysSince(priorRow.lastTrimmedAt, now);
  if (daysAgo != null && daysAgo >= 0 && daysAgo <= windowDays) {
    return {
      isRecent: true,
      trimmedPct: null,
      trimmedAt: priorRow.lastTrimmedAt,
      daysAgo: Math.round(daysAgo * 10) / 10,
      source: "memory",
    };
  }

  return result;
}

/**
 * Annotate scored holdings with `recentTrimInfo` metadata for UI chip
 * rendering. Returns a new array (does not mutate inputs). The chip is
 * informational only — `action` is never modified, so today's SWS
 * recommendation always rides through.
 */
export function annotateRecentTrims(scoredHoldings, priorSnapshot, opts = {}) {
  const now = opts.now instanceof Date ? opts.now.getTime() : (opts.now || Date.now());
  const priorByTicker = snapshotByTicker(priorSnapshot);

  return (scoredHoldings || []).map((h) => {
    const ticker = h?.sws?.ticker || h?.symbol || h?.ticker || null;
    const priorRow = ticker ? priorByTicker.get(ticker) : null;
    const ev = detectFreshTrim({ holding: h, priorRow, now, trimDetectionPct: opts.trimDetectionPct, windowDays: opts.windowDays });
    if (!ev.isRecent) return h;
    return {
      ...h,
      recentTrimInfo: {
        source: ev.source,
        trimmedPct: ev.trimmedPct,
        trimmedAt: ev.trimmedAt,
        daysAgo: ev.daysAgo,
      },
    };
  });
}

export const _internals = { TRIM_DETECTION_PCT, RECENT_TRIM_WINDOW_DAYS };
