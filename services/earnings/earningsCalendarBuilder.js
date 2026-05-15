/**
 * earningsCalendarBuilder.js
 *
 * Spine of the Earnings Watch tab. Reads NSE event-calendar (already
 * persisted at data/catalysts/events-latest.json by scripts/refresh-
 * catalysts.mjs) and produces a normalised, deduped, date-sorted list
 * of upcoming quarterly result events.
 *
 * Responsibilities:
 *   - Parse the NSE "DD-MMM-YYYY" date format into a stable ISO date.
 *   - Filter to earnings-relevant purposes only.
 *   - Dedupe multi-purpose rows (NSE files BIOCON twice on the same day
 *     when a board meeting covers both Financial Results and Fund
 *     Raising — we want one earnings card per (symbol, date), with the
 *     ancillary purposes captured as tags.
 *   - Compute days_until in IST so the UI's "days to event" matches what
 *     the user sees on screen at 9:00am Mumbai time.
 *   - Tag the fiscal quarter (Q1/Q2/Q3/Q4) from the event date so cards
 *     can show "Q4 FY26 result" without leaking date-string parsing into
 *     downstream modules.
 *
 * Pure function. No I/O — caller passes the already-loaded events array
 * and an optional "now" timestamp (defaults to Date.now()) so tests can
 * control the clock.
 */

// ────────── Date parsing ──────────

const MONTH_NAME_TO_INDEX = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * Parse "07-May-2026" → ISO date "2026-05-07".
 * Returns null on any malformed input — never throws (NSE has been
 * known to ship inconsistent rows; we'd rather skip a malformed row
 * than break the entire pipeline).
 */
export function parseNseDate(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const monthIdx = MONTH_NAME_TO_INDEX[m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase()];
  const year = Number(m[3]);
  if (monthIdx == null || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  if (day < 1 || day > 31) return null;
  // Construct as UTC midnight of the local IST date so two systems
  // running at different TZs still agree on which calendar day this is.
  const d = new Date(Date.UTC(year, monthIdx, day, 0, 0, 0, 0));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Days between two ISO dates (date strings, not full timestamps).
 * Returns negative if the event is in the past. Anchored to UTC midnight
 * to keep results stable regardless of when in the day this runs.
 */
export function daysBetween(fromIsoDate, toIsoDate) {
  const a = new Date(fromIsoDate + "T00:00:00Z").getTime();
  const b = new Date(toIsoDate + "T00:00:00Z").getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * "Today" anchored to IST. We always plan around the Mumbai trading
 * day — using server-local UTC would mean a Vercel cron at 19:00 UTC
 * (00:30 IST next day) thinks it's tomorrow already.
 */
export function istTodayIso(nowMs = Date.now()) {
  // IST is UTC+5:30 with no DST.
  const ist = new Date(nowMs + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

// ────────── Purpose classification ──────────

const RESULT_PURPOSE_REGEX = /financial\s*results?/i;
const ANCILLARY_TAG_PATTERNS = [
  { tag: "DIVIDEND",    re: /dividend/i },
  { tag: "BUYBACK",     re: /buy[\s-]*back/i },
  { tag: "SPLIT",       re: /sub[-\s]*division|stock\s*split|share\s*split/i },
  { tag: "BONUS",       re: /bonus\s*(?:issue|share)/i },
  { tag: "FUND_RAISE",  re: /fund[\s-]*rais/i },
  { tag: "MERGER",      re: /merger|amalgamation|scheme\s*of\s*arrangement/i },
  { tag: "DEMERGER",    re: /de[\s-]*merger|spin[\s-]*off/i },
  { tag: "MGMT_CHANGE", re: /appointment|resignation|change\s*in\s*directorate/i },
  { tag: "OTHER",       re: /other\s*business\s*matters?/i },
];

/**
 * Returns true if the event purpose mentions a board meeting to consider
 * quarterly/annual financial results. Excludes pure fund-raising or
 * dividend-only intimations even though they sometimes share dates.
 */
export function isResultEvent(purpose) {
  return typeof purpose === "string" && RESULT_PURPOSE_REGEX.test(purpose);
}

/**
 * Extract ancillary purposes (Dividend / Buyback / Fund Raise / etc.)
 * from a multi-purpose NSE row. The result is a deduped, sorted array of
 * tags useful for the UI ("Q4 FY26 + Dividend" pill).
 */
export function extractAncillaryTags(purpose, description = "") {
  const haystack = `${purpose || ""} ${description || ""}`;
  const tags = new Set();
  for (const { tag, re } of ANCILLARY_TAG_PATTERNS) {
    if (re.test(haystack)) tags.add(tag);
  }
  return Array.from(tags).sort();
}

// ────────── Fiscal quarter inference ──────────

/**
 * Map calendar month to Indian fiscal quarter label.
 * FY runs Apr-Mar:
 *   Q1 = Apr-Jun, Q2 = Jul-Sep, Q3 = Oct-Dec, Q4 = Jan-Mar.
 *
 * Board meetings to consider results typically happen 30-60 days after
 * the quarter ends, so a board meeting in May is most likely covering
 * Q4 of the previous fiscal year (Jan-Mar).
 */
export function inferFiscalQuarter(eventIsoDate) {
  if (typeof eventIsoDate !== "string" || eventIsoDate.length < 7) return null;
  const month = Number(eventIsoDate.slice(5, 7));
  const year = Number(eventIsoDate.slice(0, 4));
  if (!Number.isFinite(month) || !Number.isFinite(year)) return null;

  // Board-meeting → quarter-being-reported lookup. Each entry covers the
  // typical 30-60d post-quarter-end filing window.
  // Apr-Jun board meetings → Q4 of fiscal year ending in March of `year`.
  // Jul-Sep board meetings → Q1 of FY starting Apr `year`.
  // Oct-Dec board meetings → Q2 of FY starting Apr `year`.
  // Jan-Mar board meetings → Q3 of FY starting Apr (year-1).
  if (month >= 4 && month <= 6) {
    const fy = year; // FY ending Mar `year` is "FY${year-2000}".
    return { quarter: "Q4", fiscal_year: fy, label: `Q4 FY${String(fy).slice(2)}` };
  }
  if (month >= 7 && month <= 9) {
    const fy = year + 1;
    return { quarter: "Q1", fiscal_year: fy, label: `Q1 FY${String(fy).slice(2)}` };
  }
  if (month >= 10 && month <= 12) {
    const fy = year + 1;
    return { quarter: "Q2", fiscal_year: fy, label: `Q2 FY${String(fy).slice(2)}` };
  }
  // Jan-Mar
  const fy = year;
  return { quarter: "Q3", fiscal_year: fy, label: `Q3 FY${String(fy).slice(2)}` };
}

// ────────── Main builder ──────────

/**
 * Build the upcoming-results calendar from an events array.
 *
 * @param {Array<{symbol, company, purpose, date, description}>} rawEvents
 *   The `events` field of data/catalysts/events-latest.json.
 * @param {object} [opts]
 * @param {number} [opts.nowMs]       Override "now" for testing.
 * @param {number} [opts.windowDays]  Only emit events within this many
 *                                    forward days. Defaults to 30 to
 *                                    cover roughly one earnings month.
 *                                    Pass Infinity to disable.
 * @param {boolean} [opts.includePast] Include events with negative
 *                                    days_until (default false). We
 *                                    keep T+0 events because the user
 *                                    still wants to see "today's
 *                                    results" until end-of-day.
 *
 * @returns {Array<EarningsCalendarRow>} sorted ascending by event_iso_date.
 */
export function buildEarningsCalendar(rawEvents, opts = {}) {
  const nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : 30;
  const includePast = !!opts.includePast;
  const todayIso = istTodayIso(nowMs);

  if (!Array.isArray(rawEvents)) return [];

  // Step 1a — group ALL rows (result + non-result) by (symbol, iso_date)
  // so we can later fold non-result purposes (e.g. "Fund Raising"
  // board-meet on the same day) into the result event's tags. NSE
  // files these separately; the user wants them as one card.
  const allByKey = new Map();
  for (const raw of rawEvents) {
    if (!raw || typeof raw !== "object") continue;
    const symbol = typeof raw.symbol === "string" ? raw.symbol.trim().toUpperCase() : null;
    if (!symbol) continue;
    const eventIso = parseNseDate(raw.date);
    if (!eventIso) continue;
    const key = `${symbol}__${eventIso}`;
    const arr = allByKey.get(key) || [];
    arr.push({
      symbol,
      company: typeof raw.company === "string" ? raw.company.trim() : symbol,
      purpose: raw.purpose,
      description: typeof raw.description === "string" ? raw.description : "",
      event_iso_date: eventIso,
      is_result: isResultEvent(raw.purpose),
    });
    allByKey.set(key, arr);
  }

  // Step 1b — keep only (symbol, date) groups where at least one row
  // is a result event. Apply the window filter at the group level so
  // out-of-window groups are dropped entirely.
  const grouped = new Map();
  for (const [key, rows] of allByKey.entries()) {
    if (!rows.some((r) => r.is_result)) continue;
    const eventIso = rows[0].event_iso_date;
    const days = daysBetween(todayIso, eventIso);
    if (days == null) continue;
    if (!includePast && days < 0) continue;
    if (Number.isFinite(windowDays) && days > windowDays) continue;

    // Pick the result row as the canonical (longest description wins
    // among result rows; gives us the richest result-meeting agenda).
    const resultRows = rows.filter((r) => r.is_result);
    const canonical = resultRows.reduce((best, r) =>
      (r.description?.length ?? 0) > (best.description?.length ?? 0) ? r : best,
    resultRows[0]);

    // Aggregate tags across ALL rows for this date — including
    // non-result rows so a same-day Fund Raising / Buyback board meet
    // surfaces as a tag on the result card.
    const mergedTagSet = new Set();
    for (const r of rows) {
      for (const t of extractAncillaryTags(r.purpose, r.description)) {
        mergedTagSet.add(t);
      }
    }

    grouped.set(key, {
      symbol: canonical.symbol,
      company: canonical.company,
      purpose: canonical.purpose,
      description: canonical.description,
      event_iso_date: eventIso,
      days_until: days,
      tags: Array.from(mergedTagSet).sort(),
    });
  }

  // Step 2 — enrich with fiscal-quarter label and final shape.
  const out = [];
  for (const row of grouped.values()) {
    const fq = inferFiscalQuarter(row.event_iso_date);
    out.push({
      symbol: row.symbol,
      company: row.company,
      event_iso_date: row.event_iso_date,
      days_until: row.days_until,
      fiscal_quarter: fq ? fq.label : null,
      fiscal_quarter_meta: fq,
      tags: row.tags,
      description: row.description,
      source: "nse-event-calendar",
    });
  }

  // Step 4 — sort ascending by date, then by symbol for determinism.
  out.sort((a, b) => {
    if (a.event_iso_date !== b.event_iso_date) {
      return a.event_iso_date < b.event_iso_date ? -1 : 1;
    }
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });

  return out;
}

/**
 * Convenience wrapper — accepts the full payload object that
 * data/catalysts/events-latest.json deserialises into. Returns the
 * calendar plus a small meta block useful for the UI header chip.
 */
export function buildEarningsCalendarFromPayload(payload, opts = {}) {
  const events = payload && Array.isArray(payload.events) ? payload.events : [];
  const calendar = buildEarningsCalendar(events, opts);
  return {
    schema_version: "earnings-calendar-v1",
    built_at: new Date().toISOString(),
    upstream_fetched_at: payload?.fetched_at || null,
    upstream_event_count: payload?.event_count ?? events.length,
    window_days: Number.isFinite(opts.windowDays) ? opts.windowDays : 30,
    today_iso: istTodayIso(typeof opts.nowMs === "number" ? opts.nowMs : Date.now()),
    event_count: calendar.length,
    events: calendar,
  };
}
