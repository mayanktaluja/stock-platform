// Tests for services/multibagger/liquidityGate.js.
// Run: node test/liquidityGate.test.mjs

import assert from "node:assert/strict";
import { evaluateLiquidity, deriveAdvFromSws, LIQUIDITY_GATE_CONFIG } from "../services/multibagger/liquidityGate.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nliquidityGate");

it("config constants are exposed", () => {
  assert.equal(LIQUIDITY_GATE_CONFIG.ADV_MULTIPLE_FLOOR, 5);
  assert.equal(LIQUIDITY_GATE_CONFIG.MIN_ADV_INR, 50_000);
});

it("rejects invalid position size", () => {
  const r = evaluateLiquidity({ position_size_inr: 0, adv_inr_30d: 1_000_000 });
  assert.equal(r.pass, false);
  assert.equal(r.reason, "invalid_position_size");
});

it("rejects when adv is unknown and allow_unknown is false", () => {
  const r = evaluateLiquidity({ position_size_inr: 14_000, adv_inr_30d: null });
  assert.equal(r.pass, false);
  assert.equal(r.reason, "adv_unknown");
});

it("passes when adv is unknown and allow_unknown true", () => {
  const r = evaluateLiquidity({ position_size_inr: 14_000, adv_inr_30d: null, allow_unknown: true });
  assert.equal(r.pass, true);
  assert.equal(r.reason, "adv_unknown_allowed");
});

it("rejects when adv is below absolute floor", () => {
  const r = evaluateLiquidity({ position_size_inr: 5_000, adv_inr_30d: 30_000 });
  assert.equal(r.pass, false);
  assert.equal(r.reason, "adv_below_floor");
});

it("rejects when headroom < 5x position", () => {
  // ₹14k position needs ≥ ₹70k ADV
  const r = evaluateLiquidity({ position_size_inr: 14_000, adv_inr_30d: 50_000 });
  assert.equal(r.pass, false);
  assert.match(r.reason, /lt_5x_position/);
  assert.equal(r.headroom_multiple, 3.57);
});

it("passes when headroom ≥ 5x position", () => {
  // ₹14k position with ₹100k ADV → 7.14x headroom
  const r = evaluateLiquidity({ position_size_inr: 14_000, adv_inr_30d: 100_000 });
  assert.equal(r.pass, true);
  assert.equal(r.reason, "ok");
  assert.equal(r.headroom_multiple, 7.14);
});

it("deriveAdvFromSws multiplies volume × price", () => {
  assert.equal(deriveAdvFromSws({ average_daily_volume_30d: 10_000, last_close_inr: 250 }), 2_500_000);
});

it("deriveAdvFromSws falls back to current_price_inr when last_close_inr missing", () => {
  assert.equal(deriveAdvFromSws({ average_daily_volume_30d: 1000, current_price_inr: 50 }), 50_000);
});

it("deriveAdvFromSws returns null for missing fields", () => {
  assert.equal(deriveAdvFromSws(null), null);
  assert.equal(deriveAdvFromSws({}), null);
  assert.equal(deriveAdvFromSws({ average_daily_volume_30d: 0, last_close_inr: 50 }), null);
  assert.equal(deriveAdvFromSws({ average_daily_volume_30d: 1000, last_close_inr: null }), null);
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
