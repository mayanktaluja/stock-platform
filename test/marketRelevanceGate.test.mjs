/**
 * Run with: node test/marketRelevanceGate.test.mjs
 */

import assert from "node:assert/strict";
import { compileMarketGate, matchMarket } from "../services/alerts/marketRelevanceGate.js";

const g = compileMarketGate(["stock", "share", "nifty", "sensex", "rbi", "earnings", "result", "ipo", "dividend", "bitcoin", "crude", "bank", "tariff", "merger"]);

// Market / stock-relevant → kept.
assert.equal(matchMarket("Nifty closes at lifetime high; Reliance up 3%", g), true);
assert.equal(matchMarket("TCS Q1 results beat estimates, revenue up", g), true); // "result"
assert.equal(matchMarket("RBI issues final forex risk framework for banks", g), true);
assert.equal(matchMarket("IndiGo shares jump on recovery", g), true); // "share"→shares
assert.equal(matchMarket("Bitcoin falls below $60k", g), true);
assert.equal(matchMarket("Trump announces new tariff on imports", g), true);
assert.equal(matchMarket("Banking sector leads the rally", g), true); // "bank"→banking

// General news → dropped (no market keyword).
assert.equal(matchMarket("New restaurant opens in Bandra", g), false);
assert.equal(matchMarket("Pune businessman murder case: cops crack it", g), false);
assert.equal(matchMarket("MP CM faces heat over alleged land scam", g), false);
assert.equal(matchMarket("Celebrity wedding draws huge crowd", g), false);
assert.equal(matchMarket("Godown shed collapses in Taratala", g), false);

// Fail-open when no list configured.
assert.equal(matchMarket("literally anything", compileMarketGate([])), true);
assert.equal(matchMarket("", g), false);

console.log("marketRelevanceGate.test.mjs OK");
