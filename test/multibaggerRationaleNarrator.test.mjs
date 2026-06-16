// Tests for services/multibagger/rationaleNarrator.js.
// Run: node test/multibaggerRationaleNarrator.test.mjs

import assert from "node:assert/strict";
import { narrateCandidate, buildStrategyExplainer } from "../services/multibagger/rationaleNarrator.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nrationaleNarrator");

const lossToProfit = {
  ticker: "DEEPINDS", sector: "Energy", score_0_100: 70.3, verdict: "5X_CANDIDATE",
  gate_blocked: false, gate_reasons: [],
  breakdown: { inflection: 17, mcap: 8, v3_future: 8, fv_upside: 8, momentum: 4, health: 3, sector_tailwind: 0 },
  diagnostics: { inflection: { loss_to_profit: true, reasons: ["loss_to_profit_flip"] }, tailwind: { cohort_exhausted: false }, story: { tags: [] } },
};

it("narrateCandidate returns why_picked / bear_case / target", () => {
  const r = narrateCandidate(lossToProfit);
  assert.ok(Array.isArray(r.why_picked) && r.why_picked.length > 0);
  assert.ok(Array.isArray(r.bear_case) && r.bear_case.length > 0);
  assert.match(r.target_multiple_rationale, /not empirically validated as a 5x forecast/);
});

it("loss-to-profit produces the strongest-signal phrase as #1 driver", () => {
  const r = narrateCandidate(lossToProfit);
  assert.match(r.why_picked[0], /Swung from losses to profit/);
  assert.equal(r.one_line, r.why_picked[0]);
});

it("inflection-dominant pick gets the turnaround-fragility bear case", () => {
  const r = narrateCandidate(lossToProfit);
  assert.ok(r.bear_case.some((b) => /turnaround holding/.test(b)));
});

it("YoY-growth inflection narrates the percentage + CAGR", () => {
  const c = {
    ticker: "JSLL", sector: "Healthcare", verdict: "HIGH_CONVICTION",
    breakdown: { inflection: 17, v3_future: 12, fv_upside: 10 },
    diagnostics: { inflection: { loss_to_profit: false, latest_growth_pct: 134.6, three_year_cagr_pct: 84.8 } },
  };
  const r = narrateCandidate(c);
  assert.match(r.why_picked[0], /134\.6% YoY/);
  assert.match(r.why_picked[0], /84\.8% 3-yr CAGR/);
});

it("cohort-exhausted sector surfaces the 'buying late' bear case", () => {
  const c = {
    ticker: "X", sector: "Defense", verdict: "WATCH",
    breakdown: { sector_tailwind: 0, inflection: 6, mcap: 8 },
    diagnostics: { tailwind: { cohort_exhausted: true }, inflection: {} },
  };
  const r = narrateCandidate(c);
  assert.ok(r.bear_case.some((b) => /up >80%|buying late/.test(b)));
});

it("hard-gated candidate leads bear case with the gate reasons", () => {
  const c = {
    ticker: "BAD", sector: "X", verdict: "HARD_REJECT",
    gate_blocked: true, gate_reasons: ["pledge_pledge_30pct_>=_25pct"],
    breakdown: { inflection: 17 }, diagnostics: { inflection: { loss_to_profit: true } },
  };
  const r = narrateCandidate(c);
  assert.match(r.bear_case[0], /Hard-gated/);
  assert.match(r.bear_case[0], /pledge/);
});

it("thin-momentum (<=3) flagged as unproven", () => {
  const c = {
    ticker: "Y", sector: "X", verdict: "WATCH",
    breakdown: { inflection: 6, momentum: 3, mcap: 10 }, diagnostics: { inflection: {} },
  };
  const r = narrateCandidate(c);
  assert.ok(r.bear_case.some((b) => /Thin\/short trading history/.test(b)));
});

it("every candidate gets the concentrated-small-cap drawdown caveat", () => {
  const r = narrateCandidate(lossToProfit);
  assert.ok(r.bear_case.some((b) => /40%\+ drawdowns/.test(b)));
});

it("narrateCandidate handles malformed input", () => {
  assert.equal(narrateCandidate(null), null);
  const r = narrateCandidate({ ticker: "Z", breakdown: {}, diagnostics: {} });
  assert.ok(Array.isArray(r.why_picked));
  assert.ok(r.bear_case.length > 0); // still gets the baseline caveat
});

console.log("\nbuildStrategyExplainer");

const scores = {
  macro_regime: "WAR_ESCALATION", five_x_count: 1, high_conviction_count: 54, universe_size: 1964,
  top_50: [
    { ticker: "A", breakdown: { inflection: 17, mcap: 8 } },
    { ticker: "B", breakdown: { inflection: 17, v3_future: 12 } },
    { ticker: "C", breakdown: { sector_tailwind: 12, inflection: 6 } },
  ],
};

it("explainer injects live regime + counts", () => {
  const e = buildStrategyExplainer({ scores });
  assert.match(e.headline, /1 of 1964/);
  assert.match(e.headline, /54 more are high-conviction/);
  assert.ok(e.how_sectors_are_picked.some((s) => /WAR_ESCALATION/.test(s)));
});

it("explainer computes the dominant driver across top picks", () => {
  const e = buildStrategyExplainer({ scores });
  // inflection is #1 driver for A and B (2/3)
  assert.ok(e.how_stocks_are_picked.some((s) => /earnings inflection.*2\/3/.test(s)));
});

it("explainer always carries the pre-mortem + honest no-guarantee note", () => {
  const e = buildStrategyExplainer({ scores });
  assert.ok(Array.isArray(e.pre_mortem) && e.pre_mortem.length >= 4);
  assert.match(e.honest_note, /cannot guarantee 5x/);
  assert.ok(e.what_gets_removed.some((g) => /pledge/i.test(g)));
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
