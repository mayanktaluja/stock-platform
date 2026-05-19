// Tests for services/multibagger/inflectionDetector.js.
// Run: node test/inflectionDetector.test.mjs

import assert from "node:assert/strict";
import { scoreInflection, INFLECTION_CONFIG } from "../services/multibagger/inflectionDetector.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\ninflectionDetector");

it("config exposes max score", () => {
  assert.equal(INFLECTION_CONFIG.MAX_SCORE, 17);
});

it("returns 0 with no_history reason on empty input", () => {
  const r = scoreInflection({ yearly_history: [] });
  assert.equal(r.score, 0);
  assert.deepEqual(r.reasons, ["no_history"]);
});

it("returns 0 with insufficient_history on single year", () => {
  const r = scoreInflection({ yearly_history: [{ year: 2025, netIncome: 100 }] });
  assert.equal(r.score, 0);
  assert.match(r.reasons[0], /insufficient_history/);
});

it("loss-to-profit fires when prior year is negative and latest is positive", () => {
  const r = scoreInflection({
    yearly_history: [
      { year: 2024, netIncome: -100 },
      { year: 2025, netIncome: 500 },
    ],
  });
  assert.equal(r.score, 17);
  assert.equal(r.loss_to_profit, true);
  assert.match(r.reasons[0], /loss_to_profit_flip/);
});

it(">50% YoY growth gets 17pts", () => {
  const r = scoreInflection({
    yearly_history: [
      { year: 2024, netIncome: 100 },
      { year: 2025, netIncome: 200 },
    ],
  });
  assert.equal(r.score, 17);
  assert.equal(r.latest_growth_pct, 100);
});

it(">25% YoY growth gets 12pts", () => {
  const r = scoreInflection({
    yearly_history: [
      { year: 2024, netIncome: 100 },
      { year: 2025, netIncome: 130 },
    ],
  });
  assert.equal(r.score, 12);
});

it(">0% YoY growth gets 6pts", () => {
  const r = scoreInflection({
    yearly_history: [
      { year: 2024, netIncome: 100 },
      { year: 2025, netIncome: 110 },
    ],
  });
  assert.equal(r.score, 6);
});

it("negative YoY growth gets 0pts", () => {
  const r = scoreInflection({
    yearly_history: [
      { year: 2024, netIncome: 100 },
      { year: 2025, netIncome: 80 },
    ],
  });
  assert.equal(r.score, 0);
  assert.match(r.reasons[0], /negative/);
});

it("3y CAGR > 30% adds +5 bonus (cap at 17)", () => {
  const r = scoreInflection({
    yearly_history: [
      { year: 2022, netIncome: 100 },
      { year: 2023, netIncome: 140 },
      { year: 2024, netIncome: 190 },
      { year: 2025, netIncome: 260 },
    ],
  });
  // YoY 2024→2025 is +37% → 17 base (>50% threshold not met but >25% → 12);
  // actually 260/190 = +36.8% → 12pts; 3y CAGR 100→260 = ~37% → +5 → 17 cap
  assert.equal(r.score, 17);
  assert.ok(r.three_year_cagr_pct > 30);
});

it("one-off flag caps score at 6 when news matches", () => {
  const r = scoreInflection({
    yearly_history: [
      { year: 2024, netIncome: 100 },
      { year: 2025, netIncome: 300 },
    ],
    news: [
      { published_at_iso: "2025-04-15", title: "One-time tax credit boosts Q4 earnings" },
    ],
    most_recent_reported_date: "2025-03-31",
  });
  assert.equal(r.score, 6);
  assert.equal(r.one_off_flagged, true);
  assert.match(r.reasons.join(" "), /one_off_detected/);
});

it("one-off news outside 90d window is ignored", () => {
  const r = scoreInflection({
    yearly_history: [
      { year: 2024, netIncome: 100 },
      { year: 2025, netIncome: 300 },
    ],
    news: [
      { published_at_iso: "2024-01-01", title: "Asset sale exceptional item" },
    ],
    most_recent_reported_date: "2025-06-30",
  });
  assert.equal(r.score, 17);
  assert.equal(r.one_off_flagged, false);
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
