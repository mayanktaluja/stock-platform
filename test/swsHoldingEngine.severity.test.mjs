/**
 * Regression tests for the V3 continuous-severity rubric — the engine that
 * replaces the banded score → action mapping in the analyzer's reduction
 * tier.
 *
 * Covers:
 *   • Healthy stock → null rung (HOLD path)
 *   • Mild WATCH band → Reduction-33%
 *   • Concentrated weak → Reduction-66%
 *   • Broken thesis (v3<14) → EXIT-staged via floor
 *   • GSM stage 3 → EXIT-now (hard regulatory override)
 *   • v3 < 14 floor (loss trap) holds severity ≥ 0.75
 *   • Missing snowflake pillar → finite severity, no NaN
 *   • severityToTrimRung is monotone over the threshold table
 *
 * Run with: node test/swsHoldingEngine.severity.test.mjs
 */

import { computeTrimSeverity, severityToTrimRung } from "../services/actionLadder.js";

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

function rung(severity, gsmStage3Plus = false) {
  return severityToTrimRung(severity, { gsmStage3Plus });
}

// ──────────────────── Severity → rung ────────────────────

console.log("\ncomputeTrimSeverity — case 1: healthy stock\n");
{
  const r = computeTrimSeverity({
    v3: 80, position_weight: 2, sector_weight: 10,
    conviction: "MEDIUM-HIGH", surveillance: null, pnlPercent: 10, risks_count: 0,
  });
  assert("severity finite", Number.isFinite(r.severity), r.severity);
  assert("severity < 0.15", r.severity < 0.15, r.severity);
  assert("rung = null (HOLD path)", rung(r.severity) === null, r.severity);
}

console.log("\ncomputeTrimSeverity — case 2: mild WATCH (Reduction-33%)\n");
{
  const r = computeTrimSeverity({
    v3: 20, position_weight: 4, sector_weight: 15,
    conviction: "MEDIUM", surveillance: null, pnlPercent: -10, risks_count: 0,
  });
  assert("severity in [0.30, 0.45)", r.severity >= 0.30 && r.severity < 0.45, r.severity);
  assert("rung = Reduction-33%", rung(r.severity) === "Reduction-33%", rung(r.severity));
}

console.log("\ncomputeTrimSeverity — case 3: concentrated weak (Reduction-66%)\n");
{
  const r = computeTrimSeverity({
    v3: 18, position_weight: 18, sector_weight: 15,
    conviction: "LOW", surveillance: null, pnlPercent: -25, risks_count: 1,
  });
  assert("severity ≥ 0.60", r.severity >= 0.60, r.severity);
  assert("rung = Reduction-66%", rung(r.severity) === "Reduction-66%", rung(r.severity));
}

console.log("\ncomputeTrimSeverity — case 4: broken thesis (v3<14 floor → EXIT-staged)\n");
{
  const r = computeTrimSeverity({
    v3: 10, position_weight: 4, sector_weight: 12,
    conviction: "LOW", surveillance: null, pnlPercent: -45, risks_count: 2,
  });
  assert("severity ≥ 0.75 (v3<14 floor)", r.severity >= 0.75, r.severity);
  assert("rung = EXIT-staged", rung(r.severity) === "EXIT-staged", rung(r.severity));
}

console.log("\ncomputeTrimSeverity — case 5: GSM stage 3 (hard override → EXIT-now)\n");
{
  // Even with strong fundamentals, GSM-3 forces EXIT-now via the rung mapper.
  const r = computeTrimSeverity({
    v3: 70, position_weight: 5, sector_weight: 12,
    conviction: "MEDIUM-HIGH", surveillance: { list: "GSM", stage: 3 },
    pnlPercent: 5, risks_count: 0,
  });
  assert("severity finite", Number.isFinite(r.severity), r.severity);
  assert("rung = EXIT-now (gsmStage3Plus)", rung(r.severity, true) === "EXIT-now", rung(r.severity, true));
}

console.log("\ncomputeTrimSeverity — case 6: v3<14 loss-trap floor\n");
{
  const r = computeTrimSeverity({
    v3: 12, position_weight: 4, sector_weight: 12,
    conviction: "MEDIUM", surveillance: null, pnlPercent: -42, risks_count: 0,
  });
  assert("severity ≥ 0.75 via v3<14 floor", r.severity >= 0.75, r.severity);
  const r2 = severityToTrimRung(r.severity);
  assert("rung is EXIT-staged or stronger",
    r2 === "EXIT-staged" || r2 === "EXIT-now", r2);
}

console.log("\ncomputeTrimSeverity — case 7: missing inputs (defensive)\n");
{
  const r = computeTrimSeverity({
    v3: null, position_weight: undefined, sector_weight: NaN,
    conviction: undefined, surveillance: undefined,
    pnlPercent: undefined, risks_count: undefined,
  });
  assert("severity finite even with all-null inputs", Number.isFinite(r.severity), r.severity);
  assert("severity in [0, 1]", r.severity >= 0 && r.severity <= 1, r.severity);
}

console.log("\nseverityToTrimRung — threshold spot-checks\n");
{
  assert("0.05 → null", rung(0.05) === null, rung(0.05));
  assert("0.15 → Reduction-25%", rung(0.15) === "Reduction-25%", rung(0.15));
  assert("0.30 → Reduction-33%", rung(0.30) === "Reduction-33%", rung(0.30));
  assert("0.45 → Reduction-50%", rung(0.45) === "Reduction-50%", rung(0.45));
  assert("0.60 → Reduction-66%", rung(0.60) === "Reduction-66%", rung(0.60));
  assert("0.75 → EXIT-staged", rung(0.75) === "EXIT-staged", rung(0.75));
  assert("0.90 → EXIT-now", rung(0.90) === "EXIT-now", rung(0.90));
}

console.log("");
console.log(`Tests passed: ${pass}, failed: ${fail}`);
if (fail > 0) process.exit(1);
