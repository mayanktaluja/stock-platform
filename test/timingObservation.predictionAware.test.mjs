/**
 * Tests for the prediction-aware enhancement to services/timingObservation.js.
 *
 * Two changes are validated here:
 *   1. Bug fix — when the NSE is closed (weekend, pre-open, post-close) and
 *      earnings are within 7 days, the timing reason now includes a "Q-result
 *      in Xd predicted BEAT" note instead of silently dropping the earnings
 *      signal. The verdict stays "Wait-for-open" — only the reason text and
 *      the new earnings_alert field change.
 *   2. Earnings note in non-closed branches — when eps_days <= 14 and a valid
 *      prediction is available, every branch (analyst-PT cut, momentum,
 *      macro regime, default) appends "(Q-result in Xd predicted BEAT)" to
 *      its reason.
 *
 * Gates: LOW data_quality, INSUFFICIENT_DATA verdict, missing prediction →
 * legacy behavior, no earnings_alert, no note.
 *
 * Run with: node test/timingObservation.predictionAware.test.mjs
 */

import { computeTimingObservation } from "../services/timingObservation.js";

// Test clock — 2026-05-16 (Saturday IST, market closed). For market-open
// scenarios we use 2026-05-04 11:00 IST = 05:30 UTC.
const NOW_WEEKEND = new Date("2026-05-16T18:35:00Z"); // ~00:05 IST Sunday — what the user's screenshot was taken at
const NOW_OPEN = new Date("2026-05-04T05:30:00Z");    // Mon 11:00 IST

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

// Build a scored stub with a configurable next_earnings_date offset from a
// reference date. earningsInDays=3 with refDate=2026-05-16 → eps date 2026-05-19.
function scoredWithEarnings(refDate, earningsInDays) {
  const ms = refDate.getTime() + earningsInDays * 86_400_000;
  const iso = new Date(ms).toISOString().slice(0, 10);
  return { overview: { next_earnings_date: iso, returns_pct: { "1M": 0 } } };
}

// ──────────────────── Bug fix: market closed + earnings proximity ────────────────────

console.log("\nBUG FIX — market closed at midnight IST + earnings in 3d → earnings note appears\n");
{
  const scored = scoredWithEarnings(NOW_WEEKEND, 3);
  const r = computeTimingObservation({
    action: "Reduction-25%",
    scored,
    now: NOW_WEEKEND,
    predictionVerdict: "BEAT",
    predictionConfidence: 64,
    predictionQuality: "HIGH",
  });
  assert("verdict still Wait-for-open", r.verdict === "Wait-for-open", r);
  assert("window still next-session", r.window === "next-session", r);
  assert("reason mentions 'NSE closed'", /NSE closed/.test(r.reason), r.reason);
  assert("reason mentions earnings (the bug fix)", /Q-result in 3d predicted BEAT/.test(r.reason), r.reason);
  assert("reason mentions confidence", /64% conf/.test(r.reason), r.reason);
  assert("earnings_alert populated", r.earnings_alert != null, r.earnings_alert);
  assert("earnings_alert.eps_days = 3", r.earnings_alert?.eps_days === 3, r.earnings_alert);
  assert("earnings_alert.verdict = BEAT", r.earnings_alert?.verdict === "BEAT", r.earnings_alert);
  assert("earnings_alert.confidence_pct = 64", r.earnings_alert?.confidence_pct === 64, r.earnings_alert);
  assert("earnings_alert.data_quality = HIGH", r.earnings_alert?.data_quality === "HIGH", r.earnings_alert);
}

console.log("\nMarket closed + LOW data_quality → no earnings note (gate respected)\n");
{
  const scored = scoredWithEarnings(NOW_WEEKEND, 3);
  const r = computeTimingObservation({
    action: "Reduction-25%",
    scored,
    now: NOW_WEEKEND,
    predictionVerdict: "BEAT",
    predictionConfidence: 64,
    predictionQuality: "LOW",
  });
  assert("verdict Wait-for-open", r.verdict === "Wait-for-open", r);
  assert("reason has no earnings note", !/Q-result/.test(r.reason), r.reason);
  assert("earnings_alert is null", r.earnings_alert == null, r.earnings_alert);
}

console.log("\nMarket closed + no prediction at all → legacy behavior, no alert\n");
{
  const scored = scoredWithEarnings(NOW_WEEKEND, 3);
  const r = computeTimingObservation({
    action: "Reduction-25%",
    scored,
    now: NOW_WEEKEND,
  });
  assert("verdict Wait-for-open", r.verdict === "Wait-for-open", r);
  assert("reason is exactly the original (no suffix)", r.reason === "NSE closed — next regular session at 09:15 IST.", r.reason);
  assert("earnings_alert is null", r.earnings_alert == null, r.earnings_alert);
}

console.log("\nMarket closed + INSUFFICIENT_DATA verdict → no note (gate respected)\n");
{
  const scored = scoredWithEarnings(NOW_WEEKEND, 3);
  const r = computeTimingObservation({
    action: "Reduction-25%",
    scored,
    now: NOW_WEEKEND,
    predictionVerdict: "INSUFFICIENT_DATA",
    predictionConfidence: 0,
    predictionQuality: "HIGH",
  });
  assert("reason has no earnings note", !/Q-result/.test(r.reason), r.reason);
  assert("earnings_alert is null", r.earnings_alert == null, r.earnings_alert);
}

console.log("\nMarket closed + earnings >7d away → no note (out of alert window)\n");
{
  const scored = scoredWithEarnings(NOW_WEEKEND, 10);
  const r = computeTimingObservation({
    action: "Reduction-25%",
    scored,
    now: NOW_WEEKEND,
    predictionVerdict: "BEAT",
    predictionConfidence: 60,
    predictionQuality: "HIGH",
  });
  assert("verdict Wait-for-open", r.verdict === "Wait-for-open", r);
  assert("no earnings note in closed branch (>7d)", !/Also: Q-result/.test(r.reason), r.reason);
  assert("earnings_alert is null (>7d)", r.earnings_alert == null, r.earnings_alert);
}

// ──────────────────── Non-closed branches: earnings suffix in default + earnings branches ────────────────────

console.log("\nMarket open + earnings in 3d + BEAT → 'No' verdict with predictor mention\n");
{
  const scored = scoredWithEarnings(NOW_OPEN, 3);
  const r = computeTimingObservation({
    action: "Reduction-25%",
    scored,
    now: NOW_OPEN,
    predictionVerdict: "BEAT",
    predictionConfidence: 64,
    predictionQuality: "HIGH",
  });
  assert("verdict is 'No'", r.verdict === "No", r);
  assert("reason mentions 'Earnings in 3d'", /Earnings in 3d/.test(r.reason), r.reason);
  assert("reason mentions predictor BEAT", /Predictor: BEAT/.test(r.reason), r.reason);
  assert("reason mentions 64% conf", /64% conf/.test(r.reason), r.reason);
  assert("earnings_alert populated", r.earnings_alert != null, r.earnings_alert);
}

console.log("\nMarket open + earnings 5d away → 'Soft-no' with predictor mention\n");
{
  const scored = scoredWithEarnings(NOW_OPEN, 5);
  const r = computeTimingObservation({
    action: "Reduction-25%",
    scored,
    now: NOW_OPEN,
    predictionVerdict: "MISS",
    predictionConfidence: 58,
    predictionQuality: "MEDIUM",
  });
  assert("verdict is 'Soft-no'", r.verdict === "Soft-no", r);
  assert("reason mentions predictor MISS", /Predictor: MISS/.test(r.reason), r.reason);
}

console.log("\nMarket open + earnings in 10d + BEAT → default 'Yes' with appended earnings suffix\n");
{
  const scored = scoredWithEarnings(NOW_OPEN, 10);
  const r = computeTimingObservation({
    action: "Reduction-25%",
    scored,
    now: NOW_OPEN,
    predictionVerdict: "BEAT",
    predictionConfidence: 60,
    predictionQuality: "HIGH",
  });
  assert("verdict is 'Yes'", r.verdict === "Yes", r);
  assert("reason includes '(Q-result in 10d predicted BEAT'", /\(Q-result in 10d predicted BEAT/.test(r.reason), r.reason);
}

// ──────────────────── Regression: no prediction → exact legacy text ────────────────────

console.log("\nRegression — no prediction, no earnings → exact legacy default reason\n");
{
  const r = computeTimingObservation({
    action: "Reduction-25%",
    scored: { overview: { returns_pct: { "1M": 0 } } },
    now: NOW_OPEN,
  });
  assert("verdict is 'Yes'", r.verdict === "Yes", r);
  const expected = "No proximate catalyst or volatility shock — standard mid-morning window (10:30-12:00) for a balance of liquidity and stability.";
  assert("reason exactly matches legacy", r.reason === expected, r.reason);
  assert("earnings_alert is null", r.earnings_alert == null, r.earnings_alert);
}

console.log("\nRegression — HOLD with prediction → n/a, no fields added\n");
{
  const r = computeTimingObservation({
    action: "HOLD",
    now: NOW_OPEN,
    predictionVerdict: "BEAT",
    predictionConfidence: 64,
    predictionQuality: "HIGH",
  });
  assert("verdict is 'n/a'", r.verdict === "n/a", r);
  assert("legacy reason text", r.reason === "Hold — no transaction needed.", r.reason);
  assert("no earnings_alert key on HOLD path", r.earnings_alert === undefined, r);
}

console.log("\nDay label edges — today / tomorrow / in 7d\n");
{
  const scoredToday = scoredWithEarnings(NOW_OPEN, 0);
  const rToday = computeTimingObservation({
    action: "Reduction-25%",
    scored: scoredToday,
    now: NOW_OPEN,
    predictionVerdict: "BEAT",
    predictionConfidence: 64,
    predictionQuality: "HIGH",
  });
  assert("eps_days=0 → 'Earnings in 0d' branch fires", /Earnings in 0d/.test(rToday.reason), rToday.reason);

  // Tomorrow check from a CLOSED moment (so the suffix in the Closed branch
  // uses our 'today/tomorrow' wording, exercising the day-label helper).
  const scoredTomorrow = scoredWithEarnings(NOW_WEEKEND, 1);
  const rTomorrow = computeTimingObservation({
    action: "Reduction-25%",
    scored: scoredTomorrow,
    now: NOW_WEEKEND,
    predictionVerdict: "BEAT",
    predictionConfidence: 64,
    predictionQuality: "HIGH",
  });
  assert("eps_days=1 closed-branch reason says 'tomorrow'", /tomorrow predicted BEAT/.test(rTomorrow.reason), rTomorrow.reason);
}

console.log("");
console.log(`Tests passed: ${pass}, failed: ${fail}`);
if (fail > 0) process.exit(1);
