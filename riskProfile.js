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
 * to a CONSERVATIVE / MODERATE / AGGRESSIVE bucket. Soft-gated — when no
 * profile exists, recommendations still render but carry a banner asking
 * the user to complete the survey for personalised analysis.
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

// ──────────────────── 5-question SEBI suitability intake ────────
//
// Extends the 3-question risk profile with the 4 intake questions
// pinned to portfolio reviews per SEBI's IA Reg Schedule III + RA Reg
// Reg 9(b). The 3 risk-profile questions still produce the bucket
// (CONSERVATIVE / MODERATE / AGGRESSIVE) — extension answers ride
// alongside as the `intake` sub-object.
//
//   1. Fresh capital available for deployment (₹)              — numeric
//   2. Transactional changes since last review                  — radio
//   3. Focus stock (any single name on your mind)               — text/null
//   4. LTCG already realised this FY (₹)                        — numeric
//   5. Risk profile (3 sub-questions: horizon / loss / age)     — radios
//
// Question 5 reuses RISK_PROFILE_QUESTIONS unchanged — the bucket
// scoring logic + downstream consumers (mfRecommendation, asset
// allocation) keep working identically.
//
// The full intake answer shape:
//   {
//     freshCapitalInr:                 number,
//     transactionalChangesSinceLast:   "none" | "minor" | "major",
//     focusStock:                      string | null,
//     ltcgRealisedYtdRupees:           number,
//     // The 3 risk-profile fields:
//     horizon:                         "short" | "medium" | "long",
//     loss_tolerance:                  "low" | "medium" | "high",
//     age_bracket:                     "older" | "mid" | "young",
//   }

export const INTAKE_QUESTIONS = [
  {
    id: "freshCapitalInr",
    label: "Fresh capital available for deployment (₹)",
    helper: "0 if you're only reviewing the existing book, no new buys.",
    type: "numeric",
    min: 0,
    step: 10000,
    placeholder: "0",
  },
  {
    id: "transactionalChangesSinceLast",
    label: "Any transactions outside this upload since your last review?",
    helper: "If yes, the engine flags any holding-level change you may not have re-imported yet.",
    type: "radio",
    options: [
      { value: "none",  label: "No changes" },
      { value: "minor", label: "1–2 small trades" },
      { value: "major", label: "Multiple trades / reshuffle" },
    ],
  },
  {
    id: "focusStock",
    label: "Any single stock you want extra focus on? (optional)",
    helper: "Leave blank for the default review. Symbol or company name accepted.",
    type: "text",
    placeholder: "e.g. RELIANCE or Tata Motors",
    optional: true,
  },
  {
    id: "ltcgRealisedYtdRupees",
    label: "LTCG already realised this financial year (₹)",
    helper: "Used so the per-rung tax block knows how much of your ₹1.25L FY exemption is still available.",
    type: "numeric",
    min: 0,
    step: 5000,
    placeholder: "0",
  },
  // The 5th "question" is the embedded risk-profile triplet. The UI
  // expands it inline as 3 radio rows under one labelled section.
  {
    id: "_riskProfile",
    label: "Risk profile (3 questions)",
    helper: "Used to bucket you CONSERVATIVE / MODERATE / AGGRESSIVE — drives basket targets and per-fund alignment chips.",
    type: "subform",
    questions: RISK_PROFILE_QUESTIONS,
  },
];

/**
 * Validate + normalise raw intake answers from the form. Returns:
 *   { ok: true, intake, riskProfile }  on success
 *   { ok: false, error: string, missing: string[] }  on validation failure
 *
 * Required fields: all 4 explicit numeric/radio fields + the 3 risk-
 * profile sub-fields. focusStock is optional. The bucket scoring
 * delegates to scoreRiskProfile() so the existing 3-question logic
 * stays the single source of truth.
 */
export function buildIntake(raw) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "No intake answers provided.", missing: ["all"] };
  }
  const missing = [];
  const fresh = Number(raw.freshCapitalInr);
  if (!Number.isFinite(fresh) || fresh < 0) missing.push("freshCapitalInr");
  const txn = String(raw.transactionalChangesSinceLast || "");
  if (!["none", "minor", "major"].includes(txn)) missing.push("transactionalChangesSinceLast");
  const ltcg = Number(raw.ltcgRealisedYtdRupees);
  if (!Number.isFinite(ltcg) || ltcg < 0) missing.push("ltcgRealisedYtdRupees");

  // Risk profile — score using the existing 3-question helper. Returns
  // null when any of the 3 sub-questions is missing.
  const rpAnswers = {
    horizon: raw.horizon,
    loss_tolerance: raw.loss_tolerance,
    age_bracket: raw.age_bracket,
  };
  const scored = scoreRiskProfile(rpAnswers);
  if (!scored) {
    for (const q of RISK_PROFILE_QUESTIONS) {
      if (!q.options.find((o) => o.value === rpAnswers[q.id])) missing.push(q.id);
    }
  }

  if (missing.length > 0) {
    return { ok: false, error: `Missing or invalid: ${missing.join(", ")}`, missing };
  }

  const focus = String(raw.focusStock || "").trim() || null;

  return {
    ok: true,
    intake: {
      freshCapitalInr: fresh,
      transactionalChangesSinceLast: txn,
      focusStock: focus,
      ltcgRealisedYtdRupees: ltcg,
      completedAt: new Date().toISOString(),
    },
    // Returned alongside so the caller can write `riskProfile` AND
    // `intake` in a single portfolioStorage write.
    riskProfile: { ...scored, answers: rpAnswers },
  };
}

/**
 * Hard-gate check used by the analyzer route when SUITABILITY_GATE=1.
 * Returns true when the persisted portfolio carries a complete intake
 * sub-object. False → server returns 412 Precondition Failed and the UI
 * shows the intake modal before re-trying.
 */
export function hasCompleteIntake(portfolio) {
  const intake = portfolio?.intake;
  if (!intake) return false;
  if (typeof intake.freshCapitalInr !== "number") return false;
  if (!intake.transactionalChangesSinceLast) return false;
  if (typeof intake.ltcgRealisedYtdRupees !== "number") return false;
  // riskProfile.bucket is the 3-question completion proxy. Both must be
  // present for a valid SEBI-grade intake.
  if (!portfolio?.riskProfile?.bucket) return false;
  return true;
}
