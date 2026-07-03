import assert from "node:assert/strict";
import { buildTranchePlan } from "../services/entry/tranchePlanBuilder.js";
import { TRANCHES, ENTRY_TIMING_VERSION } from "../services/entry/entryTimingConfig.js";

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok ${name}`);
  } catch (err) {
    fail += 1;
    console.error(`  not ok ${name}`);
    console.error(err.stack || err.message);
  }
}

function pctSum(tranches) {
  return tranches.reduce((acc, t) => acc + t.pct, 0);
}

console.log("tranchePlanBuilder");

// ── Normal ladder happy path — every ₹ hand-computed ─────────────────────
// anchor 500, FV 600 → 0.75×FV = 450 < 500 → NORMAL. mae 10%:
//   T1 = 0.40 @ 500.00 (market)
//   T2 = 0.35 @ 500×0.90        = 450.00 (limit)
//   T3 = 0.25 @ min(450, 500×0.80) = 400.00 (limit)
// atr14 48 → invalidation = 500 − 2.5×48 = 380.00, basis "atr".
check("normal ladder happy path: exact hand-computed rupee levels", () => {
  const out = buildTranchePlan({
    anchorPriceInr: 500,
    anchoredAt: "2026-07-03T00:00:00.000Z",
    fairValueInr: 600,
    noBuyAboveInr: 540,
    fiftyTwoWeekLow: 320,
    atr14: 48,
    medianMaePct: 10,
  });
  assert.equal(out.eligible, true);
  assert.equal(out.version, ENTRY_TIMING_VERSION);
  assert.equal(out.anchor_price_inr, 500);
  assert.equal(out.anchored_at, "2026-07-03T00:00:00.000Z");
  assert.equal(out.deep_below_band, false);
  assert.equal(out.tranches.length, 3);
  assert.deepEqual(out.tranches[0], {
    pct: 0.4, trigger_type: "market", trigger_price_inr: 500, label: "Initiate at anchor",
  });
  assert.deepEqual(out.tranches[1], {
    pct: 0.35, trigger_type: "limit", trigger_price_inr: 450, label: "Add on measured pullback",
  });
  assert.deepEqual(out.tranches[2], {
    pct: 0.25, trigger_type: "limit", trigger_price_inr: 400, label: "Final add at deep-value level",
  });
  assert.equal(out.no_chase_inr, 540);
  assert.equal(out.invalidation_inr, 380);
  assert.equal(out.invalidation_basis, "atr");
  assert.equal(out.mae_pct_used, 10);
  // strictly decreasing
  assert.ok(out.tranches[0].trigger_price_inr > out.tranches[1].trigger_price_inr);
  assert.ok(out.tranches[1].trigger_price_inr > out.tranches[2].trigger_price_inr);
});

// ── DEEP_BELOW_BAND collapse — FLAIR-like numbers ─────────────────────────
// anchor 267.5, FV 451.33 → 0.75×FV = 338.4975 ≥ 267.5 → collapse to 2 rungs.
// Default mae seed 8%: T2 = 267.5×(1 − 1.5×0.08) = 267.5×0.88 = 235.40.
// no noBuyAbove → ceiling defaults to 0.90×451.33 = 406.20.
// no atr, 52w low 210.15 < 0.92×267.5 = 246.10 → invalidation 210.15 "52w_low".
check("DEEP_BELOW_BAND collapse on FLAIR-like numbers (0.75×FV above anchor)", () => {
  const out = buildTranchePlan({
    anchorPriceInr: 267.5,
    anchoredAt: "2026-07-03T04:00:00.000Z",
    fairValueInr: 451.33,
    fiftyTwoWeekLow: 210.15,
  });
  assert.equal(out.eligible, true);
  assert.equal(out.deep_below_band, true);
  assert.equal(out.tranches.length, 2);
  assert.deepEqual(out.tranches[0], {
    pct: 0.5, trigger_type: "market", trigger_price_inr: 267.5, label: "Initiate at anchor",
  });
  assert.deepEqual(out.tranches[1], {
    pct: 0.5, trigger_type: "limit", trigger_price_inr: 235.4, label: "Add on measured pullback",
  });
  for (const t of out.tranches) assert.ok(t.trigger_price_inr <= 267.5);
  assert.equal(out.no_chase_inr, 406.2);
  assert.equal(out.invalidation_inr, 210.15);
  assert.equal(out.invalidation_basis, "52w_low");
  assert.equal(out.mae_pct_used, TRANCHES.MAE_SEED_PCT); // default seed used
  assert.equal(out.anchored_at, "2026-07-03T04:00:00.000Z");
});

// ── Monotonicity property across a grid ───────────────────────────────────
// 5 anchors × 5 FV multiples × 5 maes = 125 combos (includes the ₹0.05
// penny case that forces the rounding-collision nudge, and FV multiples
// on both sides of the deep/normal boundary). atr = 0.3×anchor keeps the
// invalidation well below every ladder so all combos stay eligible.
check("monotonicity property: 125-combo grid, non-increasing, <= anchor, >= 0", () => {
  const anchors = [0.05, 42.6, 100, 267.5, 999.95];
  const fvMults = [0.6, 0.9, 1.1, 1.34, 1.8];
  const maes = [0.5, 3, 8, 14, 45];
  let combos = 0;
  for (const anchor of anchors) {
    for (const fvMult of fvMults) {
      for (const mae of maes) {
        combos += 1;
        const out = buildTranchePlan({
          anchorPriceInr: anchor,
          fairValueInr: anchor * fvMult,
          atr14: anchor * 0.3,
          medianMaePct: mae,
        });
        const tag = `anchor=${anchor} fvMult=${fvMult} mae=${mae}`;
        assert.equal(out.eligible, true, `expected eligible: ${tag}`);
        const prices = out.tranches.map((t) => t.trigger_price_inr);
        for (let i = 0; i < prices.length; i++) {
          assert.ok(prices[i] <= out.anchor_price_inr, `rung above anchor: ${tag} → ${prices}`);
          assert.ok(prices[i] >= 0, `negative rung: ${tag} → ${prices}`);
          if (i > 0) {
            assert.ok(prices[i] < prices[i - 1], `not decreasing: ${tag} → ${prices}`);
          }
        }
        assert.ok(Math.abs(pctSum(out.tranches) - 1) < 1e-9, `pct sum != 1: ${tag}`);
      }
    }
  }
  assert.ok(combos >= 100, `grid too small: ${combos}`);
});

// ── Invalidation basis: ATR path wins when atr14 present ─────────────────
check("invalidation basis: atr path (takes precedence over 52w low)", () => {
  const out = buildTranchePlan({
    anchorPriceInr: 100,
    fairValueInr: 120,
    atr14: 10,
    fiftyTwoWeekLow: 60,
    medianMaePct: 10,
  });
  assert.equal(out.eligible, true);
  assert.equal(out.invalidation_inr, 75); // 100 − 2.5×10
  assert.equal(out.invalidation_basis, "atr");
});

check("invalidation basis: 52w low path when below the anchor floor", () => {
  const out = buildTranchePlan({
    anchorPriceInr: 100,
    fairValueInr: 120,
    fiftyTwoWeekLow: 70,
    medianMaePct: 10,
  });
  assert.equal(out.eligible, true);
  assert.equal(out.invalidation_inr, 70); // min(92, 70)
  assert.equal(out.invalidation_basis, "52w_low");
});

// The non-ATR invalidation is capped BELOW the lowest rung (BELOW_LADDER_MULT=0.96):
// a stop above the final planned add would refuse every seed-MAE Tier-1 plan
// (real-data smoke 2026-07-03: 25/25 live buy-now plans refused pre-cap).
check("invalidation caps to ladder_floor when the anchor floor sits above the lowest rung", () => {
  const out = buildTranchePlan({
    anchorPriceInr: 100,
    fairValueInr: 130, // 0.75×FV = 97.5 < 100 → normal; T3 = min(97.5, 94) = 94
    medianMaePct: 3,
  });
  assert.equal(out.eligible, true);
  // anchorFloor 92 > cap 0.96×94 = 90.24 → capped, basis ladder_floor
  assert.equal(out.invalidation_inr, 90.24);
  assert.equal(out.invalidation_basis, "ladder_floor");
  assert.equal(out.tranches[2].trigger_price_inr, 94);
});

check("invalidation caps to ladder_floor when the 52w low also sits above the rung", () => {
  const out = buildTranchePlan({
    anchorPriceInr: 100,
    fairValueInr: 130,
    fiftyTwoWeekLow: 95, // above anchorFloor 92 → floor branch → capped at 90.24
    medianMaePct: 3,
  });
  assert.equal(out.eligible, true);
  assert.equal(out.invalidation_inr, 90.24);
  assert.equal(out.invalidation_basis, "ladder_floor");
});

// ── Refusal: only the (uncapped) ATR basis can refuse ─────────────────────
// anchor 100, FV 110, mae 0.5→3 → lowest rung = min(0.75×110, 94) = 82.5;
// ATR stop = 100 − 2.5×5 = 87.5 ≥ 82.5 → vol-incoherent plan → REFUSE.
check("refusal: invalidation_above_ladder via ATR stop above the ladder", () => {
  const out = buildTranchePlan({
    anchorPriceInr: 100,
    fairValueInr: 110,
    atr14: 5,
    medianMaePct: 0.5,
  });
  assert.equal(out.eligible, false);
  assert.equal(out.refusal_code, "invalidation_above_ladder");
  assert.equal(out.invalidation_inr, 87.5);
  assert.equal(out.invalidation_basis, "atr");
  assert.equal(out.lowest_tranche_inr, 82.5);
  assert.equal(out.mae_pct_used, 3);
  // a refused plan must never leak actionable rungs
  assert.ok(!("tranches" in out));
});

// Regression guard for the 2026-07-03 smoke finding: Tier-1 (no ATR) must NEVER
// refuse across a realistic grid — the ladder cap guarantees the stop sits below.
check("tier-1 (no ATR) never refuses across a realistic grid", () => {
  for (const anchor of [50, 100, 267.5, 1000, 2492]) {
    for (const fvMult of [1.05, 1.3, 1.69, 2.5]) {
      for (const mae of [3, 8, 20]) {
        for (const low of [undefined, anchor * 0.5, anchor * 0.9, anchor * 0.99]) {
          const out = buildTranchePlan({
            anchorPriceInr: anchor,
            fairValueInr: anchor * fvMult,
            fiftyTwoWeekLow: low,
            medianMaePct: mae,
          });
          assert.equal(out.eligible, true,
            `refused: anchor=${anchor} fvMult=${fvMult} mae=${mae} low=${low} → ${out.refusal_code}`);
          const lowest = out.tranches[out.tranches.length - 1].trigger_price_inr;
          assert.ok(out.invalidation_inr < lowest, "invalidation must sit below the ladder");
        }
      }
    }
  }
});

// ── MAE clamp ─────────────────────────────────────────────────────────────
check("mae clamp: 0.5 clamps up to 3", () => {
  const out = buildTranchePlan({
    anchorPriceInr: 500,
    fairValueInr: 600,
    atr14: 48,
    medianMaePct: 0.5,
  });
  assert.equal(out.eligible, true);
  assert.equal(out.mae_pct_used, 3);
  assert.equal(out.tranches[1].trigger_price_inr, 485); // 500×0.97
  assert.equal(out.tranches[2].trigger_price_inr, 450); // min(450, 500×0.94=470)
});

check("mae clamp: 45 clamps down to 20", () => {
  const out = buildTranchePlan({
    anchorPriceInr: 500,
    fairValueInr: 600,
    atr14: 90, // stop 275, below T3 300
    medianMaePct: 45,
  });
  assert.equal(out.eligible, true);
  assert.equal(out.mae_pct_used, 20);
  assert.equal(out.tranches[1].trigger_price_inr, 400); // 500×0.80
  assert.equal(out.tranches[2].trigger_price_inr, 300); // min(450, 500×0.60)
});

// ── Missing-input refusals ────────────────────────────────────────────────
check("missing-input refusals: anchor/FV absent, zero, negative, NaN", () => {
  const bads = [
    {},
    { fairValueInr: 600 },
    { anchorPriceInr: 500 },
    { anchorPriceInr: 0, fairValueInr: 600 },
    { anchorPriceInr: -10, fairValueInr: 600 },
    { anchorPriceInr: NaN, fairValueInr: 600 },
    { anchorPriceInr: 500, fairValueInr: 0 },
    { anchorPriceInr: 500, fairValueInr: -5 },
    { anchorPriceInr: 500, fairValueInr: Infinity },
    { anchorPriceInr: "500", fairValueInr: 600 },
  ];
  for (const input of bads) {
    const out = buildTranchePlan(input);
    assert.equal(out.eligible, false, JSON.stringify(input));
    assert.equal(out.refusal_code, "missing_inputs", JSON.stringify(input));
    assert.ok(!("tranches" in out));
  }
  const noArg = buildTranchePlan();
  assert.equal(noArg.eligible, false);
  assert.equal(noArg.refusal_code, "missing_inputs");
});

// ── Purity: frozen inputs, no mutation ────────────────────────────────────
check("purity: frozen input object is never mutated (ESM strict would throw)", () => {
  const input = Object.freeze({
    anchorPriceInr: 500,
    anchoredAt: "2026-07-03T00:00:00.000Z",
    fairValueInr: 600,
    noBuyAboveInr: 540,
    fiftyTwoWeekLow: 320,
    atr14: 48,
    medianMaePct: 10,
  });
  const snapshot = { ...input };
  const a = buildTranchePlan(input);
  const b = buildTranchePlan(input);
  assert.deepEqual({ ...input }, snapshot);
  assert.deepEqual(a, b); // deterministic — no hidden state, no Date.now
  assert.equal(a.eligible, true);
});

// ── No-chase ceiling ──────────────────────────────────────────────────────
check("no_chase is the provided noBuyAbove, never a rung", () => {
  const out = buildTranchePlan({
    anchorPriceInr: 500,
    fairValueInr: 600,
    noBuyAboveInr: 540,
    atr14: 48,
    medianMaePct: 10,
  });
  assert.equal(out.no_chase_inr, 540);
  assert.ok(out.tranches.every((t) => t.trigger_price_inr !== out.no_chase_inr));
});

check("no_chase defaults to 0.90 x fair value when absent", () => {
  const out = buildTranchePlan({
    anchorPriceInr: 500,
    fairValueInr: 600,
    atr14: 48,
    medianMaePct: 10,
  });
  assert.equal(out.no_chase_inr, 540); // 0.9×600
});

// ── pct sums to 1.0 in both shapes ────────────────────────────────────────
check("pct sums to 1.0 for both normal and deep shapes", () => {
  const normal = buildTranchePlan({
    anchorPriceInr: 500, fairValueInr: 600, atr14: 48, medianMaePct: 10,
  });
  const deep = buildTranchePlan({
    anchorPriceInr: 267.5, fairValueInr: 451.33, fiftyTwoWeekLow: 210.15,
  });
  assert.equal(normal.deep_below_band, false);
  assert.equal(deep.deep_below_band, true);
  assert.ok(Math.abs(pctSum(normal.tranches) - 1) < 1e-9);
  assert.ok(Math.abs(pctSum(deep.tranches) - 1) < 1e-9);
});

// ── anchored_at defaults to null when not captured ────────────────────────
check("anchored_at is null when not provided", () => {
  const out = buildTranchePlan({
    anchorPriceInr: 500, fairValueInr: 600, atr14: 48, medianMaePct: 10,
  });
  assert.equal(out.anchored_at, null);
});

console.log(`\ntranchePlanBuilder result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
