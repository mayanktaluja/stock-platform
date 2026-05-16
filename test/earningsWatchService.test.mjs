// services/earnings/earningsWatchService.js — unit tests.
//
// Focuses on the recomputeDaysUntil helper and the existing filterEvents
// upper-bound behavior on a snapshot that now carries both `events`
// (upcoming-only) and `recent_results` (past-only). The "events stays
// upcoming-only, recent_results stays past-only" invariant is what
// keeps the existing `e.days_until <= max` filter at filterEvents()
// from silently leaking past rows into the upcoming bucket.
//
// Run: node test/earningsWatchService.test.mjs

import assert from "node:assert/strict";

import {
  filterEvents,
  findEventBySymbol,
  recomputeDaysUntil,
  istTodayIso,
} from "../services/earnings/earningsWatchService.js";

let ok = 0, fail = 0;
const tests = [];
function it(name, fn) { tests.push({ name, fn }); }

// Pure helper — Date.UTC midnight in IST is current-IST + 5.5h, so
// pinning the nowMs lets us assert exact daysBetween outputs.
function istNoonMs(dateIso) {
  // 12:00 IST on the given date = 06:30 UTC
  return Date.UTC(+dateIso.slice(0, 4), +dateIso.slice(5, 7) - 1, +dateIso.slice(8, 10), 6, 30, 0);
}

const evt = (symbol, eventIsoDate, daysUntil) => ({
  symbol, event_iso_date: eventIsoDate, days_until: daysUntil,
  fiscal_quarter: "Q4 FY26", source: "nse-event-calendar",
});

console.log("[1] istTodayIso");
it("returns YYYY-MM-DD for IST date at noon UTC-equivalent", () => {
  // 2026-05-17 noon IST = 2026-05-17 06:30 UTC
  assert.equal(istTodayIso(istNoonMs("2026-05-17")), "2026-05-17");
});

it("handles midnight IST boundary correctly", () => {
  // 2026-05-17 00:00 IST = 2026-05-16 18:30 UTC
  const ms = Date.UTC(2026, 4, 16, 18, 30, 0);
  assert.equal(istTodayIso(ms), "2026-05-17");
  // 2026-05-16 23:59 IST = 2026-05-16 18:29 UTC
  const msBefore = Date.UTC(2026, 4, 16, 18, 29, 0);
  assert.equal(istTodayIso(msBefore), "2026-05-16");
});

console.log("[2] recomputeDaysUntil");
it("rewrites events[] days_until against today_iso", () => {
  const snap = {
    schema_version: "earnings-watch-v4",
    today_iso: "2026-05-15",  // stale snapshot today
    events: [
      evt("TCS", "2026-05-18", 3),  // value here is stale (was 3 when built)
      evt("INFY", "2026-05-20", 5),
      evt("WIPRO", "2026-05-17", 2),
    ],
  };
  const out = recomputeDaysUntil(snap, istNoonMs("2026-05-17"));
  assert.equal(out.today_iso, "2026-05-17");
  const byKey = Object.fromEntries(out.events.map((e) => [e.symbol, e.days_until]));
  assert.equal(byKey.TCS, 1);    // May 18 from May 17 = 1
  assert.equal(byKey.INFY, 3);   // May 20 from May 17 = 3
  assert.equal(byKey.WIPRO, 0);  // May 17 from May 17 = 0 (today)
});

it("rewrites recent_results[] days_until against today_iso", () => {
  const snap = {
    schema_version: "earnings-watch-v4",
    today_iso: "2026-05-15",
    events: [],
    recent_results: [
      { symbol: "REL", event_iso_date: "2026-05-14", days_until: -1 },  // was -1 at build
      { symbol: "SBI", event_iso_date: "2026-05-10", days_until: -5 },
    ],
  };
  const out = recomputeDaysUntil(snap, istNoonMs("2026-05-17"));
  assert.equal(out.today_iso, "2026-05-17");
  const byKey = Object.fromEntries(out.recent_results.map((r) => [r.symbol, r.days_until]));
  assert.equal(byKey.REL, -3);   // May 14 from May 17 = -3
  assert.equal(byKey.SBI, -7);   // May 10 from May 17 = -7
});

it("does not mutate the input snapshot", () => {
  const original = {
    today_iso: "2026-05-15",
    events: [evt("TCS", "2026-05-18", 3)],
    recent_results: [{ symbol: "REL", event_iso_date: "2026-05-14", days_until: -1 }],
  };
  const snapshot = JSON.parse(JSON.stringify(original));
  recomputeDaysUntil(snapshot, istNoonMs("2026-05-17"));
  assert.deepEqual(snapshot, original, "input snapshot was mutated");
});

it("handles snapshot with no recent_results field gracefully", () => {
  const snap = { today_iso: "2026-05-15", events: [evt("TCS", "2026-05-18", 3)] };
  const out = recomputeDaysUntil(snap, istNoonMs("2026-05-17"));
  assert.equal(out.today_iso, "2026-05-17");
  assert.equal(out.events[0].days_until, 1);
  assert.equal(out.recent_results, undefined);
});

it("handles snapshot with no events field gracefully", () => {
  const snap = { today_iso: "2026-05-15", recent_results: [{ symbol: "REL", event_iso_date: "2026-05-14", days_until: -1 }] };
  const out = recomputeDaysUntil(snap, istNoonMs("2026-05-17"));
  assert.equal(out.today_iso, "2026-05-17");
  assert.equal(out.recent_results[0].days_until, -3);
});

it("preserves other top-level fields verbatim", () => {
  const snap = {
    schema_version: "earnings-watch-v4",
    built_at: "2026-05-15T17:34:14Z",
    upstream_fetched_at: "2026-05-15T17:32:50Z",
    window_days: 30,
    today_iso: "2026-05-15",
    event_count: 1,
    past_window_days: 7,
    events: [evt("TCS", "2026-05-18", 3)],
    recent_results: [],
    _missing: false,
  };
  const out = recomputeDaysUntil(snap, istNoonMs("2026-05-17"));
  assert.equal(out.schema_version, "earnings-watch-v4");
  assert.equal(out.built_at, "2026-05-15T17:34:14Z");
  assert.equal(out.upstream_fetched_at, "2026-05-15T17:32:50Z");
  assert.equal(out.window_days, 30);
  assert.equal(out.event_count, 1);
  assert.equal(out.past_window_days, 7);
  assert.equal(out._missing, false);
});

it("non-object inputs pass through untouched", () => {
  assert.equal(recomputeDaysUntil(null), null);
  assert.equal(recomputeDaysUntil(undefined), undefined);
});

console.log("[3] filterEvents — upper-bound only; no past leakage when events[] is upcoming-only");
it("days=14 filter keeps events with days_until <= 14", () => {
  const events = [
    evt("A", "2026-05-18", 1),
    evt("B", "2026-05-25", 8),
    evt("C", "2026-06-05", 19),
  ];
  const out = filterEvents(events, { days: "14" });
  assert.deepEqual(out.map((e) => e.symbol), ["A", "B"]);
});

it("symbol filter is case-insensitive and exact match", () => {
  const events = [
    evt("TCS", "2026-05-18", 1),
    evt("INFY", "2026-05-20", 3),
  ];
  const out = filterEvents(events, { symbol: "tcs" });
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, "TCS");
});

console.log("[4] findEventBySymbol still works after API additions");
it("returns the matching event or null", () => {
  const snapshot = { events: [evt("TCS", "2026-05-18", 1), evt("INFY", "2026-05-20", 3)] };
  assert.equal(findEventBySymbol(snapshot, "TCS").symbol, "TCS");
  assert.equal(findEventBySymbol(snapshot, "tcs").symbol, "TCS");
  assert.equal(findEventBySymbol(snapshot, "XYZ"), null);
  assert.equal(findEventBySymbol(null, "TCS"), null);
});

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      console.log("  ✓", t.name);
      ok += 1;
    } catch (e) {
      console.log("  ✗", t.name, "\n   ", e && e.message);
      fail += 1;
    }
  }
  console.log(`\n=== ${ok} passed, ${fail} failed ===`);
  if (fail) process.exit(1);
})();
