import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parsePortfolioFile } from "../portfolioParser.js";
import { scoreHolding } from "../services/swsHoldingEngine.js";
import { buildSWSReport } from "../services/swsPortfolioAggregate.js";
import { buildPortfolioConstructionPlan } from "../services/portfolioConstructionPlan.js";

const WORKBOOK = "/Users/mayanktaluja/Desktop/Stocks_Holdings_Statement_3540358892_03-06-2026 (1).xlsx";

function scoreParsedPortfolio(parsed) {
  const equityHoldings = parsed.holdings.map((h) => {
    const quantity = Number(h.quantity) || 0;
    const avgPrice = Number(h.avgPrice) || 0;
    return { ...h, quantity, avgPrice, invested: quantity * avgPrice };
  });
  const firstPass = equityHoldings.map((h) =>
    scoreHolding({ ...h, positionWeight: 0, sectorWeight: 0, pnlPercent: 0 }, { sectorWeights: {} }),
  );
  let totalCurrent = 0;
  const sectorValues = new Map();
  const enriched = firstPass.map((row) => {
    const price = row.swsCovered ? Number(row.sws?.current_price_inr) : Number(row.sws?.current_price_inr || row.closePrice || row.avgPrice);
    const currentValue = (Number(row.quantity) || 0) * (Number.isFinite(price) && price > 0 ? price : Number(row.avgPrice) || 0);
    const sector = row.sector || row.sws?.sector || "Unclassified";
    totalCurrent += currentValue;
    sectorValues.set(sector, (sectorValues.get(sector) || 0) + currentValue);
    return { ...row, currentValue, sector };
  });
  const sectorWeights = Object.fromEntries([...sectorValues.entries()].map(([sector, value]) => [sector, totalCurrent > 0 ? (value / totalCurrent) * 100 : 0]));
  return enriched.map((row) => {
    const invested = (Number(row.quantity) || 0) * (Number(row.avgPrice) || 0);
    const positionWeight = totalCurrent > 0 ? (row.currentValue / totalCurrent) * 100 : 0;
    const pnlPercent = invested > 0 ? ((row.currentValue - invested) / invested) * 100 : 0;
    return scoreHolding(
      { ...row, positionWeight, sectorWeight: sectorWeights[row.sector], pnlPercent },
      { sectorWeights },
    );
  });
}

test("local Groww replay downgrades stale single-factor reductions", (t) => {
  if (!fs.existsSync(WORKBOOK)) t.skip("local Groww workbook fixture is not present");
  const parsed = parsePortfolioFile(fs.readFileSync(WORKBOOK), WORKBOOK);
  const scoredHoldings = scoreParsedPortfolio(parsed);
  const report = buildSWSReport(scoredHoldings, { freshCapitalInr: 0 });
  const plan = buildPortfolioConstructionPlan({
    scoredHoldings,
    baskets: report.tiers?.B?.baskets || null,
    outsidePicks: report.outsidePicks || null,
    freshCapitalInr: 0,
  });
  const confirmedSellTickers = new Set(plan.fundedSells.map((row) => row.ticker));

  for (const ticker of ["APOLLOTYRE", "BPCL", "IOC"]) {
    assert.equal(confirmedSellTickers.has(ticker), false, `${ticker} should not be a confirmed reduction`);
  }
  assert.ok(plan.smallcapSleeve?.smallMicroWeightPct >= 45, "small/micro sleeve warning should remain visible");
});
