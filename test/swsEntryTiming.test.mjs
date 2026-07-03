import assert from "node:assert/strict";
import {
  computeEntryTiming,
  percentileFractionBelow,
  fiftyTwoWeekPosition,
  resolveSectorImpact,
  ENTRY_STATES,
} from "../services/entry/swsEntryTiming.js";
import { ENTRY_TIMING_VERSION, REASON } from "../services/entry/entryTimingConfig.js";

// Every input is deep-frozen — ANY mutation attempt inside the engine throws
// in strict mode (ESM), so the whole suite doubles as a purity proof.
function deepFreeze(obj) {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

// len 10, sorted ascending. fraction-strictly-below cheat sheet:
//   r3m=5 → 0.5   r3m=8 → 0.6   r3m=-2 → 0.4   r3m=-5 → 0.3
//   r3m=-10 → 0.2   r3m=-20 → 0.1   r3m=-25 → 0.1
const UNIVERSE = [-30, -20, -10, -5, 0, 5, 10, 15, 20, 25];

function row(overrides = {}) {
  return deepFreeze({
    returnsPct: { "1D": 0.2, "7D": 1, "1M": 2, "3M": 5, "1Y": 12 },
    fiftyTwoWeek: { low: 100, high: 140 },
    currentPriceInr: 120,
    universeR3m: UNIVERSE,
    macro: null,
    sector: "Banks",
    prevState: null,
    asOf: "2026-07-03",
    ...overrides,
  });
}

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

console.log("swsEntryTiming");

// ---------------------------------------------------------------- knife legs

check("knife leg: 1M at the -12 boundary fires alone", () => {
  const out = computeEntryTiming(row({ returnsPct: { "7D": 1, "1M": -12, "3M": 5 } }));
  assert.equal(out.state, ENTRY_STATES.FALLING_KNIFE);
  assert.deepEqual(out.reasons, [REASON.KNIFE_1M]);
});

check("knife leg: 3M at the -20 boundary fires alone", () => {
  const out = computeEntryTiming(row({ returnsPct: { "7D": 1, "1M": 2, "3M": -20 } }));
  assert.equal(out.state, ENTRY_STATES.FALLING_KNIFE);
  assert.deepEqual(out.reasons, [REASON.KNIFE_3M]);
});

check("knife leg: px/52wHigh below 0.7 fires alone", () => {
  const out = computeEntryTiming(row({
    fiftyTwoWeek: { low: 80, high: 140 },
    currentPriceInr: 90, // 90/140 = 0.643
  }));
  assert.equal(out.state, ENTRY_STATES.FALLING_KNIFE);
  assert.deepEqual(out.reasons, [REASON.KNIFE_52W_HIGH]);
});

check("knife leg: 7D at the -7 boundary fires alone", () => {
  const out = computeEntryTiming(row({ returnsPct: { "7D": -7, "1M": 2, "3M": 5 } }));
  assert.equal(out.state, ENTRY_STATES.FALLING_KNIFE);
  assert.deepEqual(out.reasons, [REASON.KNIFE_7D]);
});

check("slow-bleeder WITH 6M fires clean (no degrade code)", () => {
  const out = computeEntryTiming(row({
    returnsPct: { "7D": -1, "1M": -5, "3M": -10, "6M": -8 }, // pct3m = 0.2 < 0.25
  }));
  assert.equal(out.state, ENTRY_STATES.FALLING_KNIFE);
  assert.deepEqual(out.reasons, [REASON.KNIFE_SLOW_BLEEDER]);
  assert.equal(out.momentum_pct_3m, 0.2);
});

check("slow-bleeder WITHOUT 6M fires degraded (DEGRADED_NO_6M asserted)", () => {
  const out = computeEntryTiming(row({
    returnsPct: { "7D": -1, "1M": -5, "3M": -10 },
  }));
  assert.equal(out.state, ENTRY_STATES.FALLING_KNIFE);
  assert.deepEqual(out.reasons, [REASON.KNIFE_SLOW_BLEEDER, REASON.DEGRADED_NO_6M]);
});

check("slow-bleeder vetoed by a non-negative 6M", () => {
  const out = computeEntryTiming(row({
    returnsPct: { "7D": -1, "1M": -5, "3M": -10, "6M": 4 },
  }));
  assert.equal(out.state, ENTRY_STATES.STABILIZING);
  assert.deepEqual(out.reasons, []);
});

check("slow-bleeder skipped when percentile is null (no universe)", () => {
  const out = computeEntryTiming(row({
    returnsPct: { "7D": -1, "1M": -5, "3M": -10 },
    universeR3m: null,
  }));
  assert.equal(out.state, ENTRY_STATES.STABILIZING);
  assert.deepEqual(out.reasons, [REASON.DEGRADED_NO_PERCENTILE]);
  assert.equal(out.momentum_pct_3m, null);
});

check("multi-leg knife collects every firing leg in evaluation order", () => {
  const out = computeEntryTiming(row({
    returnsPct: { "7D": -8, "1M": -15, "3M": -25, "6M": -10 }, // pct3m = 0.1
    fiftyTwoWeek: { low: 80, high: 140 },
    currentPriceInr: 90,
  }));
  assert.equal(out.state, ENTRY_STATES.FALLING_KNIFE);
  assert.deepEqual(out.reasons, [
    REASON.KNIFE_1M,
    REASON.KNIFE_3M,
    REASON.KNIFE_52W_HIGH,
    REASON.KNIFE_7D,
    REASON.KNIFE_SLOW_BLEEDER,
  ]);
});

check("knife 52w leg skipped + degraded when 52w band missing", () => {
  const out = computeEntryTiming(row({
    returnsPct: { "7D": 1, "1M": -12, "3M": 5 },
    fiftyTwoWeek: null,
  }));
  assert.equal(out.state, ENTRY_STATES.FALLING_KNIFE);
  assert.deepEqual(out.reasons, [REASON.KNIFE_1M, REASON.DEGRADED_NO_52W]);
  assert.equal(out.fiftytwo_week_position, null);
});

// ---------------------------------------------------------------- hysteresis

// pct3m for r3m=-5 is 0.3 (≥ 0.25) so the slow-bleeder cannot fire — these
// cases isolate the hysteresis path from every entry leg.
check("hysteresis HOLDS at r1m=-10 with prevState FALLING_KNIFE", () => {
  const out = computeEntryTiming(row({
    returnsPct: { "7D": -1, "1M": -10, "3M": -5 },
    prevState: ENTRY_STATES.FALLING_KNIFE,
  }));
  assert.equal(out.state, ENTRY_STATES.FALLING_KNIFE);
  assert.deepEqual(out.reasons, [REASON.KNIFE_HELD_HYSTERESIS]);
});

check("hysteresis RELEASES at r1m=-8", () => {
  const out = computeEntryTiming(row({
    returnsPct: { "7D": -1, "1M": -8, "3M": -5 },
    prevState: ENTRY_STATES.FALLING_KNIFE,
  }));
  assert.equal(out.state, ENTRY_STATES.STABILIZING);
  assert.deepEqual(out.reasons, []);
});

check("hysteresis releases at exactly r1m=-9 (strict less-than)", () => {
  const out = computeEntryTiming(row({
    returnsPct: { "7D": -1, "1M": -9, "3M": -5 },
    prevState: ENTRY_STATES.FALLING_KNIFE,
  }));
  assert.equal(out.state, ENTRY_STATES.STABILIZING);
});

check("no hysteresis without a prior FALLING_KNIFE state", () => {
  const out = computeEntryTiming(row({
    returnsPct: { "7D": -1, "1M": -10, "3M": -5 },
    prevState: "STABILIZING",
  }));
  assert.equal(out.state, ENTRY_STATES.STABILIZING);
  assert.deepEqual(out.reasons, []);
});

// ------------------------------------------------------------ ENTRY_CONFIRMED

check("CONFIRMED happy path with full output shape", () => {
  const out = computeEntryTiming(row());
  assert.deepEqual(out, {
    version: ENTRY_TIMING_VERSION,
    state: ENTRY_STATES.ENTRY_CONFIRMED,
    reasons: [REASON.CONFIRMED_ALL],
    momentum_pct_3m: 0.5,
    fiftytwo_week_position: 0.5, // (120-100)/(140-100)
    tier: 1,
    as_of: "2026-07-03",
  });
});

check("CONFIRMED needs strictly positive 1M (r1m=0 fails)", () => {
  const out = computeEntryTiming(row({ returnsPct: { "7D": 1, "1M": 0, "3M": 5 } }));
  assert.equal(out.state, ENTRY_STATES.STABILIZING);
});

check("CONFIRMED needs pct3m at/above median (0.4 fails)", () => {
  const out = computeEntryTiming(row({ returnsPct: { "7D": 1, "1M": 2, "3M": -2 } }));
  assert.equal(out.state, ENTRY_STATES.STABILIZING);
  assert.equal(out.momentum_pct_3m, 0.4);
});

check("CONFIRMED needs px at least 1.05x 52w-low (104 fails, 105 passes)", () => {
  const blocked = computeEntryTiming(row({ currentPriceInr: 104 })); // 104/140 = 0.743, no knife
  assert.equal(blocked.state, ENTRY_STATES.STABILIZING);
  const cleared = computeEntryTiming(row({ currentPriceInr: 105 }));
  assert.equal(cleared.state, ENTRY_STATES.ENTRY_CONFIRMED);
});

check("missing 52w drops the clearance leg: CONFIRMED with degrade code", () => {
  const out = computeEntryTiming(row({ fiftyTwoWeek: null }));
  assert.equal(out.state, ENTRY_STATES.ENTRY_CONFIRMED);
  assert.deepEqual(out.reasons, [REASON.CONFIRMED_ALL, REASON.DEGRADED_NO_52W]);
  assert.equal(out.fiftytwo_week_position, null);
});

check("null universe blocks CONFIRMED (absence of evidence cannot confirm)", () => {
  const out = computeEntryTiming(row({ universeR3m: null }));
  assert.equal(out.state, ENTRY_STATES.STABILIZING);
  assert.deepEqual(out.reasons, [REASON.DEGRADED_NO_PERCENTILE]);
  assert.equal(out.momentum_pct_3m, null);
});

check("empty universe blocks CONFIRMED the same way", () => {
  const out = computeEntryTiming(row({ universeR3m: [] }));
  assert.equal(out.state, ENTRY_STATES.STABILIZING);
  assert.deepEqual(out.reasons, [REASON.DEGRADED_NO_PERCENTILE]);
});

// ---------------------------------------------------------------- MACRO_DEFER

function severeMacro(overrides = {}) {
  return {
    severity: 4,
    sectorImpacts: [
      { sector: "  Banks ", impact: -2, reason: "NIM compression under the shock" },
      { sector: "IT", impact: 1, reason: "export beneficiary" },
    ],
    ...overrides,
  };
}

check("CONFIRMED blocked to MACRO_DEFER on severe regime + matching sector", () => {
  const out = computeEntryTiming(row({ macro: severeMacro(), sector: "banks" }));
  assert.equal(out.state, ENTRY_STATES.MACRO_DEFER);
  assert.deepEqual(out.reasons, [REASON.MACRO_DEFER, REASON.CONFIRMED_ALL]);
});

check("mismatching sector stays CONFIRMED", () => {
  const out = computeEntryTiming(row({ macro: severeMacro(), sector: "Pharma" }));
  assert.equal(out.state, ENTRY_STATES.ENTRY_CONFIRMED);
  assert.deepEqual(out.reasons, [REASON.CONFIRMED_ALL]);
});

check("severity below the gate stays CONFIRMED", () => {
  const out = computeEntryTiming(row({ macro: severeMacro({ severity: 3 }), sector: "Banks" }));
  assert.equal(out.state, ENTRY_STATES.ENTRY_CONFIRMED);
});

check("sector impact above the cutoff (-1) stays CONFIRMED", () => {
  const out = computeEntryTiming(row({
    macro: severeMacro({ sectorImpacts: [{ sector: "Banks", impact: -1, reason: "mild" }] }),
    sector: "Banks",
  }));
  assert.equal(out.state, ENTRY_STATES.ENTRY_CONFIRMED);
});

check("MACRO_DEFER only demotes a would-be CONFIRMED, never STABILIZING", () => {
  const out = computeEntryTiming(row({
    returnsPct: { "7D": 1, "1M": 0, "3M": 5 }, // fails the r1m>0 leg
    macro: severeMacro(),
    sector: "Banks",
  }));
  assert.equal(out.state, ENTRY_STATES.STABILIZING);
  assert.ok(!out.reasons.includes(REASON.MACRO_DEFER));
});

// -------------------------------------------------- crashed-then-bounced base

check("crashed-then-bounced base is STABILIZING, not a knife", () => {
  // 52w_pos = (71.5-70)/(100-70) = 0.05; px/52wHigh = 0.715 (clears 0.7);
  // r1m = +20; pct3m(8) = 0.6. Confirmation fails only on 52w-low clearance:
  // 71.5 < 1.05*70 = 73.5 — the forming base, exactly NOT a knife.
  const out = computeEntryTiming(row({
    returnsPct: { "7D": 2, "1M": 20, "3M": 8 },
    fiftyTwoWeek: { low: 70, high: 100 },
    currentPriceInr: 71.5,
  }));
  assert.equal(out.state, ENTRY_STATES.STABILIZING);
  assert.deepEqual(out.reasons, []);
  assert.equal(out.momentum_pct_3m, 0.6);
  assert.ok(Math.abs(out.fiftytwo_week_position - 0.05) < 1e-9);
});

// -------------------------------------------------------------------- NO_DATA

check("NO_DATA on missing returnsPct", () => {
  const out = computeEntryTiming(row({ returnsPct: null }));
  assert.equal(out.state, ENTRY_STATES.NO_DATA);
  assert.deepEqual(out.reasons, [REASON.NO_RETURNS]);
  assert.equal(out.momentum_pct_3m, null);
  assert.equal(out.fiftytwo_week_position, null);
  assert.equal(out.version, ENTRY_TIMING_VERSION);
  assert.equal(out.tier, 1);
});

check("NO_DATA on non-finite 1M (string)", () => {
  const out = computeEntryTiming(row({ returnsPct: { "1M": "5", "3M": 5 } }));
  assert.equal(out.state, ENTRY_STATES.NO_DATA);
});

check("NO_DATA on absent 1M key", () => {
  const out = computeEntryTiming(row({ returnsPct: { "7D": 1, "3M": 5 } }));
  assert.equal(out.state, ENTRY_STATES.NO_DATA);
});

check("NO_DATA takes precedence over hysteresis", () => {
  const out = computeEntryTiming(row({ returnsPct: null, prevState: ENTRY_STATES.FALLING_KNIFE }));
  assert.equal(out.state, ENTRY_STATES.NO_DATA);
  assert.deepEqual(out.reasons, [REASON.NO_RETURNS]);
});

check("as_of defaults to null when the caller omits it", () => {
  const out = computeEntryTiming(row({ asOf: undefined }));
  assert.equal(out.as_of, null);
});

// --------------------------------------------------------------------- purity

check("deep-frozen inputs prove purity (no mutation anywhere)", () => {
  const input = deepFreeze({
    returnsPct: { "7D": -8, "1M": -15, "3M": -25, "6M": -10 },
    fiftyTwoWeek: { low: 80, high: 140 },
    currentPriceInr: 90,
    universeR3m: [...UNIVERSE],
    macro: { severity: 5, sectorImpacts: [{ sector: "Banks", impact: -3, reason: "shock" }] },
    sector: "Banks",
    prevState: ENTRY_STATES.FALLING_KNIFE,
    asOf: "2026-07-03",
  });
  const out = computeEntryTiming(input); // strict mode: any mutation throws
  assert.equal(out.state, ENTRY_STATES.FALLING_KNIFE);
  assert.deepEqual(input.universeR3m, UNIVERSE); // untouched, unsorted-in-place
});

check("determinism: identical inputs give deep-equal outputs", () => {
  assert.deepEqual(computeEntryTiming(row()), computeEntryTiming(row()));
});

// ------------------------------------------------------------ helper: percentile

check("percentileFractionBelow: empty array is null", () => {
  assert.equal(percentileFractionBelow(5, deepFreeze([])), null);
});

check("percentileFractionBelow: all universe below value is 1", () => {
  assert.equal(percentileFractionBelow(100, deepFreeze([1, 2, 3])), 1);
});

check("percentileFractionBelow: all universe above value is 0", () => {
  assert.equal(percentileFractionBelow(0, deepFreeze([1, 2, 3])), 0);
});

check("percentileFractionBelow: ties count strictly below", () => {
  assert.equal(percentileFractionBelow(2, deepFreeze([1, 2, 2, 3])), 0.25);
});

check("percentileFractionBelow: non-finite value or missing universe is null", () => {
  assert.equal(percentileFractionBelow(null, deepFreeze([1])), null);
  assert.equal(percentileFractionBelow(NaN, deepFreeze([1])), null);
  assert.equal(percentileFractionBelow(5, null), null);
});

// --------------------------------------------------------- helper: 52w position

check("fiftyTwoWeekPosition clamps to [0,1] and rejects degenerate bands", () => {
  assert.equal(fiftyTwoWeekPosition(110, deepFreeze({ low: 100, high: 140 })), 0.25);
  assert.equal(fiftyTwoWeekPosition(150, deepFreeze({ low: 100, high: 140 })), 1);
  assert.equal(fiftyTwoWeekPosition(90, deepFreeze({ low: 100, high: 140 })), 0);
  assert.equal(fiftyTwoWeekPosition(120, deepFreeze({ low: 100, high: 100 })), null);
  assert.equal(fiftyTwoWeekPosition(120, null), null);
  assert.equal(fiftyTwoWeekPosition(null, deepFreeze({ low: 100, high: 140 })), null);
});

// ------------------------------------------------------- helper: sector impact

check("resolveSectorImpact matches case-insensitive + trimmed", () => {
  const impacts = deepFreeze([{ sector: "  Banks ", impact: -2, reason: "x" }]);
  assert.equal(resolveSectorImpact("banks", impacts), -2);
  assert.equal(resolveSectorImpact(" BANKS  ", impacts), -2);
  assert.equal(resolveSectorImpact("IT", impacts), null);
  assert.equal(resolveSectorImpact(null, impacts), null);
  assert.equal(resolveSectorImpact("banks", null), null);
  assert.equal(resolveSectorImpact("banks", deepFreeze([{ sector: "banks", impact: "bad" }])), null);
});

console.log(`\nswsEntryTiming result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
