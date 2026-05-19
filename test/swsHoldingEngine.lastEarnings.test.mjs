// Integration test for the last-earnings wiring in scoreHolding().
//
// Confirms that when a stock has a qualifying SWS news brief on disk,
// scoreHolding() surfaces `last_earnings_date` and `last_earnings_period`
// on its `sws` payload — and that callers without an SWS deep file get
// `null` / fallback (covered separately by the extractor unit suite).
//
// RELIANCE.json is used as the fixture because its `news[]` consistently
// carries the "Full year YYYY earnings: …" brief that the extractor
// classifies as `period: annual`.

import assert from "node:assert/strict";
import { scoreHolding } from "../services/swsHoldingEngine.js";

const rescored = scoreHolding({ symbol: "RELIANCE", positionWeight: 0, sectorWeight: 0, pnlPercent: 0 });

assert(rescored.sws, "scoreHolding must produce a .sws payload for a covered ticker");
assert.equal(typeof rescored.sws.last_earnings_date, "string",
  "last_earnings_date must be an ISO date string for a ticker with an SWS brief");
assert.match(rescored.sws.last_earnings_date, /^\d{4}-\d{2}-\d{2}$/,
  "last_earnings_date must match YYYY-MM-DD");
assert.ok(["quarter", "annual"].includes(rescored.sws.last_earnings_period),
  `last_earnings_period must be 'quarter' or 'annual', got: ${rescored.sws.last_earnings_period}`);

console.log("  ✓ scoreHolding(RELIANCE) surfaces last_earnings_date =", rescored.sws.last_earnings_date);
console.log("  ✓ scoreHolding(RELIANCE) surfaces last_earnings_period =", rescored.sws.last_earnings_period);
console.log("\n2 passed, 0 failed");
