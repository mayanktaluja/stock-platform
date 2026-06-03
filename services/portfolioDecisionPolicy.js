import { num } from "./swsScoring.js";

export const MARKET_CAP_BUCKETS = {
  micro: { label: "Micro cap", maxPositionWeightPct: 2.5 },
  small: { label: "Small cap", maxPositionWeightPct: 4 },
  mid: { label: "Mid cap", maxPositionWeightPct: 6 },
  large: { label: "Large cap", maxPositionWeightPct: 8 },
  unknown: { label: "Unknown cap", maxPositionWeightPct: 0 },
};

const CRORE = 10_000_000;
const MICRO_CAP_INR = 5_000 * CRORE;
const SMALL_CAP_INR = 20_000 * CRORE;
const MID_CAP_INR = 100_000 * CRORE;

export function classifyMarketCapBucket(marketCapInr) {
  const mc = num(marketCapInr, null);
  if (mc == null || mc <= 0) return "unknown";
  if (mc < MICRO_CAP_INR) return "micro";
  if (mc < SMALL_CAP_INR) return "small";
  if (mc < MID_CAP_INR) return "mid";
  return "large";
}

export function buildSmallcapPolicy({ marketCapInr, marketCapBucket = null, positionWeight = 0 } = {}) {
  const bucket = marketCapBucket || classifyMarketCapBucket(marketCapInr);
  const cfg = MARKET_CAP_BUCKETS[bucket] || MARKET_CAP_BUCKETS.unknown;
  const pos = num(positionWeight, 0);
  const roomPct = Math.max(0, cfg.maxPositionWeightPct - pos);
  return {
    bucket,
    label: cfg.label,
    maxPositionWeightPct: cfg.maxPositionWeightPct,
    currentWeightPct: +pos.toFixed(2),
    roomPct: +roomPct.toFixed(2),
    constrained: bucket === "micro" || bucket === "small" || bucket === "unknown",
  };
}

export function buildSmallcapSleeve(scoredHoldings = []) {
  const totalValue = scoredHoldings.reduce((sum, h) => sum + num(h?.currentValue, 0), 0);
  const buckets = {};
  for (const h of scoredHoldings) {
    const sws = h?.sws || {};
    const bucket = h?.marketCapBucket || sws.market_cap_bucket || classifyMarketCapBucket(sws.market_cap_inr);
    if (!buckets[bucket]) buckets[bucket] = { count: 0, currentValue: 0, weightPct: 0 };
    buckets[bucket].count += 1;
    buckets[bucket].currentValue += num(h?.currentValue, 0);
  }
  for (const row of Object.values(buckets)) {
    row.currentValue = Math.round(row.currentValue);
    row.weightPct = totalValue > 0 ? +((row.currentValue / totalValue) * 100).toFixed(1) : 0;
  }
  const microWeightPct = buckets.micro?.weightPct || 0;
  const smallWeightPct = buckets.small?.weightPct || 0;
  const smallMicroWeightPct = +(microWeightPct + smallWeightPct).toFixed(1);
  return {
    buckets,
    smallMicroWeightPct,
    warning: smallMicroWeightPct >= 45
      ? `Small/micro sleeve is ${smallMicroWeightPct}% of the book; enforce stricter add caps and data freshness.`
      : null,
  };
}

export function buildDataQualityGate({
  swsCovered = true,
  fallback = false,
  staleData = false,
  dataAgeHours = null,
  snowflakeDataQuality = null,
  marketCapBucket = null,
  valuationConfidence = null,
} = {}) {
  const blockedReasons = [];
  const age = num(dataAgeHours, null);
  const bucket = marketCapBucket || "unknown";
  const stale = Boolean(staleData) || (age != null && age > 36);
  const insufficient = snowflakeDataQuality?.insufficient === true;

  if (!swsCovered || fallback) blockedReasons.push("SWS coverage fallback; route to coverage watch");
  if (bucket === "unknown") blockedReasons.push("market cap unavailable; route to coverage watch");
  if (insufficient) blockedReasons.push("SWS Snowflake has insufficient source data");
  if (stale) blockedReasons.push("SWS data is stale; cap action until refreshed");
  if (valuationConfidence && valuationConfidence !== "HIGH") blockedReasons.push("fair-value confidence is not HIGH");

  let status = "ok";
  if (!swsCovered || fallback || bucket === "unknown" || insufficient) status = "coverage_watch";
  else if (stale) status = "stale";

  return {
    status,
    stale,
    dataAgeHours: age,
    blockedReasons,
    snowflakeDataQuality: snowflakeDataQuality || null,
  };
}

function isReductionAction(action) {
  return String(action || "").startsWith("Reduction") || String(action || "").startsWith("EXIT");
}

function hasDiscountedCounterEvidence({ reconciled, v4 }) {
  return reconciled?.confidence === "HIGH"
    && num(reconciled?.upside_pct, -Infinity) >= 10
    && num(v4, 0) >= 53;
}

export function buildReductionEvidence({
  action,
  legacyAction = null,
  band = null,
  hard = null,
  valuationReview = null,
  newsSignal = null,
  dataQualityGate = null,
  marketCapBucket = "unknown",
  smallcapPolicy = null,
  positionWeight = 0,
  sectorWeight = 0,
  v4 = null,
  reconciled = null,
} = {}) {
  const requestedReduction = isReductionAction(action);
  const decisiveEvidence = Array.isArray(hard?.evidence) ? [...hard.evidence] : [];
  const counterEvidence = [];
  const blockedReasons = [];
  const dataStatus = dataQualityGate?.status || "ok";
  const pos = num(positionWeight, 0);
  const isRegulatory = decisiveEvidence.some((e) => e.type === "regulatory");
  const isExtremeConcentration = pos >= 25;
  const multiSource = decisiveEvidence.length >= 2;
  const discountedCounter = hasDiscountedCounterEvidence({ reconciled, v4 });

  if (discountedCounter) {
    counterEvidence.push(`High-confidence SWS FV still shows ${num(reconciled?.upside_pct, 0).toFixed(1)}% upside with v4 ${num(v4, 0).toFixed(1)}.`);
  }
  if (newsSignal?.signal > 0) counterEvidence.push("Positive SWS news is supportive context.");
  if (smallcapPolicy?.constrained) {
    counterEvidence.push(`${smallcapPolicy.label} sizing cap is ${smallcapPolicy.maxPositionWeightPct}% per name.`);
  }
  if (valuationReview?.recommendation === "review_only") {
    blockedReasons.push("valuation review only; no hard portfolio trigger");
  }
  if (Array.isArray(dataQualityGate?.blockedReasons)) blockedReasons.push(...dataQualityGate.blockedReasons);

  let status = requestedReduction ? "confirmed" : "review_only";
  let intent = requestedReduction ? "risk_reduction" : "valuation_review";
  let confidence = "medium";
  let requiresConfirmation = requestedReduction;

  if (!requestedReduction) {
    if (dataStatus === "coverage_watch") {
      status = "coverage_watch";
      intent = "data_quality";
      confidence = "low";
    } else if (dataStatus === "stale") {
      status = "blocked";
      intent = "data_quality";
      confidence = "low";
    } else if (valuationReview?.reviewCandidate) {
      status = "review_only";
      intent = "valuation_review";
      confidence = "medium";
    } else {
      status = "review_only";
      intent = "data_quality";
      confidence = "low";
    }
    requiresConfirmation = false;
  } else if (dataStatus === "coverage_watch" && !isRegulatory && !isExtremeConcentration) {
    status = "coverage_watch";
    intent = "data_quality";
    confidence = "low";
  } else if (dataStatus === "stale" && !isRegulatory && !isExtremeConcentration && !multiSource) {
    status = "blocked";
    intent = "data_quality";
    confidence = "low";
  } else if (discountedCounter && decisiveEvidence.length <= 1 && !isRegulatory && !isExtremeConcentration) {
    status = "review_only";
    intent = "valuation_review";
    confidence = "low";
    blockedReasons.push("discounted/high-v4 counter-evidence blocks single-factor reduction");
  } else {
    const primary = decisiveEvidence[0];
    status = "confirmed";
    intent = primary?.intent || (String(action || "").startsWith("EXIT") ? "thesis_break" : "risk_cap");
    confidence = isRegulatory || isExtremeConcentration || multiSource ? "high" : "medium";
  }

  return {
    status,
    intent,
    decisionConfidence: confidence,
    requestedAction: action || null,
    legacyAction,
    band,
    marketCapBucket,
    decisiveEvidence,
    counterEvidence,
    blockedReasons: [...new Set(blockedReasons.filter(Boolean))],
    dataQuality: dataQualityGate || null,
    requiresConfirmation,
  };
}

export function gateReductionAction({ action, band, reasons = [], reductionEvidence }) {
  if (!isReductionAction(action)) return { action, band, reasons };
  if (reductionEvidence?.status === "confirmed") return { action, band, reasons };
  const status = reductionEvidence?.status || "review_only";
  const label = status === "coverage_watch"
    ? "Coverage watch"
    : status === "blocked"
      ? "Data blocked"
      : "Review only";
  return {
    action: "HOLD",
    band: `${band || "REDUCTION"}-${String(status).toUpperCase()}`,
    reasons: [
      `${label}: reduction evidence is not decision-grade; no ladder sizing applied.`,
      ...reasons,
    ],
  };
}
