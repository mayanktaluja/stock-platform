import { ALL_REDUCTION_ACTIONS, ALL_TOPUP_ACTIONS, ladderToLegacy, parseTrimPct, parseTopUpPct } from "../actionLadder.js";

export const EXIT_PLAN_VERSION = "exit-plan-v1";
export const EXIT_PLAN_SUMMARY_VERSION = "exit-plan-summary-v1";

const FORBIDDEN_COPY_RE = /\b(buy now|sell now|book profit now|stop-loss hit|exit position|place order|guaranteed|assured returns?)\b/i;

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(v) {
  const n = finite(v);
  return n == null ? null : +n.toFixed(1);
}

function money(v) {
  const n = finite(v);
  return n == null ? null : +n.toFixed(2);
}

function daysHeld(purchaseDate, now = new Date()) {
  if (!purchaseDate) return null;
  const d = new Date(purchaseDate);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000));
}

function cleanList(items) {
  return (Array.isArray(items) ? items : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

function assertNoForbiddenCopy(plan) {
  const raw = JSON.stringify(plan);
  if (FORBIDDEN_COPY_RE.test(raw)) {
    throw new Error("exitPlanPolicy produced imperative or hype copy");
  }
}

export function classifyExitIntent(input = {}) {
  const action = input.action || "HOLD";
  const legacyAction = input.legacyAction || ladderToLegacy(action) || action;
  const positionWeight = finite(input.positionWeight) ?? 0;
  const pnlPercent = finite(input.pnlPercent) ?? 0;
  const marketCap = finite(input.marketCapInr);
  const earningsNearby = Boolean(input.earningsNearby || input.nextEarningsDate);
  const riskText = cleanList(input.risks).join(" ").toLowerCase();
  const days = daysHeld(input.purchaseDate, input.now);

  if (earningsNearby || input.eventTrade === true) {
    return {
      code: "EVENT_TRADE",
      label: "Event trade",
      family: "event",
      rationale: "Near-term event risk means gap moves can dominate normal support references.",
    };
  }

  if (
    positionWeight >= 12 ||
    Math.abs(pnlPercent) >= 30 ||
    (marketCap != null && marketCap < 50_000_000_000) ||
    /\b(volatile|cash runway|unprofitable|high level of debt|less than a year)\b/i.test(riskText)
  ) {
    return {
      code: "HIGH_VOLATILITY",
      label: "High-volatility holding",
      family: "volatile",
      rationale: "Sizing, drawdown, liquidity, or SWS risk flags call for wider review bands and explicit caveats.",
    };
  }

  if (
    days != null && days >= 365 &&
    !ALL_REDUCTION_ACTIONS.has(action) &&
    (input.fundamentalVerdict === "QUALITY_GROWTH" || finite(input.snowflakeTotal) >= 18)
  ) {
    return {
      code: "CORE_COMPOUNDER",
      label: "Core compounder",
      family: "core",
      rationale: "Longer-held quality exposure is better reviewed through thesis, valuation, and concentration rather than a tight percentage rule.",
    };
  }

  return {
    code: "TACTICAL_SWING",
    label: "Tactical swing",
    family: "tactical",
    rationale: "Medium-term holding where support and upside-band references are useful review anchors.",
  };
}

function buildPositionIntent(input) {
  const action = input.action || "HOLD";
  const trimPct = parseTrimPct(action);
  const topUpPct = parseTopUpPct(action);
  const intent =
    ALL_REDUCTION_ACTIONS.has(action) ? "reduce-review" :
    ALL_TOPUP_ACTIONS.has(action) ? "add-candidate" :
    action === "HOLD" ? "hold" : "watch";
  const fraction = trimPct > 0 ? trimPct : topUpPct > 0 ? topUpPct : 0;
  return {
    action,
    legacyAction: input.legacyAction || ladderToLegacy(action) || action,
    intent,
    fraction,
    tradeRupees: finite(input.trimRupees ?? input.topUpRupees),
    urgency: input.actionUrgency || "none",
  };
}

function buildSupportLevel(input) {
  const technical = money(input.supportLevel ?? input.stopLoss ?? input.midTerm?.stopLoss);
  if (technical != null) {
    return {
      value: technical,
      source: "technical",
      confidence: finite(input.atrPct ?? input.midTerm?.volatilityPct) != null ? "medium" : "low",
      label: "Support review",
    };
  }

  const currentPrice = finite(input.currentPrice ?? input.current_price_inr);
  const avgPrice = finite(input.avgPrice);
  if (currentPrice != null && avgPrice != null && currentPrice < avgPrice * 0.85) {
    return {
      value: money(avgPrice * 0.85),
      source: "cost_drawdown",
      confidence: "low",
      label: "Drawdown review",
    };
  }

  return { value: null, source: "none", confidence: "low", label: "No support level" };
}

function buildUpsideBand(input) {
  const technical = money(input.upsideBand ?? input.target ?? input.midTerm?.target);
  if (technical != null) {
    return {
      value: technical,
      source: "technical",
      confidence: finite(input.atrPct ?? input.midTerm?.volatilityPct) != null ? "medium" : "low",
      label: "Upside band",
    };
  }

  const fv = money(input.fairValueInr ?? input.fair_value_inr);
  if (fv != null) {
    return {
      value: fv,
      source: "sws_fv",
      confidence: input.fairValueConfidence || input.valuationConfidence || "medium",
      label: "Analyst FV reference",
    };
  }

  return { value: null, source: "none", confidence: "low", label: "No upside band" };
}

function buildProfitZone(input, upsideReference) {
  const current = finite(input.currentPrice ?? input.current_price_inr);
  const avg = finite(input.avgPrice);
  const pnl = pct(input.pnlPercent);
  const band = finite(upsideReference?.value);
  const inZone = current != null && band != null && current >= band * 0.95;
  return {
    inZone,
    label: inZone ? "Profit-zone review" : "Profit-zone reference",
    currentPrice: money(current),
    avgPrice: money(avg),
    pnlPercent: pnl,
    referencePrice: money(band),
    reviewText: inZone
      ? "Price is near the upside reference; review allocation, tax, and thesis freshness before changing exposure."
      : "No profit-zone review is active from the available reference levels.",
  };
}

function buildTrailingReference(input) {
  const trailing = input.trailingStop ?? input.midTerm?.trailingStop ?? null;
  if (!trailing) return null;
  const active = Boolean(trailing.activated);
  return {
    active,
    activationPriceInr: money(trailing.activationLevel ?? trailing.activationThreshold),
    currentLevelInr: money(trailing.currentLevel),
    rule: trailing.rule || "Trailing reference from the technical engine.",
    source: "technical",
    confidence: "medium",
  };
}

function severityRank(severity) {
  return severity === "high" ? 3 : severity === "medium" ? 2 : severity === "low" ? 1 : 0;
}

function evaluateTrigger(input, supportReference, profitZone) {
  const reasons = [];
  let state = "CLEAR";
  let severity = "low";
  let label = "Clear";

  const current = finite(input.currentPrice ?? input.current_price_inr);
  const support = finite(supportReference?.value);
  if (current != null && support != null && current <= support) {
    state = "REVIEW";
    severity = "high";
    label = "Support review";
    reasons.push("Current price is below the support reference; review the holding thesis and liquidity before changing exposure.");
  }

  if (profitZone?.inZone) {
    if (state !== "REVIEW") state = "WATCH";
    if (severityRank(severity) < 2) severity = "medium";
    label = state === "REVIEW" ? label : "Profit-zone review";
    reasons.push(profitZone.reviewText);
  }

  const positionWeight = finite(input.positionWeight) ?? 0;
  if (positionWeight >= 25) {
    state = "REVIEW";
    severity = "high";
    label = "Concentration review";
    reasons.push(`Position weight ${positionWeight.toFixed(1)}% is above the single-name concentration review threshold.`);
  } else if (positionWeight >= 15) {
    if (state === "CLEAR") state = "WATCH";
    if (severityRank(severity) < 2) severity = "medium";
    if (label === "Clear") label = "Concentration watch";
    reasons.push(`Position weight ${positionWeight.toFixed(1)}% is above the watch threshold.`);
  }

  if (ALL_REDUCTION_ACTIONS.has(input.action)) {
    state = "REVIEW";
    if (severityRank(severity) < 2) severity = input.action === "EXIT" || String(input.action).startsWith("EXIT") ? "high" : "medium";
    label = label === "Clear" ? "Reduction review" : label;
    reasons.push("The SWS action ladder is already flagging this holding for reduction review.");
  }

  return {
    state,
    label,
    severity,
    reasons: reasons.length ? reasons.slice(0, 5) : ["No active review trigger from available exit-plan inputs."],
  };
}

function buildCaveats(input, trailingReference) {
  const caveats = [];
  if (!trailingReference) caveats.push("No ATR/peak history available in this analyzer path; trailing reference is omitted.");
  if (input.earningsNearby || input.nextEarningsDate) caveats.push("Event-day gaps can move through support references; levels are not execution prices.");
  if (finite(input.risk?.daysToExit) != null && finite(input.risk?.daysToExit) > 5) {
    caveats.push(`Liquidity review: full unwind may require about ${input.risk.daysToExit} trading days at the 20% ADV rule.`);
  }
  return caveats;
}

export function buildExitPlan(input = {}) {
  const intent = classifyExitIntent(input);
  const positionIntent = buildPositionIntent(input);
  const supportReference = buildSupportLevel(input);
  const upsideReference = buildUpsideBand(input);
  const trailingReference = buildTrailingReference(input);
  const profitZone = buildProfitZone(input, upsideReference);
  const trigger = evaluateTrigger(input, supportReference, profitZone);
  const caveats = buildCaveats(input, trailingReference);
  const atrPct = pct(input.atrPct ?? input.midTerm?.volatilityPct);

  const rationale = [
    intent.rationale,
    ...cleanList(input.ladderRationale).slice(0, 2),
    ...cleanList(input.reasons).slice(0, 3),
  ].filter(Boolean).slice(0, 6);

  const plan = {
    schema_version: EXIT_PLAN_VERSION,
    localOnly: true,
    intent: intent.code,
    intentLabel: intent.label,
    displayLabel: "Technical levels (analytical reference, not trade instructions)",
    positionIntent,
    supportLevel: supportReference.value,
    supportReference,
    // Backward-compatible aliases for legacy analyzer renderers.
    stopLoss: supportReference.value,
    slConfirmationRule: supportReference.value
      ? "Review rule: two consecutive daily closes below the support reference are stronger evidence than a single intraday move."
      : null,
    upsideBand: upsideReference.value,
    upsideReference,
    target: upsideReference.value,
    trailingStop: trailingReference
      ? {
          activated: trailingReference.active,
          activationLevel: trailingReference.activationPriceInr,
          currentLevel: trailingReference.currentLevelInr,
          rule: trailingReference.rule,
        }
      : null,
    atrPct,
    profitZone,
    trigger,
    policy: {
      supportStyle: intent.family === "core" ? "thesis-and-concentration review" : "support review",
      profitStyle: intent.family === "core" ? "valuation/concentration trim reference" : "profit-zone reference",
      holdStyle: intent.family === "event" ? "event-window review" : "thesis freshness review",
    },
    dataAvailability: {
      hasAtr: atrPct != null,
      hasPeak: finite(input.peakPrice ?? input.peak_price_inr) != null,
      hasSupport: supportReference.value != null,
      hasUpsideBand: upsideReference.value != null,
      hasTrailingReference: trailingReference != null,
    },
    caveats,
    rationale,
  };

  assertNoForbiddenCopy(plan);
  return plan;
}

export function buildExitPlanSummary(holdings = []) {
  const rows = [];
  const counts = {
    totalWithPlan: 0,
    activeReviewCount: 0,
    watchCount: 0,
    profitZoneCount: 0,
    concentrationReviewCount: 0,
    highVolatilityCount: 0,
  };
  const rowReason = (plan) => {
    const parts = [
      ...cleanList(plan.trigger?.reasons).slice(0, 2),
      plan.profitZone?.inZone ? plan.profitZone.reason : null,
      ...cleanList(plan.rationale).slice(0, 2),
      ...cleanList(plan.caveats).slice(0, 1),
    ].filter(Boolean);
    return parts[0] || "No active review trigger; keep this as a reference level.";
  };

  for (const h of Array.isArray(holdings) ? holdings : []) {
    const plan = h?.exitPlan;
    if (!plan || plan.schema_version !== EXIT_PLAN_VERSION) continue;
    counts.totalWithPlan++;
    if (plan.trigger?.state === "REVIEW") counts.activeReviewCount++;
    if (plan.trigger?.state === "WATCH") counts.watchCount++;
    if (plan.profitZone?.inZone) counts.profitZoneCount++;
    if (/concentration/i.test(plan.trigger?.label || "")) counts.concentrationReviewCount++;
    if (plan.intent === "HIGH_VOLATILITY") counts.highVolatilityCount++;
    if (plan.trigger?.state !== "CLEAR" || plan.profitZone?.inZone || plan.intent === "HIGH_VOLATILITY") {
      rows.push({
        symbol: h?.sws?.ticker || h?.symbol || h?.ticker || "—",
        name: h?.sws?.name || h?.name || "",
        intentLabel: plan.intentLabel,
        state: plan.trigger?.state || "CLEAR",
        severity: plan.trigger?.severity || "low",
        currentPrice: money(h?.currentPrice ?? h?.sws?.current_price_inr),
        supportLevel: plan.supportReference?.value ?? plan.supportLevel ?? null,
        upsideBand: plan.upsideReference?.value ?? plan.upsideBand ?? null,
        profitZone: Boolean(plan.profitZone?.inZone),
        reason: rowReason(plan),
      });
    }
  }

  rows.sort((a, b) => {
    const rank = { high: 3, medium: 2, low: 1 };
    return (rank[b.severity] || 0) - (rank[a.severity] || 0);
  });

  return {
    schema_version: EXIT_PLAN_SUMMARY_VERSION,
    ...counts,
    rows: rows.slice(0, 8),
    copy: "Technical levels are analytical references, not trade instructions.",
  };
}

export function containsForbiddenExitPlanCopy(value) {
  return FORBIDDEN_COPY_RE.test(typeof value === "string" ? value : JSON.stringify(value));
}
