/**
 * V4 severity-model tests for services/actionLadder.js
 *
 * Validates the Phase-1 XIRR-optimisation overlay:
 *   • pillarWeaknessRaw — worst-pillar drives, graceful fallback
 *   • recoverableDrawdownRaw — 52W proxy dampens capitulation
 *   • computeTrimSeverityV4 — full V4 severity stack
 *   • applySettlePeriodGate, applyPositionFloorGate
 *   • promoteToLadderV2 with SWS_LADDER_V4=1 — end-to-end calibration anchors
 *
 * Run with: node test/actionLadder.v4.test.mjs
 */

import {
  pillarWeaknessRaw,
  recoverableDrawdownRaw,
  computeTrimSeverityV4,
  applySettlePeriodGate,
  applyPositionFloorGate,
  promoteToLadderV2,
  isLadderV4Enabled,
} from "../services/actionLadder.js";

const SAVED_V4 = process.env.SWS_LADDER_V4;
const SAVED_V3 = process.env.SWS_LADDER_V3;
const SAVED_V2 = process.env.SWS_LADDER_V2;
function withV4(fn) {
  process.env.SWS_LADDER_V4 = "1";
  process.env.SWS_LADDER_V3 = "1";
  process.env.SWS_LADDER_V2 = "1";
  try { fn(); } finally {
    process.env.SWS_LADDER_V4 = SAVED_V4;
    process.env.SWS_LADDER_V3 = SAVED_V3;
    process.env.SWS_LADDER_V2 = SAVED_V2;
  }
}

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, "→ got", got); }
}
function within(name, x, expected, tolerance = 0.05) {
  const ok = Math.abs(x - expected) <= tolerance;
  assert(`${name} (got ${x.toFixed(3)}, want ${expected.toFixed(3)} ± ${tolerance})`, ok, x);
}

console.log("\n══ V4 Severity Model — Phase 1 ══\n");

// ─── pillarWeaknessRaw ─────────────────────────────────────────────
console.log("\npillarWeaknessRaw — pillar-decomposed weakness\n");
{
  // Deep-value compounder: cheap (val=1) but everything else strong
  const deepValue = pillarWeaknessRaw({
    v3: 38,
    pillars: { financial_health: 6, future_growth: 5, past_performance: 4, valuation: 1, dividends: 2 },
  });
  within("deep-value compounder → tiny weakness (no pillar broken)", deepValue, 0.00, 0.05);

  // Structurally weak: Health < 3 + Future < 3 → Health-driven max
  const structurallyWeak = pillarWeaknessRaw({
    v3: 38,
    pillars: { financial_health: 2, future_growth: 2, past_performance: 4, valuation: 4, dividends: 1 },
  });
  // health=2 → (3-2)/3 = 0.33, weighted 0.40 → 0.133
  within("structurally weak → Health-driven weakness ~0.13", structurallyWeak, 0.13, 0.03);

  // Expensive growth (val=6, future=2)
  const expensiveFade = pillarWeaknessRaw({
    v3: 38,
    pillars: { financial_health: 5, future_growth: 2, past_performance: 4, valuation: 6, dividends: 0 },
  });
  // future=2 → 0.33×0.30=0.10; val=6 → max(0,2)/2=1 ×0.20=0.20 → max=0.20
  within("expensive fade → Valuation-driven weakness ~0.20", expensiveFade, 0.20, 0.03);

  // Missing pillars → fallback to V3 formula (50-v3)/50
  const fallback = pillarWeaknessRaw({ v3: 30, pillars: null });
  within("missing pillars → V3 fallback (50-30)/50=0.40", fallback, 0.40, 0.01);

  // Bottom-tier broken everything
  const totallyBroken = pillarWeaknessRaw({
    v3: 8,
    pillars: { financial_health: 0, future_growth: 0, past_performance: 0, valuation: 6, dividends: 0 },
  });
  // health=0 → 1.0×0.40=0.40 → max
  within("totally broken → Health saturates at 0.40", totallyBroken, 0.40, 0.01);
}

// ─── recoverableDrawdownRaw ────────────────────────────────────────
console.log("\nrecoverableDrawdownRaw — 52W-proxy capitulation dampening\n");
{
  // No 52W data → V3 fallback −pnl/50
  const noData = recoverableDrawdownRaw({ pnlPercent: -40 });
  within("no 52W data → V3 fallback −(-40)/50=0.80", noData, 0.80, 0.01);

  // At 52W low (no recovery) → full drawdown from peak
  const atLow = recoverableDrawdownRaw({
    pnlPercent: -40, currentPrice: 60, fiftyTwoWeekHigh: 140, fiftyTwoWeekLow: 60,
  });
  // (140-60)/140 = 0.571; recovery = 0; dampening = 1; result = 0.571
  within("at 52W low → full drawdown from peak (no dampening)", atLow, 0.571, 0.02);

  // Bounced 25% off the low → drawdown contribution dampened
  const bounced = recoverableDrawdownRaw({
    pnlPercent: -25, currentPrice: 75, fiftyTwoWeekHigh: 140, fiftyTwoWeekLow: 60,
  });
  // dd = (140-75)/140 = 0.464; recovery = (75-60)/60 = 0.25; dampening = max(0, 1-1.5×0.25) = 0.625
  // → 0.464 × 0.625 = 0.290
  within("bounced 25% off low → drawdown halved", bounced, 0.290, 0.03);

  // Strong recovery (>67% off low) → drawdown zeroed
  const strongRecovery = recoverableDrawdownRaw({
    pnlPercent: -10, currentPrice: 110, fiftyTwoWeekHigh: 140, fiftyTwoWeekLow: 60,
  });
  // recovery = (110-60)/60 = 0.833 → dampening = max(0, 1 - 1.25) = 0 → result 0
  within("strong recovery → drawdown signal zeroed", strongRecovery, 0.00, 0.01);

  // No drawdown at all (price = 52W high)
  const noDrawdown = recoverableDrawdownRaw({
    pnlPercent: 10, currentPrice: 140, fiftyTwoWeekHigh: 140, fiftyTwoWeekLow: 60,
  });
  within("price at 52W high → no drawdown", noDrawdown, 0.00, 0.01);
}

// ─── computeTrimSeverityV4 — Calibration anchors from plan ─────────
console.log("\ncomputeTrimSeverityV4 — calibration anchors\n");
{
  // Anchor 1: Deep-value compounder (HOLD candidate, V3 would emit Reduction-25%)
  const deepValueComp = computeTrimSeverityV4({
    v3: 38,
    pillars: { financial_health: 6, future_growth: 5, past_performance: 4, valuation: 1, dividends: 2 },
    position_weight: 4, sector_weight: 15, conviction: "MEDIUM",
    surveillance: null, pnlPercent: -12,
    currentPrice: 100, fiftyTwoWeekHigh: 130, fiftyTwoWeekLow: 80,
    risks_count: 0,
  });
  assert(`deep-value compounder severity ≤ 0.20 (HOLD-ish)`, deepValueComp.severity <= 0.20, deepValueComp.severity);

  // Anchor 2: Structurally weak (same v3, opposite pillars → escalates)
  const struct = computeTrimSeverityV4({
    v3: 38,
    pillars: { financial_health: 2, future_growth: 2, past_performance: 4, valuation: 4, dividends: 1 },
    position_weight: 4, sector_weight: 15, conviction: "MEDIUM",
    surveillance: null, pnlPercent: -12,
    currentPrice: 100, fiftyTwoWeekHigh: 130, fiftyTwoWeekLow: 80,
    risks_count: 0,
  });
  assert(`structurally weak severity > deep-value (separation works)`,
    struct.severity > deepValueComp.severity, { struct: struct.severity, deepValue: deepValueComp.severity });

  // Anchor 3: Capitulation rebound — V3 would say Reduction-66%, V4 milder
  const capRebound = computeTrimSeverityV4({
    v3: 20,
    pillars: { financial_health: 4, future_growth: 3, past_performance: 2, valuation: 2, dividends: 2 },
    position_weight: 5, sector_weight: 18, conviction: "MEDIUM",
    surveillance: null, pnlPercent: -40,
    currentPrice: 85, fiftyTwoWeekHigh: 140, fiftyTwoWeekLow: 60,
    risks_count: 1,
  });
  assert(`capitulation rebound severity < 0.65 (V3 would over-trim)`,
    capRebound.severity < 0.65, capRebound.severity);

  // Hard floor: v3 < 14 still forces severity ≥ 0.75
  const bottomTier = computeTrimSeverityV4({
    v3: 12, pillars: { financial_health: 4, future_growth: 4, past_performance: 4, valuation: 4, dividends: 4 },
    position_weight: 3, sector_weight: 10, conviction: "HIGH",
    surveillance: null, pnlPercent: 0,
    currentPrice: 100, fiftyTwoWeekHigh: 110, fiftyTwoWeekLow: 90,
    risks_count: 0,
  });
  assert(`v3<14 hard floor preserved (severity ≥ 0.75)`, bottomTier.severity >= 0.75, bottomTier.severity);

  // Concentration escalator preserved (pw>30 → severity ≥ 0.55 under
  // aggressive-trim recalibration, was 0.60). The floor still maps to
  // Red-66% via severityToTrimRung (0.50 ≤ s < 0.65 → Red-66%).
  const concentrated = computeTrimSeverityV4({
    v3: 70, pillars: { financial_health: 6, future_growth: 6, past_performance: 6, valuation: 4, dividends: 3 },
    position_weight: 35, sector_weight: 30, conviction: "HIGH",
    surveillance: null, pnlPercent: 50,
    currentPrice: 200, fiftyTwoWeekHigh: 220, fiftyTwoWeekLow: 100,
    risks_count: 0,
  });
  assert(`pw>30 concentration floor preserved (severity ≥ 0.55)`, concentrated.severity >= 0.55, concentrated.severity);
}

// ─── applySettlePeriodGate ─────────────────────────────────────────
console.log("\napplySettlePeriodGate — held<60d caps trim severity\n");
{
  // Inside settle window with mid-tier severity → cap just under Red-33%
  // threshold (0.22 under aggressive-trim recalibration). Resulting severity
  // 0.21 lands at Red-25% rung — softest possible trim during settle window.
  const settled = applySettlePeriodGate({
    severity: 0.55, daysHeld: 28, surveillance: null, materialDisclosure: false, gsmStage3Plus: false,
  });
  assert(`held 28d, severity 0.55 → capped to 0.21 (max Red-25%)`, settled.severity === 0.21 && settled.fired, settled);

  // Outside settle window → no-op
  const beyondWindow = applySettlePeriodGate({
    severity: 0.55, daysHeld: 90, surveillance: null, materialDisclosure: false, gsmStage3Plus: false,
  });
  assert(`held 90d → gate inactive (severity unchanged)`, beyondWindow.severity === 0.55 && !beyondWindow.fired, beyondWindow);

  // Inside window but severity already low → no-op (no cap needed). 0.20
  // is below the 0.22 Red-33% threshold so it already maps to Red-25%.
  const lowSeverity = applySettlePeriodGate({
    severity: 0.20, daysHeld: 30, surveillance: null, materialDisclosure: false, gsmStage3Plus: false,
  });
  assert(`held 30d, severity 0.20 → no cap needed`, lowSeverity.severity === 0.20 && !lowSeverity.fired, lowSeverity);

  // Inside window but severity is hard EXIT-tier → bypass. New EXIT-staged
  // threshold is 0.65 so 0.85 still bypasses comfortably (it's EXIT-now).
  const hardExit = applySettlePeriodGate({
    severity: 0.85, daysHeld: 30, surveillance: null, materialDisclosure: false, gsmStage3Plus: false,
  });
  assert(`held 30d, severity 0.85 (EXIT-tier) → bypass cap`, hardExit.severity === 0.85 && !hardExit.fired, hardExit);

  // Material disclosure → bypass cap
  const matDisclosure = applySettlePeriodGate({
    severity: 0.55, daysHeld: 30, surveillance: null, materialDisclosure: true, gsmStage3Plus: false,
  });
  assert(`held 30d + material disclosure → bypass cap`, matDisclosure.severity === 0.55 && !matDisclosure.fired, matDisclosure);

  // GSM-3+ → bypass cap
  const gsm = applySettlePeriodGate({
    severity: 0.55, daysHeld: 30, surveillance: { list: "GSM", stage: 3 }, materialDisclosure: false, gsmStage3Plus: true,
  });
  assert(`held 30d + GSM-3 → bypass cap`, gsm.severity === 0.55 && !gsm.fired, gsm);

  // Null daysHeld (no purchase date) → no-op
  const nullDays = applySettlePeriodGate({
    severity: 0.55, daysHeld: null, surveillance: null, materialDisclosure: false, gsmStage3Plus: false,
  });
  assert(`daysHeld=null → gate inactive`, nullDays.severity === 0.55 && !nullDays.fired, nullDays);
}

// ─── applyPositionFloorGate ────────────────────────────────────────
console.log("\napplyPositionFloorGate — small-position execution-cost gate\n");
{
  // Small position + severe → EXIT-now
  const smallSevere = applyPositionFloorGate({
    rung: "Reduction-50%", severity: 0.80, positionWeight: 1.5, currentValue: 30000,
  });
  assert(`pw 1.5% + sev 0.80 → EXIT-now (clean close)`, smallSevere.rung === "EXIT-now" && smallSevere.fired, smallSevere);

  // Small position + mild → HOLD
  const smallMild = applyPositionFloorGate({
    rung: "Reduction-25%", severity: 0.20, positionWeight: 1.5, currentValue: 30000,
  });
  assert(`pw 1.5% + sev 0.20 → null (HOLD)`, smallMild.rung === null && smallMild.fired, smallMild);

  // Normal position → no-op
  const normalPos = applyPositionFloorGate({
    rung: "Reduction-33%", severity: 0.32, positionWeight: 5.0, currentValue: 100000,
  });
  assert(`pw 5.0% → gate inactive`, normalPos.rung === "Reduction-33%" && !normalPos.fired, normalPos);

  // Top-up below ₹25k floor → promote to next rung
  const tinyTopUp = applyPositionFloorGate({
    rung: "Top-up-25%", severity: 0.30, positionWeight: 3.0, currentValue: 60000, ideal_add_rupees: 60000,
  });
  // 60000 × 0.25 = 15000 < 25000 → try 33%: 60000×0.33=19800 < 25000 → 50%: 30000 ≥ 25000 → upgrade
  assert(`Top-up-25% on ₹60k base → promotes to ≥50%`, tinyTopUp.rung === "Top-up-50%" && tinyTopUp.fired, tinyTopUp);

  // Top-up above floor → no-op
  const goodTopUp = applyPositionFloorGate({
    rung: "Top-up-50%", severity: 0.55, positionWeight: 4.0, currentValue: 200000, ideal_add_rupees: 200000,
  });
  assert(`Top-up-50% on ₹200k base → gate inactive`, goodTopUp.rung === "Top-up-50%" && !goodTopUp.fired, goodTopUp);
}

// ─── promoteToLadderV2 with V4 — end-to-end calibration ────────────
console.log("\npromoteToLadderV2 with SWS_LADDER_V4=1 — end-to-end\n");
withV4(() => {
  assert(`V4 flag is on`, isLadderV4Enabled() === true, isLadderV4Enabled());

  // Anchor 1: deep-value compounder produces less-aggressive trim than V3
  const deepValueOut = promoteToLadderV2({
    legacyAction: "Reduction-25-33%",
    v3: 38, snow_total: 18,
    pillars: { financial_health: 6, future_growth: 5, past_performance: 4, valuation: 1, dividends: 2 },
    position_weight: 4, sector_weight: 15, upside: 25, risks_count: 0,
    surveillance: null, pnlPercent: -12,
    currentPrice: 100, fiftyTwoWeekHigh: 130, fiftyTwoWeekLow: 80, currentValue: 80000,
    daysHeld: 200, lastAction: null,
  });
  assert(`deep-value: severityModel="v4"`, deepValueOut.severityModel === "v4", deepValueOut.severityModel);
  assert(`deep-value: action HOLD or Reduction-25%`,
    deepValueOut.action === "HOLD" || deepValueOut.action === "Reduction-25%", deepValueOut.action);

  // Anchor 2: structurally weak escalates beyond deep-value
  const structOut = promoteToLadderV2({
    legacyAction: "Reduction-25-33%",
    v3: 38, snow_total: 13,
    pillars: { financial_health: 2, future_growth: 2, past_performance: 4, valuation: 4, dividends: 1 },
    position_weight: 4, sector_weight: 15, upside: 5, risks_count: 1,
    surveillance: null, pnlPercent: -12,
    currentPrice: 100, fiftyTwoWeekHigh: 130, fiftyTwoWeekLow: 80, currentValue: 80000,
    daysHeld: 200, lastAction: null,
  });
  assert(`structurally-weak severity > deep-value severity (V4 differentiates)`,
    structOut.severity > deepValueOut.severity, { struct: structOut.severity, deepValue: deepValueOut.severity });

  // Anchor 3: settle-period gate caps a fresh position
  const fresh = promoteToLadderV2({
    legacyAction: "Reduction-50%",
    v3: 18, snow_total: 10,
    pillars: { financial_health: 3, future_growth: 2, past_performance: 2, valuation: 3, dividends: 2 },
    position_weight: 6, sector_weight: 20, upside: 0, risks_count: 1,
    surveillance: null, pnlPercent: -8,
    currentPrice: 95, fiftyTwoWeekHigh: 110, fiftyTwoWeekLow: 80, currentValue: 60000,
    daysHeld: 28, lastAction: null,
  });
  assert(`fresh position (28d) → settle gate caps to ≤ Reduction-25%`,
    fresh.action === "Reduction-25%" || fresh.action === "HOLD", fresh.action);
  const settleNote = (fresh.ladderRationale || []).join("\n");
  assert(`fresh position rationale mentions Settle-period`, /Settle-period/i.test(settleNote), settleNote.slice(0, 200));

  // Anchor 5: position-floor collapses small actions
  const tiny = promoteToLadderV2({
    legacyAction: "Reduction-25-33%",
    v3: 25, snow_total: 12,
    pillars: { financial_health: 3, future_growth: 3, past_performance: 3, valuation: 3, dividends: 2 },
    position_weight: 1.5, sector_weight: 8, upside: 5, risks_count: 1,
    surveillance: null, pnlPercent: -15,
    currentPrice: 90, fiftyTwoWeekHigh: 130, fiftyTwoWeekLow: 80, currentValue: 30000,
    daysHeld: 200, lastAction: null,
  });
  assert(`tiny position (1.5%) with mild trim → HOLD (not noise)`, tiny.action === "HOLD", tiny.action);

  // Anchor 6: V4 OFF → V3 path takes over (guard against dispatch break)
  process.env.SWS_LADDER_V4 = "0";
  const v3Default = promoteToLadderV2({
    legacyAction: "Reduction-25-33%",
    v3: 38, snow_total: 18,
    pillars: { financial_health: 6, future_growth: 5, past_performance: 4, valuation: 1, dividends: 2 },
    position_weight: 4, sector_weight: 15, upside: 25, risks_count: 0,
    surveillance: null, pnlPercent: -12,
  });
  assert(`V4 off → severityModel undefined (V3 path)`, v3Default.severityModel === undefined, v3Default.severityModel);
  process.env.SWS_LADDER_V4 = "1"; // restore for the rest of the block
});

console.log(`\n${pass} passed, ${fail} failed.\n`);
if (fail > 0) process.exit(1);
