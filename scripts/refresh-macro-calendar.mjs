#!/usr/bin/env node
// Refresh data/macroCalendar.json from public macro-event sources.
//
// This is intentionally conservative: if fetches fail or the future event set
// is too thin, the script preserves the previous good file and does not bump
// _updated. That keeps the dashboard from hiding staleness behind an empty or
// partially fetched calendar.
//
// Because keeping the previous file is the correct response to a bad fetch but
// the WRONG state to sit in indefinitely, a kept-previous run whose file is
// already past MAX_AGE_HOURS exits EXIT_STALE so the nightly chain reports it
// instead of logging OK.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const OUTPUT_PATH = "data/macroCalendar.json";

// Mirrors the macro_calendar threshold in scripts/check-snapshot-health.mjs.
// Once _updated crosses this the UI shows "Stale data: Macro calendar", so a
// refresh that keeps the previous file past this point is a real outage and
// must exit non-zero (see EXIT_STALE).
const MAX_AGE_HOURS = 720;
const EXIT_STALE = 2;
// Kept the previous file while it is still fresh: not a failure, but nothing
// was written, and a run of these is what a dying pipeline looks like on day 1
// rather than on day 30.
const EXIT_KEPT_PREVIOUS = 3;
// Wrote, but at least one source contributed no forward event. Partial decay
// is how a healthy-looking calendar rots one feed at a time.
const EXIT_DEGRADED = 4;

const SOURCES = {
  fomc: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
  bls: "https://www.bls.gov/schedule/news_release/bls.ics",
  // RBI publishes no forward MPC calendar page. Every MPC resolution closes
  // with "The next meeting of the MPC is scheduled for <dates>", so we walk
  // the press-release listing to the newest resolution and read it from there.
  rbiPressReleases: "https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx",
  rbiScriptsBase: "https://www.rbi.org.in/Scripts/",
};

// MoSPI's release calendar (https://www.mospi.gov.in/release-calendar) was a
// server-rendered table; it is now a JS SPA whose /api/* endpoints answer 403
// to unauthenticated clients. There is no India CPI/IIP/GDP feed here until a
// machine-readable source exists, so the India leg rests on the RBI MPC date.

const MONTHS = new Map(
  "january february march april may june july august september october november december"
    .split(" ")
    .map((m, i) => [m, i + 1]),
);

function isoDate(year, month, day) {
  const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseDateToken(token) {
  const s = String(token || "").trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return isoDate(m[1], m[2], m[3]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return isoDate(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return isoDate(m[3], m[2], m[1]);
  m = s.match(new RegExp(`^(${MONTH_NAMES})\\s+(\\d{1,2})(?:-\\d{1,2})?,?\\s*(\\d{4})$`, "i"));
  if (m) return isoDate(m[3], MONTHS.get(m[1].toLowerCase()), m[2]);
  return null;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\\,/g, ",")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function eventKey(event) {
  return `${event.date}|${event.country}|${event.title.toLowerCase()}`;
}

function makeEvent({ date, title, country, category, tier = "B", notes }) {
  if (!date || !title || !country || !category) return null;
  return {
    date,
    title: cleanText(title),
    country,
    category,
    tier,
    ...(notes ? { notes: cleanText(notes) } : {}),
  };
}

// Keyed on the EXACT national release name. Substring matching pulled in the
// regional and demographic cuts that share a prefix — "Employment Situation of
// Veterans" was emitted as a tier-A NFP print and the 14 "State Job Openings and
// Labor Turnover" releases as US JOLTS, fabricating 16 rows that reached
// /api/market-calendar. A trailing cadence qualifier ("(Monthly)") is stripped
// first; anything else is not the national release.
const BLS_NATIONAL_RELEASES = new Map([
  ["employment situation", { title: "US Employment Situation (NFP)", category: "Labor", tier: "A" }],
  ["consumer price index", { title: "US CPI", category: "Inflation", tier: "A" }],
  ["producer price index", { title: "US PPI", category: "Inflation", tier: "B" }],
  ["job openings and labor turnover survey", { title: "US JOLTS", category: "Labor", tier: "B" }],
  ["real earnings", { title: "US Real Earnings", category: "Labor", tier: "C" }],
]);

function classifyBlsSummary(summary) {
  const key = summary
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .toLowerCase();
  return BLS_NATIONAL_RELEASES.get(key) || null;
}

// RFC 5545 folds long lines with CRLF + a leading space/tab. Unfold before
// matching so a wrapped SUMMARY still reads as one line.
function unfoldIcs(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "");
}

export function parseBlsIcs(text) {
  const events = [];
  for (const raw of unfoldIcs(text).split("BEGIN:VEVENT").slice(1)) {
    const block = raw.split("END:VEVENT")[0] || "";
    // BLS emits DTSTART;TZID=US-Eastern:20250103T100000 — accept any property
    // parameters and drop the time part. The old pattern only allowed a bare
    // ;VALUE=DATE date, which matched nothing in the live feed.
    const dt = block.match(/^DTSTART[^:\n]*:(\d{8}|\d{4}-\d{2}-\d{2})(?:T\d{6}Z?)?\s*$/m);
    const summary = block.match(/^SUMMARY:(.+)$/m);
    if (!dt || !summary) continue;
    const classified = classifyBlsSummary(cleanText(summary[1]));
    if (!classified) continue;
    const event = makeEvent({
      date: parseDateToken(dt[1]),
      country: "US",
      notes: "BLS release calendar",
      ...classified,
    });
    if (event) events.push(event);
  }
  return events;
}

const MONTH_NAMES = "January|February|March|April|May|June|July|August|September|October|November|December";

// The final year section runs to the end of the document, which on the live
// page means site chrome and inline scripts. Stop at the table's own footer.
function sectionBody(text, { start, end }) {
  const slice = text.slice(start, end);
  const cut = slice.search(/Back to Top|Last Update:/i);
  return cut >= 0 ? slice.slice(0, cut) : slice;
}

/**
 * Parse the Fed's FOMC calendar page.
 *
 * The meeting table carries the year in a section heading ("2026 FOMC
 * Meetings") and each row as a bare day range ("January 27-28", "April 28-29*").
 * The only dates written with an inline year are the parenthetical minutes
 * releases ("Minutes: ... (Released February 18, 2026)"), which exist solely
 * for meetings that have already happened. Matching on an inline year therefore
 * produced a calendar that could never hold a future FOMC date — the bug that
 * froze data/macroCalendar.json from 2026-06-10.
 *
 * The event date is the LAST day of the range: a two-day meeting decides and
 * publishes its statement on day two.
 */
export function parseFomcHtml(html) {
  const text = cleanText(String(html || "").replace(/<[^>]+>/g, " "));
  const sections = [...text.matchAll(/(\d{4})\s+FOMC\s+Meetings/gi)].map((m) => ({
    year: m[1],
    start: m.index + m[0].length,
  }));
  for (const [i, section] of sections.entries()) {
    section.end = i + 1 < sections.length ? sections[i + 1].start : text.length;
  }

  // A whole day (or day range) NOT followed by a year. The year lookahead drops
  // the "(Released February 18, 2026)" minutes dates; the digit/dash lookahead
  // stops the engine backtracking to a partial day to satisfy it, which would
  // otherwise turn "January 25-26, 2028" into a January 2 meeting.
  const meetingRe = new RegExp(
    `(${MONTH_NAMES})\\s+(\\d{1,2})(?:\\s*[-–]\\s*(\\d{1,2}))?\\*?(?![\\d-])(?!\\s*,?\\s*\\d{4})`,
    "gi",
  );
  const events = [];
  const seen = new Set();
  for (const section of sections) {
    for (const m of sectionBody(text, section).matchAll(meetingRe)) {
      const decisionDay = m[3] || m[2];
      const date = parseDateToken(`${m[1]} ${decisionDay} ${section.year}`);
      if (!date || seen.has(date)) continue;
      seen.add(date);
      events.push(
        makeEvent({
          date,
          title: "US Fed FOMC decision",
          country: "US",
          category: "Central Bank",
          tier: "A+",
          notes: "Federal Reserve FOMC calendar",
        }),
      );
    }
  }
  return events.filter(Boolean);
}

/**
 * Find the newest "Resolution of the Monetary Policy Committee" entry on RBI's
 * press-release listing. The listing is ordered newest-first and writes hrefs
 * unquoted, so the first match is the current resolution.
 */
export function findLatestMpcResolutionPath(listingHtml) {
  const match = String(listingHtml || "").match(
    /href\s*=\s*["']?(BS_PressReleaseDisplay\.aspx\?prid=\d+)["']?[^>]*>[^<]*Resolution of the Monetary Policy Committee[^<]*</i,
  );
  return match ? match[1] : null;
}

/**
 * Read the forward MPC date out of a resolution page. Every resolution closes
 * with "The next meeting of the MPC is scheduled for October 5 to 7, 2026."
 * (older ones say "during"). Meetings can straddle a month boundary
 * ("September 29 to October 1, 2026"), and the decision lands on the last day.
 */
export function parseRbiNextMpcMeeting(html) {
  const text = cleanText(String(html || "").replace(/<[^>]+>/g, " "));
  const match = text.match(
    new RegExp(
      `next meeting of the MPC is scheduled (?:for|during)\\s+(?:${MONTH_NAMES})\\s+\\d{1,2}\\s*(?:to|[-–])\\s*(?:(${MONTH_NAMES})\\s+)?(\\d{1,2}),?\\s*(\\d{4})`,
      "i",
    ),
  );
  if (!match) return [];
  const startMonth = text
    .slice(match.index, match.index + match[0].length)
    .match(new RegExp(`(${MONTH_NAMES})`, "i"))[1];
  const date = parseDateToken(`${match[1] || startMonth} ${match[2]} ${match[3]}`);
  const event = makeEvent({
    date,
    title: "RBI MPC decision",
    country: "IN",
    category: "Central Bank",
    tier: "A+",
    notes: "RBI MPC resolution — next scheduled meeting",
  });
  return event ? [event] : [];
}

function dedupeEvents(events) {
  const byKey = new Map();
  for (const event of events.filter(Boolean)) {
    if (!event.date || !event.title || !event.country) continue;
    byKey.set(eventKey(event), event);
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

export function hasCredibleFutureCoverage(events, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const max = new Date(now.getTime() + 120 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const future = dedupeEvents(events).filter((e) => e.date >= today && e.date <= max);
  const countries = new Set(future.map((e) => e.country));
  const highTier = future.filter((e) => ["A", "A+"].includes(e.tier));
  return future.length >= 4 && highTier.length >= 2 && countries.size >= 2;
}

export function buildCalendar(previousCalendar, fetchedEvents, { now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const previousEvents = Array.isArray(previousCalendar?.events) ? previousCalendar.events : [];
  const retainedPrevious = previousEvents.filter((e) => e.date >= today);
  const merged = dedupeEvents([...retainedPrevious, ...fetchedEvents]);
  const keptPrevious = (reason) => ({
    shouldWrite: false,
    reason,
    calendar: previousCalendar || { _updated: null, events: previousEvents },
  });

  // THIS run has to contribute a forward event before _updated may move.
  // Retention is what keeps a one-night source flake from emptying the
  // calendar, but gating the freshness stamp on the merged set makes the gate
  // self-satisfying: the file we just wrote carries months of forward rows, so
  // a total upstream blackout would still "pass", restamp _updated to now, and
  // exit 0 — the staleness alarm below would not fire until the retained rows
  // aged out ~63 days later. That is the 2026-06 outage with a longer fuse.
  if (!dedupeEvents(fetchedEvents).some((e) => e.date >= today)) {
    return keptPrevious("no source produced a forward event");
  }
  if (!hasCredibleFutureCoverage(merged, now)) {
    return keptPrevious("insufficient future coverage");
  }

  return {
    shouldWrite: true,
    reason: "credible future coverage",
    calendar: {
      _note: "Managed macro calendar. Refreshed from public Fed/BLS/RBI sources where available; prior future events are retained when a source is unavailable.",
      _updated: now.toISOString(),
      events: merged,
    },
  };
}

function readPrevious(path = OUTPUT_PATH) {
  if (!existsSync(path)) return { _updated: null, events: [] };
  return JSON.parse(readFileSync(path, "utf-8"));
}

async function fetchText(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "starbhai-stock-platform/1.0 (+https://starbhai-stock-platform.vercel.app)",
        Accept: "text/html,text/calendar,text/plain,*/*",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRbiMpcEvents() {
  const listing = await fetchText(SOURCES.rbiPressReleases);
  const path = findLatestMpcResolutionPath(listing);
  if (!path) throw new Error("no MPC resolution link on the press-release listing");
  return parseRbiNextMpcMeeting(await fetchText(`${SOURCES.rbiScriptsBase}${path}`));
}

export async function fetchMacroEvents({ now = new Date() } = {}) {
  const jobs = [
    ["fomc", async () => parseFomcHtml(await fetchText(SOURCES.fomc))],
    ["bls", async () => parseBlsIcs(await fetchText(SOURCES.bls))],
    ["rbi", fetchRbiMpcEvents],
  ];

  const today = now.toISOString().slice(0, 10);
  const events = [];
  const failures = [];
  // Per-source FORWARD counts, not totals: every one of these feeds publishes
  // its schedule ahead of time, so a source that returns only history is as
  // dead as one that throws — and that is precisely how the 2026-06 outage
  // looked from the inside (HTTP 200, rows parsed, none of them in the future).
  const sources = [];
  for (const [name, run] of jobs) {
    try {
      const parsed = await run();
      const forward = parsed.filter((e) => e.date >= today).length;
      events.push(...parsed);
      sources.push({ name, total: parsed.length, forward });
      console.error(`[macro-calendar] ${name}: ${parsed.length} event(s), ${forward} forward`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      sources.push({ name, total: 0, forward: 0, error: error.message });
      console.error(`[macro-calendar] ${name}: failed (${error.message})`);
    }
  }
  return { events: dedupeEvents(events), failures, sources };
}

/** Sources that returned nothing forward-dated, whether or not they threw. */
export function degradedSources(sources) {
  return (sources || []).filter((s) => !s.forward).map((s) => s.name);
}

/**
 * A kept-previous run is only acceptable while the file the dashboard reads is
 * still inside its freshness window. Past that the pipeline is dead, and
 * exiting 0 is what let sws-nightly.sh record "macroCalendar.json OK" every
 * night for 57 days while _updated never moved.
 */
export function isPastStaleThreshold(calendar, { now = new Date(), maxAgeHours = MAX_AGE_HOURS } = {}) {
  const updated = Date.parse(calendar?._updated ?? "");
  if (!Number.isFinite(updated)) return true;
  return now.getTime() - updated > maxAgeHours * 3600 * 1000;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const outIdx = args.indexOf("--output");
  const outputPath = outIdx >= 0 ? args[outIdx + 1] : OUTPUT_PATH;
  const nowArg = args.find((arg) => arg.startsWith("--now="))?.slice("--now=".length);
  const now = nowArg ? new Date(`${nowArg}T00:00:00.000Z`) : new Date();

  const previous = readPrevious(outputPath);
  const { events, failures, sources } = await fetchMacroEvents({ now });
  const degraded = degradedSources(sources);
  const result = buildCalendar(previous, events, { now });

  if (!result.shouldWrite) {
    console.error(
      `[macro-calendar] kept previous ${outputPath}: ${result.reason}; fetched=${events.length}; failures=${failures.length}`,
    );
    if (isPastStaleThreshold(result.calendar, { now })) {
      console.error(
        `[macro-calendar] STALE: ${outputPath} _updated=${result.calendar?._updated ?? "missing"} is past the ${MAX_AGE_HOURS}h health threshold and no source produced credible forward coverage`,
      );
      process.exitCode = EXIT_STALE;
    } else {
      process.exitCode = EXIT_KEPT_PREVIOUS;
    }
    return;
  }

  const payload = JSON.stringify(result.calendar, null, 2) + "\n";
  if (dryRun) {
    console.log(payload);
    return;
  }
  writeFileSync(outputPath, payload);
  console.error(`[macro-calendar] wrote ${outputPath} (${result.calendar.events.length} event(s))`);
  // A write is not a clean bill of health: one live source is enough to keep
  // _updated moving, so a partial decay would otherwise stay silent until the
  // last surviving feed died too. Name the dead legs and flag the run.
  if (degraded.length) {
    console.error(
      `[macro-calendar] DEGRADED: no forward events from ${degraded.join(", ")}${failures.length ? ` (errors: ${failures.join("; ")})` : " (fetched, but nothing forward-dated)"}`,
    );
    process.exitCode = EXIT_DEGRADED;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[macro-calendar] FATAL:", error);
    process.exit(1);
  });
}
