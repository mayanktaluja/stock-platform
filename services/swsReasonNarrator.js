// 3-paragraph narrative builder for the v2 conviction engine.
//
// Replaces the bullet-list reason template in swsHoldingEngine.buildSWSReasons
// with three short paragraphs that read as analyst opinion rather than a
// data dump:
//
//   ¶1  Verdict + primary driver  (why the engine landed on this action)
//   ¶2  Layer agreement detail    (what each independent layer said,
//                                  surfacing divergences explicitly)
//   ¶3  Position context note     (P&L stance, weight, sector posture —
//                                  pulled from position_ctx)
//
// Pure templating — deterministic, audit-safe, no LLM. Conditional clauses
// keep paragraphs from reading like template gibberish on edge cases.

import { num } from "./swsScoring.js";

function _humanAction(action) {
  return action || "—";
}

function _convictionPhrase(conviction) {
  switch (conviction) {
    case "HIGH": return "high conviction (3 of 3 layers confirm)";
    case "MEDIUM-HIGH": return "medium-high conviction (2 of 3 layers confirm)";
    case "MEDIUM": return "medium conviction (layers split or neutral)";
    case "MEDIUM-LOW": return "medium-low conviction (1 layer dissents)";
    case "LOW":
    default: return "low conviction (multiple layers dissent — softened toward HOLD per default tie-break)";
  }
}

function _primaryDriverFromLayers({ sws_v3, sws_verdict, crosscheck, catalyst, indianRisk }) {
  // Pick the layer with the strongest signal — non-zero confidence_delta,
  // largest absolute magnitude wins. Falls through to SWS-only narration
  // when no layer has a strong opinion.
  const candidates = [
    { name: "Indian-risk", text: indianRisk?.summary, magnitude: Math.abs(indianRisk?.risk_score ?? 0), delta: indianRisk?.confidence_delta ?? 0 },
    { name: "Catalyst", text: catalyst?.summary, magnitude: Math.abs(catalyst?.catalystScore ?? 0), delta: catalyst?.confidence_delta ?? 0 },
    { name: "Cross-check", text: crosscheck?.reason, magnitude: 100 - (crosscheck?.pillar_agreement_pct ?? 100), delta: crosscheck?.confidence_delta ?? 0 },
  ].filter((c) => c.delta !== 0 && c.text);
  if (candidates.length === 0) {
    return `SWS V4 score ${num(sws_v3, 0).toFixed(0)}/100 (verdict: ${sws_verdict || "n/a"}) is the dominant driver — no independent layer carries a strong dissent or confirmation.`;
  }
  candidates.sort((a, b) => b.magnitude - a.magnitude);
  const top = candidates[0];
  return `${top.name} layer is the dominant driver: ${top.text}`;
}

function _positionParagraph({ position_ctx, fiscal, action }) {
  if (!position_ctx) return null;
  const pnl = num(position_ctx.pnlPercent, 0);
  const pw = num(position_ctx.positionWeight, 0);
  const sw = num(position_ctx.sectorWeight, 0);
  const pnlClause = pnl >= 5 ? `up ${pnl.toFixed(1)}%` : pnl <= -5 ? `down ${Math.abs(pnl).toFixed(1)}%` : `near break-even (${pnl.toFixed(1)}%)`;
  const weightClause = pw > 10 ? `, oversized at ${pw.toFixed(1)}% of book` : pw > 5 ? `, mid-weight at ${pw.toFixed(1)}%` : `, small at ${pw.toFixed(1)}%`;
  const sectorClause = sw > 25 ? `; sector exposure ${sw.toFixed(0)}% (concentrated)` : sw > 15 ? `; sector ${sw.toFixed(0)}%` : "";

  let stance;
  if (action === "EXIT" && pnl < -10) stance = "Tax-loss harvest opportunity — set-off potential against realised gains.";
  else if (action?.startsWith("Reduction") && pnl > 30) stance = "Booking partial gains — locks profit, reduces single-name beta.";
  else if (action?.startsWith("Top-up") && pnl < -10) stance = "Averaging-down territory — verify thesis intact before adding.";
  else if (action === "HOLD") stance = "No transaction needed — re-evaluate next quarter.";
  else stance = null;

  return `Position is ${pnlClause}${weightClause}${sectorClause}.${stance ? " " + stance : ""}`;
}

export function buildReasonNarrative({
  action, sws_action, conviction, netDelta,
  sws_v3, sws_verdict,
  crosscheck, catalyst, indianRisk,
  position_ctx, fiscal,
  guardrailReason,
}) {
  const para1 = guardrailReason
    ? `**${_humanAction(action)}** — ${guardrailReason} (Position-guardrail override; conviction band irrelevant for this rule.)`
    : `**${_humanAction(action)}** with ${_convictionPhrase(conviction)}.${
        action !== sws_action ? ` SWS-only band would have said ${sws_action}; layer signal moved it.` : ""
      } ${_primaryDriverFromLayers({ sws_v3, sws_verdict, crosscheck, catalyst, indianRisk })}`;

  // ¶2 — explicit per-layer summary so the user sees WHY conviction is what
  // it is, not just the band label.
  const layer2 = [];
  if (crosscheck?.available) layer2.push(`• Cross-check (Layer 2): ${crosscheck.reason}`);
  else layer2.push(`• Cross-check (Layer 2): unavailable (${crosscheck?.reason || "no snapshot"}).`);
  if (catalyst?.available) layer2.push(`• Catalyst (Layer 4): ${catalyst.summary}`);
  if (indianRisk?.available) layer2.push(`• India-risk (Layer 3): ${indianRisk.summary}`);
  const para2 = layer2.join(" ");

  const para3 = _positionParagraph({ position_ctx, fiscal, action });

  const paragraphs = [para1, para2];
  if (para3) paragraphs.push(para3);

  return {
    primary_reason: para1,
    paragraphs,
  };
}
