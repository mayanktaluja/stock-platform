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

import {
  buildCalendar,
  findLatestMpcResolutionPath,
  isPastStaleThreshold,
  parseBlsIcs,
  parseFomcHtml,
  parseRbiNextMpcMeeting,
} from "../scripts/refresh-macro-calendar.mjs";

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
END:VCALENDAR`;
const bls = parseBlsIcs(blsFixture);
assert("BLS TZID datetimes parse (the live DTSTART shape)", bls.length === 3, bls);
assert("BLS Employment Situation becomes NFP tier A", bls.some((e) => e.title.includes("NFP") && e.tier === "A"), bls);
assert("BLS folded SUMMARY still classifies as CPI", bls.some((e) => e.title === "US CPI" && e.date === "2026-08-12"), bls);

// federalreserve.gov/monetarypolicy/fomccalendars.htm — the year lives in the
// section heading, meeting rows are bare day ranges, and the only inline-year
// dates are minutes releases for meetings that already happened.
const fomcFixture = `<html><body>
<h4>2026 FOMC Meetings</h4>
<div>January 27-28 Statement: PDF | HTML Minutes: PDF | HTML (Released February 18, 2026)</div>
<div>September 15-16* Statement: PDF | HTML</div>
<div>October 27-28 Statement: PDF | HTML</div>
<div>* Meeting associated with a Summary of Economic Projections.</div>
<div>Note: A two-day meeting is scheduled for January 25-26, 2028.</div>
<div>Back to Top Last Update: July 29, 2026</div>
</body></html>`;
const fomc = parseFomcHtml(fomcFixture);
assert("FOMC meeting rows parse without an inline year", fomc.length === 3, fomc);
assert("FOMC date is the decision (last) day of the range", fomc.map((e) => e.date).join(",") === "2026-01-28,2026-09-16,2026-10-28", fomc);
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

// The staleness alarm: a kept-previous run is only silent while the file the
// dashboard reads is still inside its 720h window.
const now = new Date("2026-08-06T00:00:00.000Z");
assert("a calendar refreshed yesterday is not stale", isPastStaleThreshold({ _updated: "2026-08-05T00:00:00.000Z" }, { now }) === false);
assert("a calendar frozen for 57 days is stale", isPastStaleThreshold({ _updated: "2026-06-10T01:50:23.376Z" }, { now }) === true);
assert("a calendar with no _updated is stale", isPastStaleThreshold({ events: [] }, { now }) === true);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
