/**
 * Tests for services/paperTrade/gateEvaluator.js.
 *
 * Run with: node test/paperTradeGateEvaluator.test.mjs
 */

import {
  PAPER_TRADE_GATE,
  fiscalQuarterOf,
  evaluateGate,
  markOpenTrades,
  summariseClosed,
} from "../services/paperTrade/gateEvaluator.js";

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

console.log("\ngateEvaluator — fiscalQuarterOf (Indian FY: Apr-Mar)");

assert("2026-04-15 → Q1 FY27", fiscalQuarterOf("2026-04-15") === "Q1 FY27", fiscalQuarterOf("2026-04-15"));
assert("2026-07-15 → Q2 FY27", fiscalQuarterOf("2026-07-15") === "Q2 FY27");
assert("2026-10-15 → Q3 FY27", fiscalQuarterOf("2026-10-15") === "Q3 FY27");
assert("2026-12-31 → Q3 FY27", fiscalQuarterOf("2026-12-31") === "Q3 FY27");
assert("2027-01-15 → Q4 FY27", fiscalQuarterOf("2027-01-15") === "Q4 FY27");
assert("2027-03-31 → Q4 FY27", fiscalQuarterOf("2027-03-31") === "Q4 FY27");
assert("2027-04-01 → Q1 FY28", fiscalQuarterOf("2027-04-01") === "Q1 FY28");
assert("invalid → null", fiscalQuarterOf("not-a-date") === null);

console.log("\ngateEvaluator — evaluateGate");

const empty = evaluateGate([]);
assert("empty ledger: gate not met", empty.gate_met === false);
assert("empty: blocks on resolved + quarters + sectors + hit_rate", empty.blocking_reasons.length === 4);

function mkTrade(overrides = {}) {
  return {
    ticker: "X",
    sector: "Software",
    entry_date: "2026-05-15",
    entry_price_inr: 100,
    exit_date: "2026-06-15",
    exit_price_inr: 110,
    status: "CLOSED",
    entry_snapshot: { size_inr: 100_000 },
    ...overrides,
  };
}

// 100 closed trades, all wins, all in Software, all Q1 FY27
const homogeneous = Array.from({ length: 100 }, (_, i) =>
  mkTrade({ ticker: `T${i}`, exit_price_inr: 110 }),
);
const h = evaluateGate(homogeneous);
assert("100 wins in 1 sector / 1 quarter — gate blocks on quarters+sectors", h.gate_met === false);
assert("hit_rate 100%", h.metrics.hit_rate_pct === 100);
assert("scoreable_count 100", h.metrics.scoreable_count === 100);

// 100 trades spread across 5 sectors × 20 trades, in 2 quarters, 60% wins
const sectors = ["Software", "Pharmaceuticals", "Banking", "Energy", "Materials"];
const spread = [];
for (let i = 0; i < 100; i++) {
  const sec = sectors[i % 5];
  const q1 = i < 60;
  spread.push(mkTrade({
    ticker: `S${i}`,
    sector: sec,
    entry_date: q1 ? "2026-05-15" : "2026-08-15",
    exit_price_inr: i < 60 ? 110 : 90, // 60% wins
  }));
}
const r = evaluateGate(spread);
assert("100 trades / 5 sectors / 2 quarters / 60% — gate MET", r.gate_met === true, r.blocking_reasons);
assert("hit_rate 60%", r.metrics.hit_rate_pct === 60);
assert("2 quarters", r.metrics.quarters.length === 2);
assert("5 sectors_with_min", r.metrics.sectors_with_min_events === 5);

// 100 trades but only 50% win-rate — fails hit_rate gate
const lowHit = spread.map((t, i) => ({ ...t, exit_price_inr: i < 50 ? 110 : 90 }));
const lh = evaluateGate(lowHit);
assert("50% hit-rate fails the ≥55% gate", lh.gate_met === false);
assert("hit_rate 50%", lh.metrics.hit_rate_pct === 50);

console.log("\ngateEvaluator — markOpenTrades");

const openTrades = [
  { ticker: "A", entry_price_inr: 100, status: "OPEN", entry_snapshot: { size_inr: 100_000 } },
  { ticker: "B", entry_price_inr: 200, status: "OPEN", entry_snapshot: { size_inr: 100_000 } },
  { ticker: "C", entry_price_inr: 50, status: "OPEN", entry_snapshot: { size_inr: 100_000 } },
];
const mtm = markOpenTrades(openTrades, { A: 110, B: 180 });
assert("3 open", mtm.open_count === 3);
assert("invested ₹300k", mtm.total_invested_inr === 300_000);
// A: 100→110 = +10%; B: 200→180 = -10%; C: no price, hold at cost.
// Expected MTM = 110_000 + 90_000 + 100_000 = 300_000 → pnl 0
assert("mtm ₹300k (offsetting +10%/-10% with one unmarkable)", Math.round(mtm.total_mtm_inr) === 300_000);
assert("positions sorted by return DESC (A first)", mtm.positions[0].ticker === "A");

console.log("\ngateEvaluator — summariseClosed");

const closed = [
  mkTrade({ entry_price_inr: 100, exit_price_inr: 110, entry_snapshot: { size_inr: 100_000 } }),
  mkTrade({ entry_price_inr: 100, exit_price_inr: 90, entry_snapshot: { size_inr: 100_000 } }),
];
const s = summariseClosed(closed);
assert("closed_count 2", s.closed_count === 2);
assert("wins 1", s.wins === 1);
assert("losses 1", s.losses === 1);
assert("realised PnL = 100k×0.10 + 100k×(-0.10) = 0", Math.round(s.total_realised_pnl_inr) === 0);

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
