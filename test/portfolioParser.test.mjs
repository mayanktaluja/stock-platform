/**
 * Regression tests for portfolioParser.js + stockList.js symbol resolution.
 *
 * Focus: the symbol-only lookup path that was silently dropping Nifty 50
 * flagships into `unmatched` because findByName fuzzy-matches company
 * names (not tickers) and there was no symbol index at all.
 *
 * Run with: node test/portfolioParser.test.mjs
 */

import xlsx from "xlsx";
import { parsePortfolioFile } from "../portfolioParser.js";
import { findBySymbol, findByIsin, findByName } from "../stockList.js";

// Build an in-memory Upstox-format xlsx buffer mirroring the real export
// structure (broker header rows + the canonical column layout).
function buildUpstoxXlsxBuffer(dataRows) {
  const header = [
    ["UPSTOX SECURITIES PRIVATE LIMITED"],
    ["(Formerly EPX Uptech Private Limited)"],
    ["Dealing Office: 30th Floor, Sunshine Tower, Senapati Bapat Marg, Dadar (W), Mumbai 400013"],
    ["UCC", "AG5283"],
    ["Name", "TEST USER"],
    ["PAN", "ABCDE1234F"],
    ["Report Date", "22-04-2026"],
    ["Generated On", "2026-04-23 10:51:38"],
    ["ISIN", "Scrip Name", "Free Qty", "Current Qty", "Freeze Qty",
     "Locked Qty", "Pledge Qty", "Value Date", "Rate", "Valuation"],
  ];
  const rows = header.concat(dataRows);
  const ws = xlsx.utils.aoa_to_sheet(rows);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "HOLDING");
  return xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
}

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

// ──────────────────── Upstox xlsx parser ────────────────────

console.log("\nUpstox xlsx parser\n");

// Equity rows resolve via ISIN; cost basis stand-in (= Rate) makes P&L = 0
{
  const buf = buildUpstoxXlsxBuffer([
    ["INE467B01029", "TATA CONSULTANCY-1/-", "5.0000", "5.0000", "0.0000", "0.0000", "0.0000", "22-04-2026", "2537.5500", "12687.7500"],
    ["INE040A01034", "HDFC BANK-EQ1/-", "30.0000", "30.0000", "0.0000", "0.0000", "0.0000", "22-04-2026", "799.9000", "23997.0000"],
    ["INE062A01020", "SBI - EQ", "14.0000", "14.0000", "0.0000", "0.0000", "0.0000", "22-04-2026", "1103.4000", "15447.6000"],
  ]);
  const out = parsePortfolioFile(buf, "holdings_22-04-2026_AG5283.xlsx");
  assert("Upstox: source detected as upstox-xlsx", out.source === "upstox-xlsx", out.source);
  assert("Upstox: 3 equity holdings resolved", out.holdings.length === 3, `${out.holdings.length} holdings / ${out.unmatched.length} unmatched`);
  assert("Upstox: TCS resolved by ISIN", out.holdings.find((h) => h.symbol === "TCS.NS")?.matchType === "isin", out.holdings.find((h) => h.symbol === "TCS.NS")?.matchType);
  const tcs = out.holdings.find((h) => h.symbol === "TCS.NS");
  assert("Upstox: avgPrice = Rate (stand-in)", tcs?.avgPrice === 2537.55, tcs?.avgPrice);
  assert("Upstox: closePrice = Rate", tcs?.closePrice === 2537.55, tcs?.closePrice);
  assert("Upstox: costBasisUnknown flag set on holding", tcs?.costBasisUnknown === true, tcs?.costBasisUnknown);
  assert(
    "Upstox: cost-basis warning surfaced",
    out.warnings.some((w) => /average buy price|cost basis|tradebook/i.test(w)),
    out.warnings,
  );
  assert(
    "Upstox: warning explains P&L = drift-since-report (not real P&L)",
    out.warnings.some((w) => /price movement since the report date|since the report date/i.test(w)),
    out.warnings,
  );
  assert(
    "Upstox: warning includes the report date for clarity",
    out.warnings.some((w) => w.includes("22-04-2026")),
    out.warnings,
  );
  assert("Upstox: report date captured in summary", out.summary?.asOfDate === "22-04-2026", out.summary?.asOfDate);
}

// ETFs (INF-prefix) classified as ETF and pushed to unmatched for live resolve
{
  const buf = buildUpstoxXlsxBuffer([
    ["INE467B01029", "TATA CONSULTANCY-1/-", "5.0000", "5.0000", "0.0000", "0.0000", "0.0000", "22-04-2026", "2537.5500", "12687.7500"],
    ["INF204KB14I2", "NIP ETF NIFTY50 BEES", "175.0000", "175.0000", "0.0000", "0.0000", "0.0000", "22-04-2026", "275.5700", "48224.7500"],
    ["INF789F1AYK6", "UTI SILVER ETF", "103.0000", "103.0000", "0.0000", "0.0000", "0.0000", "22-04-2026", "238.0900", "24523.2700"],
  ]);
  const out = parsePortfolioFile(buf, "holdings.xlsx");
  assert("Upstox: 1 equity in holdings (ETFs deferred to live-resolve)", out.holdings.length === 1, out.holdings.length);
  assert("Upstox: 2 ETFs in unmatched as pending-live", out.unmatched.filter((u) => u.matchType === "pending-live").length === 2, out.unmatched.map((u) => u.matchType));
  const types = out.unmatched.map((u) => u.instrumentType).sort();
  assert("Upstox: ETF rows classified as etf", JSON.stringify(types) === JSON.stringify(["etf", "etf"]), types);
}

// Single-cell footer row ("From DD-MMM-YYYY, our Broking…") is ignored
{
  const buf = buildUpstoxXlsxBuffer([
    ["INE467B01029", "TATA CONSULTANCY-1/-", "5.0000", "5.0000", "0.0000", "0.0000", "0.0000", "22-04-2026", "2537.5500", "12687.7500"],
    ["From 19-Jul-2025, our Broking operations were transitioned from RKSV to Upstox."],
  ]);
  const out = parsePortfolioFile(buf, "holdings.xlsx");
  assert("Upstox: footer row skipped (no ISIN)", out.holdings.length === 1 && out.unmatched.length === 0, `${out.holdings.length}/${out.unmatched.length}`);
}

// Pledged/locked qty included via Current Qty (sum of Free + Locked + Pledge)
{
  // 10 free + 5 locked + 3 pledged = 18 current
  const buf = buildUpstoxXlsxBuffer([
    ["INE467B01029", "TATA CONSULTANCY-1/-", "10.0000", "18.0000", "0.0000", "5.0000", "3.0000", "22-04-2026", "2537.5500", "45675.9000"],
  ]);
  const out = parsePortfolioFile(buf, "holdings.xlsx");
  assert("Upstox: Current Qty (18) used, not Free Qty (10)", out.holdings[0]?.quantity === 18, out.holdings[0]?.quantity);
}

// Non-Upstox xlsx with similar columns shouldn't be misidentified
{
  // Build a fake xlsx with Groww-style columns — should not match Upstox
  const ws = xlsx.utils.aoa_to_sheet([
    ["Stock Name", "ISIN", "Quantity", "Average buy price"],
    ["TCS", "INE467B01029", "5", "3800"],
  ]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
  const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
  const out = parsePortfolioFile(buf, "groww_export.xlsx");
  assert("Groww xlsx still detected as groww-xlsx (no Upstox false-positive)", out.source === "groww-xlsx", out.source);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
