/**
 * earningsWatchDiff.js
 *
 * Selects the "what's NEW in Earnings Watch today" rows for the daily
 * SWS-input-alert email (admin-gated). Pure: no I/O, no clock reads.
 *
 * Diffs today's live earnings snapshot against the most recent PRIOR per-day
 * archive (data/catalysts/earnings-history/<date>.json, loaded by the caller via
 * loadPriorArchivePredictions). Two signals, both honestly bounded:
 *
 *   - added: (symbol, event_iso_date) pairs newly present in the calendar, within
 *     an actionable near-term window. The full sorted list is returned + an
 *     `added_total` count; the RENDERER decides how many to show (holdings first,
 *     never silently truncated).
 *
 *   - verdict_changed: only MATERIAL flips — a BEAT<->MISS reversal, i.e. the
 *     "catastrophic" off-by-2 the archive already treats as the money-losing case
 *     (earningsHistoryArchive.js VERDICT_ORDER). Adjacent drift (INLINE<->BEAT,
 *     INLINE<->MISS) and any INSUFFICIENT_DATA/null transition are EXCLUDED: the
 *     verdict is as uncalibrated as confidence_pct (a documented coin-flip), so
 *     only a genuine direction reversal is signal, not noise.
 *
 * Held (⭐) is NOT applied here — the delta is GLOBAL (built once per cron
 * invocation and shared across recipients); starring the owner's holdings is a
 * per-user render concern. Keeping this pure lets the caller memoize it.
 */

import { canonicalSwsTicker } from "../swsInputSnapshot.js";
import { formatDaysUntil, formatConfidence, VERDICT_LABELS } from "./portfolioEarningsSection.js";

export const EARNINGS_ADDED_SECTION_VERSION = "earnings-added-section-v1-2026-07";

/** Newly-added events reporting within this many days are actionable enough to list. */
export const DEFAULT_ADDED_MAX_DAYS = 30;

/** Hard cap on rows in either list, as a runaway guard. */
export const DEFAULT_MAX_ROWS = 20;

// Mirrors earningsHistoryArchive.js: MISS↔BEAT is the off-by-2 "catastrophic"
// reversal. Adjacent moves (distance 1) are the coin-flip jitter we suppress.
const VERDICT_ORDER = Object.freeze({ MISS: 0, INLINE: 1, BEAT: 2 });

function isMaterialFlip(prevVerdict, currVerdict) {
  const a = VERDICT_ORDER[prevVerdict];
  const b = VERDICT_ORDER[currVerdict];
  if (a === undefined || b === undefined) return false; // excludes INSUFFICIENT_DATA/null
  return Math.abs(a - b) === 2;
}

function keyOf(symbol, isoDate) {
  const s = canonicalSwsTicker(symbol);
  return s && isoDate ? `${s}|${isoDate}` : null;
}

/** Copy scalars out of a live event into a render row (no object references retained). */
function toRow(event) {
  const prediction = event?.prediction || {};
  const symbol = canonicalSwsTicker(event?.symbol);
  const confidencePct = Number.isFinite(prediction.confidence_pct) ? prediction.confidence_pct : null;
  const verdict = typeof prediction.verdict === "string" && prediction.verdict
    ? prediction.verdict
    : "INSUFFICIENT_DATA";
  return {
    symbol,
    company: String(event?.company || "").trim() || symbol,
    event_iso_date: typeof event?.event_iso_date === "string" ? event.event_iso_date : "",
    days_until: event?.days_until,
    days_until_label: formatDaysUntil(event?.days_until),
    fiscal_quarter: String(event?.fiscal_quarter || "").trim() || "—",
    verdict,
    verdict_label: VERDICT_LABELS[verdict] || VERDICT_LABELS.INSUFFICIENT_DATA,
    confidence_pct: confidencePct,
    confidence_label: formatConfidence(confidencePct),
  };
}

/**
 * @param {object[]} currentEvents  live snapshot events (event.prediction.verdict)
 * @param {object[]} priorEvents    prior archive predictions (p.predicted_verdict)
 * @returns {{ added: object[], added_total: number, verdict_changed: object[],
 *            suppressed_reason: null | "no_prior" }}
 */
export function buildEarningsWatchDelta(currentEvents, priorEvents, opts = {}) {
  const { addedMaxDays = DEFAULT_ADDED_MAX_DAYS, maxRows = DEFAULT_MAX_ROWS } = opts;
  const current = Array.isArray(currentEvents) ? currentEvents : [];
  const prior = Array.isArray(priorEvents) ? priorEvents : [];

  // No prior snapshot (first ever run) → everything would look "new". Suppress
  // rather than dump the whole calendar.
  if (!prior.length) {
    return { added: [], added_total: 0, verdict_changed: [], suppressed_reason: "no_prior" };
  }

  const priorVerdictByKey = new Map();
  for (const p of prior) {
    const k = keyOf(p?.symbol, p?.event_iso_date);
    if (k) priorVerdictByKey.set(k, typeof p?.predicted_verdict === "string" ? p.predicted_verdict : null);
  }

  const added = [];
  const verdictChanged = [];
  for (const event of current) {
    const k = keyOf(event?.symbol, event?.event_iso_date);
    if (!k) continue;
    if (!priorVerdictByKey.has(k)) {
      // Newly in the calendar. Only near-term additions are actionable; far-edge
      // 60-day additions are noise.
      if (Number.isFinite(event?.days_until) && event.days_until >= 0 && event.days_until <= addedMaxDays) {
        added.push(toRow(event));
      }
      continue;
    }
    const prevVerdict = priorVerdictByKey.get(k);
    const row = toRow(event);
    if (isMaterialFlip(prevVerdict, row.verdict)) {
      verdictChanged.push({
        ...row,
        prev_verdict: prevVerdict,
        prev_verdict_label: VERDICT_LABELS[prevVerdict] || prevVerdict,
      });
    }
  }

  const byWhen = (a, b) => a.days_until - b.days_until || a.symbol.localeCompare(b.symbol);
  added.sort(byWhen);
  verdictChanged.sort(byWhen);

  return {
    // Full sorted list — the renderer caps NON-held rows and always keeps held.
    added,
    added_total: added.length,
    verdict_changed: verdictChanged.slice(0, maxRows),
    suppressed_reason: null,
  };
}
