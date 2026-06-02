import assert from "node:assert/strict";
import {
  buildExitPlan,
  buildExitPlanSummary,
  classifyExitIntent,
  containsForbiddenExitPlanCopy,
} from "../services/exitPlan/exitPlanPolicy.js";

console.log("exitPlanPolicy.js regression");

{
  const plan = buildExitPlan({
    action: "HOLD",
    currentPrice: 100,
    avgPrice: 80,
    supportLevel: 92,
    upsideBand: 120,
    atrPct: 2.5,
    pnlPercent: 25,
    positionWeight: 6,
  });

  assert.equal(plan.schema_version, "exit-plan-v1");
  assert.equal(plan.intent, "TACTICAL_SWING");
  assert.equal(plan.supportLevel, 92);
  assert.equal(plan.supportReference.value, 92);
  assert.equal(plan.upsideBand, 120);
  assert.equal(plan.upsideReference.value, 120);
  assert.equal(plan.atrPct, 2.5);
  assert.equal(plan.trigger.state, "CLEAR");
  assert.equal(containsForbiddenExitPlanCopy(plan), false);
}

{
  const plan = buildExitPlan({
    action: "HOLD",
    currentPrice: 96,
    supportLevel: 100,
    target: 102,
    nextEarningsDate: "2026-06-05",
    positionWeight: 4,
  });

  assert.equal(plan.intent, "EVENT_TRADE");
  assert.equal(plan.trigger.state, "REVIEW");
  assert.equal(plan.trailingStop, null);
  assert.match(plan.caveats.join(" "), /Event-day gaps/);
  assert.equal(containsForbiddenExitPlanCopy(plan), false);
}

{
  const volatileIntent = classifyExitIntent({
    action: "HOLD",
    currentPrice: 100,
    marketCapInr: 25_000_000_000,
    positionWeight: 4,
    pnlPercent: 4,
  });
  assert.equal(volatileIntent.code, "HIGH_VOLATILITY");

  const coreIntent = classifyExitIntent({
    action: "HOLD",
    purchaseDate: "2024-01-01",
    now: new Date("2026-06-02T00:00:00Z"),
    snowflakeTotal: 21,
    positionWeight: 4,
  });
  assert.equal(coreIntent.code, "CORE_COMPOUNDER");
}

{
  const review = buildExitPlan({
    action: "Reduction-50%",
    currentPrice: 100,
    supportLevel: 110,
    fairValueInr: 125,
    positionWeight: 16,
    marketCapInr: 200_000_000_000,
  });
  const clear = buildExitPlan({
    action: "HOLD",
    currentPrice: 80,
    supportLevel: 70,
    fairValueInr: 120,
    positionWeight: 5,
  });

  const summary = buildExitPlanSummary([
    { symbol: "REVIEWCO", currentPrice: 100, exitPlan: review },
    { symbol: "CLEARCO", currentPrice: 80, exitPlan: clear },
  ]);
  assert.equal(summary.schema_version, "exit-plan-summary-v1");
  assert.equal(summary.totalWithPlan, 2);
  assert.equal(summary.activeReviewCount, 1);
  assert.equal(summary.watchCount, 0);
  assert.equal(summary.highVolatilityCount, 1);
  assert.equal(summary.rows[0].symbol, "REVIEWCO");
  assert.equal(containsForbiddenExitPlanCopy(summary), false);
}

console.log("  ok");
