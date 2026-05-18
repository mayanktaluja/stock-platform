/**
 * Tests for services/nseTickerAliases.js — the NSE corporate-action
 * rename map consulted by scripts/refresh-fundamentals.mjs to fold
 * obsolete tickers (TATAMOTORS / LTIM / ZOMATO) into their successors.
 *
 * Run with: node test/nseTickerAliases.test.mjs
 */

import {
  NSE_TICKER_RENAMES,
  resolveCurrentNseSymbol,
  isObsoleteNseSymbol,
} from "../services/nseTickerAliases.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${got !== undefined ? ` (got ${JSON.stringify(got)})` : ""}`);
  }
}

console.log("\nnseTickerAliases\n");

// The three renames captured in fundamentals.json's failure list.
assert("TATAMOTORS.NS resolves to TMPV.NS",
  resolveCurrentNseSymbol("TATAMOTORS.NS") === "TMPV.NS");
assert("LTIM.NS resolves to LTM.NS",
  resolveCurrentNseSymbol("LTIM.NS") === "LTM.NS");
assert("ZOMATO.NS resolves to ETERNAL.NS",
  resolveCurrentNseSymbol("ZOMATO.NS") === "ETERNAL.NS");

// Non-renamed symbols pass through unchanged.
assert("RELIANCE.NS passes through unchanged",
  resolveCurrentNseSymbol("RELIANCE.NS") === "RELIANCE.NS");
assert("TMPV.NS (already current) passes through unchanged",
  resolveCurrentNseSymbol("TMPV.NS") === "TMPV.NS");

// Defensive: nullish input.
assert("null input returns null",
  resolveCurrentNseSymbol(null) === null);
assert("undefined input returns undefined",
  resolveCurrentNseSymbol(undefined) === undefined);
assert("empty string returns empty string",
  resolveCurrentNseSymbol("") === "");

// isObsoleteNseSymbol mirrors the map.
assert("isObsoleteNseSymbol(TATAMOTORS.NS) === true",
  isObsoleteNseSymbol("TATAMOTORS.NS") === true);
assert("isObsoleteNseSymbol(TMPV.NS) === false",
  isObsoleteNseSymbol("TMPV.NS") === false);
assert("isObsoleteNseSymbol(null) === false",
  isObsoleteNseSymbol(null) === false);

// The map is frozen so callers can't accidentally mutate it.
assert("NSE_TICKER_RENAMES is frozen",
  Object.isFrozen(NSE_TICKER_RENAMES));

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
