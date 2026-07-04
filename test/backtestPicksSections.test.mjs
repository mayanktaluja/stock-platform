import assert from "node:assert/strict";
import { computeReturns } from "../paperTrades.js";
import {
  computeSectionMetrics,
  buildSectionBacktest,
  bootstrapMeanCI,
  bootstrapMedianCI,
} from "../services/trackRecord/picksSectionBacktest.js";
import { SWS_SECTION_PERFORMANCE_REGISTRY } from "../services/trackRecord/sectionPerformance.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nbacktestPicksSections");

// LONG closed trade: 100→110 (+10%) vs Nifty 100→105 (+5%) ⇒ alpha +5pp.
function mkTrade({ type = "sws_midterm", pa = 100, cp = 110, na = 100, nc = 105, closed = true, side, symbol = "X.NS" }) {
  return {
    id: `${type}-${symbol}-${cp}-${nc}`,
    type,
    symbol,
    name: symbol,
    side,
    priceAtSnapshot: pa,
    niftyAtSnapshot: na,
    snapshotAt: "2026-05-01T00:00:00.000Z",
    closedAt: closed ? "2026-05-03T00:00:00.000Z" : null,
    closingPrice: closed ? cp : null,
    niftyAtClose: closed ? nc : null,
  };
}

it("alpha is PERCENT, not fraction (no double-scale)", () => {
  const r = computeReturns(mkTrade({}));
  assert.equal(r.returnPct, 10);   // +10%, not 0.10
  assert.equal(r.alpha, 5);        // +5pp, not 0.05
  assert.equal(r.beatsNifty, true);
});

it("SHORT type flips alpha sign (guards future sws_avoid/earnings_miss)", () => {
  const r = computeReturns(mkTrade({ side: "SHORT" }));
  // stock +10%, nifty +5% → a SHORT 'wins' only if it underperforms → alpha −5.
  assert.equal(r.alpha, -5);
  assert.equal(r.beatsNifty, false);
});

it("thin-n gate: 29 resolved → thin/nulls; 30th → populated", () => {
  const rows29 = Array.from({ length: 29 }, (_, i) => mkTrade({ symbol: `A${i}.NS` }));
  const m29 = computeSectionMetrics(rows29, { minN: 30 });
  assert.equal(m29.n_resolved, 29);
  assert.equal(m29.thin, true);
  assert.equal(m29.hit_rate_pct, null);
  assert.equal(m29.mean_alpha_pct, null);
  assert.equal(m29.median_alpha_pct, null);

  const rows30 = Array.from({ length: 30 }, (_, i) => mkTrade({ symbol: `B${i}.NS` }));
  const m30 = computeSectionMetrics(rows30, { minN: 30 });
  assert.equal(m30.n_resolved, 30);
  assert.equal(m30.thin, false);
  assert.equal(m30.hit_rate_pct, 100);      // all 30 beat
  assert.equal(m30.median_alpha_pct, 5);
  assert.equal(m30.mean_alpha_pct, 5);
});

it("open rows counted in n_open, excluded from resolved", () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => mkTrade({ symbol: `C${i}.NS` })),
    mkTrade({ symbol: "OPEN.NS", closed: false }),
  ];
  const m = computeSectionMetrics(rows, { minN: 30 });
  assert.equal(m.n_open, 1);
  assert.equal(m.n_resolved, 30);
  assert.equal(m.n_total, 31);
});

it("closed row with no benchmark → n_alpha_excluded, not resolved", () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => mkTrade({ symbol: `D${i}.NS` })),
    mkTrade({ symbol: "NONIFTY.NS", na: null, nc: null }),
  ];
  const m = computeSectionMetrics(rows, { minN: 30 });
  assert.equal(m.n_alpha_excluded, 1);
  assert.equal(m.n_resolved, 30);
});

it("missing price → n_bad_price, no throw", () => {
  const rows = [mkTrade({ symbol: "BAD.NS", pa: 0 })];
  const m = computeSectionMetrics(rows, { minN: 30 });
  assert.equal(m.n_bad_price, 1);
  assert.equal(m.n_resolved, 0);
});

it("registry join: sws_midterm→midterm, sws_top30_v3→top_ranked_30_v4 (collision safe)", () => {
  const trades = [
    ...Array.from({ length: 30 }, (_, i) => mkTrade({ type: "sws_midterm", symbol: `M${i}.NS` })),
    ...Array.from({ length: 30 }, (_, i) => mkTrade({ type: "sws_top30_v3", symbol: `T${i}.NS` })),
  ];
  const p = buildSectionBacktest(trades, { minN: 30 });
  assert.equal(p.sections.midterm.n_resolved, 30);
  assert.equal(p.sections.top_ranked_30_v4.n_resolved, 30);
  assert.equal(p.sections.top_ranked_30_v4.ledger_type, "sws_top30_v3");
});

it("public non-registry type (scanner_*) → unmapped_ledger_types, never pooled", () => {
  const trades = [
    ...Array.from({ length: 30 }, (_, i) => mkTrade({ type: "sws_midterm", symbol: `M${i}.NS` })),
    ...Array.from({ length: 5 }, (_, i) => mkTrade({ type: "scanner_buynow_top10", symbol: `S${i}.NS` })),
  ];
  const p = buildSectionBacktest(trades, { minN: 30 });
  const um = p.unmapped_ledger_types.find((u) => u.type === "scanner_buynow_top10");
  assert.ok(um, "scanner type surfaced as unmapped");
  assert.equal(um.count, 5);
  // and it must not have leaked into any section
  for (const s of Object.values(p.sections)) assert.notEqual(s.ledger_type, "scanner_buynow_top10");
});

it("empty ledger: every registry key present with n_resolved 0, no throw", () => {
  const p = buildSectionBacktest([], { minN: 30 });
  const keys = Object.keys(SWS_SECTION_PERFORMANCE_REGISTRY);
  for (const k of keys) {
    assert.ok(p.sections[k], `section ${k} present`);
    assert.equal(p.sections[k].n_resolved, 0);
    assert.equal(p.sections[k].thin, true);
  }
  assert.equal(p._has_any_resolved, false);
});

it("outlier: median < mean when one huge winner skews the mean", () => {
  // 30 tiny-negative rows + 1 giant winner. mean pulled up, median stays low.
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => mkTrade({ symbol: `E${i}.NS`, cp: 99, nc: 100 })), // −1% vs 0 → alpha −1
    mkTrade({ symbol: "MOON.NS", cp: 300, nc: 100 }), // +200% vs 0 → alpha +200
  ];
  const m = computeSectionMetrics(rows, { minN: 30 });
  assert.ok(m.median_alpha_pct < m.mean_alpha_pct, `median ${m.median_alpha_pct} < mean ${m.mean_alpha_pct}`);
  assert.ok(m.median_alpha_pct < 0, "median stays negative despite the outlier");
});

it("bootstrapMeanCI/MedianCI: n<5 → null; all-equal → lo==hi==stat", () => {
  assert.deepEqual(bootstrapMeanCI([1, 2, 3, 4]), { lo: null, hi: null });
  const eq = bootstrapMeanCI([7, 7, 7, 7, 7, 7]);
  assert.equal(eq.lo, 7);
  assert.equal(eq.hi, 7);
  const eqMed = bootstrapMedianCI([3, 3, 3, 3, 3]);
  assert.equal(eqMed.lo, 3);
  assert.equal(eqMed.hi, 3);
});

it("wilson CI bounds ⊂ [0,100] and lo ≤ p ≤ hi", () => {
  const rows = Array.from({ length: 40 }, (_, i) =>
    mkTrade({ symbol: `W${i}.NS`, cp: i < 25 ? 110 : 90, nc: 100 }) // 25 win / 15 lose
  );
  const m = computeSectionMetrics(rows, { minN: 30 });
  assert.ok(m.hit_rate_ci_pct.lo >= 0 && m.hit_rate_ci_pct.hi <= 100);
  assert.ok(m.hit_rate_ci_pct.lo <= m.hit_rate_pct && m.hit_rate_pct <= m.hit_rate_ci_pct.hi);
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
