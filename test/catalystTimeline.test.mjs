import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getUpcomingCatalysts, getCatalystProximity } from "../services/macroThesis/catalystTimeline.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    pass++;
  } catch (err) {
    console.log(`  not ok - ${name}\n      ${err.message}`);
    fail++;
  }
}

function withCalendar(events, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalystTimeline-"));
  const calPath = path.join(dir, "calendar.json");
  fs.writeFileSync(calPath, JSON.stringify({ schema_version: "test", events }));
  try {
    fn(calPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SAMPLE_EVENTS = [
  { date: "2026-06-04", kind: "RBI_MPC", label: "RBI June", severity_potential: 3 },
  { date: "2026-06-18", kind: "FOMC", label: "FOMC June", severity_potential: 3 },
  { date: "2026-08-15", kind: "INDIA_INDEPENDENCE", label: "Independence", severity_potential: 1 },
  { date: "2025-01-01", kind: "PAST", label: "Past event", severity_potential: 3 },
];

test("getUpcomingCatalysts filters by window + excludes past", () => {
  withCalendar(SAMPLE_EVENTS, (calPath) => {
    const r = getUpcomingCatalysts({ asOf: "2026-05-18", windowDays: 30, calendarPath: calPath });
    // From 2026-05-18, RBI June (17 days) is in 30d window; FOMC June (31d) and Independence (89d) are out
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, "RBI_MPC");
    assert.equal(r[0].days_until, 17);
  });
});

test("getUpcomingCatalysts sorts by days_until ascending", () => {
  withCalendar(SAMPLE_EVENTS, (calPath) => {
    const r = getUpcomingCatalysts({ asOf: "2026-05-18", windowDays: 90, calendarPath: calPath });
    for (let i = 1; i < r.length; i++) {
      assert.ok(r[i].days_until >= r[i - 1].days_until);
    }
  });
});

test("getCatalystProximity returns the nearest days_until", () => {
  withCalendar(SAMPLE_EVENTS, (calPath) => {
    const d = getCatalystProximity({ asOf: "2026-05-18", windowDays: 90, calendarPath: calPath });
    assert.equal(d, 17);
  });
});

test("getCatalystProximity returns null when no catalysts in window", () => {
  withCalendar(SAMPLE_EVENTS, (calPath) => {
    const d = getCatalystProximity({ asOf: "2026-05-18", windowDays: 7, calendarPath: calPath });
    assert.equal(d, null);
  });
});

test("missing calendar file → empty / null without crash", () => {
  const fake = "/nonexistent/calendar.json";
  assert.deepEqual(getUpcomingCatalysts({ calendarPath: fake }), []);
  assert.equal(getCatalystProximity({ calendarPath: fake }), null);
});

test("real production calendar has at least 5 events scheduled in FY26+", () => {
  const realPath = path.resolve("data", "macro-events-calendar-2026.json");
  if (!fs.existsSync(realPath)) {
    console.log("  (skipped: production calendar missing)");
    return;
  }
  const cal = JSON.parse(fs.readFileSync(realPath, "utf-8"));
  assert.ok(cal.events.length >= 5);
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
