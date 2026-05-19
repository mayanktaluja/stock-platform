// Tests for services/multibagger/regimeGate.js.
// Run: node test/regimeGate.test.mjs

import assert from "node:assert/strict";
import { evaluateRegime, pillarsOpen, REGIME_GATE_CONFIG } from "../services/multibagger/regimeGate.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nregimeGate");

it("config exposes blocked regimes + severity threshold", () => {
  assert.ok(REGIME_GATE_CONFIG.BLOCKED_REGIMES.includes("RISK_OFF"));
  assert.equal(REGIME_GATE_CONFIG.HIGH_SEVERITY, 4);
  assert.equal(REGIME_GATE_CONFIG.SMALLCAP_DRAWDOWN_FLOOR_PCT, -10);
});

it("passes on a benign regime", () => {
  const r = evaluateRegime({ macroRegime: { regime: "RATE_CUT", severity: 2 }, tier: "high" });
  assert.equal(r.pass, true);
  assert.deepEqual(r.reasons, []);
});

it("blocks all entries on RISK_OFF", () => {
  const r = evaluateRegime({ macroRegime: { regime: "RISK_OFF", severity: 3 }, tier: "high" });
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /regime_risk_off_blocked/);
});

it("normalises regime to upper case", () => {
  const r = evaluateRegime({ macroRegime: { regime: "risk_off", severity: 1 }, tier: "high" });
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /regime_risk_off_blocked/);
});

it("blocks Anchor + High tiers at severity ≥ 4", () => {
  const rAnchor = evaluateRegime({ macroRegime: { regime: "RATE_HIKE", severity: 5 }, tier: "anchor" });
  const rHigh = evaluateRegime({ macroRegime: { regime: "RATE_HIKE", severity: 5 }, tier: "high" });
  const rConv = evaluateRegime({ macroRegime: { regime: "RATE_HIKE", severity: 5 }, tier: "conviction" });
  assert.equal(rAnchor.pass, false);
  assert.equal(rHigh.pass, false);
  assert.equal(rConv.pass, true); // Conviction unaffected by severity
});

it("blocks Pillar 1 on deep smallcap drawdown", () => {
  const r = evaluateRegime({
    macroRegime: { regime: "RATE_CUT", severity: 2 },
    smallcap_90d_return_pct: -15,
    tier: "high",
  });
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /smallcap_90d_return_-15pct_below_floor/);
});

it("smallcap-floor check skipped when value is null", () => {
  const r = evaluateRegime({
    macroRegime: { regime: "RATE_CUT", severity: 2 },
    smallcap_90d_return_pct: null,
    tier: "high",
  });
  assert.equal(r.pass, true);
});

it("flags regime_unknown for null macroRegime", () => {
  const r = evaluateRegime({ macroRegime: null, tier: "high" });
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /regime_unknown/);
});

it("pillarsOpen: all open under benign regime", () => {
  const map = pillarsOpen({ macroRegime: { regime: "RATE_CUT", severity: 2 } });
  for (const key of Object.keys(map)) {
    assert.equal(map[key].open, true, `${key} should be open`);
  }
});

it("pillarsOpen: blocks Anchor + High under severity 5; lower pillars stay open", () => {
  const map = pillarsOpen({ macroRegime: { regime: "RATE_HIKE", severity: 5 } });
  assert.equal(map.pillar1_anchor.open, false);
  assert.equal(map.pillar1_high.open, false);
  assert.equal(map.pillar1_conviction.open, true);
  assert.equal(map.pillar2_catalyst.open, true);
  assert.equal(map.pillar3_sector.open, true);
});

it("pillarsOpen: blocks every pillar under RISK_OFF", () => {
  const map = pillarsOpen({ macroRegime: { regime: "RISK_OFF", severity: 3 } });
  for (const key of Object.keys(map)) {
    assert.equal(map[key].open, false, `${key} should be blocked`);
  }
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
