/**
 * Regression tests for services/foScreener.js — the F&O OI-Delta screener.
 *
 * Covers:
 *   • mostRecentIstTradingDate — IST conversion + weekend walk-back
 *     - Mid-week UTC instants stay on the same IST date
 *     - Saturday IST → Friday
 *     - Sunday IST → Friday
 *     - Late-evening UTC that crosses midnight into IST next day
 *     - Month + year boundary roll-forward (IST is UTC+5:30)
 *     - Default-arg no-throw + YYYY-MM-DD format
 *     - Idempotent (same input → same output)
 *
 * NOT covered (would need NSE network + disk + KV mocks):
 *   • runOnce — orchestrator: fetchBhavcopy, parse, history append, KV mirror,
 *     atomic disk write. End-to-end side-effecting; out of scope for a
 *     fixture-free unit test.
 *
 * The other helpers in foScreener.js (partitionSections, loadPortfolioTickers,
 * loadPicksTickers, fetchAndParseWithFallback, ymdMinusDays, pad2,
 * writeJsonAtomic, readJsonSafe, resolveTargetDate) are NOT exported, so they
 * can't be reached from outside without re-architecting the source. Skipped.
 *
 * Run with: node test/foScreener.test.mjs
 */

import assert from "node:assert/strict";
import { mostRecentIstTradingDate } from "../services/foScreener.js";

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ok", name);
  } catch (err) {
    fail++;
    console.log("  FAIL", name, "→", err.message);
  }
}

console.log("\nmostRecentIstTradingDate — format + default-arg sanity\n");

check("returns YYYY-MM-DD when called with no args", () => {
  const out = mostRecentIstTradingDate();
  assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
});

check("idempotent — same Date input → same output", () => {
  const fixed = new Date("2026-05-13T08:00:00Z"); // Wed
  assert.equal(mostRecentIstTradingDate(fixed), mostRecentIstTradingDate(fixed));
});

console.log("\nmostRecentIstTradingDate — weekday cases (no walk-back)\n");

check("Mon 12:00 UTC → same IST date (Mon)", () => {
  // 2026-05-11 12:00 UTC = 2026-05-11 17:30 IST (Mon)
  const out = mostRecentIstTradingDate(new Date("2026-05-11T12:00:00Z"));
  assert.equal(out, "2026-05-11");
});

check("Wed 03:00 UTC → same IST date (Wed)", () => {
  // 2026-05-13 03:00 UTC = 2026-05-13 08:30 IST (Wed)
  const out = mostRecentIstTradingDate(new Date("2026-05-13T03:00:00Z"));
  assert.equal(out, "2026-05-13");
});

check("Fri 23:00 UTC → IST has rolled to Sat → walk back to Fri", () => {
  // 2026-05-15 23:00 UTC = 2026-05-16 04:30 IST (Sat)
  // expected: walk back to Fri 2026-05-15
  const out = mostRecentIstTradingDate(new Date("2026-05-15T23:00:00Z"));
  assert.equal(out, "2026-05-15");
});

console.log("\nmostRecentIstTradingDate — weekend walk-back\n");

check("Sat noon IST → Fri", () => {
  // 2026-05-16 06:30 UTC = 2026-05-16 12:00 IST (Sat) → walk back to Fri 2026-05-15
  const out = mostRecentIstTradingDate(new Date("2026-05-16T06:30:00Z"));
  assert.equal(out, "2026-05-15");
});

check("Sun noon IST → Fri (skip Sat)", () => {
  // 2026-05-17 06:30 UTC = 2026-05-17 12:00 IST (Sun) → walk back two days to Fri 2026-05-15
  const out = mostRecentIstTradingDate(new Date("2026-05-17T06:30:00Z"));
  assert.equal(out, "2026-05-15");
});

check("Sat 00:00 UTC (still Fri 19:30 IST) → stays on Fri", () => {
  // 2026-05-16 00:00 UTC = 2026-05-15 19:30 IST (Fri) — IST date still Friday
  const out = mostRecentIstTradingDate(new Date("2026-05-16T00:00:00Z"));
  assert.equal(out, "2026-05-15");
});

console.log("\nmostRecentIstTradingDate — boundary roll-forward (UTC < 18:30 → IST next day)\n");

check("Sun 23:30 UTC → Mon IST (no walk-back needed)", () => {
  // 2026-05-17 23:30 UTC = 2026-05-18 05:00 IST (Mon) — no walk-back
  const out = mostRecentIstTradingDate(new Date("2026-05-17T23:30:00Z"));
  assert.equal(out, "2026-05-18");
});

check("Sat 23:00 UTC → IST is Sun → walk back to Fri", () => {
  // 2026-05-16 23:00 UTC = 2026-05-17 04:30 IST (Sun) → walk back to Fri 2026-05-15
  const out = mostRecentIstTradingDate(new Date("2026-05-16T23:00:00Z"));
  assert.equal(out, "2026-05-15");
});

console.log("\nmostRecentIstTradingDate — month + year boundary\n");

check("end-of-month Wed → no roll", () => {
  // 2026-04-29 12:00 UTC = 2026-04-29 17:30 IST (Wed)
  const out = mostRecentIstTradingDate(new Date("2026-04-29T12:00:00Z"));
  assert.equal(out, "2026-04-29");
});

check("Sat IST 2026-08-01 → walks back to Fri 2026-07-31 (month boundary)", () => {
  // 2026-08-01 06:30 UTC = 2026-08-01 12:00 IST (Sat) → walk back to Fri 2026-07-31
  const out = mostRecentIstTradingDate(new Date("2026-08-01T06:30:00Z"));
  assert.equal(out, "2026-07-31");
});

check("Sun IST 2027-01-03 → walks back to Fri 2027-01-01 (year boundary, skip Sat)", () => {
  // 2027-01-03 06:30 UTC = 2027-01-03 12:00 IST (Sun) → walk back to Fri 2027-01-01
  const out = mostRecentIstTradingDate(new Date("2027-01-03T06:30:00Z"));
  assert.equal(out, "2027-01-01");
});

check("Sat IST 2027-01-02 → walks back to Fri 2027-01-01 (year + 1-day Sat→Fri)", () => {
  // 2027-01-02 06:30 UTC = 2027-01-02 12:00 IST (Sat) → walk back to Fri 2027-01-01
  const out = mostRecentIstTradingDate(new Date("2027-01-02T06:30:00Z"));
  assert.equal(out, "2027-01-01");
});

check("Sun IST 2026-03-01 → walks back to Fri 2026-02-27 (Feb non-leap)", () => {
  // 2026-03-01 06:30 UTC = 2026-03-01 12:00 IST (Sun) → walk back to Fri 2026-02-27
  const out = mostRecentIstTradingDate(new Date("2026-03-01T06:30:00Z"));
  assert.equal(out, "2026-02-27");
});

console.log("\nmostRecentIstTradingDate — pad2 zero-padding\n");

check("Jan 5th renders as 2026-01-05 (months and days zero-padded)", () => {
  // 2026-01-05 05:00 UTC = 2026-01-05 10:30 IST (Mon)
  const out = mostRecentIstTradingDate(new Date("2026-01-05T05:00:00Z"));
  assert.equal(out, "2026-01-05");
  assert.ok(out.split("-")[1].length === 2 && out.split("-")[2].length === 2);
});

console.log("\nmostRecentIstTradingDate — does not mutate input\n");

check("input Date object is not mutated by call", () => {
  const d = new Date("2026-05-16T06:30:00Z");
  const before = d.getTime();
  mostRecentIstTradingDate(d);
  assert.equal(d.getTime(), before);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
