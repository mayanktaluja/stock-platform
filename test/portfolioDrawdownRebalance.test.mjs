// Unit tests for computeDrawdownInfo (P1.1) + computeRebalanceSuggestion (P1.2).
//
// Both are pure functions added in 2026-05-16 to surface the two
// investor-protection numbers that paid Indian-equity-research platforms
// typically don't show: max-drawdown-from-52W-high (per pick) and an
// explicit "trim X from Y% to Z%, sell ~₹A" suggestion (per holding).

import { strict as assert } from "node:assert";
import {
  computeDrawdownInfo,
  computeRebalanceSuggestion,
} from "../portfolioIntelligence.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.error(`  ✗ ${name}\n     ${e.message}`); failed += 1; }
}

console.log("\n[1] computeDrawdownInfo — severity bands");
test("near 52W high (down <5%) → mild + 'Near 52W high' narrative", () => {
  const d = computeDrawdownInfo({ currentPrice: 1800 }, { fiftyTwoWeekHigh: 1830 });
  assert.equal(d.drawdown_severity, "mild");
  assert.match(d.narrative, /Near 52W high/);
});
test("down 10% → mild", () => {
  const d = computeDrawdownInfo({ currentPrice: 90 }, { fiftyTwoWeekHigh: 100 });
  assert.equal(d.drawdown_severity, "mild");
});
test("down 20% → moderate", () => {
  const d = computeDrawdownInfo({ currentPrice: 80 }, { fiftyTwoWeekHigh: 100 });
  assert.equal(d.drawdown_severity, "moderate");
});
test("down 35% → deep", () => {
  const d = computeDrawdownInfo({ currentPrice: 65 }, { fiftyTwoWeekHigh: 100 });
  assert.equal(d.drawdown_severity, "deep");
});
test("down 55% → severe", () => {
  const d = computeDrawdownInfo({ currentPrice: 45 }, { fiftyTwoWeekHigh: 100 });
  assert.equal(d.drawdown_severity, "severe");
});

console.log("\n[2] computeDrawdownInfo — position in range");
test("at midpoint of range → 50%", () => {
  const d = computeDrawdownInfo({ currentPrice: 75 }, { fiftyTwoWeekHigh: 100, fiftyTwoWeekLow: 50 });
  assert.equal(d.position_in_52w_range_pct, 50);
});
test("missing low → position_in_range null", () => {
  const d = computeDrawdownInfo({ currentPrice: 75 }, { fiftyTwoWeekHigh: 100 });
  assert.equal(d.position_in_52w_range_pct, null);
});

console.log("\n[3] computeDrawdownInfo — edge cases");
test("returns null with no quote", () => { assert.equal(computeDrawdownInfo({ currentPrice: 100 }, null), null); });
test("returns null with no currentPrice", () => { assert.equal(computeDrawdownInfo({}, { fiftyTwoWeekHigh: 100 }), null); });
test("returns null with zero high", () => { assert.equal(computeDrawdownInfo({ currentPrice: 100 }, { fiftyTwoWeekHigh: 0 }), null); });

console.log("\n[4] computeRebalanceSuggestion — threshold");
test("weight <=15% returns null (no rebalance)", () => {
  assert.equal(computeRebalanceSuggestion({ symbol: "A", investedValue: 100000 }, 12), null);
  assert.equal(computeRebalanceSuggestion({ symbol: "A", investedValue: 100000 }, 15), null);
});
test("weight 22% → elevated severity + trim narrative", () => {
  const r = computeRebalanceSuggestion({ symbol: "RELIANCE", investedValue: 220000 }, 22);
  assert.equal(r.severity, "elevated");
  assert.equal(r.target_weight_pct, 15);
  assert.equal(r.current_weight_pct, 22);
  // sell_inr = 220000 * (7/22) = 70000
  assert.equal(r.sell_inr, 70000);
  assert.match(r.narrative, /Trim RELIANCE from 22\.0% → 15%/);
});
test("weight 30% → severe severity", () => {
  const r = computeRebalanceSuggestion({ symbol: "TCS", investedValue: 300000 }, 30);
  assert.equal(r.severity, "severe");
  assert.match(r.narrative, /severe concentration risk/);
});

console.log("\n[5] computeRebalanceSuggestion — edge cases");
test("returns null with no investedValue", () => {
  assert.equal(computeRebalanceSuggestion({ symbol: "A" }, 22), null);
});
test("returns null with zero investedValue", () => {
  assert.equal(computeRebalanceSuggestion({ symbol: "A", investedValue: 0 }, 22), null);
});
test("returns null with NaN weight", () => {
  assert.equal(computeRebalanceSuggestion({ symbol: "A", investedValue: 100000 }, NaN), null);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
