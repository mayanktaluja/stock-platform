/**
 * Regression tests for mfRecommendation.js + holdingsOverlap.js
 *
 * Run with: node test/mfRecommendation.test.mjs
 *
 * Acceptance criteria from the plan:
 *   • Quant Small Cap (-7.67% / -7.54%) → EXIT or SWITCH (NOT HOLD)
 *   • 5 ELSS folios across 3 schemes → CONSOLIDATE flagged where dupes exist
 *   • Multiple folios same scheme → CONSOLIDATE
 *   • Top-quartile fund → HOLD (or ADD if category not crowded)
 *   • Below-benchmark fund with no peer alternative → HOLD with caution
 *   • Folio overlap correctly counted
 *
 * Pure decision-tree tests against synthetic + real-shaped inputs (the real
 * book from Mutual_Funds_3540358892_24-04-2026.xlsx is reproduced inline
 * so the test file is self-contained).
 */

import { recommendForPosition, recommendBook } from "../mfRecommendation.js";
import { detectOverlap } from "../holdingsOverlap.js";

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

const TODAY = "2026-04-25";

console.log("mfRecommendation.js regression\n");

// ──────────────────── 1. holdingsOverlap.js ────────────────────
console.log("holdingsOverlap.detectOverlap:");
{
  const book = [
    { name: "Axis ELSS Tax Saver Direct Plan Growth", folio: "910159279896", category: "Equity", subCategory: "ELSS", invested: 99995, currentValue: 111360, publishedXirrPct: 4.93 },
    { name: "Axis ELSS Tax Saver Direct Plan Growth", folio: "910171385823", category: "Equity", subCategory: "ELSS", invested: 24999, currentValue: 33734, publishedXirrPct: 11.62 },
    { name: "UTI ELSS Tax Saver Fund Direct Growth", folio: "577357920391", category: "Equity", subCategory: "ELSS", invested: 24999, currentValue: 32997, publishedXirrPct: 10.72 },
    { name: "UTI ELSS Tax Saver Fund Direct Growth", folio: "577351285391", category: "Equity", subCategory: "ELSS", invested: 104995, currentValue: 115384, publishedXirrPct: 4.18 },
    { name: "Mirae Asset ELSS Tax Saver Fund Direct Growth", folio: "77760343603", category: "Equity", subCategory: "ELSS", invested: 134993, currentValue: 171052, publishedXirrPct: 10.12 },
  ];
  const o = detectOverlap(book);
  assert("Axis ELSS detected as duplicate (2 folios)", o.folioDuplicates["Axis ELSS Tax Saver Direct Plan Growth"]?.length === 2, o.folioDuplicates);
  assert("UTI ELSS detected as duplicate (2 folios)", o.folioDuplicates["UTI ELSS Tax Saver Fund Direct Growth"]?.length === 2, o.folioDuplicates);
  assert("duplicateFolioCount = 2 (Axis +1, UTI +1)", o.duplicateFolioCount === 2, o.duplicateFolioCount);
  assert("ELSS category flagged overweight (3 distinct funds)", o.overweightCategories.some((c) => c.categoryKey === "elss" && c.fundCount === 3), o.overweightCategories);

  // Per-fund overlap reverse index
  assert("Axis folio 910159… knows it has a sibling", o.perFundOverlap["910159279896"]?.isDuplicate === true, o.perFundOverlap["910159279896"]);
  assert("Mirae has no duplicate", o.perFundOverlap["77760343603"]?.isDuplicate === false, o.perFundOverlap["77760343603"]);
  assert("Axis folio sees 2 ELSS category peers (UTI x2 + Mirae)", (o.perFundOverlap["910159279896"]?.categoryPeers || []).length >= 2, o.perFundOverlap["910159279896"]?.categoryPeers);
}
console.log();

// ──────────────────── 2. Quant Small Cap → EXIT/SWITCH (acceptance) ──
console.log("ACCEPTANCE: Quant Small Cap loser → EXIT or SWITCH:");
{
  const quant = {
    name: "Quant Small Cap Fund Direct Plan Growth",
    folio: "51082967565",
    category: "Equity",
    subCategory: "Small Cap",
    invested: 112501,
    currentValue: 103423,
    publishedXirrPct: -7.67,
    pnlPercent: -8.07,
    amc: "Quant Mutual Fund",
  };
  const r = recommendForPosition(quant, { overlap: detectOverlap([quant]), today: TODAY });
  assert("Quant Small Cap (-7.67%) → NOT HOLD", r.action !== "HOLD", r.action);
  assert("Quant Small Cap → EXIT or SWITCH", ["EXIT", "SWITCH"].includes(r.action), r.action);
  assert("Confidence = HIGH (negative XIRR + clear signal)", r.confidence === "HIGH", r.confidence);
  assert("Reason includes XIRR_NEGATIVE", r.reasons.some((x) => x.code === "XIRR_NEGATIVE"), r.reasons.map((x) => x.code));
  // If SWITCH, peer must NOT be Quant (same-AMC excluded)
  if (r.action === "SWITCH") {
    assert("SWITCH peer is not Quant AMC", !r.peerCandidates.some((c) => /quant/i.test(c.name)), r.peerCandidates.map((c) => c.name));
  }
}
console.log();

// ──────────────────── 3. CONSOLIDATE for duplicate folios ──
//
// Note: CONSOLIDATE only fires when the SCHEME is HOLD-quality
// (within ±3pp of category benchmark). If the scheme is failing,
// SWITCH/EXIT preempts — telling the RA to "consolidate two losing
// folios" misses the real fix. So this test uses XIRR=13 (within
// ELSS benchmark 13.5% ±3pp) to genuinely isolate the CONSOLIDATE path.
console.log("CONSOLIDATE for duplicate folios (HOLD-quality scheme):");
{
  const book = [
    { name: "Axis ELSS Tax Saver Direct Plan Growth", folio: "BIG_FOLIO", category: "Equity", subCategory: "ELSS", invested: 200000, currentValue: 230000, publishedXirrPct: 13 },
    { name: "Axis ELSS Tax Saver Direct Plan Growth", folio: "SMALL_FOLIO", category: "Equity", subCategory: "ELSS", invested: 50000, currentValue: 55000, publishedXirrPct: 13 },
  ];
  const overlap = detectOverlap(book);
  const small = recommendForPosition(book[1], { overlap, today: TODAY });
  const big = recommendForPosition(book[0], { overlap, today: TODAY });
  assert("Smaller folio → CONSOLIDATE", small.action === "CONSOLIDATE", small.action);
  assert("Smaller folio's consolidateTo points at BIG_FOLIO", small.consolidateTo?.folio === "BIG_FOLIO", small.consolidateTo);
  assert("Bigger folio → NOT CONSOLIDATE (it's the target)", big.action !== "CONSOLIDATE", big.action);
}
console.log();

// Bonus: failing scheme + dupe folio → SWITCH/EXIT preempts CONSOLIDATE
console.log("SWITCH preempts CONSOLIDATE on failing scheme:");
{
  const book = [
    { name: "Axis ELSS Tax Saver Direct Plan Growth", folio: "F_LOSER_A", category: "Equity", subCategory: "ELSS", invested: 100000, currentValue: 95000, publishedXirrPct: -5 },
    { name: "Axis ELSS Tax Saver Direct Plan Growth", folio: "F_LOSER_B", category: "Equity", subCategory: "ELSS", invested: 50000, currentValue: 47000, publishedXirrPct: -5 },
  ];
  const overlap = detectOverlap(book);
  const r = recommendForPosition(book[1], { overlap, today: TODAY });
  assert("Failing dupe folio → SWITCH or EXIT, NOT CONSOLIDATE", ["SWITCH", "EXIT"].includes(r.action), r.action);
}
console.log();

// ──────────────────── 4. HOLD for fund within ±3pp of benchmark ──
console.log("HOLD when within ±3pp of category benchmark:");
{
  const inLine = {
    name: "Parag Parikh Flexi Cap Fund Direct Growth",
    folio: "15593087",
    category: "Equity", subCategory: "Flexi Cap",
    invested: 219989, currentValue: 233763,
    publishedXirrPct: 13.5, // benchmark ~14%, within tolerance
    pnlPercent: 6.26,
    amc: "PPFAS Mutual Fund",
  };
  const r = recommendForPosition(inLine, { overlap: detectOverlap([inLine]), today: TODAY });
  assert("Within-benchmark fund → HOLD", r.action === "HOLD", r.action);
  assert("Confidence = HIGH (clear signal)", r.confidence === "HIGH", r.confidence);
}
console.log();

// ──────────────────── 5. Top-performer with empty category → ADD ──
console.log("ADD when top performer + uncrowded category:");
{
  const star = {
    name: "Mirae Asset ELSS Tax Saver Fund Direct Growth",
    folio: "77760343603",
    category: "Equity", subCategory: "ELSS",
    invested: 134993, currentValue: 171052,
    publishedXirrPct: 19.5, // benchmark 13.5%, +6pp
    pnlPercent: 26.71,
    amc: "Mirae Asset Mutual Fund",
  };
  const r = recommendForPosition(star, { overlap: detectOverlap([star]), today: TODAY });
  assert("Top performer (alone in category) → ADD", r.action === "ADD", r.action);
  assert("Reason includes XIRR_TOP_QUARTILE", r.reasons.some((x) => x.code === "XIRR_TOP_QUARTILE"), r.reasons.map((x) => x.code));
}
console.log();

// ──────────────────── 6. Top-performer in CROWDED category → HOLD (not ADD) ──
console.log("HOLD when top performer is in crowded category:");
{
  const book = [
    { name: "Mirae Asset ELSS Tax Saver Fund Direct Growth", folio: "F1", category: "Equity", subCategory: "ELSS", invested: 100000, currentValue: 130000, publishedXirrPct: 19.5 },
    { name: "Axis ELSS Tax Saver Direct Plan Growth", folio: "F2", category: "Equity", subCategory: "ELSS", invested: 100000, currentValue: 110000, publishedXirrPct: 8 },
    { name: "UTI ELSS Tax Saver Fund Direct Growth", folio: "F3", category: "Equity", subCategory: "ELSS", invested: 100000, currentValue: 108000, publishedXirrPct: 7 },
  ];
  const overlap = detectOverlap(book);
  const star = recommendForPosition(book[0], { overlap, today: TODAY });
  assert("Top performer in crowded ELSS book → HOLD (not ADD)", star.action === "HOLD", star.action);
  assert("Reason mentions CATEGORY_CONCENTRATION", star.reasons.some((x) => x.code === "CATEGORY_CONCENTRATION"), star.reasons.map((x) => x.code));
}
console.log();

// ──────────────────── 7. Missing XIRR → HOLD with LOW confidence ──
console.log("Missing XIRR → HOLD/LOW:");
{
  const noData = {
    name: "Some New Fund Direct Growth",
    folio: "F99",
    category: "Equity", subCategory: "Mid Cap",
    invested: 50000, currentValue: 50000,
    publishedXirrPct: null,
  };
  const r = recommendForPosition(noData, { overlap: detectOverlap([noData]), today: TODAY });
  assert("No XIRR → HOLD", r.action === "HOLD", r.action);
  assert("No XIRR → LOW confidence", r.confidence === "LOW", r.confidence);
  assert("Reason MISSING_DATA surfaced", r.reasons.some((x) => x.code === "MISSING_DATA"), r.reasons.map((x) => x.code));
}
console.log();

// ──────────────────── 8. recommendBook on the REAL book ──
console.log("recommendBook on the real Mayank Taluja book (11 folios):");
{
  const realBook = [
    { name: "Axis ELSS Tax Saver Direct Plan Growth", folio: "910159279896", category: "Equity", subCategory: "ELSS", invested: 99995.02, currentValue: 111359.87, publishedXirrPct: 4.93, pnlPercent: 11.36 },
    { name: "Quant Small Cap Fund Direct Plan Growth", folio: "51082967565", category: "Equity", subCategory: "Small Cap", invested: 112501.58, currentValue: 103422.9, publishedXirrPct: -7.67, pnlPercent: -8.07 },
    { name: "HDFC Mid Cap Fund Direct Growth", folio: "31525914", category: "Equity", subCategory: "Mid Cap", invested: 269986.44, currentValue: 288429.9, publishedXirrPct: 4.09, pnlPercent: 6.83 },
    { name: "UTI ELSS Tax Saver Fund Direct Growth", folio: "577357920391", category: "Equity", subCategory: "ELSS", invested: 24998.69, currentValue: 32996.63, publishedXirrPct: 10.72, pnlPercent: 31.99 },
    { name: "Bandhan Small Cap Fund Direct Growth", folio: "5008422", category: "Equity", subCategory: "Small Cap", invested: 269986.44, currentValue: 275863.2, publishedXirrPct: 1.32, pnlPercent: 2.18 },
    { name: "UTI ELSS Tax Saver Fund Direct Growth", folio: "577351285391", category: "Equity", subCategory: "ELSS", invested: 104994.59, currentValue: 115383.85, publishedXirrPct: 4.18, pnlPercent: 9.89 },
    { name: "Axis ELSS Tax Saver Direct Plan Growth", folio: "910171385823", category: "Equity", subCategory: "ELSS", invested: 24998.77, currentValue: 33733.88, publishedXirrPct: 11.62, pnlPercent: 34.94 },
    { name: "Nippon India Large Cap Fund Direct Growth", folio: "477359028343", category: "Equity", subCategory: "Large Cap", invested: 229988.51, currentValue: 234490.33, publishedXirrPct: 1.18, pnlPercent: 1.96 },
    { name: "Parag Parikh Flexi Cap Fund Direct Growth", folio: "15593087", category: "Equity", subCategory: "Flexi Cap", invested: 219989.05, currentValue: 233762.9, publishedXirrPct: 3.76, pnlPercent: 6.26 },
    { name: "Mirae Asset ELSS Tax Saver Fund Direct Growth", folio: "77760343603", category: "Equity", subCategory: "ELSS", invested: 134993.29, currentValue: 171052.21, publishedXirrPct: 10.12, pnlPercent: 26.71 },
    { name: "Quant Small Cap Fund Direct Plan Growth", folio: "51082967626", category: "Equity", subCategory: "Small Cap", invested: 104445.43, currentValue: 96206.3, publishedXirrPct: -7.54, pnlPercent: -7.89 },
  ];
  const out = recommendBook(realBook, { today: TODAY });
  assert("11 positions in output", out.positions.length === 11, out.positions.length);

  // Action mix sanity
  const mix = out.actionMix;
  console.log("    actionMix:", JSON.stringify(mix));
  const actionable = (mix.EXIT || 0) + (mix.SWITCH || 0) + (mix.CONSOLIDATE || 0) + (mix.ADD || 0);
  assert("At least 4 actionable items (was: 1 in old optimizer)", actionable >= 4, actionable);

  // Both Quant Small Cap folios EXIT/SWITCH
  const quants = out.positions.filter((p) => /quant.*small/i.test(p.name));
  assert("Both Quant Small Cap folios surface", quants.length === 2, quants.length);
  for (const q of quants) {
    assert(`Quant ${q.folio} action ∈ {EXIT, SWITCH}`, ["EXIT", "SWITCH"].includes(q.rec.action), q.rec.action);
  }

  // Duplicate Axis ELSS detected
  const axisFolios = out.positions.filter((p) => /axis ELSS/i.test(p.name));
  assert("Both Axis ELSS folios surface", axisFolios.length === 2, axisFolios.length);
  const consolidateAxis = axisFolios.filter((p) => p.rec.action === "CONSOLIDATE");
  assert("Smaller Axis folio → CONSOLIDATE (1 of the 2)", consolidateAxis.length === 1, consolidateAxis.map((p) => p.folio));

  // Overlap signal
  assert("duplicateFolioCount >= 2 (Axis dupes + UTI dupes + Quant dupes)", out.overlap.duplicateFolioCount >= 2, out.overlap.duplicateFolioCount);

  // Sort: actionable items first
  const firstAction = out.positions[0].rec.action;
  assert("First position is actionable (EXIT/SWITCH/CONSOLIDATE)", ["EXIT", "SWITCH", "CONSOLIDATE", "ADD"].includes(firstAction), firstAction);
}
console.log();

// ──────────────────── Summary ────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
