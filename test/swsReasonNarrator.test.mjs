/**
 * Regression tests for services/swsReasonNarrator.js.
 *
 * The narrator generates the 3-paragraph user-facing reason text for every
 * pick in the v2 conviction engine. It is pure templating (no LLM, no I/O),
 * so its contract is straightforward to lock down but easy to silently
 * drift on — a refactor that swaps a conviction-band string or reorders
 * the primary-driver pickers would degrade the explanation shown to every
 * user with zero observable runtime signal. These tests pin the shape and
 * the conditional-clause logic.
 *
 * Run with: node test/swsReasonNarrator.test.mjs
 */

import { buildReasonNarrative } from "../services/swsReasonNarrator.js";

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

// ──────────────────── Output shape ────────────────────

console.log("\nOutput shape\n");

// Minimal call — no layers, no position_ctx. Should still return a 2-para
// payload with primary_reason populated.
{
  const out = buildReasonNarrative({
    action: "HOLD",
    sws_action: "HOLD",
    conviction: "MEDIUM",
    netDelta: 0,
    sws_v3: 35,
    sws_verdict: "WATCH",
    crosscheck: null,
    catalyst: null,
    indianRisk: null,
    position_ctx: null,
    fiscal: null,
    guardrailReason: null,
  });
  assert("returns object with primary_reason + paragraphs",
    typeof out === "object" && typeof out.primary_reason === "string" && Array.isArray(out.paragraphs),
    out);
  assert("paragraphs has 2 entries when position_ctx is null",
    out.paragraphs.length === 2, out.paragraphs.length);
  assert("primary_reason equals paragraphs[0]",
    out.primary_reason === out.paragraphs[0], { p: out.primary_reason, p0: out.paragraphs[0] });
  assert("primary_reason starts with bolded action",
    out.primary_reason.startsWith("**HOLD**"), out.primary_reason);
}

// ──────────────────── Happy path — typical Reduction ────────────────────

console.log("\nHappy path — typical Reduction with all layers\n");

{
  const out = buildReasonNarrative({
    action: "Reduction-50%",
    sws_action: "Reduction-25-33%",
    conviction: "MEDIUM-HIGH",
    netDelta: -2,
    sws_v3: 38,
    sws_verdict: "WATCH",
    crosscheck: {
      available: true,
      reason: "Snowflake disagrees with v3 by 18 points.",
      pillar_agreement_pct: 40,
      confidence_delta: -1,
    },
    catalyst: {
      available: true,
      summary: "Sector-rotation headwind expected through Q2.",
      catalystScore: -8,
      confidence_delta: -1,
    },
    indianRisk: {
      available: true,
      summary: "ASM-2 surveillance + governance concern from auditor change.",
      risk_score: 6,
      confidence_delta: -1,
    },
    position_ctx: {
      pnlPercent: 12.4,
      positionWeight: 7.2,
      sectorWeight: 22,
      snowflake_total: 14,
    },
    fiscal: null,
    guardrailReason: null,
  });
  assert("3 paragraphs when position_ctx is present",
    out.paragraphs.length === 3, out.paragraphs.length);
  assert("para1 includes conviction phrase",
    out.paragraphs[0].includes("medium-high conviction"), out.paragraphs[0]);
  assert("para1 includes SWS-band-mismatch hint (action !== sws_action)",
    out.paragraphs[0].includes("SWS-only band would have said Reduction-25-33%"), out.paragraphs[0]);
  // Indian-risk and Catalyst both have magnitude=|risk_score=6| and |catalystScore=-8|;
  // the cross-check magnitude is 100-40=60 → cross-check wins.
  assert("para1 picks Cross-check as dominant driver (highest magnitude)",
    out.paragraphs[0].includes("Cross-check layer is the dominant driver"), out.paragraphs[0]);
  assert("para2 enumerates all three available layers",
    out.paragraphs[1].includes("Cross-check (Layer 2)") &&
    out.paragraphs[1].includes("Catalyst (Layer 4)") &&
    out.paragraphs[1].includes("India-risk (Layer 3)"),
    out.paragraphs[1]);
  assert("para3 mentions PnL stance + weight + sector",
    out.paragraphs[2].includes("up 12.4%") &&
    out.paragraphs[2].includes("mid-weight at 7.2%") &&
    out.paragraphs[2].includes("sector 22%"),
    out.paragraphs[2]);
}

// ──────────────────── Conviction phrase mapping ────────────────────

console.log("\nConviction phrase mapping\n");

const baseArgs = {
  action: "HOLD",
  sws_action: "HOLD",
  netDelta: 0,
  sws_v3: 40,
  sws_verdict: "WATCH",
  crosscheck: null,
  catalyst: null,
  indianRisk: null,
  position_ctx: null,
  fiscal: null,
  guardrailReason: null,
};

const convictionExpectations = {
  HIGH:          "high conviction (3 of 3 layers confirm)",
  "MEDIUM-HIGH": "medium-high conviction (2 of 3 layers confirm)",
  MEDIUM:        "medium conviction (layers split or neutral)",
  "MEDIUM-LOW":  "medium-low conviction (1 layer dissents)",
  LOW:           "low conviction (multiple layers dissent",
};
for (const [conv, phrase] of Object.entries(convictionExpectations)) {
  const out = buildReasonNarrative({ ...baseArgs, conviction: conv });
  assert(`${conv} → "${phrase}…"`,
    out.paragraphs[0].includes(phrase), out.paragraphs[0]);
}

// Unknown conviction falls through to LOW wording (default branch).
{
  const out = buildReasonNarrative({ ...baseArgs, conviction: "NONESUCH" });
  assert("unknown conviction falls through to LOW phrasing",
    out.paragraphs[0].includes("low conviction"), out.paragraphs[0]);
}

// ──────────────────── Primary driver selection ────────────────────

console.log("\nPrimary driver — highest absolute magnitude with non-zero delta wins\n");

// Indian-risk magnitude=12, Catalyst magnitude=5, Cross-check magnitude=2
// → Indian-risk wins.
{
  const out = buildReasonNarrative({
    action: "EXIT",
    sws_action: "EXIT",
    conviction: "LOW",
    netDelta: -3,
    sws_v3: 9,
    sws_verdict: "AVOID",
    crosscheck: { available: true, reason: "Minor SnowFlake gap.", pillar_agreement_pct: 98, confidence_delta: -1 },
    catalyst:   { available: true, summary: "Mild calendar drag.", catalystScore: -5, confidence_delta: -1 },
    indianRisk: { available: true, summary: "GSM-3 surveillance triggered.", risk_score: 12, confidence_delta: -1 },
    position_ctx: null,
    fiscal: null,
    guardrailReason: null,
  });
  assert("Indian-risk wins when its magnitude tops the others",
    out.paragraphs[0].includes("Indian-risk layer is the dominant driver"), out.paragraphs[0]);
  assert("dominant-driver line contains the layer's summary text",
    out.paragraphs[0].includes("GSM-3 surveillance triggered."), out.paragraphs[0]);
}

// Candidates with delta=0 are filtered out — only Catalyst remains.
{
  const out = buildReasonNarrative({
    action: "HOLD",
    sws_action: "HOLD",
    conviction: "MEDIUM",
    netDelta: 0,
    sws_v3: 50,
    sws_verdict: "ACCEPTABLE",
    crosscheck: { available: true, reason: "Pillars roughly aligned.", pillar_agreement_pct: 92, confidence_delta: 0 },
    catalyst:   { available: true, summary: "Earnings call next week.", catalystScore: 3, confidence_delta: 1 },
    indianRisk: { available: true, summary: "No flags.", risk_score: 0, confidence_delta: 0 },
    position_ctx: null,
    fiscal: null,
    guardrailReason: null,
  });
  assert("layers with confidence_delta=0 are filtered → Catalyst wins by default",
    out.paragraphs[0].includes("Catalyst layer is the dominant driver"), out.paragraphs[0]);
}

// All layers have delta=0 → fallback to SWS-only narration.
{
  const out = buildReasonNarrative({
    action: "HOLD",
    sws_action: "HOLD",
    conviction: "MEDIUM",
    netDelta: 0,
    sws_v3: 47.6,
    sws_verdict: "ACCEPTABLE",
    crosscheck: { available: true, reason: "Aligned.", pillar_agreement_pct: 95, confidence_delta: 0 },
    catalyst:   { available: true, summary: "Quiet.", catalystScore: 0, confidence_delta: 0 },
    indianRisk: { available: true, summary: "Clean.", risk_score: 0, confidence_delta: 0 },
    position_ctx: null,
    fiscal: null,
    guardrailReason: null,
  });
  assert("no-layer-opinion fallback names SWS as dominant",
    out.paragraphs[0].includes("SWS V4 score 48/100"), out.paragraphs[0]);
  assert("fallback includes verdict",
    out.paragraphs[0].includes("ACCEPTABLE"), out.paragraphs[0]);
  assert("fallback explicitly says no dissent",
    out.paragraphs[0].includes("no independent layer carries a strong dissent"), out.paragraphs[0]);
}

// SWS-only fallback works when verdict is missing.
{
  const out = buildReasonNarrative({
    action: "HOLD",
    sws_action: "HOLD",
    conviction: "MEDIUM",
    netDelta: 0,
    sws_v3: 40,
    sws_verdict: null,
    crosscheck: null,
    catalyst: null,
    indianRisk: null,
    position_ctx: null,
    fiscal: null,
    guardrailReason: null,
  });
  assert("missing verdict prints 'n/a' in fallback",
    out.paragraphs[0].includes("verdict: n/a"), out.paragraphs[0]);
}

// ──────────────────── Guardrail override path ────────────────────

console.log("\nGuardrail override path\n");

{
  const out = buildReasonNarrative({
    action: "EXIT",
    sws_action: "Reduction-50%",
    conviction: "HIGH",            // ignored under guardrail
    netDelta: 0,
    sws_v3: 24,
    sws_verdict: "WATCH",
    crosscheck: { available: true, reason: "OK.", pillar_agreement_pct: 90, confidence_delta: -1 },
    catalyst:   { available: true, summary: "OK.", catalystScore: -2, confidence_delta: -1 },
    indianRisk: { available: true, summary: "OK.", risk_score: 4, confidence_delta: -1 },
    position_ctx: { pnlPercent: -45, positionWeight: 18, sectorWeight: 30 },
    fiscal: null,
    guardrailReason: "Stop-loss breached at -45% with deteriorating fundamentals.",
  });
  assert("guardrail para1 includes the guardrail reason verbatim",
    out.paragraphs[0].includes("Stop-loss breached at -45% with deteriorating fundamentals."),
    out.paragraphs[0]);
  assert("guardrail para1 omits the band-phrase wording (e.g. 'high conviction (3 of 3 layers confirm)')",
    !out.paragraphs[0].includes("3 of 3 layers confirm") &&
    !out.paragraphs[0].includes("layers split or neutral") &&
    !out.paragraphs[0].includes("layer dissents"),
    out.paragraphs[0]);
  assert("guardrail para1 explains override semantics",
    out.paragraphs[0].includes("Position-guardrail override"),
    out.paragraphs[0]);
  // para2 + para3 are still generated normally — the override only rewrites para1.
  assert("guardrail still emits layer paragraph",
    out.paragraphs[1].includes("Cross-check (Layer 2)"),
    out.paragraphs[1]);
  assert("guardrail still emits position paragraph",
    out.paragraphs.length === 3 && out.paragraphs[2].includes("down 45.0%"),
    out.paragraphs);
}

// ──────────────────── Action equals sws_action — no mismatch line ────────────────────

console.log("\nNo SWS-band-mismatch sentence when action === sws_action\n");

{
  const out = buildReasonNarrative({
    action: "HOLD",
    sws_action: "HOLD",
    conviction: "MEDIUM",
    netDelta: 0,
    sws_v3: 40,
    sws_verdict: "WATCH",
    crosscheck: null,
    catalyst: null,
    indianRisk: null,
    position_ctx: null,
    fiscal: null,
    guardrailReason: null,
  });
  assert("no mismatch hint when action matches sws_action",
    !out.paragraphs[0].includes("SWS-only band would have said"),
    out.paragraphs[0]);
}

// ──────────────────── Layer-2 unavailable wording ────────────────────

console.log("\nLayer-2 unavailable wording in para2\n");

// available=false WITH a reason — uses the reason.
{
  const out = buildReasonNarrative({
    action: "HOLD", sws_action: "HOLD", conviction: "MEDIUM", netDelta: 0,
    sws_v3: 40, sws_verdict: "WATCH",
    crosscheck: { available: false, reason: "snapshot older than 14d" },
    catalyst: null,
    indianRisk: null,
    position_ctx: null,
    fiscal: null,
    guardrailReason: null,
  });
  assert("para2 names the cross-check unavailable reason",
    out.paragraphs[1].includes("Cross-check (Layer 2): unavailable (snapshot older than 14d)"),
    out.paragraphs[1]);
}

// available=false WITHOUT a reason — falls back to "no snapshot".
{
  const out = buildReasonNarrative({
    action: "HOLD", sws_action: "HOLD", conviction: "MEDIUM", netDelta: 0,
    sws_v3: 40, sws_verdict: "WATCH",
    crosscheck: { available: false },
    catalyst: null,
    indianRisk: null,
    position_ctx: null,
    fiscal: null,
    guardrailReason: null,
  });
  assert("para2 falls back to 'no snapshot' when no reason provided",
    out.paragraphs[1].includes("unavailable (no snapshot)"),
    out.paragraphs[1]);
}

// crosscheck completely null — should still emit the unavailable line.
{
  const out = buildReasonNarrative({
    action: "HOLD", sws_action: "HOLD", conviction: "MEDIUM", netDelta: 0,
    sws_v3: 40, sws_verdict: "WATCH",
    crosscheck: null,
    catalyst: null,
    indianRisk: null,
    position_ctx: null,
    fiscal: null,
    guardrailReason: null,
  });
  assert("para2 handles null crosscheck cleanly",
    out.paragraphs[1].includes("Cross-check (Layer 2): unavailable"),
    out.paragraphs[1]);
}

// Catalyst / indianRisk lines only appear when their .available flag is true.
{
  const out = buildReasonNarrative({
    action: "HOLD", sws_action: "HOLD", conviction: "MEDIUM", netDelta: 0,
    sws_v3: 40, sws_verdict: "WATCH",
    crosscheck: { available: true, reason: "fine" },
    catalyst:   { available: false, summary: "not present" },
    indianRisk: { available: false, summary: "not present" },
    position_ctx: null,
    fiscal: null,
    guardrailReason: null,
  });
  assert("Catalyst absent when available=false",
    !out.paragraphs[1].includes("Catalyst (Layer 4)"),
    out.paragraphs[1]);
  assert("India-risk absent when available=false",
    !out.paragraphs[1].includes("India-risk (Layer 3)"),
    out.paragraphs[1]);
}

// ──────────────────── Position paragraph banding ────────────────────

console.log("\nPosition paragraph — PnL bands\n");

const pctx = (overrides) => ({
  pnlPercent: 0,
  positionWeight: 4,
  sectorWeight: 15,
  ...overrides,
});
const reasonArgsWithCtx = (ctx, action = "HOLD") => ({
  action,
  sws_action: action,
  conviction: "MEDIUM",
  netDelta: 0,
  sws_v3: 40,
  sws_verdict: "WATCH",
  crosscheck: null,
  catalyst: null,
  indianRisk: null,
  position_ctx: ctx,
  fiscal: null,
  guardrailReason: null,
});

// PnL banding: ≥+5% → "up X%", ≤-5% → "down X%", else → "near break-even".
{
  const upOut    = buildReasonNarrative(reasonArgsWithCtx(pctx({ pnlPercent: 18.7 })));
  const downOut  = buildReasonNarrative(reasonArgsWithCtx(pctx({ pnlPercent: -22.3 })));
  const flatOut  = buildReasonNarrative(reasonArgsWithCtx(pctx({ pnlPercent: 1.2 })));
  const lowEdge  = buildReasonNarrative(reasonArgsWithCtx(pctx({ pnlPercent: -5 })));
  const highEdge = buildReasonNarrative(reasonArgsWithCtx(pctx({ pnlPercent: 5 })));
  assert("+18.7% → 'up 18.7%'",         upOut.paragraphs[2].includes("up 18.7%"), upOut.paragraphs[2]);
  assert("-22.3% → 'down 22.3%'",       downOut.paragraphs[2].includes("down 22.3%"), downOut.paragraphs[2]);
  assert("+1.2% → 'near break-even'",   flatOut.paragraphs[2].includes("near break-even (1.2%)"), flatOut.paragraphs[2]);
  assert("-5% (boundary) → 'down 5.0%'", lowEdge.paragraphs[2].includes("down 5.0%"), lowEdge.paragraphs[2]);
  assert("+5% (boundary) → 'up 5.0%'",  highEdge.paragraphs[2].includes("up 5.0%"), highEdge.paragraphs[2]);
}

console.log("\nPosition paragraph — weight bands\n");

// Position weight: >10 oversized, 5-10 mid, ≤5 small.
{
  const oversized = buildReasonNarrative(reasonArgsWithCtx(pctx({ positionWeight: 14.2 })));
  const midweight = buildReasonNarrative(reasonArgsWithCtx(pctx({ positionWeight: 7.5 })));
  const small     = buildReasonNarrative(reasonArgsWithCtx(pctx({ positionWeight: 3.0 })));
  assert("14.2% → 'oversized at 14.2% of book'",
    oversized.paragraphs[2].includes("oversized at 14.2% of book"), oversized.paragraphs[2]);
  assert("7.5% → 'mid-weight at 7.5%'",
    midweight.paragraphs[2].includes("mid-weight at 7.5%"), midweight.paragraphs[2]);
  assert("3.0% → 'small at 3.0%'",
    small.paragraphs[2].includes("small at 3.0%"), small.paragraphs[2]);
}

console.log("\nPosition paragraph — sector bands\n");

// Sector concentration: >25 concentrated, 15-25 plain, ≤15 silent.
{
  const concentrated = buildReasonNarrative(reasonArgsWithCtx(pctx({ sectorWeight: 32 })));
  const midSector    = buildReasonNarrative(reasonArgsWithCtx(pctx({ sectorWeight: 20 })));
  const lowSector    = buildReasonNarrative(reasonArgsWithCtx(pctx({ sectorWeight: 10 })));
  assert("sector=32% → '(concentrated)'",
    concentrated.paragraphs[2].includes("sector exposure 32% (concentrated)"), concentrated.paragraphs[2]);
  assert("sector=20% → '; sector 20%'",
    midSector.paragraphs[2].includes("sector 20%") && !midSector.paragraphs[2].includes("concentrated"),
    midSector.paragraphs[2]);
  assert("sector=10% → no sector clause",
    !lowSector.paragraphs[2].includes("sector"), lowSector.paragraphs[2]);
}

console.log("\nPosition paragraph — action-specific stance lines\n");

// EXIT + pnl < -10 → tax-loss harvest stance.
{
  const out = buildReasonNarrative(reasonArgsWithCtx(pctx({ pnlPercent: -25 }), "EXIT"));
  assert("EXIT + -25% → tax-loss harvest stance",
    out.paragraphs[2].includes("Tax-loss harvest opportunity"), out.paragraphs[2]);
}
// EXIT + pnl = -5 → no harvest stance (boundary, not < -10).
{
  const out = buildReasonNarrative(reasonArgsWithCtx(pctx({ pnlPercent: -8 }), "EXIT"));
  assert("EXIT + -8% → no harvest stance (above -10 threshold)",
    !out.paragraphs[2].includes("Tax-loss harvest"), out.paragraphs[2]);
}
// Reduction + pnl > 30 → booking partial gains stance.
{
  const out = buildReasonNarrative(reasonArgsWithCtx(pctx({ pnlPercent: 45 }), "Reduction-50%"));
  assert("Reduction-50% + +45% → 'Booking partial gains'",
    out.paragraphs[2].includes("Booking partial gains"), out.paragraphs[2]);
}
// Top-up + pnl < -10 → averaging-down stance.
{
  const out = buildReasonNarrative(reasonArgsWithCtx(pctx({ pnlPercent: -18 }), "Top-up-50%"));
  assert("Top-up-50% + -18% → 'Averaging-down territory'",
    out.paragraphs[2].includes("Averaging-down territory"), out.paragraphs[2]);
}
// HOLD always → "No transaction needed."
{
  const out = buildReasonNarrative(reasonArgsWithCtx(pctx({ pnlPercent: 1 }), "HOLD"));
  assert("HOLD → 'No transaction needed'",
    out.paragraphs[2].includes("No transaction needed"), out.paragraphs[2]);
}
// Random other action with no matching stance condition → no stance line.
{
  const out = buildReasonNarrative(reasonArgsWithCtx(pctx({ pnlPercent: 2 }), "Reduction-50%"));
  // No stance line means the paragraph ends right after the sector clause —
  // it doesn't get any of the four stance suffixes.
  const p3 = out.paragraphs[2];
  const hasStance =
    p3.includes("Tax-loss") ||
    p3.includes("Booking partial") ||
    p3.includes("Averaging-down") ||
    p3.includes("No transaction needed");
  assert("Reduction-50% + small gain → no stance suffix",
    !hasStance, p3);
}

// Defensive: missing numeric fields default to 0 via num() helper.
{
  const out = buildReasonNarrative(reasonArgsWithCtx({
    pnlPercent: null,
    positionWeight: undefined,
    sectorWeight: NaN,
  }));
  assert("null pnl + undefined weight + NaN sector defaults to 0s",
    out.paragraphs[2].includes("near break-even (0.0%)") &&
    out.paragraphs[2].includes("small at 0.0%"),
    out.paragraphs[2]);
}

// ──────────────────── Error/edge cases ────────────────────

console.log("\nError-path / edge cases\n");

// Missing action → falls through to "—" placeholder.
{
  const out = buildReasonNarrative({
    action: null,
    sws_action: null,
    conviction: "MEDIUM",
    netDelta: 0,
    sws_v3: 40,
    sws_verdict: "WATCH",
    crosscheck: null,
    catalyst: null,
    indianRisk: null,
    position_ctx: null,
    fiscal: null,
    guardrailReason: null,
  });
  assert("null action renders as '—' placeholder",
    out.paragraphs[0].startsWith("**—**"), out.paragraphs[0]);
}

// Pure function — same args produce identical output, no shared state.
{
  const args = {
    action: "Reduction-25%",
    sws_action: "HOLD",
    conviction: "MEDIUM-LOW",
    netDelta: -1,
    sws_v3: 32,
    sws_verdict: "WATCH",
    crosscheck: { available: true, reason: "Snowflake gap.", pillar_agreement_pct: 80, confidence_delta: -1 },
    catalyst: null,
    indianRisk: null,
    position_ctx: { pnlPercent: 7.5, positionWeight: 8.2, sectorWeight: 18 },
    fiscal: null,
    guardrailReason: null,
  };
  const a = buildReasonNarrative(args);
  const b = buildReasonNarrative(args);
  assert("determinism: primary_reason matches across calls",
    a.primary_reason === b.primary_reason, [a.primary_reason, b.primary_reason]);
  assert("determinism: paragraphs match exactly across calls",
    JSON.stringify(a.paragraphs) === JSON.stringify(b.paragraphs), null);
}

// ──────────────────── Summary ────────────────────

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
