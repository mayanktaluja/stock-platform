// Tests for services/multibagger/sectorTailwindMap.js.
// Run: node test/sectorTailwindMap.test.mjs

import assert from "node:assert/strict";
import { computeSectorTailwind, SECTOR_TAILWIND_CONFIG } from "../services/multibagger/sectorTailwindMap.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nsectorTailwindMap");

it("config exposes constants", () => {
  assert.equal(SECTOR_TAILWIND_CONFIG.MAX_PTS, 17);
  assert.equal(SECTOR_TAILWIND_CONFIG.BASE_WEIGHTS.Defense, 17);
  assert.equal(SECTOR_TAILWIND_CONFIG.BASE_WEIGHTS.Renewables, 16);
});

it("Defense in RISK_ON with low TTM → near max points", () => {
  const r = computeSectorTailwind({
    sector: "Defense",
    macroRegime: { regime: "RISK_ON" },
    ttmReturnPct: 20,
  });
  assert.equal(r.pts, 17);
  assert.equal(r.cohort_exhausted, false);
});

it("Defense with TTM > 80% → zero pts (cohort exhausted)", () => {
  const r = computeSectorTailwind({
    sector: "Defense",
    macroRegime: { regime: "RISK_ON" },
    ttmReturnPct: 100,
  });
  assert.equal(r.pts, 0);
  assert.equal(r.cohort_exhausted, true);
  assert.match(r.reasons.join(" "), /cohort_exhausted/);
});

it("Defense with TTM 50% (warm) → 8.5 pts (17 × 0.5)", () => {
  const r = computeSectorTailwind({
    sector: "Defense",
    macroRegime: { regime: "RISK_ON" },
    ttmReturnPct: 50,
  });
  assert.equal(r.pts, 8.5);
  assert.equal(r.cohort_freshness, 0.5);
});

it("RATE_HIKE drops Defense to 60%", () => {
  const r = computeSectorTailwind({
    sector: "Defense",
    macroRegime: { regime: "RATE_HIKE" },
    ttmReturnPct: 20,
  });
  // 17 × 0.6 × 1.0 = 10.2
  assert.equal(r.pts, 10.2);
  assert.equal(r.regime_multiplier, 0.6);
});

it("RATE_CUT boosts Capital Goods 1.2×", () => {
  const r = computeSectorTailwind({
    sector: "Capital Goods",
    macroRegime: { regime: "RATE_CUT" },
    ttmReturnPct: 20,
  });
  // 12 × 1.2 × 1.0 = 14.4
  assert.equal(r.pts, 14.4);
});

it("RISK_OFF caps most sectors at 0.5×", () => {
  const r = computeSectorTailwind({
    sector: "Defense",
    macroRegime: { regime: "RISK_OFF" },
    ttmReturnPct: 20,
  });
  // 17 × 0.8 × 1.0 = 13.6 (Defense gets special 0.8 in RISK_OFF)
  assert.equal(r.pts, 13.6);
});

it("RISK_OFF leaves Pharma untouched", () => {
  const r = computeSectorTailwind({
    sector: "Pharma",
    macroRegime: { regime: "RISK_OFF" },
    ttmReturnPct: 20,
  });
  assert.equal(r.pts, 7);
});

it("unknown sector falls back to base 5", () => {
  const r = computeSectorTailwind({
    sector: "PetCare",
    macroRegime: { regime: "RISK_ON" },
    ttmReturnPct: null,
  });
  assert.equal(r.base_weight, 5);
  assert.equal(r.pts, 5);
});

it("null TTM treats sector as fresh (full base × regime)", () => {
  const r = computeSectorTailwind({
    sector: "Defense",
    macroRegime: { regime: "RISK_ON" },
    ttmReturnPct: null,
  });
  assert.equal(r.pts, 17);
  assert.equal(r.cohort_freshness, 1.0);
});

it("missing regime falls back to multiplier 1.0", () => {
  const r = computeSectorTailwind({
    sector: "Defense",
    macroRegime: null,
    ttmReturnPct: 20,
  });
  assert.equal(r.regime_multiplier, 1.0);
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
