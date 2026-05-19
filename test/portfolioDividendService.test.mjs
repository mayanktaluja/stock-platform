import {
  buildNextDividend,
  attachDividendsToHoldings,
  __testing__,
} from "../services/portfolio/portfolioDividendService.js";

const { normalizeSymbol, dateMinusOne, daysUntil, indexByNormalizedSymbol } = __testing__;

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}

// ──── normalizeSymbol ────
{
  assert("normalizeSymbol: 'RELIANCE.NS' → 'RELIANCE'", normalizeSymbol("RELIANCE.NS") === "RELIANCE");
  assert("normalizeSymbol: 'M&M.NS' → 'M&M'", normalizeSymbol("M&M.NS") === "M&M");
  assert("normalizeSymbol: 'BAJAJ-AUTO.NS' → 'BAJAJ-AUTO'", normalizeSymbol("BAJAJ-AUTO.NS") === "BAJAJ-AUTO");
  assert("normalizeSymbol: 'tcs.bo' → 'TCS' (uppercase)", normalizeSymbol("tcs.bo") === "TCS");
  assert("normalizeSymbol: 'INFY.BSE' → 'INFY'", normalizeSymbol("INFY.BSE") === "INFY");
  assert("normalizeSymbol: bare 'RELIANCE' unchanged", normalizeSymbol("RELIANCE") === "RELIANCE");
  assert("normalizeSymbol: null → null", normalizeSymbol(null) === null);
  assert("normalizeSymbol: empty string → null", normalizeSymbol("") === null);
}

// ──── dateMinusOne ────
{
  assert("dateMinusOne: '2026-07-17' → '2026-07-16'", dateMinusOne("2026-07-17") === "2026-07-16");
  assert("dateMinusOne: month boundary '2026-08-01' → '2026-07-31'", dateMinusOne("2026-08-01") === "2026-07-31");
  assert("dateMinusOne: year boundary '2026-01-01' → '2025-12-31'", dateMinusOne("2026-01-01") === "2025-12-31");
  assert("dateMinusOne: null → null", dateMinusOne(null) === null);
}

// ──── daysUntil ────
{
  assert("daysUntil: '2026-05-26' - '2026-05-19' = 7", daysUntil("2026-05-26", "2026-05-19") === 7);
  assert("daysUntil: '2026-05-19' - '2026-05-19' = 0", daysUntil("2026-05-19", "2026-05-19") === 0);
  assert("daysUntil: past = -3", daysUntil("2026-05-16", "2026-05-19") === -3);
}

// ──── indexByNormalizedSymbol — sorts ASC ────
{
  const divs = [
    { symbol: "TCS.NS", ex_date: "2026-08-10", dps: 5 },
    { symbol: "TCS", ex_date: "2026-06-15", dps: 3 },
    { symbol: "RELIANCE.NS", ex_date: "2026-07-01", dps: 8 },
  ];
  const idx = indexByNormalizedSymbol(divs);
  assert("index: TCS has 2 entries (suffix variants merged)", idx.get("TCS")?.length === 2);
  assert("index: TCS sorted ASC (earliest first)", idx.get("TCS")?.[0]?.ex_date === "2026-06-15");
  assert("index: RELIANCE has 1 entry", idx.get("RELIANCE")?.length === 1);
}

// ──── buildNextDividend — earliest future wins, totals computed correctly ────
{
  const holding = { symbol: "TCS.NS", quantity: 10, avgPrice: 3000 };
  const divs = [
    { symbol: "TCS", ex_date: "2026-08-10", dps: 5, record_date: "2026-08-10", pay_date: "2026-09-01", dividend_type: "interim", source: "sws-news" },
    { symbol: "TCS", ex_date: "2026-06-15", dps: 3, record_date: "2026-06-15", pay_date: "2026-07-01", dividend_type: "annual", source: "sws-news" },
  ];
  const idx = indexByNormalizedSymbol(divs);
  const next = buildNextDividend(holding, idx.get("TCS"), { todayIso: "2026-05-19" });
  assert("tie-break: earliest future ex-date wins", next?.ex_date === "2026-06-15", next);
  assert("tie-break: dps = 3", next?.dps === 3, next);
  assert("payout: 10 × 3 = 30", next?.total_payout_inr === 30, next);
  assert("yield: 3/3000 = 0.1%", next?.yield_on_cost_pct === 0.1, next);
  assert("other_dividends_count = 1", next?.other_dividends_count === 1, next);
  assert("hold_by = ex_date - 1 day", next?.hold_by_date === "2026-06-14", next);
  assert("days_until_ex (2026-05-19 → 2026-06-15) = 27", next?.days_until_ex === 27, next);
  assert("days_until_hold_by = days_until_ex - 1", next?.days_until_hold_by === 26, next);
}

// ──── buildNextDividend — no future dividends returns null ────
{
  const holding = { symbol: "X", quantity: 10, avgPrice: 100 };
  const divs = [{ symbol: "X", ex_date: "2026-01-01", dps: 1, source: "sws-news" }];
  const idx = indexByNormalizedSymbol(divs);
  const next = buildNextDividend(holding, idx.get("X"), { todayIso: "2026-05-19" });
  assert("no future divs: returns null", next === null, next);
}

// ──── buildNextDividend — missing avgPrice still computes payout, omits yield ────
{
  const holding = { symbol: "Y", quantity: 100 };
  const divs = [{ symbol: "Y", ex_date: "2026-07-01", dps: 2.5, source: "sws-news" }];
  const idx = indexByNormalizedSymbol(divs);
  const next = buildNextDividend(holding, idx.get("Y"), { todayIso: "2026-05-19" });
  assert("missing avgPrice: payout still computed", next?.total_payout_inr === 250, next);
  assert("missing avgPrice: yield is null", next?.yield_on_cost_pct === null, next);
}

// ──── attachDividendsToHoldings — joins on .NS-suffixed holdings ────
{
  const holdings = [
    { symbol: "RELIANCE.NS", quantity: 5, avgPrice: 2000 },
    { symbol: "TCS.NS", quantity: 1, avgPrice: 4000 },
    { symbol: "UNKNOWN.NS", quantity: 1, avgPrice: 100 },
  ];
  const divs = [
    { symbol: "RELIANCE", ex_date: "2026-07-01", dps: 10, source: "sws-news" },
    { symbol: "TCS", ex_date: "2026-08-15", dps: 5, source: "sws-news" },
  ];
  const out = attachDividendsToHoldings(holdings, divs, { todayIso: "2026-05-19" });
  assert("attach: RELIANCE.NS got next_dividend", out[0]?.sws?.next_dividend?.dps === 10);
  assert("attach: RELIANCE.NS payout = 5×10 = 50", out[0]?.sws?.next_dividend?.total_payout_inr === 50);
  assert("attach: TCS.NS got next_dividend", out[1]?.sws?.next_dividend?.dps === 5);
  assert("attach: UNKNOWN.NS got no next_dividend", out[2]?.sws?.next_dividend == null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
