// Pulls the most recent reported earnings event for a stock — the date plus
// whether it was a quarterly or audited annual filing — so the Portfolio
// Analyzer can render a "Last earnings: <date> (quarter|annual)" column
// alongside the upcoming-result date.
//
// Primary signal: SWS news briefs at data/sws/deep/<TICKER>.json. Brief
// titles shaped "Full year YYYY earnings: …" or "Q[1-4] YYYY earnings: …"
// are emitted by SWS within a few days of each Indian-company filing. The
// detection regex is shared with the actuals ingester (single source of
// truth for "this is a per-period earnings result brief").
//
// Fallback signal: Yahoo fundamentalsHistory.json — its per-ticker entry
// holds `annual[]` and `quarterly[]` arrays ordered OLDEST-FIRST, each
// with an `endDate`. We pick the latest endDate across both arrays and
// label it by which array it came from.
//
// Coverage stays graceful: stocks with neither source return null, which
// the UI renders as "—". No new scrape, no new disk I/O — this reuses
// the deep file already loaded by scoreHolding and a shared snapshot of
// fundamentalsHistory threaded through portfolioContext.

import { isEarningsResultBrief } from "./actualsIngester.js";

function toIsoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function pickLatestFundamentalsEntry(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  // The Yahoo arrays in fundamentalsHistory.json are oldest-first; the
  // latest reported period is the last element.
  for (let i = arr.length - 1; i >= 0; i--) {
    const endDate = arr[i]?.endDate;
    if (typeof endDate !== "string") continue;
    const ms = Date.parse(endDate + "T00:00:00Z");
    if (Number.isFinite(ms)) return { endDate, ms };
  }
  return null;
}

export function extractLastEarnings({ deep, fundamentalsHistory, ticker } = {}) {
  // 1. SWS news briefs — highest fidelity when present.
  const news = Array.isArray(deep?.news) ? deep.news : [];
  let latest = null;
  for (const n of news) {
    if (!isEarningsResultBrief(n)) continue;
    const ms = Date.parse(n.date);
    if (!Number.isFinite(ms)) continue;
    if (!latest || ms > latest.ms) latest = { ms, title: String(n.title) };
  }
  if (latest) {
    return {
      date: toIsoDate(latest.ms),
      period: /^full year/i.test(latest.title) ? "annual" : "quarter",
      source: "sws_news",
    };
  }

  // 2. Yahoo fundamentalsHistory fallback. Keys use the .NS Yahoo suffix.
  if (!ticker) return null;
  const yKey = ticker.endsWith(".NS") || ticker.endsWith(".BO") ? ticker : `${ticker}.NS`;
  const entry = fundamentalsHistory?.stocks?.[yKey] || null;
  if (!entry) return null;
  const q = pickLatestFundamentalsEntry(entry.quarterly);
  const a = pickLatestFundamentalsEntry(entry.annual);
  if (!q && !a) return null;
  if (a && (!q || a.ms > q.ms)) {
    return { date: a.endDate, period: "annual", source: "fundamentals_history" };
  }
  return { date: q.endDate, period: "quarter", source: "fundamentals_history" };
}
