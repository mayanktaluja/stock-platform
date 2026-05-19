// Tests for services/multibagger/multibaggerBacktest.js + multibaggerWeightTuner.js.
// Run: node test/multibaggerBacktest.test.mjs

import assert from "node:assert/strict";
import { computeBacktest, computeAblation, checkValidationGate } from "../services/multibagger/multibaggerBacktest.js";
import { tuneWeights, checkTuningGate, COMPONENT_KEYS } from "../services/multibagger/multibaggerWeightTuner.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nmultibaggerBacktest");

function makeRow(ticker, entry, fwd, verdict, sector, snapshot, breakdown = {}) {
  return { ticker, entry_price_inr: entry, forward_365d_price_inr: fwd, verdict, sector, snapshot_iso: snapshot, score_0_100: 60, breakdown };
}

it("empty resolved → 0 count, gate not met", () => {
  const r = computeBacktest([]);
  assert.equal(r.resolved_count, 0);
  assert.equal(r.validation_gate.gate_met, false);
});

it("computes bucket hit-rates correctly", () => {
  const rows = [
    makeRow("A", 100, 500, "5X_CANDIDATE", "Renewables", "2025-05-01"), // 5x
    makeRow("B", 100, 300, "HIGH_CONVICTION", "Defense", "2025-05-01"), // 3x
    makeRow("C", 100, 200, "WATCH", "EMS", "2025-05-01"),               // 2x
    makeRow("D", 100, 80, "WATCH", "IT", "2025-05-01"),                 // 0.8x
  ];
  const r = computeBacktest(rows);
  assert.equal(r.resolved_count, 4);
  assert.equal(r.bucket_hit_rates.ge_5x.hits, 1);
  assert.equal(r.bucket_hit_rates.ge_3x.hits, 2);
  assert.equal(r.bucket_hit_rates.ge_2x.hits, 3);
  // D at 0.8x is a 20% loss → below breakeven (1.0x), so only A/B/C clear ge_0pct.
  assert.equal(r.bucket_hit_rates.ge_0pct.hits, 3);
});

it("survivorship warning is always present", () => {
  const r = computeBacktest([makeRow("A", 100, 500, "5X_CANDIDATE", "X", "2025-05-01")]);
  assert.match(r.survivorship_warning, /delisted/i);
});

it("validation gate stays closed without 9mo forward archive", () => {
  const gate = checkValidationGate({ resolved: [1, 2, 3], windows: 1, forward_months_available: 2 });
  assert.equal(gate.gate_met, false);
  assert.match(gate.blocking_reasons.join(" "), /forward_archive_2mo/);
});

it("per-verdict avg multiple computed", () => {
  const rows = [
    makeRow("A", 100, 500, "5X_CANDIDATE", "X", "2025-05-01"),
    makeRow("B", 100, 700, "5X_CANDIDATE", "Y", "2025-05-01"),
  ];
  const r = computeBacktest(rows);
  assert.equal(r.verdict_stats["5X_CANDIDATE"].count, 2);
  assert.equal(r.verdict_stats["5X_CANDIDATE"].avg_multiple, 6);
  assert.equal(r.verdict_stats["5X_CANDIDATE"].five_x_rate_pct, 100);
});

it("ablation reports per-component delta", () => {
  const rows = [
    makeRow("A", 100, 500, "5X_CANDIDATE", "X", "2025-05-01", { inflection: 17, mcap: 10 }),
    makeRow("B", 100, 90, "WATCH", "Y", "2025-05-01", { inflection: 0, mcap: 4 }),
  ];
  const r = computeAblation(rows, ["inflection", "mcap"]);
  assert.ok("inflection" in r.ablation);
  assert.ok("mcap" in r.ablation);
});

console.log("\nmultibaggerWeightTuner");

it("COMPONENT_KEYS has the 10 additive components", () => {
  assert.equal(COMPONENT_KEYS.length, 10);
  assert.ok(COMPONENT_KEYS.includes("inflection"));
  assert.ok(COMPONENT_KEYS.includes("sector_tailwind"));
});

it("tuning gate closed on thin data (expected)", () => {
  const gate = checkTuningGate([makeRow("A", 100, 500, "5X_CANDIDATE", "X", "2025-05-01", { mcap: 10 })]);
  assert.equal(gate.gate_met, false);
  assert.match(gate.blocking_reasons.join(" "), /resolved_1_</);
});

it("tuneWeights returns baseline + candidates, no recommendation when gated", () => {
  const rows = [
    makeRow("A", 100, 500, "5X_CANDIDATE", "X", "2025-05-01", { inflection: 17, mcap: 10, v3_future: 12 }),
    makeRow("B", 100, 90, "WATCH", "Y", "2025-05-01", { inflection: 0, mcap: 4, v3_future: 2 }),
  ];
  const r = tuneWeights(rows);
  assert.equal(r.gate_met, false);
  assert.ok(Array.isArray(r.top_candidates));
  assert.ok(r.top_candidates.length > 0);
  assert.match(r.recommendation, /Gate not met|expected/i);
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
