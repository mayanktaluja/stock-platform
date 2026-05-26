import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPortfolioConstructionPlan,
  MAX_FUNDED_ADDS,
  MIN_FUNDED_TRADE_INR,
} from "../services/portfolioConstructionPlan.js";

function holding({
  ticker,
  action = "Top-up-100%",
  currentValue = 40_000,
  sector = "Financials",
  v4 = 68,
  upside = 22,
  band = "DISCOUNT",
  confidence = "HIGH",
  staleData = false,
  dataAge = 10,
  priceSource = "sws",
} = {}) {
  return {
    symbol: ticker,
    name: ticker,
    quantity: 10,
    currentValue,
    positionWeight: currentValue / 10_000,
    sectorWeight: 10,
    action,
    swsCovered: true,
    staleData,
    priceSource,
    sws: {
      ticker,
      name: ticker,
      sector,
      v4_score: v4,
      upside_pct: upside,
      fair_value_inr: 112,
      current_price_inr: 92,
      valuation_confidence: confidence,
      valuation_source: "computed_fv_price",
      valuation_band: band,
      data_age_hours: dataAge,
      surveillance: null,
      next_earnings_date: null,
    },
  };
}

test("does not fund buys when available buy capital is zero", () => {
  const plan = buildPortfolioConstructionPlan({
    scoredHoldings: [holding({ ticker: "AAA" })],
    freshCapitalInr: 0,
    confirmedFreedCapitalInr: 0,
  });
  assert.equal(plan.fundedTrades.length, 0);
  assert.equal(plan.capitalLedger.availableBuyCapital, 0);
  assert.match(plan.zeroStateReasons.join(" "), /below INR 25,000/);
});

test("caps funded adds at five and never exceeds available buy capital", () => {
  const scoredHoldings = [
    holding({ ticker: "FILLER", action: "HOLD", currentValue: 2_000_000, sector: "Cash Equivalents" }),
    ...Array.from({ length: 8 }, (_, i) =>
      holding({ ticker: `ADD${i}`, currentValue: 50_000 + i * 1000, sector: `Sector${i}` }),
    ),
  ];
  const plan = buildPortfolioConstructionPlan({
    scoredHoldings,
    freshCapitalInr: 1_000_000,
  });
  assert.equal(plan.fundedTrades.length, MAX_FUNDED_ADDS);
  assert.ok(plan.capitalLedger.deployedBuyCapital <= plan.capitalLedger.availableBuyCapital);
  assert.ok(plan.fundedTrades.every((t) => t.tradeRupees >= MIN_FUNDED_TRADE_INR));
});

test("leaves leftover cash below minimum trade size as cash", () => {
  const plan = buildPortfolioConstructionPlan({
    scoredHoldings: [
      holding({ ticker: "FILLER", action: "HOLD", currentValue: 1_000_000, sector: "Industrials" }),
      holding({ ticker: "AAA", currentValue: 30_000, sector: "Technology" }),
    ],
    freshCapitalInr: 49_000,
  });
  assert.equal(plan.fundedTrades.length, 1);
  assert.ok(plan.capitalLedger.leftoverCash > 0);
  assert.ok(plan.capitalLedger.leftoverCash < MIN_FUNDED_TRADE_INR);
  assert.match(plan.zeroStateReasons.join(" "), /Leftover cash/);
});

test("dedupes duplicate holding and fresh candidates by ticker", () => {
  const plan = buildPortfolioConstructionPlan({
    scoredHoldings: [holding({ ticker: "DUP", currentValue: 20_000 })],
    baskets: {
      growth: [{
        ticker: "DUP",
        source: "fresh",
        sector: "Financials",
        v4_score: 70,
        upside_pct: 25,
        valuation_confidence: "HIGH",
        valuation_band: "DISCOUNT",
      }],
    },
    freshCapitalInr: 100_000,
  });
  const dupRows = plan.eligibleAddCandidates.filter((c) => c.ticker === "DUP");
  assert.equal(dupRows.length, 1);
  assert.equal(dupRows[0].source, "holding");
});

test("enforces post-trade single-name cap", () => {
  const plan = buildPortfolioConstructionPlan({
    scoredHoldings: [holding({ ticker: "BIG", currentValue: 79_500 })],
    freshCapitalInr: 100_000,
  });
  assert.equal(plan.fundedTrades.length, 0);
  assert.match(plan.eligibleAddCandidates[0].unfundedReasons.join(" "), /single-name 8% cap/);
});

test("enforces post-trade sector cap", () => {
  const scoredHoldings = [
    holding({ ticker: "BANK1", action: "HOLD", currentValue: 270_000, sector: "Financials" }),
    holding({ ticker: "OTHER", action: "HOLD", currentValue: 730_000, sector: "Industrials" }),
  ];
  const baskets = {
    growth: [{
      ticker: "NEWBANK",
      source: "fresh",
      sector: "Financials",
      v4_score: 70,
      upside_pct: 25,
      valuation_confidence: "HIGH",
      valuation_band: "DISCOUNT",
      data_age_hours: 8,
    }],
  };
  const plan = buildPortfolioConstructionPlan({ scoredHoldings, baskets, freshCapitalInr: 100_000 });
  assert.equal(plan.fundedTrades.length, 0);
  assert.match(plan.eligibleAddCandidates[0].unfundedReasons.join(" "), /sector 25% cap/);
});

test("excludes cooldown-demoted top-up candidates from funding", () => {
  const plan = buildPortfolioConstructionPlan({
    scoredHoldings: [holding({ ticker: "COOL", action: "HOLD" })],
    freshCapitalInr: 100_000,
  });
  assert.equal(plan.eligibleAddCandidates.length, 0);
  assert.equal(plan.fundedTrades.length, 0);
});

test("stale fresh candidates can remain eligible but cannot be funded", () => {
  const plan = buildPortfolioConstructionPlan({
    scoredHoldings: [holding({ ticker: "BASE", action: "HOLD", currentValue: 500_000, sector: "Other" })],
    baskets: {
      growth: [{
        ticker: "STALE",
        source: "fresh",
        sector: "Technology",
        v4_score: 72,
        upside_pct: 30,
        valuation_confidence: "HIGH",
        valuation_band: "DEEP_DISCOUNT",
        data_age_hours: 72,
      }],
    },
    freshCapitalInr: 100_000,
  });
  assert.equal(plan.eligibleAddCandidates.length, 1);
  assert.equal(plan.eligibleAddCandidates[0].fundable, false);
  assert.equal(plan.fundedTrades.length, 0);
});
