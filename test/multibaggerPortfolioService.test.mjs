// Tests for services/paperTrade/multibaggerPortfolioService.js.
// Uses a temp dir via chdir.
// Run: node test/multibaggerPortfolioService.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multibagger-port-test-"));
process.chdir(tmpDir);

const {
  readPortfolio,
  openPosition,
  trimPosition,
  closePosition,
  markToMarket,
  summary,
  PORTFOLIO_CONFIG,
} = await import("../services/paperTrade/multibaggerPortfolioService.js");

console.log("\nmultibaggerPortfolioService");

it("starts empty with ₹1,00,000 cash", () => {
  const book = readPortfolio();
  if (book.cash_inr !== 100_000) throw new Error("cash mismatch: " + book.cash_inr);
  if (book.positions.length !== 0) throw new Error("expected empty positions");
  if (book.schema_version !== PORTFOLIO_CONFIG.SCHEMA_VERSION) throw new Error("schema mismatch");
});

it("openPosition adds a position, decrements cash, persists to disk", () => {
  const p = openPosition({
    ticker: "INOX", tier: "anchor", qty: 100, entry_price_inr: 100,
    sector: "Renewables",
  });
  if (p.qty !== 100) throw new Error("qty mismatch");
  const book = readPortfolio();
  if (book.cash_inr !== 90_000) throw new Error("cash should be 90,000, got " + book.cash_inr);
  if (book.positions.length !== 1) throw new Error("expected 1 position");
});

it("openPosition rejects duplicate symbol", () => {
  try {
    openPosition({ ticker: "INOX", tier: "anchor", qty: 1, entry_price_inr: 100, sector: "Renewables" });
    throw new Error("should have thrown");
  } catch (e) {
    if (!/already held/.test(e.message)) throw e;
  }
});

it("openPosition rejects insufficient cash", () => {
  try {
    openPosition({ ticker: "BIG", tier: "high", qty: 10000, entry_price_inr: 100, sector: "Defense" });
    throw new Error("should have thrown");
  } catch (e) {
    if (!/insufficient cash/.test(e.message)) throw e;
  }
});

it("trimPosition reduces qty, credits cash, leaves position open", () => {
  const pos = trimPosition({ ticker: "INOX", qty: 40, price_inr: 150 });
  if (pos.qty !== 60) throw new Error("qty after trim: " + pos.qty);
  const book = readPortfolio();
  if (book.cash_inr !== 96_000) throw new Error("cash after trim: " + book.cash_inr);
});

it("trimPosition rejects oversized trim", () => {
  try {
    trimPosition({ ticker: "INOX", qty: 1000, price_inr: 150 });
    throw new Error("should have thrown");
  } catch (e) {
    if (!/invalid qty/.test(e.message)) throw e;
  }
});

it("closePosition closes the line, credits cash, moves to closed_positions", () => {
  closePosition({ ticker: "INOX", price_inr: 200, reason: "target" });
  const book = readPortfolio();
  if (book.positions.length !== 0) throw new Error("position should be closed");
  if (book.closed_positions.length !== 1) throw new Error("closed_positions empty");
  // Cash: 100k start − 10k entry + 6k trim (40 × 150) + 12k close (60 × 200) = 108k
  if (book.cash_inr !== 108_000) throw new Error("final cash: " + book.cash_inr);
});

it("markToMarket reports portfolio_value and per-position PnL", () => {
  openPosition({ ticker: "ABC", tier: "high", qty: 100, entry_price_inr: 50, sector: "EMS" });
  const mtm = markToMarket({ ABC: 80 });
  if (mtm.positions[0].unrealised_pl_pct !== 60) throw new Error("expected +60% PnL, got " + mtm.positions[0].unrealised_pl_pct);
  // Cash: 108_000 - 5_000 entry = 103_000; market value 100 × 80 = 8_000; total 111_000
  if (mtm.portfolio_value_inr !== 111_000) throw new Error("portfolio_value: " + mtm.portfolio_value_inr);
});

it("markToMarket updates peak_price_inr when current exceeds previous peak", () => {
  markToMarket({ ABC: 100 });
  const book = readPortfolio();
  const pos = book.positions.find((p) => p.ticker === "ABC");
  if (pos.peak_price_inr !== 100) throw new Error("peak should update to 100");
  markToMarket({ ABC: 90 }); // below peak
  const book2 = readPortfolio();
  const pos2 = book2.positions.find((p) => p.ticker === "ABC");
  if (pos2.peak_price_inr !== 100) throw new Error("peak should remain 100 on pullback");
});

it("summary returns book metadata", () => {
  const s = summary();
  if (s.open_positions !== 1) throw new Error("open_positions mismatch");
  if (s.closed_positions !== 1) throw new Error("closed_positions mismatch");
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
