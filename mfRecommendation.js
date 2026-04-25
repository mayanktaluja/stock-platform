/**
 * Per-MF position recommendation engine — Phase 1.
 *
 * For each fund in the user's book, produces:
 *   {
 *     action: "HOLD" | "EXIT" | "SWITCH" | "ADD" | "CONSOLIDATE",
 *     confidence: "HIGH" | "MEDIUM" | "LOW",
 *     reasons: [{ code, label, detail }],
 *     peerCandidates: [{ name, amc, isin, approxXirr5yPct, deltaPp, lockInMonths }],
 *     consolidateTo: { folio, name } | null,   // when action=CONSOLIDATE
 *     performance: { trailingXirrPct, vsCategoryPp, categoryKey, categoryLeader },
 *     news: null,                              // populated in Phase 3
 *     factors: { ... }                         // raw inputs for audit
 *   }
 *
 * Phase 1 inputs (no AMFI yet — we use what Groww gives us):
 *   • publishedXirrPct        (Groww-published per-scheme XIRR)
 *   • pnlPercent              (computed (current-invested)/invested)
 *   • category / subCategory  (from MF XLSX header)
 *   • mfCandidates.json       (curated SEBI-category leaders)
 *   • holdingsOverlap         (folio duplicates + category concentration)
 *
 * Phase 2 will replace publishedXirrPct with AMFI-computed 1y/3y/5y CAGR
 * and add Sharpe / max-DD / alpha. The decision tree is structured so
 * those new signals plug into the same `factors` object without churning
 * the action mapping.
 *
 * Designed for SEBI-RA review: every action carries its full evidence
 * trail in `reasons[]`. The verb stays observational ("Candidate switch")
 * so the RA can relay the analysis to clients within IA Reg 2013 framing.
 */

import { mfCategoryKey, getMfCandidates } from "./xirrOptimizer.js";

// ──────────────────── Reason codebook ────────────────────
//
// Codes are stable identifiers consumed by the UI (badge styling,
// filtering); labels are the human-readable summary; detail is the
// per-position specific text.

const REASONS = {
  // Performance signals
  XIRR_NEGATIVE: { label: "Negative annualised return" },
  XIRR_BELOW_CAT_BENCHMARK: { label: "Below category benchmark" },
  XIRR_TOP_QUARTILE: { label: "Top quartile vs category" },
  XIRR_OUTPERFORMER: { label: "Outperforms category" },
  // Structural / book-level
  FOLIO_DUPLICATE: { label: "Same scheme held in another folio" },
  CATEGORY_CONCENTRATION: { label: "Multiple funds in same SEBI category" },
  // Switch availability
  BETTER_SAME_CATEGORY: { label: "Better-ranked alternative in category" },
  NO_BETTER_ALTERNATIVE: { label: "Already among category leaders" },
  // Edge
  MISSING_DATA: { label: "Insufficient data for high-confidence call" },
  LOCK_IN_REMAINING: { label: "Statutory lock-in not expired" },
};

// ──────────────────── Category-baseline expected returns ──
//
// "Below benchmark" needs a benchmark. We use the long-run AMFI category
// median (5y rolling) as the bar. These are conservative — beating them
// is achievable; falling below for >2y is a concern.

const CATEGORY_BENCHMARK_PCT = {
  large_cap: 13.5,
  flexi_cap: 14.0,
  elss: 13.5,
  mid_cap: 16.0,
  small_cap: 18.0,
  hybrid_aggressive: 11.5,
  hybrid_conservative: 8.5,
  liquid: 6.5,
  short_duration: 7.0,
  corporate_bond: 7.5,
  index_nifty50: 13.0,
};

const DEFAULT_BENCHMARK_PCT = 12.0;

function categoryBenchmark(catKey) {
  return Number.isFinite(CATEGORY_BENCHMARK_PCT[catKey])
    ? CATEGORY_BENCHMARK_PCT[catKey]
    : DEFAULT_BENCHMARK_PCT;
}

// Derive the AMC short-name from a fund's full scheme name. Used to
// exclude same-AMC swaps (switching from "Quant Small Cap" to another
// "Quant" fund makes no sense for diversification).
function amcOf(name) {
  return String(name || "").trim().split(/\s+/)[0].toLowerCase();
}

// ──────────────────── Peer ranking ────────────────────
//
// Pull the curated leaders for this category, exclude same-scheme and
// same-AMC, sort by 5y CAGR descending. Returns top-3.

function rankPeers(holding, catKey) {
  if (!catKey) return [];
  const currentAmc = amcOf(holding.amc || holding.name);
  const all = getMfCandidates(holding);
  if (!all.length) return [];
  const currentXirr = Number(holding.publishedXirrPct);
  return all
    .filter((c) => amcOf(c.amc || c.name) !== currentAmc)
    .map((c) => ({
      name: c.name,
      amc: c.amc,
      isin: c.isin || null,
      approxXirr5yPct: c.approxXirr5yPct,
      deltaPp: Number.isFinite(currentXirr) && Number.isFinite(c.approxXirr5yPct)
        ? +(c.approxXirr5yPct - currentXirr).toFixed(2)
        : null,
      lockInMonths: c.lockInMonths || 0,
      categoryRank5y: c.categoryRank5y || null,
      expenseRatioPct: c.expenseRatioPct || null,
    }))
    .sort((a, b) => (b.approxXirr5yPct || 0) - (a.approxXirr5yPct || 0))
    .slice(0, 3);
}

// ──────────────────── CONSOLIDATE helper ────────────────────
//
// Returns a CONSOLIDATE recommendation when the holding has a duplicate
// sibling AND the current folio is NOT the largest. The largest folio
// is the "absorber" — it stays put and accumulates the merge.
//
// Returns null when no consolidation is warranted (no dupes, or the
// current folio is itself the absorber). Callers chain after the
// EXIT/SWITCH branches so we never tell an RA to "consolidate two
// failing folios into one bigger failing folio" — fix the scheme first.

function maybeConsolidate(holding, folioOverlap, factors) {
  if (!folioOverlap.isDuplicate || !folioOverlap.duplicateSiblings?.length) return null;
  const target = [...folioOverlap.duplicateSiblings, { invested: holding.invested, currentValue: holding.currentValue, folio: holding.folio }]
    .sort((a, b) => (b.invested || 0) - (a.invested || 0))[0];
  if (target.folio === holding.folio) return null; // we ARE the absorber
  return makeRecommendation({
    action: "CONSOLIDATE",
    confidence: "HIGH",
    reasons: [{
      code: "FOLIO_DUPLICATE",
      ...REASONS.FOLIO_DUPLICATE,
      detail: `Same scheme also in folio ${target.folio} (₹${Math.round(target.invested).toLocaleString("en-IN")} invested). Merging reduces statement clutter and simplifies redemption sequencing.`,
    }],
    peerCandidates: [],
    consolidateTo: { folio: target.folio, name: holding.name },
    performance: buildPerformance(factors),
    factors,
  });
}

// ──────────────────── Main per-position decision ────────────────────

/**
 * @param {object} holding - normalised mf row from the parser
 * @param {object} ctx - { overlap, today, fyContext }
 * @returns recommendation object (see file header)
 */
export function recommendForPosition(holding, ctx = {}) {
  const overlap = ctx.overlap || {};
  const folioOverlap = (overlap.perFundOverlap && holding.folio)
    ? overlap.perFundOverlap[holding.folio] || {}
    : {};

  const catKey = mfCategoryKey(holding);
  const benchmark = categoryBenchmark(catKey);
  // Explicit null/undefined check — Number(null) coerces to 0 (which IS
  // Number.isFinite), so a missing publishedXirrPct would otherwise be
  // silently treated as "fund returned 0%" and trip the below-benchmark
  // SWITCH branch with bogus confidence. Same pattern for missing data
  // shows up across all broker exports — guard explicitly.
  const xirrRaw = holding.publishedXirrPct;
  const hasXirr = xirrRaw != null && Number.isFinite(Number(xirrRaw));
  const trailingXirr = hasXirr ? Number(xirrRaw) : null;
  const vsBenchmarkPp = hasXirr ? +(trailingXirr - benchmark).toFixed(2) : null;
  const peers = rankPeers(holding, catKey);
  const bestPeer = peers[0] || null;
  const peerLagPp = (bestPeer && hasXirr) ? +(bestPeer.approxXirr5yPct - trailingXirr).toFixed(2) : null;

  const factors = {
    catKey,
    benchmarkPct: benchmark,
    trailingXirrPct: hasXirr ? +trailingXirr.toFixed(2) : null,
    vsBenchmarkPp,
    peerLagPp,
    bestPeerName: bestPeer?.name || null,
    isFolioDuplicate: !!folioOverlap.isDuplicate,
    duplicateSiblings: folioOverlap.duplicateSiblings || [],
    categoryPeerCount: (folioOverlap.categoryPeers || []).length,
  };

  // ── Decision tree ──
  //
  // Order matters. The plan-doc had CONSOLIDATE first (it's the cheapest
  // action), but real testing on the user's book exposed the flaw:
  // when a SCHEME is failing (e.g., Quant Small Cap -7.67%), telling
  // the RA to "merge two losing folios into one larger losing folio"
  // is technically correct hygiene but completely misses the headline
  // fix. EXIT/SWITCH on a failing scheme always preempts the merge.
  //
  // Final ordering:
  //   1. EXIT (negative XIRR + no credible alternative) — highest priority
  //   2. SWITCH (below-benchmark XIRR + credible alternative)
  //   3. CONSOLIDATE (folio dupes — only when scheme itself is HOLD-able)
  //   4. ADD (top quartile + uncrowded category)
  //   5. HOLD (default)
  //
  // First match wins; reasons accumulate so the audit trail is complete.

  const reasons = [];

  // 1. EXIT vs SWITCH — drives off trailing XIRR signal. Highest priority
  //    because a failing scheme dominates folio-hygiene concerns.
  if (hasXirr) {
    // 2a. Material negative XIRR → EXIT signal regardless of category
    if (trailingXirr < -3) {
      reasons.push({
        code: "XIRR_NEGATIVE",
        ...REASONS.XIRR_NEGATIVE,
        detail: `Annualised return ${trailingXirr.toFixed(2)}% — material loss vs category benchmark of ${benchmark}%.`,
      });
      // Is there a credible alternative in the same category?
      // Same-AMC excluded by rankPeers, so bestPeer is genuinely a swap.
      if (bestPeer && peerLagPp >= 5) {
        reasons.push({
          code: "BETTER_SAME_CATEGORY",
          ...REASONS.BETTER_SAME_CATEGORY,
          detail: `${bestPeer.name} delivers ${bestPeer.approxXirr5yPct}% 5y CAGR (+${peerLagPp}pp).`,
        });
        return makeRecommendation({
          action: "SWITCH",
          confidence: "HIGH",
          reasons,
          peerCandidates: peers,
          consolidateTo: null,
          performance: buildPerformance(factors),
          factors,
        });
      }
      // No credible alternative → flat EXIT
      return makeRecommendation({
        action: "EXIT",
        confidence: "HIGH",
        reasons,
        peerCandidates: peers, // still surface for context
        consolidateTo: null,
        performance: buildPerformance(factors),
        factors,
      });
    }

    // 2b. Below benchmark by ≥3pp → SWITCH if alternative available
    if (vsBenchmarkPp != null && vsBenchmarkPp <= -3) {
      reasons.push({
        code: "XIRR_BELOW_CAT_BENCHMARK",
        ...REASONS.XIRR_BELOW_CAT_BENCHMARK,
        detail: `Trailing ${trailingXirr.toFixed(2)}% vs category benchmark ${benchmark}% (${vsBenchmarkPp}pp gap).`,
      });
      if (bestPeer && peerLagPp >= 3) {
        reasons.push({
          code: "BETTER_SAME_CATEGORY",
          ...REASONS.BETTER_SAME_CATEGORY,
          detail: `${bestPeer.name} delivers ${bestPeer.approxXirr5yPct}% 5y CAGR (+${peerLagPp}pp).`,
        });
        return makeRecommendation({
          action: "SWITCH",
          confidence: peerLagPp >= 5 ? "HIGH" : "MEDIUM",
          reasons,
          peerCandidates: peers,
          consolidateTo: null,
          performance: buildPerformance(factors),
          factors,
        });
      }
      // Below benchmark but no clearly-better peer → check CONSOLIDATE,
      // then fall to HOLD with caution
      const cons = maybeConsolidate(holding, folioOverlap, factors);
      if (cons) return cons;
      reasons.push({
        code: "NO_BETTER_ALTERNATIVE",
        ...REASONS.NO_BETTER_ALTERNATIVE,
        detail: "No same-category peer with material outperformance after excluding same-AMC swaps.",
      });
      return makeRecommendation({
        action: "HOLD",
        confidence: "MEDIUM",
        reasons,
        peerCandidates: peers,
        consolidateTo: null,
        performance: buildPerformance(factors),
        factors,
      });
    }

    // 2c. Outperforms benchmark by ≥5pp → ADD signal (top performer).
    //     But CONSOLIDATE first if the same scheme exists in another folio
    //     — duplicate folios are still hygiene-worth fixing even on a star.
    if (vsBenchmarkPp != null && vsBenchmarkPp >= 5) {
      const cons = maybeConsolidate(holding, folioOverlap, factors);
      if (cons) return cons;
      reasons.push({
        code: "XIRR_TOP_QUARTILE",
        ...REASONS.XIRR_TOP_QUARTILE,
        detail: `Trailing ${trailingXirr.toFixed(2)}% beats category benchmark ${benchmark}% by ${vsBenchmarkPp}pp.`,
      });
      // ADD only when category isn't already crowded in the book
      if (factors.categoryPeerCount === 0) {
        return makeRecommendation({
          action: "ADD",
          confidence: "MEDIUM",
          reasons,
          peerCandidates: peers,
          consolidateTo: null,
          performance: buildPerformance(factors),
          factors,
        });
      }
      // Crowded category → HOLD as outperformer; don't add more weight
      reasons.push({
        code: "CATEGORY_CONCENTRATION",
        ...REASONS.CATEGORY_CONCENTRATION,
        detail: `${factors.categoryPeerCount} other fund(s) in same SEBI category — adding more would concentrate risk.`,
      });
      return makeRecommendation({
        action: "HOLD",
        confidence: "HIGH",
        reasons,
        peerCandidates: peers,
        consolidateTo: null,
        performance: buildPerformance(factors),
        factors,
      });
    }

    // 2d. Within ±3pp of benchmark → CONSOLIDATE if dupe folio, else HOLD
    {
      const cons = maybeConsolidate(holding, folioOverlap, factors);
      if (cons) return cons;
    }
    reasons.push({
      code: "XIRR_OUTPERFORMER",
      ...REASONS.XIRR_OUTPERFORMER,
      detail: `Trailing ${trailingXirr.toFixed(2)}% within ±3pp of category benchmark ${benchmark}% — fund is performing in line.`,
    });
    return makeRecommendation({
      action: "HOLD",
      confidence: "HIGH",
      reasons,
      peerCandidates: peers,
      consolidateTo: null,
      performance: buildPerformance(factors),
      factors,
    });
  }

  // 3. No XIRR data → CONSOLIDATE if dupe folio, else HOLD with low confidence
  {
    const cons = maybeConsolidate(holding, folioOverlap, factors);
    if (cons) return cons;
  }
  reasons.push({
    code: "MISSING_DATA",
    ...REASONS.MISSING_DATA,
    detail: "No published XIRR available — recommendation will firm up after AMFI NAV ingestion (Phase 2).",
  });
  return makeRecommendation({
    action: "HOLD",
    confidence: "LOW",
    reasons,
    peerCandidates: peers,
    consolidateTo: null,
    performance: buildPerformance(factors),
    factors,
  });
}

function buildPerformance(factors) {
  return {
    trailingXirrPct: factors.trailingXirrPct,
    vsCategoryPp: factors.vsBenchmarkPp,
    categoryKey: factors.catKey,
    categoryBenchmarkPct: factors.benchmarkPct,
    categoryLeader: factors.bestPeerName,
    peerLagPp: factors.peerLagPp,
  };
}

function makeRecommendation(input) {
  return {
    action: input.action,
    confidence: input.confidence,
    reasons: input.reasons,
    peerCandidates: input.peerCandidates,
    consolidateTo: input.consolidateTo,
    performance: input.performance,
    news: null, // Phase 3 populates this
    factors: input.factors,
  };
}

// ──────────────────── Bulk: per-book run ────────────────────
//
// Convenience wrapper: takes the full mfHoldings array, computes overlap
// once, then runs the per-position recommender for each row. Used by
// portfolioAnalyzer.buildReport.

import { detectOverlap } from "./holdingsOverlap.js";

export function recommendBook(mfHoldings = [], opts = {}) {
  const overlap = detectOverlap(mfHoldings);
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const recs = mfHoldings.map((h) => ({
    name: h.name,
    folio: h.folio,
    invested: Number(h.invested) || 0,
    currentValue: Number(h.currentValue) || 0,
    pnlPercent: Number.isFinite(Number(h.pnlPercent)) ? Number(h.pnlPercent) : null,
    publishedXirrPct: Number.isFinite(Number(h.publishedXirrPct)) ? Number(h.publishedXirrPct) : null,
    category: h.category || null,
    subCategory: h.subCategory || null,
    rec: recommendForPosition(h, { overlap, today }),
  }));

  // Action-mix counts for the header card
  const actionMix = recs.reduce((acc, r) => {
    acc[r.rec.action] = (acc[r.rec.action] || 0) + 1;
    return acc;
  }, {});

  // Sort: actionable items first (EXIT > SWITCH > CONSOLIDATE > ADD > HOLD)
  const ORDER = { EXIT: 0, SWITCH: 1, CONSOLIDATE: 2, ADD: 3, HOLD: 4 };
  recs.sort((a, b) => (ORDER[a.rec.action] ?? 99) - (ORDER[b.rec.action] ?? 99));

  return {
    positions: recs,
    actionMix,
    overlap: {
      duplicateFolioCount: overlap.duplicateFolioCount,
      overweightCategories: overlap.overweightCategories,
    },
    benchmark: {
      source: "AMFI 5y category median (curated; replaced with live values in Phase 2)",
      asOfDate: today,
    },
  };
}
