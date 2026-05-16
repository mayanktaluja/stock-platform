/**
 * Tests for the prediction-aware reasoning bullet appended to the SWS
 * holding engine's `reasons` array.
 *
 * The bullet text varies by (action direction, predicted verdict) — the
 * matrix is:
 *
 *               BEAT verdict       MISS verdict       INLINE verdict
 *   bearish     Note: ...conflict  Headwind: ...      no directional read
 *   neutral     Watch: upside tilt Watch: downside    no directional read
 *   bullish     Tailwind: ...      Note: ...conflict  no directional read
 *
 * Out-of-window (>14d), missing event, LOW data_quality, INSUFFICIENT_DATA
 * all return null (no bullet).
 *
 * Run with: node test/swsHoldingEngine.predictionReasoning.test.mjs
 */

import { _buildPredictionReasoningBullet, _actionDirection } from "../services/swsHoldingEngine.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

function prediction({ verdict = "BEAT", confidence_pct = 64, fiscal_quarter = "Q4 FY26",
                      days_until = 3, data_quality = "HIGH",
                      event_iso_date = "2026-05-20" } = {}) {
  return { verdict, confidence_pct, fiscal_quarter, days_until, data_quality, event_iso_date };
}

console.log("\n_actionDirection — classification matrix\n");
{
  assert("HOLD = neutral", _actionDirection("HOLD") === "neutral", _actionDirection("HOLD"));
  assert("EXIT = bearish", _actionDirection("EXIT") === "bearish", _actionDirection("EXIT"));
  assert("EXIT-now = bearish", _actionDirection("EXIT-now") === "bearish", _actionDirection("EXIT-now"));
  assert("EXIT-staged = bearish", _actionDirection("EXIT-staged") === "bearish", _actionDirection("EXIT-staged"));
  assert("Reduction-25% = bearish", _actionDirection("Reduction-25%") === "bearish", _actionDirection("Reduction-25%"));
  assert("Reduction-25-33% = bearish", _actionDirection("Reduction-25-33%") === "bearish", _actionDirection("Reduction-25-33%"));
  assert("Reduction-50% = bearish", _actionDirection("Reduction-50%") === "bearish", _actionDirection("Reduction-50%"));
  assert("Top-up-modest = bullish", _actionDirection("Top-up-modest") === "bullish", _actionDirection("Top-up-modest"));
  assert("Top-up-25% = bullish", _actionDirection("Top-up-25%") === "bullish", _actionDirection("Top-up-25%"));
  assert("STRONG Top-up = bullish", _actionDirection("STRONG Top-up") === "bullish", _actionDirection("STRONG Top-up"));
  assert("null = neutral", _actionDirection(null) === "neutral", _actionDirection(null));
  assert("undefined = neutral", _actionDirection(undefined) === "neutral", _actionDirection(undefined));
}

console.log("\n_buildPredictionReasoningBullet — REDUCE on BEAT prints conflict bullet\n");
{
  const b = _buildPredictionReasoningBullet("Reduction-25%", prediction({ verdict: "BEAT", confidence_pct: 64 }));
  assert("bullet returned", typeof b === "string" && b.length > 0, b);
  assert("mentions 'conflicts with the reduction'", /conflicts with the reduction/.test(b), b);
  assert("includes fiscal quarter", /Q4 FY26/.test(b), b);
  assert("includes confidence pct", /64%/.test(b), b);
  assert("includes data quality", /HIGH quality/.test(b), b);
  assert("includes day label", /in 3d/.test(b), b);
}

console.log("\n_buildPredictionReasoningBullet — TOP-UP on BEAT prints tailwind bullet\n");
{
  const b = _buildPredictionReasoningBullet("Top-up-25%", prediction({ verdict: "BEAT", confidence_pct: 62 }));
  assert("includes 'Tailwind'", /Tailwind/.test(b), b);
  assert("includes 'supports the current view'", /supports the current view/.test(b), b);
}

console.log("\n_buildPredictionReasoningBullet — REDUCE on MISS prints headwind bullet\n");
{
  const b = _buildPredictionReasoningBullet("Reduction-25%", prediction({ verdict: "MISS", confidence_pct: 60 }));
  assert("includes 'Headwind'", /Headwind/.test(b), b);
  assert("includes 'supports the current view'", /supports the current view/.test(b), b);
}

console.log("\n_buildPredictionReasoningBullet — TOP-UP on MISS prints conflict bullet\n");
{
  const b = _buildPredictionReasoningBullet("Top-up-modest", prediction({ verdict: "MISS", confidence_pct: 58 }));
  assert("mentions 'conflicts with the top-up'", /conflicts with the top-up/.test(b), b);
}

console.log("\n_buildPredictionReasoningBullet — HOLD with directional forecast prints watch line\n");
{
  const beatBullet = _buildPredictionReasoningBullet("HOLD", prediction({ verdict: "BEAT", confidence_pct: 64 }));
  assert("HOLD+BEAT includes 'Watch'", /Watch:/.test(beatBullet), beatBullet);
  assert("HOLD+BEAT mentions 'upside tilt'", /upside tilt/.test(beatBullet), beatBullet);

  const missBullet = _buildPredictionReasoningBullet("HOLD", prediction({ verdict: "MISS", confidence_pct: 60 }));
  assert("HOLD+MISS mentions 'downside tilt'", /downside tilt/.test(missBullet), missBullet);
}

console.log("\n_buildPredictionReasoningBullet — INLINE always = no directional read\n");
{
  const reduceBullet = _buildPredictionReasoningBullet("Reduction-25%", prediction({ verdict: "INLINE", confidence_pct: 55 }));
  assert("REDUCE+INLINE: 'no directional read'", /no directional read/.test(reduceBullet), reduceBullet);
  const topUpBullet = _buildPredictionReasoningBullet("Top-up-25%", prediction({ verdict: "INLINE" }));
  assert("TOP-UP+INLINE: 'no directional read'", /no directional read/.test(topUpBullet), topUpBullet);
  const holdBullet = _buildPredictionReasoningBullet("HOLD", prediction({ verdict: "INLINE" }));
  assert("HOLD+INLINE: 'no directional read'", /no directional read/.test(holdBullet), holdBullet);
}

console.log("\n_buildPredictionReasoningBullet — out-of-window (>14d) returns null\n");
{
  const b = _buildPredictionReasoningBullet("Reduction-25%", prediction({ days_until: 18 }));
  assert("returns null", b === null, b);
}

console.log("\n_buildPredictionReasoningBullet — missing or malformed input returns null\n");
{
  assert("null prediction → null", _buildPredictionReasoningBullet("Reduction-25%", null) === null, null);
  assert("missing verdict → null", _buildPredictionReasoningBullet("Reduction-25%", { confidence_pct: 64 }) === null, "no-verdict");
  assert("days_until null → null", _buildPredictionReasoningBullet("Reduction-25%", prediction({ days_until: null })) === null, "null-days");
  assert("days_until negative → null", _buildPredictionReasoningBullet("Reduction-25%", prediction({ days_until: -1 })) === null, "negative-days");
}

console.log("\n_buildPredictionReasoningBullet — day labels (today / tomorrow / in Xd)\n");
{
  const today = _buildPredictionReasoningBullet("Reduction-25%", prediction({ days_until: 0 }));
  assert("days_until=0 says 'today'", /today/.test(today), today);
  const tomorrow = _buildPredictionReasoningBullet("Reduction-25%", prediction({ days_until: 1 }));
  assert("days_until=1 says 'tomorrow'", /tomorrow/.test(tomorrow), tomorrow);
  const future = _buildPredictionReasoningBullet("Reduction-25%", prediction({ days_until: 7 }));
  assert("days_until=7 says 'in 7d'", /in 7d/.test(future), future);
}

console.log("");
console.log(`Tests passed: ${pass}, failed: ${fail}`);
if (fail > 0) process.exit(1);
