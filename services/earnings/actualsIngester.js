/**
 * actualsIngester.js
 *
 * Resolves the post-result `actual_*` fields on archived earnings
 * predictions so the backtest harness can compute hit-rate, Brier,
 * and the V1 confidence-cap lift gate.
 *
 * Two sources, tried in order:
 *   1. SWS news briefs — `data/sws/deep/<TICKER>.json:news[]` carries a
 *      `type:"brief"` item per reporting period with a title like
 *      "Full year 2026 earnings: EPS exceeds analyst expectations".
 *      Zero network cost, covers the full ~5,500-stock SWS universe.
 *   2. Yahoo `earningsHistory` — `epsActual` / `epsEstimate` /
 *      `surprisePercent` per quarter. Network-bound, ~48% coverage
 *      (large-caps); used only when SWS has no result brief yet.
 *
 * KEYING DISCIPLINE — both sources are matched to the *fiscal-quarter
 * end* parsed from the prediction's `fiscal_quarter` string ("Q4 FY26"),
 * NOT to the NSE event announcement date. This is deliberate:
 *   - SWS news dates and Yahoo `quarter` dates are in different
 *     timezones than the IST event date; matching on the quarter end
 *     (a calendar boundary) sidesteps the off-by-one timezone bug.
 *   - Adjacent quarters are ~90d apart, so a generous post-quarter
 *     window cleanly isolates the right result without leaking the
 *     previous quarter's brief.
 *
 * Everything here is a pure function except `fetchActualFromYahoo`,
 * which accepts an injectable `yf` client so it can be unit-tested
 * without a network round-trip.
 */

import YahooFinance from "yahoo-finance2";

// Earnings-result classification thresholds — mirror the locked rule in
// scripts/sws-fetch-earnings-beat.mjs so SWS-news and Yahoo paths agree.
const BEAT_RATIO = 0.02;
const MISS_RATIO = -0.02;

// SWS publishes a result brief within SEBI's reporting limit (45d for
// Q1-Q3, 60d for Q4/annual) plus a few days of its own ingest lag. An
// 80-day post-quarter window covers the slowest filer; a 5-day pre-
// quarter buffer absorbs any date weirdness (results never precede the
// quarter close, but SWS timestamps occasionally sit on the boundary).
const DEFAULT_WINDOW_BEFORE_DAYS = 5;
const DEFAULT_WINDOW_AFTER_DAYS = 80;

// Yahoo's `quarter` field is the period-END date. Match the row whose
// quarter end is within ±45d of the computed Indian fiscal-quarter end.
const YAHOO_QUARTER_TOLERANCE_DAYS = 45;

const MS_PER_DAY = 86400000;

/* ───────────────────────── fiscal quarter ───────────────────────── */

/**
 * Parse an Indian fiscal-quarter label into its calendar quarter-end.
 *
 * Indian FY runs April→March. FY26 = Apr 2025 → Mar 2026, so:
 *   Q1 FY26 ends 2025-06-30   Q2 FY26 ends 2025-09-30
 *   Q3 FY26 ends 2025-12-31   Q4 FY26 ends 2026-03-31
 *
 * Accepts "Q4 FY26", "Q1 FY27", "q3 fy26", with or without spaces.
 * Returns { quarter, fy, quarterEndIso } or null when unparseable.
 */
export function parseFiscalQuarter(fqStr) {
  if (!fqStr || typeof fqStr !== "string") return null;
  const m = fqStr.trim().match(/^Q([1-4])\s*FY\s*(\d{2}|\d{4})$/i);
  if (!m) return null;
  const quarter = Number(m[1]);
  let fy = Number(m[2]);
  if (fy < 100) fy += 2000; // "26" → 2026
  let quarterEndIso;
  switch (quarter) {
    case 1: quarterEndIso = `${fy - 1}-06-30`; break;
    case 2: quarterEndIso = `${fy - 1}-09-30`; break;
    case 3: quarterEndIso = `${fy - 1}-12-31`; break;
    case 4: quarterEndIso = `${fy}-03-31`; break;
    default: return null;
  }
  return { quarter, fy, quarterEndIso };
}

function daysBetweenIso(aIso, bIso) {
  return (new Date(aIso + "T00:00:00Z").getTime() - new Date(bIso + "T00:00:00Z").getTime()) / MS_PER_DAY;
}

function isoDateOf(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/* ─────────────────────── title classification ───────────────────── */

const POS_KW = "exceed|exceeds|exceeded|beat|beats|surpass|surpasses|above|ahead";
const NEG_KW = "miss|misses|missed|lag|lags|lagged|below|short|shortfall|disappoint|disappoints|behind|fell short|fall short";
const INLINE_KW = "in[\\s-]?line|match|matches|matched|meet|meets|met|as expected|as anticipated";

/**
 * For a given subject ("eps" or a revenue regex fragment), look for a
 * pos / neg / inline keyword within ~40 chars on either side. Returns
 * 'pos' | 'neg' | 'inline' | null.
 */
function detectSubjectSignal(clause, subjectPattern) {
  const near = (kw) =>
    new RegExp(`(?:${subjectPattern})[^.;]{0,40}?\\b(?:${kw})\\b`, "i").test(clause) ||
    new RegExp(`\\b(?:${kw})\\b[^.;]{0,40}?(?:${subjectPattern})`, "i").test(clause);
  // inline is checked first — "in line" contains no pos/neg token, but a
  // mixed phrase like "broadly in line, though revenue beat" should read
  // as inline on the EPS subject only when EPS itself is the in-line one.
  if (near(INLINE_KW)) return "inline";
  const pos = near(POS_KW);
  const neg = near(NEG_KW);
  if (pos && !neg) return "pos";
  if (neg && !pos) return "neg";
  if (pos && neg) return "inline"; // genuinely ambiguous on one subject
  return null;
}

function signalToVerdict(sig) {
  if (sig === "pos") return "BEAT";
  if (sig === "neg") return "MISS";
  if (sig === "inline") return "INLINE";
  return null;
}

/**
 * Classify an SWS result-brief title into BEAT / INLINE / MISS.
 *
 * EPS is the headline metric. When EPS and revenue signals disagree
 * (e.g. "Revenues exceed... while EPS lags behind") the result is
 * INLINE — a mixed quarter. When only one subject is mentioned that
 * subject drives; when neither is named we fall back to a generic
 * read of the whole clause.
 *
 * Returns "BEAT" | "INLINE" | "MISS" or null when the title carries
 * no earnings-result signal at all.
 */
export function classifyEarningsTitle(title) {
  if (!title || typeof title !== "string") return null;
  // Strip the "<period> earnings:" prefix when present so the keyword
  // search runs over the result clause only.
  const lower = title.toLowerCase();
  const clauseStart = lower.indexOf("earnings:");
  const clause = clauseStart >= 0 ? lower.slice(clauseStart + "earnings:".length) : lower;

  const epsSig = detectSubjectSignal(clause, "eps|earnings per share");
  const revSig = detectSubjectSignal(clause, "revenue|revenues|sales|topline|top line");

  if (epsSig && revSig) {
    if (epsSig === revSig) return signalToVerdict(epsSig);
    // Disagreement (one positive, one negative, or one inline) → mixed.
    return "INLINE";
  }
  if (epsSig) return signalToVerdict(epsSig);
  if (revSig) return signalToVerdict(revSig);

  // Generic fallback — no subject named, read the whole clause.
  const generic = detectSubjectSignal(clause, "result|results|earnings|quarter|profit");
  if (generic) return signalToVerdict(generic);
  return null;
}

/**
 * True when an SWS news item is a per-period earnings result brief —
 * "type":"brief" with a title shaped "<period> earnings: ...". This
 * excludes narrative-update / article / event items that merely
 * mention "earnings".
 */
export function isEarningsResultBrief(newsItem) {
  if (!newsItem || typeof newsItem.title !== "string") return false;
  if (newsItem.type && newsItem.type !== "brief") return false;
  return /(full year|q[1-4])\s+\d{4}\s+earnings:/i.test(newsItem.title);
}

/* ───────────────────────── SWS news source ──────────────────────── */

/**
 * Extract the BEAT/INLINE/MISS verdict for a fiscal quarter from a
 * stock's SWS news array.
 *
 * @param {Array}  newsArr        deep file `.news[]`
 * @param {string} fiscalQuarter  e.g. "Q4 FY26"
 * @param {object} [opts]
 * @param {number} [opts.windowBeforeDays] pre-quarter-end buffer (days)
 * @param {number} [opts.windowAfterDays]  post-quarter-end window (days)
 * @returns {{actual_verdict, actual_source, actual_evidence}|null}
 */
export function extractActualVerdictFromSwsNews(newsArr, fiscalQuarter, opts = {}) {
  if (!Array.isArray(newsArr) || newsArr.length === 0) return null;
  const fq = parseFiscalQuarter(fiscalQuarter);
  if (!fq) return null;

  const before = Number.isFinite(opts.windowBeforeDays) ? opts.windowBeforeDays : DEFAULT_WINDOW_BEFORE_DAYS;
  const after = Number.isFinite(opts.windowAfterDays) ? opts.windowAfterDays : DEFAULT_WINDOW_AFTER_DAYS;

  const candidates = [];
  for (const item of newsArr) {
    if (!isEarningsResultBrief(item)) continue;
    const itemIso = isoDateOf(item.date);
    if (!itemIso) continue;
    const delta = daysBetweenIso(itemIso, fq.quarterEndIso);
    if (delta < -before || delta > after) continue; // wrong quarter
    const verdict = classifyEarningsTitle(item.title);
    if (!verdict) continue;
    candidates.push({ itemIso, delta, verdict, title: item.title });
  }
  if (candidates.length === 0) return null;

  // Most recent matching brief wins — naturally picks up a restatement
  // brief over the original if SWS published a correction.
  candidates.sort((a, b) => (a.itemIso < b.itemIso ? 1 : -1));
  const best = candidates[0];
  return {
    actual_verdict: best.verdict,
    actual_source: "sws_news",
    actual_evidence: `[${best.itemIso}] ${best.title}`,
  };
}

/* ──────────────────────────── Yahoo source ──────────────────────── */

function toYahooSymbol(ticker) {
  if (!ticker) return null;
  return ticker.endsWith(".NS") || ticker.endsWith(".BO") ? ticker : `${ticker}.NS`;
}

function classifyYahooRow({ epsActual, epsEstimate, surprisePercent }) {
  if (epsActual == null || epsEstimate == null) return null;
  if (epsEstimate === 0) return null;
  const ratio = surprisePercent != null ? surprisePercent : (epsActual - epsEstimate) / Math.abs(epsEstimate);
  if (ratio >= BEAT_RATIO) return "BEAT";
  if (ratio <= MISS_RATIO) return "MISS";
  return "INLINE";
}

/**
 * Resolve a quarter's actual verdict (and best-effort T+1 price) from
 * Yahoo Finance. Used only as a fallback when SWS has no result brief.
 *
 * @param {string} symbol         bare NSE ticker (".NS" appended if absent)
 * @param {string} fiscalQuarter  e.g. "Q4 FY26"
 * @param {string} eventIsoDate   NSE result date — anchors the T+1 lookup
 * @param {object} [opts]
 * @param {object} [opts.yf]      injectable yahoo-finance2 client (tests)
 * @param {number} [opts.quarterToleranceDays]
 * @returns {Promise<object|null>}
 */
export async function fetchActualFromYahoo(symbol, fiscalQuarter, eventIsoDate, opts = {}) {
  const fq = parseFiscalQuarter(fiscalQuarter);
  if (!fq) return null;
  const ySym = toYahooSymbol(symbol);
  if (!ySym) return null;

  const yf = opts.yf || new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  const tol = Number.isFinite(opts.quarterToleranceDays)
    ? opts.quarterToleranceDays
    : YAHOO_QUARTER_TOLERANCE_DAYS;

  let row = null;
  try {
    const res = await yf.quoteSummary(ySym, { modules: ["earningsHistory"] });
    const history = res?.earningsHistory?.history || [];
    // `quarter` is the period-END date. Pick the row closest to the
    // computed fiscal-quarter end, within tolerance — this rejects the
    // adjacent-quarter rows and the US-calendar-quarter confusion.
    let bestDelta = Infinity;
    for (const r of history) {
      const qIso = isoDateOf(r.quarter);
      if (!qIso) continue;
      const delta = Math.abs(daysBetweenIso(qIso, fq.quarterEndIso));
      if (delta <= tol && delta < bestDelta) {
        bestDelta = delta;
        row = r;
      }
    }
  } catch {
    return null;
  }
  if (!row) return null;

  const verdict = classifyYahooRow({
    epsActual: row.epsActual ?? null,
    epsEstimate: row.epsEstimate ?? null,
    surprisePercent: row.surprisePercent ?? null,
  });
  if (!verdict) return null;

  const qIso = isoDateOf(row.quarter);
  const surp = row.surprisePercent != null ? `${(row.surprisePercent * 100).toFixed(1)}%` : "n/a";
  const out = {
    actual_verdict: verdict,
    actual_source: "yahoo",
    actual_evidence: `Yahoo earningsHistory q=${qIso} epsActual=${row.epsActual} epsEst=${row.epsEstimate} surprise=${surp}`,
    actual_t1_close_inr: null,
    actual_t1_open_gap_pct: null,
  };

  // Best-effort T+1 price — the verdict is the load-bearing field, so a
  // chart failure must not sink the whole resolution.
  if (eventIsoDate) {
    try {
      const p1 = new Date(eventIsoDate + "T00:00:00Z");
      const p2 = new Date(p1.getTime() + 9 * MS_PER_DAY);
      const chart = await yf.chart(ySym, { period1: p1, period2: p2, interval: "1d" });
      const quotes = (chart?.quotes || []).filter((q) => q && q.date);
      const eventDayIdx = quotes.findIndex((q) => isoDateOf(q.date) >= eventIsoDate);
      if (eventDayIdx >= 0 && quotes[eventDayIdx + 1]) {
        const eventDay = quotes[eventDayIdx];
        const t1 = quotes[eventDayIdx + 1];
        if (Number.isFinite(t1.close)) out.actual_t1_close_inr = t1.close;
        if (Number.isFinite(t1.open) && Number.isFinite(eventDay.close) && eventDay.close > 0) {
          out.actual_t1_open_gap_pct = ((t1.open - eventDay.close) / eventDay.close) * 100;
        }
      }
    } catch {
      // leave T+1 fields null
    }
  }
  return out;
}

/* ─────────────────────── combined resolution ────────────────────── */

/**
 * Resolve one event's actuals — SWS news primary, Yahoo fallback.
 *
 * @param {object} args
 * @param {string} args.symbol
 * @param {string} args.fiscalQuarter
 * @param {string} args.eventIsoDate
 * @param {Array}  [args.swsNews]   deep file `.news[]` (omit to skip SWS)
 * @param {object} [args.opts]
 * @returns {Promise<object|null>} the `actual_*` patch, or null when
 *          neither source can resolve the quarter yet.
 */
export async function resolveActualForEvent({ symbol, fiscalQuarter, eventIsoDate, swsNews, opts = {} }) {
  const nowIso = new Date().toISOString();

  const sws = extractActualVerdictFromSwsNews(swsNews || [], fiscalQuarter, opts);
  if (sws) {
    return {
      actual_verdict: sws.actual_verdict,
      actual_source: sws.actual_source,
      actual_evidence: sws.actual_evidence,
      actual_t1_close_inr: null,
      actual_t1_open_gap_pct: null,
      resolved_at_iso: nowIso,
    };
  }

  const yahoo = await fetchActualFromYahoo(symbol, fiscalQuarter, eventIsoDate, opts);
  if (yahoo) {
    return {
      actual_verdict: yahoo.actual_verdict,
      actual_source: yahoo.actual_source,
      actual_evidence: yahoo.actual_evidence,
      actual_t1_close_inr: yahoo.actual_t1_close_inr,
      actual_t1_open_gap_pct: yahoo.actual_t1_open_gap_pct,
      resolved_at_iso: nowIso,
    };
  }
  return null;
}

/* ──────────────────── resolvable-key selection ──────────────────── */

/**
 * Walk every loaded history file and return the set of unique
 * (symbol, event_iso_date) keys that need resolution — deduped so a
 * single event appearing in N daily snapshots is resolved once.
 *
 * @param {Array}  history  output of loadAllHistory()
 * @param {object} [opts]
 * @param {string} [opts.todayIso]    IST today (events strictly before
 *                                    this are eligible — T+1 must exist)
 * @param {number} [opts.sinceDays]   only events within this lookback
 * @param {string} [opts.symbol]      restrict to one ticker
 * @param {boolean}[opts.reResolve]   include already-resolved events
 *                                    within 90d (restatement re-check)
 * @returns {Array<{symbol, event_iso_date, fiscal_quarter, files, alreadyResolved}>}
 */
export function selectResolvableKeys(history, opts = {}) {
  const todayIso = opts.todayIso || new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const sinceDays = Number.isFinite(opts.sinceDays) ? opts.sinceDays : 120;
  const symbolFilter = opts.symbol ? String(opts.symbol).toUpperCase() : null;
  const reResolve = !!opts.reResolve;

  // Derive every cutoff from todayIso so the selection is deterministic.
  const todayMs = new Date(todayIso + "T00:00:00Z").getTime();
  const sinceIso = isoDateOf(new Date(todayMs - sinceDays * MS_PER_DAY));
  const reResolveCutoffIso = isoDateOf(new Date(todayMs - 90 * MS_PER_DAY));

  const byKey = new Map();
  for (const day of history || []) {
    for (const r of day.predictions || []) {
      if (!r || !r.symbol || !r.event_iso_date) continue;
      if (symbolFilter && r.symbol.toUpperCase() !== symbolFilter) continue;
      // Event must have passed (T+1 exists) and sit inside the lookback.
      if (!(r.event_iso_date < todayIso)) continue;
      if (r.event_iso_date < sinceIso) continue;

      const key = `${r.symbol}|${r.event_iso_date}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          symbol: r.symbol,
          event_iso_date: r.event_iso_date,
          fiscal_quarter: r.fiscal_quarter || null,
          files: new Set(),
          alreadyResolved: false,
        };
        byKey.set(key, entry);
      }
      if (day.filename) entry.files.add(day.filename);
      if (r.fiscal_quarter && !entry.fiscal_quarter) entry.fiscal_quarter = r.fiscal_quarter;
      if (r.actual_verdict) entry.alreadyResolved = true;
    }
  }

  const out = [];
  for (const entry of byKey.values()) {
    if (entry.alreadyResolved) {
      // Already resolved — only revisit when re-resolution is enabled
      // and the event is recent enough for a restatement to land.
      if (!reResolve) continue;
      if (entry.event_iso_date < reResolveCutoffIso) continue;
    }
    out.push({
      symbol: entry.symbol,
      event_iso_date: entry.event_iso_date,
      fiscal_quarter: entry.fiscal_quarter,
      files: [...entry.files],
      alreadyResolved: entry.alreadyResolved,
    });
  }
  // Stable order — newest events first so a capped run resolves the
  // freshest quarters before older ones.
  out.sort((a, b) => (a.event_iso_date < b.event_iso_date ? 1 : -1));
  return out;
}
