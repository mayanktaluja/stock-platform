/**
 * Regression tests for services/actionLadder.js.
 *
 * Covers:
 *   • parseTrimPct + parseTopUpPct round-trip for every label (legacy + v2)
 *   • ladderToLegacy mapping table
 *   • deriveConvictionProxy bands (HIGH / MEDIUM-HIGH / MEDIUM / MEDIUM-LOW / LOW)
 *   • pickTrimRung — every matrix row that should fire
 *   • pickTopUpRung — every matrix row that should fire
 *   • Surveillance escalation (GSM-3+ → EXIT-now overrides v3 score band)
 *   • EXIT-staged firing for v3 8-14 with no severe surveillance
 *
 * Run with: node test/actionLadder.test.mjs
 */

import {
  parseTrimPct,
  parseTopUpPct,
  ladderToLegacy,
  deriveConvictionProxy,
  pickTrimRung,
  pickTopUpRung,
  promoteToLadderV2,
  computeTrimSeverity,
  computeTopUpSeverity,
  severityToTrimRung,
  severityToTopUpRung,
  ALL_REDUCTION_ACTIONS,
  ALL_TOPUP_ACTIONS,
  LEGACY_REDUCTION_ACTIONS,
  LEGACY_TOPUP_ACTIONS,
  LADDER_V2_REDUCTION_ACTIONS,
  LADDER_V2_TOPUP_ACTIONS,
} from "../services/actionLadder.js";

// promoteToLadderV2 is gated by SWS_LADDER_V2=1. The block below tests the
// V2 categorical matrix specifically, so we force V3 OFF inside the wrapper
// — V3 became default-on (2026-05-06) and otherwise takes precedence.
const SAVED_FLAG = process.env.SWS_LADDER_V2;
const SAVED_V3_PRE = process.env.SWS_LADDER_V3;
function withFlagOn(fn) {
  process.env.SWS_LADDER_V2 = "1";
  process.env.SWS_LADDER_V3 = "0";
  try { fn(); } finally {
    process.env.SWS_LADDER_V2 = SAVED_FLAG;
    process.env.SWS_LADDER_V3 = SAVED_V3_PRE;
  }
}

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

// ──────────────────── parseTrimPct ────────────────────

console.log("\nparseTrimPct\n");
assert("EXIT → 1.0",            parseTrimPct("EXIT") === 1.0, parseTrimPct("EXIT"));
assert("EXIT-now → 1.0",        parseTrimPct("EXIT-now") === 1.0, parseTrimPct("EXIT-now"));
assert("EXIT-staged → 0.5",     parseTrimPct("EXIT-staged") === 0.5, parseTrimPct("EXIT-staged"));
assert("Reduction-66% → 0.66",  parseTrimPct("Reduction-66%") === 0.66, parseTrimPct("Reduction-66%"));
assert("Reduction-50% → 0.50",  parseTrimPct("Reduction-50%") === 0.5, parseTrimPct("Reduction-50%"));
assert("Reduction-33% → 0.33",  parseTrimPct("Reduction-33%") === 0.33, parseTrimPct("Reduction-33%"));
assert("Reduction-25% → 0.25",  parseTrimPct("Reduction-25%") === 0.25, parseTrimPct("Reduction-25%"));
assert("Reduction-25-33% → 0.30 (legacy mid)", parseTrimPct("Reduction-25-33%") === 0.30, parseTrimPct("Reduction-25-33%"));
assert("HOLD → 0",              parseTrimPct("HOLD") === 0, parseTrimPct("HOLD"));
assert("Top-up-50% → 0",        parseTrimPct("Top-up-50%") === 0, parseTrimPct("Top-up-50%"));
assert("unknown → 0 (fail-soft)", parseTrimPct("FOO") === 0, parseTrimPct("FOO"));
assert("null → 0",              parseTrimPct(null) === 0, parseTrimPct(null));

// ──────────────────── parseTopUpPct ────────────────────

console.log("\nparseTopUpPct\n");
assert("STRONG Top-up → 1.0",   parseTopUpPct("STRONG Top-up") === 1.0, parseTopUpPct("STRONG Top-up"));
assert("Top-up-100% → 1.0",     parseTopUpPct("Top-up-100%") === 1.0, parseTopUpPct("Top-up-100%"));
assert("Top-up → 0.5",          parseTopUpPct("Top-up") === 0.5, parseTopUpPct("Top-up"));
assert("Top-up-50% → 0.5",      parseTopUpPct("Top-up-50%") === 0.5, parseTopUpPct("Top-up-50%"));
assert("Top-up-33% → 0.33",     parseTopUpPct("Top-up-33%") === 0.33, parseTopUpPct("Top-up-33%"));
assert("Top-up-modest → 0.25",  parseTopUpPct("Top-up-modest") === 0.25, parseTopUpPct("Top-up-modest"));
assert("Top-up-25% → 0.25",     parseTopUpPct("Top-up-25%") === 0.25, parseTopUpPct("Top-up-25%"));
assert("HOLD → 0",              parseTopUpPct("HOLD") === 0, parseTopUpPct("HOLD"));
assert("Reduction-50% → 0",     parseTopUpPct("Reduction-50%") === 0, parseTopUpPct("Reduction-50%"));

// ──────────────────── ladderToLegacy ────────────────────

console.log("\nladderToLegacy\n");
assert("EXIT-now → EXIT",            ladderToLegacy("EXIT-now") === "EXIT", ladderToLegacy("EXIT-now"));
assert("EXIT-staged → EXIT",         ladderToLegacy("EXIT-staged") === "EXIT", ladderToLegacy("EXIT-staged"));
assert("Reduction-66% → Reduction-50%", ladderToLegacy("Reduction-66%") === "Reduction-50%", ladderToLegacy("Reduction-66%"));
assert("Reduction-50% → Reduction-50% (passthrough)", ladderToLegacy("Reduction-50%") === "Reduction-50%", ladderToLegacy("Reduction-50%"));
assert("Reduction-33% → Reduction-25-33%", ladderToLegacy("Reduction-33%") === "Reduction-25-33%", ladderToLegacy("Reduction-33%"));
assert("Reduction-25% → Reduction-25-33%", ladderToLegacy("Reduction-25%") === "Reduction-25-33%", ladderToLegacy("Reduction-25%"));
assert("HOLD → HOLD",                ladderToLegacy("HOLD") === "HOLD", ladderToLegacy("HOLD"));
assert("Top-up-25% → Top-up-modest", ladderToLegacy("Top-up-25%") === "Top-up-modest", ladderToLegacy("Top-up-25%"));
assert("Top-up-50% → Top-up",        ladderToLegacy("Top-up-50%") === "Top-up", ladderToLegacy("Top-up-50%"));
assert("Top-up-100% → STRONG Top-up", ladderToLegacy("Top-up-100%") === "STRONG Top-up", ladderToLegacy("Top-up-100%"));
assert("EXIT (legacy) → EXIT (passthrough)", ladderToLegacy("EXIT") === "EXIT", ladderToLegacy("EXIT"));
assert("null → null (no-op)",        ladderToLegacy(null) === null, ladderToLegacy(null));

// ──────────────────── deriveConvictionProxy ────────────────────

console.log("\nderiveConvictionProxy\n");

// HIGH: v3 80, snow 25, no surveillance, 0 risks → score = 80*0.6 + (25/30*100)*0.4 ≈ 48 + 33.3 ≈ 81 → HIGH
assert("v3=80 snow=25 → HIGH",
  deriveConvictionProxy({ v3: 80, snow_total: 25, surveillance: null, risks_count: 0 }) === "HIGH",
  deriveConvictionProxy({ v3: 80, snow_total: 25, surveillance: null, risks_count: 0 }));

// MEDIUM-HIGH: v3 60, snow 18 → 36 + 24 = 60 → MEDIUM-HIGH
assert("v3=60 snow=18 → MEDIUM-HIGH",
  deriveConvictionProxy({ v3: 60, snow_total: 18, surveillance: null, risks_count: 0 }) === "MEDIUM-HIGH",
  deriveConvictionProxy({ v3: 60, snow_total: 18, surveillance: null, risks_count: 0 }));

// MEDIUM: v3 40 snow 12 → 24 + 16 = 40 → MEDIUM
assert("v3=40 snow=12 → MEDIUM",
  deriveConvictionProxy({ v3: 40, snow_total: 12, surveillance: null, risks_count: 0 }) === "MEDIUM",
  deriveConvictionProxy({ v3: 40, snow_total: 12, surveillance: null, risks_count: 0 }));

// MEDIUM-LOW: v3 28 snow 8 → 16.8 + 10.7 = 27.5 → MEDIUM-LOW
assert("v3=28 snow=8 → MEDIUM-LOW",
  deriveConvictionProxy({ v3: 28, snow_total: 8, surveillance: null, risks_count: 0 }) === "MEDIUM-LOW",
  deriveConvictionProxy({ v3: 28, snow_total: 8, surveillance: null, risks_count: 0 }));

// LOW: v3 10 snow 4 → 6 + 5.3 = 11.3 → LOW
assert("v3=10 snow=4 → LOW",
  deriveConvictionProxy({ v3: 10, snow_total: 4, surveillance: null, risks_count: 0 }) === "LOW",
  deriveConvictionProxy({ v3: 10, snow_total: 4, surveillance: null, risks_count: 0 }));

// GSM stage 3 should drop a MEDIUM-HIGH to LOW (penalty 15+9=24, so 60-24=36 → MEDIUM-LOW; with stage 5: 60-30=30 → MEDIUM-LOW)
assert("GSM-3 surveillance penalises conviction",
  deriveConvictionProxy({ v3: 60, snow_total: 18, surveillance: { list: "GSM", stage: 3 }, risks_count: 0 }) === "MEDIUM-LOW",
  deriveConvictionProxy({ v3: 60, snow_total: 18, surveillance: { list: "GSM", stage: 3 }, risks_count: 0 }));

// ASM is lighter (-8): 60-8=52 → MEDIUM
assert("ASM penalises lighter than GSM",
  deriveConvictionProxy({ v3: 60, snow_total: 18, surveillance: { list: "ASM" }, risks_count: 0 }) === "MEDIUM",
  deriveConvictionProxy({ v3: 60, snow_total: 18, surveillance: { list: "ASM" }, risks_count: 0 }));

// Risks count: 60 base - 4 risks * 4 = 60-16=44 → MEDIUM
assert("4 risks penalises 16 points",
  deriveConvictionProxy({ v3: 60, snow_total: 18, surveillance: null, risks_count: 4 }) === "MEDIUM",
  deriveConvictionProxy({ v3: 60, snow_total: 18, surveillance: null, risks_count: 4 }));

// ──────────────────── pickTrimRung ────────────────────

console.log("\npickTrimRung\n");

// EXIT-now: v3 < 8
{
  const r = pickTrimRung({ v3: 5, position_weight: 3, sector_weight: 10, conviction: "LOW", surveillance: null });
  assert("v3=5 → EXIT-now", r?.action === "EXIT-now", r?.action);
  assert("v3=5 rationale references AVOID floor",
    r?.rationale?.some((s) => s.includes("AVOID") || s.includes("exit floor")), r?.rationale);
}

// EXIT-now: GSM-3+ overrides v3 score
{
  const r = pickTrimRung({ v3: 30, position_weight: 3, sector_weight: 10, conviction: "MEDIUM",
    surveillance: { list: "GSM", stage: 4 } });
  assert("v3=30 + GSM-4 → EXIT-now (regulatory override)", r?.action === "EXIT-now", r?.action);
}

// EXIT-staged: v3 8-14 without GSM-3+
{
  const r = pickTrimRung({ v3: 11, position_weight: 5, sector_weight: 15, conviction: "LOW", surveillance: null });
  assert("v3=11 no surveillance → EXIT-staged", r?.action === "EXIT-staged", r?.action);
}

// EXIT-staged with mild ASM
{
  const r = pickTrimRung({ v3: 11, position_weight: 5, sector_weight: 15, conviction: "LOW",
    surveillance: { list: "ASM", stage: 1 } });
  assert("v3=11 + ASM-1 → EXIT-staged (not escalated)", r?.action === "EXIT-staged", r?.action);
}

// Reduction-66%: v3 14-22, weight > 15, conviction LOW
{
  const r = pickTrimRung({ v3: 18, position_weight: 18, sector_weight: 20, conviction: "LOW", surveillance: null });
  assert("v3=18 weight=18 LOW → Reduction-66%", r?.action === "Reduction-66%", r?.action);
}

// Reduction-50%: v3 14-22, weight 10-15 + sector > 25 + LOW/ML
{
  const r = pickTrimRung({ v3: 18, position_weight: 12, sector_weight: 28, conviction: "MEDIUM-LOW", surveillance: null });
  assert("v3=18 weight=12 sector=28 ML → Reduction-50%", r?.action === "Reduction-50%", r?.action);
}

// Reduction-50%: v3 14-22, weight > 15 fallback (not LOW so doesn't hit 66%)
{
  const r = pickTrimRung({ v3: 18, position_weight: 18, sector_weight: 20, conviction: "MEDIUM", surveillance: null });
  assert("v3=18 weight=18 MEDIUM → Reduction-50% (concentration)", r?.action === "Reduction-50%", r?.action);
}

// Reduction-33%: v3 14-22, weight 8-10, MEDIUM
{
  const r = pickTrimRung({ v3: 18, position_weight: 9, sector_weight: 20, conviction: "MEDIUM", surveillance: null });
  assert("v3=18 weight=9 MEDIUM → Reduction-33%", r?.action === "Reduction-33%", r?.action);
}

// Reduction-25%: v3 14-22, weight < 8, sector < 25, conviction M+ no surveillance
{
  const r = pickTrimRung({ v3: 18, position_weight: 5, sector_weight: 18, conviction: "MEDIUM-HIGH", surveillance: null });
  assert("v3=18 weight=5 MH no surv → Reduction-25%", r?.action === "Reduction-25%", r?.action);
}

// Default WATCH-band fallback: v3 14-22 no specific bucket → Reduction-33%
{
  const r = pickTrimRung({ v3: 18, position_weight: 12, sector_weight: 20, conviction: "MEDIUM", surveillance: null });
  assert("v3=18 weight=12 MEDIUM no surv → Reduction-33% (default)", r?.action === "Reduction-33%", r?.action);
}

// Tier 4 — overweight ACCEPTABLE band
{
  const r = pickTrimRung({ v3: 32, position_weight: 18, sector_weight: 20, conviction: "MEDIUM", surveillance: null });
  assert("v3=32 weight=18 → Reduction-25% (overweight)", r?.action === "Reduction-25%", r?.action);
}

// Tier 4 — ASM-2 forces light trim even at v3=30
{
  const r = pickTrimRung({ v3: 30, position_weight: 5, sector_weight: 18, conviction: "MEDIUM",
    surveillance: { list: "ASM", stage: 2 } });
  assert("v3=30 + ASM-2 → Reduction-25% (regulatory caution)", r?.action === "Reduction-25%", r?.action);
}

// No trim fires: v3 ≥ 22 with no overweight + no surveillance escalation
{
  const r = pickTrimRung({ v3: 35, position_weight: 5, sector_weight: 18, conviction: "MEDIUM", surveillance: null });
  assert("v3=35 weight=5 no surv → null (no trim)", r === null, r);
}

// ──────────────────── pickTopUpRung ────────────────────

console.log("\npickTopUpRung\n");

// Top-up-100%: TOP_PICK + maximal room + clean risk
{
  const r = pickTopUpRung({ v3: 70, position_weight: 3, sector_weight: 15, upside: 20, risks_count: 0 });
  assert("v3=70 weight=3 sector=15 up=20 risks=0 → Top-up-100%",
    r?.action === "Top-up-100%", r?.action);
}

// Top-up-50%: TOP_PICK with moderate room
{
  const r = pickTopUpRung({ v3: 70, position_weight: 7, sector_weight: 22, upside: 12, risks_count: 1 });
  assert("v3=70 weight=7 → Top-up-50%", r?.action === "Top-up-50%", r?.action);
}

// Top-up-25% (TOP_PICK constrained): weight too high for 100/50 buckets
{
  const r = pickTopUpRung({ v3: 70, position_weight: 12, sector_weight: 30, upside: 5, risks_count: 2 });
  assert("v3=70 constrained → Top-up-25%", r?.action === "Top-up-25%", r?.action);
}

// Top-up-50% in STRONG band
{
  const r = pickTopUpRung({ v3: 55, position_weight: 4, sector_weight: 18, upside: 18, risks_count: 0 });
  assert("v3=55 ample room high upside → Top-up-50%", r?.action === "Top-up-50%", r?.action);
}

// Top-up-33% in STRONG band
{
  const r = pickTopUpRung({ v3: 55, position_weight: 7, sector_weight: 22, upside: 8, risks_count: 1 });
  assert("v3=55 moderate room → Top-up-33%", r?.action === "Top-up-33%", r?.action);
}

// Top-up-25% in STRONG band (thin upside)
{
  const r = pickTopUpRung({ v3: 55, position_weight: 9, sector_weight: 28, upside: 3, risks_count: 2 });
  assert("v3=55 thin → Top-up-25% (STRONG-band fallback)", r?.action === "Top-up-25%", r?.action);
}

// Top-up-25% in ACCEPTABLE-PLUS
{
  const r = pickTopUpRung({ v3: 45, position_weight: 6, sector_weight: 20, upside: 8, risks_count: 1 });
  assert("v3=45 + room + upside → Top-up-25% (ACCEPTABLE-PLUS)",
    r?.action === "Top-up-25%", r?.action);
}

// No top-up fires: v3 ≥ 40 but no room
{
  const r = pickTopUpRung({ v3: 45, position_weight: 12, sector_weight: 30, upside: 3, risks_count: 0 });
  assert("v3=45 too constrained → null (no top-up)", r === null, r);
}

// No top-up fires: v3 < 40
{
  const r = pickTopUpRung({ v3: 35, position_weight: 5, sector_weight: 18, upside: 10, risks_count: 0 });
  assert("v3=35 → null (HOLD band)", r === null, r);
}

// ──────────────────── promoteToLadderV2 ────────────────────

console.log("\npromoteToLadderV2 (flag off)\n");
{
  // Both flags must be explicitly "0" to disable — V2 and V3 are default-on
  // (2026-05-06). Force off here so the no-op assertion still holds.
  const SAVED_V2 = process.env.SWS_LADDER_V2;
  const SAVED_V3 = process.env.SWS_LADDER_V3;
  process.env.SWS_LADDER_V2 = "0";
  process.env.SWS_LADDER_V3 = "0";
  try {
    const r = promoteToLadderV2({
      legacyAction: "Reduction-50%", v3: 18, snow_total: 8,
      position_weight: 18, sector_weight: 20, upside: -10, risks_count: 2,
      surveillance: null, pnlPercent: -25,
    });
    assert("flag off → no-op promotion", r.action === "Reduction-50%" && r.ladderV2 === false, r);
  } finally {
    process.env.SWS_LADDER_V2 = SAVED_V2;
    process.env.SWS_LADDER_V3 = SAVED_V3;
  }
}

console.log("\npromoteToLadderV2 (flag on)\n");
withFlagOn(() => {
  // EXIT branch — GSM-3+ → EXIT-now
  {
    const r = promoteToLadderV2({
      legacyAction: "EXIT", v3: 30, snow_total: 14,
      position_weight: 5, sector_weight: 12, upside: -20, risks_count: 0,
      surveillance: { list: "GSM", stage: 4 }, pnlPercent: -10,
    });
    assert("EXIT + GSM-4 → EXIT-now", r.action === "EXIT-now", r.action);
  }
  // EXIT branch — pnl -50% → EXIT-now
  {
    const r = promoteToLadderV2({
      legacyAction: "EXIT", v3: 25, snow_total: 12,
      position_weight: 4, sector_weight: 18, upside: -10, risks_count: 1,
      surveillance: null, pnlPercent: -55,
    });
    assert("EXIT + drawdown -55% → EXIT-now", r.action === "EXIT-now", r.action);
  }
  // EXIT branch — v3 6 → EXIT-now (bottom-tier)
  {
    const r = promoteToLadderV2({
      legacyAction: "EXIT", v3: 6, snow_total: 5,
      position_weight: 4, sector_weight: 18, upside: -30, risks_count: 0,
      surveillance: null, pnlPercent: -20,
    });
    assert("EXIT + v3=6 → EXIT-now", r.action === "EXIT-now", r.action);
  }
  // EXIT branch — moderate, no triggers → EXIT-staged
  {
    const r = promoteToLadderV2({
      legacyAction: "EXIT", v3: 13, snow_total: 9,
      position_weight: 3, sector_weight: 12, upside: -8, risks_count: 0,
      surveillance: null, pnlPercent: -15,
    });
    assert("EXIT + moderate factors → EXIT-staged", r.action === "EXIT-staged", r.action);
  }

  // Reduction-50% branch — overweight + LOW conviction → Reduction-66%
  {
    const r = promoteToLadderV2({
      legacyAction: "Reduction-50%", v3: 12, snow_total: 6,
      position_weight: 18, sector_weight: 22, upside: -5, risks_count: 3,
      surveillance: null, pnlPercent: -15,
    });
    assert("Reduction-50% + weight 18% + LOW conv → Reduction-66%", r.action === "Reduction-66%", r.action);
  }
  // Reduction-50% branch — weight 9% → Reduction-33%
  {
    const r = promoteToLadderV2({
      legacyAction: "Reduction-50%", v3: 35, snow_total: 14,
      position_weight: 9, sector_weight: 18, upside: 0, risks_count: 1,
      surveillance: null, pnlPercent: -8,
    });
    assert("Reduction-50% + weight 9% → Reduction-33%", r.action === "Reduction-33%", r.action);
  }
  // Reduction-50% branch — weight 4% + MEDIUM-HIGH conv + no surveillance → Reduction-25%
  {
    const r = promoteToLadderV2({
      legacyAction: "Reduction-50%", v3: 50, snow_total: 18,
      position_weight: 4, sector_weight: 16, upside: 5, risks_count: 0,
      surveillance: null, pnlPercent: -3,
    });
    assert("Reduction-50% + weight 4% + MEDIUM-HIGH → Reduction-25%", r.action === "Reduction-25%", r.action);
  }

  // Reduction-25-33% branch — weight 9% + MEDIUM-LOW → Reduction-33%
  {
    const r = promoteToLadderV2({
      legacyAction: "Reduction-25-33%", v3: 22, snow_total: 9,
      position_weight: 9, sector_weight: 18, upside: 0, risks_count: 1,
      surveillance: null, pnlPercent: -8,
    });
    assert("Reduction-25-33% + weight 9% → Reduction-33%", r.action === "Reduction-33%", r.action);
  }
  // Reduction-25-33% branch — weight 4% + MEDIUM → Reduction-25%
  {
    const r = promoteToLadderV2({
      legacyAction: "Reduction-25-33%", v3: 38, snow_total: 14,
      position_weight: 4, sector_weight: 16, upside: 0, risks_count: 0,
      surveillance: null, pnlPercent: -3,
    });
    assert("Reduction-25-33% + weight 4% MEDIUM → Reduction-25%", r.action === "Reduction-25%", r.action);
  }

  // STRONG Top-up branch — full constraints → Top-up-100%
  {
    const r = promoteToLadderV2({
      legacyAction: "STRONG Top-up", v3: 70, snow_total: 24,
      position_weight: 3, sector_weight: 15, upside: 25, risks_count: 0,
      surveillance: null, pnlPercent: 5,
    });
    assert("STRONG Top-up + full constraints → Top-up-100%", r.action === "Top-up-100%", r.action);
  }
  // STRONG Top-up branch — moderate room → Top-up-50%
  {
    const r = promoteToLadderV2({
      legacyAction: "STRONG Top-up", v3: 70, snow_total: 22,
      position_weight: 7, sector_weight: 22, upside: 12, risks_count: 1,
      surveillance: null, pnlPercent: 5,
    });
    assert("STRONG Top-up + moderate room → Top-up-50%", r.action === "Top-up-50%", r.action);
  }

  // Top-up branch — full constraints → Top-up-50%
  {
    const r = promoteToLadderV2({
      legacyAction: "Top-up", v3: 60, snow_total: 19,
      position_weight: 4, sector_weight: 18, upside: 18, risks_count: 0,
      surveillance: null, pnlPercent: 5,
    });
    assert("Top-up + full constraints → Top-up-50%", r.action === "Top-up-50%", r.action);
  }
  // Top-up branch — moderate → Top-up-33%
  {
    const r = promoteToLadderV2({
      legacyAction: "Top-up", v3: 60, snow_total: 19,
      position_weight: 7, sector_weight: 22, upside: 8, risks_count: 1,
      surveillance: null, pnlPercent: 5,
    });
    assert("Top-up + moderate → Top-up-33%", r.action === "Top-up-33%", r.action);
  }

  // Top-up-modest branch → Top-up-25% (always smallest)
  {
    const r = promoteToLadderV2({
      legacyAction: "Top-up-modest", v3: 48, snow_total: 16,
      position_weight: 5, sector_weight: 20, upside: 8, risks_count: 1,
      surveillance: null, pnlPercent: 5,
    });
    assert("Top-up-modest → Top-up-25%", r.action === "Top-up-25%", r.action);
  }

  // HOLD passthrough
  {
    const r = promoteToLadderV2({
      legacyAction: "HOLD", v3: 35, snow_total: 14,
      position_weight: 5, sector_weight: 20, upside: 0, risks_count: 1,
      surveillance: null, pnlPercent: 0,
    });
    assert("HOLD passes through unchanged", r.action === "HOLD" && r.ladderV2 === false, r);
  }
});

// ──────────────────── Set membership ────────────────────

console.log("\nSet membership\n");
assert("ALL_REDUCTION_ACTIONS includes both legacy + v2 reduction labels",
  ALL_REDUCTION_ACTIONS.has("EXIT") && ALL_REDUCTION_ACTIONS.has("EXIT-now") &&
  ALL_REDUCTION_ACTIONS.has("Reduction-50%") && ALL_REDUCTION_ACTIONS.has("Reduction-66%"),
  Array.from(ALL_REDUCTION_ACTIONS));
assert("ALL_TOPUP_ACTIONS includes both legacy + v2 top-up labels",
  ALL_TOPUP_ACTIONS.has("Top-up-modest") && ALL_TOPUP_ACTIONS.has("STRONG Top-up") &&
  ALL_TOPUP_ACTIONS.has("Top-up-25%") && ALL_TOPUP_ACTIONS.has("Top-up-100%"),
  Array.from(ALL_TOPUP_ACTIONS));
// Reduction-50% is intentionally shared between legacy and v2 — it's the
// natural midpoint of both ladders. Top-up labels are disjoint (modest/
// normal/strong vs 25/33/50/100%).
assert("Reduction-50% present in both reduction sets (shared midpoint)",
  LEGACY_REDUCTION_ACTIONS.has("Reduction-50%") && LADDER_V2_REDUCTION_ACTIONS.has("Reduction-50%"),
  null);
assert("Legacy-unique reduction labels not in v2 set",
  ["EXIT", "Reduction-25-33%"].every((a) => !LADDER_V2_REDUCTION_ACTIONS.has(a)),
  null);
assert("V2-unique reduction labels not in legacy set",
  ["EXIT-now", "EXIT-staged", "Reduction-66%", "Reduction-33%", "Reduction-25%"]
    .every((a) => !LEGACY_REDUCTION_ACTIONS.has(a)),
  null);
assert("LEGACY and LADDER_V2 topup sets are disjoint",
  [...LEGACY_TOPUP_ACTIONS].every((a) => !LADDER_V2_TOPUP_ACTIONS.has(a)),
  null);

// ════════════════════════════════════════════════════════════════════════
// V3 — continuous severity model
// ════════════════════════════════════════════════════════════════════════

console.log("\ncomputeTrimSeverity\n");

// Healthy stock — minimal severity, no trim.
{
  const r = computeTrimSeverity({
    v3: 80, position_weight: 2, sector_weight: 10,
    conviction: "MEDIUM-HIGH", surveillance: null, pnlPercent: 10, risks_count: 0,
  });
  assert("healthy stock severity ≈ 0.10", r.severity < 0.15, r.severity);
  assert("healthy → no trim rung", severityToTrimRung(r.severity) === null, severityToTrimRung(r.severity));
  assert("rationale produces 8 lines", r.rationale.length === 8, r.rationale.length);
}

// Mild WATCH-band stock — typical retail holding. Under aggressive-trim
// recalibration this case now lands at Reduction-50% (was Red-33%) — the
// boosted weakness/drawdown weights + lowered rung thresholds intentionally
// pull weak-fundamental losing positions one rung harder. This is the
// behavioural target of the calibration change.
{
  const r = computeTrimSeverity({
    v3: 20, position_weight: 4, sector_weight: 15,
    conviction: "MEDIUM", surveillance: null, pnlPercent: -10, risks_count: 0,
  });
  assert("mild WATCH severity in 0.30..0.45 band", r.severity >= 0.30 && r.severity < 0.50, r.severity);
  assert("mild WATCH → Reduction-50%", severityToTrimRung(r.severity) === "Reduction-50%", severityToTrimRung(r.severity));
}

// Concentrated weak name — should escalate above 33%.
{
  const r = computeTrimSeverity({
    v3: 18, position_weight: 18, sector_weight: 15,
    conviction: "LOW", surveillance: null, pnlPercent: -25, risks_count: 1,
  });
  assert("concentrated weak severity in 0.55..0.75", r.severity >= 0.55 && r.severity < 0.75, r.severity);
  // Either Reduction-50% or Reduction-66% depending on exact calibration —
  // both are correct for this profile (escalation beyond 33%).
  const rung = severityToTrimRung(r.severity);
  assert("concentrated weak → Reduction-50% or Reduction-66%",
    rung === "Reduction-50%" || rung === "Reduction-66%", rung);
}

// Broken thesis — should hit EXIT-staged or EXIT-now.
{
  const r = computeTrimSeverity({
    v3: 10, position_weight: 4, sector_weight: 12,
    conviction: "LOW", surveillance: null, pnlPercent: -45, risks_count: 2,
  });
  assert("broken thesis severity in 0.55..0.85", r.severity >= 0.55 && r.severity < 0.85, r.severity);
  const rung = severityToTrimRung(r.severity);
  assert("broken thesis → exit-tier or 66% rung",
    rung === "Reduction-66%" || rung === "EXIT-staged" || rung === "EXIT-now", rung);
}

// GSM-3+ surveillance hard override — EXIT-now regardless of score.
{
  assert("GSM-3+ override → EXIT-now",
    severityToTrimRung(0.10, { gsmStage3Plus: true }) === "EXIT-now",
    severityToTrimRung(0.10, { gsmStage3Plus: true }));
  // Even with high severity, GSM-3+ goes through EXIT-now (not double-counted).
  assert("GSM-3+ override even at high severity",
    severityToTrimRung(0.95, { gsmStage3Plus: true }) === "EXIT-now",
    severityToTrimRung(0.95, { gsmStage3Plus: true }));
}

// Boundary mappings — rung edges must be deterministic. Aggressive-trim
// recalibration shifted every band one rung lower so the same severity
// score produces a harder action (the user wants more Red-50%, not more
// HOLD). The boundary table below is the calibration-of-record; if it
// drifts, expect downstream UI tests to need updating in lockstep.
console.log("\nseverityToTrimRung boundaries\n");
assert("0.09 → null (below trim floor)",       severityToTrimRung(0.09) === null,            severityToTrimRung(0.09));
assert("0.10 → Reduction-25%",                 severityToTrimRung(0.10) === "Reduction-25%", severityToTrimRung(0.10));
assert("0.21 → Reduction-25%",                 severityToTrimRung(0.21) === "Reduction-25%", severityToTrimRung(0.21));
assert("0.22 → Reduction-33%",                 severityToTrimRung(0.22) === "Reduction-33%", severityToTrimRung(0.22));
assert("0.34 → Reduction-33%",                 severityToTrimRung(0.34) === "Reduction-33%", severityToTrimRung(0.34));
assert("0.35 → Reduction-50%",                 severityToTrimRung(0.35) === "Reduction-50%", severityToTrimRung(0.35));
assert("0.49 → Reduction-50%",                 severityToTrimRung(0.49) === "Reduction-50%", severityToTrimRung(0.49));
assert("0.50 → Reduction-66%",                 severityToTrimRung(0.50) === "Reduction-66%", severityToTrimRung(0.50));
assert("0.64 → Reduction-66%",                 severityToTrimRung(0.64) === "Reduction-66%", severityToTrimRung(0.64));
assert("0.65 → EXIT-staged",                   severityToTrimRung(0.65) === "EXIT-staged",   severityToTrimRung(0.65));
assert("0.84 → EXIT-staged",                   severityToTrimRung(0.84) === "EXIT-staged",   severityToTrimRung(0.84));
assert("0.85 → EXIT-now",                      severityToTrimRung(0.85) === "EXIT-now",      severityToTrimRung(0.85));
assert("1.00 → EXIT-now",                      severityToTrimRung(1.00) === "EXIT-now",      severityToTrimRung(1.00));

// Determinism — same inputs ⇒ same severity.
{
  const a = computeTrimSeverity({ v3: 18, position_weight: 4, sector_weight: 15, conviction: "MEDIUM", surveillance: null, pnlPercent: -10, risks_count: 0 });
  const b = computeTrimSeverity({ v3: 18, position_weight: 4, sector_weight: 15, conviction: "MEDIUM", surveillance: null, pnlPercent: -10, risks_count: 0 });
  assert("severity is deterministic", a.severity === b.severity, [a.severity, b.severity]);
}

// ──────────────────── computeTopUpSeverity ────────────────────

console.log("\ncomputeTopUpSeverity\n");

// TOP_PICK with full room + upside + clean risks → 100%.
{
  const r = computeTopUpSeverity({ v3: 75, position_weight: 2, sector_weight: 10, upside: 25, risks_count: 0 });
  assert("TOP_PICK clean → severity ≥ 0.70", r.severity >= 0.70, r.severity);
  assert("TOP_PICK clean → Top-up-100%", severityToTopUpRung(r.severity) === "Top-up-100%", severityToTopUpRung(r.severity));
}
// STRONG band moderate — should land Top-up-50% or Top-up-33%.
{
  const r = computeTopUpSeverity({ v3: 60, position_weight: 5, sector_weight: 18, upside: 12, risks_count: 1 });
  const rung = severityToTopUpRung(r.severity);
  assert("STRONG moderate → 33% or 50% rung",
    rung === "Top-up-33%" || rung === "Top-up-50%", rung);
}
// Below threshold — no top-up.
{
  const r = computeTopUpSeverity({ v3: 45, position_weight: 7, sector_weight: 23, upside: 4, risks_count: 3 });
  assert("weak signal → no top-up rung", severityToTopUpRung(r.severity) === null, severityToTopUpRung(r.severity));
}

// ──────────────────── promoteToLadderV2 with V3 flag ────────────────────

console.log("\npromoteToLadderV2 V3 path\n");

const SAVED_V3 = process.env.SWS_LADDER_V3;
function withV3On(fn) {
  process.env.SWS_LADDER_V2 = "1";
  process.env.SWS_LADDER_V3 = "1";
  try { fn(); } finally {
    process.env.SWS_LADDER_V2 = SAVED_FLAG;
    process.env.SWS_LADDER_V3 = SAVED_V3;
  }
}

withV3On(() => {
  // V3 should produce specific rungs for typical retail factors — no
  // default-fallback to 33% when factors don't say so.
  const r = promoteToLadderV2({
    legacyAction: "Reduction-50%",
    v3: 19, snow_total: 12, position_weight: 3, sector_weight: 14,
    upside: -5, risks_count: 1,
    surveillance: null, pnlPercent: -8,
  });
  assert("V3 promotion returns ladderV2=true", r.ladderV2 === true, r.ladderV2);
  assert("V3 promotion populates severity", typeof r.severity === "number" && r.severity >= 0 && r.severity <= 1, r.severity);
  assert("V3 promotion populates rationale array", Array.isArray(r.ladderRationale) && r.ladderRationale.length >= 8, r.ladderRationale?.length);
  // Aggressive-trim recalibration: severity 0.40-0.50 lands Red-50%.
  // (Was Red-25% or Red-33% under the old calibration; the harder rung
  // is the intended behaviour for v3=19 + LOW conviction + losing position.)
  assert("V3 mild WATCH → Red-50% (aggressive)",
    r.action === "Reduction-50%", r.action);

  // Concentrated position should escalate.
  const r2 = promoteToLadderV2({
    legacyAction: "Reduction-50%",
    v3: 16, snow_total: 10, position_weight: 16, sector_weight: 18,
    upside: -10, risks_count: 1,
    surveillance: null, pnlPercent: -22,
  });
  assert("V3 concentrated weak → 50% or 66%",
    r2.action === "Reduction-50%" || r2.action === "Reduction-66%", r2.action);

  // GSM-3+ → EXIT-now hard override on EXIT path.
  const r3 = promoteToLadderV2({
    legacyAction: "EXIT",
    v3: 18, snow_total: 12, position_weight: 4, sector_weight: 15,
    upside: -8, risks_count: 1,
    surveillance: { list: "GSM", stage: 3 }, pnlPercent: -15,
  });
  assert("V3 GSM-3+ EXIT → EXIT-now", r3.action === "EXIT-now", r3.action);

  const topUpFromV4 = promoteToLadderV2({
    legacyAction: "Top-up",
    v4: 60, snow_total: 20, position_weight: 4, sector_weight: 14,
    upside: 18, risks_count: 0,
    surveillance: null, pnlPercent: 12,
  });
  assert("V4 score alias produces top-up severity", Number.isFinite(topUpFromV4.severity) && topUpFromV4.action.startsWith("Top-up"), topUpFromV4);
  assert("V4 score alias rationale uses Score label",
    Array.isArray(topUpFromV4.ladderRationale) && /Score 60\/100/.test(topUpFromV4.ladderRationale.join(" ")),
    topUpFromV4.ladderRationale);

  const topUpFromLegacyV3 = promoteToLadderV2({
    legacyAction: "Top-up",
    v3: 60, snow_total: 20, position_weight: 4, sector_weight: 14,
    upside: 18, risks_count: 0,
    surveillance: null, pnlPercent: 12,
  });
  assert("legacy v3 score still supported", topUpFromLegacyV3.action === topUpFromV4.action, [topUpFromLegacyV3.action, topUpFromV4.action]);
});

// ──────────────────── Summary ────────────────────

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
