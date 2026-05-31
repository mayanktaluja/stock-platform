#!/usr/bin/env node
// Refresh data/macroCalendar.json from public macro-event sources.
//
// This is intentionally conservative: if fetches fail or the future event set
// is too thin, the script preserves the previous good file and does not bump
// _updated. That keeps the dashboard from hiding staleness behind an empty or
// partially fetched calendar.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const OUTPUT_PATH = "data/macroCalendar.json";

const SOURCES = {
  fomc: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
  bls: "https://www.bls.gov/schedule/news_release/bls.ics",
  mospi: "https://www.mospi.gov.in/release-calendar",
  rbi: "https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx",
};

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

function parseDateToken(token, fallbackYear) {
  const s = String(token || "").trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return isoDate(m[1], m[2], m[3]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return isoDate(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return isoDate(m[3], m[2], m[1]);
  m = s.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:-\d{1,2})?,?\s*(\d{4})?$/i,
  );
  if (m) return isoDate(m[3] || fallbackYear, MONTHS.get(m[1].toLowerCase()), m[2]);
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

function classifyBlsSummary(summary) {
  const s = summary.toLowerCase();
  if (s.includes("employment situation")) {
    return { title: "US Employment Situation (NFP)", category: "Labor", tier: "A" };
  }
  if (s.includes("consumer price index")) {
    return { title: "US CPI", category: "Inflation", tier: "A" };
  }
  if (s.includes("producer price index")) {
    return { title: "US PPI", category: "Inflation", tier: "B" };
  }
  if (s.includes("job openings") || s.includes("jolts")) {
    return { title: "US JOLTS", category: "Labor", tier: "B" };
  }
  if (s.includes("real earnings")) {
    return { title: "US Real Earnings", category: "Labor", tier: "C" };
  }
  return null;
}

export function parseBlsIcs(text) {
  const events = [];
  for (const raw of String(text || "").split("BEGIN:VEVENT").slice(1)) {
    const block = raw.split("END:VEVENT")[0] || "";
    const dt = block.match(/^DTSTART(?:;VALUE=DATE)?:(\d{8}|\d{4}-\d{2}-\d{2})/m);
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

export function parseFomcHtml(html, { fallbackYear = new Date().getUTCFullYear() } = {}) {
  const text = cleanText(String(html || "").replace(/<[^>]+>/g, " "));
  const events = [];
  const seen = new Set();
  const re =
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:-\d{1,2})?,?\s+(\d{4})/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const window = text.slice(Math.max(0, m.index - 120), Math.min(text.length, m.index + 220));
    if (!/fomc|federal open market committee|meeting|statement/i.test(window)) continue;
    const date = parseDateToken(`${m[1]} ${m[2]} ${m[3] || fallbackYear}`, fallbackYear);
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
  return events.filter(Boolean);
}

function parseIndianReleaseText(text, sourceName, country = "IN") {
  const events = [];
  const lines = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .split(/\n|(?<=\d{4})\s{2,}/)
    .map(cleanText)
    .filter(Boolean);

  for (const line of lines) {
    const dateMatch =
      line.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/) ||
      line.match(
        /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/i,
      );
    if (!dateMatch) continue;
    const date = parseDateToken(dateMatch[1]);
    if (!date) continue;
    const lower = line.toLowerCase();
    let event = null;
    if (lower.includes("consumer price") || /\bcpi\b/i.test(line)) {
      event = makeEvent({
        date,
        title: "India CPI",
        country,
        category: "Inflation",
        tier: "A",
        notes: sourceName,
      });
    } else if (lower.includes("industrial production") || /\biip\b/i.test(line)) {
      event = makeEvent({
        date,
        title: "India IIP",
        country,
        category: "Growth",
        tier: "B",
        notes: sourceName,
      });
    } else if (lower.includes("gross domestic product") || /\bgdp\b/i.test(line)) {
      event = makeEvent({
        date,
        title: "India GDP",
        country,
        category: "Growth",
        tier: "A",
        notes: sourceName,
      });
    } else if (lower.includes("monetary policy") || lower.includes("mpc")) {
      event = makeEvent({
        date,
        title: "RBI MPC decision",
        country,
        category: "Central Bank",
        tier: "A+",
        notes: sourceName,
      });
    }
    if (event) events.push(event);
  }
  return events;
}

export function parseMospiText(text) {
  return parseIndianReleaseText(text, "MoSPI release calendar");
}

export function parseRbiText(text) {
  return parseIndianReleaseText(text, "RBI MPC schedule");
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

  if (!hasCredibleFutureCoverage(merged, now)) {
    return {
      shouldWrite: false,
      reason: "insufficient future coverage",
      calendar: previousCalendar || { _updated: null, events: previousEvents },
    };
  }

  return {
    shouldWrite: true,
    reason: "credible future coverage",
    calendar: {
      _note: "Managed macro calendar. Refreshed from public Fed/BLS/MoSPI/RBI sources where available; prior future events are retained when a source is unavailable.",
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

export async function fetchMacroEvents() {
  const jobs = [
    ["fomc", SOURCES.fomc, (text) => parseFomcHtml(text)],
    ["bls", SOURCES.bls, (text) => parseBlsIcs(text)],
    ["mospi", SOURCES.mospi, (text) => parseMospiText(text)],
    ["rbi", SOURCES.rbi, (text) => parseRbiText(text)],
  ];

  const events = [];
  const failures = [];
  for (const [name, url, parse] of jobs) {
    try {
      const text = await fetchText(url);
      const parsed = parse(text);
      events.push(...parsed);
      console.error(`[macro-calendar] ${name}: ${parsed.length} event(s)`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      console.error(`[macro-calendar] ${name}: failed (${error.message})`);
    }
  }
  return { events: dedupeEvents(events), failures };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const outIdx = args.indexOf("--output");
  const outputPath = outIdx >= 0 ? args[outIdx + 1] : OUTPUT_PATH;
  const nowArg = args.find((arg) => arg.startsWith("--now="))?.slice("--now=".length);
  const now = nowArg ? new Date(`${nowArg}T00:00:00.000Z`) : new Date();

  const previous = readPrevious(outputPath);
  const { events, failures } = await fetchMacroEvents();
  const result = buildCalendar(previous, events, { now });

  if (!result.shouldWrite) {
    console.error(
      `[macro-calendar] kept previous ${outputPath}: ${result.reason}; fetched=${events.length}; failures=${failures.length}`,
    );
    return;
  }

  const payload = JSON.stringify(result.calendar, null, 2) + "\n";
  if (dryRun) {
    console.log(payload);
    return;
  }
  writeFileSync(outputPath, payload);
  console.error(`[macro-calendar] wrote ${outputPath} (${result.calendar.events.length} future event(s))`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[macro-calendar] FATAL:", error);
    process.exit(1);
  });
}
