/**
 * recentResultsBuilder.js
 *
 * Builds the `recent_results` field carried alongside `events` in
 * data/catalysts/earnings-watch-latest.json. The Earnings Watch tab
 * renders this as a "Recent / status tracker · past N days" section
 * above the upcoming card grid, showing original prediction plus either
 * resolved actual verdict + accuracy, or a PENDING status until actuals land.
 *
 * Design notes:
 *   - The history files at data/catalysts/earnings-history/<refresh-
 *     date>.json are keyed by REFRESH date, not event date — the same
 *     event appears in every snapshot until it passes. loadAllHistory +
 *     dedupePredictions returns one row per (symbol, event_iso_date)
 *     with resolved rows winning, which is exactly what we need.
 *   - Past rows are a slim projection by construction: no signals,
 *     price_band, rationale, or playbook fields. That keeps the
 *     snapshot lean (~150KB saved vs merging into events[]) and avoids
 *     verdict-filter ambiguity on the UI (the upcoming "Verdict: BEAT"
 *     filter only ever applies to upcoming).
 *   - Rows without actual_verdict stay visible as PENDING after the
 *     event date through the pastWindowDays cutoff, even before actuals
 *     resolve. Same-day rows remain in events[] to avoid duplicate cards.
 *
 * Pure module — no FS side effects beyond what loadAllHistory does.
 */

import { loadAllHistory, dedupePredictions } from "./earningsHistoryArchive.js";

function istTodayIso(nowMs = Date.now()) {
  return new Date(nowMs + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function subtractDays(iso, days) {
  const d = new Date(iso + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(aIso, bIso) {
  const a = Date.UTC(+aIso.slice(0, 4), +aIso.slice(5, 7) - 1, +aIso.slice(8, 10));
  const b = Date.UTC(+bIso.slice(0, 4), +bIso.slice(5, 7) - 1, +bIso.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

/**
 * Build the recent_results slim array for the snapshot.
 *
 * @param {object} opts
 * @param {string} [opts.todayIso]        IST date the lookback anchors to (defaults to IST today)
 * @param {number} [opts.pastWindowDays]  How many calendar days back to include (default 14)
 * @param {Map<string,string>} [opts.companyByEventKey]  Optional `${symbol}|${event_iso_date}` → company.
 *                                                       Sourced from the current calendar — exact match wins.
 * @param {Map<string,string>} [opts.companyBySymbol]    Optional symbol → company fallback used when the
 *                                                       event-keyed lookup misses (past events whose ticker
 *                                                       has rolled off the NSE upcoming calendar).
 *
 * @returns {Array<object>}  Slim records ready to serialise.
 */
export function buildRecentResults(opts = {}) {
  const todayIso = opts.todayIso || istTodayIso();
  const pastWindowDays = Number.isFinite(opts.pastWindowDays) ? opts.pastWindowDays : 14;
  const companyByEventKey = opts.companyByEventKey || new Map();
  const companyBySymbol = opts.companyBySymbol || new Map();

  const earliestIso = subtractDays(todayIso, pastWindowDays);

  const history = loadAllHistory();
  const deduped = dedupePredictions(history);

  const out = [];
  for (const r of deduped) {
    if (!r || !r.symbol || !r.event_iso_date) continue;
    if (r.event_iso_date < earliestIso) continue;
    if (r.event_iso_date >= todayIso) continue;

    const actualStatus = r.actual_verdict ? "RESOLVED" : "PENDING";
    const accuracy =
      r.predicted_verdict && r.actual_verdict
        ? r.predicted_verdict === r.actual_verdict ? "hit" : "miss"
        : "pending";

    const key = `${r.symbol}|${r.event_iso_date}`;
    const company = companyByEventKey.get(key) || companyBySymbol.get(r.symbol) || null;

    out.push({
      symbol: r.symbol,
      company,
      fiscal_quarter: r.fiscal_quarter || null,
      event_iso_date: r.event_iso_date,
      days_until: daysBetween(todayIso, r.event_iso_date),
      sector: r.sector || null,
      predicted_verdict: r.predicted_verdict,
      confidence_pct: typeof r.confidence_pct === "number" ? r.confidence_pct : null,
      score_100: typeof r.score_100 === "number" ? r.score_100 : null,
      actual_verdict: r.actual_verdict,
      actual_t1_close_inr: typeof r.actual_t1_close_inr === "number" ? r.actual_t1_close_inr : null,
      actual_t1_open_gap_pct: typeof r.actual_t1_open_gap_pct === "number" ? r.actual_t1_open_gap_pct : null,
      actual_source: r.actual_source || null,
      actual_evidence: r.actual_evidence || null,
      actual_resolved_at: r.resolved_at_iso || null,
      actual_status: actualStatus,
      prediction_accuracy: accuracy,
    });
  }

  out.sort((a, b) => {
    if (a.event_iso_date !== b.event_iso_date) {
      return a.event_iso_date > b.event_iso_date ? -1 : 1;
    }
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });

  return out;
}
