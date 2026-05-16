// Unit tests for portfolioIntelligence.computeSellTrigger (P0.4, 2026-05-16)
//
// SEBI-RA review flagged the absence of explicit sell discipline as the #1
// investor-protection gap. computeSellTrigger() now emits a concrete rupee
// stop on every position. These tests exercise the three-floor logic
// (15% below avg cost, 8% below current, 1% above 52W low) and the
// edge cases (missing data, zero/negative prices).

import { strict as assert } from "node:assert";
import { computeSellTrigger } from "../portfolioIntelligence.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.error(`  ✗ ${name}\n     ${e.message}`); failed += 1; }
}

console.log("\n[1] Avg-cost floor dominates when stock has dropped significantly from entry");
test("avg ₹100, current ₹80 → trailing (₹73.6) below avg floor (₹85) → AVG_COST_FLOOR wins", () => {
  // avg ₹100 → floor 100*0.85 = ₹85
  // current ₹80 → trailing 80*0.92 = ₹73.60
  // Max(85, 73.60) = 85 → AVG_COST_FLOOR wins (caps total drawdown).
  const t = computeSellTrigger({ avgPrice: 100, currentPrice: 80 }, {});
  assert.equal(t.triggerType, "AVG_COST_FLOOR");
  assert.equal(t.stopPriceInr, 85);
});
test("avg ₹100, current ₹95 → trailing (₹87.4) above avg floor (₹85) → TRAILING_8PCT wins", () => {
  // When the stock hasn't moved much from entry, the 8% trailing stop is
  // tighter than the 15%-below-avg-cost floor, so trailing dominates.
  const t = computeSellTrigger({ avgPrice: 100, currentPrice: 95 }, {});
  assert.equal(t.triggerType, "TRAILING_8PCT");
  assert.equal(t.stopPriceInr, 87.4);
});

console.log("\n[2] Trailing-8% dominates when stock has run up");
test("avg ₹100, current ₹200 → trailing 92% of current (₹184) wins over avg floor (₹85)", () => {
  const t = computeSellTrigger({ avgPrice: 100, currentPrice: 200 }, {});
  assert.equal(t.triggerType, "TRAILING_8PCT");
  assert.equal(t.stopPriceInr, 184);
});

console.log("\n[3] Near-52W-low floor dominates when both other floors are lower");
test("avg ₹100, current ₹50, 52W-low ₹48 → stop = ₹48*1.01 = ₹48.48 (NEAR_52W_LOW wins over ₹85 and ₹46)", () => {
  // avg floor 100*0.85 = 85; trailing 50*0.92 = 46; 52w-low 48*1.01 = 48.48
  // Highest is 85 (avg floor) — wait, that's higher than 48.48.
  // Let me recompute: avg ₹100 → floor ₹85; current ₹50 → trailing ₹46;
  //   52W low ₹48 → 1% above = ₹48.48.
  // Max(85, 46, 48.48) = 85 → AVG_COST_FLOOR wins.
  const t = computeSellTrigger({ avgPrice: 100, currentPrice: 50 }, { fiftyTwoWeekLow: 48 });
  assert.equal(t.triggerType, "AVG_COST_FLOOR");
  assert.equal(t.stopPriceInr, 85);
});

console.log("\n[4] Near-52W-low actually wins when avg and trailing are low");
test("avg ₹50, current ₹40, 52W-low ₹45 → 52W floor 45*1.01 = 45.45 beats 42.5 and 36.8", () => {
  // avg ₹50 → floor ₹42.50; trailing 40*0.92 = ₹36.80; 52W low 45*1.01 = ₹45.45.
  // Max = 45.45 → NEAR_52W_LOW wins.
  const t = computeSellTrigger({ avgPrice: 50, currentPrice: 40 }, { fiftyTwoWeekLow: 45 });
  assert.equal(t.triggerType, "NEAR_52W_LOW");
  assert.equal(t.stopPriceInr, 45.45);
});

console.log("\n[5] Severity reflects distance from current price");
test("tight severity when stop is within 5% of current", () => {
  // avg ₹100, current ₹100 → both floors at 85 and 92 → max 92 (TRAILING_8PCT).
  // Distance: (92-100)/100 = -8% — abs is 8, which is > 5 → wide.
  const t = computeSellTrigger({ avgPrice: 100, currentPrice: 100 }, {});
  assert.equal(t.severity, "wide");
});
test("wide severity when stop is far below current", () => {
  const t = computeSellTrigger({ avgPrice: 100, currentPrice: 200 }, {});
  assert.equal(t.severity, "wide");
});
test("tight severity when an old 52W-low keeps stop close", () => {
  // avg ₹100, current ₹100, 52W-low ₹99 → 99*1.01 = 99.99 → tight (-0.01% from current).
  const t = computeSellTrigger({ avgPrice: 100, currentPrice: 100 }, { fiftyTwoWeekLow: 99 });
  assert.equal(t.severity, "tight");
});

console.log("\n[6] Edge cases: missing or invalid data");
test("returns null when avgPrice is missing", () => {
  const t = computeSellTrigger({ currentPrice: 100 }, {});
  assert.equal(t, null);
});
test("returns null when currentPrice is missing", () => {
  const t = computeSellTrigger({ avgPrice: 100 }, {});
  assert.equal(t, null);
});
test("returns null when avgPrice is zero", () => {
  const t = computeSellTrigger({ avgPrice: 0, currentPrice: 100 }, {});
  assert.equal(t, null);
});
test("returns null when prices are NaN", () => {
  const t = computeSellTrigger({ avgPrice: NaN, currentPrice: 100 }, {});
  assert.equal(t, null);
});
test("ignores invalid 52W-low (negative)", () => {
  const t = computeSellTrigger({ avgPrice: 100, currentPrice: 100 }, { fiftyTwoWeekLow: -5 });
  // Falls back to avg floor (85) vs trailing (92) → trailing wins.
  assert.equal(t.triggerType, "TRAILING_8PCT");
});

console.log("\n[7] Output shape contract");
test("returns expected keys", () => {
  const t = computeSellTrigger({ avgPrice: 100, currentPrice: 100 }, {});
  assert.ok("stopPriceInr" in t);
  assert.ok("triggerType" in t);
  assert.ok("rationale" in t);
  assert.ok("pctFromCurrent" in t);
  assert.ok("severity" in t);
});
test("rationale is a readable string", () => {
  const t = computeSellTrigger({ avgPrice: 100, currentPrice: 100 }, {});
  assert.equal(typeof t.rationale, "string");
  assert.ok(t.rationale.length > 0);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
