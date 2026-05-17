/**
 * Tests for services/searchDedup.js — NSE/BSE dedup for the global
 * search dropdown.
 *
 * Invariants we never want to break:
 *   - Dual-listed (.NS + .BO) collapses to .NS regardless of input order
 *   - BSE-only fallback (.BO with no .NS pair) is preserved
 *   - Case-insensitive suffix detection (Yahoo sometimes returns .ns)
 *   - Null/empty/suffix-less symbols don't throw
 *   - Non-array inputs return [] instead of throwing
 *
 * Run with: node test/search-dedup.test.mjs
 */

import {
  bareTicker,
  isNseSymbol,
  dedupeByBareSymbol,
} from "../services/searchDedup.js";

let pass = 0,
  fail = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`✓ ${name}`);
    pass++;
  } else {
    console.log(`✗ ${name} — got: ${JSON.stringify(got)}`);
    fail++;
  }
}

// ──── bareTicker primitive ────
{
  assert("bareTicker strips .NS", bareTicker("RELIANCE.NS") === "RELIANCE", bareTicker("RELIANCE.NS"));
  assert("bareTicker strips .BO", bareTicker("AJAXENGG.BO") === "AJAXENGG", bareTicker("AJAXENGG.BO"));
  assert("bareTicker strips lowercase .ns", bareTicker("reliance.ns") === "RELIANCE", bareTicker("reliance.ns"));
  assert("bareTicker passes suffix-less symbol through", bareTicker("PRAJIND") === "PRAJIND", bareTicker("PRAJIND"));
  assert("bareTicker handles null", bareTicker(null) === "", bareTicker(null));
  assert("bareTicker handles undefined", bareTicker(undefined) === "", bareTicker(undefined));
  assert("bareTicker handles empty string", bareTicker("") === "", bareTicker(""));
}

// ──── isNseSymbol primitive ────
{
  assert("isNseSymbol true for .NS", isNseSymbol("RELIANCE.NS") === true, isNseSymbol("RELIANCE.NS"));
  assert("isNseSymbol true for lowercase .ns (defence)", isNseSymbol("RELIANCE.ns") === true, isNseSymbol("RELIANCE.ns"));
  assert("isNseSymbol false for .BO", isNseSymbol("RELIANCE.BO") === false, isNseSymbol("RELIANCE.BO"));
  assert("isNseSymbol false for null", isNseSymbol(null) === false, isNseSymbol(null));
  assert("isNseSymbol false for suffix-less", isNseSymbol("PRAJIND") === false, isNseSymbol("PRAJIND"));
}

// ──── Dual-listed collapses to NSE — order independent ────
{
  const out = dedupeByBareSymbol([
    { symbol: "AJAXENGG.NS", name: "Ajax NSE" },
    { symbol: "AJAXENGG.BO", name: "Ajax BSE" },
  ]);
  assert(".NS first → one row", out.length === 1, out);
  assert(".NS first → keeps .NS", out[0].symbol === "AJAXENGG.NS", out[0]);
}
{
  const out = dedupeByBareSymbol([
    { symbol: "AJAXENGG.BO", name: "Ajax BSE" },
    { symbol: "AJAXENGG.NS", name: "Ajax NSE" },
  ]);
  assert(".BO first → one row", out.length === 1, out);
  assert(".BO first → still keeps .NS (upgrade path)", out[0].symbol === "AJAXENGG.NS", out[0]);
}

// ──── Case-insensitive suffix (F4 — defence against Yahoo lowercase) ────
{
  const out = dedupeByBareSymbol([
    { symbol: "AJAXENGG.bo", name: "Ajax BSE lowercase" },
    { symbol: "AJAXENGG.ns", name: "Ajax NSE lowercase" },
  ]);
  assert("lowercase .ns still recognised as NSE", out.length === 1 && out[0].symbol === "AJAXENGG.ns", out);
}

// ──── BSE-only fallback preserved ────
{
  const out = dedupeByBareSymbol([{ symbol: "XYZ.BO", name: "SME only" }]);
  assert("BSE-only kept when no NSE pair", out.length === 1 && out[0].symbol === "XYZ.BO", out);
}

// ──── Multiple distinct stocks pass through unchanged ────
{
  const input = [
    { symbol: "RELIANCE.NS", name: "Reliance" },
    { symbol: "TCS.NS", name: "TCS" },
    { symbol: "INFY.NS", name: "Infosys" },
  ];
  const out = dedupeByBareSymbol(input);
  assert("no dups → length unchanged", out.length === 3, out.length);
  assert("no dups → order preserved", out[0].symbol === "RELIANCE.NS" && out[2].symbol === "INFY.NS", out.map((r) => r.symbol));
}

// ──── Mixed payload: some dual, some single ────
{
  const out = dedupeByBareSymbol([
    { symbol: "AJAXENGG.NS" },
    { symbol: "AJAXENGG.BO" },
    { symbol: "XYZ.BO" },
    { symbol: "RELIANCE.NS" },
  ]);
  const syms = out.map((r) => r.symbol).sort();
  assert("mixed → 3 rows", out.length === 3, out);
  assert("mixed → AJAX.NS, RELIANCE.NS, XYZ.BO", JSON.stringify(syms) === JSON.stringify(["AJAXENGG.NS", "RELIANCE.NS", "XYZ.BO"]), syms);
}

// ──── Null/empty/suffix-less defence (F3) ────
{
  const out = dedupeByBareSymbol([
    { symbol: null },
    { symbol: "" },
    { symbol: undefined },
    null,
    { name: "no symbol" },
  ]);
  assert("garbage symbols → empty result, no throw", out.length === 0, out);
}
{
  const out = dedupeByBareSymbol([{ symbol: "PRAJIND", name: "Praj no suffix" }]);
  assert("suffix-less symbol kept under bare key", out.length === 1 && out[0].symbol === "PRAJIND", out);
}

// ──── BSE numeric code (e.g. "500325.BO") — bare key is the numeric part ────
{
  const out = dedupeByBareSymbol([{ symbol: "500325.BO", name: "BSE numeric" }]);
  assert("BSE numeric code kept", out.length === 1 && out[0].symbol === "500325.BO", out);
}

// ──── Non-array input ────
{
  assert("null input → []", JSON.stringify(dedupeByBareSymbol(null)) === "[]", dedupeByBareSymbol(null));
  assert("undefined input → []", JSON.stringify(dedupeByBareSymbol(undefined)) === "[]", dedupeByBareSymbol(undefined));
  assert("object input → []", JSON.stringify(dedupeByBareSymbol({})) === "[]", dedupeByBareSymbol({}));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
