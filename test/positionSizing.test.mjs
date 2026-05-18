import { strict as assert } from "node:assert";
import {
  SIZING_TIERS,
  computeSizeMultiplier,
  resolveSizingTier,
  resolveCalibratedConfidence,
  buildSizingDecision,
} from "../services/riskLab/positionSizing.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    pass++;
  } catch (err) {
    console.log(`  not ok - ${name}\n      ${err.message}`);
    fail++;
  }
}

// ───────── tier bands ─────────
test("SIZING_TIERS is sorted by min descending", () => {
  for (let i = 0; i < SIZING_TIERS.length - 1; i++) {
    assert.ok(SIZING_TIERS[i].min > SIZING_TIERS[i + 1].min, "tiers not strictly descending at " + i);
  }
});
test("SIZING_TIERS multipliers descend with confidence", () => {
  for (let i = 0; i < SIZING_TIERS.length - 1; i++) {
    assert.ok(SIZING_TIERS[i].multiplier >= SIZING_TIERS[i + 1].multiplier);
  }
});

// ───────── computeSizeMultiplier ─────────
test("computeSizeMultiplier returns null for non-numeric input", () => {
  assert.equal(computeSizeMultiplier(null), null);
  assert.equal(computeSizeMultiplier(undefined), null);
  assert.equal(computeSizeMultiplier(NaN), null);
  assert.equal(computeSizeMultiplier("65"), null);
});
test("computeSizeMultiplier band edges", () => {
  assert.equal(computeSizeMultiplier(100), 1.0, "100 → 1.0x");
  assert.equal(computeSizeMultiplier(65), 1.0, "65 → 1.0x (lower-bound inclusive)");
  assert.equal(computeSizeMultiplier(64.99), 0.6, "64.99 → 0.6x (drops to next tier)");
  assert.equal(computeSizeMultiplier(48), 0.6, "48 → 0.6x");
  assert.equal(computeSizeMultiplier(47.99), 0.3, "47.99 → 0.3x");
  assert.equal(computeSizeMultiplier(40), 0.3, "40 → 0.3x");
  assert.equal(computeSizeMultiplier(39.99), 0.2, "39.99 → 0.2x");
  assert.equal(computeSizeMultiplier(0), 0.2, "0 → 0.2x (floor)");
});
test("computeSizeMultiplier clamps out-of-range", () => {
  assert.equal(computeSizeMultiplier(150), 1.0);
  assert.equal(computeSizeMultiplier(-10), 0.2);
});

// ───────── resolveSizingTier ─────────
test("resolveSizingTier returns the matching tier", () => {
  const tier = resolveSizingTier(48);
  assert.ok(tier);
  assert.equal(tier.multiplier, 0.6);
  assert.equal(tier.label, "Reduced size");
});
test("resolveSizingTier returns null for non-numeric", () => {
  assert.equal(resolveSizingTier(null), null);
  assert.equal(resolveSizingTier("48"), null);
});

// ───────── resolveCalibratedConfidence ─────────
test("resolveCalibratedConfidence prefers lab_view.quality_adjusted_confidence", () => {
  const e = {
    prediction: { confidence_pct: 65 },
    lab_view: { quality_adjusted_confidence: 48 },
  };
  assert.equal(resolveCalibratedConfidence(e), 48);
});
test("resolveCalibratedConfidence falls back to production confidence_pct", () => {
  const e = { prediction: { confidence_pct: 65 } };
  assert.equal(resolveCalibratedConfidence(e), 65);
});
test("resolveCalibratedConfidence handles missing/null lab", () => {
  const e = { prediction: { confidence_pct: 65 }, lab_view: { quality_adjusted_confidence: null } };
  assert.equal(resolveCalibratedConfidence(e), 65);
});
test("resolveCalibratedConfidence returns null when nothing present", () => {
  assert.equal(resolveCalibratedConfidence({}), null);
  assert.equal(resolveCalibratedConfidence(null), null);
});

// ───────── buildSizingDecision ─────────
test("buildSizingDecision: KEC-style downgrade — 65% prod, 48% lab", () => {
  const e = {
    prediction: { confidence_pct: 65 },
    lab_view: { quality_adjusted_confidence: 48 },
  };
  const d = buildSizingDecision(e);
  assert.equal(d.production_confidence_pct, 65);
  assert.equal(d.calibrated_confidence_pct, 48);
  assert.equal(d.effective_confidence_pct, 48);
  assert.equal(d.multiplier, 0.6);
  assert.equal(d.source, "lab_calibrated");
});
test("buildSizingDecision: no lab → production confidence used", () => {
  const e = { prediction: { confidence_pct: 65 } };
  const d = buildSizingDecision(e);
  assert.equal(d.effective_confidence_pct, 65);
  assert.equal(d.multiplier, 1.0);
  assert.equal(d.source, "production_only");
});
test("buildSizingDecision: returns null when no confidence anywhere", () => {
  assert.equal(buildSizingDecision({}), null);
  assert.equal(buildSizingDecision({ prediction: {} }), null);
});
test("buildSizingDecision: schema versioned for downstream consumers", () => {
  const d = buildSizingDecision({ prediction: { confidence_pct: 50 } });
  assert.equal(d.schema_version, "sizing-v1");
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
