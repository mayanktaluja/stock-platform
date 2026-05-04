/**
 * Regression tests for services/timingObservation.js — the per-action
 * "is today the right day?" verdict that powers the Timing chip on
 * every non-HOLD SWS card.
 *
 * Covers:
 *   • HOLD / null action → n/a
 *   • Market closed (weekend, pre-09:00, post-16:00) → Wait-for-open
 *   • Pre-open auction (09:00-09:15) → Wait-for-open with auction caveat
 *   • Earnings ≤3d → No (regardless of momentum)
 *   • Earnings 4-7d → Soft-no, closing-vwap
 *   • Recent analyst PT cut → Soft-no, closing-vwap
 *   • 1M return >+15% on a TRIM/EXIT → Soft-no
 *   • 1M return <-15% on a Top-up → Yes, mid-morning
 *   • 1M return <-15% on a TRIM/EXIT → Yes-not-urgent, post-lunch
 *   • Severe macro regime against sector + TRIM → Soft-no
 *   • Default clean state → Yes, mid-morning
 *
 * Date freezing: 2026-05-04 (today per project context). Market state
 * passed explicitly so the test doesn't depend on the runner's TZ or
 * the actual NSE session timing.
 *
 * Run with: node test/timingObservation.test.mjs
 */

import { computeTimingObservation, deriveIstMarketState } from "../services/timingObservation.js";

// 2026-05-04 is a Monday. Use 11:00 IST = 05:30 UTC for "Open" tests.
const NOW_OPEN = new Date("2026-05-04T05:30:00Z");
const NOW_PREOPEN = new Date("2026-05-04T03:30:00Z"); // 09:00 IST exactly
const NOW_PREOPEN_2 = new Date("2026-05-04T03:38:00Z"); // 09:08 IST
const NOW_POSTCLOSE = new Date("2026-05-04T11:00:00Z"); // 16:30 IST
const NOW_WEEKEND = new Date("2026-05-03T05:30:00Z");   // Sunday

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", got);
  }
}

// ──────────────────── deriveIstMarketState ────────────────────

console.log("\nderiveIstMarketState\n");
assert("Mon 11:00 IST → Open",     deriveIstMarketState(NOW_OPEN) === "Open",       deriveIstMarketState(NOW_OPEN));
assert("Mon 09:08 IST → Pre-open", deriveIstMarketState(NOW_PREOPEN_2) === "Pre-open", deriveIstMarketState(NOW_PREOPEN_2));
assert("Mon 09:00 IST → Pre-open", deriveIstMarketState(NOW_PREOPEN) === "Pre-open", deriveIstMarketState(NOW_PREOPEN));
assert("Mon 16:30 IST → Post-close", deriveIstMarketState(NOW_POSTCLOSE) === "Post-close", deriveIstMarketState(NOW_POSTCLOSE));
assert("Sunday → Closed",          deriveIstMarketState(NOW_WEEKEND) === "Closed",   deriveIstMarketState(NOW_WEEKEND));

// ──────────────────── HOLD / null ────────────────────

console.log("\nHOLD / null action\n");
{
  const r = computeTimingObservation({ action: "HOLD", now: NOW_OPEN });
  assert("HOLD → n/a", r.verdict === "n/a", r);
}
{
  const r = computeTimingObservation({ action: null, now: NOW_OPEN });
  assert("null action → n/a", r.verdict === "n/a", r);
}

// ──────────────────── Market state ────────────────────

console.log("\nMarket state\n");
{
  const r = computeTimingObservation({ action: "Reduction-50%", now: NOW_WEEKEND });
  assert("Sunday + TRIM → Wait-for-open", r.verdict === "Wait-for-open", r);
  assert("Sunday → next-session window", r.window === "next-session", r);
}
{
  const r = computeTimingObservation({ action: "Top-up-50%", now: NOW_PREOPEN_2 });
  assert("09:08 IST + Top-up → Wait-for-open", r.verdict === "Wait-for-open", r);
  assert("09:08 IST reason mentions pre-open auction", /pre-open/i.test(r.reason), r.reason);
}
{
  const r = computeTimingObservation({ action: "EXIT-now", now: NOW_POSTCLOSE });
  assert("16:30 IST + EXIT → Wait-for-open", r.verdict === "Wait-for-open", r);
}
// Override marketState to "Open" so we can run the rest of the rules
// against deterministic conditions without depending on the wall clock.

// ──────────────────── Earnings proximity ────────────────────

console.log("\nEarnings proximity\n");
{
  const scored = { overview: { next_earnings_date: "2026-05-06" } }; // 2 days away
  const r = computeTimingObservation({ action: "Reduction-50%", scored, now: NOW_OPEN, marketState: "Open" });
  assert("Earnings 2d → No", r.verdict === "No", r);
  assert("Earnings 2d → null window", r.window === null, r.window);
}
{
  const scored = { overview: { next_earnings_date: "2026-05-09" } }; // 5 days away
  const r = computeTimingObservation({ action: "Reduction-50%", scored, now: NOW_OPEN, marketState: "Open" });
  assert("Earnings 5d → Soft-no", r.verdict === "Soft-no", r);
  assert("Earnings 5d → closing-vwap window", r.window === "closing-vwap", r.window);
}
{
  const scored = { overview: { next_earnings_date: "2026-05-25" } }; // 21 days away — beyond the gate
  const r = computeTimingObservation({ action: "Reduction-50%", scored, now: NOW_OPEN, marketState: "Open" });
  assert("Earnings 21d → not gated", r.verdict !== "No" && r.verdict !== "Soft-no" || r.verdict === "Yes", r);
}

// ──────────────────── Recent analyst PT cut ────────────────────

console.log("\nRecent analyst PT cut\n");
{
  const scored = {
    overview: {
      recent_analyst_revisions: [{ direction: "decreased" }],
    },
  };
  const r = computeTimingObservation({ action: "Reduction-25%", scored, now: NOW_OPEN, marketState: "Open" });
  assert("PT cut + TRIM → Soft-no", r.verdict === "Soft-no", r);
  assert("PT cut → closing-vwap window", r.window === "closing-vwap", r.window);
}

// ──────────────────── Momentum-based ────────────────────

console.log("\nMomentum-based\n");
{
  // 1M +20% on a TRIM/EXIT → defer to closing VWAP
  const scored = { overview: { returns_pct: { "1M": 20 } } };
  const r = computeTimingObservation({ action: "Reduction-50%", scored, now: NOW_OPEN, marketState: "Open" });
  assert("+20% 1M + TRIM → Soft-no", r.verdict === "Soft-no", r);
  assert("+20% 1M + TRIM → closing-vwap", r.window === "closing-vwap", r.window);
}
{
  // 1M +20% on a Top-up → no rule triggers (overshoot doesn't apply to top-ups)
  const scored = { overview: { returns_pct: { "1M": 20 } } };
  const r = computeTimingObservation({ action: "Top-up-50%", scored, now: NOW_OPEN, marketState: "Open" });
  assert("+20% 1M + Top-up → falls through to default Yes", r.verdict === "Yes", r);
}
{
  // 1M -20% on a Top-up → averaging window, mid-morning
  const scored = { overview: { returns_pct: { "1M": -20 } } };
  const r = computeTimingObservation({ action: "Top-up-50%", scored, now: NOW_OPEN, marketState: "Open" });
  assert("-20% 1M + Top-up → Yes", r.verdict === "Yes", r);
  assert("-20% 1M + Top-up → mid-morning", r.window === "mid-morning", r.window);
}
{
  // 1M -20% on a TRIM/EXIT → avoid panic, post-lunch
  const scored = { overview: { returns_pct: { "1M": -20 } } };
  const r = computeTimingObservation({ action: "Reduction-50%", scored, now: NOW_OPEN, marketState: "Open" });
  assert("-20% 1M + TRIM → Yes-not-urgent", r.verdict === "Yes-not-urgent", r);
  assert("-20% 1M + TRIM → post-lunch", r.window === "post-lunch", r.window);
}

// ──────────────────── Macro regime headwind ────────────────────

console.log("\nMacro regime\n");
{
  const scored = { overview: { returns_pct: { "1M": 2 } } };
  const r = computeTimingObservation({
    action: "Reduction-50%", scored, now: NOW_OPEN, marketState: "Open",
    regimeSeverity: 4, sectorImpact: -3,
  });
  assert("Severe regime + sector hit + TRIM → Soft-no", r.verdict === "Soft-no", r);
  assert("Severe regime → closing-vwap", r.window === "closing-vwap", r.window);
}
{
  // Severe regime but sector neutral → no headwind override
  const scored = { overview: { returns_pct: { "1M": 2 } } };
  const r = computeTimingObservation({
    action: "Reduction-50%", scored, now: NOW_OPEN, marketState: "Open",
    regimeSeverity: 4, sectorImpact: 0,
  });
  assert("Severe regime + neutral sector → Yes (no override)", r.verdict === "Yes", r);
}

// ──────────────────── Default clean state ────────────────────

console.log("\nDefault clean state\n");
{
  const scored = { overview: { returns_pct: { "1M": 3 } } };
  const r = computeTimingObservation({ action: "Reduction-25%", scored, now: NOW_OPEN, marketState: "Open" });
  assert("Clean state + TRIM → Yes", r.verdict === "Yes", r);
  assert("Clean state → mid-morning window", r.window === "mid-morning", r.window);
}
{
  const r = computeTimingObservation({ action: "Top-up-100%", now: NOW_OPEN, marketState: "Open" });
  assert("Top-up no scored data → Yes (default)", r.verdict === "Yes", r);
}

// ──────────────────── Summary ────────────────────

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
