// Counter-thesis + falsification-trigger builder for the v2 conviction
// engine. SEBI-style analyst output should always articulate the case
// against the current call and the specific event that would reverse it.
// Pure templating, no LLM.

import { num } from "./swsScoring.js";

function _isBullishAction(a) { return a && (a.startsWith("Top-up") || a === "STRONG Top-up"); }
function _isBearishAction(a) { return a && (a === "EXIT" || a.startsWith("Reduction")); }

function _bullCase({ crosscheck, catalyst, indianRisk, sws_v3, fiscal }) {
  const bits = [];
  if (crosscheck?.available && crosscheck.independent_score != null && crosscheck.independent_score > num(sws_v3, 0)) {
    bits.push(`Layer-2 independent fundamentals score this ${crosscheck.independent_score.toFixed(0)}/100 — higher than SWS v3 ${num(sws_v3, 0).toFixed(0)}, so the bear view may be over-weighting near-term momentum`);
  }
  if (catalyst?.recent_pt_actions?.some((r) => r.direction === "increased")) {
    bits.push(`a recent analyst PT raise is in the catalyst block — broker view diverges from quantitative score`);
  }
  if (catalyst?.last_quarter_result === "beat") {
    bits.push(`last-quarter beat extends; post-earnings drift typically lasts 30–60 days`);
  }
  if (num(fiscal?.revenue_growth_pct, 0) > 10 && num(fiscal?.earnings_growth_pct, 0) < 0) {
    bits.push(`top-line growth is intact (revenue +${fiscal.revenue_growth_pct.toFixed(1)}%) — margin compression may be one-off`);
  }
  return bits;
}

function _bearCase({ crosscheck, catalyst, indianRisk, sws_v3, fiscal }) {
  const bits = [];
  if (crosscheck?.available && crosscheck.independent_score != null && crosscheck.independent_score < num(sws_v3, 0)) {
    bits.push(`Layer-2 independent fundamentals score this ${crosscheck.independent_score.toFixed(0)}/100 — lower than SWS v3 ${num(sws_v3, 0).toFixed(0)}, so the bullish quant signal may not be confirmed by RoE/margin/leverage trends`);
  }
  if (catalyst?.recent_pt_actions?.some((r) => r.direction === "decreased")) {
    bits.push(`a recent analyst PT cut is in the catalyst block`);
  }
  if (catalyst?.last_quarter_result === "miss") {
    bits.push(`last quarter missed estimates — earnings re-rate downside risk`);
  }
  if (indianRisk?.surveillance) {
    bits.push(`stock is on NSE ${indianRisk.surveillance.list} surveillance — circuit filters tightened`);
  }
  if (num(fiscal?.earnings_growth_pct, 0) < -10) {
    bits.push(`earnings declining ${fiscal.earnings_growth_pct.toFixed(1)}% YoY — structural concern`);
  }
  return bits;
}

function _falsificationFor({ action, crosscheck, catalyst, indianRisk, sws_v3, fiscal }) {
  // The list of concrete events that would reverse the current call. SEBI
  // analyst convention: 2-4 specific, observable, time-bounded triggers.
  const triggers = [];
  if (_isBearishAction(action)) {
    triggers.push("the next quarterly result beats consensus by ≥10%");
    if (crosscheck?.available && crosscheck.divergent_pillars?.length > 0) {
      const weakest = crosscheck.divergent_pillars[0];
      triggers.push(`Layer-2 ${weakest.pillar} pillar improves materially (currently ${weakest.delta > 0 ? "+" : ""}${weakest.delta} vs SWS)`);
    }
    if (indianRisk?.surveillance) {
      triggers.push(`NSE removes the ${indianRisk.surveillance.list} surveillance flag`);
    }
    triggers.push("a new analyst PT is raised by ≥15%");
  } else if (_isBullishAction(action)) {
    triggers.push("the next quarterly result misses estimates");
    if (crosscheck?.divergent_pillars?.length > 0) {
      triggers.push(`Layer-2 cross-check agreement drops below 40%`);
    }
    if (catalyst?.momentum_1m != null && catalyst.momentum_1m > 25) {
      triggers.push(`1M return turns negative (currently +${catalyst.momentum_1m.toFixed(1)}%)`);
    }
    triggers.push(`a new India-risk overlay materialises (ASM/GSM, promoter pledge spike)`);
  } else {
    triggers.push("a new material catalyst lands in the next 30 days");
    triggers.push("layer agreement drops below 33%");
  }
  return triggers;
}

export function buildCounterThesis({ action, sws_action, conviction, crosscheck, catalyst, indianRisk, sws_v3, fiscal }) {
  const isBull = _isBullishAction(action);
  const isBear = _isBearishAction(action);
  const oppositeCase = isBull
    ? _bearCase({ crosscheck, catalyst, indianRisk, sws_v3, fiscal })
    : isBear
      ? _bullCase({ crosscheck, catalyst, indianRisk, sws_v3, fiscal })
      : [];

  const text = oppositeCase.length === 0
    ? `Counter-thesis: no strong opposing signal in the layer outputs — the call is well-grounded but a single-source view; verify your independent thesis before acting.`
    : `Counter-thesis: ${oppositeCase.join("; ")}.`;

  const triggers = _falsificationFor({ action, crosscheck, catalyst, indianRisk, sws_v3, fiscal });
  const falsification_trigger = `Hold the **${action}** view unless any of: ${triggers.map((t, i) => `(${i + 1}) ${t}`).join("; ")}.`;

  return { text, falsification_trigger };
}
