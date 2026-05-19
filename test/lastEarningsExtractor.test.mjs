// Unit tests for services/earnings/lastEarningsExtractor.js — covers the
// SWS-news primary path, the Yahoo fundamentalsHistory fallback path, and
// the graceful "no data" return.

import assert from "node:assert/strict";
import { extractLastEarnings } from "../services/earnings/lastEarningsExtractor.js";

let ok = 0, fail = 0;
const tests = [];
function it(name, fn) { tests.push({ name, fn }); }

it("SWS brief 'Full year 2026 earnings:' → period=annual + ISO date", () => {
  const out = extractLastEarnings({
    deep: { news: [
      { type: "brief", date: "2026-04-26T22:54:28.000Z", title: "Full year 2026 earnings: EPS exceeds analyst expectations" },
    ] },
    ticker: "TCS",
  });
  assert.equal(out.period, "annual");
  assert.equal(out.date, "2026-04-26");
  assert.equal(out.source, "sws_news");
});

it("SWS brief 'Q1 2026 earnings:' → period=quarter", () => {
  const out = extractLastEarnings({
    deep: { news: [
      { type: "brief", date: "2025-07-15T10:00:00.000Z", title: "Q1 2026 earnings: EPS in line with expectations" },
    ] },
    ticker: "RELIANCE",
  });
  assert.equal(out.period, "quarter");
  assert.equal(out.date, "2025-07-15");
});

it("Two qualifying briefs → latest date wins", () => {
  const out = extractLastEarnings({
    deep: { news: [
      { type: "brief", date: "2025-07-15T10:00:00.000Z", title: "Q1 2026 earnings: EPS misses" },
      { type: "brief", date: "2026-04-26T22:54:28.000Z", title: "Full year 2026 earnings: EPS exceeds" },
      { type: "brief", date: "2025-10-12T09:00:00.000Z", title: "Q2 2026 earnings: EPS exceeds" },
    ] },
    ticker: "TCS",
  });
  assert.equal(out.date, "2026-04-26");
  assert.equal(out.period, "annual");
});

it("Non-earnings briefs ignored — narrative-update / sector-chatter return null", () => {
  const out = extractLastEarnings({
    deep: { news: [
      { type: "brief", date: "2026-04-01T10:00:00.000Z", title: "Sector outlook update for IT services" },
      { type: "narrative-update", date: "2026-04-15T10:00:00.000Z", title: "Q1 2026 earnings: EPS misses" },
      { type: "article", date: "2026-04-20T10:00:00.000Z", title: "Full year 2026 earnings: EPS exceeds" },
    ] },
    ticker: "TCS",
  });
  // None of the above are {type:'brief'} with a qualifying title — should fall through.
  assert.equal(out, null);
});

it("No briefs + fundamentalsHistory: quarterly newer than annual → quarter", () => {
  const out = extractLastEarnings({
    deep: { news: [] },
    fundamentalsHistory: {
      stocks: {
        "TCS.NS": {
          annual: [
            { endDate: "2024-03-31" },
            { endDate: "2025-03-31" },
          ],
          quarterly: [
            { endDate: "2024-09-30" },
            { endDate: "2025-12-31" },
          ],
        },
      },
    },
    ticker: "TCS",
  });
  assert.equal(out.period, "quarter");
  assert.equal(out.date, "2025-12-31");
  assert.equal(out.source, "fundamentals_history");
});

it("No briefs + fundamentalsHistory: annual newer than quarterly → annual", () => {
  const out = extractLastEarnings({
    deep: { news: [] },
    fundamentalsHistory: {
      stocks: {
        "RELIANCE.NS": {
          annual: [
            { endDate: "2025-03-31" },
            { endDate: "2026-03-31" },
          ],
          quarterly: [
            { endDate: "2025-09-30" },
            { endDate: "2025-12-31" },
          ],
        },
      },
    },
    ticker: "RELIANCE",
  });
  assert.equal(out.period, "annual");
  assert.equal(out.date, "2026-03-31");
});

it("Ticker passed without .NS suffix → joined to .NS for fundamentalsHistory lookup", () => {
  const out = extractLastEarnings({
    deep: null,
    fundamentalsHistory: { stocks: { "INFY.NS": { quarterly: [{ endDate: "2025-12-31" }] } } },
    ticker: "INFY",
  });
  assert.equal(out.date, "2025-12-31");
  assert.equal(out.period, "quarter");
});

it("Ticker already has .NS suffix → not double-suffixed", () => {
  const out = extractLastEarnings({
    deep: null,
    fundamentalsHistory: { stocks: { "INFY.NS": { annual: [{ endDate: "2025-03-31" }] } } },
    ticker: "INFY.NS",
  });
  assert.equal(out.date, "2025-03-31");
});

it("Empty everywhere → null", () => {
  assert.equal(extractLastEarnings({ deep: null, fundamentalsHistory: null, ticker: "FOOBAR" }), null);
  assert.equal(extractLastEarnings({ deep: { news: [] }, fundamentalsHistory: { stocks: {} }, ticker: "FOOBAR" }), null);
  assert.equal(extractLastEarnings({}), null);
});

it("Half-yearly filer ('First half 2026 earnings: …') doesn't match → falls through to fundamentalsHistory if present, else null", () => {
  // The regex /(full year|q[1-4])\s+\d{4}\s+earnings:/i intentionally does
  // NOT match half-yearly filer titles. Such rows must either fall back to
  // fundamentalsHistory or render "—" — never get mis-classified as quarter
  // or annual on title alone.
  const out = extractLastEarnings({
    deep: { news: [
      { type: "brief", date: "2026-04-01T10:00:00.000Z", title: "First half 2026 earnings: EPS exceeds" },
    ] },
    ticker: "SOMESMALLCAP",
  });
  assert.equal(out, null);
});

it("Brief with un-parseable date → ignored", () => {
  const out = extractLastEarnings({
    deep: { news: [
      { type: "brief", date: "not-a-date", title: "Full year 2026 earnings: EPS exceeds" },
      { type: "brief", date: "2025-12-31T10:00:00.000Z", title: "Q3 2026 earnings: EPS in line" },
    ] },
    ticker: "TCS",
  });
  assert.equal(out.date, "2025-12-31");
  assert.equal(out.period, "quarter");
});

(async () => {
  for (const t of tests) {
    try { await t.fn(); console.log("  ok -", t.name); ok++; }
    catch (e) { console.log("  FAIL -", t.name, "\n", e.message); fail++; }
  }
  console.log(`\n${ok} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
