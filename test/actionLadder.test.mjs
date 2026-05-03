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
  ALL_REDUCTION_ACTIONS,
  ALL_TOPUP_ACTIONS,
  LEGACY_REDUCTION_ACTIONS,
  LEGACY_TOPUP_ACTIONS,
  LADDER_V2_REDUCTION_ACTIONS,
  LADDER_V2_TOPUP_ACTIONS,
} from "../services/actionLadder.js";

// promoteToLadderV2 is gated by SWS_LADDER_V2=1. The test sets the env
// for the duration of its block and restores it after, so the rest of
// the suite runs in default state.
const SAVED_FLAG = process.env.SWS_LADDER_V2;
function withFlagOn(fn) {
  process.env.SWS_LADDER_V2 = "1";
  try { fn(); } finally { process.env.SWS_LADDER_V2 = SAVED_FLAG; }
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
  const r = promoteToLadderV2({
    legacyAction: "Reduction-50%", v3: 18, snow_total: 8,
    position_weight: 18, sector_weight: 20, upside: -10, risks_count: 2,
    surveillance: null, pnlPercent: -25,
  });
  assert("flag off → no-op promotion", r.action === "Reduction-50%" && r.ladderV2 === false, r);
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

// ──────────────────── Summary ────────────────────

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
