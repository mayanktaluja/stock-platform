/**
 * Paper-trade registry coverage for Growing Sector Value.
 *
 * Run with: node test/paperTradesGrowingSectorValue.test.mjs
 */

import assert from "node:assert/strict";
import {
	  SWS_SECTION_TO_TYPE,
	  STANDARD_HORIZONS,
	  buildTradeEntry,
	  inferSideFromType,
	  shouldSkipSwsSectionSnapshot,
	} from "../paperTrades.js";

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ✓", name);
  } catch (e) {
    fail++;
    console.log("  ✗", name, "→", e.message);
  }
}

console.log("paperTrades Growing Sector Value registry\n");

check("SWS section maps to public long paper-trade type", () => {
  assert.equal(SWS_SECTION_TO_TYPE.growing_sector_value, "sws_growing_sector_value");
  assert.equal(inferSideFromType("sws_growing_sector_value"), "LONG");
});

check("buildTradeEntry uses standard horizons for growing-sector rows", () => {
  const entry = buildTradeEntry(
    {
      symbol: "AUTO.NS",
      name: "Auto Ltd",
      sector: "Automobile",
      price: 100,
      market_cap_inr: 1e11,
      score: 65,
    },
    "sws_growing_sector_value",
    {
      snapshotAt: "2026-06-03T04:00:00.000Z",
      niftyPrice: 23000,
      section_rank: 1,
    },
  );
  assert.equal(entry.type, "sws_growing_sector_value");
  assert.equal(entry.side, "LONG");
  assert.deepEqual(Object.keys(entry.returns_by_horizon), STANDARD_HORIZONS);
});

check("macro fallback rows are not snapshotted as canonical growing-sector track record", () => {
  assert.equal(shouldSkipSwsSectionSnapshot("growing_sector_value", {
    section_audit: {
      growing_sector_value: { display_mode: "macro_value_fallback" },
    },
  }), true);
  assert.equal(shouldSkipSwsSectionSnapshot("growing_sector_value", {
    section_audit: {
      growing_sector_value: { display_mode: "sector_outlook" },
    },
  }), false);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
