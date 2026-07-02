import test from "node:test";
import assert from "node:assert/strict";
import { applyTopUpFundingLabels } from "../services/portfolio/topUpFundingLabels.js";
import { CAPPED_TOPUP_ACTION } from "../services/actionLadder.js";

function holding(ticker, action, extra = {}) {
  return { symbol: ticker, action, sws: { ticker }, reasons: [], ...extra };
}

function plan({ funded = [], eligible = [], budget = 0 } = {}) {
  return {
    fundedTrades: funded.map(([ticker, tradeRupees, rank]) => ({
      ticker, tradeRupees, rank, source: "holding", side: "BUY",
    })),
    eligibleAddCandidates: eligible.map(([ticker, reasons]) => ({
      ticker, unfundedReasons: reasons,
    })),
    capitalLedger: { availableBuyCapital: budget },
  };
}

test("funded holding gets the ₹ label + topUpFunding metadata", () => {
  const h = holding("AAA", "Top-up-33%");
  const out = applyTopUpFundingLabels([h], plan({ funded: [["AAA", 50000, 1]], budget: 100000 }));
  assert.equal(h.displayActionIntent, "Top-up — ₹50,000 funded");
  assert.equal(h.fundedTradeRupees, 50000);
  assert.deepEqual(h.topUpFunding, { status: "funded", tradeRupees: 50000, rank: 1, belowCap: false });
  assert.equal(out.funded, 1);
});

test("no declared budget → kept Top-up label untouched (no funding claim)", () => {
  const h = holding("AAA", "Top-up-33%", { displayActionIntent: "Add candidate" });
  applyTopUpFundingLabels([h], plan({ budget: 0 }));
  assert.equal(h.displayActionIntent, "Add candidate");
  assert.deepEqual(h.topUpFunding, { status: "no_budget" });
});

test("declared budget that ran out → 'Top-up (unfunded this budget)' + plan reasons", () => {
  const h = holding("BBB", "Top-up-25%");
  applyTopUpFundingLabels([h], plan({
    budget: 30000,
    eligible: [["BBB", ["ranked below funded candidates within today's budget"]]],
  }));
  assert.equal(h.displayActionIntent, "Top-up (unfunded this budget)");
  assert.equal(h.topUpFunding.status, "unfunded");
  assert.match(h.topUpFunding.reasons[0], /ranked below funded candidates/);
});

test("cap-demoted row keeps its if-funded label; promotes to funded ₹ when the budget reaches it", () => {
  const kept = holding("CCC", CAPPED_TOPUP_ACTION, { displayActionIntent: "Top-up (if funded)" });
  applyTopUpFundingLabels([kept], plan({ budget: 100000 }));
  assert.equal(kept.displayActionIntent, "Top-up (if funded)");
  assert.equal(kept.topUpFunding.status, "if_funded");

  const promoted = holding("DDD", CAPPED_TOPUP_ACTION, { displayActionIntent: "Top-up (if funded)" });
  applyTopUpFundingLabels([promoted], plan({ funded: [["DDD", 40000, 3]], budget: 200000 }));
  assert.equal(promoted.displayActionIntent, "Top-up — ₹40,000 funded");
  assert.equal(promoted.topUpFunding.belowCap, true);
});

test("reductions and HOLDs are untouched", () => {
  const red = holding("RED", "Reduction-50%", { displayActionIntent: "Trim" });
  const hold = holding("HHH", "HOLD");
  applyTopUpFundingLabels([red, hold], plan({ funded: [["RED", 50000, 1]], budget: 100000 }));
  assert.equal(red.displayActionIntent, "Trim");
  assert.equal(red.topUpFunding, undefined);
  assert.equal(hold.topUpFunding, undefined);
});

test("idempotent: second application converges to the same labels", () => {
  const p = plan({ funded: [["AAA", 50000, 1]], eligible: [["BBB", ["budget exhausted"]]], budget: 60000 });
  const hs = [holding("AAA", "Top-up-33%"), holding("BBB", "Top-up-25%")];
  applyTopUpFundingLabels(hs, p);
  const first = JSON.stringify(hs);
  applyTopUpFundingLabels(hs, p);
  assert.equal(JSON.stringify(hs), first);
});

test("fresh-pick funded trades never label holdings with the same ticker prefix", () => {
  const h = holding("EEE", "Top-up-33%");
  const p = plan({ budget: 100000 });
  p.fundedTrades.push({ ticker: "EEE", tradeRupees: 50000, rank: 1, source: "fresh", side: "BUY" });
  applyTopUpFundingLabels([h], p);
  assert.notEqual(h.displayActionIntent, "Top-up — ₹50,000 funded");
  assert.equal(h.topUpFunding.status, "unfunded");
});
