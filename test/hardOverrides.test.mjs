/**
 * Tests for evaluateHardOverrides — the three new SEBI-RA risk-management
 * overrides on top of the existing GSM / earnings-decline / fragile-balance /
 * narrative-flag rules.
 *
 *   Override A — single-stock concentration cap (pw>25 or pw>35)
 *   Override B — severe FV downside (upside ≤ -45 OR upside ≤ -30 + snow ≤ 14)
 *   Override C — multi-signal weakness stack (any 2 of {snow ≤ 12,
 *                upside ≤ -20, pnl < -15, sector_weight > 30})
 *
 * Plus regression coverage for the existing overrides (GSM, earnings
 * declining < -10%, fragile balance + extreme PE) so the refactor of
 * first-match-wins → collect-all-reasons doesn't regress them.
 *
 * Run with: node test/hardOverrides.test.mjs
 */

import { evaluateHardOverrides } from "../services/swsHoldingEngine.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, "→ got", JSON.stringify(got)); }
}

// Helper to build a minimal "scored" object the override reads from.
function scoredOf({ snowfin = 5, snowfut = 5, snowpast = 5, snowval = 5, snowdiv = 5, surveillance = null, pe = null, risksList = [] }) {
  return {
    v2_breakdown: { surveillance },
    overview: {
      multiples: { pe },
      risks: risksList,
    },
  };
}
function snowOf({ fin = 5, fut = 5, past = 5, val = 5, div = 5 }) {
  return { financial_health: fin, future_growth: fut, past_performance: past, valuation: val, dividends: div, total: fin + fut + past + val + div };
}

// ─── Override A: concentration cap ────────────────────────────────
console.log("\nOverride A — single-stock concentration cap\n");

{
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: 5 }, snow: snowOf({}), fiscal: {},
    position_weight: 27, sector_weight: 10, upside: 5,
  });
  assert("pw=27 → fires Reduction-50% legacy", r?.action === "Reduction-50%", r);
  assert("pw=27 reason mentions 25% threshold", /25% concentration threshold/.test(r?.reasons?.[0] || ""), r?.reasons);
}
{
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: 5 }, snow: snowOf({}), fiscal: {},
    position_weight: 37, sector_weight: 10, upside: 5,
  });
  assert("pw=37 → fires Reduction-50% legacy (severity escalator promotes to Red-66%)", r?.action === "Reduction-50%", r);
  assert("pw=37 reason mentions 35% cap", /35% concentration cap/.test(r?.reasons?.[0] || ""), r?.reasons);
}
{
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: 5 }, snow: snowOf({}), fiscal: {},
    position_weight: 24, sector_weight: 10, upside: 5,
  });
  assert("pw=24 (below 25% threshold) → no concentration override", r === null, r);
}

// ─── Override B: severe FV downside ───────────────────────────────
console.log("\nOverride B — severe FV downside\n");

{
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: 0 }, snow: snowOf({}), fiscal: {},
    position_weight: 5, sector_weight: 10, upside: -46,
  });
  assert("upside=-46 alone → Reduction-50%", r?.action === "Reduction-50%", r);
  assert("upside=-46 reason mentions extreme overvaluation", /extreme overvaluation/.test((r?.reasons || []).join(" ")), r?.reasons);
}
{
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: 0 },
    snow: snowOf({ fin: 2, fut: 2, past: 3, val: 2, div: 2 }), // total = 11, weak
    fiscal: {},
    position_weight: 5, sector_weight: 10, upside: -32,
  });
  assert("upside=-32 + snow=11 → Reduction-50%", r?.action === "Reduction-50%", r);
  assert("upside=-32 reason mentions thin fundamental support", /thin fundamental support/.test((r?.reasons || []).join(" ")), r?.reasons);
}
{
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: 0 },
    snow: snowOf({}),  // total = 25, healthy
    fiscal: {},
    position_weight: 5, sector_weight: 10, upside: -32,
  });
  assert("upside=-32 + snow=25 (healthy) → no FV override", r === null, r);
}
{
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: 0 },
    snow: snowOf({}), fiscal: {},
    position_weight: 5, sector_weight: 10, upside: -25,
  });
  assert("upside=-25 (above -30 threshold) alone → no FV override", r === null, r);
}

// ─── Override C: 2-of-4 multi-signal stack ────────────────────────
console.log("\nOverride C — 2-of-4 multi-signal weakness stack\n");

{
  // 1 signal — snow weak only — should NOT fire
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: 0 },
    snow: snowOf({ fin: 2, fut: 2, past: 2, val: 2, div: 2 }),  // total = 10
    fiscal: {},
    position_weight: 5, sector_weight: 10, upside: 5,
  });
  assert("only 1 signal (snow=10) → no multi-signal fire", r === null, r);
}
{
  // 2 signals — snow weak + drawdown
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: -16 },
    snow: snowOf({ fin: 2, fut: 2, past: 2, val: 2, div: 2 }),  // total = 10
    fiscal: {},
    position_weight: 5, sector_weight: 10, upside: 0,
  });
  assert("2 signals (snow=10, pnl=-16) → fires Reduction-50%", r?.action === "Reduction-50%", r);
  assert("2-signal rationale lists both signals", /Snowflake.*drawdown|drawdown.*Snowflake/.test((r?.reasons || []).join(" ")), r?.reasons);
}
{
  // 3 signals — snow weak + drawdown + overvalued (the IRFC-class pattern)
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: -16 },
    snow: snowOf({ fin: 2, fut: 2, past: 3, val: 2, div: 2 }),  // total = 11
    fiscal: {},
    position_weight: 5, sector_weight: 10, upside: -25,
  });
  assert("3 signals (snow + pnl + upside) → fires", r?.action === "Reduction-50%", r);
  assert("rationale notes 3 of 4 firing", /3 of 4/.test((r?.reasons || []).join(" ")), r?.reasons);
}
{
  // Sector overweight + upside-overvalued (no pnl/snow signal)
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: 5 },
    snow: snowOf({}),  // healthy
    fiscal: {},
    position_weight: 5, sector_weight: 35, upside: -22,
  });
  assert("2 signals (sector + upside) → fires", r?.action === "Reduction-50%", r);
}

// ─── Replacement-rule regression — old 3-stacked still caught ─────
console.log("\nReplacement-rule regression — old narrow rule's cases\n");

{
  // The old rule: pnl<-20 + snow≤12 + (fwdGrowth≤1 OR null)
  // New 2-of-4 should still catch this since pnl<-20 implies pnl<-15
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: -25 },
    snow: snowOf({ fin: 2, fut: 2, past: 3, val: 2, div: 2 }),  // total = 11
    fiscal: { earnings_growth_pct: 0 },
    position_weight: 5, sector_weight: 10, upside: 5,
  });
  assert("old-rule case (pnl=-25 + snow=11) caught by new 2-of-4", r?.action === "Reduction-50%", r);
}

// ─── GSM still trumps everything (regression) ─────────────────────
console.log("\nExisting overrides — regression\n");

{
  const r = evaluateHardOverrides({
    scored: scoredOf({ surveillance: { list: "GSM", stage: 3, timeframe: "Stage III" } }),
    holding: { pnlPercent: 0 },
    snow: snowOf({}), fiscal: {},
    position_weight: 5, sector_weight: 10, upside: 5,
  });
  assert("GSM still emits EXIT (not Reduction)", r?.action === "EXIT", r);
}

// ─── Earnings-declining override preserved ────────────────────────
{
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: 0 },
    snow: snowOf({}), fiscal: { earnings_growth_pct: -15 },
    position_weight: 5, sector_weight: 10, upside: 5,
  });
  assert("earnings declining -15% → fires Reduction-50%", r?.action === "Reduction-50%", r);
  assert("earnings reason mentions YoY decline", /declining.*YoY/.test((r?.reasons || []).join(" ")), r?.reasons);
}

// ─── Fragile balance + extreme PE preserved ───────────────────────
{
  const r = evaluateHardOverrides({
    scored: scoredOf({ pe: 150 }),
    holding: { pnlPercent: 0 },
    snow: snowOf({ fin: 1, fut: 4, past: 3, val: 4, div: 2 }),  // health=1
    fiscal: {},
    position_weight: 5, sector_weight: 10, upside: 5,
  });
  assert("fragile balance + extreme PE → fires Reduction-50%", r?.action === "Reduction-50%", r);
  assert("fragile-balance reason mentions Health and P/E", /Fragile balance.*P\/E/.test((r?.reasons || []).join(" ")), r?.reasons);
}

// ─── Multi-override stack (IRFC-style: 3 overrides fire together) ─
console.log("\nIRFC-class case — concentration + FV downside + multi-signal all fire\n");

{
  const r = evaluateHardOverrides({
    scored: scoredOf({}),
    holding: { pnlPercent: 7 }, // slightly profitable
    snow: snowOf({ fin: 2, fut: 2, past: 3, val: 2, div: 2 }),  // total = 11
    fiscal: { earnings_growth_pct: 8 },
    position_weight: 42.4,
    sector_weight: 47,
    upside: -40,
  });
  assert("IRFC profile → returns Reduction-50% (severity will promote to Red-66%)", r?.action === "Reduction-50%", r);
  assert("IRFC reasons list ≥ 3 firing overrides", (r?.reasons || []).length >= 3, r?.reasons);
  assert("IRFC reasons include concentration mention", /35%.*concentration|25%.*concentration/.test((r?.reasons || []).join(" ")), r?.reasons);
  assert("IRFC reasons include FV-downside mention", /AnalystConsensus FV/.test((r?.reasons || []).join(" ")), r?.reasons);
  assert("IRFC reasons include multi-signal mention", /Multi-signal weakness/.test((r?.reasons || []).join(" ")), r?.reasons);
}

// ─── Healthy compounder gets no override (false-positive guard) ───
console.log("\nFalse-positive guard — healthy compounder stays HOLD\n");

{
  const r = evaluateHardOverrides({
    scored: scoredOf({}),
    holding: { pnlPercent: 25 },
    snow: snowOf({ fin: 6, fut: 6, past: 6, val: 4, div: 4 }),  // total = 26
    fiscal: { earnings_growth_pct: 18 },
    position_weight: 8,
    sector_weight: 18,
    upside: 8,
  });
  assert("healthy compounder → no override fires", r === null, r);
}

// ─── No upside data (null-safe) ───────────────────────────────────
{
  const r = evaluateHardOverrides({
    scored: scoredOf({}), holding: { pnlPercent: 5 },
    snow: snowOf({}), fiscal: {},
    position_weight: 5, sector_weight: 10, upside: null,
  });
  assert("upside=null → no FV override (graceful)", r === null, r);
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
if (fail > 0) process.exit(1);
