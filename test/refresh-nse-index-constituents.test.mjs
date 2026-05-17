/**
 * Tests for scripts/refresh-nse-index-constituents.mjs — covers:
 *   • CSV parser: extracts bare uppercase symbols from NSE constituent CSV
 *   • CSV parser: rejects HTML error pages
 *   • Guard: writes when count is stable
 *   • Guard: warns + writes on a >10% legitimate-rebalance drop
 *   • Guard: refuses to write on a >40% drop into <50% of nominal
 *     (the "NSE returned an HTML error page parsed as 30 rows" pattern)
 *
 * Run with: node test/refresh-nse-index-constituents.test.mjs
 */

import { parseConstituentCsv, evaluateGuards } from "../scripts/refresh-nse-index-constituents.mjs";

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

console.log("\nparseConstituentCsv()");

{
  const csv = [
    "Company Name,Industry,Symbol,Series,ISIN Code",
    "Reliance Industries Limited,Energy,RELIANCE,EQ,INE002A01018",
    "Tata Consultancy Services Limited,IT,TCS,EQ,INE467B01029",
    "Mahindra & Mahindra Limited,Auto,M&M,EQ,INE101A01026",
  ].join("\n");
  const out = parseConstituentCsv(csv);
  assert("extracts 3 symbols", out.length === 3, out.length);
  assert("first symbol is RELIANCE", out[0] === "RELIANCE", out[0]);
  assert("preserves ampersand (M&M)", out[2] === "M&M", out[2]);
}

{
  const csvLower = "Company Name,Industry,Symbol,Series,ISIN\nTata,IT,tcs,EQ,X";
  const out = parseConstituentCsv(csvLower);
  assert("uppercases lowercase symbols", out[0] === "TCS", out[0]);
}

{
  const csvWithSimpleQuotes = `Company Name,Industry,Symbol,Series,ISIN\nFoo Inc.,IT,"FOO",EQ,X`;
  const out = parseConstituentCsv(csvWithSimpleQuotes);
  // NSE archives don't quote (per scripts/build-nifty500.mjs comment), but
  // the parser strips wrapping quotes on the Symbol column defensively.
  assert("strips wrapping quotes from symbol", out[0] === "FOO", out[0]);
}

{
  try {
    parseConstituentCsv("<html><body>503 Service Unavailable</body></html>");
    assert("rejects HTML page (header-missing branch)", false, "did not throw");
  } catch (err) {
    assert("rejects HTML page (header-missing branch)", /missing Symbol|no data rows/i.test(err.message), err.message);
  }
}

{
  try {
    parseConstituentCsv("");
    assert("rejects empty input", false, "did not throw");
  } catch (err) {
    assert("rejects empty input", /no data rows/i.test(err.message), err.message);
  }
}

console.log("\nevaluateGuards()");

{
  // First-run case (no previous): always writes, no warning.
  const r = evaluateGuards(new Array(100), undefined, 100);
  assert("first run: writes, no warn", r.write === true && r.warn === false, r);
}

{
  // Steady-state: 100 → 102. Writes, no warning.
  const r = evaluateGuards(new Array(102), 100, 100);
  assert("steady state: writes, no warn", r.write === true && r.warn === false, r);
}

{
  // Legitimate rebalance: 500 → 470 (-6%). Writes, no warning.
  const r = evaluateGuards(new Array(470), 500, 500);
  assert("6% drop: writes, no warn", r.write === true && r.warn === false, r);
}

{
  // Bigger rebalance: 500 → 420 (-16%). Writes, but warns.
  const r = evaluateGuards(new Array(420), 500, 500);
  assert("16% drop: writes with WARN", r.write === true && r.warn === true, r);
}

{
  // Catastrophic shrink that still leaves us above half nominal:
  // 500 → 280 (-44%), nominal 500 → 280 ≥ 250 → still writes (with warn).
  const r = evaluateGuards(new Array(280), 500, 500);
  assert("44% drop but above half-nominal: writes with WARN", r.write === true && r.warn === true, r);
}

{
  // HTML-page pattern: 500 → 30 (-94%), nominal 500 → 30 < 250 → REFUSE.
  const r = evaluateGuards(new Array(30), 500, 500);
  assert("94% drop into <half-nominal: REFUSE", r.write === false, r);
}

{
  // Edge: list grew (102 → 200). Writes, no warning.
  const r = evaluateGuards(new Array(200), 102, 100);
  assert("growth: writes, no warn", r.write === true && r.warn === false, r);
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) process.exit(1);
