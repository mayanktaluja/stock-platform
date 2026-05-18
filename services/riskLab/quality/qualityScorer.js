/**
 * Risk Lab — Quality Lens / Composite Scorer.
 *
 * Combines all PRs 3-5 quality signals into a single per-stock verdict:
 *
 *   consecutive_miss        (PR 3) — SWS news[] parsed for prior Q miss
 *   imputation_inflation    (PR 4) — v3_breakdown fv/momentum_imputed
 *   risk_text_classifier    (PR 4) — SWS risks[] regex against taxonomy
 *   counter_thesis_parser   (PR 5) — picks counter_thesis falsification triggers
 *   sector_quality_overlay  (PR 5) — sector-specific risk patterns
 *
 * Output schema (see plan D2):
 *   {
 *     ticker, original_score, original_verdict, original_confidence,
 *     quality_flags: [...combined from all sources...],
 *     quality_score_delta: sum-of-severities capped at -10,
 *     quality_adjusted_score: original_score + delta (clamped [0, 100]),
 *     quality_adjusted_verdict: original or "QUALITY_HOLD" if vetoed,
 *     quality_adjusted_confidence: from confidenceCalibrator (or null),
 *     quality_verdict: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_DATA",
 *     combined_verdict: "<quality>_QUALITY_<original_verdict>",
 *   }
 *
 * Quality verdict rules:
 *   HIGH    — 0 flags fired
 *   MEDIUM  — 1-2 flags fired
 *   LOW     — 3+ flags fired
 *   INSUFFICIENT_DATA — no risks[] AND no news[] (can't classify)
 *
 * Veto rule (parallel to macro veto):
 *   quality_adjusted_verdict = "QUALITY_HOLD" when:
 *     - 3+ flags fired AND
 *     - original_verdict === "TOP_PICK" AND
 *     - quality_score_delta ≤ -7 (heavy penalty)
 */

import { detectConsecutiveMiss } from "./consecutiveMissDetector.js";
import { computeImputationPenalty } from "./imputationPenalty.js";
import { classifyRiskText } from "./riskTextClassifier.js";
import { parseCounterThesis } from "./counterThesisParser.js";
import { applySectorQualityOverlay } from "./sectorQualityOverlay.js";
import { calibrateConfidence } from "./confidenceCalibrator.js";

const DELTA_CAP = -10;
const VETO_FLAG_THRESHOLD = 3;
const VETO_DELTA_THRESHOLD = -7;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function deriveQualityVerdict(flagCount, hasRisks, hasNews) {
  if (!hasRisks && !hasNews) return "INSUFFICIENT_DATA";
  if (flagCount === 0) return "HIGH";
  if (flagCount <= 2) return "MEDIUM";
  return "LOW";
}

function deriveCombinedVerdict(qualityVerdict, originalVerdict) {
  if (!originalVerdict) return qualityVerdict;
  // Map qualityVerdict to label prefix
  if (qualityVerdict === "INSUFFICIENT_DATA") return `INSUFFICIENT_${originalVerdict}`;
  return `${qualityVerdict}_QUALITY_${originalVerdict}`;
}

/**
 * Compute the quality score for one stock.
 *
 * @param {object} input — {
 *   ticker, original_score, original_verdict, original_confidence?,
 *   v3_breakdown, sector,
 *   counter_thesis,            // picks-latest row's counter_thesis
 *   risks,                     // SWS deep brief overview.risks[]
 *   news,                      // SWS deep brief news[]
 *   event_iso_date?,           // optional; consecutive-miss only fires if provided
 * }
 * @param {object} opts — { now? }
 * @returns {object} quality scoring output (see schema in module header)
 */
export function computeQualityScore(input, opts = {}) {
  const ticker = input?.ticker || null;
  const originalScore = Number(input?.original_score ?? 0);
  const originalVerdict = input?.original_verdict || null;
  const originalConfidence = input?.original_confidence ?? null;

  const flags = [];

  // Each scorer is independent and defensive — null inputs return zero-flag
  // shapes, never throw.
  const miss = input?.event_iso_date
    ? detectConsecutiveMiss(input?.news, input.event_iso_date, opts)
    : { detected: false, penaltyPts: 0, evidence: [] };
  if (miss.detected) {
    flags.push({
      type: "consecutive_miss",
      severity: miss.penaltyPts,
      evidence: miss.evidence[0]?.title || "prior quarter miss",
      source: "sws_news",
      detail: { evidence_count: miss.evidence.length, latest_date: miss.evidence[0]?.date },
    });
  }

  const imputation = computeImputationPenalty(input?.v3_breakdown, originalScore);
  for (const f of imputation.flags) {
    flags.push(f);
  }

  const riskText = classifyRiskText(input?.risks);
  for (const f of riskText.flags) {
    flags.push({ ...f, source: "sws_risks" });
  }

  const counterThesis = parseCounterThesis(input?.counter_thesis);
  for (const f of counterThesis.flags) {
    flags.push({ ...f, source: "counter_thesis" });
  }

  const sectorOverlay = applySectorQualityOverlay(input?.sector, input?.risks);
  for (const f of sectorOverlay.flags) {
    flags.push({ ...f, source: "sector_overlay" });
  }

  // Cap combined delta to limit how much the lab can swing a score
  const rawDelta = flags.reduce((acc, f) => acc + Number(f.severity || 0), 0);
  const delta = Math.max(rawDelta, DELTA_CAP);

  const adjustedScore = clamp(Number((originalScore + delta).toFixed(2)), 0, 100);

  const hasRisks = Array.isArray(input?.risks) && input.risks.length > 0;
  const hasNews = Array.isArray(input?.news) && input.news.length > 0;
  const qualityVerdict = deriveQualityVerdict(flags.length, hasRisks, hasNews);

  // Veto rule — applies only to TOP_PICK with heavy quality concerns
  const vetoed =
    flags.length >= VETO_FLAG_THRESHOLD &&
    delta <= VETO_DELTA_THRESHOLD &&
    originalVerdict === "TOP_PICK";
  const adjustedVerdict = vetoed ? "QUALITY_HOLD" : originalVerdict;

  const combinedVerdict = deriveCombinedVerdict(qualityVerdict, originalVerdict);

  const calibratedConf = calibrateConfidence(originalConfidence, flags);

  return {
    ticker,
    original_score: originalScore,
    original_verdict: originalVerdict,
    original_confidence: originalConfidence,
    quality_flags: flags,
    quality_score_delta: delta,
    quality_adjusted_score: adjustedScore,
    quality_adjusted_verdict: adjustedVerdict,
    quality_adjusted_confidence: calibratedConf?.adjusted_confidence ?? null,
    quality_confidence_breakdown: calibratedConf,
    quality_verdict: qualityVerdict,
    combined_verdict: combinedVerdict,
    quality_veto: {
      vetoed,
      reason: vetoed ? `${flags.length} quality flags + delta ${delta} ≤ ${VETO_DELTA_THRESHOLD}` : null,
    },
  };
}
