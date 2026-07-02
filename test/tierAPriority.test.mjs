import test from "node:test";
import assert from "node:assert/strict";
import { buildTiers } from "../services/swsPortfolioAggregate.js";

function reduction(ticker, { severity = null, currentValue = 100000, action = "Reduction-50%" } = {}) {
  return {
    symbol: ticker,
    swsCovered: true,
    action,
    ladderSeverity: severity,
    currentValue,
    positionWeight: 5,
    reasons: ["r"],
    sws: {
      ticker,
      v4_score: 20,
      upside_pct: -10,
      snowflake_total: 10,
      snowflake: { valuation: 2, future_growth: 2, past_performance: 2, financial_health: 2, dividends: 2 },
      // enough coverage that _isSwsDataTooThinToReduce doesn't reroute to Tier D
      pe: 12,
      market_cap_inr: 5e10,
    },
  };
}

test("Tier A sorts by ladderSeverity desc, then freedRupees desc, then ticker asc", () => {
  const hs = [
    reduction("LOWSEV", { severity: 0.2, currentValue: 900000 }),
    reduction("HIGHSEV", { severity: 0.9, currentValue: 50000 }),
    reduction("MIDSEV-SMALL", { severity: 0.5, currentValue: 60000 }),
    reduction("MIDSEV-BIG", { severity: 0.5, currentValue: 400000 }),
  ];
  const { tierA } = buildTiers(hs);
  const order = tierA.map((h) => h.symbol);
  assert.deepEqual(order, ["HIGHSEV", "MIDSEV-BIG", "MIDSEV-SMALL", "LOWSEV"]);
});

test("Tier A ties on severity and freed ₹ break deterministically by ticker", () => {
  const hs = [
    reduction("ZZZ", { severity: 0.5, currentValue: 100000 }),
    reduction("AAA", { severity: 0.5, currentValue: 100000 }),
  ];
  const a = buildTiers(hs).tierA.map((h) => h.symbol);
  const b = buildTiers([...hs].reverse()).tierA.map((h) => h.symbol);
  assert.deepEqual(a, ["AAA", "ZZZ"]);
  assert.deepEqual(b, ["AAA", "ZZZ"]);
});

test("null severity sorts below scored severity but rows are never dropped", () => {
  const hs = [
    reduction("NOSEV", { severity: null, currentValue: 800000 }),
    reduction("SEV", { severity: 0.3, currentValue: 50000 }),
  ];
  const { tierA } = buildTiers(hs);
  assert.deepEqual(tierA.map((h) => h.symbol), ["SEV", "NOSEV"]);
  assert.equal(tierA.length, 2);
});
