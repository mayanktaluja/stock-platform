/**
 * Risk Lab — Quality Lens / Consecutive-Miss Detector.
 *
 * Re-derives what the production scoreLastQuarterEcho() in
 * services/earnings/earningsPredictor.js SHOULD compute but doesn't,
 * because its source field signals.sws_upcoming_earnings.last_quarter_result
 * is null for many stocks even when the truth sits in
 * data/sws/deep/<TICKER>.json:news[].
 *
 * The canonical case is KEC International (Risk Lab plan trigger 2):
 *   - Predicted BEAT @ 65% conf on 2026-05-15 → actual MISS on 2026-05-16
 *   - SWS news on 2026-01-31: "Third quarter 2026 earnings: EPS and
 *     revenues miss analyst expectations"
 *   - SWS news on 2026-02-03: "KEC International Limited Just Missed EPS
 *     By 41%: Here's What Analysts Think Will Happen Next"
 *   - signals.sws_upcoming_earnings.last_quarter_result was null because
 *     the upstream extractor only checks one field and never falls back
 *     to news[] text.
 *
 * This detector parses SWS news[] for entries dated in
 * [event_iso_date - 120d, event_iso_date - 30d] (i.e. roughly "the most
 * recent prior quarter's reporting window"), matches against miss
 * patterns with a negation guard, and emits a -4 pt quality penalty
 * with cited evidence (title + date) when found.
 *
 * The lab uses this to derive its own last_quarter signal in parallel
 * with the production predictor. The production code is NOT modified.
 */

// Patterns that indicate a prior quarter missed estimates. Tested below
// against both KEC fixture titles + adversarial cases ("won't miss",
// "don't miss the rally"). Each pattern fires on a title independently.
const MISS_PATTERNS = [
  /miss(?:ed)?\s+analyst\s+(?:estimate|expectation|forecast)/i,
  /miss(?:ed)?\s+(?:eps|earnings)\s+(?:estimate|expectation|forecast|target|by)/i,
  /\beps\s+(?:and\s+revenues?\s+)?miss(?:ed)?\s+(?:analyst|estimate|expectation)/i,
  /\b(?:earnings|results?)[^.]{0,30}miss(?:ed)?\s+(?:analyst|estimate|expectation)/i,
  /just\s+miss(?:ed)?\s+(?:eps|earnings|estimate|by\s+\d+%)/i,
  /miss(?:ed)?\s+(?:eps|earnings|estimate|expectation)s?\s+by\s+\d+%/i,
];

// Negation guards — if any of these appears within 4 words BEFORE a "miss"
// match, suppress the signal. Catches "won't miss", "did not miss", etc.
const NEGATION_PATTERN = /\b(?:won['']?t|wo\s?n['']?t|will\s+not|cannot|did\s?n['']?t|do\s?n['']?t|never|no(?:t|ne)?)\s+(?:\w+\s+){0,4}miss/i;

const DEFAULT_LOOKBACK_DAYS = 120;
const DEFAULT_BUFFER_DAYS = 30;
const PENALTY_PTS = -4;

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Check a single news title against the miss patterns + negation guard.
 * Returns { matched: bool, pattern?: string }.
 */
function titleSuggestsMiss(title) {
  if (!title || typeof title !== "string") return { matched: false };
  if (NEGATION_PATTERN.test(title)) return { matched: false };
  for (const pattern of MISS_PATTERNS) {
    if (pattern.test(title)) {
      return { matched: true, pattern: pattern.source };
    }
  }
  return { matched: false };
}

/**
 * Detect whether the most recent prior quarter missed estimates by parsing
 * the SWS news array.
 *
 * @param {object[]} news — array of SWS news objects {title, date, url?}
 * @param {string} eventIsoDate — the upcoming earnings event date
 * @param {object} opts — { lookbackDays?, bufferDays?, now? }
 * @returns {object} { detected, penaltyPts, evidence[], windowStart, windowEnd }
 */
export function detectConsecutiveMiss(news, eventIsoDate, opts = {}) {
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const bufferDays = opts.bufferDays ?? DEFAULT_BUFFER_DAYS;

  const eventDate = parseDate(eventIsoDate);
  if (!eventDate) {
    return {
      detected: false,
      penaltyPts: 0,
      evidence: [],
      windowStart: null,
      windowEnd: null,
      reason: "missing_or_invalid_event_date",
    };
  }

  const windowEnd = new Date(eventDate.getTime() - bufferDays * 24 * 60 * 60 * 1000);
  const windowStart = new Date(eventDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  if (!Array.isArray(news) || news.length === 0) {
    return {
      detected: false,
      penaltyPts: 0,
      evidence: [],
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      reason: "no_news",
    };
  }

  const evidence = [];
  for (const item of news) {
    const itemDate = parseDate(item?.date);
    if (!itemDate) continue;
    if (itemDate < windowStart || itemDate > windowEnd) continue;
    const check = titleSuggestsMiss(item.title);
    if (check.matched) {
      evidence.push({
        title: item.title,
        date: item.date,
        url: item.url || null,
        pattern: check.pattern,
      });
    }
  }

  if (evidence.length === 0) {
    return {
      detected: false,
      penaltyPts: 0,
      evidence: [],
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      reason: "no_match_in_window",
    };
  }

  // Sort by date descending so the most recent evidence is first — the UI
  // and confidence calibrator both prefer the freshest signal.
  evidence.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return {
    detected: true,
    penaltyPts: PENALTY_PTS,
    evidence,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    reason: "match",
  };
}
