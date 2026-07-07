/**
 * Tests for services/regionIndexConstituents.js — the generic (US)
 * index-membership engine behind the universe dropdowns. Covers:
 *   • MARKET_NORMALISERS: US dotted share classes (-,/ → .)
 *   • buildMarketIndexSets(): normalises list tickers to the picks-row form
 *   • stampMarketIndexFlags(): membership per market incl. share-class matching
 *     across source/picks ticker variants (BRK-B list vs BRK.B row)
 *   • loadMarketIndexConstituents(): missing/corrupt → available:false
 *   • availableMarketIndexKeys(): empty index → option disabled
 *
 * Run with: node test/regionIndexConstituents.test.mjs
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  MARKET_INDEX_KEYS,
  MARKET_NORMALISERS,
  buildMarketIndexSets,
  loadMarketIndexConstituents,
  stampMarketIndexFlags,
  availableMarketIndexKeys,
} from "../services/regionIndexConstituents.js";

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, "→ got", JSON.stringify(got)); }
}

console.log("\nMARKET_NORMALISERS — US (dotted share classes)");
assert("AAPL → AAPL", MARKET_NORMALISERS.us("AAPL") === "AAPL");
assert("BRK.B → BRK.B", MARKET_NORMALISERS.us("BRK.B") === "BRK.B");
assert("BRK-B → BRK.B", MARKET_NORMALISERS.us("BRK-B") === "BRK.B");
assert("BRK/B → BRK.B", MARKET_NORMALISERS.us("BRK/B") === "BRK.B");
assert("lower brk.b → BRK.B", MARKET_NORMALISERS.us("brk.b") === "BRK.B");
assert("null → empty", MARKET_NORMALISERS.us(null) === "");

console.log("\nbuildMarketIndexSets() — US normalises list tickers");
{
  const sets = buildMarketIndexSets({ sp500: ["AAPL", "BRK-B"], dow30: ["AAPL"], nasdaq100: [], russell2000: [] }, "us");
  assert("sp500 size 2", sets.sp500.size === 2, sets.sp500.size);
  assert("sp500 has AAPL", sets.sp500.has("AAPL"));
  assert("sp500 has BRK.B (from BRK-B)", sets.sp500.has("BRK.B"));
  assert("dow30 size 1", sets.dow30.size === 1, sets.dow30.size);
  assert("nasdaq100 empty", sets.nasdaq100.size === 0);
}
{
  const sets = buildMarketIndexSets(null, "us");
  assert("null → all four US sets empty", MARKET_INDEX_KEYS.us.every((k) => sets[k].size === 0));
}

console.log("\nstampMarketIndexFlags() — US (incl. share-class variant match)");
{
  const sets = buildMarketIndexSets({ sp500: ["AAPL", "BRK-B"], dow30: ["AAPL"], nasdaq100: ["AAPL"], russell2000: [] }, "us");
  const aapl = { ticker: "AAPL" };
  stampMarketIndexFlags(aapl, sets, "us");
  assert("AAPL sp500", aapl.sp500 === true);
  assert("AAPL dow30", aapl.dow30 === true);
  assert("AAPL nasdaq100", aapl.nasdaq100 === true);
  assert("AAPL !russell2000", aapl.russell2000 === false);
  // picks row is BRK.B; list had BRK-B — normaliser folds both to BRK.B
  const brk = { ticker: "BRK.B" };
  stampMarketIndexFlags(brk, sets, "us");
  assert("BRK.B row matches BRK-B list entry", brk.sp500 === true, brk.sp500);
  assert("BRK.B !dow30", brk.dow30 === false);
  const out = { ticker: "ZZZZ" };
  stampMarketIndexFlags(out, sets, "us");
  assert("outsider all false", !out.sp500 && !out.dow30 && !out.nasdaq100 && !out.russell2000);
}

console.log("\nstampMarketIndexFlags() — guards");
{
  const sets = buildMarketIndexSets({ sp500: ["AAPL"] }, "us");
  const noTicker = { foo: "bar" };
  stampMarketIndexFlags(noTicker, sets, "us");
  assert("row without ticker untouched", noTicker.sp500 === undefined, noTicker.sp500);
  stampMarketIndexFlags(null, sets, "us");
  stampMarketIndexFlags({ ticker: "AAPL" }, sets, "zz"); // unknown market: no throw
  assert("null row + unknown market tolerated", true);
}

console.log("\navailableMarketIndexKeys()");
{
  const sets = buildMarketIndexSets({ sp500: ["AAPL"], dow30: ["AAPL"], nasdaq100: [], russell2000: [] }, "us");
  const avail = availableMarketIndexKeys(sets, "us");
  assert("only populated indexes available", avail.length === 2 && avail.includes("sp500") && avail.includes("dow30"), avail);
}

console.log("\nloadMarketIndexConstituents() — missing + corrupt");
{
  const r = loadMarketIndexConstituents("/tmp/nope-region-idx-123.json", "us");
  assert("missing → available false", r.available === false, r.available);
  assert("missing → empty sets", r.sets.sp500.size === 0);
}
{
  const tmp = path.join(os.tmpdir(), `region-idx-test-${process.pid}.json`);
  fs.writeFileSync(tmp, "<<not json>>");
  const r = loadMarketIndexConstituents(tmp, "us");
  fs.unlinkSync(tmp);
  assert("corrupt → available false", r.available === false, r.available);
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) process.exit(1);
