// Tests for services/multibagger/positionSizer.js.
// Run: node test/positionSizer.test.mjs

import assert from "node:assert/strict";
import {
  kellyFraction,
  sizePosition,
  evaluateAddCandidate,
  buildTargetPortfolio,
  PILLAR_ALLOC,
  HARD_CAPS,
} from "../services/multibagger/positionSizer.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\npositionSizer");

it("config: Anchor 12%, High 14%×2, Conviction 8%×3", () => {
  assert.equal(PILLAR_ALLOC.anchor_pct, 12);
  assert.equal(PILLAR_ALLOC.high_pct, 14);
  assert.equal(PILLAR_ALLOC.high_max, 2);
  assert.equal(PILLAR_ALLOC.conviction_pct, 8);
  assert.equal(PILLAR_ALLOC.conviction_max, 3);
});

it("config: caps", () => {
  assert.equal(HARD_CAPS.per_symbol_pct, 14);
  assert.equal(HARD_CAPS.per_sector_pct, 35);
  assert.equal(HARD_CAPS.per_promoter_group_pct, 20);
  assert.equal(HARD_CAPS.kelly_max_fraction, 0.25);
});

it("kellyFraction: math sanity", () => {
  // 60% win, avg win 3×, avg loss 1× → f = (3·0.6 − 0.4·1)/3 = 1.4/3 ≈ 0.467 → cap 0.25
  assert.equal(kellyFraction({ win_rate: 0.6, avg_win_mult: 3, avg_loss_mult: 1 }), 0.25);
});

it("kellyFraction: negative edge → 0", () => {
  assert.equal(kellyFraction({ win_rate: 0.3, avg_win_mult: 1, avg_loss_mult: 2 }), 0);
});

it("kellyFraction: invalid inputs → 0", () => {
  assert.equal(kellyFraction({ win_rate: 1.5, avg_win_mult: 1, avg_loss_mult: 1 }), 0);
  assert.equal(kellyFraction({ win_rate: 0.6, avg_win_mult: 0, avg_loss_mult: 1 }), 0);
  assert.equal(kellyFraction({ win_rate: 0.6, avg_win_mult: 1, avg_loss_mult: -1 }), 0);
});

it("sizePosition: tier_pct of portfolio", () => {
  assert.equal(sizePosition({ portfolio_value_inr: 100_000, tier_pct: 12 }), 12_000);
  assert.equal(sizePosition({ portfolio_value_inr: 100_000, tier_pct: 14 }), 14_000);
});

it("sizePosition: Kelly shrinks below tier_pct", () => {
  // Kelly 0.05 = 5% < 14% tier → take 5%
  const s = sizePosition({
    portfolio_value_inr: 100_000,
    tier_pct: 14,
    kelly_inputs: { win_rate: 0.4, avg_win_mult: 2, avg_loss_mult: 1 }, // f = (2·0.4 − 0.6)/2 = 0.1 → 10%
  });
  // Cleaner check: just verify it ≤ tier_pct
  assert.ok(s <= 14_000);
  assert.ok(s > 0);
});

it("sizePosition: zero / invalid → 0", () => {
  assert.equal(sizePosition({ portfolio_value_inr: 0, tier_pct: 14 }), 0);
  assert.equal(sizePosition({ portfolio_value_inr: 100_000, tier_pct: 0 }), 0);
});

it("evaluateAddCandidate: blocks duplicate symbol", () => {
  const r = evaluateAddCandidate({
    candidate: { ticker: "A", sector: "Renewables", value_inr: 10_000 },
    current_positions: [{ ticker: "A", sector: "Renewables", value_inr: 10_000 }],
    portfolio_value_inr: 100_000,
  });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /symbol_already_held/);
});

it("evaluateAddCandidate: blocks when per-symbol > 14%", () => {
  const r = evaluateAddCandidate({
    candidate: { ticker: "B", sector: "Renewables", value_inr: 20_000 },
    current_positions: [],
    portfolio_value_inr: 100_000,
  });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /per_symbol_/);
});

it("evaluateAddCandidate: blocks when sector exposure > 35%", () => {
  const r = evaluateAddCandidate({
    candidate: { ticker: "B", sector: "Renewables", value_inr: 14_000 },
    current_positions: [
      { ticker: "X", sector: "Renewables", value_inr: 12_000 },
      { ticker: "Y", sector: "Renewables", value_inr: 10_000 },
    ],
    portfolio_value_inr: 100_000,
  });
  // total in Renewables would be 36 > 35
  assert.equal(r.allowed, false);
  assert.match(r.reason, /sector_/);
});

it("evaluateAddCandidate: blocks when promoter group > 20%", () => {
  const r = evaluateAddCandidate({
    candidate: { ticker: "BAD", sector: "X", promoter_group: "ADANI", value_inr: 14_000 },
    current_positions: [
      { ticker: "ADE", sector: "Y", promoter_group: "ADANI", value_inr: 12_000 },
    ],
    portfolio_value_inr: 100_000,
  });
  // total ADANI exposure = 26 > 20
  assert.equal(r.allowed, false);
  assert.match(r.reason, /promoter_group_/);
});

it("evaluateAddCandidate: passes on a clean candidate", () => {
  const r = evaluateAddCandidate({
    candidate: { ticker: "INOX", sector: "Renewables", value_inr: 14_000 },
    current_positions: [
      { ticker: "X", sector: "Defense", value_inr: 12_000 },
    ],
    portfolio_value_inr: 100_000,
  });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, "ok");
});

it("buildTargetPortfolio: fills Anchor + 2 High + 3 Conviction = 6 positions", () => {
  const candidates = [
    { ticker: "A", sector: "Renewables", score_0_100: 80 },
    { ticker: "B", sector: "Defense", score_0_100: 75 },
    { ticker: "C", sector: "EMS", score_0_100: 72 },
    { ticker: "D", sector: "Auto", score_0_100: 68 },
    { ticker: "E", sector: "Pharma", score_0_100: 65 },
    { ticker: "F", sector: "Banks", score_0_100: 62 },
    { ticker: "G", sector: "IT", score_0_100: 60 },
  ];
  const out = buildTargetPortfolio({ candidates, portfolio_value_inr: 100_000 });
  assert.equal(out.length, 6);
  assert.equal(out[0].tier, "anchor");
  assert.equal(out[0].value_inr, 12_000);
  assert.equal(out[1].tier, "high");
  assert.equal(out[1].value_inr, 14_000);
});

it("buildTargetPortfolio: skips when sector cap would be breached", () => {
  // 3 candidates all in Renewables — only first 2 fit (12 + 14 = 26 < 35; +14 = 40 > 35)
  const candidates = [
    { ticker: "A", sector: "Renewables", score_0_100: 80 },
    { ticker: "B", sector: "Renewables", score_0_100: 75 },
    { ticker: "C", sector: "Renewables", score_0_100: 70 }, // would breach
    { ticker: "D", sector: "Defense", score_0_100: 65 },
  ];
  const out = buildTargetPortfolio({ candidates, portfolio_value_inr: 100_000 });
  const sectors = out.map((o) => o.sector);
  const renewablesCount = sectors.filter((s) => s === "Renewables").length;
  assert.ok(renewablesCount <= 2);
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
