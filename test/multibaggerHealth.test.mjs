// Tests for services/multibagger/multibaggerHealth.js.
// Run: node test/multibaggerHealth.test.mjs

import assert from "node:assert/strict";
import { buildHealthSummary, formatHealthOneLiner, HEALTH_CONFIG } from "../services/multibagger/multibaggerHealth.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nmultibaggerHealth");

const NOW = "2026-05-20T00:00:00Z";

it("config: thresholds", () => {
  assert.equal(HEALTH_CONFIG.STALE_MACRO_HOURS, 36);
  assert.equal(HEALTH_CONFIG.PIPELINE_THIN_THRESHOLD, 5);
});

it("counts HIGH_CONVICTION+ candidates correctly", () => {
  const r = buildHealthSummary({
    candidates: [
      { verdict: "5X_CANDIDATE" }, { verdict: "5X_CANDIDATE" }, { verdict: "HIGH_CONVICTION" },
      { verdict: "WATCH" }, { verdict: "PASS" }, { verdict: "HARD_REJECT" },
    ],
    now_iso: NOW,
  });
  assert.equal(r.metrics.high_conviction_count, 3);
});

it("alerts when pipeline is thin", () => {
  const r = buildHealthSummary({
    candidates: [{ verdict: "5X_CANDIDATE" }, { verdict: "HIGH_CONVICTION" }],
    now_iso: NOW,
  });
  assert.ok(r.alerts.some((a) => /Pipeline thin/i.test(a)));
});

it("alerts on stale macro regime", () => {
  const r = buildHealthSummary({
    macroRegime: { generatedAt: "2026-05-17T00:00:00Z" }, // 72h old
    candidates: Array.from({ length: 10 }, () => ({ verdict: "HIGH_CONVICTION" })),
    now_iso: NOW,
  });
  assert.ok(r.alerts.some((a) => /Macro regime is/i.test(a)));
});

it("alerts on missing macro regime", () => {
  const r = buildHealthSummary({ macroRegime: null, candidates: [], now_iso: NOW });
  assert.ok(r.alerts.some((a) => /Macro regime file missing/i.test(a)));
});

it("alerts on portfolio YELLOW/AMBER/RED state", () => {
  for (const state of ["YELLOW", "AMBER", "RED"]) {
    const r = buildHealthSummary({
      candidates: Array.from({ length: 10 }, () => ({ verdict: "HIGH_CONVICTION" })),
      portfolio_risk: { state, drawdown_pct: -30 },
      now_iso: NOW,
    });
    assert.ok(r.alerts.some((a) => a.includes(state)), `expected ${state} alert`);
  }
});

it("alerts when regime gate just closed for Pillar 1", () => {
  const r = buildHealthSummary({
    candidates: Array.from({ length: 10 }, () => ({ verdict: "HIGH_CONVICTION" })),
    previous_regime_open: { pillar1_anchor: { open: true } },
    current_regime_open: { pillar1_anchor: { open: false } },
    now_iso: NOW,
  });
  assert.ok(r.alerts.some((a) => /Regime gate CLOSED/i.test(a)));
});

it("alerts on orphaned decision log", () => {
  const r = buildHealthSummary({
    candidates: Array.from({ length: 10 }, () => ({ verdict: "HIGH_CONVICTION" })),
    last_decision_ts_iso: "2026-03-01T00:00:00Z", // 80d ago
    now_iso: NOW,
  });
  assert.ok(r.alerts.some((a) => /Decision log idle/i.test(a)));
});

it("formatHealthOneLiner returns a single-line string", () => {
  const r = buildHealthSummary({
    candidates: Array.from({ length: 10 }, () => ({ verdict: "HIGH_CONVICTION" })),
    portfolio_risk: { state: "GREEN", drawdown_pct: -5 },
    now_iso: NOW,
  });
  const line = formatHealthOneLiner(r);
  assert.ok(line.includes("GREEN"));
  assert.ok(!line.includes("\n"));
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
