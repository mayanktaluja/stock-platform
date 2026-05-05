// v2 conviction engine — replaces the single-band action lookup with a
// 5-layer-vote decision tree that emits action + conviction + counter-thesis.
//
// Inputs (all collected by swsHoldingEngine.scoreHolding before this runs):
//   sws_action      — the v1 action band (EXIT / Reduction-* / HOLD / Top-up*)
//   sws_v3          — the v3 score 0..100
//   crosscheck      — output of swsLayerCrosscheck (Layer 2)
//   catalyst        — output of swsCatalystLayer    (Layer 4)
//   indianRisk      — output of swsIndianRiskLayer  (Layer 3)
//   position_ctx    — { positionWeight, sectorWeight, pnlPercent, holding }
//   fiscal          — scored.fiscal block (for the loss-deep-cut rule)
//
// Decision rule (per the agreed v2 spec):
//   1. Sum confidence_deltas from all 3 layers (-3..+3 net signal).
//   2. Map to conviction band:
//        net >= +2 → HIGH
//        net == +1 → MEDIUM-HIGH
//        net ==  0 → MEDIUM
//        net == -1 → MEDIUM-LOW
//        net <= -2 → LOW   (default tie-break: soften toward HOLD)
//   3. Action override:
//        LOW conviction + SWS-bullish action → soften by one tier.
//        LOW conviction + SWS-bearish action → soften by one tier.
//        HIGH conviction + bearish layer agreement upgrades a HOLD to
//        Reduction-25-33% (cautious-analyst stance per defaults).
//        HIGH conviction + bullish layer agreement upgrades a HOLD to
//        Top-up-modest (conservative — never STRONG Top-up off pure
//        agreement; Strong tier still requires v3 ≥ 55).
//   4. Position-context layer (legacy LOSS_DEEP_CUT rule from
//      portfolioIntelligence.js — currently absent in the v1 SWS engine):
//        pnl < -40              → forced EXIT (broken thesis on deep loss)
//        pnl < -30 + sws_v3<65  → forced Reduction-50%
//        pnl < -25 + sws_v3<55  → forced Reduction-25-33%
//        positionWeight > 15    → forced Reduction-25-33% (single-name risk)
//   5. Build narrative + counter-thesis.

import { num } from "./swsScoring.js";
import { buildReasonNarrative } from "./swsReasonNarrator.js";
import { buildCounterThesis } from "./swsCounterThesis.js";
import { ladderToLegacy } from "./actionLadder.js";

// Action ladder from most-bearish to most-bullish. softenAction("STRONG Top-up")
// returns "Top-up", softenAction("Reduction-50%") returns "Reduction-25-33%",
// etc. Tie-break stops at HOLD per the agreed default ("soften toward HOLD").
//
// The conviction engine works in legacy-label space — when the v2 ladder is
// firing upstream, ladder labels (EXIT-now, Reduction-66%, Top-up-100%, …)
// are normalised to legacy via ladderToLegacy() at every entry point. Output
// stays in legacy space; the holding engine layers the v2 label back on top.
const ACTION_LADDER = [
  "EXIT",
  "Reduction-50%",
  "Reduction-25-33%",
  "HOLD",
  "Top-up-modest",
  "Top-up",
  "STRONG Top-up",
];

function _ladderIndex(action) {
  const i = ACTION_LADDER.indexOf(ladderToLegacy(action));
  return i < 0 ? ACTION_LADDER.indexOf("HOLD") : i;
}

function _softenTowardHold(action) {
  const idx = _ladderIndex(action);
  const holdIdx = ACTION_LADDER.indexOf("HOLD");
  if (idx === holdIdx) return action;
  if (idx < holdIdx) return ACTION_LADDER[idx + 1];
  return ACTION_LADDER[idx - 1];
}

function _bumpToward(action, direction) {
  const idx = _ladderIndex(action);
  if (direction === "bullish" && idx < ACTION_LADDER.length - 1) {
    return ACTION_LADDER[idx + 1];
  }
  if (direction === "bearish" && idx > 0) {
    return ACTION_LADDER[idx - 1];
  }
  return action;
}

function _isBullishAction(action) {
  if (!action) return false;
  // Treat both legacy (Top-up-modest / Top-up / STRONG Top-up) and ladder-v2
  // (Top-up-25%/33%/50%/100%) labels as bullish. The startsWith("Top-up")
  // check naturally covers both.
  return action.startsWith("Top-up") || action === "STRONG Top-up";
}
function _isBearishAction(action) {
  if (!action) return false;
  // Legacy: EXIT, Reduction-*. Ladder-v2: EXIT-now, EXIT-staged, Reduction-*.
  return action === "EXIT" || action.startsWith("EXIT-") || action.startsWith("Reduction");
}

function _convictionBand(netDelta) {
  if (netDelta >= 2) return "HIGH";
  if (netDelta === 1) return "MEDIUM-HIGH";
  if (netDelta === 0) return "MEDIUM";
  if (netDelta === -1) return "MEDIUM-LOW";
  return "LOW";
}

// Position-context modifiers — fills the legacy LOSS_DEEP_CUT gap. Returns
// either a forced action (string) or null. These run AFTER the conviction
// engine has settled; they're hard guardrails.
//
// PR 2.1 / 2.2 (May 2026): Drawdown alone no longer forces EXIT. The earlier
// rule "pnl < -40 → EXIT regardless of current score" surfaced exits on
// names SWS still rated TOP_PICK with active +30% momentum (INOXWIND v3=67).
// New rule requires BOTH a deep drawdown AND a structural-weakness signal
// before forcing EXIT — at least one of:
//   • v3 score < 50 (composite has weakened)
//   • snowflake total < 14 (SWS pillars degraded)
//   • forward earnings growth < -10% (de-rating in fiscal block)
//   • independent crosscheck score < 50 (fundamentalsV2 confirms weakness)
// Drawdown without structural confirmation degrades to Reduction-50% and a
// "observe before exit" note rather than forcing the user out at the bottom.
//
// The disposition-effect tier was also too aggressive (TCS pnl=-30 v3=62 got
// Reduction-50% even though crosscheck and snow were strong). Lowered v3
// ceiling to 50 and added a "snow OR crosscheck weak" gate so the rule fires
// only when fundamentals also flag weakness.
function _positionGuardrail({ pnlPercent, sws_v3, sws_snow, fwdGrowth, positionWeight, crosscheck }) {
  const pnl = num(pnlPercent, 0);
  const v3 = num(sws_v3, 50);
  const snow = num(sws_snow, 18);
  const fwd = num(fwdGrowth, null);
  const indep = num(crosscheck?.independent_score, null);
  const indepWeak = indep != null && indep < 50;
  const pw = num(positionWeight, 0);

  const structurallyWeak =
    v3 < 50
    || snow < 14
    || (fwd != null && fwd < -10)
    || indepWeak;

  // Catastrophic drawdown — trim is mandatory; EXIT only when fundamentals also weak.
  if (pnl < -40 && structurallyWeak) {
    const tags = [`v3 ${v3.toFixed(0)}`, `snow ${snow}/30`];
    if (fwd != null && fwd < -10) tags.push(`fwd ${fwd.toFixed(1)}%`);
    if (indepWeak) tags.push(`indep ${indep.toFixed(0)}`);
    return {
      action: "EXIT",
      reason: `Deep loss ${pnl.toFixed(1)}% with structural weakness (${tags.join(", ")}) — thesis broken.`,
    };
  }
  if (pnl < -40) {
    return {
      action: "Reduction-50%",
      reason: `Drawdown ${pnl.toFixed(1)}% but fundamentals intact (v3 ${v3.toFixed(0)}, snow ${snow}/30) — partial trim, observe before exit.`,
    };
  }

  // Disposition-effect override — only fires when crosscheck or snowflake
  // also flag weakness. Prevents trim on quality compounders that are mid-correction.
  if (pnl < -30 && v3 < 50 && (snow < 18 || indepWeak)) {
    const why = indepWeak ? `independent score ${indep.toFixed(0)}` : `snow ${snow}/30`;
    return {
      action: "Reduction-50%",
      reason: `Loss ${pnl.toFixed(1)}% with v3 ${v3.toFixed(0)} and ${why} — disposition-effect override.`,
    };
  }
  if (pnl < -25 && v3 < 45 && (snow < 16 || indepWeak)) {
    return {
      action: "Reduction-25-33%",
      reason: `Loss ${pnl.toFixed(1)}% with v3 ${v3.toFixed(0)} — partial trim, free capital.`,
    };
  }

  if (pw > 15) return { action: "Reduction-25-33%", reason: `Position ${pw.toFixed(1)}% of book — single-name concentration risk.` };
  return null;
}

// Translate net layer delta + SWS action into v2 action.
function _resolveAction({ swsAction, netDelta }) {
  const bullish = _isBullishAction(swsAction);
  const bearish = _isBearishAction(swsAction);
  if (netDelta <= -2) {
    return _softenTowardHold(swsAction);
  }
  if (netDelta >= 2) {
    if (swsAction === "HOLD") {
      return "Top-up-modest";
    }
    if (bullish && swsAction !== "STRONG Top-up") return _bumpToward(swsAction, "bullish");
    if (bearish && swsAction !== "EXIT") return _bumpToward(swsAction, "bearish");
  }
  return swsAction;
}

// Main entrypoint — returns the v2 recommendation block.
export function computeRecommendationV2({
  sws_action,
  sws_v3,
  sws_verdict,
  crosscheck,
  catalyst,
  indianRisk,
  position_ctx,
  fiscal,
}) {
  const layerVotes = {
    crosscheck: crosscheck?.confidence_delta ?? 0,
    catalyst: catalyst?.confidence_delta ?? 0,
    indianRisk: indianRisk?.confidence_delta ?? 0,
  };
  const netDelta = layerVotes.crosscheck + layerVotes.catalyst + layerVotes.indianRisk;
  const conviction = _convictionBand(netDelta);

  // Step 1 — translate net delta into a layered action.
  let action = _resolveAction({ swsAction: sws_action, netDelta });
  let actionSource = action === sws_action ? "sws-confirmed" : "layer-adjusted";
  let guardrailReason = null;

  // Step 2 — position guardrail (loss-deep-cut + single-name risk).
  // Snowflake total and fwd growth come from the same scored object as
  // sws_v3, so they're sourced from position_ctx (set by swsHoldingEngine)
  // OR fallback to the fiscal block this function already receives.
  const guardrail = _positionGuardrail({
    pnlPercent: position_ctx?.pnlPercent,
    sws_v3,
    sws_snow: position_ctx?.snowflake_total ?? num(fiscal?.snowflake_total, null),
    fwdGrowth: num(fiscal?.earnings_growth_pct, null),
    positionWeight: position_ctx?.positionWeight,
    crosscheck,
  });
  if (guardrail) {
    // Guardrail beats layered action only when it would be MORE bearish
    // than the layer-adjusted action — never softens a layer call.
    if (_ladderIndex(guardrail.action) < _ladderIndex(action)) {
      action = guardrail.action;
      actionSource = "guardrail";
      guardrailReason = guardrail.reason;
    }
  }

  // Step 3 — build the per-layer agreement matrix the narrator consumes.
  const agreement = {
    crosscheck: { vote: layerVotes.crosscheck, summary: crosscheck?.reason || null },
    catalyst:   { vote: layerVotes.catalyst,   summary: catalyst?.summary   || null },
    indianRisk: { vote: layerVotes.indianRisk, summary: indianRisk?.summary || null },
  };

  // Step 4 — narrative paragraphs + counter-thesis.
  const narrative = buildReasonNarrative({
    action, sws_action, conviction, netDelta,
    sws_v3, sws_verdict,
    crosscheck, catalyst, indianRisk,
    position_ctx, fiscal,
    guardrailReason,
  });

  const counterThesis = buildCounterThesis({
    action, sws_action, conviction,
    crosscheck, catalyst, indianRisk,
    sws_v3, fiscal,
  });

  return {
    version: "v2",
    action,
    action_source: actionSource,
    conviction,
    net_delta: netDelta,
    layer_votes: layerVotes,
    agreement,
    primary_reason: narrative.primary_reason,
    narrative_paragraphs: narrative.paragraphs,
    counter_thesis: counterThesis.text,
    falsification_trigger: counterThesis.falsification_trigger,
    guardrail_reason: guardrailReason,
  };
}
