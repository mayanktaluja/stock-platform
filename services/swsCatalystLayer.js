// Layer-4 catalyst signal extraction for the SWS holding engine.
//
// Reads the SWS deep file's catalyst-bearing fields (next_earnings_date,
// recent_analyst_revisions, insider_activity, last_quarter_result, news,
// rewards/risks, momentum returns) and emits a single signed catalystScore
// plus a structured pending_catalysts list the conviction engine (PR 3) and
// the v2 reason narrator will consume.
//
// Shadow attach only — never overrides the SWS verdict on its own. Today's
// SWS API capture leaves insider_activity/recent_analyst_revisions/news
// empty for ~98% of the universe, so the score is dominated by earnings-
// proximity and momentum signals. The framework is here so a richer capture
// will plug in without code changes.

import { num } from "./swsScoring.js";

// catalystScore deltas. All bounded to [-10, +10] after summation.
const PT_UPGRADE_BONUS = +3;
const PT_DOWNGRADE_PENALTY = -3;
const QTR_BEAT_BONUS = +2;
const QTR_MISS_PENALTY = -2;
const INSIDER_BUY_BONUS = +1;
const EARNINGS_PROXIMITY_PENALTY = -2;   // < 7 days = uncertainty
const POST_BEAT_DRIFT_BONUS = +1;        // earnings 8-30d AND last quarter beat
const STRONG_MOMENTUM_BONUS = +1;        // 1M return > 8% (positive momentum tailwind)
const FALLING_KNIFE_PENALTY = -2;        // 1M return < -15% (capitulation risk)

function _earningsDays(deep) {
  const next = deep?.overview?.next_earnings_date;
  if (!next) return null;
  const t = Date.parse(next + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

function _ptActions(deep) {
  const revs = deep?.overview?.recent_analyst_revisions || [];
  return revs
    .filter((r) => r && r.direction)
    .map((r) => ({
      date: r.date || null,
      direction: r.direction,
      target: r.target ?? r.amount ?? null,
    }));
}

function _insiderBuyCount(deep) {
  const insider = deep?.overview?.insider_activity || [];
  return insider.filter((x) => x && x.direction === "buy").length;
}

// Build the human-readable pending_catalysts list. The conviction engine
// surfaces these in `falsification_trigger` ("Hold the Reduction view
// unless Q-result on 2026-05-12 beats by ≥10%") so they need to read as
// concrete actionable events.
function _buildPendingCatalysts({ epsDays, ptActions, lastQtr, insiderBuys, ret1m }) {
  const out = [];
  if (epsDays != null && epsDays >= 0) {
    if (epsDays === 0) out.push({ kind: "earnings", text: "Q-result today", urgency: "high" });
    else if (epsDays <= 7) out.push({ kind: "earnings", text: `Q-result in ${epsDays}d`, urgency: "high" });
    else if (epsDays <= 30) out.push({ kind: "earnings", text: `Q-result in ${epsDays}d`, urgency: "medium" });
  }
  for (const r of ptActions.slice(0, 3)) {
    out.push({
      kind: "pt_action",
      text: `${r.direction === "increased" ? "PT raised" : "PT cut"}${r.date ? ` (${r.date})` : ""}`,
      urgency: r.direction === "decreased" ? "medium" : "low",
    });
  }
  if (lastQtr === "miss") out.push({ kind: "qtr_miss", text: "Last quarter missed estimates", urgency: "medium" });
  if (lastQtr === "beat") out.push({ kind: "qtr_beat", text: "Last quarter beat estimates", urgency: "low" });
  if (insiderBuys > 0) out.push({ kind: "insider_buy", text: `${insiderBuys} recent insider buy(s)`, urgency: "low" });
  if (ret1m != null && ret1m < -15) out.push({ kind: "drawdown", text: `1M return ${ret1m.toFixed(1)}% — capitulation watch`, urgency: "medium" });
  if (ret1m != null && ret1m > 25) out.push({ kind: "overshoot", text: `1M return +${ret1m.toFixed(1)}% — extended`, urgency: "medium" });
  return out;
}

// Compute the signed catalyst score. All inputs guarded against null.
function _computeCatalystScore({ epsDays, ptActions, lastQtr, insiderBuys, ret1m }) {
  let score = 0;
  for (const r of ptActions) {
    if (r.direction === "increased") score += PT_UPGRADE_BONUS;
    else if (r.direction === "decreased") score += PT_DOWNGRADE_PENALTY;
  }
  if (lastQtr === "beat") score += QTR_BEAT_BONUS;
  else if (lastQtr === "miss") score += QTR_MISS_PENALTY;
  if (insiderBuys > 0) score += INSIDER_BUY_BONUS;
  if (epsDays != null && epsDays >= 0 && epsDays <= 7) score += EARNINGS_PROXIMITY_PENALTY;
  if (epsDays != null && epsDays >= 8 && epsDays <= 30 && lastQtr === "beat") score += POST_BEAT_DRIFT_BONUS;
  if (ret1m != null && ret1m > 8) score += STRONG_MOMENTUM_BONUS;
  if (ret1m != null && ret1m < -15) score += FALLING_KNIFE_PENALTY;
  return Math.max(-10, Math.min(10, score));
}

// Layer-4 signal-direction → conviction nudge. Mirrors swsLayerCrosscheck:
//   score >= +3  → +1 (catalysts confirm bullish bias)
//   score <= -3  → -1 (catalysts contradict — soften)
//   else         →  0
function _confidenceDelta(score) {
  if (score == null) return 0;
  if (score >= 3) return +1;
  if (score <= -3) return -1;
  return 0;
}

function _buildSummary({ score, pending, ptCount }) {
  if (pending.length === 0 && ptCount === 0) {
    return "No proximate catalysts in current SWS capture.";
  }
  const head = score >= 3 ? "Catalyst tailwind" : score <= -3 ? "Catalyst headwind" : "Mixed catalyst signal";
  const top = pending.slice(0, 3).map((p) => p.text).join("; ");
  return `${head} (score ${score >= 0 ? "+" : ""}${score}/10): ${top || "no specific events"}.`;
}

// Build the optional `prediction` metadata block from an earningsEvent (the
// shape returned by services/earnings/earningsWatchService.js:findEventBySymbol).
// Returns null when no event is provided, the verdict is INSUFFICIENT_DATA,
// or data_quality is LOW — those signals aren't trustworthy enough to surface
// in the analyzer reasoning.
//
// IMPORTANT: contributed_delta is always 0. This is METADATA only — the
// catalystScore is NOT modified by the prediction. The backtest hit-rate in
// the 60-64% confidence bucket is currently 25% (gate requires ≥55%) and
// enough_data_to_lift_cap is false, so folding the prediction into the score
// would soften REDUCE decisions on signals that are wrong ~75% of the time.
// When the predictor passes its own cap-lift gate, a follow-up PR can wire
// confidence_delta to reflect a non-zero contributed_delta.
function _buildPredictionMeta(earningsEvent) {
  if (!earningsEvent || !earningsEvent.prediction) return null;
  const p = earningsEvent.prediction;
  if (!p.verdict || p.verdict === "INSUFFICIENT_DATA") return null;
  const dq = earningsEvent?.signals?.data_quality;
  if (dq === "LOW") return null;
  return {
    verdict: p.verdict,
    confidence_pct: num(p.confidence_pct, 0),
    fiscal_quarter: earningsEvent.fiscal_quarter || null,
    days_until: num(earningsEvent.days_until, null),
    data_quality: dq || "MEDIUM",
    event_iso_date: earningsEvent.event_iso_date || null,
    score_100: num(p.score_100, null),
    contributed_delta: 0,
  };
}

// Catalyst layer entrypoint. Inputs:
//   deep   — the SWS deep snapshot (deep.overview.*, deep.news, etc.)
//   opts   — { earningsEvent } optional. The upcoming-earnings event from
//            services/earnings/earningsWatchService.js — used to surface
//            BEAT/INLINE/MISS prediction metadata for the reasoning layer.
//            Has no effect on catalystScore (see _buildPredictionMeta).
//
// Always returns a populated object — never throws. When `deep` is null
// returns { available: false, ... } so callers can short-circuit.
export function extractCatalystSignals(deep, opts = {}) {
  if (!deep) return { available: false, reason: "no deep snapshot", catalystScore: 0, confidence_delta: 0, prediction: null };

  const epsDays = _earningsDays(deep);
  const ptActions = _ptActions(deep);
  const insiderBuys = _insiderBuyCount(deep);
  const lastQtr = deep?.overview?.last_quarter_result || null;
  const ret1m = num(deep?.overview?.returns_pct?.["1M"], null);
  const ret3m = num(deep?.overview?.returns_pct?.["3M"], null);

  const pending = _buildPendingCatalysts({ epsDays, ptActions, lastQtr, insiderBuys, ret1m });
  const score = _computeCatalystScore({ epsDays, ptActions, lastQtr, insiderBuys, ret1m });
  const confidence_delta = _confidenceDelta(score);
  const prediction = _buildPredictionMeta(opts.earningsEvent);

  return {
    available: true,
    catalystScore: score,
    confidence_delta,
    next_earnings_days: epsDays,
    last_quarter_result: lastQtr,
    recent_pt_actions: ptActions,
    insider_buys_count: insiderBuys,
    momentum_1m: ret1m,
    momentum_3m: ret3m,
    pending_catalysts: pending,
    prediction,
    summary: _buildSummary({ score, pending, ptCount: ptActions.length }),
  };
}
