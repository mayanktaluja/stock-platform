/**
 * Unit guards for scripts/refresh-macro-calendar.mjs.
 *
 * The fixtures below are captured VERBATIM from the live sources. The previous
 * suite used idealised shapes no source actually emits (a bare
 * `DTSTART;VALUE=DATE:` from BLS, an inline `June 16-17, 2026` from the Fed),
 * so it stayed green through 57 days of a completely dead pipeline. Any new
 * fixture must come off a real payload for the same reason.
 *
 * Run with: node test/refreshMacroCalendar.test.mjs
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildCalendar,
  degradedSources,
  findLatestMpcResolutionPath,
  isPastStaleThreshold,
  parseBlsIcs,
  parseFomcHtml,
  parseRbiNextMpcMeeting,
} from "../scripts/refresh-macro-calendar.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

console.log("\nmacro calendar refresh\n");

// bls.gov/schedule/news_release/bls.ics — TZID-qualified datetimes, LF line
// endings, and a folded SUMMARY continuation line.
const blsFixture = `BEGIN:VCALENDAR
PRODID:-//Department of Labor//Bureau of Labor Statistics//EN
VERSION:2.0
BEGIN:VEVENT
SEQUENCE:1
UID:f65741ec-4080-474c-b2e3-1349fe430963
DTSTART;TZID=US-Eastern:20260807T083000
DURATION:PT0M
SUMMARY:Employment Situation
LOCATION:Washington\\, DC
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=US-Eastern:20260812T083000
SUMMARY:Consumer Price Ind
 ex
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=US-Eastern:20260901T100000
SUMMARY:Job Openings and Labor Turnover Survey
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=US-Eastern:20260428T100000
SUMMARY:Employment Situation of Veterans
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=US-Eastern:20260916T100000
SUMMARY:State Job Openings and Labor Turnover
END:VEVENT
END:VCALENDAR`;
const bls = parseBlsIcs(blsFixture);
assert("BLS TZID datetimes parse (the live DTSTART shape)", bls.length === 3, bls);
assert("BLS Employment Situation becomes NFP tier A", bls.some((e) => e.title.includes("NFP") && e.tier === "A"), bls);
assert("BLS folded SUMMARY still classifies as CPI", bls.some((e) => e.title === "US CPI" && e.date === "2026-08-12"), bls);
// The live feed carries 2 "Employment Situation of Veterans" and 14 "State Job
// Openings and Labor Turnover" releases. Substring matching relabelled all 16
// as the national print and shipped them to /api/market-calendar.
assert("a demographic cut is not promoted to the national NFP", !bls.some((e) => e.date === "2026-04-28"), bls);
assert("a state-level release is not promoted to national JOLTS", !bls.some((e) => e.date === "2026-09-16"), bls);
assert(
  "a cadence qualifier still classifies",
  parseBlsIcs(`BEGIN:VEVENT
DTSTART;TZID=US-Eastern:20260812T083000
SUMMARY:Consumer Price Index (Monthly)
END:VEVENT`)[0]?.title === "US CPI",
);

// federalreserve.gov/monetarypolicy/fomccalendars.htm — the year lives in the
// section heading, meeting rows are bare day ranges, and the only inline-year
// dates are minutes releases for meetings that already happened.
// Multi-section and non-chronological, like the live page (which runs 2026,
// 2025 … 2021, then 2027). A single-section fixture cannot detect a regression
// in the section-boundary arithmetic, and that regression re-stamps one year's
// meeting days with another year — the same wrong-year-on-a-bare-day-range
// failure that froze the calendar.
const fomcFixture = `<html><body>
<h4>2026 FOMC Meetings</h4>
<div>January 27-28 Statement: PDF | HTML Minutes: PDF | HTML (Released February 18, 2026)</div>
<div>September 15-16* Statement: PDF | HTML</div>
<div>October 27-28 Statement: PDF | HTML</div>
<h4>2025 FOMC Meetings</h4>
<div>March 18-19 Statement: PDF | HTML Minutes: PDF | HTML (Released April 9, 2025)</div>
<div>December 9-10 Statement: PDF | HTML</div>
<h4>2027 FOMC Meetings</h4>
<div>January 26-27 Statement: PDF | HTML</div>
<div>* Meeting associated with a Summary of Economic Projections.</div>
<div>Note: A two-day meeting is scheduled for January 25-26, 2028.</div>
<div>Back to Top Last Update: July 29, 2026</div>
</body></html>`;
const fomc = parseFomcHtml(fomcFixture);
assert("FOMC meeting rows parse without an inline year", fomc.length === 6, fomc);
assert(
  "each year section attributes its own year, on the decision (last) day",
  fomc.map((e) => e.date).join(",") === "2026-01-28,2026-09-16,2026-10-28,2025-03-19,2025-12-10,2027-01-27",
  fomc,
);
assert("a later section's rows never inherit an earlier section's year", !fomc.some((e) => e.date === "2026-03-19" || e.date === "2026-12-10"), fomc);
assert("minutes-release dates are not treated as meetings", !fomc.some((e) => e.date === "2026-02-18"), fomc);
assert("the trailing note does not backtrack into a January 2 meeting", !fomc.some((e) => e.date === "2026-01-02"), fomc);
assert("FOMC events are central-bank A+ events", fomc.every((e) => e.category === "Central Bank" && e.tier === "A+"), fomc);

// rbi.org.in press-release listing — hrefs are unquoted and ordered newest first.
const rbiListingFixture = `<tr><td><a class='link2' href=BS_PressReleaseDisplay.aspx?prid=63288>Governor’s Statement: August 5, 2026</a></td></tr>
<tr><td><a class='link2' href=BS_PressReleaseDisplay.aspx?prid=63287>Monetary Policy Statement, 2026-27 Resolution of the Monetary Policy Committee August 3 to 5, 2026</a></td></tr>
<tr><td><a class='link2' href=BS_PressReleaseDisplay.aspx?prid=62863>Monetary Policy Statement, 2026-27 Resolution of the Monetary Policy Committee June 3 to 5, 2026</a></td></tr>`;
assert(
  "newest MPC resolution link is picked off the listing",
  findLatestMpcResolutionPath(rbiListingFixture) === "BS_PressReleaseDisplay.aspx?prid=63287",
  findLatestMpcResolutionPath(rbiListingFixture),
);
assert("listing without a resolution yields no link", findLatestMpcResolutionPath("<tr><td>Press Releases</td></tr>") === null);

const rbiNext = parseRbiNextMpcMeeting("<p>The next meeting of the MPC is scheduled for October 5 to 7, 2026.</p>");
assert("RBI next-meeting sentence yields the decision date", rbiNext.length === 1 && rbiNext[0].date === "2026-10-07", rbiNext);
assert("RBI MPC is an India central-bank A+ event", rbiNext[0]?.country === "IN" && rbiNext[0]?.tier === "A+", rbiNext);
const rbiCrossMonth = parseRbiNextMpcMeeting("The next meeting of the MPC is scheduled during September 29 to October 1, 2026.");
assert("MPC meetings straddling a month end on the later month", rbiCrossMonth[0]?.date === "2026-10-01", rbiCrossMonth);
assert("a resolution with no next-meeting sentence yields nothing", parseRbiNextMpcMeeting("<p>The MPC voted unanimously.</p>").length === 0);

const prior = {
  _updated: "2026-05-31T00:00:00.000Z",
  events: [
    { date: "2026-06-12", title: "India CPI", country: "IN", category: "Inflation", tier: "A" },
    { date: "2026-06-18", title: "RBI MPC decision", country: "IN", category: "Central Bank", tier: "A+" },
  ],
};
const sparse = buildCalendar(prior, [{ date: "2026-06-05", title: "US CPI", country: "US", category: "Inflation", tier: "A" }], {
  now: new Date("2026-06-01T00:00:00.000Z"),
});
assert("insufficient coverage preserves prior calendar", sparse.shouldWrite === false, sparse);
assert("insufficient coverage does not bump _updated", sparse.calendar._updated === prior._updated, sparse.calendar);

const credible = buildCalendar(prior, [...bls, ...fomc, ...rbiNext], { now: new Date("2026-06-01T00:00:00.000Z") });
assert("credible future coverage writes a refreshed calendar", credible.shouldWrite === true, credible);
assert("credible coverage bumps _updated", credible.calendar._updated !== prior._updated, credible.calendar._updated);
assert("refreshed calendar preserves India and US future coverage", new Set(credible.calendar.events.map((e) => e.country)).size >= 2, credible.calendar.events);

// The blackout case: a previous file rich in forward events plus a run that
// fetched nothing. Gating the _updated bump on the MERGED set made this write
// and restamp — the alarm below would not have fired until the retained rows
// aged out, roughly two months later.
const richPrior = {
  _updated: "2026-05-31T00:00:00.000Z",
  events: [
    { date: "2026-06-17", title: "US Fed FOMC decision", country: "US", category: "Central Bank", tier: "A+" },
    { date: "2026-07-29", title: "US Fed FOMC decision", country: "US", category: "Central Bank", tier: "A+" },
    { date: "2026-06-10", title: "US CPI", country: "US", category: "Inflation", tier: "A" },
    { date: "2026-06-12", title: "India CPI", country: "IN", category: "Inflation", tier: "A" },
    { date: "2026-08-06", title: "RBI MPC decision", country: "IN", category: "Central Bank", tier: "A+" },
  ],
};
const blackout = buildCalendar(richPrior, [], { now: new Date("2026-06-01T00:00:00.000Z") });
assert("a run that fetched nothing does not write on retained coverage alone", blackout.shouldWrite === false, blackout.reason);
assert("a blackout leaves _updated frozen so the file can age out", blackout.calendar._updated === richPrior._updated, blackout.calendar._updated);
const pastOnly = buildCalendar(richPrior, [{ date: "2026-01-05", title: "US CPI", country: "US", category: "Inflation", tier: "A" }], {
  now: new Date("2026-06-01T00:00:00.000Z"),
});
assert("sources that return only history count as a blackout", pastOnly.shouldWrite === false, pastOnly.reason);

assert("sources with no forward events are reported as degraded", degradedSources([
  { name: "fomc", total: 55, forward: 11 },
  { name: "bls", total: 131, forward: 0 },
  { name: "rbi", total: 0, forward: 0, error: "HTTP 503" },
]).join(",") === "bls,rbi");
assert("a fully healthy fetch is not degraded", degradedSources([{ name: "fomc", total: 55, forward: 11 }]).length === 0);

// The staleness alarm: a kept-previous run is only silent while the file the
// dashboard reads is still inside its 720h window.
const now = new Date("2026-08-06T00:00:00.000Z");
assert("a calendar refreshed yesterday is not stale", isPastStaleThreshold({ _updated: "2026-08-05T00:00:00.000Z" }, { now }) === false);
assert("a calendar frozen for 57 days is stale", isPastStaleThreshold({ _updated: "2026-06-10T01:50:23.376Z" }, { now }) === true);
assert("a calendar with no _updated is stale", isPastStaleThreshold({ events: [] }, { now }) === true);

// The exit code IS the fix for "logged OK for 57 days", so run the real script
// and read the real rc. Deleting the process.exitCode assignments in main()
// leaves every assertion above green; these two go red.
const scratch = mkdtempSync(path.join(tmpdir(), "macro-calendar-"));
const offlineStub = path.join(scratch, "offline.mjs");
writeFileSync(offlineStub, 'globalThis.fetch = async () => { throw new Error("offline (test stub)"); };\n');

function refreshExitCode(previousCalendar) {
  const target = path.join(scratch, `prior-${Math.abs(hashString(JSON.stringify(previousCalendar)))}.json`);
  writeFileSync(target, JSON.stringify(previousCalendar, null, 2) + "\n");
  const run = spawnSync(process.execPath, ["scripts/refresh-macro-calendar.mjs", "--output", target, "--now=2026-08-06"], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_OPTIONS: `--import ${new URL(`file://${offlineStub}`).href}` },
    encoding: "utf-8",
  });
  return { status: run.status, stderr: run.stderr || "", after: JSON.parse(readFileSync(target, "utf-8")) };
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const staleRun = refreshExitCode({ _updated: "2026-06-10T01:50:23.376Z", events: richPrior.events });
assert("a kept-previous run past the threshold exits 2", staleRun.status === 2, staleRun.status);
assert("the stale run names the threshold it crossed", /STALE:/.test(staleRun.stderr), staleRun.stderr.slice(-200));
assert("the stale run leaves _updated untouched", staleRun.after._updated === "2026-06-10T01:50:23.376Z", staleRun.after._updated);

const freshRun = refreshExitCode({ _updated: "2026-08-05T18:00:00.000Z", events: richPrior.events });
assert("a kept-previous run inside the window exits 3", freshRun.status === 3, freshRun.status);
assert("the fresh kept-previous run leaves _updated untouched", freshRun.after._updated === "2026-08-05T18:00:00.000Z", freshRun.after._updated);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
