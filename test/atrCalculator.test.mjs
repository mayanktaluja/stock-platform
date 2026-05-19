// Tests for services/multibagger/atrCalculator.js.
// Run: node test/atrCalculator.test.mjs

import assert from "node:assert/strict";
import { computeATR, atrStopPrice, tierStopPrice } from "../services/multibagger/atrCalculator.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\natrCalculator");

it("returns null for empty / too-small input", () => {
  assert.equal(computeATR([]), null);
  assert.equal(computeATR(null), null);
  assert.equal(computeATR([{ high: 1, low: 0, close: 0.5 }]), null);
});

it("computes TR correctly across H/L and prevClose-gap paths", () => {
  const bars = [
    { high: 100, low: 95, close: 98 },
    { high: 102, low: 99, close: 101 }, // TR = max(3, |102-98|=4, |99-98|=1) = 4
    { high: 95, low: 90, close: 92 },   // TR = max(5, |95-101|=6, |90-101|=11) = 11
  ];
  assert.equal(computeATR(bars, 90), 7.5);
});

it("uses only last N bars when array longer than period", () => {
  const bars = Array.from({ length: 100 }, (_, i) => ({
    high: 100 + i,
    low: 100 + i - 1,
    close: 100 + i - 0.5,
  }));
  // Each TR = max(hl=1, |high-prevClose|=1.5, |low-prevClose|=0.5) = 1.5
  assert.equal(computeATR(bars, 90), 1.5);
});

it("rejects non-finite high/low silently", () => {
  const bars = [
    { high: 100, low: 95, close: 98 },
    { high: NaN, low: 99, close: 101 },
    { high: 102, low: 100, close: 101 },
  ];
  // First TR rejected (NaN high), only second TR computed.
  const atr = computeATR(bars);
  assert.equal(atr, 2); // 102-100 = 2
});

it("atrStopPrice returns null for invalid inputs", () => {
  assert.equal(atrStopPrice(0, 5), null);
  assert.equal(atrStopPrice(100, 0), null);
  assert.equal(atrStopPrice(100, 5, 0), null);
  assert.equal(atrStopPrice(NaN, 5), null);
  // Stop below zero → null
  assert.equal(atrStopPrice(10, 5, 100), null);
});

it("atrStopPrice computes entry - 2.5 × ATR", () => {
  assert.equal(atrStopPrice(100, 4), 90); // 100 - 2.5*4 = 90
  assert.equal(atrStopPrice(100, 4, 3), 88);
});

it("tierStopPrice returns wider of ATR-stop and 35% floor", () => {
  // ATR stop 90 > 35% floor 65 → returns 65 (more permissive)
  assert.equal(tierStopPrice({ entryPrice: 100, atr: 4 }), 65);
  // ATR stop 50 < 35% floor 65 → returns 50 (more permissive)
  assert.equal(tierStopPrice({ entryPrice: 100, atr: 20 }), 50);
});

it("tierStopPrice falls back to absolute floor when atr missing", () => {
  assert.equal(tierStopPrice({ entryPrice: 100, atr: null }), 65);
  assert.equal(tierStopPrice({ entryPrice: 100, atr: NaN }), 65);
});

it("tierStopPrice respects custom floor", () => {
  assert.equal(tierStopPrice({ entryPrice: 100, atr: 2, absoluteFloorPct: 0.20 }), 80);
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
