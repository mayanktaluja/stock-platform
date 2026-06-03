import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDataQualityGate,
  buildReductionEvidence,
  buildSmallcapPolicy,
  classifyMarketCapBucket,
  gateReductionAction,
} from "../services/portfolioDecisionPolicy.js";

test("market-cap buckets and caps match analyzer policy", () => {
  assert.equal(classifyMarketCapBucket(4_999 * 10_000_000), "micro");
  assert.equal(classifyMarketCapBucket(19_999 * 10_000_000), "small");
  assert.equal(classifyMarketCapBucket(99_999 * 10_000_000), "mid");
  assert.equal(classifyMarketCapBucket(100_000 * 10_000_000), "large");
  assert.equal(classifyMarketCapBucket(null), "unknown");

  assert.equal(buildSmallcapPolicy({ marketCapBucket: "micro" }).maxPositionWeightPct, 2.5);
  assert.equal(buildSmallcapPolicy({ marketCapBucket: "small" }).maxPositionWeightPct, 4);
  assert.equal(buildSmallcapPolicy({ marketCapBucket: "mid" }).maxPositionWeightPct, 6);
  assert.equal(buildSmallcapPolicy({ marketCapBucket: "large" }).maxPositionWeightPct, 8);
});

test("discounted high-v4 stale fiscal-only reduction becomes review-only", () => {
  const dataQualityGate = buildDataQualityGate({
    swsCovered: true,
    staleData: true,
    dataAgeHours: 74,
    marketCapBucket: "large",
    valuationConfidence: "HIGH",
  });
  const reductionEvidence = buildReductionEvidence({
    action: "Reduction-50%",
    legacyAction: "Reduction-50%",
    band: "HARD_OVERRIDE",
    hard: {
      evidence: [{
        type: "earnings_decline",
        intent: "thesis_break",
        source: "sws_fiscal",
        confidence: "medium",
        summary: "Earnings decline only.",
      }],
    },
    dataQualityGate,
    marketCapBucket: "large",
    positionWeight: 1.5,
    v4: 64,
    reconciled: { confidence: "HIGH", upside_pct: 35 },
  });
  const gated = gateReductionAction({
    action: "Reduction-50%",
    band: "HARD_OVERRIDE",
    reasons: ["earnings decline"],
    reductionEvidence,
  });

  assert.equal(reductionEvidence.status, "blocked");
  assert.equal(gated.action, "HOLD");
  assert.match(gated.reasons[0], /not decision-grade/i);
});

test("fresh confirmed earnings decline can remain a reduction", () => {
  const dataQualityGate = buildDataQualityGate({
    swsCovered: true,
    staleData: false,
    dataAgeHours: 8,
    marketCapBucket: "mid",
    valuationConfidence: "HIGH",
  });
  const reductionEvidence = buildReductionEvidence({
    action: "Reduction-50%",
    legacyAction: "Reduction-50%",
    band: "HARD_OVERRIDE",
    hard: {
      evidence: [
        { type: "earnings_decline", intent: "thesis_break", source: "sws_fiscal", confidence: "medium", summary: "Earnings decline with revenue decline." },
        { type: "multi_signal", intent: "thesis_break", source: "sws_factor_stack", confidence: "high", summary: "Multiple risk signals." },
      ],
    },
    dataQualityGate,
    marketCapBucket: "mid",
    positionWeight: 5,
    v4: 42,
    reconciled: { confidence: "HIGH", upside_pct: -8 },
  });
  const gated = gateReductionAction({
    action: "Reduction-50%",
    band: "HARD_OVERRIDE",
    reasons: ["confirmed weakness"],
    reductionEvidence,
  });

  assert.equal(reductionEvidence.status, "confirmed");
  assert.equal(gated.action, "Reduction-50%");
});

test("coverage fallback emits coverage-watch", () => {
  const dataQualityGate = buildDataQualityGate({
    swsCovered: false,
    fallback: true,
    marketCapBucket: "unknown",
    valuationConfidence: "NONE",
  });
  const reductionEvidence = buildReductionEvidence({
    action: "Reduction-50%",
    dataQualityGate,
    marketCapBucket: "unknown",
    positionWeight: 4,
    v4: 30,
    reconciled: { confidence: "NONE", upside_pct: null },
  });

  assert.equal(dataQualityGate.status, "coverage_watch");
  assert.equal(reductionEvidence.status, "coverage_watch");
  assert.equal(gateReductionAction({ action: "Reduction-50%", reductionEvidence }).action, "HOLD");
});
