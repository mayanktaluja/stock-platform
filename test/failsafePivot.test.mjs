// Tests for services/multibagger/failsafePivot.js.
// Uses a temp dir for the portfolio file.
// Run: node test/failsafePivot.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "failsafe-test-"));
process.chdir(tmpDir);

const { planFailsafePivot, executeFailsafePivot, FAILSAFE_TARGET } = await import("../services/multibagger/failsafePivot.js");
const { openPosition, readPortfolio } = await import("../services/paperTrade/multibaggerPortfolioService.js");

console.log("\nfailsafePivot");

it("target allocation sums to 100%", () => {
  const total = FAILSAFE_TARGET.NIFTYBEES_PCT + FAILSAFE_TARGET.GOLDBEES_PCT + FAILSAFE_TARGET.CASH_PCT;
  if (total !== 100) throw new Error("allocation does not sum to 100: " + total);
});

it("planFailsafePivot returns SELL instructions per position + BUY for NIFTYBEES/GOLDBEES", () => {
  const plan = planFailsafePivot({
    portfolio_value_inr: 60_000,
    current_positions: [
      { ticker: "A", qty: 100, avg_entry_price_inr: 100 },
      { ticker: "B", qty: 50, avg_entry_price_inr: 200 },
    ],
    price_map: { A: 60, B: 120 },
  });
  if (plan.instructions.length !== 4) throw new Error("expected 4 instructions");
  const sells = plan.instructions.filter((i) => i.type === "SELL_AT_MARKET");
  const buys = plan.instructions.filter((i) => i.type === "BUY_AT_MARKET");
  if (sells.length !== 2) throw new Error("expected 2 sells");
  if (buys.length !== 2) throw new Error("expected 2 buys");
  if (buys[0].ticker !== "NIFTYBEES") throw new Error("first buy should be NIFTYBEES");
  if (buys[0].target_value_inr !== 36_000) throw new Error("NIFTYBEES target = 60% × 60k = 36k");
  if (buys[1].ticker !== "GOLDBEES") throw new Error("second buy should be GOLDBEES");
});

it("planFailsafePivot bails on invalid portfolio value", () => {
  const plan = planFailsafePivot({ portfolio_value_inr: 0 });
  if (plan.instructions.length !== 0) throw new Error("expected no instructions");
});

it("executeFailsafePivot closes all open positions via decisionLog", () => {
  openPosition({ ticker: "A", tier: "anchor", qty: 100, entry_price_inr: 100, sector: "X" });
  openPosition({ ticker: "B", tier: "high", qty: 50, entry_price_inr: 200, sector: "Y" });
  const before = readPortfolio();
  if (before.positions.length !== 2) throw new Error("setup failed");
  const result = executeFailsafePivot({ price_map: { A: 60, B: 120 } });
  if (result.closed_positions !== 2) throw new Error("expected 2 closed, got " + result.closed_positions);
  const after = readPortfolio();
  if (after.positions.length !== 0) throw new Error("positions should be empty");
  if (after.closed_positions.length !== 2) throw new Error("closed_positions should have 2 entries");
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
