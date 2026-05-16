/**
 * Unit tests for services/combinedScore.js — pure-math surface only.
 *
 * Covers the stuff that doesn't touch storage / DAL / KV / fs:
 *   • WEIGHTS / NEWS_WEIGHTS — sum-to-1.0 invariant per scanner
 *   • DIVERGENCE_THRESHOLD + METHODOLOGY_VERSION — exported constants
 *   • computeCombinedScore — every branch of the scoring math:
 *       - empty input  → null + low confidence
 *       - all 3 dims   → weighted average + high confidence
 *       - missing dims → pro-rata reweight (Σweightsused = 1)
 *       - news pillar  → switches weight basis (NEWS_WEIGHTS)
 *       - clamp        → 0..100 invariant on extreme inputs
 *       - divergence   → fires at > threshold, not at == threshold
 *       - dataConfidence ladder (3 → high, 2 → medium, 1 → low)
 *       - unknown scannerType falls back to uniform
 *       - monotonicity: raising one dim never lowers final score
 *       - methodologyVersion stamped on every result
 *       - news flag is Number.isFinite (rejects null + NaN)
 *   • buildCombinedAudit — pure shape transform, null-safe defaults
 *
 * Skipped (would need DAL / fs / KV mocks):
 *   • lookupSwsScore, lookupSwsScoreBulk, getMethodology
 *   • readShadowDiffStore, captureShadowDiff, captureShadowDiffBulk
 *
 * Run with: node test/combinedScore.test.mjs
 */

import {
  WEIGHTS,
  NEWS_WEIGHTS,
  DIVERGENCE_THRESHOLD,
  METHODOLOGY_VERSION,
  computeCombinedScore,
  buildCombinedAudit,
} from "../services/combinedScore.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ok", name);
  } else {
    fail++;
    console.log("  FAIL", name, "->", JSON.stringify(got));
  }
}

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

console.log("\nWEIGHTS / NEWS_WEIGHTS — sum-to-1.0 invariant\n");

for (const [name, w] of Object.entries(WEIGHTS)) {
  const sum = w.tech + w.fund + w.sws;
  assert(`WEIGHTS.${name} sums to 1.0`, approx(sum, 1.0), sum);
}
for (const [name, w] of Object.entries(NEWS_WEIGHTS)) {
  const sum = w.tech + w.fund + w.sws + w.news;
  assert(`NEWS_WEIGHTS.${name} sums to 1.0`, approx(sum, 1.0), sum);
}
assert("WEIGHTS is frozen", Object.isFrozen(WEIGHTS), Object.isFrozen(WEIGHTS));
assert("NEWS_WEIGHTS is frozen", Object.isFrozen(NEWS_WEIGHTS), Object.isFrozen(NEWS_WEIGHTS));
assert(
  "every scanner key has a NEWS_WEIGHTS counterpart",
  Object.keys(WEIGHTS).every((k) => NEWS_WEIGHTS[k]),
  Object.keys(WEIGHTS),
);
// News allocation is borrowed from tech (per the file's P1.4 doc-comment).
for (const k of Object.keys(WEIGHTS)) {
  if (k === "uniform") continue;
  assert(
    `NEWS_WEIGHTS.${k}.tech <= WEIGHTS.${k}.tech (news borrows from tech)`,
    NEWS_WEIGHTS[k].tech <= WEIGHTS[k].tech + 1e-9,
    { news: NEWS_WEIGHTS[k].tech, base: WEIGHTS[k].tech },
  );
}

console.log("\nExported constants\n");

assert("DIVERGENCE_THRESHOLD is 22", DIVERGENCE_THRESHOLD === 22, DIVERGENCE_THRESHOLD);
assert(
  "METHODOLOGY_VERSION matches combined-vN-YYYY-MM",
  /^combined-v\d+-\d{4}-\d{2}$/.test(METHODOLOGY_VERSION),
  METHODOLOGY_VERSION,
);

console.log("\ncomputeCombinedScore — empty input\n");

{
  const r = computeCombinedScore({});
  assert("no scores -> combinedScore null", r.combinedScore === null, r.combinedScore);
  assert("no scores -> dataConfidence low", r.dataConfidence === "low", r.dataConfidence);
  assert("no scores -> contributingDims []", r.contributingDims.length === 0, r.contributingDims);
  assert("no scores -> divergence false", r.divergence === false, r.divergence);
  assert("no scores -> methodologyVersion stamped", r.methodologyVersion === METHODOLOGY_VERSION, r.methodologyVersion);
}

console.log("\ncomputeCombinedScore — uniform 3-pillar\n");

{
  // All 3 scores equal -> result equals the score, regardless of weights.
  const r = computeCombinedScore({ techScore: 50, fundScore: 50, swsScore: 50, scannerType: "uniform" });
  assert("equal pillars -> equal output", r.combinedScore === 50, r.combinedScore);
  assert("3 dims -> dataConfidence high", r.dataConfidence === "high", r.dataConfidence);
  assert(
    "3 dims -> contributingDims [tech,fund,sws]",
    r.contributingDims.join(",") === "tech,fund,sws",
    r.contributingDims,
  );
  assert("equal pillars -> divergence false", r.divergence === false, r.divergence);
  assert("equal pillars -> spread 0", r.divergenceSpread === 0, r.divergenceSpread);
}

console.log("\ncomputeCombinedScore — buynow weighting math\n");

{
  // buynow = { tech: 0.45, fund: 0.25, sws: 0.30 }
  // expected = 100*0.45 + 0*0.25 + 0*0.30 = 45.0
  const r = computeCombinedScore({ techScore: 100, fundScore: 0, swsScore: 0, scannerType: "buynow" });
  assert("buynow tech=100,others=0 -> 45.0", r.combinedScore === 45.0, r.combinedScore);
  assert(
    "weightsUsed mirrors buynow when all dims present",
    r.weightsUsed.tech === 0.45 && r.weightsUsed.fund === 0.25 && r.weightsUsed.sws === 0.30,
    r.weightsUsed,
  );
}

{
  // buynow with sws missing -> tech+fund pro-rata reweighted to sum=1.
  //   sumW = 0.45 + 0.25 = 0.70
  //   tech weight applied = 0.45/0.70 ≈ 0.6428
  //   fund weight applied = 0.25/0.70 ≈ 0.3571
  //   weighted = 80*0.6428 + 60*0.3571 ≈ 72.857 -> rounded 72.9
  const r = computeCombinedScore({ techScore: 80, fundScore: 60, scannerType: "buynow" });
  const sumUsed = r.weightsUsed.tech + r.weightsUsed.fund + r.weightsUsed.sws + r.weightsUsed.news;
  assert("missing sws -> Σweightsused ≈ 1", Math.abs(sumUsed - 1.0) < 1e-3, sumUsed);
  assert("missing sws -> sws weight = 0", r.weightsUsed.sws === 0, r.weightsUsed.sws);
  assert("missing sws -> tech > fund (buynow)", r.weightsUsed.tech > r.weightsUsed.fund, r.weightsUsed);
  assert("missing sws -> contributingDims excludes sws", !r.contributingDims.includes("sws"), r.contributingDims);
  assert("2 dims -> dataConfidence medium", r.dataConfidence === "medium", r.dataConfidence);
  assert("2 dims -> combinedScore around 72.9", Math.abs(r.combinedScore - 72.9) < 0.2, r.combinedScore);
}

{
  // Single dim only -> weight applied is 1.0, output equals input.
  const r = computeCombinedScore({ swsScore: 73, scannerType: "fund" });
  assert("single dim -> output equals input", r.combinedScore === 73, r.combinedScore);
  assert("single dim -> sws weight = 1.0", Math.abs(r.weightsUsed.sws - 1.0) < 1e-3, r.weightsUsed);
  assert("single dim -> dataConfidence low", r.dataConfidence === "low", r.dataConfidence);
  assert("single dim -> divergenceSpread 0", r.divergenceSpread === 0, r.divergenceSpread);
}

console.log("\ncomputeCombinedScore — news pillar (P1.4)\n");

{
  // newsScore present -> uses NEWS_WEIGHTS basis. buynow = {tech:.40,fund:.20,sws:.25,news:.15}
  // expected = 100*.40 + 100*.20 + 100*.25 + 100*.15 = 100
  const r = computeCombinedScore({
    techScore: 100, fundScore: 100, swsScore: 100, newsScore: 100, scannerType: "buynow",
  });
  assert("news pillar all-100 -> 100", r.combinedScore === 100, r.combinedScore);
  assert("news pillar -> 4 contributingDims", r.contributingDims.length === 4, r.contributingDims);
  assert(
    "news pillar -> news weight present in weightsUsed",
    Math.abs(r.weightsUsed.news - 0.15) < 1e-3,
    r.weightsUsed.news,
  );
  assert("4 dims -> dataConfidence high", r.dataConfidence === "high", r.dataConfidence);
}

{
  // newsScore = null -> falls back to legacy 3-pillar WEIGHTS, news omitted.
  const r = computeCombinedScore({
    techScore: 50, fundScore: 50, swsScore: 50, newsScore: null, scannerType: "buynow",
  });
  assert("newsScore=null -> news NOT in dims", !r.contributingDims.includes("news"), r.contributingDims);
  assert("newsScore=null -> news weight 0", r.weightsUsed.news === 0, r.weightsUsed.news);
  assert("newsScore=null -> tech weight = 0.45 (legacy)", r.weightsUsed.tech === 0.45, r.weightsUsed.tech);
}

{
  // NaN newsScore is treated as missing (Number.isFinite is the gate).
  const r = computeCombinedScore({
    techScore: 50, fundScore: 50, swsScore: 50, newsScore: NaN, scannerType: "buynow",
  });
  assert("newsScore=NaN -> news NOT in dims", !r.contributingDims.includes("news"), r.contributingDims);
}

console.log("\ncomputeCombinedScore — clamp + rounding invariants\n");

{
  // Out-of-range inputs (>100) are clamped to 100.
  const r = computeCombinedScore({ techScore: 999, fundScore: 999, swsScore: 999, scannerType: "uniform" });
  assert("scores >100 clamp to 100", r.combinedScore === 100, r.combinedScore);
}
{
  // Out-of-range inputs (<0) are clamped to 0.
  const r = computeCombinedScore({ techScore: -999, fundScore: -999, swsScore: -999, scannerType: "uniform" });
  assert("scores <0 clamp to 0", r.combinedScore === 0, r.combinedScore);
}
{
  // Result is rounded to 1 decimal place.
  const r = computeCombinedScore({ techScore: 33.333, fundScore: 33.333, swsScore: 33.333, scannerType: "uniform" });
  assert("output rounded to 1dp", Number.isFinite(r.combinedScore) && (r.combinedScore * 10) % 1 === 0, r.combinedScore);
}

console.log("\ncomputeCombinedScore — divergence flag\n");

{
  // Spread = 30 > threshold(22) -> divergence true.
  const r = computeCombinedScore({ techScore: 80, fundScore: 50, swsScore: 50, scannerType: "uniform" });
  assert("spread 30 -> divergence true", r.divergence === true, r);
  assert("spread 30 -> divergenceSpread 30", r.divergenceSpread === 30, r.divergenceSpread);
}
{
  // Spread = 22 == threshold -> NOT strictly greater, so divergence false.
  const r = computeCombinedScore({ techScore: 72, fundScore: 50, swsScore: 50, scannerType: "uniform" });
  assert("spread == threshold -> divergence false", r.divergence === false, r);
}
{
  // 2-dim spread is computed (per the inline comment).
  const r = computeCombinedScore({ techScore: 90, swsScore: 10, scannerType: "uniform" });
  assert("2-dim divergence computed", r.divergenceSpread === 80, r.divergenceSpread);
  assert("2-dim wide spread -> divergence true", r.divergence === true, r.divergence);
}

console.log("\ncomputeCombinedScore — unknown scanner falls back to uniform\n");

{
  const r = computeCombinedScore({ techScore: 60, fundScore: 60, swsScore: 60, scannerType: "bogus" });
  // uniform = 1/3 each -> 60.0
  assert("unknown scanner -> uniform output", r.combinedScore === 60, r.combinedScore);
  assert(
    "unknown scanner -> roughly equal weights",
    Math.abs(r.weightsUsed.tech - r.weightsUsed.fund) < 1e-3 &&
      Math.abs(r.weightsUsed.fund - r.weightsUsed.sws) < 1e-3,
    r.weightsUsed,
  );
}

console.log("\ncomputeCombinedScore — monotonicity (raising one dim never lowers result)\n");

{
  const lo = computeCombinedScore({ techScore: 30, fundScore: 50, swsScore: 70, scannerType: "buynow" });
  const hi = computeCombinedScore({ techScore: 90, fundScore: 50, swsScore: 70, scannerType: "buynow" });
  assert("raising techScore -> combinedScore not lower", hi.combinedScore >= lo.combinedScore, { lo: lo.combinedScore, hi: hi.combinedScore });
}
{
  const lo = computeCombinedScore({ techScore: 50, fundScore: 50, swsScore: 50, scannerType: "fund" });
  const hi = computeCombinedScore({ techScore: 50, fundScore: 95, swsScore: 50, scannerType: "fund" });
  assert("raising fundScore -> combinedScore not lower", hi.combinedScore >= lo.combinedScore, { lo: lo.combinedScore, hi: hi.combinedScore });
}
{
  const lo = computeCombinedScore({ techScore: 50, fundScore: 50, swsScore: 10, scannerType: "midterm" });
  const hi = computeCombinedScore({ techScore: 50, fundScore: 50, swsScore: 90, scannerType: "midterm" });
  assert("raising swsScore -> combinedScore not lower", hi.combinedScore >= lo.combinedScore, { lo: lo.combinedScore, hi: hi.combinedScore });
}

console.log("\ncomputeCombinedScore — surveillanceFlag + swsFallback passthrough\n");

{
  const flag = { reason: "ASM-Stage-2" };
  const r = computeCombinedScore({
    techScore: 50, fundScore: 50, swsScore: 50, scannerType: "buynow",
    surveillanceFlag: flag, swsFallback: true,
  });
  assert("surveillanceFlag passes through", r.surveillanceFlag === flag, r.surveillanceFlag);
  assert("swsFallback passes through", r.swsFallback === true, r.swsFallback);
}
{
  // Even on empty-input path the surveillance/fallback state is preserved.
  const r = computeCombinedScore({ surveillanceFlag: { x: 1 }, swsFallback: true });
  assert("empty: surveillanceFlag preserved", r.surveillanceFlag?.x === 1, r.surveillanceFlag);
  assert("empty: swsFallback preserved", r.swsFallback === true, r.swsFallback);
}

console.log("\nbuildCombinedAudit — pure shape transform\n");

{
  const result = computeCombinedScore({ techScore: 60, fundScore: 70, swsScore: 80, scannerType: "midterm" });
  const audit = buildCombinedAudit({
    symbol: "RELIANCE", scannerType: "midterm",
    techScore: 60, fundScore: 70, swsScore: 80,
    result,
  });
  assert("audit.symbol", audit.symbol === "RELIANCE", audit.symbol);
  assert("audit.scanner_type", audit.scanner_type === "midterm", audit.scanner_type);
  assert("audit.methodology_version", audit.methodology_version === METHODOLOGY_VERSION, audit.methodology_version);
  assert(
    "audit.components mirror inputs",
    audit.components.tech === 60 && audit.components.fund === 70 && audit.components.sws === 80,
    audit.components,
  );
  assert("audit.combined_score from result", audit.combined_score === result.combinedScore, audit.combined_score);
  assert("audit.weights_used from result", audit.weights_used === result.weightsUsed, audit.weights_used);
  assert("audit.contributing_dims from result", Array.isArray(audit.contributing_dims) && audit.contributing_dims.length === 3, audit.contributing_dims);
  assert("audit.data_confidence from result", audit.data_confidence === result.dataConfidence, audit.data_confidence);
  assert("audit.divergence is boolean", typeof audit.divergence === "boolean", audit.divergence);
  assert("audit.sws_fallback is boolean", typeof audit.sws_fallback === "boolean", audit.sws_fallback);
  assert("audit.timestamp ISO-ish", /^\d{4}-\d{2}-\d{2}T/.test(audit.timestamp), audit.timestamp);
}

{
  // null-safe defaults: nothing supplied.
  const audit = buildCombinedAudit({});
  assert("null-safe symbol", audit.symbol === null, audit.symbol);
  assert("null-safe scanner_type", audit.scanner_type === null, audit.scanner_type);
  assert("null-safe components", audit.components.tech === null && audit.components.fund === null && audit.components.sws === null, audit.components);
  assert("null-safe weights_used", audit.weights_used === null, audit.weights_used);
  assert("null-safe combined_score", audit.combined_score === null, audit.combined_score);
  assert("null-safe contributing_dims is []", Array.isArray(audit.contributing_dims) && audit.contributing_dims.length === 0, audit.contributing_dims);
  assert("null-safe data_confidence", audit.data_confidence === null, audit.data_confidence);
  assert("null-safe divergence -> false (boolean coerced)", audit.divergence === false, audit.divergence);
  assert("null-safe divergence_spread -> 0", audit.divergence_spread === 0, audit.divergence_spread);
  assert("null-safe sws_fallback -> false", audit.sws_fallback === false, audit.sws_fallback);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
