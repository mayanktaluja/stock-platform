/**
 * Regression tests for portfolioParser.js + stockList.js symbol resolution.
 *
 * Focus: the symbol-only lookup path that was silently dropping Nifty 50
 * flagships into `unmatched` because findByName fuzzy-matches company
 * names (not tickers) and there was no symbol index at all.
 *
 * Run with: node test/portfolioParser.test.mjs
 */

import { parsePortfolioFile } from "../portfolioParser.js";
import { findBySymbol, findByIsin, findByName } from "../stockList.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  \u2713", name);
  } else {
    fail++;
    console.log("  \u2717", name, "\u2192 got", got);
  }
}

// ──────────────────── findBySymbol unit tests ────────────────────

console.log("\nfindBySymbol unit tests\n");

// Bare ticker resolves
{
  const s = findBySymbol("TCS");
  assert("bare 'TCS' → TCS.NS", s?.symbol === "TCS.NS", s?.symbol);
}
{
  const s = findBySymbol("RELIANCE");
  assert("bare 'RELIANCE' → RELIANCE.NS", s?.symbol === "RELIANCE.NS", s?.symbol);
}
{
  const s = findBySymbol("HDFCBANK");
  assert("bare 'HDFCBANK' → HDFCBANK.NS", s?.symbol === "HDFCBANK.NS", s?.symbol);
}
{
  const s = findBySymbol("INFY");
  assert("bare 'INFY' → INFY.NS", s?.symbol === "INFY.NS", s?.symbol);
}
{
  const s = findBySymbol("ICICIBANK");
  assert("bare 'ICICIBANK' → ICICIBANK.NS", s?.symbol === "ICICIBANK.NS", s?.symbol);
}

// Full-suffix forms resolve
{
  const s = findBySymbol("TCS.NS");
  assert("full 'TCS.NS' → TCS.NS", s?.symbol === "TCS.NS", s?.symbol);
}
{
  const s = findBySymbol("tcs.ns");
  assert("lowercase 'tcs.ns' resolves", s?.symbol === "TCS.NS", s?.symbol);
}
{
  const s = findBySymbol("  RELIANCE  ");
  assert("whitespace 'RELIANCE' resolves", s?.symbol === "RELIANCE.NS", s?.symbol);
}

// Negative cases return null (not crash)
{
  const s = findBySymbol("");
  assert("empty string → null", s === null, s);
}
{
  const s = findBySymbol(null);
  assert("null input → null", s === null, s);
}
{
  const s = findBySymbol("NOTATICKER");
  assert("unknown ticker → null", s === null, s);
}

// ──────────────────── parsePortfolioFile end-to-end ────────────────────

console.log("\nparsePortfolioFile end-to-end\n");

// The bug we're fixing: bare symbols used to end up in `unmatched`
{
  const csv =
    "Symbol,Quantity,Avg Price\n" +
    "TCS,5,3800\n" +
    "RELIANCE,10,2500\n" +
    "HDFCBANK,8,1500\n" +
    "INFY,12,1800\n" +
    "ICICIBANK,15,1100\n";
  const out = parsePortfolioFile(csv, "test.csv");
  assert("5 bare-symbol Nifty 50 rows all resolve to holdings", out.holdings.length === 5, `${out.holdings.length} holdings / ${out.unmatched.length} unmatched`);
  assert("none land in unmatched", out.unmatched.length === 0, out.unmatched.length);
  const syms = out.holdings.map((h) => h.symbol).sort();
  assert(
    "symbols include all 5 NSE-suffixed names",
    JSON.stringify(syms) === JSON.stringify(["HDFCBANK.NS","ICICIBANK.NS","INFY.NS","RELIANCE.NS","TCS.NS"]),
    syms,
  );
  // Every match was via the new symbol path
  const bySymbol = out.holdings.filter((h) => h.matchType === "symbol").length;
  assert("all 5 resolved via matchType='symbol'", bySymbol === 5, bySymbol);
}

// .NS suffix form still resolves
{
  const csv = "Symbol,Quantity,Avg Price\nTCS.NS,5,3800\n";
  const out = parsePortfolioFile(csv, "test.csv");
  assert(
    "'TCS.NS' row resolves to holdings (not unmatched)",
    out.holdings.length === 1 && out.unmatched.length === 0,
    `${out.holdings.length}/${out.unmatched.length}`,
  );
  assert("TCS.NS canonical symbol preserved", out.holdings[0]?.symbol === "TCS.NS", out.holdings[0]?.symbol);
}

// ISIN path still wins when provided (no regression)
{
  const csv =
    "Symbol,ISIN,Quantity,Avg Price\n" +
    "TCS,INE467B01029,5,3800\n";
  const out = parsePortfolioFile(csv, "test.csv");
  assert("ISIN+symbol → ISIN wins", out.holdings[0]?.matchType === "isin", out.holdings[0]?.matchType);
}

// Unknown symbol still goes to unmatched with the pre-existing reason
{
  const csv = "Symbol,Quantity,Avg Price\nZZZXYZFAKE,10,100\n";
  const out = parsePortfolioFile(csv, "test.csv");
  assert("unknown symbol → unmatched", out.unmatched.length === 1 && out.holdings.length === 0, `${out.holdings.length}/${out.unmatched.length}`);
  assert(
    "unmatched reason unchanged (Nifty-500 wording preserved)",
    /Not in our scored universe/.test(out.unmatched[0]?.reason || ""),
    out.unmatched[0]?.reason,
  );
}

// ETF classification not regressed — NIFTYBEES still goes to unmatched as etf,
// NOT to holdings via symbol lookup. classifyInstrument runs first.
{
  const csv =
    "Symbol,ISIN,Name,Quantity,Avg Price\n" +
    "NIFTYBEES,INF204KB13I3,Nippon India ETF Nifty BeES,50,250\n";
  const out = parsePortfolioFile(csv, "test.csv");
  assert("NIFTYBEES still classified as ETF", out.unmatched[0]?.instrumentType === "etf", out.unmatched[0]?.instrumentType);
  assert("NIFTYBEES not leaked into holdings", out.holdings.length === 0, out.holdings.length);
}

// Mutual fund still classified correctly
{
  const csv =
    "Symbol,ISIN,Name,Quantity,Avg Price\n" +
    "UTIMOMENTUM,INF789F1AW12,UTI Nifty Momentum Fund,100,15\n";
  const out = parsePortfolioFile(csv, "test.csv");
  assert("MF row still classified as mf", out.unmatched[0]?.instrumentType === "mf", out.unmatched[0]?.instrumentType);
}

// Mixed realistic portfolio
{
  const csv =
    "Symbol,ISIN,Quantity,Avg Price\n" +
    "TCS,,5,3800\n" +
    "RELIANCE.NS,,10,2500\n" +
    "HDFCBANK,INE040A01034,8,1500\n" +
    "NIFTYBEES,INF204KB13I3,50,250\n" +
    "ZZZFAKE,,100,10\n";
  const out = parsePortfolioFile(csv, "test.csv");
  assert("mixed: 3 equities resolved", out.holdings.length === 3, out.holdings.length);
  assert("mixed: 2 unmatched (1 ETF + 1 unknown)", out.unmatched.length === 2, out.unmatched.length);
  const types = out.unmatched.map((u) => u.instrumentType).sort();
  assert("mixed: unmatched types are [equity, etf]", JSON.stringify(types) === JSON.stringify(["equity","etf"]), types);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
