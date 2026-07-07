// Unit tests for the Tier-0 buildLeaderboard backtest harness pure helpers.
// The network-driven backtest itself can't be unit-tested offline, but the
// deterministic core — date math, the no-lookahead price slice, regime lookup,
// ticker mapping, and stats — is the part whose correctness the harness's
// point-in-time / survivorship-free guarantees rest on. Those are asserted here.

import assert from "node:assert";
import {
  toDateStr,
  addCalendarMonths,
  holdToMonths,
  regimeAt,
  closeAtOrBefore,
  tickerToYahoo,
  median,
  mean,
} from "../scripts/backtest-buildleaderboard.mjs";

let passed = 0;
function t(name, fn) { fn(); passed++; }

// --- date math ---
t("addCalendarMonths advances by calendar months (UTC-stable)", () => {
  assert.strictEqual(addCalendarMonths("2026-04-30", 1), "2026-05-30");
  assert.strictEqual(addCalendarMonths("2026-01-31", 1), "2026-03-03"); // JS month rollover — documented behavior
  assert.strictEqual(addCalendarMonths("2026-05-08", 3), "2026-08-08");
});

t("holdToMonths parses Nm tokens, rejects junk", () => {
  assert.strictEqual(holdToMonths("1m"), 1);
  assert.strictEqual(holdToMonths("12m"), 12);
  assert.strictEqual(holdToMonths("t1"), null);
  assert.strictEqual(holdToMonths("3"), null);
});

t("toDateStr normalizes to YYYY-MM-DD", () => {
  assert.strictEqual(toDateStr("2026-06-15T10:20:30Z"), "2026-06-15");
});

// --- NO-LOOKAHEAD: this is the load-bearing survivorship/point-in-time guard ---
t("closeAtOrBefore never returns a price dated after the ask date", () => {
  const bars = [
    { date: "2026-04-28", close: 100 },
    { date: "2026-05-01", close: 110 },
    { date: "2026-05-15", close: 120 },
    { date: "2026-06-01", close: 130 },
  ];
  // exact match returns that bar
  assert.strictEqual(closeAtOrBefore(bars, "2026-05-01"), 110);
  // between bars returns the last one on-or-before (no peeking forward)
  assert.strictEqual(closeAtOrBefore(bars, "2026-05-10"), 110);
  // date before the series → null (no fabricated entry)
  assert.strictEqual(closeAtOrBefore(bars, "2026-04-01"), null);
  // date after the series → last available (still not lookahead)
  assert.strictEqual(closeAtOrBefore(bars, "2026-12-31"), 130);
});

t("closeAtOrBefore + addCalendarMonths compose to a lookahead-free forward return", () => {
  const bars = [
    { date: "2026-04-30", close: 200 },
    { date: "2026-05-30", close: 220 },
    { date: "2026-06-30", close: 210 },
  ];
  const entryDate = "2026-04-30";
  const exitDate = addCalendarMonths(entryDate, 1); // 2026-05-30
  const entryPx = closeAtOrBefore(bars, entryDate);
  const exitPx = closeAtOrBefore(bars, exitDate);
  assert.strictEqual(entryPx, 200);
  assert.strictEqual(exitPx, 220);
  const ret = ((exitPx - entryPx) / entryPx) * 100;
  assert.strictEqual(ret, 10);
});

// --- regime lookup uses the regime active AS OF the entry date ---
t("regimeAt returns the last regime on-or-before the date, UNKNOWN before history", () => {
  const events = [
    { at: "2026-04-01", regime: "CALM" },
    { at: "2026-05-20", regime: "RATE_HIKE" },
    { at: "2026-06-10", regime: "RISK_OFF" },
  ];
  assert.strictEqual(regimeAt(events, "2026-03-01"), "UNKNOWN"); // before any regime
  assert.strictEqual(regimeAt(events, "2026-04-15"), "CALM");
  assert.strictEqual(regimeAt(events, "2026-05-20"), "RATE_HIKE"); // boundary inclusive
  assert.strictEqual(regimeAt(events, "2026-07-01"), "RISK_OFF");
});

// --- ticker → Yahoo symbol ---
t("tickerToYahoo appends .NS, preserves explicit suffix, handles empties", () => {
  assert.strictEqual(tickerToYahoo("JSLL"), "JSLL.NS");
  assert.strictEqual(tickerToYahoo("m&m"), "M&M.NS");
  assert.strictEqual(tickerToYahoo("TCS.BO"), "TCS.BO");
  assert.strictEqual(tickerToYahoo(""), null);
  assert.strictEqual(tickerToYahoo(null), null);
});

// --- stats ---
t("median handles even/odd/empty", () => {
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([4, 1, 2, 3]), 2.5);
  assert.strictEqual(median([]), null);
});
t("mean handles empty", () => {
  assert.strictEqual(mean([2, 4, 6]), 4);
  assert.strictEqual(mean([]), null);
});

console.log(`backtestBuildLeaderboard: ${passed} tests passed`);
