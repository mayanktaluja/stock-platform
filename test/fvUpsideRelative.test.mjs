// Unit tests for the relative, magnitude-aware FV-upside block.
// Plain node:assert/strict — run with: node test/fvUpsideRelative.test.mjs
import assert from "node:assert/strict";
import {
  signedLog,
  buildFvUpsideBenchmark,
  relativeFvPoints,
  DEFAULT_MICRO_CAP_FLOOR_INR,
  MAX_PTS,
} from "../services/scoring/fvUpsideRelative.js";
import { computeV3Score } from "../services/swsScoring.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}
const approx = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (±${eps})`);

const CR = 1e7;            // 1 crore in raw INR
const BIG = 5000 * CR;     // ₹5,000cr — safely above the micro-cap floor
const SMALL = 10 * CR;     // ₹10cr — below the floor

// Legacy absolute band, for the "we fixed the saturation" contrast tests.
const oldBand = (u) => (u == null ? 6 : u >= 30 ? 12 : u >= 15 ? 9 : u >= 0 ? 6 : u >= -10 ? 3 : 0);

console.log("\nsignedLog");
it("0 -> 0, sign-symmetric, monotone, null on non-finite", () => {
  approx(signedLog(0), 0);
  approx(signedLog(Math.E - 1), 1);            // ln(1 + (e-1)) = 1
  approx(signedLog(-(Math.E - 1)), -1);
  assert.ok(signedLog(150) > signedLog(50));
  assert.equal(signedLog(null), null);
  assert.equal(signedLog(NaN), null);
  assert.equal(signedLog(Infinity), null);
});

console.log("\nbuildFvUpsideBenchmark — moment math");
it("known 4-row set yields the expected median/MAD/robust_sigma", () => {
  // upsides 0,10,20,40 -> slog 0, 2.397895, 3.044522, 3.713572
  // median = (2.397895 + 3.044522)/2 = 2.721209
  // abs devs sorted: 0.323313, 0.323313, 0.992363, 2.721209 -> median 0.657838
  // robust_sigma = 1.4826 * 0.657838 = 0.975310
  const rows = [0, 10, 20, 40].map((u) => ({ upside_pct: u, market_cap_inr: BIG }));
  const b = buildFvUpsideBenchmark(rows);
  assert.equal(b.n, 4);
  assert.equal(b.degenerate, false);
  approx(b.median_slog, 2.721209);
  approx(b.mad, 0.657838);
  approx(b.robust_sigma, 0.975310);
});

console.log("\nbuildFvUpsideBenchmark — exclusions (F6: don't contaminate the anchor)");
it("micro-caps are excluded from the moments", () => {
  const base = [0, 10, 20, 40].map((u) => ({ upside_pct: u, market_cap_inr: BIG }));
  const polluted = [...base,
    { upside_pct: 9999, market_cap_inr: SMALL },   // micro-cap moonshot — must NOT move the anchor
    { upside_pct: -90, market_cap_inr: SMALL },
  ];
  const b1 = buildFvUpsideBenchmark(base);
  const b2 = buildFvUpsideBenchmark(polluted);
  assert.equal(b2.n, b1.n);                         // micro-caps not counted
  approx(b2.median_slog, b1.median_slog);
  approx(b2.robust_sigma, b1.robust_sigma);
});
it("null / non-finite upsides are excluded", () => {
  const rows = [
    { upside_pct: 10, market_cap_inr: BIG },
    { upside_pct: null, market_cap_inr: BIG },
    { upside_pct: NaN, market_cap_inr: BIG },
    { market_cap_inr: BIG },                         // missing upside
    { upside_pct: 30, market_cap_inr: BIG },
  ];
  assert.equal(buildFvUpsideBenchmark(rows).n, 2);
});
it("default micro-cap floor is ₹500cr in raw INR", () => {
  assert.equal(DEFAULT_MICRO_CAP_FLOOR_INR, 5e9);
});

console.log("\nbuildFvUpsideBenchmark — degenerate guards");
it("empty input -> degenerate", () => {
  const b = buildFvUpsideBenchmark([]);
  assert.equal(b.n, 0);
  assert.equal(b.degenerate, true);
});
it("zero-dispersion cross-section (all equal) -> degenerate", () => {
  const rows = Array.from({ length: 50 }, () => ({ upside_pct: 12, market_cap_inr: BIG }));
  const b = buildFvUpsideBenchmark(rows);
  assert.equal(b.robust_sigma, 0);
  assert.equal(b.degenerate, true);
});

// Realistic benchmark anchored on the measured live distribution
// (median upside ≈ +16.75% -> median_slog ≈ 2.8764, robust_sigma ≈ 1.7258).
const BENCH = { median_slog: 2.8764, robust_sigma: 1.7258, degenerate: false };

console.log("\nrelativeFvPoints — monotonicity & magnitude preservation (load-bearing)");
it("non-decreasing across the full upside ladder", () => {
  const ladder = [-50, -10, 0, 16.75, 30, 50, 100, 150, 300];
  const pts = ladder.map((u) => relativeFvPoints(u, BENCH).pts);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i] >= pts[i - 1], `pts(${ladder[i]})=${pts[i].toFixed(3)} must be ≥ pts(${ladder[i - 1]})=${pts[i - 1].toFixed(3)}`);
  }
});
it("strictly increasing across the investable (unsaturated) range", () => {
  // 0..+300% all map to (0, MAX_PTS) — magnitude must be preserved here
  const ladder = [0, 16.75, 30, 50, 100, 150, 300];
  const pts = ladder.map((u) => relativeFvPoints(u, BENCH).pts);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i] > pts[i - 1], `pts(${ladder[i]})=${pts[i].toFixed(3)} must exceed pts(${ladder[i - 1]})=${pts[i - 1].toFixed(3)}`);
    assert.ok(pts[i] > 0 && pts[i] < MAX_PTS, `pts(${ladder[i]})=${pts[i].toFixed(3)} should be unsaturated`);
  }
});
it("deeply-overvalued names intentionally floor at 0 (no cheapness credit)", () => {
  // relative to a benchmark whose median upside is well positive, anything
  // priced above ~fair value gets no cheapness points — by design.
  approx(relativeFvPoints(-50, BENCH).pts, 0);
  approx(relativeFvPoints(-10, BENCH).pts, 0);
});
it("the median-upside name lands at neutral (MAX_PTS/2)", () => {
  // upside whose slog == median_slog -> rz = 0 -> half points
  const medianUpside = Math.exp(BENCH.median_slog) - 1;
  approx(relativeFvPoints(medianUpside, BENCH).pts, MAX_PTS / 2, 1e-3);
});
it("FIXES the original complaint: +150% scores meaningfully above +50%", () => {
  const p150 = relativeFvPoints(150, BENCH).pts;
  const p50 = relativeFvPoints(50, BENCH).pts;
  // legacy band saturated both at 12 — no separation
  assert.equal(oldBand(150), oldBand(50));
  assert.equal(oldBand(150), 12);
  // new transform keeps a real gap
  assert.ok(p150 - p50 > 1.0, `expected a >1pt gap, got ${(p150 - p50).toFixed(3)}`);
});
it("a +300% moonshot saturates gently (only edges past +150%)", () => {
  const p150 = relativeFvPoints(150, BENCH).pts;
  const p300 = relativeFvPoints(300, BENCH).pts;
  assert.ok(p300 > p150);                            // still monotone
  assert.ok(p300 - p150 < p150 - relativeFvPoints(50, BENCH).pts); // diminishing returns in the tail
});

console.log("\nrelativeFvPoints — bounds & imputation");
it("clamps to [0, MAX_PTS]", () => {
  for (const u of [-99, -50, 0, 50, 500, 5000]) {
    const p = relativeFvPoints(u, BENCH).pts;
    assert.ok(p >= 0 && p <= MAX_PTS, `pts(${u})=${p} out of range`);
  }
});
it("null upside -> neutral, flagged imputed", () => {
  const r = relativeFvPoints(null, BENCH);
  approx(r.pts, MAX_PTS / 2);
  assert.equal(r.imputed, true);
  assert.equal(r.rz, null);
});
it("degenerate / missing benchmark -> neutral, flagged imputed", () => {
  approx(relativeFvPoints(42, { degenerate: true }).pts, MAX_PTS / 2);
  assert.equal(relativeFvPoints(42, null).imputed, true);
  assert.equal(relativeFvPoints(42, { robust_sigma: 0 }).imputed, true);
});

console.log("\nend-to-end — built benchmark feeds scoring");
it("benchmark built from rows scores its own median name ≈ neutral", () => {
  // odd count so the median upside is an actual member
  const ups = [-40, -10, 5, 12, 18, 25, 60, 120, 250];
  const rows = ups.map((u) => ({ upside_pct: u, market_cap_inr: BIG }));
  const b = buildFvUpsideBenchmark(rows);
  approx(relativeFvPoints(18, b).pts, MAX_PTS / 2, 1e-6); // 18 is the median upside
});

console.log("\ncomputeV3Score integration (live wiring)");
it("uses the relative transform when a benchmark is supplied", () => {
  const ov = { upside_pct: 50, market_cap_inr: BIG, snowflake: {}, returns_pct: {} };
  const r = computeV3Score({ ticker: "T", overview: ov }, { fvBenchmark: BENCH });
  // +50% relative is well below the legacy band's flat 12, and above neutral 6
  assert.ok(r.v3_breakdown.pts_fv_upside > 6 && r.v3_breakdown.pts_fv_upside < 12,
    `relative pts_fv_upside should be in (6,12), got ${r.v3_breakdown.pts_fv_upside}`);
  assert.equal(r.v3_breakdown.fv_imputed, false);
});
it("falls back to the legacy absolute band when no benchmark is supplied", () => {
  const ov = { upside_pct: 50, market_cap_inr: BIG, snowflake: {}, returns_pct: {} };
  const r = computeV3Score({ ticker: "T", overview: ov }, {});
  assert.equal(r.v3_breakdown.pts_fv_upside, 12); // +50% → legacy band max
});

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
if (fail) process.exit(1);
