/**
 * Run with: node test/watchlistGate.test.mjs
 */

import assert from "node:assert/strict";
import { compileWatchlist, matchHeadline } from "../services/alerts/watchlistGate.js";

const wl = {
  tickers: ["RELIANCE", "INFY", "M&M", "LT", "IT"],
  aliases: {
    RELIANCE: ["Reliance", "RIL"],
    INFY: ["Infosys"],
    "M&M": ["Mahindra & Mahindra"],
    LT: ["Larsen", "L&T"],
  },
  sectorKeywords: ["banking", "automobile"],
};
const c = compileWatchlist(wl);

// "IT" (2 chars) is below the min-length floor and must be dropped → no matcher.
assert.ok(!c.perSymbol.some((p) => p.symbol === "IT"));
assert.ok(c.perSymbol.some((p) => p.symbol === "RELIANCE"));

// Ticker + alias hits.
assert.deepEqual(matchHeadline("Reliance Industries posts record profit", c).symbols, ["RELIANCE"]);
assert.deepEqual(matchHeadline("RIL board to meet Friday", c).symbols, ["RELIANCE"]);
assert.deepEqual(matchHeadline("Infosys wins $1bn deal", c).symbols, ["INFY"]);

// Ampersand alias survives (no plain \b around &).
assert.deepEqual(matchHeadline("M&M sales jump 12%", c).symbols, ["M&M"]);
assert.deepEqual(matchHeadline("Larsen & Toubro bags order", c).symbols, ["LT"]);

// Word-boundary: no match inside a larger token.
assert.equal(matchHeadline("RELIANCEXYZ corp news", c).matched, false);
assert.equal(matchHeadline("infosystems ltd update", c).matched, false);

// Sector keyword ALONE never matches (M2 false-positive guard).
assert.equal(matchHeadline("RBI tightens banking norms", c).matched, false);
assert.equal(matchHeadline("automobile demand weak this quarter", c).matched, false);

// Sector keyword counts only when co-occurring with a ticker.
const m = matchHeadline("Infosys flags weak banking vertical", c);
assert.deepEqual(m.symbols, ["INFY"]);
assert.deepEqual(m.sectors, ["banking"]);

// Empty / junk input.
assert.equal(matchHeadline("", c).matched, false);
assert.equal(matchHeadline("nothing relevant here", c).matched, false);

console.log("watchlistGate.test.mjs OK");
