/**
 * Asset Allocation Gap Analysis — Priority 2 of the recommender.
 *
 * The per-fund recommender (mfRecommendation.js) operates one position at
 * a time. It can spot a bad fund, a duplicate folio, or a category in the
 * book that's overweight. What it CANNOT do — by design — is the first
 * thing a SEBI-RA actually checks: are you in the right asset classes
 * for your goals?
 *
 * A textbook case: the user's book in the regression test is 100% equity
 * (5 ELSS, 3 small-cap, 1 mid, 1 large, 1 flexi). Zero debt, zero hybrid,
 * zero international, zero gold. For a ₹16L portfolio with no separate
 * emergency fund, that's a structural concentration risk that dominates
 * any single-fund switch. The per-MF cards never surface this; this module
 * does.
 *
 * Approach:
 *   1. Map each SEBI category → asset class bucket (equity_cap_growth,
 *      equity_thematic, debt_short, debt_corp, hybrid, international,
 *      commodity).
 *   2. Aggregate the user's currentValue per bucket.
 *   3. Compare to a target derived from their risk profile (or fall back
 *      to a balanced default when no profile is set).
 *   4. Surface gaps ≥ ABS_GAP_PP_THRESHOLD with a recommendation
 *      (REDUCE / ADD_NEW / OK).
 *
 * Output is consumed by recommendBook — attached as `assetAllocation` on
 * the returned object — and rendered ABOVE the per-fund cards by the UI.
 */

import { mfCategoryKey } from "./xirrOptimizer.js";

// ──────────────────── Category → asset-class mapping ────────────────────
//
// Each SEBI category key (as produced by xirrOptimizer.mfCategoryKey) maps
// to one bucket. Buckets are intentionally coarse — finer granularity
// belongs in a v2 once we have factor-attribution data.

const CATEGORY_TO_ASSET_CLASS = {
  // Equity — growth-oriented; high vol / high expected return
  large_cap:        "equity_large",
  flexi_cap:        "equity_diversified",
  elss:             "equity_diversified",
  mid_cap:          "equity_mid_small",
  small_cap:        "equity_mid_small",
  index_nifty50:    "equity_large",
  // Hybrid — equity + debt blend
  hybrid_aggressive:   "hybrid",
  hybrid_conservative: "hybrid",
  // Debt — capital preservation
  liquid:         "debt_short",
  short_duration: "debt_short",
  corporate_bond: "debt_long",
};

// Display labels and risk colour for each bucket. Used by the UI; exported
// so the renderer can keep its own mapping in sync.
export const ASSET_CLASS_META = {
  equity_large:        { label: "Equity — Large Cap & Index", risk: "moderate-high" },
  equity_diversified:  { label: "Equity — Flexi / ELSS",      risk: "high" },
  equity_mid_small:    { label: "Equity — Mid & Small Cap",    risk: "very-high" },
  equity_thematic:     { label: "Equity — Sectoral / Thematic", risk: "very-high" },
  hybrid:              { label: "Hybrid (Equity + Debt)",      risk: "moderate" },
  debt_short:          { label: "Debt — Liquid / Short",       risk: "low" },
  debt_long:           { label: "Debt — Corporate / Long",     risk: "low-moderate" },
  international:       { label: "International Equity",         risk: "high" },
  commodity:           { label: "Gold / Commodity",            risk: "moderate" },
  unclassified:        { label: "Unclassified",                risk: "unknown" },
};

export function categoryToAssetClass(catKey) {
  return CATEGORY_TO_ASSET_CLASS[catKey] || "unclassified";
}

// ──────────────────── Target allocations by risk profile ────────────────────
//
// These are conservative defaults aligned with common SEBI-RA model
// portfolios. Numbers are %; each profile sums to 100. The "target" is a
// midpoint — the gap thresholds below define the tolerance band.
//
// CONSERVATIVE: capital-preservation tilt. Suitable for short horizons
//   (< 3 yr) or high loss-aversion.
// MODERATE: balanced. Suitable for medium horizons (3–7 yr).
// AGGRESSIVE: growth tilt. Suitable for long horizons (> 7 yr) and high
//   loss-tolerance. Still keeps a debt floor for liquidity.
const TARGET_ALLOCATIONS = {
  CONSERVATIVE: {
    equity_large:       15,
    equity_diversified: 10,
    equity_mid_small:    5,
    hybrid:             15,
    debt_short:         25,
    debt_long:          20,
    international:       5,
    commodity:           5,
  },
  MODERATE: {
    equity_large:       25,
    equity_diversified: 20,
    equity_mid_small:   10,
    hybrid:             10,
    debt_short:         10,
    debt_long:          15,
    international:       5,
    commodity:           5,
  },
  AGGRESSIVE: {
    equity_large:       25,
    equity_diversified: 25,
    equity_mid_small:   20,
    hybrid:              5,
    debt_short:          5,
    debt_long:          10,
    international:       5,
    commodity:           5,
  },
};

// Default target when no risk profile is set. Identical to MODERATE so
// the user gets sensible numbers even before completing the survey.
const DEFAULT_TARGET = TARGET_ALLOCATIONS.MODERATE;

// Tolerance band — gaps within ±this many percentage points are flagged
// "OK". Larger gaps surface a REDUCE / ADD_NEW recommendation.
const ABS_GAP_PP_THRESHOLD = 8;

// Below this share the bucket is considered "missing" (zero exposure when
// the target is non-trivial). Drives the "ADD_NEW" recommendation chip.
const MISSING_BUCKET_TARGET_THRESHOLD = 5;

export function getTargetAllocation(riskProfile) {
  if (!riskProfile) return DEFAULT_TARGET;
  const key = String(riskProfile.bucket || "").toUpperCase();
  return TARGET_ALLOCATIONS[key] || DEFAULT_TARGET;
}

// ──────────────────── Gap computation ────────────────────

/**
 * Compute current vs target asset allocation for an MF book.
 *
 * @param {Array}  mfHoldings - book as parsed by portfolioParser
 *                              (each row carries currentValue + category fields)
 * @param {object} [riskProfile] - { bucket: "CONSERVATIVE"|"MODERATE"|"AGGRESSIVE" }
 *                              When omitted, falls back to MODERATE.
 * @returns {{
 *   totalCurrent: number,
 *   targetSource: "user_profile"|"default_moderate",
 *   buckets: Array<{
 *     assetClass: string,
 *     label: string,
 *     currentPct: number,
 *     currentRupees: number,
 *     targetPct: number,
 *     gapPp: number,
 *     verdict: "OK"|"REDUCE"|"ADD_NEW"|"INCREASE",
 *   }>,
 *   summary: {
 *     equityPct: number,
 *     debtPct: number,
 *     hybridPct: number,
 *     internationalPct: number,
 *     commodityPct: number,
 *     unclassifiedPct: number,
 *     concentrationFlags: string[],   // e.g. "100% equity"
 *   },
 * }}
 */
export function computeAllocationGap(mfHoldings = [], riskProfile = null) {
  // Defensive — empty book returns a well-shaped zero result so the UI
  // can render an "upload some funds" placeholder without crashing.
  if (!Array.isArray(mfHoldings) || mfHoldings.length === 0) {
    return {
      totalCurrent: 0,
      targetSource: riskProfile ? "user_profile" : "default_moderate",
      buckets: [],
      summary: {
        equityPct: 0, debtPct: 0, hybridPct: 0, internationalPct: 0,
        commodityPct: 0, unclassifiedPct: 0,
        concentrationFlags: [],
      },
    };
  }

  const target = getTargetAllocation(riskProfile);
  const targetSource = riskProfile ? "user_profile" : "default_moderate";

  // 1. Aggregate currentValue per asset class
  const valueByClass = {};
  let totalCurrent = 0;
  for (const h of mfHoldings) {
    const value = Number(h.currentValue) || Number(h.invested) || 0;
    if (value <= 0) continue;
    const catKey = mfCategoryKey(h);
    const assetClass = categoryToAssetClass(catKey);
    valueByClass[assetClass] = (valueByClass[assetClass] || 0) + value;
    totalCurrent += value;
  }

  if (totalCurrent <= 0) {
    return {
      totalCurrent: 0,
      targetSource,
      buckets: [],
      summary: {
        equityPct: 0, debtPct: 0, hybridPct: 0, internationalPct: 0,
        commodityPct: 0, unclassifiedPct: 0,
        concentrationFlags: [],
      },
    };
  }

  // 2. Build the per-bucket comparison. Iterate the union of (target keys,
  //    user keys) so missing buckets surface as ADD_NEW.
  const allClasses = new Set([
    ...Object.keys(target),
    ...Object.keys(valueByClass),
  ]);
  const buckets = [];
  for (const ac of allClasses) {
    const currentRupees = valueByClass[ac] || 0;
    const currentPct = +((currentRupees / totalCurrent) * 100).toFixed(1);
    const targetPct = target[ac] || 0;
    const gapPp = +(currentPct - targetPct).toFixed(1);
    let verdict = "OK";
    if (Math.abs(gapPp) <= ABS_GAP_PP_THRESHOLD) verdict = "OK";
    else if (gapPp > ABS_GAP_PP_THRESHOLD) verdict = "REDUCE";
    else if (currentPct < 1 && targetPct >= MISSING_BUCKET_TARGET_THRESHOLD) verdict = "ADD_NEW";
    else verdict = "INCREASE";

    buckets.push({
      assetClass: ac,
      label: ASSET_CLASS_META[ac]?.label || ac,
      risk: ASSET_CLASS_META[ac]?.risk || "unknown",
      currentPct,
      currentRupees: Math.round(currentRupees),
      targetPct,
      gapPp,
      verdict,
    });
  }

  // Sort: largest current allocation first, then by abs gap (so problems
  // surface near the top regardless of book composition)
  buckets.sort((a, b) => {
    if (b.currentPct !== a.currentPct) return b.currentPct - a.currentPct;
    return Math.abs(b.gapPp) - Math.abs(a.gapPp);
  });

  // 3. Roll-up summary used by the headline card. Concentration flags
  //    surface "extreme" structural issues a SEBI-RA would lead with
  //    (e.g. "100% equity, no debt cushion").
  const groupSum = (prefix) => buckets
    .filter((b) => b.assetClass.startsWith(prefix))
    .reduce((s, b) => s + b.currentPct, 0);
  const equityPct = +groupSum("equity_").toFixed(1);
  const debtPct = +groupSum("debt_").toFixed(1);
  const hybridPct = +(buckets.find((b) => b.assetClass === "hybrid")?.currentPct || 0).toFixed(1);
  const internationalPct = +(buckets.find((b) => b.assetClass === "international")?.currentPct || 0).toFixed(1);
  const commodityPct = +(buckets.find((b) => b.assetClass === "commodity")?.currentPct || 0).toFixed(1);
  const unclassifiedPct = +(buckets.find((b) => b.assetClass === "unclassified")?.currentPct || 0).toFixed(1);

  const concentrationFlags = [];
  if (equityPct >= 90 && debtPct < 5) {
    concentrationFlags.push(
      "Book is " + equityPct + "% equity with no meaningful debt cushion. " +
      "Even an aggressive profile typically retains 5–15% in debt for " +
      "liquidity and rebalancing dry-powder.",
    );
  }
  if (debtPct >= 80 && equityPct < 10) {
    concentrationFlags.push(
      "Book is " + debtPct + "% debt — extremely conservative. Long-horizon " +
      "real return after inflation may be near zero.",
    );
  }
  // Mid+small-cap concentration check (separate from total equity %)
  const midSmallPct = buckets.find((b) => b.assetClass === "equity_mid_small")?.currentPct || 0;
  if (midSmallPct >= 35) {
    concentrationFlags.push(
      "Mid + small-cap exposure is " + midSmallPct.toFixed(1) + "% of book — " +
      "high drawdown sensitivity. SEBI-RA convention caps mid+small at " +
      "20–30% even for aggressive profiles.",
    );
  }
  if (internationalPct < 1) {
    concentrationFlags.push(
      "Zero international exposure. A 5–10% allocation (e.g. via PPFAS Flexi " +
      "or a global index fund) typically improves diversification.",
    );
  }
  if (commodityPct < 1) {
    concentrationFlags.push(
      "Zero gold/commodity exposure. A 5% gold allocation has historically " +
      "improved drawdown resilience without meaningfully reducing returns.",
    );
  }
  if (unclassifiedPct >= 5) {
    concentrationFlags.push(
      `${unclassifiedPct}% of book is in unclassified categories — review the ` +
      "category labels on those funds to ensure correct asset-class accounting.",
    );
  }

  return {
    totalCurrent: Math.round(totalCurrent),
    targetSource,
    riskProfileBucket: riskProfile?.bucket || null,
    buckets,
    summary: {
      equityPct,
      debtPct,
      hybridPct,
      internationalPct,
      commodityPct,
      unclassifiedPct,
      concentrationFlags,
    },
  };
}
