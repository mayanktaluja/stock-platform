/**
 * Tests for services/earnings/earningsCalendarBuilder.js
 *
 * Covers:
 *   - parseNseDate: DD-MMM-YYYY → ISO; rejects malformed input
 *   - daysBetween / istTodayIso math
 *   - extractAncillaryTags: DIVIDEND/BUYBACK/etc. taxonomy
 *   - inferFiscalQuarter: month → Q1-Q4 mapping (Indian FY)
 *   - buildEarningsCalendar:
 *       · filters non-result purposes
 *       · dedupes multi-purpose rows for the same (symbol, date)
 *       · respects windowDays
 *       · includes / excludes past events per opt
 *
 * Run with: node test/earningsCalendarBuilder.test.mjs
 */

import {
  parseNseDate,
  daysBetween,
  istTodayIso,
  extractAncillaryTags,
  inferFiscalQuarter,
  isResultEvent,
  buildEarningsCalendar,
  buildEarningsCalendarFromPayload,
} from "../services/earnings/earningsCalendarBuilder.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}

// ──── parseNseDate ────
{
  assert("parseNseDate: '07-May-2026' → '2026-05-07'", parseNseDate("07-May-2026") === "2026-05-07", parseNseDate("07-May-2026"));
  assert("parseNseDate: '7-May-2026' (single digit day)", parseNseDate("7-May-2026") === "2026-05-07", parseNseDate("7-May-2026"));
  assert("parseNseDate: '31-Dec-2025'", parseNseDate("31-Dec-2025") === "2025-12-31", parseNseDate("31-Dec-2025"));
  assert("parseNseDate: invalid month rejected", parseNseDate("07-Foo-2026") === null, parseNseDate("07-Foo-2026"));
  assert("parseNseDate: empty string rejected", parseNseDate("") === null, parseNseDate(""));
  assert("parseNseDate: null rejected", parseNseDate(null) === null, parseNseDate(null));
  assert("parseNseDate: number rejected", parseNseDate(42) === null, parseNseDate(42));
}

// ──── daysBetween ────
{
  assert("daysBetween same day = 0", daysBetween("2026-05-09", "2026-05-09") === 0);
  assert("daysBetween +5 days", daysBetween("2026-05-09", "2026-05-14") === 5);
  assert("daysBetween negative for past", daysBetween("2026-05-09", "2026-05-04") === -5);
}

// ──── istTodayIso (sanity — anchored to IST) ────
{
  // Mock a timestamp at UTC 18:30 (00:00 IST next day) — should give next-day IST date
  const utcMidnightUtc = Date.UTC(2026, 4, 9, 19, 0, 0); // 00:30 IST May 10
  const iso = istTodayIso(utcMidnightUtc);
  assert("istTodayIso: 19:00 UTC May 9 → 2026-05-10 IST", iso === "2026-05-10", iso);
}

// ──── isResultEvent / extractAncillaryTags ────
{
  assert("isResultEvent: 'Financial Results'", isResultEvent("Financial Results") === true);
  assert("isResultEvent: 'Financial Results/Dividend'", isResultEvent("Financial Results/Dividend") === true);
  assert("isResultEvent: 'Fund Raising' (no result)", isResultEvent("Fund Raising") === false);
  assert("isResultEvent: empty rejected", isResultEvent("") === false);

  const t1 = extractAncillaryTags("Financial Results/Dividend", "approve dividend");
  assert("extractAncillaryTags: dividend extracted", t1.includes("DIVIDEND"), t1);

  const t2 = extractAncillaryTags(
    "Financial Results/Dividend/Other business matters",
    "consider dividend, buyback, and fund raising",
  );
  assert("extractAncillaryTags: dividend + buyback + fund raise + other", t2.length >= 3 && t2.includes("DIVIDEND") && t2.includes("BUYBACK") && t2.includes("FUND_RAISE") && t2.includes("OTHER"), t2);

  const t3 = extractAncillaryTags("Financial Results", "");
  assert("extractAncillaryTags: bare result returns []", t3.length === 0, t3);
}

// ──── inferFiscalQuarter ────
{
  // Q4 of FY26 = Jan-Mar 2026 — a board meeting in May 2026 covers it.
  const may = inferFiscalQuarter("2026-05-09");
  assert("Q4 FY26 from May-2026 board meet", may?.quarter === "Q4" && may?.label === "Q4 FY26", may);

  const aug = inferFiscalQuarter("2026-08-15");
  assert("Q1 FY27 from Aug-2026 board meet", aug?.quarter === "Q1" && aug?.label === "Q1 FY27", aug);

  const nov = inferFiscalQuarter("2026-11-10");
  assert("Q2 FY27 from Nov-2026 board meet", nov?.quarter === "Q2" && nov?.label === "Q2 FY27", nov);

  const feb = inferFiscalQuarter("2027-02-04");
  assert("Q3 FY27 from Feb-2027 board meet", feb?.quarter === "Q3" && feb?.label === "Q3 FY27", feb);

  assert("inferFiscalQuarter rejects bad input", inferFiscalQuarter("nope") === null, inferFiscalQuarter("nope"));
}

// ──── buildEarningsCalendar: dedup + filter ────
{
  const now = Date.UTC(2026, 4, 9, 4, 0, 0); // ~09:30 IST May 9
  // Multi-purpose row pair (BIOCON case) + one non-result + one out of window.
  const rows = [
    { symbol: "BIOCON", company: "Biocon Limited", purpose: "Financial Results/Dividend", date: "12-May-2026", description: "Approve quarterly results and dividend" },
    { symbol: "BIOCON", company: "Biocon Limited", purpose: "Fund Raising", date: "12-May-2026", description: "Consider fund raising" },
    { symbol: "INFY", company: "Infosys Limited", purpose: "Buyback", date: "12-May-2026", description: "Consider buyback" }, // not a result
    { symbol: "TCS", company: "Tata Consultancy", purpose: "Financial Results", date: "07-May-2026", description: "Q4 results" }, // past
    { symbol: "WIPRO", company: "Wipro Limited", purpose: "Financial Results", date: "20-May-2026", description: "Q4 results" }, // in window
    { symbol: "HCLTECH", company: "HCL Technologies", purpose: "Financial Results", date: "30-Jun-2026", description: "out of window" },
  ];
  const cal = buildEarningsCalendar(rows, { nowMs: now, windowDays: 14 });
  // Should contain: BIOCON (deduped to 1, with Fund Raise tag merged in), WIPRO. Not TCS (past), not INFY (not result), not HCLTECH (out of window).
  assert("calendar event count = 2", cal.length === 2, cal.map((e) => e.symbol));
  const biocon = cal.find((e) => e.symbol === "BIOCON");
  assert("BIOCON merged tags include FUND_RAISE", biocon?.tags?.includes("FUND_RAISE"), biocon?.tags);
  assert("BIOCON merged tags include DIVIDEND", biocon?.tags?.includes("DIVIDEND"), biocon?.tags);
  assert("BIOCON fiscal_quarter is Q4 FY26", biocon?.fiscal_quarter === "Q4 FY26", biocon?.fiscal_quarter);
  assert("BIOCON days_until = 3", biocon?.days_until === 3, biocon?.days_until);
}

// ──── buildEarningsCalendar: includePast option ────
{
  const now = Date.UTC(2026, 4, 9, 4, 0, 0);
  const rows = [
    { symbol: "TCS", company: "TCS", purpose: "Financial Results", date: "07-May-2026", description: "" },
  ];
  const without = buildEarningsCalendar(rows, { nowMs: now, windowDays: 14, includePast: false });
  const with_ = buildEarningsCalendar(rows, { nowMs: now, windowDays: 14, includePast: true });
  assert("includePast=false drops past events", without.length === 0, without.length);
  assert("includePast=true keeps past events", with_.length === 1 && with_[0].days_until === -2, with_);
}

// ──── buildEarningsCalendarFromPayload: meta block ────
{
  const payload = {
    schemaVersion: "catalysts-events-v1",
    fetched_at: "2026-05-05T23:42:31Z",
    event_count: 1,
    events: [{ symbol: "RELIANCE", company: "Reliance", purpose: "Financial Results", date: "12-May-2026", description: "Q4" }],
  };
  const out = buildEarningsCalendarFromPayload(payload, { nowMs: Date.UTC(2026, 4, 9), windowDays: 14 });
  assert("payload wrapper schema_version", out.schema_version === "earnings-calendar-v1", out.schema_version);
  assert("payload wrapper preserves upstream_fetched_at", out.upstream_fetched_at === payload.fetched_at, out.upstream_fetched_at);
  assert("payload wrapper event_count = 1", out.event_count === 1, out.event_count);
}

// ──── Empty / malformed input safety ────
{
  assert("buildEarningsCalendar(null) returns []", Array.isArray(buildEarningsCalendar(null)) && buildEarningsCalendar(null).length === 0);
  assert("buildEarningsCalendar([]) returns []", buildEarningsCalendar([]).length === 0);
  assert("buildEarningsCalendar drops missing-symbol rows", buildEarningsCalendar([{ purpose: "Financial Results", date: "12-May-2026" }]).length === 0);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
