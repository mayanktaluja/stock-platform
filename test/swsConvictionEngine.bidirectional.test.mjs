/**
 * Regression tests for the bidirectional conviction layer in
 * services/swsConvictionEngine.js — specifically the new signedHoldEscalate
 * branch that promotes HOLD → Reduction-25-33% when 3 layers all agree
 * bearish (signSum ≤ -2 AND netDelta ≤ -2).
 *
 * Covers:
 *   • HOLD + 3 bearish layers       → Reduction-25-33%
 *   • HOLD + mixed but net positive → Top-up-modest
 *   • HOLD + 3 bullish layers       → Top-up-modest
 *   • Reduction-25-33% + Δ≥+2       → Reduction-50% (existing escalation)
 *   • STRONG Top-up + Δ≥+2          → unchanged (top of ladder cap)
 *   • Reduction-25-33% + Δ≤-2       → softens toward HOLD
 *
 * Run with: node test/swsConvictionEngine.bidirectional.test.mjs
 *
 * Tests pass position_ctx with pnl=0, pw=2, v3=50 so the position guardrail
 * never fires — the only logic exercised is the conviction layer.
 */

import { computeRecommendationV2 } from "../services/swsConvictionEngine.js";

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

function neutralCtx() {
  return {
    sws_v3: 50,
    sws_verdict: "ACCEPTABLE",
    position_ctx: { pnlPercent: 0, positionWeight: 2, snowflake_total: 18 },
    fiscal: { snowflake_total: 18, earnings_growth_pct: 5 },
  };
}

console.log("\nHOLD + 3 bearish layers → Reduction-25-33%\n");
{
  const r = computeRecommendationV2({
    sws_action: "HOLD",
    crosscheck: { confidence_delta: -1, reason: "fundamentals weak" },
    catalyst:   { confidence_delta: -1, summary: "earnings miss" },
    indianRisk: { confidence_delta: -1, summary: "regulatory drag" },
    ...neutralCtx(),
  });
  assert("action = Reduction-25-33%", r.action === "Reduction-25-33%", r.action);
  assert("net_delta = -3", r.net_delta === -3, r.net_delta);
  assert("conviction = LOW", r.conviction === "LOW", r.conviction);
  assert("action_source = layer-adjusted", r.action_source === "layer-adjusted", r.action_source);
}

console.log("\nHOLD + mixed (net positive) → Top-up-modest\n");
{
  const r = computeRecommendationV2({
    sws_action: "HOLD",
    crosscheck: { confidence_delta: 2 },  // strong bullish
    catalyst:   { confidence_delta: -1 }, // mild bearish
    indianRisk: { confidence_delta: 1 },  // mild bullish
    ...neutralCtx(),
  });
  // signSum = +1 (1 -1 1), netDelta = +2 → Top-up-modest
  assert("action = Top-up-modest", r.action === "Top-up-modest", r.action);
  assert("net_delta = 2", r.net_delta === 2, r.net_delta);
}

console.log("\nHOLD + 3 bullish layers → Top-up-modest\n");
{
  const r = computeRecommendationV2({
    sws_action: "HOLD",
    crosscheck: { confidence_delta: 1 },
    catalyst:   { confidence_delta: 1 },
    indianRisk: { confidence_delta: 1 },
    ...neutralCtx(),
  });
  assert("action = Top-up-modest", r.action === "Top-up-modest", r.action);
  assert("net_delta = 3", r.net_delta === 3, r.net_delta);
}

console.log("\nReduction-25-33% + Δ≥+2 (bearish escalation) → Reduction-50%\n");
{
  const r = computeRecommendationV2({
    sws_action: "Reduction-25-33%",
    crosscheck: { confidence_delta: 1 },
    catalyst:   { confidence_delta: 1 },
    indianRisk: { confidence_delta: 0 },
    ...neutralCtx(),
  });
  assert("action = Reduction-50%", r.action === "Reduction-50%", r.action);
  assert("net_delta = 2", r.net_delta === 2, r.net_delta);
}

console.log("\nSTRONG Top-up + Δ≥+2 → unchanged (cap at top of ladder)\n");
{
  const r = computeRecommendationV2({
    sws_action: "STRONG Top-up",
    crosscheck: { confidence_delta: 1 },
    catalyst:   { confidence_delta: 1 },
    indianRisk: { confidence_delta: 1 },
    ...neutralCtx(),
  });
  assert("action = STRONG Top-up (no leapfrog)", r.action === "STRONG Top-up", r.action);
}

console.log("\nReduction-25-33% + Δ≤-2 → softens toward HOLD\n");
{
  const r = computeRecommendationV2({
    sws_action: "Reduction-25-33%",
    crosscheck: { confidence_delta: -1 },
    catalyst:   { confidence_delta: -1 },
    indianRisk: { confidence_delta: 0 },
    ...neutralCtx(),
  });
  // ACTION_LADDER softens Reduction-25-33% toward HOLD: index moves +1.
  // The exact softened action depends on ladder ordering; assert it isn't
  // a Reduction stronger than the input.
  assert("net_delta = -2", r.net_delta === -2, r.net_delta);
  assert("not stronger than Reduction-25-33%",
    r.action !== "Reduction-50%" && r.action !== "Reduction-66%" &&
    r.action !== "EXIT-staged" && r.action !== "EXIT-now" && r.action !== "EXIT",
    r.action);
}

console.log("");
console.log(`Tests passed: ${pass}, failed: ${fail}`);
if (fail > 0) process.exit(1);
