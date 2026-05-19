/**
 * Tests for services/earningsEdge/edgeFilter.js — KEC-bug-list filter.
 *
 * Run with: node test/earningsEdgeFilter.test.mjs
 */

import {
  EARNINGS_EDGE_FILTER,
  applyEarningsEdgeFilter,
  sizePosition,
  evaluateExit,
} from "../services/earningsEdge/edgeFilter.js";

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

function makeEvent(overrides = {}) {
  return {
    symbol: "TEST",
    sector: "Software",
    actual_verdict: "BEAT",
    event_iso_date: "2026-05-15",
    signals: {
      market_cap_inr: 2000_00_00_000,
      v3: { breakdown: { fv_imputed: false } },
    },
    ...overrides,
  };
}
function makeDeep(overrides = {}) {
  return {
    sector: "Software",
    overview: {
      snowflake: { health: 5 },
      risks: [],
      market_cap_inr: 2000_00_00_000,
    },
    news: [],
    ...overrides,
  };
}
function makeCtx(deepOverrides = {}, surv = {}) {
  return {
    deep: makeDeep(deepOverrides),
    surveillance: surv,
  };
}

console.log("\nedgeFilter — applyEarningsEdgeFilter");

assert(
  "perfect BEAT passes",
  applyEarningsEdgeFilter(makeEvent(), makeCtx()).passed === true,
);
assert(
  "non-BEAT rejected",
  applyEarningsEdgeFilter(makeEvent({ actual_verdict: "MISS" }), makeCtx()).passed === false,
);
assert(
  "unresolved rejected",
  applyEarningsEdgeFilter(makeEvent({ actual_verdict: null }), makeCtx()).passed === false,
);

// KEC bug #1 — prior-quarter MISS regex
const priorMissNews = [
  {
    date: "2026-02-15T12:00:00Z",
    title: "Q3 results: EPS and revenues miss analyst expectations",
    body: "Quarterly results came in below estimates",
  },
];
assert(
  "prior-Q-miss in news[] rejects",
  applyEarningsEdgeFilter(
    makeEvent({ event_iso_date: "2026-05-15" }),
    makeCtx({ news: priorMissNews }),
  ).passed === false,
);

// Same date outside the lookback window must NOT reject
const oldMissNews = [
  {
    date: "2025-08-15T12:00:00Z",
    title: "miss analyst expectations",
    body: "old",
  },
];
assert(
  "old miss (outside lookback) does NOT reject",
  applyEarningsEdgeFilter(
    makeEvent({ event_iso_date: "2026-05-15" }),
    makeCtx({ news: oldMissNews }),
  ).passed === true,
);

// Brief AFTER the event date is the event's own brief — don't count
const sameDayMissNews = [
  {
    date: "2026-05-15T18:00:00Z",
    title: "miss analyst expectations",
    body: "current event",
  },
];
assert(
  "same-event-day miss is NOT a prior-Q miss",
  applyEarningsEdgeFilter(
    makeEvent({ event_iso_date: "2026-05-15" }),
    makeCtx({ news: sameDayMissNews }),
  ).passed === true,
);

// KEC bug #2 — fv_imputed haircut
assert(
  "fv_imputed=true rejects",
  applyEarningsEdgeFilter(
    makeEvent({ signals: { market_cap_inr: 2000_00_00_000, v3: { breakdown: { fv_imputed: true } } } }),
    makeCtx(),
  ).passed === false,
);

// KEC bug #3 — debt/liquidity risk keywords
assert(
  "interest-not-well-covered rejects",
  applyEarningsEdgeFilter(
    makeEvent(),
    makeCtx({ overview: { snowflake: { health: 5 }, risks: ["Interest payments are not well covered by earnings"], market_cap_inr: 2000_00_00_000 } }),
  ).passed === false,
);
assert(
  "benign risk does NOT reject",
  applyEarningsEdgeFilter(
    makeEvent(),
    makeCtx({ overview: { snowflake: { health: 5 }, risks: ["Dividend payments are unstable"], market_cap_inr: 2000_00_00_000 } }),
  ).passed === true,
);

// KEC bug #4 — problem-sector watchlist
assert(
  "Power T&D sector rejects",
  applyEarningsEdgeFilter(
    makeEvent({ sector: "Power T&D" }),
    makeCtx(),
  ).passed === false,
);
assert(
  "EPC sector rejects (case-insensitive)",
  applyEarningsEdgeFilter(
    makeEvent({ sector: "epc engineering" }),
    makeCtx(),
  ).passed === false,
);
assert(
  "Software sector does NOT reject",
  applyEarningsEdgeFilter(makeEvent(), makeCtx()).passed === true,
);

// snowflake.health gate
assert(
  "snowflake.health<3 rejects",
  applyEarningsEdgeFilter(
    makeEvent(),
    makeCtx({ overview: { snowflake: { health: 2 }, risks: [], market_cap_inr: 2000_00_00_000 } }),
  ).passed === false,
);

// market_cap gate
assert(
  "market_cap<₹1000Cr rejects",
  applyEarningsEdgeFilter(
    makeEvent({ signals: { market_cap_inr: 100_00_00_000, v3: { breakdown: { fv_imputed: false } } } }),
    makeCtx({ overview: { snowflake: { health: 5 }, risks: [], market_cap_inr: 100_00_00_000 } }),
  ).passed === false,
);

// ASM/GSM gate
assert(
  "ASM-listed rejects",
  applyEarningsEdgeFilter(
    makeEvent({ symbol: "BADSTOCK" }),
    makeCtx({}, { ASM: new Set(["BADSTOCK"]) }),
  ).passed === false,
);

console.log("\nedgeFilter — sizePosition");

// At ₹2000Cr mcap: ADV proxy = ₹20Cr → 0.25% = ₹5L → capped at ₹1L.
// The cap is binding for every name that passes the ₹1000Cr mcap gate;
// the proportional logic only matters for sub-threshold names which the
// filter already rejects.
assert(
  "₹2000Cr mcap → ₹100k (cap wins)",
  sizePosition(2000_00_00_000) === 100_000,
  sizePosition(2000_00_00_000),
);
assert(
  "₹10000Cr mcap → capped at ₹100k",
  sizePosition(10000_00_00_000) === 100_000,
  sizePosition(10000_00_00_000),
);
// Below ~₹400Cr mcap, the proportional logic produces sub-₹1L values and
// the cap doesn't bind. Tested with a value the filter would reject anyway —
// this is just verifying the math (ADV proxy = mcap × 1%, position = 0.25% of ADV).
//   ₹200Cr → ADV ₹2Cr → 0.25% = ₹50k.
assert(
  "₹200Cr mcap → ₹50k (proportional, no cap)",
  sizePosition(200_00_00_000) === 50_000,
  sizePosition(200_00_00_000),
);
assert(
  "invalid mcap → 0",
  sizePosition(null) === 0,
);

console.log("\nedgeFilter — evaluateExit");

assert(
  "HOLD when within targets",
  evaluateExit(
    { entry_date: "2026-05-01", entry_price_inr: 100 },
    { close_price_inr: 105, peak_close_inr: 110, days_held: 10 },
  ).action === "HOLD",
);

assert(
  "EXIT on hard stop -12%",
  evaluateExit(
    { entry_price_inr: 100 },
    { close_price_inr: 88, peak_close_inr: 100, days_held: 5 },
  ).action === "EXIT",
);
assert(
  "EXIT on trailing stop -8% from peak",
  evaluateExit(
    { entry_price_inr: 100 },
    { close_price_inr: 92, peak_close_inr: 105, days_held: 5 },
  ).action === "EXIT",
);
assert(
  "EXIT on T+30 hold expiry",
  evaluateExit(
    { entry_price_inr: 100 },
    { close_price_inr: 110, peak_close_inr: 110, days_held: 31 },
  ).action === "EXIT",
);

// Priority: hard-stop wins over trail-stop wins over hold-expiry
assert(
  "hard-stop wins over hold-expiry",
  evaluateExit(
    { entry_price_inr: 100 },
    { close_price_inr: 80, peak_close_inr: 100, days_held: 35 },
  ).reason.startsWith("hard-stop"),
);

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
