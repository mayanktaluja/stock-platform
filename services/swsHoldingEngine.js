// Per-holding SWS scoring + action engine.
//
// Reads data/sws/deep/{TICKER}.json (mtime-cached), runs the SWS scorer to
// derive composite + v2_score + v4_score + verdict, then maps to a portfolio
// action (EXIT / Reduction-50% / Reduction-25-33% / HOLD / Top-up-modest /
// Top-up / STRONG Top-up) using portfolio-context modifiers (position_weight,
// sector_weight, P&L %).
//
// Score driving the action engine: v4_score_100. v3 is the 50%-coverage-gated
// scorecard (74 fundamentals · 14 momentum · ±15 safety overlay) that uses
// every input we actually have data for and skips the sparse fields v1/v2
// included as zeros. Thresholds in scoreBandAction are calibrated to v3's
// distribution (universe p25≈21, p50≈29, p75≈39, p95≈59), not v1/v2's.
//
// The data shape was studied empirically against the 2026-04-28 API-pipeline
// snapshot. Notable: rewards[]/risks[] are universally empty in this snapshot,
// so narrative-phrase hard overrides are replaced with structured-data overrides
// pulled from the `fiscal` and `overview.snowflake` blocks.

import { scoreStock, num, buildCanonicalScore, buildRegulatoryFlags, buildRiskOverlay } from "./swsScoring.js";
import { reconcileFairValue } from "./fvReconciliation.js";
import * as dal from "./swsDal/index.js";
import { crosscheckHolding } from "./swsLayerCrosscheck.js";
import { extractCatalystSignals } from "./swsCatalystLayer.js";
import { extractIndianRiskSignals } from "./swsIndianRiskLayer.js";
import { findEventBySymbol } from "./earnings/earningsWatchService.js";
import { extractLastEarnings } from "./earnings/lastEarningsExtractor.js";
import { computeRecommendationV2 } from "./swsConvictionEngine.js";
import { isV1Only, isV2Primary, getRecommenderMode } from "./swsRecommenderMode.js";
import { findPeerSubstitutes } from "./swsPeerLayer.js";
import { buildFallbackHolding } from "./swsCoverageFallback.js";
import { buildAuditTrail } from "./swsAuditTrail.js";
import { promoteToLadderV2, parseTrimPct, parseTopUpPct } from "./actionLadder.js";
import { coreAddQualityFailures } from "./portfolio/addCandidateRank.js";
import { buildExitPlan } from "./exitPlan/exitPlanPolicy.js";
import { computeTimingObservation as computeTimingObservationFromModule } from "./timingObservation.js";
import { gateActionByTier, getLiquidityTier } from "./swsTierGate.js";
import { extractSwsNewsSignals } from "./swsNewsSignal.js";
import {
  buildDataQualityGate,
  buildReductionEvidence,
  buildSmallcapPolicy,
  classifyMarketCapBucket,
  gateReductionAction,
} from "./portfolioDecisionPolicy.js";

// V4-universe and per-ticker deep loads now go through services/swsDal.
// Backwards-compatible re-exports — many modules import these names; the
// underlying caching, file paths, and ticker normalisation live in the DAL
// (see services/swsDal/jsonBackend.js).
export function loadV3Universe() {
  return dal.getV4UniverseStats?.() ?? dal.getV3UniverseStats();
}

export function loadV4Universe() {
  return loadV3Universe();
}

export function loadSWSDeep(ticker) {
  return dal.getStockByTicker(ticker);
}

export function pickSnowflake(deep) {
  const sn = deep?.overview?.snowflake || {};
  return {
    valuation: num(sn.valuation ?? sn.value, 0),
    future_growth: num(sn.future_growth ?? sn.future, 0),
    past_performance: num(sn.past_performance ?? sn.past, 0),
    financial_health: num(sn.financial_health ?? sn.health, 0),
    dividends: num(sn.dividends ?? sn.dividend, 0),
    total: num(deep?.overview?.snowflake_total, 0),
  };
}

function dataFreshnessMs(deep) {
  const ts = deep?.parsed_at;
  if (!ts) return null;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  return Date.now() - t;
}

export function isSWSPriceStale(deep, thresholdHours = 24) {
  const ageMs = dataFreshnessMs(deep);
  if (ageMs == null) return true;
  return ageMs > thresholdHours * 3600 * 1000;
}

// Reconcile the SWS-scraped FV / upside_pct trio through the canonical shared
// policy. SWS is the primary FV source, so finite raw SWS FV is preserved and
// upside is computed from FV + current price whenever both are present.
// Returns { upside_pct, fair_value_inr, confidence, source, valuation_band }.
// The caller should overwrite `sws.upside_pct` and `sws.fair_value_inr` with
// these so the rest of the report sees the same reconciled view. The extra
// confidence fields are consumed only by the budget-aware construction layer:
// raw quoted upside from placeholder FV can still inform research, but it is
// not fundable capital.
export function _reconcileFVUpside(ov) {
  const r = reconcileFairValue(ov);
  return {
    upside_pct: r.upside_pct,
    fair_value_inr: r.fair_value_inr,
    confidence: r.fair_value_confidence,
    source: r.fair_value_source,
    valuation_band: r.valuation_band || "UNKNOWN",
    fv_reconcile_reason: r.fv_reconcile_reason,
    upside_source: r.upside_source,
  };
}

const NARRATIVE_RED = /declin|structurally\s*weak|promoter\s*(exit|pledge|stake)|governance|tax-loss|fraud|sebi/i;

// SEBI-RA-grade hard overrides — three new risk-management overrides
// (concentration cap, severe FV downside, multi-signal weakness) added on
// top of the existing GSM / earnings-decline / fragile-balance / narrative-
// flag rules. Each override emits a Reduction-50% legacy label; the V3
// severity model then picks the specific rung from the full factor stack —
// so a 42%-weight position lands on Red-66% via the pw>30 severity floor,
// while a 27%-weight position lands on Red-50% via the pw>25 floor.
//
// Unlike the original first-match-wins design, this version COLLECTS every
// firing override into the reasons[] array so the audit trail shows every
// independent risk signal that confirmed the call. The action label remains
// single-valued (Reduction-50% legacy or EXIT for GSM) — the V3 promoter
// reads only `action`, but a SEBI RA reading the report sees all signals.
export function evaluateHardOverrides({ scored, holding, snow, fiscal, position_weight, sector_weight, upside, v4 = null, newsSignal = null }) {
  const surveillance = buildRegulatoryFlags(scored).surveillance || null;

  // GSM surveillance is special — exits the holding entirely, not a partial
  // trim. Returns immediately with a single regulatory reason.
  if (surveillance && surveillance.list === "GSM") {
    return {
      action: "EXIT",
      reasons: [`Listed on NSE GSM surveillance (${surveillance.timeframe || "—"}) — regulatory red flag, exit per SEBI-aligned framework.`],
      evidence: [{
        type: "regulatory",
        intent: "thesis_break",
        source: "nse_surveillance",
        confidence: "high",
        summary: `NSE GSM surveillance${surveillance.timeframe ? ` (${surveillance.timeframe})` : ""}.`,
      }],
    };
  }

  const pnl = num(holding.pnlPercent, 0);
  const snowTotal = snow.total;
  const fwdGrowth = num(fiscal.earnings_growth_pct, null);
  const revenueGrowth = num(fiscal.revenue_growth_pct, null);
  const pw = num(position_weight, 0);
  const sw = num(sector_weight, 0);
  const up = Number.isFinite(upside) ? upside : null;
  const v4n = num(v4, null);

  const reasons = [];
  const evidence = [];

  // ─── Override A: single-stock concentration cap ──────────────────
  // SEBI RA risk-management observation: single-issuer concentration above
  // a threshold is a portfolio-level risk independent of the issuer's
  // fundamentals. Even a high-quality compounder at 40%+ weight is sizing
  // imprudence, not stock-selection genius. Forces partial trim — the
  // severity escalator (pw>30 → ≥0.55) then promotes to Red-66%.
  if (pw > 35) {
    reasons.push(`Position weight ${pw.toFixed(1)}% exceeds 35% concentration cap — single-name risk independent of fundamentals (SEBI RA risk-management observation).`);
    evidence.push({ type: "concentration", intent: "risk_cap", source: "portfolio_weight", confidence: "high", summary: `Position weight ${pw.toFixed(1)}% exceeds 35% cap.` });
  } else if (pw > 25) {
    reasons.push(`Position weight ${pw.toFixed(1)}% exceeds 25% concentration threshold — partial trim to restore single-name risk discipline.`);
    evidence.push({ type: "concentration", intent: "risk_cap", source: "portfolio_weight", confidence: "high", summary: `Position weight ${pw.toFixed(1)}% exceeds 25% threshold.` });
  }

  // ─── Override B: severe FV downside ──────────────────────────────
  // AnalystConsensus FV is the published-research view; material divergence
  // is a primary sell signal under SEBI RA Regulations 2014. Two rungs:
  // (1) extreme overvaluation alone is sufficient (≤−45% to FV);
  // (2) moderate overvaluation requires weak fundamentals as cross-check
  //     (≤−30% to FV AND Snowflake ≤14/30).
  if (up != null) {
    if (up <= -45) {
      reasons.push(`Trading ${Math.abs(up).toFixed(1)}% above AnalystConsensus FV — extreme overvaluation by published research consensus.`);
      evidence.push({ type: "valuation", intent: "trim_excess", source: "sws_fair_value", confidence: "high", summary: `${up.toFixed(1)}% upside to SWS FV.` });
    } else if (up <= -30 && snowTotal <= 14) {
      reasons.push(`Trading ${Math.abs(up).toFixed(1)}% above AnalystConsensus FV with weak fundamentals (Snowflake ${snowTotal}/30) — overvaluation + thin fundamental support.`);
      evidence.push({ type: "valuation", intent: "trim_excess", source: "sws_fair_value", confidence: "high", summary: `${up.toFixed(1)}% upside plus Snowflake ${snowTotal}/30.` });
    }
  }

  // ─── Override C: multi-signal weakness stack (replaces the prior narrow
  // pnl<-20+snow≤12+no-fwd-growth rule). Any 2 of 4 independent risk
  // signals firing is sufficient — each is separately observable, the
  // four are independent (a healthy compounder won't trip two), and the
  // 2-of-4 threshold is more permissive than the old 3-stacked rule
  // without sacrificing rigor.
  const signalLabels = [];
  if (snowTotal <= 12) signalLabels.push(`Snowflake ${snowTotal}/30 (weak fundamentals)`);
  if (up != null && up <= -20) signalLabels.push(`upside ${up.toFixed(1)}% to FV (overvalued)`);
  if (pnl < -15) signalLabels.push(`drawdown ${pnl.toFixed(1)}% (material loss)`);
  if (sw > 30) signalLabels.push(`sector weight ${sw.toFixed(1)}% (sector overweight)`);
  if (signalLabels.length >= 2) {
    reasons.push(`Multi-signal weakness — ${signalLabels.length} of 4 risk signals firing: ${signalLabels.join("; ")}.`);
    evidence.push({ type: "multi_signal", intent: "thesis_break", source: "sws_factor_stack", confidence: "high", summary: `${signalLabels.length} of 4 risk signals firing.` });
  }

  // ─── Earnings-declining override ─────────────────────────────────
  // Earnings decline alone is an attention signal, not a decision-grade trim.
  // It must be confirmed by a separate deterioration signal so discounted /
  // high-v4 names do not become reductions off one stale fiscal field.
  if (fwdGrowth != null && fwdGrowth < -10) {
    const confirmations = [];
    if (revenueGrowth != null && revenueGrowth < 0) confirmations.push(`revenue growth ${revenueGrowth.toFixed(1)}%`);
    if (snow.financial_health <= 2) confirmations.push(`Health ${snow.financial_health}/6`);
    if (v4n != null && v4n < 47) confirmations.push(`v4 ${v4n.toFixed(1)}`);
    if (newsSignal?.signal < 0 && newsSignal?.materialDisclosure) confirmations.push("material negative SWS news");
    const lastQ = String(scored.overview?.last_quarter_result || "");
    if (/\b(miss|declin|fall|lower|weak|loss)\b/i.test(lastQ)) confirmations.push("weak latest result");
    if (confirmations.length > 0) {
      reasons.push(`Earnings declining ${fwdGrowth.toFixed(1)}% YoY with confirmation (${confirmations.join(", ")}) — thesis deterioration review.`);
      evidence.push({ type: "earnings_decline", intent: "thesis_break", source: "sws_fiscal", confidence: confirmations.length >= 2 ? "high" : "medium", summary: `Earnings ${fwdGrowth.toFixed(1)}% YoY; ${confirmations.join(", ")}.` });
    }
  }

  // ─── Existing fragile-balance + extreme-PE override (preserved) ──
  if (snow.financial_health <= 1 && (scored.overview?.multiples?.pe ?? 0) > 100) {
    reasons.push(`Fragile balance sheet (Health ${snow.financial_health}/6) at extreme valuation (P/E ${scored.overview?.multiples?.pe?.toFixed?.(1) ?? "—"}x).`);
    evidence.push({ type: "balance_sheet", intent: "thesis_break", source: "sws_snowflake", confidence: "high", summary: `Health ${snow.financial_health}/6 at extreme P/E.` });
  }

  // ─── Existing narrative-red override (preserved) ─────────────────
  // Rarely fires on current API-pipeline snapshots (rewards/risks empty)
  // but covered for older snapshots and any future re-population.
  const risksList = scored.overview?.risks || [];
  for (const r of risksList) {
    if (NARRATIVE_RED.test(String(r))) {
      reasons.push(`SWS narrative flag: "${String(r).slice(0, 120)}".`);
      evidence.push({ type: "narrative_red", intent: "thesis_break", source: "sws_risks", confidence: "medium", summary: String(r).slice(0, 120) });
      break;
    }
  }

  if (reasons.length === 0) return null;
  // All firing overrides emit Reduction-50% legacy. The V3 severity model
  // then picks the specific rung — Red-66% for pw>30 via the severity
  // escalator, Red-50% otherwise.
  return { action: "Reduction-50%", reasons, evidence };
}

// v3 score thresholds — calibrated to the v3 universe distribution
// (p25≈21, p50≈29, p75≈39, p95≈59; max≈86). Each tier targets a
// realistic share of the universe so the action engine fires usefully:
//   <14 EXIT  (~bottom 8%)
//   <22 Reduction-50% legacy (~bottom 25%) — lets severity scale to 25/33/50/66
//   <30 Reduction-25-33% legacy (~bottom 50%) — NEW band, was HOLD
//   <40 HOLD  (~middle 25%)
//   <55 Top-up tier  (~top 25%, sub-tiers by portfolio context)
//   ≥55 STRONG Top-up tier  (~top 7%)
//
// AGGRESSIVE-TRIM RECALIBRATION (PR for #126 follow-up): widened the trim
// band so a real retail book actually surfaces Reduction signals. Pre-change:
// only stocks with v3<22 entered the trim path, and only those with
// position_weight>10% started at Reduction-50% legacy — too narrow to fire
// on a typical curated book where most positions are 2-6% weight.
//
// Three things changed here:
//   • Reduction-50% legacy now fires uniformly for v3<22 (drop the pw split;
//     the V3 severity model picks the specific rung from the full factor
//     stack, no need for a position-weight pre-filter on the legacy label).
//   • A new Reduction-25-33% band at v3<30 — the v3 22-30 range used to be
//     HOLD-by-default regardless of P&L or sector concentration. Now severity
//     decides whether it's a soft 25% trim, a 33%, or HOLD-after-severity
//     when the factor stack adds up below the trim floor.
//   • HOLD band shifts to v3 30-40 (was 22-40). Top-up bands unchanged.
function scoreBandAction({ v4, snow, upside, position_weight, sector_weight, risks_count }) {
  // scoreBandAction always emits LEGACY labels. The ladder-v2 promotion
  // runs as a post-stage on the FINAL action (after the conviction
  // engine + position guardrails), in scoreHolding below.
  //
  // V4 RECALIBRATION (2026-05): V4 scores run lower than V3 (median ~37 vs
  // higher), so the old absolute cutoffs (14/22/30/40/50/65) are remapped onto
  // V4's distribution via its verdict bands (AVOID<28 · WATCH 28-37 ·
  // ACCEPTABLE 37-47 · STRONG 47-59 · TOP_PICK≥59). EXIT stays the deep-AVOID
  // floor (~bottom 10%) so trims don't balloon under the lower distribution.
  if (v4 < 18) return { action: "EXIT", band: "AVOID" };

  // Deep AVOID (rest of the bottom quartile) → Reduction-50%; severity → rung
  // picks the realised label (concentration baked in).
  if (v4 < 28) return { action: "Reduction-50%", band: "WATCH" };

  // WATCH band (28-37) → Reduction-25-33%; below the 0.10 severity floor it
  // falls through to HOLD via the promoter's null path.
  if (v4 < 37) return { action: "Reduction-25-33%", band: "WATCH-MILD" };

  // ACCEPTABLE band (37-47) → HOLD.
  if (v4 < 47) return { action: "HOLD", band: "ACCEPTABLE" };

  // PR 2.4 — every Top-up rung requires positive upside-to-AnalystFV; when a
  // rung's upside floor isn't met we fall through to HOLD — never push capital
  // into a position at/above estimated fair value.
  // Low STRONG band (47-53) → Top-up-modest.
  if (v4 < 53) {
    if (position_weight <= 8 && sector_weight <= 25 && upside >= 5) {
      return { action: "Top-up-modest", band: "ACCEPTABLE-PLUS" };
    }
    return { action: "HOLD", band: "ACCEPTABLE-PLUS" };
  }

  // High STRONG band (53-59) → Top-up.
  if (v4 < 59) {
    if (upside >= 15 && risks_count === 0 && position_weight <= 6) {
      return { action: "Top-up", band: "STRONG" };
    }
    if (position_weight <= 8 && sector_weight <= 25 && upside >= 5) {
      return { action: "Top-up-modest", band: "STRONG" };
    }
    return { action: "HOLD", band: "STRONG" };
  }

  // TOP_PICK band (≥59) — STRONG Top-up only on a clear discount.
  if (position_weight <= 5 && sector_weight <= 20 && upside >= 15) {
    return { action: "STRONG Top-up", band: "TOP_PICK" };
  }
  if (upside >= 5) {
    return { action: "Top-up-modest", band: "TOP_PICK" };
  }
  return { action: "HOLD", band: "TOP_PICK" };
}

function buildSWSReasons({ scored, snow, fiscal, action, band, reconciled }) {
  const ov = scored.overview || {};
  const reasons = [];
  // Use the reconciled upside/FV so the user-facing reason matches what the
  // KPI cards and basket rows show — the raw `ov.upside_pct` can carry junk
  // values from the upstream scraper (see _reconcileFVUpside).
  const upside = reconciled?.upside_pct ?? null;
  const fvPrice = reconciled?.fair_value_inr ?? null;
  const curPrice = num(ov.current_price_inr, null);
  const pe = ov.multiples?.pe;
  const fwd = num(fiscal.earnings_growth_pct, null);
  const margin = num(fiscal.net_margin_pct ?? ov.net_margin_pct, null);
  const ret1y = num((ov.returns_pct || {})["1Y"], null);

  reasons.push(`Snowflake ${snow.total}/30 (val ${snow.valuation}, future ${snow.future_growth}, past ${snow.past_performance}, health ${snow.financial_health}, div ${snow.dividends}).`);
  // Only emit the (₹FV vs ₹price) suffix when:
  //   • both prices are present, AND
  //   • the rounded prices actually differ — when the scraper sets FV = price
  //     but the upside is a non-zero analyst-consensus figure (LODHA/HAL),
  //     the suffix would render "(₹841 vs ₹841)" alongside "+32%" which
  //     reads as broken arithmetic. Bare form is the honest fallback.
  const sameRoundedPrice = fvPrice != null && curPrice != null
    && Math.round(fvPrice) === Math.round(curPrice);
  if (upside != null && fvPrice != null && curPrice != null && !sameRoundedPrice) {
    reasons.push(`${upside >= 0 ? "+" : ""}${upside.toFixed(1)}% to AnalystConsensus FV (₹${fvPrice.toFixed(0)} vs ₹${curPrice.toFixed(0)}).`);
  } else if (upside != null) {
    reasons.push(`${upside >= 0 ? "+" : ""}${upside.toFixed(1)}% to AnalystConsensus FV.`);
  }
  if (pe != null) reasons.push(`P/E ${pe.toFixed(1)}x.`);
  if (fwd != null) reasons.push(`Earnings growth ${fwd.toFixed(1)}% YoY.`);
  if (margin != null) reasons.push(`Net margin ${margin.toFixed(1)}%.`);
  if (ret1y != null) reasons.push(`1Y return ${ret1y >= 0 ? "+" : ""}${ret1y.toFixed(1)}%.`);
  const surveillance = buildRegulatoryFlags(scored).surveillance;
  if (surveillance) {
    const s = surveillance;
    reasons.push(`NSE ${s.list}${s.timeframe ? ` (${s.timeframe})` : ""} surveillance.`);
  }

  return reasons;
}

// Classify an action label as bullish / bearish / neutral. Mirrors the
// helpers in swsConvictionEngine but kept local — we only need a 3-way
// classification here, not the full ladder math. Exported for unit tests
// (test/swsHoldingEngine.predictionReasoning.test.mjs).
export function _actionDirection(action) {
  if (!action) return "neutral";
  if (action === "HOLD") return "neutral";
  if (action === "EXIT") return "bearish";
  if (action.startsWith("EXIT-")) return "bearish";
  if (action.startsWith("Reduction")) return "bearish";
  if (action.startsWith("Top-up") || action === "STRONG Top-up") return "bullish";
  return "neutral";
}

// Build a single reasoning bullet that surfaces the upcoming earnings
// prediction alongside the analyzer's action. Returns null when the
// prediction metadata isn't actionable (missing, out-of-window, etc.).
//
// Why this exists: the earnings predictor doesn't pass its own cap-lift gate
// yet (60-64% confidence bucket hit-rate is 25%) so we deliberately don't
// let it CHANGE the action. But the user sees both views in the UI — the
// analyzer's REDUCE and the modal's BEAT — and the silence between them
// reads as a self-contradiction. This bullet makes the relationship
// explicit: concurring / conflicting / neutral, with the actual numbers.
//
// Exported for unit tests (test/swsHoldingEngine.predictionReasoning.test.mjs).
export function _buildPredictionReasoningBullet(action, prediction) {
  if (!prediction || !prediction.verdict) return null;
  const days = prediction.days_until;
  if (days == null || days < 0 || days > 14) return null;
  const verdict = prediction.verdict;
  const conf = Math.round(num(prediction.confidence_pct, 0));
  const fq = prediction.fiscal_quarter || "next Q-result";
  const dq = prediction.data_quality || "MEDIUM";
  const dayLabel = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days}d`;

  if (verdict === "INLINE") {
    return `${fq} predicted INLINE ${dayLabel} (${conf}% conf, ${dq} quality) — no directional read; act on the existing thesis.`;
  }

  const dir = _actionDirection(action);

  // Confirming (analyzer and predictor agree on direction)
  if ((verdict === "BEAT" && dir === "bullish") || (verdict === "MISS" && dir === "bearish")) {
    const tailwind = verdict === "BEAT" ? "Tailwind" : "Headwind";
    return `${tailwind}: ${fq} predicted ${verdict} ${dayLabel} (${conf}% conf, ${dq} quality) — supports the current view.`;
  }

  // Conflicting (analyzer recommends one direction, predictor the other)
  if ((verdict === "BEAT" && dir === "bearish") || (verdict === "MISS" && dir === "bullish")) {
    const direction = dir === "bearish" ? "reduction" : "top-up";
    return `Note: ${fq} predicted ${verdict} ${dayLabel} (${conf}% conf, ${dq} quality) — conflicts with the ${direction}. Predictor is in calibration; re-evaluate post-result.`;
  }

  // Neutral analyzer action (HOLD) with a directional forecast
  if (dir === "neutral") {
    const tilt = verdict === "BEAT" ? "upside tilt" : "downside tilt";
    return `Watch: ${fq} predicted ${verdict} ${dayLabel} (${conf}% conf, ${dq} quality) — ${tilt} into the print.`;
  }

  return null;
}

export function valuationReviewBucket(upside, confidence = "NONE") {
  if (confidence !== "HIGH" || !Number.isFinite(upside)) return "unknown";
  if (upside >= 10) return "discounted";
  if (upside >= -5) return "near_fv";
  return "materially_above_fv";
}

function actionIsReduction(action) {
  return String(action || "").startsWith("Reduction") || String(action || "").startsWith("EXIT");
}

function actionIsTopUp(action) {
  return String(action || "").startsWith("Top-up") || action === "STRONG Top-up";
}

// Badge-time wording for the shared core add-quality gate codes
// (services/portfolio/addCandidateRank.js — one threshold source shared with
// the construction plan's funding gate and the measurement script).
const RAW_ADD_GATE_WORDING = {
  v4_below_floor: "V4 score below 53 add-candidate floor",
  confidence_not_high: "fair-value confidence is not HIGH",
  band_not_discount: "valuation is not discounted or deep-discounted",
  upside_below_floor: "FV upside below 12% add-candidate floor",
};

export function _buildRawAddGate({
  action,
  v4 = null,
  reconciled = null,
  newsSignal = null,
  dataQualityGate = null,
  surveillance = null,
} = {}) {
  if (!actionIsTopUp(action)) return { allowed: true, reasons: [] };
  const reasons = [];
  const dataStatus = dataQualityGate?.status || "ok";

  for (const code of coreAddQualityFailures({
    v4_score: v4,
    valuation_confidence: reconciled?.confidence || "NONE",
    valuation_band: reconciled?.valuation_band || "UNKNOWN",
    upside_pct: reconciled?.upside_pct,
  })) {
    reasons.push(RAW_ADD_GATE_WORDING[code]);
  }
  if (newsSignal?.signal < 0) {
    reasons.push(newsSignal?.materialDisclosure
      ? "material negative SWS news blocks adding exposure"
      : "negative SWS news blocks adding exposure");
  }
  if (dataStatus !== "ok") {
    reasons.push(...(Array.isArray(dataQualityGate?.blockedReasons) && dataQualityGate.blockedReasons.length
      ? dataQualityGate.blockedReasons
      : [`data quality gate is ${dataStatus}`]));
  }
  if (surveillance?.list) reasons.push(`${surveillance.list} surveillance blocks adding exposure`);

  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons.filter(Boolean))],
  };
}

export function _buildDecisionMetadata({
  action,
  legacyAction,
  valuationReview,
  reductionEvidence,
  newsSignal,
  blockedReasons = [],
  trimFrac = 0,
  topUpFrac = 0,
  position_weight = 0,
  currentValue = 0,
  reasonFamily = null,
} = {}) {
  const isReduction = actionIsReduction(action);
  const isTopUp = actionIsTopUp(action);
  const postTradeWeight = trimFrac > 0
    ? +Math.max(0, position_weight * (1 - trimFrac)).toFixed(1)
    : topUpFrac > 0
      ? +Math.max(0, position_weight * (1 + topUpFrac)).toFixed(1)
      : +num(position_weight, 0).toFixed(1);
  let displayActionIntent = "Do nothing";
  if (String(action || "").startsWith("EXIT")) {
    displayActionIntent = "Exit thesis";
  } else if (isReduction) {
    displayActionIntent = trimFrac >= 0.45 ? "Cut risk" : "Trim excess";
  } else if (isTopUp) {
    displayActionIntent = "Add candidate";
  } else if (reductionEvidence?.status && reductionEvidence.status !== "confirmed") {
    displayActionIntent = "Review only";
  } else if (valuationReview?.reviewCandidate || blockedReasons.length) {
    displayActionIntent = "Review only";
  }

  const family = reasonFamily
    || (String(action || "").startsWith("EXIT")
      ? "thesis_break"
      : isReduction
        ? reductionEvidence?.intent || (valuationReview?.reviewCandidate ? "valuation_review" : "risk_reduction")
        : isTopUp
          ? "add_candidate"
          : reductionEvidence?.status && reductionEvidence.status !== "confirmed"
            ? reductionEvidence.intent || "data_quality"
          : valuationReview?.reviewCandidate
            ? "valuation_review"
            : "do_nothing");

  const actionFactors = [];
  if (valuationReview?.reviewCandidate) actionFactors.push("valuation_review");
  if (reductionEvidence?.status) actionFactors.push(`reduction_${reductionEvidence.status}`);
  if (newsSignal?.signal < 0) actionFactors.push("news_veto");
  if (newsSignal?.signal > 0) actionFactors.push("positive_news_context");
  if (trimFrac > 0) actionFactors.push("reduction_sizing");
  if (topUpFrac > 0) actionFactors.push("topup_sizing");
  if (blockedReasons.length) actionFactors.push("blocked_or_provisional");

  return {
    displayActionIntent,
    reasonFamily: family,
    actionFactors,
    blockedReasons,
    postTradeWeight,
    requiresConfirmation: reductionEvidence?.requiresConfirmation ?? (isReduction || isTopUp || Boolean(legacyAction && legacyAction !== action)),
    notionalTradeValue: trimFrac > 0 ? Math.round(num(currentValue, 0) * trimFrac) : null,
  };
}

function buildValuationReview({
  reconciled,
  v4,
  snow,
  position_weight,
  sector_weight,
  pnlPercent,
  newsSignal,
} = {}) {
  const upside = Number.isFinite(reconciled?.upside_pct) ? reconciled.upside_pct : null;
  const bucket = valuationReviewBucket(upside, reconciled?.confidence);
  const highQualityWinner = num(v4, 0) >= 59 || num(snow?.total, 0) >= 18;
  const reviewCandidate = highQualityWinner && (bucket === "near_fv" || bucket === "materially_above_fv");
  const hardPortfolioReasons = [];
  if (num(position_weight, 0) >= 8) hardPortfolioReasons.push("position size");
  if (num(sector_weight, 0) >= 25) hardPortfolioReasons.push("sector pressure");
  if (num(pnlPercent, 0) >= 35) hardPortfolioReasons.push("profit cushion");
  if (bucket === "materially_above_fv" && upside != null && upside <= -20) hardPortfolioReasons.push("FV downside");
  if (newsSignal?.signal < 0 && newsSignal?.materialDisclosure) hardPortfolioReasons.push("material negative news");

  return {
    bucket,
    upside_pct: upside,
    fair_value_inr: reconciled?.fair_value_inr ?? null,
    confidence: reconciled?.confidence || "NONE",
    source: reconciled?.source || null,
    reconcile_reason: reconciled?.fv_reconcile_reason || null,
    reviewCandidate,
    hardPortfolioReasons,
    recommendation: reviewCandidate
      ? hardPortfolioReasons.length
        ? "rebalance_candidate"
        : "review_only"
      : "not_applicable",
    rationale: reviewCandidate
      ? hardPortfolioReasons.length
        ? `Near/above SWS fair value with portfolio trigger: ${hardPortfolioReasons.join(", ")}.`
        : "Near SWS fair value, but no hard portfolio trigger for a reduction."
      : bucket === "discounted"
        ? "SWS fair value still leaves material upside."
        : "Fair-value signal is not strong enough for a valuation review.",
  };
}

/**
 * Backward-compatibility shim. The real timing logic moved to
 * services/timingObservation.js as part of PR-3 (richer inputs:
 * NSE market state from IST clock, macro-regime severity, sector
 * impact). Existing callers still hit this name; new callers use
 * computeTimingObservationFromModule directly.
 *
 * As of May 2026 the shim also forwards predictionVerdict /
 * predictionConfidence / predictionQuality so the timing chip's reason
 * surfaces the upcoming-earnings prediction in every market state — see
 * services/timingObservation.js for the bug fix this enables (market-closed
 * branches previously hid the earnings warning).
 */
export function computeTimingObservation({ deep, scored, action, livePrice, now, marketState, regimeSeverity, sectorImpact, predictionVerdict, predictionConfidence, predictionQuality } = {}) {
  return computeTimingObservationFromModule({
    action,
    scored,
    now: now instanceof Date ? now : new Date(),
    marketState,
    regimeSeverity,
    sectorImpact,
    predictionVerdict,
    predictionConfidence,
    predictionQuality,
  });
}

export function scoreHolding(holding, portfolioContext = {}) {
  const ticker = holding?.symbol || holding?.ticker;
  const deep = loadSWSDeep(ticker);
  if (!deep) {
    // Coverage fallback — synthesise a low-confidence verdict from
    // fundamentals.json (yfinance/NSE snapshot) when SWS doesn't have
    // the ticker. Returns null when fundamentals.json also has no
    // snapshot, in which case we fall through to the original
    // "no opinion" stub.
    if (!isV1Only()) {
      const fb = buildFallbackHolding({ ticker, name: holding?.name, sector: holding?.sector, holding });
      if (fb) return fb;
    }
    return {
      ...holding,
      swsCovered: false,
      action: null,
      reasons: ["No SWS data — likely demerger, freshly delisted, or out of NSE universe."],
      timing: null,
    };
  }

  const universe = loadV3Universe();
  const scored = scoreStock(deep, { universe });
  const snow = pickSnowflake(scored);
  const fiscal = scored.fiscal || {};
  const ov = scored.overview || {};
  const lastEarnings = extractLastEarnings({
    deep,
    fundamentalsHistory: portfolioContext?.fundamentalsHistory || null,
    ticker: scored.ticker || ticker,
  });
  // Reconcile FV / upside_pct once — every downstream consumer (action
  // mapping, reasons, basket classifier) reads the same clean numbers.
  const reconciled = _reconcileFVUpside(ov);
  const nowForSignals = portfolioContext.now instanceof Date ? portfolioContext.now : new Date();
  const newsSignal = extractSwsNewsSignals(scored.news || deep.news || [], { now: nowForSignals });

  const position_weight = num(holding.positionWeight, 0);
  const sector_weight = num(portfolioContext.sectorWeights?.[scored.sector] ?? holding.sectorWeight, 0);
  const upside = num(reconciled.upside_pct, 0);
  const risks_count = scored.v2_breakdown?.risks_count ?? (ov.risks?.length || 0);
  const valuationReview = buildValuationReview({
    reconciled,
    v4: num(scored.v4_score_100, 0),
    snow,
    position_weight,
    sector_weight,
    pnlPercent: num(holding.pnlPercent, 0),
    newsSignal,
  });
  const marketCapBucket = classifyMarketCapBucket(ov.market_cap_inr);
  const smallcapPolicy = buildSmallcapPolicy({
    marketCapInr: ov.market_cap_inr,
    marketCapBucket,
    positionWeight: position_weight,
  });

  const regulatoryFlags = buildRegulatoryFlags(scored);
  const riskOverlay = buildRiskOverlay(scored);
  const surveillance = regulatoryFlags.surveillance || null;

  // Look up the upcoming-earnings event for this ticker. Passed into the
  // catalyst layer (for the prediction metadata block) AND used directly
  // below to append a reasoning bullet that cross-references the predictor.
  // When portfolioContext doesn't carry a snapshot (legacy callers, stale
  // data, missing file), this is null and downstream logic skips.
  const _tickerForLookup = scored.ticker || holding?.symbol || holding?.ticker;
  const earningsEvent = portfolioContext.earningsSnapshot
    ? findEventBySymbol(portfolioContext.earningsSnapshot, _tickerForLookup)
    : null;
  // Distilled prediction metadata — shared by the reasoning bullet (below)
  // and the timing observer (which uses it to enrich the timing chip's
  // reason string + emit an earnings_alert badge). Same suppression rules
  // as services/swsCatalystLayer.js:_buildPredictionMeta so we don't surface
  // INSUFFICIENT_DATA / LOW-quality predictions anywhere.
  const _predictionMeta = (() => {
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
    };
  })();

  const hard = evaluateHardOverrides({
    scored, holding, snow, fiscal,
    position_weight, sector_weight, upside,
    v4: num(scored.v4_score_100, null),
    newsSignal,
  });
  let action, band, reasons;
  if (hard) {
    action = hard.action;
    band = "HARD_OVERRIDE";
    reasons = hard.reasons;
  } else {
    const sb = scoreBandAction({
      v4: num(scored.v4_score_100, 0),
      snow,
      upside,
      position_weight,
      sector_weight,
      risks_count,
    });
    action = sb.action;
    band = sb.band;
    reasons = buildSWSReasons({ scored, snow, fiscal, action, band, reconciled });
  }

  const blockedReasons = [];
  let decisionReasonFamily = null;
  if (valuationReview.reviewCandidate && valuationReview.recommendation === "review_only") {
    blockedReasons.push("near SWS fair value but no hard portfolio trigger; review only");
  }
  if (!hard && action === "HOLD" && valuationReview.recommendation === "rebalance_candidate") {
    action = "Reduction-25-33%";
    band = "VALUATION_REVIEW";
    decisionReasonFamily = "valuation_review";
    reasons = [
      `${valuationReview.rationale} Treat as trim-excess review, not a thesis exit.`,
      ...reasons,
    ];
  }
  if (actionIsTopUp(action) && newsSignal.signal < 0) {
    blockedReasons.push(...(newsSignal.blockedReasons || []));
    action = "HOLD";
    band = `${band}-NEWS-VETO`;
    decisionReasonFamily = "news_veto";
    reasons = [
      "SWS news signal is adverse; add candidate blocked pending manual review.",
      ...reasons,
    ];
  } else if (newsSignal.signal < 0 && actionIsReduction(action)) {
    reasons = [
      "SWS news is adverse and confirms an independently-supported reduction review.",
      ...reasons,
    ];
  }

  const dataAgeHoursPre = dataFreshnessMs(scored) != null ? Math.round(dataFreshnessMs(scored) / 3600000) : null;
  const staleDataPre = Number.isFinite(dataAgeHoursPre) && dataAgeHoursPre > 36;
  const dataQualityGate = buildDataQualityGate({
    swsCovered: true,
    fallback: false,
    staleData: staleDataPre,
    dataAgeHours: dataAgeHoursPre,
    snowflakeDataQuality: ov.snowflake_data_quality || null,
    marketCapBucket,
    valuationConfidence: reconciled.confidence,
  });
  const reductionEvidence = buildReductionEvidence({
    action,
    legacyAction: action,
    band,
    hard,
    valuationReview,
    newsSignal,
    dataQualityGate,
    marketCapBucket,
    smallcapPolicy,
    positionWeight: position_weight,
    sectorWeight: sector_weight,
    v4: num(scored.v4_score_100, null),
    reconciled,
  });
  const gatedReduction = gateReductionAction({ action, band, reasons, reductionEvidence });
  if (gatedReduction.action !== action) {
    blockedReasons.push(...(reductionEvidence.blockedReasons || []));
    action = gatedReduction.action;
    band = gatedReduction.band;
    reasons = gatedReduction.reasons;
    decisionReasonFamily = reductionEvidence.intent || "data_quality";
  }

  // Append the upcoming-earnings prediction bullet to whichever reasons set
  // we landed on (hard-override OR scoreBand). This is the cross-reference
  // the user explicitly asked for: when the analyzer says REDUCE and the
  // earnings modal says BEAT, the analyzer's reasoning will name the
  // conflict instead of leaving the user to spot it themselves.
  if (_predictionMeta) {
    const predictionBullet = _buildPredictionReasoningBullet(action, _predictionMeta);
    if (predictionBullet) reasons = [...reasons, predictionBullet];
  }

  // Pass regime severity + sector impact from portfolioContext when the
  // server provides them (analyzer route does — computed once per
  // request from the macro-regime layer). When missing, the timing
  // module degrades gracefully — momentum + earnings + market-state
  // signals remain.
  //
  // Prediction fields are passed through so the timing observer can append
  // a "Q-result in Xd predicted BEAT" suffix to its reason and attach an
  // earnings_alert badge — including in the market-closed branches that
  // previously hid this signal from the user (see services/timingObservation.js
  // for the bug-fix details).
  const timing = computeTimingObservation({
    deep: scored,
    scored,
    action,
    now: portfolioContext.now instanceof Date ? portfolioContext.now : undefined,
    marketState: portfolioContext.marketState,
    regimeSeverity: num(portfolioContext.regimeSeverity, 0),
    sectorImpact: num(portfolioContext.sectorImpactBySector?.[scored.sector], 0),
    predictionVerdict: _predictionMeta?.verdict || null,
    predictionConfidence: _predictionMeta?.confidence_pct ?? null,
    predictionQuality: _predictionMeta?.data_quality || null,
  });

  // Layer-2 independent-fundamentals cross-check — shadow attach only.
  // The conviction engine (PR 3) will read crosscheck.confidence_delta to
  // bias the action band. Today we just expose the data so the divergence
  // smoke test (scripts/smoke-sws-crosscheck.mjs) and a future UI can read
  // it. Never throws — returns { available: false } when fundamentals.json
  // has no snapshot for this ticker.
  const crosscheck = crosscheckHolding({
    ticker: scored.ticker || holding?.symbol || holding?.ticker,
    swsSnowflake: snow,
    swsV4Score: num(scored.v4_score_100, null),
  });

  // Layer-3 (Indian-specific risk) and Layer-4 (catalyst) shadow attaches.
  // The catalyst layer now receives the upcoming-earnings event so it can
  // surface a `prediction` metadata block on the result. The catalystScore
  // itself is unchanged — see _buildPredictionMeta in swsCatalystLayer.js
  // for why we don't fold the prediction into the score yet.
  const catalyst = extractCatalystSignals(scored, { earningsEvent });
  const indianRisk = extractIndianRiskSignals({
    ticker: scored.ticker || holding?.symbol || holding?.ticker,
    deep: scored,
  });

  // v2 conviction engine — gated by RECOMMENDER_VERSION env var. Default
  // is `v2-shadow` (compute v2 alongside v1, attach as
  // sws.v2_recommendation, leave UI on v1). `v2-primary` makes v2 the
  // authoritative `action`; `v1` skips computation entirely.
  let v2recommendation = null;
  if (!isV1Only()) {
    try {
      v2recommendation = computeRecommendationV2({
        sws_action: action,
        sws_v4: num(scored.v4_score_100, null),
        sws_verdict: scored.v4_verdict,
        crosscheck,
        catalyst,
        indianRisk,
        position_ctx: {
          positionWeight: num(holding.positionWeight, 0),
          sectorWeight: num(portfolioContext.sectorWeights?.[scored.sector] ?? holding.sectorWeight, 0),
          pnlPercent: num(holding.pnlPercent, 0),
          // Pass the scored snowflake total so the position guardrail can
          // require structural weakness alongside drawdown before forcing EXIT
          // (PR 2.1 — replaces the unconditional pnl<-40 → EXIT rule).
          snowflake_total: snow?.total ?? null,
        },
        fiscal,
      });
    } catch (err) {
      console.warn(`[swsConvictionEngine] ${scored.ticker} failed: ${err.message}`);
    }
  }

  // v2-primary: replace top-level action + reasons with v2 output.
  // v2-shadow (default): keep v1 as authoritative; v2 lives in
  // sws.v2_recommendation for divergence monitoring + UI opt-in.
  let finalAction = action;
  let finalReasons = reasons;
  if (isV2Primary() && v2recommendation) {
    finalAction = v2recommendation.action;
    finalReasons = v2recommendation.narrative_paragraphs;
  }
  if (actionIsReduction(finalAction) && reductionEvidence.status !== "confirmed") {
    finalAction = "HOLD";
    finalReasons = [
      "Review only: reduction evidence is not decision-grade; no ladder sizing applied.",
      ...finalReasons,
    ];
  }
  const rawAddGate = _buildRawAddGate({
    action: finalAction,
    v4: num(scored.v4_score_100, null),
    reconciled,
    newsSignal,
    dataQualityGate,
    surveillance,
  });
  if (actionIsTopUp(finalAction) && !rawAddGate.allowed) {
    blockedReasons.push(...rawAddGate.reasons);
    finalAction = "HOLD";
    decisionReasonFamily = "add_gate";
    finalReasons = [
      `Add candidate blocked: ${rawAddGate.reasons[0] || "did not clear the high-confidence add gate"}.`,
      ...finalReasons,
    ];
  }

  // ─── Ladder-v2 final-stage promotion ─────────────────────────────
  // SWS_LADDER_V2=1 promotes the legacy action label to a granular
  // rung based on the full factor stack — conviction proxy (which now
  // includes the v2 layer-vote signal indirectly via surveillance/risks),
  // position weight, sector weight, upside, P&L drawdown. When the flag
  // is off, promoteToLadderV2 returns the input unchanged. The legacy
  // label is preserved on the output for consumers that don't read v2
  // labels yet.
  //
  // V4 (SWS_LADDER_V4=1) consumes the additional optional inputs below
  // — pillars, daysHeld, 52W high/low, currentPrice, currentValue,
  // lastAction. When V4 is off, these inputs are silently ignored. We
  // pass them unconditionally so flipping the flag is a one-line change.
  // currentValue is hoisted before the call so the V4 floor gate sees
  // the same number used for trim/topUp ₹ rendering below.
  const _currentValue = num(holding.currentValue ?? (ov.current_price_inr * holding.quantity), 0);
  const _currentPrice = num(holding.currentPrice ?? ov.current_price_inr, null);
  const _purchaseAt = holding.purchaseDate ? Date.parse(holding.purchaseDate) : NaN;
  const _daysHeld = Number.isFinite(_purchaseAt)
    ? Math.max(0, Math.floor((Date.now() - _purchaseAt) / (24 * 3600 * 1000)))
    : null;
  const promotion = promoteToLadderV2({
    legacyAction: finalAction,
    v4: num(scored.v4_score_100, 0),
    snow_total: snow?.total ?? 0,
    position_weight,
    sector_weight,
    upside,
    risks_count,
    surveillance,
    pnlPercent: num(holding.pnlPercent, 0),
    // V4 inputs (silently ignored when SWS_LADDER_V4 is off)
    pillars: snow,
    daysHeld: _daysHeld,
    fiftyTwoWeekHigh: num(holding.fiftyTwoWeekHigh, null),
    fiftyTwoWeekLow:  num(holding.fiftyTwoWeekLow, null),
    currentPrice:     _currentPrice,
    currentValue:     _currentValue > 0 ? _currentValue : null,
    materialDisclosure: actionIsReduction(finalAction) && newsSignal.materialDisclosure,
  });
  // Liquidity-tier gate — runs AFTER ladder promotion so it sees the final
  // rung label (Top-up-25%, STRONG Top-up, etc.). Suppresses every buy-side
  // action when the stock sits on a restricted BSE group (Z surveillance,
  // T trade-to-trade, X/XT low-liquidity, M/MS/MT SME, P/R/IP transient).
  // No-op for NSE main-board, BSE A/B (high/medium liquidity), and stocks
  // we can't classify (unknown) — preserves existing behaviour.
  const _tierGated = gateActionByTier(
    promotion.action,
    getLiquidityTier(scored.ticker || holding?.symbol || holding?.ticker)
  );
  const promotedAction = _tierGated.action;
  const ladderRationale = _tierGated.downgraded
    ? [_tierGated.reason, ...(promotion.ladderRationale || [])]
    : promotion.ladderRationale;
  const ladderV2 = promotion.ladderV2;
  const convictionProxy = promotion.conviction;
  const legacyAction = promotion.legacyAction;
  // V3 surface: severity score (0..1) + per-component contribution. Null
  // when V3 path didn't fire (V2 categorical or legacy passthrough).
  const ladderSeverity = Number.isFinite(promotion.severity) ? promotion.severity : null;
  const ladderSeverityComponents = promotion.severityComponents || null;
  // Per-rung ₹ realised — current value × trim/topup fraction. Lets the UI
  // show "Reduction-33% · ₹12,400 freed" inline next to the action badge.
  // Null on HOLD or when current value is missing. Re-uses _currentValue
  // computed above for the V4 position-floor gate.
  const trimFrac = parseTrimPct(promotedAction);
  const topUpFrac = parseTopUpPct(promotedAction);
  const trimRupees = trimFrac > 0 && _currentValue > 0 ? Math.round(_currentValue * trimFrac) : null;
  const topUpRupees = topUpFrac > 0 && _currentValue > 0 ? Math.round(_currentValue * topUpFrac) : null;

  // When the ladder fires, prepend its rationale to the engine's reasons
  // so the UI can show the ladder logic (one bullet per step) ahead of
  // the SWS engine's standard reason set.
  if (ladderRationale && ladderRationale.length) {
    finalReasons = [...ladderRationale, ...finalReasons];
  }

  // Stale-data tag — SWS refreshes daily, so anything > 36h old gets a
  // visible "verify before acting" note. Action remains whatever V3 emits;
  // this is informational, not gating.
  const dataAgeHours = dataAgeHoursPre;
  const staleData = staleDataPre;
  if (staleData) {
    blockedReasons.push("SWS data is stale; verify price/FV before acting");
    finalReasons = [`SWS data ${dataAgeHours}h old — verify before acting.`, ...finalReasons];
  }

  const decisionMetadata = _buildDecisionMetadata({
    action: promotedAction,
    legacyAction,
    valuationReview,
    reductionEvidence,
    newsSignal,
    blockedReasons: [...new Set(blockedReasons)],
    trimFrac,
    topUpFrac,
    position_weight,
    currentValue: _currentValue,
    reasonFamily: decisionReasonFamily,
  });

  const exitPlan = buildExitPlan({
    action: promotedAction,
    legacyAction,
    actionUrgency: promotedAction === "EXIT" || String(promotedAction).startsWith("EXIT")
      ? "high"
      : trimFrac > 0
        ? "medium"
        : "none",
    trimRupees,
    topUpRupees,
    ladderRationale,
    reasons: finalReasons,
    currentPrice: _currentPrice || ov.current_price_inr,
    current_price_inr: ov.current_price_inr,
    avgPrice: holding.avgPrice,
    quantity: holding.quantity,
    positionWeight: position_weight,
    sectorWeight: sector_weight,
    pnlPercent: holding.pnlPercent,
    purchaseDate: holding.purchaseDate,
    nextEarningsDate: ov.next_earnings_date,
    fairValueInr: reconciled.fair_value_inr,
    fairValueConfidence: reconciled.confidence,
    upsidePct: reconciled.upside_pct,
    marketCapInr: ov.market_cap_inr,
    risks: ov.risks || scored.overview?.risks || [],
    snowflakeTotal: snow.total,
    fundamentalVerdict: scored.verdict,
  });

  return {
    ...holding,
    swsCovered: true,
    sws: {
      ticker: scored.ticker,
      name: scored.name,
      sector: scored.sector,
      sws_url: scored.sws_url,
      score: scored.composite_score_100,
      v2_score: scored.v2_score_100,
      v4_score: scored.v4_score_100,
      v4_score_100: scored.v4_score_100,
      v4_verdict: scored.v4_verdict,
      canonical_score: buildCanonicalScore(scored),
      score_model: "sws-v4-100pt-2026-05",
      score_source: "sws_v4",
      regulatory_flags: regulatoryFlags,
      risk_overlay: riskOverlay,
      verdict: scored.verdict,
      band,
      crosscheck,
      catalyst,
      indianRisk,
      snowflake: snow,
      snowflake_total: snow.total,
      current_price_inr: ov.current_price_inr,
      // SWS deep 52W range — primary input for the profit-protection signal
      // (services/portfolio/profitProtectionSignal.js). Nightly-refreshed
      // with the rest of the deep brief; live-quote fields are only the
      // fallback for uncovered names.
      fifty_two_week_high_inr: num(ov.fifty_two_week?.high, null),
      fifty_two_week_low_inr: num(ov.fifty_two_week?.low, null),
      fair_value_inr: reconciled.fair_value_inr,
      upside_pct: reconciled.upside_pct,
      valuation_confidence: reconciled.confidence,
      valuation_source: reconciled.source,
      valuation_band: reconciled.valuation_band,
      fv_reconcile_reason: reconciled.fv_reconcile_reason,
      upside_source: reconciled.upside_source,
      valuation_review: valuationReview,
      reduction_evidence: reductionEvidence,
      news_signal: newsSignal,
      data_quality_gate: dataQualityGate,
      market_cap_bucket: marketCapBucket,
      smallcap_policy: smallcapPolicy,
      market_cap_inr: ov.market_cap_inr,
      multiples: ov.multiples || null,
      dividend_yield_pct: ov.dividend?.yield_pct ?? ov.dividend_yield_pct ?? null,
      dividend_payout_pct: ov.dividend?.payout_pct ?? null,
      net_margin_pct: num(fiscal.net_margin_pct ?? ov.net_margin_pct, null),
      revenue_growth_pct: num(fiscal.revenue_growth_pct, null),
      earnings_growth_pct: num(fiscal.earnings_growth_pct, null),
      returns_pct: ov.returns_pct || null,
      next_earnings_date: ov.next_earnings_date,
      last_quarter_result: ov.last_quarter_result,
      last_earnings_date: lastEarnings?.date ?? null,
      last_earnings_period: lastEarnings?.period ?? null,
      surveillance,
      data_freshness_at: scored.parsed_at,
      data_age_hours: dataFreshnessMs(scored) != null ? Math.round(dataFreshnessMs(scored) / 3600000) : null,
      snowflake_data_quality: ov.snowflake_data_quality || null,
      breakdown: scored.score_breakdown,
      v2_breakdown: scored.v2_breakdown,
      v4_breakdown: scored.v4_breakdown,
      v2_recommendation: v2recommendation,
      recommender_mode: getRecommenderMode(),
      peer_substitute: findPeerSubstitutes({
        ticker: scored.ticker,
        sector: scored.sector,
        sws_v4: num(scored.v4_score_100, null),
        market_cap_inr: num(ov.market_cap_inr, null),
        heldTickers: portfolioContext?.heldTickers,
      }),
    },
    // Promoted action — when SWS_LADDER_V2=1 this is the granular rung
    // (EXIT-now / EXIT-staged / Reduction-66/50/33/25% / Top-up-25/33/50/100%);
    // when off it's the legacy label. legacyAction always carries the
    // legacy equivalent so older consumers keep working.
    action: promotedAction,
    legacyAction,
    ladderRationale,
    ladderV2,
    convictionProxy,
    // V3 severity: continuous score 0..1 + per-component breakdown. The UI
    // renders this alongside the rung label so the user sees WHY a stock
    // landed on a specific rung. Null on HOLD or when V3 didn't fire.
    ladderSeverity,
    ladderSeverityComponents,
    // V4 surface: severityModel = "v4" when SWS_LADDER_V4=1 fired, otherwise
    // undefined (V3/V2). Lets the dashboard badge "V4" alongside the rung
    // and the diff-mode harness know which engine produced this action.
    severityModel: promotion.severityModel,
    // ₹ realised for the chosen rung — `currentValue × trim_or_topup fraction`.
    // Surfaced inline as "Reduction-33% · ₹12,400" so the user sees the
    // rupee impact at a glance, no clicking required.
    trimRupees,
    topUpRupees,
    exitPlan,
    staleData,
    displayActionIntent: decisionMetadata.displayActionIntent,
    reasonFamily: decisionMetadata.reasonFamily,
    actionFactors: decisionMetadata.actionFactors,
    valuationReview,
    reductionEvidence,
    dataQualityGate,
    marketCapBucket,
    smallcapPolicy,
    counterEvidence: reductionEvidence.counterEvidence,
    decisionConfidence: reductionEvidence.decisionConfidence,
    newsSignal,
    blockedReasons: decisionMetadata.blockedReasons,
    postTradeWeight: decisionMetadata.postTradeWeight,
    requiresConfirmation: decisionMetadata.requiresConfirmation,
    notionalTradeValue: decisionMetadata.notionalTradeValue,
    reasons: finalReasons,
    timing,
    audit: buildAuditTrail({
      holding: { ...holding, sws: { ticker: scored.ticker, snowflake: snow, fair_value_inr: reconciled.fair_value_inr, crosscheck, catalyst, indianRisk, peer_substitute: { top_peer: null }, v2_recommendation: v2recommendation, v4_score:num(scored.v4_score_100, null), v4_verdict: scored.v4_verdict }, action: finalAction },
      scored,
      recommenderMode: getRecommenderMode(),
    }),
  };
}
