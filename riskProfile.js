/**
 * Risk Profile — Priority 3 of the recommender.
 *
 * SEBI's IA Regulations 2013 (Schedule III) require risk profiling before
 * any portfolio recommendation. The analyser today produces actionable
 * SWITCH/EXIT/CONSOLIDATE calls without ever asking who's holding the
 * portfolio — a 25-year-old with a 30-year horizon and a 60-year-old
 * preserving capital before retirement get the same advice. That isn't
 * SEBI-defensible.
 *
 * This module is the bare-minimum risk profiler: three questions, scored
 * to a CONSERVATIVE / MODERATE / AGGRESSIVE bucket. Hard-gated as of
 * 2026-05-16 — the analyser's personalised endpoints (/api/portfolio/
 * analyze, /api/portfolio/analyze/rerun, /api/portfolio/optimize) refuse
 * to run with a 412 RISK_PROFILE_REQUIRED until this survey is completed.
 * Universal-data endpoints (sws-picks, earnings calendar, watchlist) stay
 * open so the friend can browse before committing to the survey.
 *
 * Three questions:
 *   1. Investment horizon (when do you need this money?)
 *      < 3 yr → 1 pt
 *      3–7 yr → 2 pt
 *      > 7 yr → 3 pt
 *   2. Loss tolerance (in the worst year you've been through, how much
 *      could your portfolio drop before you'd lose sleep?)
 *      < 10% → 1 pt
 *      10–20% → 2 pt
 *      > 20% → 3 pt
 *   3. Age bracket (proxy for both horizon AND income stability)
 *      > 50 → 1 pt
 *      35–50 → 2 pt
 *      < 35 → 3 pt
 *
 * Sum: 3–4 → CONSERVATIVE, 5–7 → MODERATE, 8–9 → AGGRESSIVE.
 *
 * The bucket is consumed by:
 *   • assetAllocation.computeAllocationGap → derives target allocations
 *   • mfRecommendation.tagRecRiskAlignment → tags each per-fund rec with
 *     ALIGNED / TOO_AGGRESSIVE / TOO_CONSERVATIVE
 */

// ──────────────────── Question schema ────────────────────
//
// Pure data so the UI can render the survey directly off this. Each
// question carries its options and a score per option. Adding a question
// means adding to this list; the scoring helper sums numerically.

export const RISK_PROFILE_QUESTIONS = [
  {
    id: "horizon",
    label: "When do you need this money?",
    helper: "Pick the typical horizon across your major goals.",
    options: [
      { value: "short",  label: "Within 3 years",  score: 1 },
      { value: "medium", label: "3 – 7 years",     score: 2 },
      { value: "long",   label: "More than 7 years", score: 3 },
    ],
  },
  {
    id: "loss_tolerance",
    label: "What's the largest single-year drop you'd accept without panicking?",
    helper: "Honest answers produce better recommendations.",
    options: [
      { value: "low",    label: "Less than 10%",  score: 1 },
      { value: "medium", label: "10 – 20%",       score: 2 },
      { value: "high",   label: "More than 20%",  score: 3 },
    ],
  },
  {
    id: "age_bracket",
    label: "What's your age bracket?",
    helper: "Used as a proxy for income stability + remaining time horizon.",
    options: [
      { value: "older",  label: "Above 50",  score: 1 },
      { value: "mid",    label: "35 – 50",   score: 2 },
      { value: "young",  label: "Below 35",  score: 3 },
    ],
  },
];

// ──────────────────── Scoring ────────────────────

/**
 * Convert raw answers → bucket. Answers shape is { [questionId]: optionValue }.
 * Returns null when answers are incomplete (caller can render the banner).
 */
export function scoreRiskProfile(answers) {
  if (!answers || typeof answers !== "object") return null;
  let total = 0;
  for (const q of RISK_PROFILE_QUESTIONS) {
    const chosenValue = answers[q.id];
    const opt = q.options.find((o) => o.value === chosenValue);
    if (!opt) return null; // incomplete
    total += opt.score;
  }
  // 3 questions × max 3 points = 9. Min 3.
  let bucket;
  if (total <= 4) bucket = "CONSERVATIVE";
  else if (total <= 7) bucket = "MODERATE";
  else bucket = "AGGRESSIVE";
  return { bucket, score: total, completedAt: new Date().toISOString() };
}

/**
 * Tag a single per-fund recommendation with risk alignment vs. the user's
 * profile. No-op when riskProfile is null (soft gate — recs still render).
 *
 * Risk hierarchy (low → high):
 *   debt_short, debt_long  → low
 *   hybrid                  → moderate
 *   equity_large, intl, gold → moderate-high
 *   equity_diversified      → high
 *   equity_mid_small        → very-high
 *
 * For CONSERVATIVE profiles, very-high / high positions are TOO_AGGRESSIVE.
 * For AGGRESSIVE profiles, low / moderate positions are TOO_CONSERVATIVE
 * (informational — we don't downgrade the action, just chip the card).
 *
 * Returns the rec with `factors.riskAlignment` populated.
 */
export function tagRecRiskAlignment(rec, holding, riskProfile) {
  if (!rec || !rec.factors) return rec;
  if (!riskProfile || !riskProfile.bucket) {
    rec.factors.riskAlignment = null;
    return rec;
  }

  const catKey = rec.factors.catKey;
  const riskTier = categoryRiskTier(catKey);
  const bucket = riskProfile.bucket;

  let alignment = "ALIGNED";
  if (bucket === "CONSERVATIVE") {
    if (riskTier === "very-high" || riskTier === "high") alignment = "TOO_AGGRESSIVE";
  } else if (bucket === "MODERATE") {
    if (riskTier === "very-high") alignment = "TOO_AGGRESSIVE";
  } else if (bucket === "AGGRESSIVE") {
    if (riskTier === "low") alignment = "TOO_CONSERVATIVE";
  }

  rec.factors.riskAlignment = alignment;
  // Don't change the action — alignment is informational. Surface a chip
  // only when misaligned so the card stays clean for ALIGNED holdings.
  return rec;
}

// Internal: SEBI-category → risk tier. Mirrors the categoryRiskTier
// taxonomy used elsewhere; kept in this module so risk-profile changes
// don't ripple through assetAllocation.
function categoryRiskTier(catKey) {
  switch (catKey) {
    case "small_cap":
    case "mid_cap":
      return "very-high";
    case "elss":
    case "flexi_cap":
      return "high";
    case "large_cap":
    case "index_nifty50":
    case "hybrid_aggressive":
      return "moderate-high";
    case "hybrid_conservative":
      return "moderate";
    case "liquid":
    case "short_duration":
    case "corporate_bond":
      return "low";
    default:
      return "unknown";
  }
}

// ──────────────────── Empty-profile helper ────────────────────
//
// Used by the UI: render a CTA when this returns true.
export function needsProfile(riskProfile) {
  return !riskProfile || !riskProfile.bucket;
}

