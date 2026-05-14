// PR 3 — services/earnings/v3SignalAdapter.js unit tests.
//
// The adapter resolves a stock's SWS V3 100-pt breakdown via three
// sources, richest first: the upcoming_earnings pick row, any other
// picks-latest row, then an inline computeV3Score off the SWS deep
// file. These tests pin the priority order, the malformed-breakdown
// fall-through, and the inline-compute path's internal consistency.

import assert from "node:assert/strict";
import { extractV3SignalsForEvent } from "../services/earnings/v3SignalAdapter.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

// A well-formed v3_breakdown with the four pillars the predictor reads.
function goodBreakdown(over = {}) {
  return {
    pts_health: 15, pts_future: 14, pts_valuation: 7, pts_past: 8,
    pts_dividends: 3, pts_fv_upside: 9, fv_imputed: false,
    pts_mom_1y: 5, pts_mom_3m: 2, pts_mom_1m: 1, momentum_imputed: false,
    pts_overlay: 0, overlay_reasons: [], surveillance: null,
    ...over,
  };
}

// A synthetic SWS deep file — the shape computeV3Score reads.
function deepFile(over = {}) {
  return {
    ticker: "TESTCO",
    overview: {
      snowflake: { health: 4, future: 5, valuation: 3, past: 4, dividends: 2 },
      upside_pct: 20,
      returns_pct: { "1M": 5, "3M": 10, "1Y": 25 },
      ...over,
    },
  };
}

console.log("[1] resolution priority");
it("upcoming_earnings row wins (source: upcoming)", () => {
  const r = extractV3SignalsForEvent({
    upcomingRow: { v3_score_100: 70, v3_verdict: "TOP_PICK", v3_breakdown: goodBreakdown() },
    pickRow: { v3_score_100: 40, v3_verdict: "ACCEPTABLE", v3_breakdown: goodBreakdown({ pts_future: 2 }) },
    swsDeep: deepFile(),
  });
  assert.equal(r.source, "upcoming");
  assert.equal(r.v3_score_100, 70);
  assert.equal(r.v3_breakdown.pts_future, 14);
});

it("falls to any picks row when no upcoming row (source: picks)", () => {
  const r = extractV3SignalsForEvent({
    pickRow: { v3_score_100: 55, v3_verdict: "STRONG", v3_breakdown: goodBreakdown() },
    swsDeep: deepFile(),
  });
  assert.equal(r.source, "picks");
  assert.equal(r.v3_score_100, 55);
});

it("falls to inline computeV3Score when not in any picks section (source: computed)", () => {
  const r = extractV3SignalsForEvent({ swsDeep: deepFile(), universe: null });
  assert.equal(r.source, "computed");
  assert.ok(Number.isFinite(r.v3_score_100));
  assert.ok(["TOP_PICK", "STRONG", "ACCEPTABLE", "WATCH", "AVOID"].includes(r.v3_verdict));
});

console.log("[2] malformed breakdown falls through");
it("pick row with missing pillars is skipped, computed path used instead", () => {
  const r = extractV3SignalsForEvent({
    pickRow: { v3_score_100: 55, v3_breakdown: { pts_health: 10 } }, // missing future/past/fv/overlay
    swsDeep: deepFile(),
    universe: null,
  });
  assert.equal(r.source, "computed");
});

it("upcoming row with non-numeric pillar is skipped", () => {
  const r = extractV3SignalsForEvent({
    upcomingRow: { v3_breakdown: goodBreakdown({ pts_future: "n/a" }) },
    pickRow: { v3_score_100: 55, v3_verdict: "STRONG", v3_breakdown: goodBreakdown() },
  });
  assert.equal(r.source, "picks");
});

console.log("[3] empty / unresolvable");
it("no inputs → null", () => {
  assert.equal(extractV3SignalsForEvent({}), null);
  assert.equal(extractV3SignalsForEvent({ swsDeep: null }), null);
});
it("swsDeep without overview → null", () => {
  assert.equal(extractV3SignalsForEvent({ swsDeep: { ticker: "X" } }), null);
});

console.log("[4] computed path internal consistency");
it("breakdown pillars + overlay sum to within ±1 of v3_score_100", () => {
  const r = extractV3SignalsForEvent({ swsDeep: deepFile(), universe: null });
  const b = r.v3_breakdown;
  const sum =
    b.pts_health + b.pts_future + b.pts_valuation + b.pts_past + b.pts_dividends +
    b.pts_fv_upside + b.pts_mom_1y + b.pts_mom_3m + b.pts_mom_1m + b.pts_overlay;
  assert.ok(Math.abs(sum - r.v3_score_100) <= 1, `sum ${sum} vs score ${r.v3_score_100}`);
});
it("weak snowflake → low score; strong snowflake → high score", () => {
  const weak = extractV3SignalsForEvent({
    swsDeep: deepFile({ snowflake: { health: 1, future: 1, valuation: 1, past: 1, dividends: 0 }, upside_pct: -20 }),
    universe: null,
  });
  const strong = extractV3SignalsForEvent({
    swsDeep: deepFile({ snowflake: { health: 6, future: 6, valuation: 6, past: 6, dividends: 6 }, upside_pct: 40 }),
    universe: null,
  });
  assert.ok(strong.v3_score_100 > weak.v3_score_100, `strong ${strong.v3_score_100} > weak ${weak.v3_score_100}`);
});

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
if (fail) process.exit(1);
