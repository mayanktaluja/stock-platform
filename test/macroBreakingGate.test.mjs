/**
 * Run with: node test/macroBreakingGate.test.mjs
 */

import assert from "node:assert/strict";
import { compileMacroGate, matchMacro } from "../services/alerts/macroBreakingGate.js";

const c = compileMacroGate();

// Positives — high-signal breaking headlines.
assert.equal(matchMacro("Fed hikes rates by 25 bps", c).matched, true);
assert.equal(matchMacro("Trump announces new tariff", c).matched, true);
assert.equal(matchMacro("Crude oil surges as OPEC cuts", c).matched, true);
assert.equal(matchMacro("Nifty crash wipes out gains", c).matched, true);
assert.equal(matchMacro("RBI holds repo rate", c).matched, true);

// Negatives — no macro term present, must not false-positive.
assert.equal(matchMacro("ease into the weekend", c).matched, false);
assert.equal(matchMacro("barrel of laughs", c).matched, false);
assert.equal(matchMacro("budget-friendly phone", c).matched, false);
assert.equal(matchMacro("Reliance posts profit", c).matched, false);

// Word-boundary — no match inside a larger token.
assert.equal(matchMacro("ratehiked overnight", c).matched, false);
assert.equal(matchMacro("fedex delivers parcel", c).matched, false);

// hits array contents — distinct, lowercased matched terms.
const fed = matchMacro("Fed hikes rates by 25 bps", c);
assert.ok(fed.hits.includes("fed"));
assert.ok(fed.hits.includes("bps"));

// Multi-word superset wins over substring (longest-first alternation).
const crash = matchMacro("Nifty crash wipes out gains", c);
assert.ok(crash.hits.includes("nifty crash"));
assert.ok(!crash.hits.includes("nifty"));

// Dedup — same term twice in one headline collapses to one hit.
const dup = matchMacro("tariff on steel, tariff on aluminium", c);
assert.deepEqual(dup.hits, ["tariff"]);

// extraKeywords are folded in.
const ce = compileMacroGate(["yield curve"]);
assert.equal(matchMacro("yield curve inverts sharply", ce).matched, true);

// Empty / junk input.
assert.equal(matchMacro("", c).matched, false);
assert.deepEqual(matchMacro("", c).hits, []);

console.log("macroBreakingGate.test.mjs OK");
