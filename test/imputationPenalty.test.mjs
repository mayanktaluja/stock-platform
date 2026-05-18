import { computeImputationPenalty } from "../services/riskLab/quality/imputationPenalty.js";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

console.log("imputationPenalty: clean case (no imputation)");
{
  const r = computeImputationPenalty({ fv_imputed: false, momentum_imputed: false }, 80);
  assert("clean: no flags", r.flags.length === 0);
  assert("clean: 0 pts", r.pts === 0);
}

console.log("imputationPenalty: fv imputed with high score");
{
  const r = computeImputationPenalty({ fv_imputed: true, momentum_imputed: false }, 70);
  assert("fv imputed high: 1 flag", r.flags.length === 1);
  assert("fv imputed high: -2 pts", r.pts === -2);
  assert("fv imputed high: flag type", r.flags[0].type === "fv_imputed");
  assert("fv imputed high: cites breakdown source", r.flags[0].source === "v3_breakdown.fv_imputed");
}

console.log("imputationPenalty: fv imputed but LOW score (no penalty)");
{
  const r = computeImputationPenalty({ fv_imputed: true, momentum_imputed: false }, 40);
  assert("fv imputed low: no flags (under threshold)", r.flags.length === 0);
  assert("fv imputed low: 0 pts", r.pts === 0);
}

console.log("imputationPenalty: momentum imputed");
{
  const r = computeImputationPenalty({ fv_imputed: false, momentum_imputed: true }, 75);
  assert("momentum imputed high: 1 flag", r.flags.length === 1);
  assert("momentum imputed high: -1 pt", r.pts === -1);
}

console.log("imputationPenalty: both imputed (combined, capped)");
{
  const r = computeImputationPenalty({ fv_imputed: true, momentum_imputed: true }, 80);
  assert("both imputed: 2 flags", r.flags.length === 2);
  assert("both imputed: -3 pts (capped, not -3)", r.pts === -3);
}

console.log("imputationPenalty: guards");
{
  // Null breakdown
  const r1 = computeImputationPenalty(null, 80);
  assert("null breakdown: 0 pts", r1.pts === 0);
  assert("null breakdown: reason no_breakdown", r1.reason === "no_breakdown");

  // Non-object breakdown
  const r2 = computeImputationPenalty("invalid", 80);
  assert("invalid breakdown: 0 pts", r2.pts === 0);

  // Missing score → defaults to 0 → no flags (below threshold)
  const r3 = computeImputationPenalty({ fv_imputed: true }, null);
  assert("null score: no flags", r3.flags.length === 0);

  // Exactly at threshold (50) → no flag (>, not >=)
  const r4 = computeImputationPenalty({ fv_imputed: true }, 50);
  assert("score === 50: no flag", r4.flags.length === 0);

  // 50.1 → fires
  const r5 = computeImputationPenalty({ fv_imputed: true }, 50.1);
  assert("score === 50.1: fires", r5.flags.length === 1);
}

if (_failed === 0) {
  console.log("imputationPenalty: PASS");
  process.exit(0);
} else {
  console.error(`imputationPenalty: FAIL (${_failed})`);
  process.exit(1);
}
