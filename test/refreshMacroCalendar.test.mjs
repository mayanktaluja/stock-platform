/**
 * Unit guards for scripts/refresh-macro-calendar.mjs.
 *
 * Run with: node test/refreshMacroCalendar.test.mjs
 */

import {
  buildCalendar,
  parseBlsIcs,
  parseFomcHtml,
  parseMospiText,
  parseRbiText,
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

const blsFixture = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260702
SUMMARY:Employment Situation
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260714
SUMMARY:Consumer Price Index
END:VEVENT
END:VCALENDAR`;
const bls = parseBlsIcs(blsFixture);
assert("BLS ICS parses Employment Situation and CPI", bls.length === 2, bls);
assert("BLS Employment Situation becomes NFP tier A", bls.some((e) => e.title.includes("NFP") && e.tier === "A"), bls);
assert("BLS CPI becomes Inflation tier A", bls.some((e) => e.title === "US CPI" && e.category === "Inflation"), bls);

const fomcFixture = `<html><body>
<h2>Federal Open Market Committee meetings</h2>
<p>FOMC meeting: June 16-17, 2026. Statement released after the meeting.</p>
<p>FOMC meeting: July 28-29, 2026.</p>
</body></html>`;
const fomc = parseFomcHtml(fomcFixture);
assert("Fed HTML parses FOMC meeting dates", fomc.length === 2, fomc);
assert("FOMC events are central-bank A+ events", fomc.every((e) => e.category === "Central Bank" && e.tier === "A+"), fomc);

const mospi = parseMospiText(`
Consumer Price Index 12-07-2026
Index of Industrial Production 12-08-2026
Gross Domestic Product 29-08-2026
`);
assert("MoSPI-style text parses India CPI/IIP/GDP", mospi.length === 3, mospi);
assert("MoSPI CPI/GDP are high-tier India events", mospi.filter((e) => e.country === "IN" && e.tier === "A").length === 2, mospi);

const rbi = parseRbiText("Monetary Policy Committee meeting / MPC decision 06-08-2026");
assert("RBI-style text parses MPC decision", rbi.length === 1 && rbi[0].title === "RBI MPC decision", rbi);

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

const credible = buildCalendar(prior, [...bls, ...fomc, ...mospi, ...rbi], {
  now: new Date("2026-06-01T00:00:00.000Z"),
});
assert("credible future coverage writes a refreshed calendar", credible.shouldWrite === true, credible);
assert("credible coverage bumps _updated", credible.calendar._updated !== prior._updated, credible.calendar._updated);
assert("refreshed calendar preserves India and US future coverage", new Set(credible.calendar.events.map((e) => e.country)).size >= 2, credible.calendar.events);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
