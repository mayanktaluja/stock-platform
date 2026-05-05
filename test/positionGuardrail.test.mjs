/**
 * Regression tests for services/swsConvictionEngine.js::_positionGuardrail
 * (PR 2.1 + 2.2 — drawdown rule rewrite).
 *
 * Covers:
 *   • Catastrophic drawdown alone no longer forces EXIT — must combine with
 *     a structural-weakness signal (low v3, low snow, negative fwd growth,
 *     or weak independent crosscheck).
 *   • Disposition-effect override only fires when v3 < 50 AND fundamentals
 *     also flag weakness — no longer trims TCS-style quality compounders.
 *   • Single-name concentration guardrail still fires.
 *
 * The guardrail is exercised through computeRecommendationV2 since the
 * guardrail function itself is private. We construct minimal inputs that
 * isolate the guardrail's contribution by feeding net-zero layer votes.
 *
 * Run with: node test/positionGuardrail.test.mjs
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

// Default crosscheck/catalyst/indianRisk that contribute zero net delta —
// keeps the conviction engine on HOLD/MEDIUM so the guardrail's behavior
// is what gets exercised. independent_score is supplied per-test for the
// crosscheck-weak gate.
function neutralLayers(independentScore = 65) {
  return {
    crosscheck: { confidence_delta: 0, independent_score: independentScore },
    catalyst:   { confidence_delta: 0 },
    indianRisk: { confidence_delta: 0 },
  };
}

function run({ pnl, v3, snow, fwd = null, indep = 65, pw = 5, swsAction = "HOLD" }) {
  const { crosscheck, catalyst, indianRisk } = neutralLayers(indep);
  return computeRecommendationV2({
    sws_action: swsAction,
    sws_v3: v3,
    sws_verdict: null,
    crosscheck,
    catalyst,
    indianRisk,
    position_ctx: { pnlPercent: pnl, positionWeight: pw, sectorWeight: 5, snowflake_total: snow },
    fiscal: { earnings_growth_pct: fwd },
  });
}

console.log("\n_positionGuardrail — catastrophic drawdown (-43%)\n");

{
  // INOXWIND-style: drawdown deep but SWS still rates TOP_PICK and snow strong.
  // OLD rule: force EXIT. NEW rule: not structurally weak → fall through to
  // Reduction-50% with an "observe before exit" note.
  const r = run({ pnl: -43, v3: 67, snow: 22 });
  assert("v3=67 snow=22 → not EXIT", r.action !== "EXIT", r.action);
  assert("emits Reduction-50%", r.action === "Reduction-50%", r.action);
  assert("guardrail_reason mentions partial trim", /partial trim|observe/i.test(r.guardrail_reason || ""), r.guardrail_reason);
}

{
  // Genuinely broken: drawdown deep AND v3 weak AND snow weak.
  const r = run({ pnl: -43, v3: 20, snow: 10 });
  assert("v3=20 snow=10 → EXIT", r.action === "EXIT", r.action);
  assert("guardrail_reason cites structural weakness", /structural weakness|thesis broken/i.test(r.guardrail_reason || ""), r.guardrail_reason);
}

{
  // Borderline: drawdown deep, snow borderline, v3 borderline → still EXIT
  // because v3<50 trips the structurallyWeak gate.
  const r = run({ pnl: -43, v3: 30, snow: 15 });
  assert("v3=30 snow=15 → EXIT (v3<50)", r.action === "EXIT", r.action);
}

{
  // Independent crosscheck flags weakness: drawdown + indep<50 → EXIT.
  const r = run({ pnl: -43, v3: 60, snow: 20, indep: 40 });
  assert("indep<50 + drawdown → EXIT", r.action === "EXIT", r.action);
  assert("reason mentions independent score", /indep/i.test(r.guardrail_reason || ""), r.guardrail_reason);
}

console.log("\n_positionGuardrail — disposition-effect (-30%)\n");

{
  // TCS-style: -31% drawdown but v3=62 (TOP_PICK band) and snow strong.
  // OLD rule: Reduction-50%. NEW rule: pass-through (no guardrail fires —
  // v3 ≥ 50 means the disposition-effect gate doesn't open).
  const r = run({ pnl: -31, v3: 62, snow: 20 });
  assert("v3=62 snow=20 → no trim", r.action === "HOLD", r.action);
  assert("no guardrail_reason", !r.guardrail_reason, r.guardrail_reason);
}

{
  // Genuinely weak compounder mid-correction: v3<50 AND snow<18.
  const r = run({ pnl: -31, v3: 35, snow: 12 });
  assert("v3=35 snow=12 → Reduction-50%", r.action === "Reduction-50%", r.action);
  assert("guardrail_reason cites disposition-effect", /disposition-effect/i.test(r.guardrail_reason || ""), r.guardrail_reason);
}

{
  // -31% but v3 borderline + crosscheck OK → pass-through.
  const r = run({ pnl: -31, v3: 45, snow: 20, indep: 60 });
  assert("v3=45 snow=20 indep=60 → pass-through", r.action === "HOLD", r.action);
}

console.log("\n_positionGuardrail — light-trim band (-25%)\n");

{
  const r = run({ pnl: -26, v3: 40, snow: 14 });
  assert("v3=40 snow=14 → Reduction-25-33%", r.action === "Reduction-25-33%", r.action);
}

{
  // -25% drawdown but quality intact → pass-through.
  const r = run({ pnl: -26, v3: 60, snow: 22 });
  assert("v3=60 snow=22 → no trim", r.action === "HOLD", r.action);
}

console.log("\n_positionGuardrail — single-name concentration\n");

{
  const r = run({ pnl: -5, v3: 55, snow: 20, pw: 17 });
  assert("pw=17 → Reduction-25-33%", r.action === "Reduction-25-33%", r.action);
  assert("guardrail_reason cites concentration", /concentration|of book/i.test(r.guardrail_reason || ""), r.guardrail_reason);
}

console.log("\n_positionGuardrail — no guardrail at small drawdown\n");

{
  const r = run({ pnl: -8, v3: 45, snow: 16 });
  assert("pnl=-8 → pass-through", !r.guardrail_reason, r.guardrail_reason);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
