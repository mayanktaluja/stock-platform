// Tests for services/multibagger/riskManager.js.
// Run: node test/riskManager.test.mjs

import assert from "node:assert/strict";
import {
  initialStopPrice,
  trailingStopPrice,
  evaluatePosition,
  evaluatePortfolioRisk,
  TIER_STOPS,
  CIRCUIT_BREAKERS,
} from "../services/multibagger/riskManager.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nriskManager");

it("config: tier stop policies", () => {
  assert.equal(TIER_STOPS.anchor.absolute_floor_pct, 0.35);
  assert.equal(TIER_STOPS.high.atr_mult, 2.5);
  assert.equal(TIER_STOPS.conviction.absolute_floor_pct, 0.25);
  assert.equal(TIER_STOPS.catalyst.absolute_floor_pct, 0.08);
  assert.equal(TIER_STOPS.sector.absolute_floor_pct, 0.20);
});

it("config: circuit breakers", () => {
  assert.equal(CIRCUIT_BREAKERS.PAUSE_ENTRIES, 0.25);
  assert.equal(CIRCUIT_BREAKERS.TRIM_CATALYST_SECTOR, 0.35);
  assert.equal(CIRCUIT_BREAKERS.FAILSAFE_NIFTYBEES, 0.40);
});

it("initialStopPrice: Anchor without ATR → 35% floor", () => {
  assert.equal(initialStopPrice({ entry_price_inr: 100, tier: "anchor" }), 65);
});

it("initialStopPrice: Anchor with ATR uses wider of ATR-band and 35% floor", () => {
  // ATR 4 × 2.5 = 10 from entry → stop at 90 > 35% floor 65 → uses 65
  assert.equal(initialStopPrice({ entry_price_inr: 100, tier: "anchor", atr: 4 }), 65);
  // ATR 20 × 2.5 = 50 from entry → stop at 50 < 35% floor 65 → uses 50
  assert.equal(initialStopPrice({ entry_price_inr: 100, tier: "anchor", atr: 20 }), 50);
});

it("initialStopPrice: Conviction tier never uses ATR even if supplied", () => {
  assert.equal(initialStopPrice({ entry_price_inr: 100, tier: "conviction", atr: 20 }), 75);
});

it("initialStopPrice: Catalyst tier -8%", () => {
  assert.equal(initialStopPrice({ entry_price_inr: 100, tier: "catalyst" }), 92);
});

it("initialStopPrice: unknown tier → null", () => {
  assert.equal(initialStopPrice({ entry_price_inr: 100, tier: "unknown" }), null);
});

it("trailingStopPrice: position at +50% raises stop to -10% from entry", () => {
  const r = trailingStopPrice({ entry_price_inr: 100, peak_price_inr: 150, tier: "anchor" });
  assert.equal(r.stop_price_inr, 90);
  assert.match(r.band_label, /\+50%_entry/);
});

it("trailingStopPrice: position at +100% trails -30% from peak", () => {
  const r = trailingStopPrice({ entry_price_inr: 100, peak_price_inr: 200, tier: "anchor" });
  assert.equal(r.stop_price_inr, 140);
});

it("trailingStopPrice: position at +200% trails -35% from peak", () => {
  const r = trailingStopPrice({ entry_price_inr: 100, peak_price_inr: 300, tier: "anchor" });
  assert.equal(r.stop_price_inr, 195);
});

it("trailingStopPrice: position at +500% trails -40% from peak + trim 50%", () => {
  const r = trailingStopPrice({ entry_price_inr: 100, peak_price_inr: 600, tier: "anchor" });
  assert.equal(r.stop_price_inr, 360);
  assert.equal(r.recommended_trim_pct, 0.5);
});

it("trailingStopPrice: underwater → returns initial stop", () => {
  const r = trailingStopPrice({ entry_price_inr: 100, peak_price_inr: 80, tier: "anchor" });
  assert.equal(r.stop_price_inr, 65);
  assert.equal(r.band_label, "underwater");
});

it("evaluatePosition: stop breach → exit_stop", () => {
  const r = evaluatePosition({
    entry_price_inr: 100,
    current_price_inr: 60,
    peak_price_inr: 100,
    tier: "anchor",
  });
  assert.equal(r.breached, true);
  assert.equal(r.action, "exit_stop");
});

it("evaluatePosition: stop intact at +500% band → trim_50pct, not breached", () => {
  // peak 600 → stop 360. Current 400 is above stop.
  const r = evaluatePosition({
    entry_price_inr: 100,
    current_price_inr: 400,
    peak_price_inr: 600,
    tier: "anchor",
  });
  assert.equal(r.breached, false);
  assert.match(r.action, /trim_50pct/);
  assert.equal(r.gain_pct, 300);
});

it("evaluatePortfolioRisk: GREEN under 25% drawdown", () => {
  const r = evaluatePortfolioRisk({ current_value_inr: 85_000, peak_value_inr: 100_000 });
  assert.equal(r.state, "GREEN");
  assert.equal(r.drawdown_pct, -15);
});

it("evaluatePortfolioRisk: YELLOW at -25%", () => {
  const r = evaluatePortfolioRisk({ current_value_inr: 75_000, peak_value_inr: 100_000 });
  assert.equal(r.state, "YELLOW");
  assert.ok(r.actions.includes("pause_new_entries_7d"));
});

it("evaluatePortfolioRisk: AMBER at -35%", () => {
  const r = evaluatePortfolioRisk({ current_value_inr: 65_000, peak_value_inr: 100_000 });
  assert.equal(r.state, "AMBER");
  assert.ok(r.actions.includes("liquidate_catalyst_and_sector_tilt"));
});

it("evaluatePortfolioRisk: RED at -40% → failsafe", () => {
  const r = evaluatePortfolioRisk({ current_value_inr: 60_000, peak_value_inr: 100_000 });
  assert.equal(r.state, "RED");
  assert.ok(r.actions.includes("failsafe_pivot_to_niftybees_and_cash"));
});

it("evaluatePortfolioRisk: flash crash flag fires on -10% single day", () => {
  const r = evaluatePortfolioRisk({ current_value_inr: 89_000, peak_value_inr: 100_000, daily_pl_pct: -11 });
  assert.ok(r.actions.includes("flash_crash_audit_flag"));
  assert.ok(r.actions.includes("freeze_entries_48h"));
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
