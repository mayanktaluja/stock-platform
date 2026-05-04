/**
 * Regression tests for taxEngine.computeTaxScenarios — the per-rung tax
 * accounting that powers the "if you trim 25%/33%/50%/66%/100% you keep
 * ₹X net" table in the SWS holding card.
 *
 * Covers:
 *   • LTCG path (≥365 days held, gain) → 12.5% over ₹1.25L exemption
 *   • STCG path (<365 days, gain) → 20% on full gain
 *   • Loss path → tax 0, carry-forward note
 *   • LTCG-budget consumption — proportional rung scaling
 *   • Equity vs ETF asset-class routing
 *   • Default rung set + custom rung override
 *
 * Today is fixed to 2026-05-04 to match the project's date context;
 * purchase dates are chosen to land cleanly in LT vs ST regimes.
 *
 * Run with: node test/taxScenarios.test.mjs
 */

import { computeTaxScenarios, buildFyContext } from "../taxEngine.js";

const TODAY = new Date("2026-05-04T00:00:00Z");

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

// ──────────────────── LTCG path ────────────────────

console.log("\nLTCG (long-term equity, gain)\n");
{
  // Bought ~3 years ago (Apr 2023), held ~3 yrs, current value 3× invested.
  // 100% exit gain = ₹2L. After ₹1.25L FY exemption → ₹75K taxable × 12.5% = ₹9,375 tax.
  const fy = buildFyContext(TODAY, 0, 0);
  const out = computeTaxScenarios({
    investedRupees: 100000,
    currentValueRupees: 300000,
    purchaseDate: "2023-04-15",
    assetClass: "equity",
    fyContext: fy,
    today: TODAY,
  });
  assert("default rungs are 25/33/50/66/100", JSON.stringify(out.map((s) => s.trimPct)) === JSON.stringify([25, 33, 50, 66, 100]), out.map((s) => s.trimPct));
  const r25 = out.find((s) => s.trimPct === 25);
  assert("25% rung gross = ₹75K", r25.grossProceedsRupees === 75000, r25.grossProceedsRupees);
  assert("25% rung gain = ₹50K (within ₹1.25L exemption → 0 tax)", r25.gainRupees === 50000 && r25.taxRupees === 0, r25);
  assert("25% rung regime = ltcg", r25.regime === "ltcg", r25.regime);
  const r100 = out.find((s) => s.trimPct === 100);
  assert("100% rung gross = ₹3L", r100.grossProceedsRupees === 300000, r100.grossProceedsRupees);
  assert("100% rung gain = ₹2L", r100.gainRupees === 200000, r100.gainRupees);
  assert("100% rung tax = ₹9,375 (₹75K taxable × 12.5%)", r100.taxRupees === 9375, r100.taxRupees);
  assert("100% rung net keep = ₹290,625", r100.netProceedsRupees === 290625, r100.netProceedsRupees);
  assert("100% rung isLongTerm true", r100.isLongTerm === true, r100.isLongTerm);
}

// ──────────────────── STCG path ────────────────────

console.log("\nSTCG (short-term equity, gain)\n");
{
  // Bought 6 months ago, current value 1.5× invested. STCG path → 20% on full gain.
  const fy = buildFyContext(TODAY, 0, 0);
  const out = computeTaxScenarios({
    investedRupees: 100000,
    currentValueRupees: 150000,
    purchaseDate: "2025-11-04", // ~182 days ago
    assetClass: "equity",
    fyContext: fy,
    today: TODAY,
  });
  const r50 = out.find((s) => s.trimPct === 50);
  assert("50% rung gain = ₹25K", r50.gainRupees === 25000, r50.gainRupees);
  assert("50% rung tax = ₹5K (20% STCG)", r50.taxRupees === 5000, r50.taxRupees);
  assert("50% rung regime = stcg", r50.regime === "stcg", r50.regime);
  assert("50% rung isLongTerm false", r50.isLongTerm === false, r50.isLongTerm);
  const r100 = out.find((s) => s.trimPct === 100);
  assert("100% rung gain = ₹50K", r100.gainRupees === 50000, r100.gainRupees);
  assert("100% rung tax = ₹10K (20% STCG)", r100.taxRupees === 10000, r100.taxRupees);
  assert("STCG note mentions days-to-LTCG savings",
    r100.notes.some((n) => /Short-term/.test(n) && /LTCG/i.test(n)),
    r100.notes);
}

// ──────────────────── Loss path ────────────────────

console.log("\nLoss path (carry-forward)\n");
{
  // Bought a year ago, current value 0.6× invested. Loss → no tax, carry-fwd note.
  const fy = buildFyContext(TODAY, 0, 0);
  const out = computeTaxScenarios({
    investedRupees: 100000,
    currentValueRupees: 60000,
    purchaseDate: "2025-04-01",
    assetClass: "equity",
    fyContext: fy,
    today: TODAY,
  });
  const r66 = out.find((s) => s.trimPct === 66);
  assert("loss rung tax = 0", r66.taxRupees === 0, r66.taxRupees);
  assert("loss rung regime = loss", r66.regime === "loss", r66.regime);
  assert("loss rung gain is negative", r66.gainRupees < 0, r66.gainRupees);
  assert("loss rung notes mention carry-forward",
    r66.notes.some((n) => /carries forward/i.test(n)),
    r66.notes);
}

// ──────────────────── LTCG-budget consumption ────────────────────

console.log("\nLTCG-budget consumption (FY exemption already partially used)\n");
{
  // Same LTCG holding as before, but ₹1L of LTCG already realised this FY.
  // Remaining exemption = ₹1.25L − ₹1L = ₹25K.
  // 100% exit gain = ₹2L → consumes ₹25K exemption → ₹1.75L taxable × 12.5% = ₹21,875.
  const fy = buildFyContext(TODAY, 100000, 0);
  const out = computeTaxScenarios({
    investedRupees: 100000,
    currentValueRupees: 300000,
    purchaseDate: "2023-04-15",
    assetClass: "equity",
    fyContext: fy,
    today: TODAY,
  });
  const r100 = out.find((s) => s.trimPct === 100);
  assert("LTCG-partial-budget tax = ₹21,875",
    r100.taxRupees === 21875, r100.taxRupees);
  assert("exemption used = ₹25K (the remaining budget)",
    r100.exemptionUsedRupees === 25000, r100.exemptionUsedRupees);
}

// ──────────────────── Custom rung set ────────────────────

console.log("\nCustom rung set\n");
{
  const fy = buildFyContext(TODAY, 0, 0);
  const out = computeTaxScenarios({
    investedRupees: 100000,
    currentValueRupees: 200000,
    purchaseDate: "2023-04-15",
    assetClass: "equity",
    fyContext: fy,
    today: TODAY,
    rungs: [10, 50, 100],
  });
  assert("custom rungs honoured", out.length === 3 && out.map((s) => s.trimPct).join(",") === "10,50,100", out.map((s) => s.trimPct));
}

// ──────────────────── ETF asset class ────────────────────

console.log("\nETF asset class (equity rules apply)\n");
{
  const fy = buildFyContext(TODAY, 0, 0);
  const out = computeTaxScenarios({
    investedRupees: 50000,
    currentValueRupees: 100000,
    purchaseDate: "2023-04-15",
    assetClass: "etf",
    fyContext: fy,
    today: TODAY,
  });
  const r100 = out.find((s) => s.trimPct === 100);
  // ETF gets equity-class LTCG (≥365 days). Gain ₹50K. ₹50K under ₹1.25L
  // exemption → 0 tax. The point: regime should be "ltcg", not "slab_*".
  assert("ETF gain routed to LTCG regime", r100.regime === "ltcg", r100.regime);
  assert("ETF gain under exemption → 0 tax", r100.taxRupees === 0, r100.taxRupees);
}

// ──────────────────── Tax % of gain ────────────────────

console.log("\nTax % of gain\n");
{
  const fy = buildFyContext(TODAY, 0, 0);
  const out = computeTaxScenarios({
    investedRupees: 100000,
    currentValueRupees: 200000,
    purchaseDate: "2025-11-04", // STCG path
    assetClass: "equity",
    fyContext: fy,
    today: TODAY,
  });
  const r50 = out.find((s) => s.trimPct === 50);
  // Gain ₹50K * 20% = ₹10K → 20% of gain
  assert("STCG taxPctOfGain = 20.0", r50.taxPctOfGain === 20.0, r50.taxPctOfGain);
}

// ──────────────────── Summary ────────────────────

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
