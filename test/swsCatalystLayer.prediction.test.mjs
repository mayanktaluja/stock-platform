/**
 * Tests for extractCatalystSignals' new `prediction` metadata block.
 *
 * The metadata is surfaced ONLY when the upcoming-earnings event is present
 * AND data quality is HIGH/MEDIUM AND verdict isn't INSUFFICIENT_DATA. The
 * catalystScore itself must be IDENTICAL with/without the earningsEvent —
 * the prediction is metadata only, not a score input (see the rationale in
 * services/swsCatalystLayer.js:_buildPredictionMeta).
 *
 * Run with: node test/swsCatalystLayer.prediction.test.mjs
 */

import { extractCatalystSignals } from "../services/swsCatalystLayer.js";

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

// Minimal SWS deep with just enough to drive the catalyst layer. The lookup
// uses overview.next_earnings_date for proximity scoring and overview.returns_pct
// for momentum — everything else is optional.
function makeDeep({ next_earnings_date = null, last_quarter_result = null, ret1m = null } = {}) {
  return {
    overview: {
      next_earnings_date,
      last_quarter_result,
      returns_pct: ret1m != null ? { "1M": ret1m, "3M": ret1m } : null,
      recent_analyst_revisions: [],
      insider_activity: [],
    },
  };
}

// Earnings event shape mirrors what findEventBySymbol returns from
// data/catalysts/earnings-watch-latest.json.
function makeEvent({ verdict = "BEAT", confidence_pct = 64, fiscal_quarter = "Q4 FY26",
                     days_until = 3, data_quality = "HIGH", event_iso_date = "2026-05-20",
                     score_100 = 78 } = {}) {
  return {
    symbol: "BPCL",
    fiscal_quarter,
    event_iso_date,
    days_until,
    prediction: { verdict, confidence_pct, score_100, score_breakdown: {} },
    signals: { data_quality },
  };
}

console.log("\nextractCatalystSignals — prediction metadata: happy path\n");
{
  const deep = makeDeep({ next_earnings_date: "2026-05-20", last_quarter_result: "beat", ret1m: 2 });
  const event = makeEvent({ verdict: "BEAT", confidence_pct: 64, data_quality: "HIGH", days_until: 3 });
  const r = extractCatalystSignals(deep, { earningsEvent: event });
  assert("prediction is populated", r.prediction != null, r.prediction);
  assert("prediction.verdict = BEAT", r.prediction?.verdict === "BEAT", r.prediction?.verdict);
  assert("prediction.confidence_pct = 64", r.prediction?.confidence_pct === 64, r.prediction?.confidence_pct);
  assert("prediction.fiscal_quarter present", r.prediction?.fiscal_quarter === "Q4 FY26", r.prediction?.fiscal_quarter);
  assert("prediction.days_until = 3", r.prediction?.days_until === 3, r.prediction?.days_until);
  assert("prediction.data_quality = HIGH", r.prediction?.data_quality === "HIGH", r.prediction?.data_quality);
  assert("prediction.contributed_delta = 0 (metadata only)", r.prediction?.contributed_delta === 0, r.prediction?.contributed_delta);
}

console.log("\nextractCatalystSignals — no earnings event passed\n");
{
  const deep = makeDeep({ next_earnings_date: "2026-05-20", last_quarter_result: "beat", ret1m: 2 });
  const r = extractCatalystSignals(deep);
  assert("prediction is null", r.prediction === null, r.prediction);
  assert("catalystScore still computed", Number.isFinite(r.catalystScore), r.catalystScore);
}

console.log("\nextractCatalystSignals — LOW data_quality → prediction suppressed\n");
{
  const deep = makeDeep({ next_earnings_date: "2026-05-20", ret1m: 0 });
  const event = makeEvent({ data_quality: "LOW" });
  const r = extractCatalystSignals(deep, { earningsEvent: event });
  assert("prediction is null (LOW gate)", r.prediction === null, r.prediction);
}

console.log("\nextractCatalystSignals — INSUFFICIENT_DATA verdict → prediction suppressed\n");
{
  const deep = makeDeep({ next_earnings_date: "2026-05-20", ret1m: 0 });
  const event = makeEvent({ verdict: "INSUFFICIENT_DATA", data_quality: "HIGH" });
  const r = extractCatalystSignals(deep, { earningsEvent: event });
  assert("prediction is null (INSUFFICIENT_DATA gate)", r.prediction === null, r.prediction);
}

console.log("\nextractCatalystSignals — MEDIUM data_quality passes through\n");
{
  const deep = makeDeep({ next_earnings_date: "2026-05-20", ret1m: 0 });
  const event = makeEvent({ data_quality: "MEDIUM", verdict: "MISS", confidence_pct: 58 });
  const r = extractCatalystSignals(deep, { earningsEvent: event });
  assert("prediction present", r.prediction != null, r.prediction);
  assert("prediction.verdict = MISS", r.prediction?.verdict === "MISS", r.prediction?.verdict);
  assert("prediction.data_quality = MEDIUM", r.prediction?.data_quality === "MEDIUM", r.prediction?.data_quality);
}

console.log("\nextractCatalystSignals — catalystScore is UNCHANGED with/without earningsEvent\n");
{
  // The whole point of the metadata-only approach: adding the earnings event
  // must not move the score, the confidence_delta, or any other field that
  // feeds the conviction engine. Regression check that the predictor signal
  // is genuinely shadow-only at this stage.
  const deep = makeDeep({ next_earnings_date: "2026-05-20", last_quarter_result: "beat", ret1m: 9 });
  const without = extractCatalystSignals(deep);
  const withEvent = extractCatalystSignals(deep, {
    earningsEvent: makeEvent({ verdict: "BEAT", confidence_pct: 64, data_quality: "HIGH", days_until: 3 }),
  });
  assert("catalystScore identical", without.catalystScore === withEvent.catalystScore, { without: without.catalystScore, with: withEvent.catalystScore });
  assert("confidence_delta identical", without.confidence_delta === withEvent.confidence_delta, { without: without.confidence_delta, with: withEvent.confidence_delta });
  assert("next_earnings_days identical", without.next_earnings_days === withEvent.next_earnings_days, [without.next_earnings_days, withEvent.next_earnings_days]);
  assert("pending_catalysts length identical", without.pending_catalysts.length === withEvent.pending_catalysts.length, [without.pending_catalysts.length, withEvent.pending_catalysts.length]);
}

console.log("\nextractCatalystSignals — null deep returns null prediction\n");
{
  const r = extractCatalystSignals(null);
  assert("available is false", r.available === false, r);
  assert("prediction is null", r.prediction === null, r.prediction);
}

console.log("\nextractCatalystSignals — event with no prediction key\n");
{
  const deep = makeDeep({ next_earnings_date: "2026-05-20" });
  const event = { symbol: "X", fiscal_quarter: "Q4 FY26", event_iso_date: "2026-05-20", days_until: 3, signals: { data_quality: "HIGH" } };
  const r = extractCatalystSignals(deep, { earningsEvent: event });
  assert("prediction is null (no prediction key)", r.prediction === null, r.prediction);
}

console.log("");
console.log(`Tests passed: ${pass}, failed: ${fail}`);
if (fail > 0) process.exit(1);
