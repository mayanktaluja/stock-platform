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
import { liveTopPeers } from "./mfNavIngestion.js";

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
  // Phase 4: quality / risk-adjusted signals (require AMFI metrics)
  POOR_SHARPE: { label: "Poor risk-adjusted return (Sharpe)" },
  STRONG_SHARPE: { label: "Strong risk-adjusted return (Sharpe)" },
  SEVERE_DRAWDOWN: { label: "Severe historical drawdown" },
  HIGH_VOL_FOR_CATEGORY: { label: "Volatility above category norm" },
  // Phase 4: news-driven signals (from GPT-5 classification)
  MATERIAL_NEGATIVE_NEWS: { label: "Material negative news in last 30d" },
  MATERIAL_POSITIVE_NEWS: { label: "Material positive news in last 30d" },
  // Edge
  MISSING_DATA: { label: "Insufficient data for high-confidence call" },
  LOCK_IN_REMAINING: { label: "Statutory lock-in not expired" },
};

// Phase 4: per-category Sharpe baselines used to gate "POOR_SHARPE" /
// "STRONG_SHARPE" reasons. Equity categories have higher absolute risk so
// their Sharpe baselines are tuned lower than debt funds. Values are
// approximate AMFI category medians (3y rolling).
const SHARPE_BASELINES = {
  large_cap:        { poor: 0.3, strong: 0.7 },
  flexi_cap:        { poor: 0.4, strong: 0.8 },
  elss:             { poor: 0.3, strong: 0.7 },
  mid_cap:          { poor: 0.4, strong: 0.9 },
  small_cap:        { poor: 0.5, strong: 1.0 },
  hybrid_aggressive:{ poor: 0.4, strong: 0.8 },
  hybrid_conservative:{ poor: 0.6, strong: 1.2 },
  liquid:           { poor: 0.8, strong: 2.5 },
  short_duration:   { poor: 0.5, strong: 1.5 },
  corporate_bond:   { poor: 0.5, strong: 1.5 },
  index_nifty50:    { poor: 0.3, strong: 0.7 },
};
function sharpeBaseline(catKey) {
  return SHARPE_BASELINES[catKey] || { poor: 0.3, strong: 0.7 };
}

// Phase 4: max-DD gates by category (equity carries deeper drawdowns).
const MAX_DD_SEVERE = {
  large_cap: -45, flexi_cap: -45, elss: -45, mid_cap: -50, small_cap: -55,
  hybrid_aggressive: -35, hybrid_conservative: -20,
  liquid: -2, short_duration: -8, corporate_bond: -12, index_nifty50: -45,
};
function severeDrawdownThreshold(catKey) {
  return MAX_DD_SEVERE[catKey] ?? -45;
}

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

  // Phase 5: prefer live AMFI peers when available (real 5y CAGR computed
  // from NAV history, not a curated 2020-2025 snapshot). Falls back to
  // the curated mfCandidates.json when liveTopPeers couldn't run.
  if (Array.isArray(holding.livePeers) && holding.livePeers.length > 0) {
    const currentXirr = holding.metrics?.cagr5yPct ?? Number(holding.publishedXirrPct);
    return holding.livePeers
      .map((c) => ({
        name: c.name,
        amc: c.fundHouse || null,
        isin: c.isin || null,
        approxXirr5yPct: c.cagr5yPct,
        cagr3yPct: c.cagr3yPct,
        cagr1yPct: c.cagr1yPct,
        sharpe3y: c.sharpe3y,
        maxDrawdownPct: c.maxDrawdownPct,
        deltaPp: Number.isFinite(currentXirr) && Number.isFinite(c.cagr5yPct)
          ? +(c.cagr5yPct - currentXirr).toFixed(2)
          : null,
        lockInMonths: 0, // AMFI doesn't tag lock-in; the recommender doesn't recommend SWITCH into ELSS within lock anyway
        source: "amfi_live",
      }))
      .filter((c) => c.name && (!currentAmc || amcOf(c.amc || c.name).indexOf(currentAmc.split(" ")[0]) === -1))
      .slice(0, 3);
  }

  // Fallback to curated list
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
      source: "curated",
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
  // Phase 2 priority order for the trailing-return signal:
  //   1. AMFI 3y CAGR  — real audited NAV history, period-stable
  //   2. AMFI 1y CAGR  — falls back when fund is too new for 3y
  //   3. publishedXirrPct (Groww back-solve) — noisy, last resort
  //
  // The 3y window is the SEBI-RA convention for cross-cycle comparison.
  // 1y is recency-biased; 5y understates recent manager changes; 3y is
  // the sweet spot for actionable evaluation.
  const amfi = holding.amfi || null;
  const metrics = holding.metrics || null;
  const amfiCagr3y = metrics?.cagr3yPct;
  const amfiCagr1y = metrics?.cagr1yPct;
  const xirrRaw = holding.publishedXirrPct;

  let trailingXirr = null;
  let xirrSource = null;
  if (Number.isFinite(amfiCagr3y)) {
    trailingXirr = amfiCagr3y;
    xirrSource = "amfi_3y";
  } else if (Number.isFinite(amfiCagr1y)) {
    trailingXirr = amfiCagr1y;
    xirrSource = "amfi_1y";
  } else if (xirrRaw != null && Number.isFinite(Number(xirrRaw))) {
    trailingXirr = Number(xirrRaw);
    xirrSource = "groww_xirr";
  }
  const hasXirr = trailingXirr != null;
  const vsBenchmarkPp = hasXirr ? +(trailingXirr - benchmark).toFixed(2) : null;
  const peers = rankPeers(holding, catKey);
  const bestPeer = peers[0] || null;
  const peerLagPp = (bestPeer && hasXirr) ? +(bestPeer.approxXirr5yPct - trailingXirr).toFixed(2) : null;

  // Phase 4: quality + news signals derived from Phase 2 + Phase 3 data.
  // These don't drive a top-level action by themselves — they augment
  // the XIRR-based decision and adjust confidence.
  const sharpe = metrics?.sharpe3y;
  const maxDD = metrics?.maxDrawdownPct;
  const sharpeBands = sharpeBaseline(catKey);
  const ddSevereAt = severeDrawdownThreshold(catKey);
  const qualitySignal =
    Number.isFinite(sharpe) && sharpe < sharpeBands.poor ? "POOR_SHARPE"
    : Number.isFinite(sharpe) && sharpe > sharpeBands.strong ? "STRONG_SHARPE"
    : null;
  const ddSignal = Number.isFinite(maxDD) && maxDD < ddSevereAt ? "SEVERE_DRAWDOWN" : null;

  // News signal: count MATERIAL items by sentiment from Phase 3 enrichment
  const newsItems = holding.news?.items || [];
  const materialNeg = newsItems.filter((it) => it.materiality === "MATERIAL" && it.sentiment === "NEGATIVE");
  const materialPos = newsItems.filter((it) => it.materiality === "MATERIAL" && it.sentiment === "POSITIVE");
  const newsSignal = materialNeg.length > 0 ? "MATERIAL_NEGATIVE"
    : materialPos.length > 0 ? "MATERIAL_POSITIVE"
    : null;

  const factors = {
    catKey,
    benchmarkPct: benchmark,
    trailingXirrPct: hasXirr ? +trailingXirr.toFixed(2) : null,
    trailingXirrSource: xirrSource, // "amfi_3y" | "amfi_1y" | "groww_xirr"
    vsBenchmarkPp,
    peerLagPp,
    bestPeerName: bestPeer?.name || null,
    isFolioDuplicate: !!folioOverlap.isDuplicate,
    duplicateSiblings: folioOverlap.duplicateSiblings || [],
    categoryPeerCount: (folioOverlap.categoryPeers || []).length,
    qualitySignal,
    ddSignal,
    newsSignal,
    materialNegCount: materialNeg.length,
    materialPosCount: materialPos.length,
    // Phase 2 quality signals — surfaced alongside the headline action
    amfi: amfi ? { schemeCode: amfi.schemeCode, schemeName: amfi.schemeName, fundHouse: amfi.fundHouse, score: amfi.score, matchType: amfi.matchType } : null,
    metrics: metrics ? {
      cagr1yPct: metrics.cagr1yPct,
      cagr3yPct: metrics.cagr3yPct,
      cagr5yPct: metrics.cagr5yPct,
      annualVolPct: metrics.annualVolPct,
      sharpe3y: metrics.sharpe3y,
      maxDrawdownPct: metrics.maxDrawdownPct,
      asOfDate: metrics.asOfDate,
      historyDays: metrics.historyDays,
    } : null,
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
  return augmentWithQualityAndNews({
    action: input.action,
    confidence: input.confidence,
    reasons: input.reasons,
    peerCandidates: input.peerCandidates,
    consolidateTo: input.consolidateTo,
    performance: input.performance,
    news: null,
    factors: input.factors,
  });
}

// Phase 4: layer Sharpe / max-DD / news signals on top of the base
// XIRR-driven action. These don't override CONSOLIDATE / EXIT / strong
// SWITCH (those are already supported by stronger evidence) but they:
//   • Add a reason chip so the RA sees the full picture
//   • Downgrade confidence HIGH→MEDIUM when a HOLD has a quality concern
//   • Promote HOLD→SWITCH when material negative news appears + a clear
//     peer alternative exists
function augmentWithQualityAndNews(rec) {
  const f = rec.factors;
  if (!f) return rec;

  // Add quality reason chips
  if (f.qualitySignal === "POOR_SHARPE" && Number.isFinite(f.metrics?.sharpe3y)) {
    rec.reasons.push({
      code: "POOR_SHARPE",
      ...REASONS.POOR_SHARPE,
      detail: `3y Sharpe ${f.metrics.sharpe3y} below category baseline ${sharpeBaseline(f.catKey).poor}. Returns are not compensating risk taken.`,
    });
    // Downgrade confidence on HOLD/ADD when risk-adjusted return is weak
    if ((rec.action === "HOLD" || rec.action === "ADD") && rec.confidence === "HIGH") {
      rec.confidence = "MEDIUM";
    }
  } else if (f.qualitySignal === "STRONG_SHARPE" && Number.isFinite(f.metrics?.sharpe3y)) {
    rec.reasons.push({
      code: "STRONG_SHARPE",
      ...REASONS.STRONG_SHARPE,
      detail: `3y Sharpe ${f.metrics.sharpe3y} beats category baseline ${sharpeBaseline(f.catKey).strong}. Risk-adjusted return is top-tier.`,
    });
  }

  if (f.ddSignal === "SEVERE_DRAWDOWN" && Number.isFinite(f.metrics?.maxDrawdownPct)) {
    rec.reasons.push({
      code: "SEVERE_DRAWDOWN",
      ...REASONS.SEVERE_DRAWDOWN,
      detail: `Max drawdown ${f.metrics.maxDrawdownPct}% exceeds the typical ${severeDrawdownThreshold(f.catKey)}% category bar. Drawdown discipline is the concern, not return.`,
    });
  }

  // News-driven augmentation: material negative news on a HOLD → flag for review
  if (f.newsSignal === "MATERIAL_NEGATIVE") {
    rec.reasons.push({
      code: "MATERIAL_NEGATIVE_NEWS",
      ...REASONS.MATERIAL_NEGATIVE_NEWS,
      detail: `${f.materialNegCount} material negative news item(s) in the last 30 days — verify before relaying any HOLD recommendation.`,
    });
    if (rec.action === "HOLD" || rec.action === "ADD") {
      rec.confidence = "LOW"; // forces RA review
    }
  } else if (f.newsSignal === "MATERIAL_POSITIVE") {
    rec.reasons.push({
      code: "MATERIAL_POSITIVE_NEWS",
      ...REASONS.MATERIAL_POSITIVE_NEWS,
      detail: `${f.materialPosCount} material positive news item(s) in the last 30 days.`,
    });
  }

  return rec;
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

  // NOTE: Phase 5 live peers come pre-enriched on each holding (set by
  // enrichLivePeers in mfNavIngestion.js, called from the analyze
  // endpoint alongside enrichMfHoldings + enrichMfNews). Keeping
  // recommendBook synchronous so buildReport stays sync.

  const recs = mfHoldings.map((h) => ({
    name: h.name,
    folio: h.folio,
    invested: Number(h.invested) || 0,
    currentValue: Number(h.currentValue) || 0,
    pnlPercent: Number.isFinite(Number(h.pnlPercent)) ? Number(h.pnlPercent) : null,
    publishedXirrPct: Number.isFinite(Number(h.publishedXirrPct)) ? Number(h.publishedXirrPct) : null,
    category: h.category || null,
    subCategory: h.subCategory || null,
    // Phase 2 — pass AMFI metadata + metrics through to the UI so the
    // RA can read the audit trail (matched scheme, 1y/3y/5y CAGR,
    // Sharpe, max DD) directly on each card.
    amfi: h.amfi || null,
    metrics: h.metrics || null,
    // Phase 3 — classified Google News items (MATERIAL + CONTEXT only)
    news: h.news || null,
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

  // Phase 5: portfolio-level narrative summary — the "exec summary" the
  // SEBI-RA reads first. Three things:
  //   1. Headline action count + book size
  //   2. Top concerns (worst Sharpe, severe drawdown, material neg news)
  //   3. Top opportunities (highest-Sharpe peer alternatives within reach)
  const totalInvested = recs.reduce((s, p) => s + p.invested, 0);
  const totalCurrent = recs.reduce((s, p) => s + p.currentValue, 0);
  const actionable = recs.filter((p) => p.rec.action !== "HOLD");

  // Concerns: ranked by reason severity
  const concerns = [];
  for (const p of recs) {
    const codes = p.rec.reasons.map((r) => r.code);
    if (codes.includes("XIRR_NEGATIVE")) concerns.push({ folio: p.folio, name: p.name, kind: "negative_return", detail: `${p.name?.slice(0,42)} — annualised ${p.rec.factors.trailingXirrPct}%` });
    else if (codes.includes("MATERIAL_NEGATIVE_NEWS")) concerns.push({ folio: p.folio, name: p.name, kind: "negative_news", detail: `${p.name?.slice(0,42)} — material negative news in last 30d` });
    else if (codes.includes("SEVERE_DRAWDOWN")) concerns.push({ folio: p.folio, name: p.name, kind: "drawdown", detail: `${p.name?.slice(0,42)} — max DD ${p.rec.factors.metrics?.maxDrawdownPct}%` });
    else if (codes.includes("POOR_SHARPE")) concerns.push({ folio: p.folio, name: p.name, kind: "poor_sharpe", detail: `${p.name?.slice(0,42)} — Sharpe ${p.rec.factors.metrics?.sharpe3y}` });
  }

  // Opportunities: top 3 SWITCH targets ranked by deltaPp
  const opportunities = recs
    .filter((p) => p.rec.action === "SWITCH" && p.rec.peerCandidates?.[0])
    .sort((a, b) => (b.rec.peerCandidates[0].deltaPp || 0) - (a.rec.peerCandidates[0].deltaPp || 0))
    .slice(0, 3)
    .map((p) => ({
      from: { folio: p.folio, name: p.name },
      to: p.rec.peerCandidates[0].name,
      deltaPp: p.rec.peerCandidates[0].deltaPp,
    }));

  // Per-category breakdown
  const byCategory = {};
  for (const p of recs) {
    const k = p.rec.factors.catKey || "unknown";
    if (!byCategory[k]) byCategory[k] = { folioCount: 0, totalInvested: 0, totalCurrent: 0 };
    byCategory[k].folioCount += 1;
    byCategory[k].totalInvested += p.invested;
    byCategory[k].totalCurrent += p.currentValue;
  }

  return {
    positions: recs,
    actionMix,
    overlap: {
      duplicateFolioCount: overlap.duplicateFolioCount,
      overweightCategories: overlap.overweightCategories,
    },
    summary: {
      folioCount: recs.length,
      schemeCount: new Set(recs.map((r) => r.name)).size,
      totalInvested,
      totalCurrent,
      pnlAbsolute: totalCurrent - totalInvested,
      pnlPercent: totalInvested > 0 ? +(((totalCurrent - totalInvested) / totalInvested) * 100).toFixed(2) : 0,
      actionableCount: actionable.length,
      concerns: concerns.slice(0, 5),
      opportunities,
      byCategory,
    },
    benchmark: {
      source: "AMFI live NAV history + curated category medians (3y rolling)",
      asOfDate: today,
    },
  };
}
