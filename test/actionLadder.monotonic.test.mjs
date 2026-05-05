/**
 * Monotonicity property test for the V3 continuous-severity ladder.
 *
 * Asserts: as severity rises from 0 → 1 in 0.05 steps, the rung never
 * gets weaker. This is the safety property that keeps the action mix
 * SEBI-defensible — no inputs can produce a paradoxical "more risk →
 * lighter action" path.
 *
 * Run with: node test/actionLadder.monotonic.test.mjs
 */

import { severityToTrimRung, severityToTopUpRung } from "../services/actionLadder.js";

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

// Trim-rung depth ordering (deeper = more bearish).
const TRIM_DEPTH = {
  null: 0,
  "Reduction-25%": 1,
  "Reduction-33%": 2,
  "Reduction-50%": 3,
  "Reduction-66%": 4,
  "EXIT-staged": 5,
  "EXIT-now": 6,
};

// Top-up-rung depth ordering (deeper = more bullish).
const TOPUP_DEPTH = {
  null: 0,
  "Top-up-25%": 1,
  "Top-up-33%": 2,
  "Top-up-50%": 3,
  "Top-up-100%": 4,
};

console.log("\nseverityToTrimRung — monotone over 0.00 → 1.00\n");
{
  let lastDepth = -1;
  let monotone = true;
  let breakingPoint = null;
  for (let s = 0; s <= 1.001; s += 0.05) {
    const r = severityToTrimRung(s);
    const d = TRIM_DEPTH[String(r)] ?? -1;
    if (d < lastDepth) {
      monotone = false;
      breakingPoint = { severity: s, rung: r, prevDepth: lastDepth, thisDepth: d };
      break;
    }
    lastDepth = d;
  }
  assert("trim ladder is monotone-non-decreasing", monotone, breakingPoint);
}

console.log("\nseverityToTopUpRung — monotone over 0.00 → 1.00\n");
{
  let lastDepth = -1;
  let monotone = true;
  let breakingPoint = null;
  for (let s = 0; s <= 1.001; s += 0.05) {
    const r = severityToTopUpRung(s);
    const d = TOPUP_DEPTH[String(r)] ?? -1;
    if (d < lastDepth) {
      monotone = false;
      breakingPoint = { severity: s, rung: r, prevDepth: lastDepth, thisDepth: d };
      break;
    }
    lastDepth = d;
  }
  assert("top-up ladder is monotone-non-decreasing", monotone, breakingPoint);
}

console.log("\nseverityToTrimRung — GSM stage-3 short-circuits to EXIT-now\n");
{
  for (let s = 0; s <= 1.001; s += 0.10) {
    const r = severityToTrimRung(s, { gsmStage3Plus: true });
    if (r !== "EXIT-now") {
      assert(`severity=${s.toFixed(2)} with GSM-3 → EXIT-now`, false, r);
      break;
    }
  }
  assert("GSM-3 always returns EXIT-now", true, "EXIT-now");
}

console.log("\nseverityToTrimRung — boundary cases\n");
{
  assert("null severity → null rung", severityToTrimRung(null) === null, severityToTrimRung(null));
  assert("NaN severity → null rung", severityToTrimRung(NaN) === null, severityToTrimRung(NaN));
  assert("negative severity → null rung", severityToTrimRung(-0.1) === null, severityToTrimRung(-0.1));
  assert("severity > 1 → EXIT-now", severityToTrimRung(1.5) === "EXIT-now", severityToTrimRung(1.5));
}

console.log("");
console.log(`Tests passed: ${pass}, failed: ${fail}`);
if (fail > 0) process.exit(1);
