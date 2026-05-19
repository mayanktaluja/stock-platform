// Tests for services/paperTrade/trajectoryTracker.js.
// Run: node test/trajectoryTracker.test.mjs

import assert from "node:assert/strict";
import {
  applyTax,
  requiredGrossMultiple,
  projectTrajectory,
  simulatePofTargetMultiple,
  TRAJECTORY_CONFIG,
} from "../services/paperTrade/trajectoryTracker.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\ntrajectoryTracker");

it("config exposes 5× target + STCG/LTCG rates", () => {
  assert.equal(TRAJECTORY_CONFIG.TARGET_MULTIPLE, 5);
  assert.equal(TRAJECTORY_CONFIG.STCG_RATE, 0.20);
  assert.equal(TRAJECTORY_CONFIG.LTCG_RATE, 0.125);
  assert.equal(TRAJECTORY_CONFIG.LTCG_EXEMPTION_INR, 125_000);
});

it("applyTax passes through losses", () => {
  assert.equal(applyTax({ gross_pl_inr: -10_000 }), -10_000);
});

it("applyTax applies STCG/LTCG mix to gains", () => {
  // 4L gross gain, 50/50 mix: STCG 2L × 0.20 = 40k; LTCG 2L − 1.25L = 75k × 0.125 = 9.375k
  // Tax = 49,375; Net = 4L − 49,375 = 350,625
  const net = applyTax({ gross_pl_inr: 400_000, stcg_share: 0.5 });
  assert.equal(net, 350_625);
});

it("requiredGrossMultiple ≥ 5× under STCG churn", () => {
  const r = requiredGrossMultiple({ starting_capital_inr: 100_000, target_multiple: 5, stcg_share: 1.0 });
  assert.ok(r > 5, `expected >5×, got ${r}`);
  // With 100% STCG: net = gross × 0.8; for net 5L we need gross 6.25L → 6.25× starting
  assert.ok(r >= 5.9 && r <= 6.3);
});

it("requiredGrossMultiple with full LTCG (12m hold) closer to 5×", () => {
  const r = requiredGrossMultiple({ starting_capital_inr: 100_000, target_multiple: 5, stcg_share: 0.0 });
  // 100% LTCG: 5L gross gain, LTCG taxable = 5L − 1.25L = 3.75L × 0.125 = 46.875k tax
  // Net = 5L − 46.875k = 453,125 (well below 4L net target); so need gross > 5L
  // Actually solving: gross × (1 - 0.125) + 0.125 × 1.25L = 4L (target net = 4L)
  // gross = (4L - 15.625k) / 0.875 = 4.398L → 5.4× starting
  assert.ok(r >= 5.0 && r <= 5.6);
});

it("projectTrajectory computes current multiple + status", () => {
  const r = projectTrajectory({
    starting_capital_inr: 100_000,
    current_value_inr: 150_000,
    started_at_iso: "2026-05-20",
    today_iso: "2026-08-20", // 92 days in
  });
  assert.equal(r.current_multiple, 1.5);
  assert.equal(r.days_elapsed, 92);
  assert.equal(r.days_remaining, 273);
  assert.ok(["ON_TRACK", "AHEAD", "BEHIND"].includes(r.status));
});

it("simulatePofTargetMultiple returns finite probability", () => {
  const r = simulatePofTargetMultiple({
    starting_capital_inr: 100_000,
    cash_inr: 5_000,
    positions: [
      { ticker: "A", current_value_inr: 12_000 },
      { ticker: "B", current_value_inr: 14_000 },
      { ticker: "C", current_value_inr: 8_000 },
    ],
    seed: 42,
    n_sims: 500,
  });
  assert.ok(r.p_target_multiple >= 0 && r.p_target_multiple <= 1);
  assert.ok(r.mean_final_inr > 0);
  assert.ok(r.p10_final_inr <= r.p50_final_inr);
  assert.ok(r.p50_final_inr <= r.p90_final_inr);
  assert.equal(r.n_sims, 500);
});

it("Monte Carlo is deterministic with same seed", () => {
  const args = {
    starting_capital_inr: 100_000,
    cash_inr: 5_000,
    positions: [{ ticker: "A", current_value_inr: 30_000 }],
    seed: 12345,
    n_sims: 200,
  };
  const r1 = simulatePofTargetMultiple(args);
  const r2 = simulatePofTargetMultiple(args);
  assert.equal(r1.p_target_multiple, r2.p_target_multiple);
  assert.equal(r1.mean_final_inr, r2.mean_final_inr);
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
