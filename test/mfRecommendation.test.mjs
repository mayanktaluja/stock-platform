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

// ──────────────────── 2. Quant Small Cap → HOLD (offline gate, Priority 1) ──
//
// PRE-Priority-1 behavior: Quant Small Cap with -7.67% Groww XIRR fired SWITCH.
// POST-Priority-1: with only `groww_xirr` available (no AMFI metrics), the
// action is gated to HOLD with INSUFFICIENT_DATA_FOR_SWITCH. The XIRR_NEGATIVE
// observation chip is preserved so the user still sees the underlying concern,
// but the recommender doesn't act on a duration-mismatched signal.
console.log("Priority 1: Quant Small Cap (groww_xirr only) → HOLD with data-quality gate:");
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
  assert("Offline → HOLD (action gated, was SWITCH/EXIT pre-P1)", r.action === "HOLD", r.action);
  assert("Confidence = LOW (gate downgrades the call)", r.confidence === "LOW", r.confidence);
  assert("INSUFFICIENT_DATA_FOR_SWITCH chip surfaces", r.reasons.some((x) => x.code === "INSUFFICIENT_DATA_FOR_SWITCH"), r.reasons.map((x) => x.code));
  assert("XIRR_DURATION_MISMATCH chip surfaces", r.reasons.some((x) => x.code === "XIRR_DURATION_MISMATCH"), r.reasons.map((x) => x.code));
  // Underlying observation preserved so the user still sees the concern
  assert("XIRR_NEGATIVE preserved as observation", r.reasons.some((x) => x.code === "XIRR_NEGATIVE"), r.reasons.map((x) => x.code));
  assert("factors.actionGated=true", r.factors.actionGated === true, r.factors.actionGated);
}
console.log();

// ── 2b. With AMFI metrics, the same fund WOULD fire SWITCH ──
console.log("Priority 1: With AMFI metrics, gate releases and SWITCH fires:");
{
  const quantWithAmfi = {
    name: "Quant Small Cap Fund Direct Plan Growth",
    folio: "51082967565",
    category: "Equity",
    subCategory: "Small Cap",
    invested: 112501,
    currentValue: 103423,
    publishedXirrPct: -7.67,
    amc: "Quant Mutual Fund",
    metrics: {
      // AMFI 3y CAGR is the apples-to-apples comparison vs the 5y benchmark
      cagr3yPct: -2.5,
      cagr1yPct: -10,
      cagr5yPct: 8,
      sharpe3y: 0.1,
      maxDrawdownPct: -38,
      annualVolPct: 22,
      asOfDate: TODAY,
      historyDays: 1500,
    },
  };
  const r = recommendForPosition(quantWithAmfi, { overlap: detectOverlap([quantWithAmfi]), today: TODAY });
  assert("AMFI 3y CAGR → action gate releases", r.factors.actionGated === false, r.factors.actionGated);
  assert("AMFI present → action ∈ {EXIT, SWITCH} (not HOLD)", ["EXIT", "SWITCH"].includes(r.action), r.action);
  assert("Source recorded as amfi_3y", r.factors.trailingXirrSource === "amfi_3y", r.factors.trailingXirrSource);
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

// Bonus: failing scheme + dupe folio
//
// PRE-Priority-1: SWITCH/EXIT preempted CONSOLIDATE (a failing scheme is
// the headline; folio hygiene is secondary).
// POST-Priority-1: with only `groww_xirr`, SWITCH/EXIT is gated to HOLD,
// so the CONSOLIDATE path on the dupe folio surfaces instead. A reasonable
// fallback — the recommender can't act on a misleading return signal but
// can still suggest folio cleanup.
console.log("Priority 1: gated SWITCH falls back to CONSOLIDATE on dupe folio:");
{
  const book = [
    { name: "Axis ELSS Tax Saver Direct Plan Growth", folio: "F_LOSER_A", category: "Equity", subCategory: "ELSS", invested: 100000, currentValue: 95000, publishedXirrPct: -5 },
    { name: "Axis ELSS Tax Saver Direct Plan Growth", folio: "F_LOSER_B", category: "Equity", subCategory: "ELSS", invested: 50000, currentValue: 47000, publishedXirrPct: -5 },
  ];
  const overlap = detectOverlap(book);
  const r = recommendForPosition(book[1], { overlap, today: TODAY });
  // Without AMFI, SWITCH/EXIT is gated. The original SWITCH/EXIT was based on
  // groww_xirr, so it gets downgraded — and CONSOLIDATE/HOLD is acceptable.
  assert("Gated dupe folio → HOLD or CONSOLIDATE (NOT SWITCH/EXIT)", !["SWITCH", "EXIT"].includes(r.action), r.action);
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

// ──────────────────── 5. Top-performer (offline) → HOLD (gated) ──
//
// Pre-P1: ADD fired. Post-P1: ADD is gated when only groww_xirr is the
// signal — the same duration mismatch that produces false SWITCHes
// produces false ADDs in the other direction.
console.log("Priority 1: top performer (offline) gated to HOLD:");
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
  assert("Top performer (groww_xirr only) → HOLD (was ADD pre-P1)", r.action === "HOLD", r.action);
  assert("XIRR_TOP_QUARTILE observation preserved", r.reasons.some((x) => x.code === "XIRR_TOP_QUARTILE"), r.reasons.map((x) => x.code));
  assert("INSUFFICIENT_DATA_FOR_SWITCH chip surfaces", r.reasons.some((x) => x.code === "INSUFFICIENT_DATA_FOR_SWITCH"), r.reasons.map((x) => x.code));
}
console.log();

// ──────────────────── 5b. Top performer WITH AMFI metrics → ADD ──
console.log("With AMFI metrics, top performer fires ADD:");
{
  const star = {
    name: "Mirae Asset ELSS Tax Saver Fund Direct Growth",
    folio: "77760343603",
    category: "Equity", subCategory: "ELSS",
    invested: 134993, currentValue: 171052,
    publishedXirrPct: 19.5,
    amc: "Mirae Asset Mutual Fund",
    metrics: { cagr3yPct: 19.5, cagr1yPct: 22, cagr5yPct: 18, sharpe3y: 0.9, maxDrawdownPct: -25, asOfDate: TODAY, historyDays: 1500 },
  };
  const r = recommendForPosition(star, { overlap: detectOverlap([star]), today: TODAY });
  assert("AMFI cagr3y → ADD fires (gate released)", r.action === "ADD", r.action);
}
console.log();

// ──────────────────── 6. Top-performer in CROWDED category → HOLD ──
console.log("HOLD when top performer is in crowded category:");
{
  const book = [
    { name: "Mirae Asset ELSS Tax Saver Fund Direct Growth", folio: "F1", category: "Equity", subCategory: "ELSS", invested: 100000, currentValue: 130000, publishedXirrPct: 19.5 },
    { name: "Axis ELSS Tax Saver Direct Plan Growth", folio: "F2", category: "Equity", subCategory: "ELSS", invested: 100000, currentValue: 110000, publishedXirrPct: 8 },
    { name: "UTI ELSS Tax Saver Fund Direct Growth", folio: "F3", category: "Equity", subCategory: "ELSS", invested: 100000, currentValue: 108000, publishedXirrPct: 7 },
  ];
  const overlap = detectOverlap(book);
  const star = recommendForPosition(book[0], { overlap, today: TODAY });
  assert("Top performer in crowded ELSS book → HOLD", star.action === "HOLD", star.action);
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

  // Action mix sanity (Priority 1: offline → HOLD/CONSOLIDATE only)
  const mix = out.actionMix;
  console.log("    actionMix:", JSON.stringify(mix));
  assert("Priority 1: no SWITCH/EXIT/ADD when only groww_xirr available",
    !mix.SWITCH && !mix.EXIT && !mix.ADD,
    mix);
  assert("Only HOLD + CONSOLIDATE actions in offline mode",
    Object.keys(mix).every((k) => k === "HOLD" || k === "CONSOLIDATE"),
    Object.keys(mix));

  // Both Quant Small Cap folios surface as HOLD with the data-quality gate
  const quants = out.positions.filter((p) => /quant.*small/i.test(p.name));
  assert("Both Quant Small Cap folios surface", quants.length === 2, quants.length);
  for (const q of quants) {
    assert(`Quant ${q.folio} action = HOLD (gated)`, q.rec.action === "HOLD", q.rec.action);
    assert(`Quant ${q.folio} carries INSUFFICIENT_DATA_FOR_SWITCH chip`,
      q.rec.reasons.some((r) => r.code === "INSUFFICIENT_DATA_FOR_SWITCH"),
      q.rec.reasons.map((r) => r.code));
  }

  // Duplicate Axis ELSS still detected (CONSOLIDATE is not gated)
  const axisFolios = out.positions.filter((p) => /axis ELSS/i.test(p.name));
  assert("Both Axis ELSS folios surface", axisFolios.length === 2, axisFolios.length);
  const consolidateAxis = axisFolios.filter((p) => p.rec.action === "CONSOLIDATE");
  assert("Smaller Axis folio → CONSOLIDATE (1 of the 2)", consolidateAxis.length === 1, consolidateAxis.map((p) => p.folio));
  // Priority 4: ELSS CONSOLIDATEs carry the lock-in assumption disclosure
  for (const c of consolidateAxis) {
    assert(`Axis ELSS CONSOLIDATE ${c.folio} carries LOCK_IN_ASSUMED_CLEAR`,
      c.rec.reasons.some((r) => r.code === "LOCK_IN_ASSUMED_CLEAR"),
      c.rec.reasons.map((r) => r.code));
  }

  // Overlap signal
  assert("duplicateFolioCount >= 2 (Axis dupes + UTI dupes + Quant dupes)", out.overlap.duplicateFolioCount >= 2, out.overlap.duplicateFolioCount);

  // Priority 2: asset allocation block surfaces structural concerns
  assert("assetAllocation block present", !!out.assetAllocation, !!out.assetAllocation);
  assert("Book detected as 100% equity", out.assetAllocation.summary.equityPct === 100, out.assetAllocation.summary.equityPct);
  assert("Concentration flag for missing debt", out.assetAllocation.summary.concentrationFlags.some((f) => /equity.*no.*debt/i.test(f)), out.assetAllocation.summary.concentrationFlags);
  assert("Mid+small overweight flag", out.assetAllocation.summary.concentrationFlags.some((f) => /mid.*small/i.test(f)), out.assetAllocation.summary.concentrationFlags);

  // Priority 3: risk profile defaults to absent
  assert("riskProfile.present = false (no profile saved)", out.riskProfile.present === false, out.riskProfile);
}
console.log();

// ──────────────────── 9. Priority 5: peer reconciliation ──
//
// Bandhan Small Cap and Quant Small Cap both held; without AMFI both fall
// to HOLD via the offline gate, so the peer-exclusion path can't trigger.
// Use AMFI-shaped synthetic metrics so both fire SWITCH and the cross-
// exclusion is exercised.
console.log("Priority 5: same-book SWITCH-OUT excluded from sibling peer list:");
{
  const book = [
    {
      name: "Quant Small Cap Fund Direct Plan Growth",
      folio: "F1", category: "Equity", subCategory: "Small Cap",
      invested: 100000, currentValue: 92000, publishedXirrPct: -5,
      amc: "Quant Mutual Fund",
      metrics: { cagr3yPct: -2.5, cagr5yPct: 8, sharpe3y: 0.05, maxDrawdownPct: -40, asOfDate: TODAY, historyDays: 1500 },
    },
    {
      name: "Bandhan Small Cap Fund Direct Growth",
      folio: "F2", category: "Equity", subCategory: "Small Cap",
      invested: 100000, currentValue: 105000, publishedXirrPct: 1.3,
      amc: "Bandhan Mutual Fund",
      metrics: { cagr3yPct: 5, cagr5yPct: 12, sharpe3y: 0.3, maxDrawdownPct: -30, asOfDate: TODAY, historyDays: 1500 },
    },
  ];
  const out = recommendBook(book, { today: TODAY });
  const bandhan = out.positions.find((p) => /bandhan/i.test(p.name));
  assert("Bandhan position present", !!bandhan, bandhan);
  if (bandhan) {
    const peerNames = (bandhan.rec.peerCandidates || []).map((c) => c.name.toLowerCase());
    assert("Peer list does NOT contain Quant Small Cap (excluded by book)",
      !peerNames.some((n) => /quant.*small/i.test(n)),
      peerNames);
    if (bandhan.rec.factors.peerExclusionCount > 0) {
      assert("PEER_EXCLUDED_SAME_BOOK chip surfaces when an exclusion happened",
        bandhan.rec.reasons.some((r) => r.code === "PEER_EXCLUDED_SAME_BOOK"),
        bandhan.rec.reasons.map((r) => r.code));
    }
  }
}
console.log();

// ──────────────────── 10. Priority 3: risk-profile alignment chips ──
console.log("Priority 3: small-cap fund tagged TOO_AGGRESSIVE for CONSERVATIVE profile:");
{
  const conservativeProfile = { bucket: "CONSERVATIVE", score: 3, completedAt: TODAY };
  const smallCap = {
    name: "Quant Small Cap Fund Direct Plan Growth",
    folio: "F1", category: "Equity", subCategory: "Small Cap",
    invested: 100000, currentValue: 105000, publishedXirrPct: 8,
    amc: "Quant Mutual Fund",
  };
  const out = recommendBook([smallCap], { today: TODAY, riskProfile: conservativeProfile });
  const p = out.positions[0];
  assert("riskAlignment = TOO_AGGRESSIVE for small-cap on conservative profile",
    p.rec.factors.riskAlignment === "TOO_AGGRESSIVE", p.rec.factors.riskAlignment);
  assert("riskProfile echoed back on the book",
    out.riskProfile.bucket === "CONSERVATIVE", out.riskProfile);
  assert("assetAllocation targetSource = user_profile (not default)",
    out.assetAllocation.targetSource === "user_profile", out.assetAllocation.targetSource);
}
console.log();

// ──────────────────── Summary ────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
