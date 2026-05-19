/**
 * Tests for services/compounder/compounderRanker.js — filter + ranker logic.
 *
 * Run with: node test/compounderRanker.test.mjs
 */

import {
  COMPOUNDER_FILTER,
  applyCompounderFilter,
  rankCompounderCandidates,
} from "../services/compounder/compounderRanker.js";

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

function makeEntry(overrides = {}) {
  return {
    ticker: "TEST",
    name: "Test Co",
    sector: "Industrials",
    sws_url: "",
    snowflake_past: 5,
    snowflake_health: 4,
    snowflake_dividend: 4,
    risks: [],
    market_cap_inr: 1000_00_00_000,
    current_price_inr: 100,
    fair_value_inr: 150,
    upside_pct: 50,
    fv_reconcile_reason: "ok",
    ...overrides,
  };
}

console.log("\ncompounderRanker — applyCompounderFilter");

assert(
  "perfect candidate passes",
  applyCompounderFilter(makeEntry()).passed === true,
);
assert(
  "snowflake_past < 5 fails",
  applyCompounderFilter(makeEntry({ snowflake_past: 4 })).passed === false,
);
assert(
  "snowflake_health < 4 fails",
  applyCompounderFilter(makeEntry({ snowflake_health: 3 })).passed === false,
);
assert(
  "snowflake_dividend < 4 fails",
  applyCompounderFilter(makeEntry({ snowflake_dividend: 3 })).passed === false,
);

assert(
  "market_cap below ₹500Cr fails",
  applyCompounderFilter(makeEntry({ market_cap_inr: 100_00_00_000 })).passed === false,
);
assert(
  "market_cap above ₹500Cr passes",
  applyCompounderFilter(makeEntry({ market_cap_inr: 600_00_00_000 })).passed === true,
);

assert(
  "debt risk keyword rejects (interest)",
  applyCompounderFilter(makeEntry({ risks: ["Interest payments are not well covered"] })).passed === false,
);
assert(
  "debt risk keyword rejects (operating cash flow)",
  applyCompounderFilter(makeEntry({ risks: ["Debt is not well covered by operating cash flow"] })).passed === false,
);
assert(
  "unprofitable risk rejects",
  applyCompounderFilter(makeEntry({ risks: ["Unprofitable in last 5y"] })).passed === false,
);
assert(
  "benign risk passes",
  applyCompounderFilter(makeEntry({ risks: ["Dividend payments are not well covered by earnings"] })).passed === true,
);

assert(
  "missing upside_pct fails",
  applyCompounderFilter(makeEntry({ upside_pct: null })).passed === false,
);

assert(
  "fv_imputed reconcile reason fails",
  applyCompounderFilter(makeEntry({ fv_reconcile_reason: "fv_imputed" })).passed === false,
);

assert(
  "invalid entry returns false",
  applyCompounderFilter(null).passed === false,
);

console.log("\ncompounderRanker — rankCompounderCandidates");

const universe = [
  makeEntry({ ticker: "A", upside_pct: 30 }),
  makeEntry({ ticker: "B", upside_pct: 100 }),
  makeEntry({ ticker: "C", upside_pct: 50 }),
  makeEntry({ ticker: "REJ", upside_pct: 200, snowflake_past: 3 }),
];
const ranked = rankCompounderCandidates(universe);

assert("passed_count = 3", ranked.passed_count === 3, ranked.passed_count);
assert("rejected_count = 1", ranked.rejected_count === 1, ranked.rejected_count);
assert("basket sorted by upside DESC — B first", ranked.basket[0].ticker === "B", ranked.basket[0].ticker);
assert("basket — C second", ranked.basket[1].ticker === "C", ranked.basket[1].ticker);
assert("basket — A third", ranked.basket[2].ticker === "A", ranked.basket[2].ticker);
assert("REJ not in basket", !ranked.basket.find((b) => b.ticker === "REJ"));

const opts = { ...COMPOUNDER_FILTER, basket_size: 2 };
const rankedSmall = rankCompounderCandidates(universe, opts);
assert("basket_size override caps the basket", rankedSmall.basket.length === 2, rankedSmall.basket.length);

try {
  rankCompounderCandidates(null);
  fail++;
  console.log("  ✗ throws on non-array input");
} catch {
  pass++;
  console.log("  ✓ throws on non-array input");
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
