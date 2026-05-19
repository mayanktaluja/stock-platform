/**
 * Tests for services/compounder/paperTradeLog.js. Uses a temp data dir
 * by chdir'ing into a fresh directory under os.tmpdir() so we don't write
 * into the real data/paper-trades/.
 *
 * Run with: node test/paperTradeLog.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

// Create temp cwd before importing the module (it captures cwd at module load).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-trade-test-"));
const origCwd = process.cwd();
process.chdir(tmpDir);

const {
  openTrade,
  closeTrade,
  openTradesFor,
  closedTradesFor,
  reconcileBasket,
  readLedger,
  pathFor,
} = await import("../services/compounder/paperTradeLog.js");

console.log("\npaperTradeLog — basic open / close lifecycle");

const STRATEGY = "compounder";

const t1 = openTrade(STRATEGY, {
  ticker: "RELIANCE",
  name: "Reliance Industries",
  sector: "Energy",
  entry_date: "2026-05-19",
  entry_price_inr: 1500,
  entry_snapshot: { snowflake_past: 6, snowflake_health: 5, snowflake_dividend: 5, risks: [], fair_value_inr: 1800, upside_pct: 20 },
});
assert("openTrade returns trade with OPEN status", t1.status === "OPEN", t1);
assert("ledger file written", fs.existsSync(pathFor(STRATEGY)));
assert("ledger has 1 trade", readLedger(STRATEGY).trades.length === 1);

// Idempotency
const t1again = openTrade(STRATEGY, {
  ticker: "RELIANCE",
  entry_date: "2026-05-19",
  entry_price_inr: 1500,
});
assert("idempotent — second openTrade returns existing", t1again === t1 || t1again.ticker === "RELIANCE" && readLedger(STRATEGY).trades.length === 1);

openTrade(STRATEGY, {
  ticker: "TCS",
  entry_date: "2026-05-19",
  entry_price_inr: 3000,
});
assert("two distinct tickers → two trades", readLedger(STRATEGY).trades.length === 2);

const open = openTradesFor(STRATEGY);
assert("openTradesFor returns 2 open", open.length === 2);

const closed = closeTrade(STRATEGY, "RELIANCE", {
  exit_date: "2026-08-19",
  exit_price_inr: 1600,
  exit_action: "TRIM_50",
  exit_reason: "test-close",
});
assert("closeTrade returns CLOSED trade", closed && closed.status === "CLOSED");
assert("openTradesFor now 1", openTradesFor(STRATEGY).length === 1);
assert("closedTradesFor now 1", closedTradesFor(STRATEGY).length === 1);
assert("closed trade has exit_price_inr", closed.exit_price_inr === 1600);
assert("closed trade has exit_reason", closed.exit_reason === "test-close");

assert("closeTrade on unknown ticker returns null", closeTrade(STRATEGY, "GHOST", {}) === null);

console.log("\npaperTradeLog — reconcileBasket");

const STRAT2 = "compounder2";
// Seed with 2 open trades
openTrade(STRAT2, { ticker: "A", entry_date: "2026-05-19", entry_price_inr: 100 });
openTrade(STRAT2, { ticker: "B", entry_date: "2026-05-19", entry_price_inr: 200 });

// Today's basket: B stays, A drops, C and D are new
const basket = [
  { ticker: "B", name: "B Co", sector: "X", current_price_inr: 210, snowflake_past: 6, snowflake_health: 5, snowflake_dividend: 4, risks: [], fair_value_inr: 240, upside_pct: 14 },
  { ticker: "C", name: "C Co", sector: "Y", current_price_inr: 300, snowflake_past: 5, snowflake_health: 4, snowflake_dividend: 4, risks: [], fair_value_inr: 350, upside_pct: 17 },
  { ticker: "D", name: "D Co", sector: "Z", current_price_inr: 400, snowflake_past: 5, snowflake_health: 5, snowflake_dividend: 5, risks: [], fair_value_inr: 480, upside_pct: 20 },
];

const recon = reconcileBasket(STRAT2, basket, { today_iso: "2026-05-20" });
assert("reconcileBasket opens 2 new (C, D)", recon.opened === 2, recon);
assert("reconcileBasket closes 1 (A)", recon.closed === 1, recon);
assert("reconcileBasket basket_size = 3", recon.basket_size === 3, recon);

const finalLedger = readLedger(STRAT2);
const openAfter = finalLedger.trades.filter((t) => t.status === "OPEN").map((t) => t.ticker).sort();
assert("open trades after reconcile: B, C, D", JSON.stringify(openAfter) === '["B","C","D"]', openAfter);
const closedAfter = finalLedger.trades.filter((t) => t.status === "CLOSED").map((t) => t.ticker);
assert("closed trades after reconcile: A", JSON.stringify(closedAfter) === '["A"]', closedAfter);

// Cleanup
process.chdir(origCwd);
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
