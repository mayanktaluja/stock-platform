// SWS-driven portfolio aggregator: Tier A/B/C/D action grid + two-basket
// (Defensive vs Growth + shared Core) + outside-portfolio fresh picks.
//
// Inputs:
//   - scoredHoldings[]: each carries { sws, action, reasons, timing, ... }
//                       from services/swsHoldingEngine.scoreHolding()
//   - opts.freshCapitalInr (optional): candidate-surface trigger only; funded
//                            rupee sizing lives in portfolioConstructionPlan
//   - opts.freshPickLimit (default 8): cap on fresh-pick rows per basket
//
// Output: { tiers: { A, B, C, D }, baskets: { defensive, growth, core },
//           sectorOverlay, snapshot, banner }

import { num } from "./swsScoring.js";
import { loadSWSDeep, pickSnowflake, scoreHolding, _reconcileFVUpside } from "./swsHoldingEngine.js";
import { detectSectorWipeout } from "./swsPeerLayer.js";
import { getPicksLatest, listDeepTickers } from "./swsDal/index.js";
import {
  ALL_REDUCTION_ACTIONS,
  ALL_TOPUP_ACTIONS,
  parseTrimPct,
} from "./actionLadder.js";
import { computePortfolioHealth } from "./swsPortfolioHealth.js";
import {
  buildSectorContext,
  scoreSectorFit,
  selectSectorGapPicks,
  buildPerfectFitReason,
  PERFECT_FIT_FLOOR,
} from "./swsSectorFit.js";
import { attachDividendsToHoldings } from "./portfolio/portfolioDividendService.js";
import fs from "node:fs";
import path from "node:path";

let _dividendCache = null;
function loadDividendsUpcoming() {
  if (_dividendCache) return _dividendCache;
  const p = path.resolve(process.cwd(), "data", "catalysts", "dividends-upcoming.json");
  try {
    const raw = fs.readFileSync(p, "utf8");
    const json = JSON.parse(raw);
    _dividendCache = Array.isArray(json?.dividends) ? json.dividends : [];
  } catch {
    _dividendCache = [];
  }
  return _dividendCache;
}

// Lazy macro-regime import — only used for basket tilt; failing import
// degrades gracefully (no tilt applied).
let _computeMacroDelta = null;
let _getCurrentRegimeOrNull = null;
try {
  const mod = await import("../macroRegime.js");
  if (typeof mod.computeMacroDelta === "function") _computeMacroDelta = mod.computeMacroDelta;
} catch {}

// loadPicksLatest is a thin alias over the DAL for callsite readability;
// DEEP_DIR walk has been replaced by dal.listDeepTickers() below.
const loadPicksLatest = getPicksLatest;

// Action sets from actionLadder cover both legacy (EXIT / Reduction-50% /
// Reduction-25-33% / Top-up-modest / Top-up / STRONG Top-up) and ladder-v2
// (EXIT-now / EXIT-staged / Reduction-66/50/33/25% / Top-up-25/33/50/100%)
// labels. Aggregator behaviour stays identical for legacy callers; v2 labels
// flow through naturally because parseTrimPct understands every rung.
const REDUCTION_ACTIONS = ALL_REDUCTION_ACTIONS;
const TOPUP_ACTIONS = ALL_TOPUP_ACTIONS;

function _reductionRupees(holding) {
  const cv = num(holding.currentValue, 0);
  // parseTrimPct handles every label in the system: EXIT/EXIT-now → 1.0,
  // EXIT-staged → 0.5 (only the today-half is realised), Reduction-* fixed
  // tiers, plus the legacy Reduction-25-33% → 0.30 mapping kept for
  // backward compat with v1 outputs.
  return cv * parseTrimPct(holding.action);
}

// Detects "shell" SWS deep entries — the file exists (so swsCovered is
// true and the engine produces a score) but the underlying snapshot has
// no fundamentals signal. Real example: post-demerger tickers like
// TMCV.NS where SWS lists the security but hasn't populated pillars or
// multiples yet. Without this check the action ladder reads the low
// score as a deeply weak holding and emits a Reduction — which is the
// engine punishing the user for an SWS coverage gap, not a thesis call.
//
// Two shapes are treated as too thin:
//   1. snowflake_total = 0 AND all multiples null (original TMCV shape)
//   2. snowflake_total = 1 AND all multiples null AND every fundamentals
//      signal (margin / revenue / earnings growth / last quarter) null —
//      the "phantom valuation pillar" case. SWS computes a consensus
//      fair value from analyst targets even when statements are missing,
//      which yields snowflake.valuation = 1 standalone. The data is
//      still a shell; the lone pillar comes from FV alone.
//
// snow ≥ 2 OR any non-null multiple OR any non-null fundamentals signal
// → real (if weak) data, ladder call stands. Predicate is self-healing:
// once SWS lifts coverage, holdings flow back through normal tier logic.
export function _isSwsDataTooThinToReduce(h) {
  const sws = h?.sws || {};
  const snowTotal = num(sws.snowflake?.total ?? sws.snowflake_total, 0);
  const m = sws.multiples || {};
  const allMultiplesNull =
    m.pe == null && m.ps == null && m.pb == null && m.ev_ebitda == null;
  if (!allMultiplesNull) return false;
  if (snowTotal === 0) return true;
  if (snowTotal === 1) {
    return (
      sws.net_margin_pct == null &&
      sws.revenue_growth_pct == null &&
      sws.earnings_growth_pct == null &&
      sws.last_quarter_result == null
    );
  }
  return false;
}

export function buildTiers(scoredHoldings) {
  const tierA = []; // Reductions
  const tierC = []; // HOLD
  const tierD = []; // Watch (HOLD with weak signal — borderline)

  let freedRupees = 0;

  for (const h of scoredHoldings) {
    if (!h.swsCovered) {
      tierD.push({ ...h, watchReason: "No SWS data — verify ticker / treat as out-of-universe." });
      continue;
    }
    if (REDUCTION_ACTIONS.has(h.action) && _isSwsDataTooThinToReduce(h)) {
      tierD.push({
        ...h,
        watchReason: "Insufficient SWS coverage (near-zero snowflake, no multiples or fundamentals) — too thin to recommend reduction. Hand-watch.",
      });
      continue;
    }
    if (REDUCTION_ACTIONS.has(h.action)) {
      const freed = _reductionRupees(h);
      freedRupees += freed;
      tierA.push({ ...h, freedRupees: Math.round(freed) });
    } else if (h.action === "HOLD") {
      const v4 = num(h.sws.v4_score, 0);
      const upside = num(h.sws.upside_pct, 0);
      const days = h.sws.next_earnings_date
        ? Math.ceil((new Date(h.sws.next_earnings_date + "T00:00:00Z") - Date.now()) / 86400000)
        : null;
      // PR 7 calibration: original watch rule (v3 < 36 OR upside < 5 OR
      // earnings ≤7d) was so strict that EVERY HOLD on a real personal
      // book landed in Tier D, leaving Tier C empty (real-portfolio
      // diagnostic gap #3). New rule:
      //   • v4 < 28  → genuinely borderline (V4 WATCH floor, ~universe p25)
      //   • upside < -5 (significantly overvalued, not just modest)
      //   • earnings ≤3d (true imminent catalyst, not 7d window)
      // Anything else stays in Tier C.
      const isWatch = v4 < 28 || upside < -5 || (days != null && days >= 0 && days <= 3);
      if (isWatch) {
        tierD.push({
          ...h,
          watchReason: days != null && days >= 0 && days <= 3
            ? `Earnings in ${days}d — re-evaluate post-result.`
            : v4 < 28 ? `Low score (v4 ${v4.toFixed(1)}) — watch for catalyst.`
            : `Notable overvaluation (${upside.toFixed(1)}%) — re-rate next quarter.`,
        });
      } else {
        tierC.push(h);
      }
    }
  }

  return { tierA, tierC, tierD, freedRupees: Math.round(freedRupees) };
}

// PR 7 calibration: the v1 filter required v1-verdict ∈ {QUALITY_GROWTH,
// DEEP_VALUE} which gate at composite ≥ 62. v3-aware filter uses v4_verdict
// (TOP_PICK ≥60, STRONG ≥45) which is the score the action engine
// authoritatively drives off. Real-portfolio symptom: Tier B Growth basket
// was empty despite 30 Top-up candidates because v1 verdict bands almost
// never matched on a personal book (pre-selected → distribution skewed).
//
// Defensive filter is also relaxed slightly: dividends ≥ 2 (was ≥ 3) so
// growth-oriented quality names (HDFCBANK Snowflake-div=5, SBIN div=4)
// still pass, while pure growth no-divs (NETWEB) correctly don't.
function classifyBasket(rec) {
  const snow = rec.snowflake;
  if (!snow) return null;
  const beta = num(rec.beta, null);
  const upsideRaw = rec.upside_pct;
  const hasUpside = upsideRaw != null && Number.isFinite(upsideRaw);
  const upside = num(upsideRaw, 0);
  const v4Verdict = rec.v4_verdict || rec.verdict;
  const v4Score = num(rec.v4_score, 0);
  const risksFlag = rec.v2_breakdown?.risks_flag === true;

  // PR 2.4 — fresh-pick basket gate: require upside ≥ 5% to FV. Holdings
  // (source: holding) keep flowing through their per-stock action ladder,
  // which already enforces upside floors per rung; fresh picks bypass that
  // ladder, so the gate is applied here. Without this, the analyzer was
  // surfacing BSOFT (-17.5%), NAVNETEDUL (-19.2%), NATIONALUM (-5.9%) as
  // "fresh top-up" suggestions despite the engine itself saying they're
  // already above fair value.
  const isFresh = rec.source === "fresh";
  if (isFresh && (!hasUpside || upside < 5)) {
    return { defensive: false, growth: false };
  }

  // Tier B "Perfect Fit" floor — only applied to fresh picks (holdings
  // already gate at the per-stock action ladder). Tightens what reaches
  // the user-facing baskets to v3 ≥ 45, snowflake_total ≥ 16, upside ≥ 8%
  // and a clean surveillance/risk profile. Without this, mid-quality
  // picks (v3 30-45) leak into the basket grid and dilute the
  // SEBI-analyst framing.
  if (isFresh) {
    const surveillanceClean =
      rec.surveillance == null ||
      rec.surveillance === "none" ||
      rec.surveillance === false ||
      rec.surveillance === "";
    const passesPerfectFit =
      v4Score >= PERFECT_FIT_FLOOR.v4 &&
      num(snow.total, 0) >= PERFECT_FIT_FLOOR.snowflake_total &&
      hasUpside && upside >= PERFECT_FIT_FLOOR.upside_pct &&
      !risksFlag &&
      surveillanceClean;
    if (!passesPerfectFit) {
      return { defensive: false, growth: false };
    }
  }

  const passesDefensive =
    snow.financial_health >= 4 &&
    snow.dividends >= 2 &&
    (beta == null || beta < 0.9) &&
    !risksFlag;

  // Growth: any of (a) v3 verdict says STRONG/TOP_PICK, OR (b) future
  // pillar high + meaningful upside. Either gate is sufficient — no
  // longer requires the v1 verdict label.
  const passesGrowth =
    !risksFlag && (
      ["TOP_PICK", "STRONG"].includes(v4Verdict) ||
      (snow.future_growth >= 4 && upside >= 10) ||
      v4Score >= 47
    );

  return { defensive: passesDefensive, growth: passesGrowth };
}

function hoursSinceIso(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.round((Date.now() - ms) / 3_600_000);
}

function holdingToBasketRow(h) {
  const snow = h.sws.snowflake;
  const ov = h.sws;
  return {
    source: "holding",
    ticker: h.sws.ticker,
    name: h.sws.name,
    sector: h.sws.sector,
    snowflake: snow,
    snowflake_total: snow.total,
    verdict: h.sws.verdict,
    v4_score: h.sws.v4_score,
    v2_score: h.sws.v2_score,
    current_price_inr: ov.current_price_inr,
    fair_value_inr: ov.fair_value_inr,
    upside_pct: ov.upside_pct,
    valuation_confidence: ov.valuation_confidence ?? null,
    valuation_source: ov.valuation_source ?? null,
    valuation_band: ov.valuation_band ?? null,
    data_age_hours: ov.data_age_hours ?? null,
    staleData: h.staleData ?? false,
    priceSource: h.priceSource ?? null,
    currentValue: h.currentValue ?? null,
    positionWeight: h.positionWeight ?? null,
    sectorWeight: h.sectorWeight ?? null,
    rawAction: h.action,
    topUpRupeesResearch: Number.isFinite(h.topUpRupees) ? Number(h.topUpRupees) : null,
    beta: ov.beta ?? null,
    market_cap_inr: ov.market_cap_inr,
    multiples: ov.multiples,
    dividend_yield_pct: ov.dividend_yield_pct,
    net_margin_pct: ov.net_margin_pct,
    earnings_growth_pct: ov.earnings_growth_pct,
    returns_pct: ov.returns_pct,
    next_earnings_date: ov.next_earnings_date,
    last_earnings_date: h.sws.last_earnings_date ?? null,
    last_earnings_period: h.sws.last_earnings_period ?? null,
    v2_breakdown: ov.v2_breakdown,
    surveillance: ov.surveillance,
    timing: h.timing,
    action: h.action,
    sws_url: h.sws.sws_url,
  };
}

function pickToBasketRow(pick) {
  const deep = loadSWSDeep(pick.ticker);
  const snow = deep ? pickSnowflake(deep) : pick.snowflake;
  const ov = deep?.overview || {};
  const fiscal = deep?.fiscal || {};
  // Run the same FV/upside reconciliation as in-portfolio holdings so fresh
  // picks (CARERATING, CEINSYS, etc.) don't surface raw scraper values
  // ("65.68440275587282%") in the basket UI. Falls back to picks-latest
  // values when the deep file is missing.
  const reconciled = _reconcileFVUpside({
    current_price_inr: ov.current_price_inr ?? pick.current_price_inr,
    fair_value_inr: ov.fair_value_inr ?? pick.fair_value_inr,
    upside_pct: ov.upside_pct ?? pick.upside_pct,
  });
  return {
    source: "fresh",
    ticker: pick.ticker,
    name: pick.name,
    sector: pick.sector,
    snowflake: snow,
    snowflake_total: snow?.total ?? pick.snowflake_total,
    verdict: pick.verdict,
    v4_score: pick.v4_score_100 ?? pick.v4_score ?? null,
    v2_score: pick.v2_score,
    current_price_inr: ov.current_price_inr ?? pick.current_price_inr,
    fair_value_inr: reconciled.fair_value_inr,
    upside_pct: reconciled.upside_pct,
    valuation_confidence: reconciled.confidence,
    valuation_source: reconciled.source,
    valuation_band: reconciled.valuation_band,
    data_age_hours: hoursSinceIso(deep?.parsed_at ?? pick.parsed_at ?? pick.scanned_at),
    beta: ov.beta ?? null,
    market_cap_inr: ov.market_cap_inr ?? pick.market_cap_inr,
    multiples: ov.multiples ?? null,
    dividend_yield_pct: ov.dividend?.yield_pct ?? ov.dividend_yield_pct ?? null,
    net_margin_pct: fiscal.net_margin_pct ?? ov.net_margin_pct ?? null,
    earnings_growth_pct: fiscal.earnings_growth_pct ?? null,
    returns_pct: ov.returns_pct ?? null,
    next_earnings_date: ov.next_earnings_date ?? pick.next_earnings_date,
    last_earnings_date: pick.last_earnings_date ?? null,
    last_earnings_period: pick.last_earnings_period ?? null,
    v2_breakdown: pick.v2_breakdown,
    surveillance: pick.v2_breakdown?.surveillance ?? null,
    sws_url: pick.sws_url ?? null,
  };
}

// Outside-portfolio fresh picks — surfaces a structured list of
// candidates from 4 picks-latest buckets, set-diffed against the user's
// held tickers, split into defensive (quality_growth + deep_value) and
// growth (top_ranked_30_v3 + smallcap_gems).
//
// Trigger: fires when fresh capital > 0 OR top-5 holdings > 50% of book
// (concentration risk). This surface is candidate-only; executable rupee
// sizing is produced exclusively by portfolioConstructionPlan.
//
// Gated by OUTSIDE_PICKS=1 env flag per PR-4 plan.
export function surfaceOutsidePicks({ scoredHoldings, freshCapitalInr, limit = 12, forceEnabled = false }) {
  if (!forceEnabled && process.env.OUTSIDE_PICKS !== "1") {
    return { available: false, reason: "OUTSIDE_PICKS feature flag disabled" };
  }

  const totalValue = scoredHoldings.reduce((s, h) => s + (num(h.currentValue, 0) || 0), 0);
  if (totalValue <= 0) {
    return { available: false, reason: "No portfolio value to compute concentration." };
  }

  // Concentration score = top-5 holdings as % of book. ≥50% = trigger.
  const sortedByValue = [...scoredHoldings]
    .filter((h) => num(h.currentValue, 0) > 0)
    .sort((a, b) => num(b.currentValue, 0) - num(a.currentValue, 0));
  const top5Value = sortedByValue.slice(0, 5).reduce((s, h) => s + num(h.currentValue, 0), 0);
  const concentrationPct = +((top5Value / totalValue) * 100).toFixed(1);

  const hasFreshCapital = num(freshCapitalInr, 0) > 0;
  const isOverConcentrated = concentrationPct >= 50;
  if (!hasFreshCapital && !isOverConcentrated) {
    return {
      available: false,
      reason: "No fresh capital and concentration < 50% — outside picks not surfaced.",
      concentrationPct,
    };
  }

  const heldTickers = new Set(
    scoredHoldings.filter((h) => h.swsCovered && h.sws?.ticker).map((h) => h.sws.ticker),
  );
  const picks = loadPicksLatest();
  const sections = picks?.sections || {};

  // Pull from 4 buckets, set-diff against held. The plan calls out
  // top_ranked_30_v3 (the v3-aware ranking) — we fall back to
  // top_ranked_30 if the v3 variant isn't populated.
  const growthSrc = [
    ...(sections.top_ranked_30_v3 || sections.top_ranked_30 || []),
    ...(sections.smallcap_gems || []),
  ].filter((p) => p?.ticker && !heldTickers.has(p.ticker));

  const defensiveSrc = [
    ...(sections.quality_growth || []),
    ...(sections.deep_value || []),
  ].filter((p) => p?.ticker && !heldTickers.has(p.ticker));

  // Dedupe within each list, then take top by v4_score. Cross-bucket
  // dedupe runs after — if a ticker qualifies for both growth and
  // defensive buckets (common: a top-ranked v3 name with strong
  // quality_growth metrics), it stays in growth (the higher-priority
  // surface) and is removed from defensive so the user doesn't see
  // duplicates.
  const dedupe = (arr) => {
    const seen = new Set();
    const out = [];
    for (const p of arr.sort((a, b) => num(b.v4_score, 0) - num(a.v4_score, 0))) {
      if (seen.has(p.ticker)) continue;
      seen.add(p.ticker);
      out.push(p);
    }
    return out;
  };
  const growth = dedupe(growthSrc).slice(0, Math.ceil(limit / 2));
  const growthTickers = new Set(growth.map((p) => p.ticker));
  const defensive = dedupe(defensiveSrc)
    .filter((p) => !growthTickers.has(p.ticker))
    .slice(0, Math.floor(limit / 2));

  const totalPicks = growth.length + defensive.length;

  // Annotate each row with source + candidate-only metadata. No rupee
  // allocation is attached here; funded trades come from constructionPlan.
  const annotateBucket = (rows, basketLabel) => rows.map((p) => {
    const baseRow = pickToBasketRow(p);
    return {
      ...baseRow,
      source: "fresh",
      basket: basketLabel,
      candidate_only: true,
    };
  });

  return {
    available: true,
    concentrationPct,
    triggerReasons: [
      hasFreshCapital ? `Fresh capital ₹${freshCapitalInr.toLocaleString("en-IN")} available` : null,
      isOverConcentrated ? `Top-5 holdings = ${concentrationPct}% of book (≥50% trigger)` : null,
    ].filter(Boolean),
    growth: annotateBucket(growth, "growth"),
    defensive: annotateBucket(defensive, "defensive"),
    counts: {
      growth: growth.length,
      defensive: defensive.length,
      total: totalPicks,
    },
    methodology:
      `Picks: top_ranked_30_v3 + smallcap_gems (growth) and quality_growth + deep_value (defensive), ` +
      `set-diffed against your ${heldTickers.size} held ticker(s). Candidate-only surface; funded rupees ` +
      `come from the construction plan after budget, valuation confidence, freshness, and post-trade caps. ` +
      `Always opt-in via OUTSIDE_PICKS=1.`,
  };
}

function buildBaskets({ scoredHoldings, freshPickLimit, sectorOverlay, macroRegime }) {
  const heldTickers = new Set(scoredHoldings.filter((h) => h.swsCovered).map((h) => h.sws.ticker));

  // Source 1: in-portfolio top-up candidates
  const topupHoldings = scoredHoldings
    .filter((h) => h.swsCovered && TOPUP_ACTIONS.has(h.action))
    .map(holdingToBasketRow);

  // Source 2: outside-portfolio fresh picks
  const picks = loadPicksLatest();
  const sections = picks?.sections || {};

  // Sector context — drives the "perfect add for *this* portfolio" gating.
  // Built once and reused for both the 3-basket grid filter and the new
  // Sector Gap Spotlight basket.
  const sectorCtx = buildSectorContext(sectorOverlay || [], picks, macroRegime || null);
  const seedGrowth = (sections.top_ranked_30 || []).filter((p) => !heldTickers.has(p.ticker));
  const seedDefensive = (sections.dividend_aristocrats || []).filter((p) => !heldTickers.has(p.ticker));

  const candidatePicks = new Map();
  for (const p of seedGrowth) candidatePicks.set(p.ticker, p);
  for (const p of seedDefensive) if (!candidatePicks.has(p.ticker)) candidatePicks.set(p.ticker, p);

  // Defensive fallback: scan deep/ for high-health + dividend stocks if seed is thin
  if (seedDefensive.length < freshPickLimit) {
    let scanned = 0;
    try {
      const tickers = listDeepTickers();
      for (const ticker of tickers) {
        if (scanned >= 200) break; // soft cap to keep this quick
        scanned++;
        if (heldTickers.has(ticker) || candidatePicks.has(ticker)) continue;
        const deep = loadSWSDeep(ticker);
        if (!deep) continue;
        const snow = pickSnowflake(deep);
        if (snow.financial_health < 5 || snow.dividends < 3) continue;
        const ov = deep.overview || {};
        const beta = num(ov.beta, null);
        if (beta != null && beta >= 0.7) continue;
        // Fabricate a pick-shaped record
        const scored = scoreHolding({ symbol: ticker, positionWeight: 0, sectorWeight: 0, pnlPercent: 0 }, { sectorWeights: {} });
        if (!scored.swsCovered) continue;
        candidatePicks.set(ticker, {
          ticker,
          name: scored.sws.name,
          sector: scored.sws.sector,
          verdict: scored.sws.verdict,
          v4_score: scored.sws.v4_score,
          v2_score: scored.sws.v2_score,
          snowflake_total: snow.total,
          snowflake: snow,
          current_price_inr: scored.sws.current_price_inr,
          fair_value_inr: scored.sws.fair_value_inr,
          upside_pct: scored.sws.upside_pct,
          market_cap_inr: scored.sws.market_cap_inr,
          v2_breakdown: scored.sws.v2_breakdown,
          sws_url: scored.sws.sws_url,
        });
      }
    } catch {}
  }

  const freshRows = [...candidatePicks.values()].map(pickToBasketRow);

  // Combine and classify
  const combined = [...topupHoldings, ...freshRows];

  // Attach sector-fit metadata to every row up-front so we can both gate
  // overweight-sector fresh picks AND surface sector-fit reasons on rows
  // that survive into the existing 3-basket grid.
  let gatedOverweightSector = 0;
  for (const row of combined) {
    const fit = scoreSectorFit(row.sector, sectorCtx);
    row._sectorFit = fit;
    row.perfectFitScore = num(row.v4_score, 0) + (fit.score === -999 ? 0 : fit.score);
    row.whyFit = buildPerfectFitReason(row, sectorCtx, fit);
  }

  const passesDefensive = [];
  const passesGrowth = [];
  const passesBoth = [];

  for (const row of combined) {
    const c = classifyBasket(row);
    if (!c) continue;

    // Sector-fit gating: drop fresh picks whose sector is already
    // overweight (≥20% of book). Holdings are exempt — the user already
    // owns them, and reducing/holding is the action ladder's job, not
    // the basket selector's. The graceful fallback below relaxes this
    // when a basket would otherwise be empty.
    if (row.source === "fresh" && row._sectorFit?.gapType === "overweight") {
      gatedOverweightSector++;
      continue;
    }

    if (c.defensive && c.growth) passesBoth.push(row);
    else if (c.defensive) passesDefensive.push(row);
    else if (c.growth) passesGrowth.push(row);
  }

  // Sort each by perfectFitScore desc (= v3 + sector-fit bonus). A
  // tailwind-missing-sector v3=50 candidate now beats a sector-saturated
  // v3=70 candidate, exactly the point of the perfect-fit framing.
  const byPerfectFit = (a, b) => num(b.perfectFitScore, 0) - num(a.perfectFitScore, 0);
  passesDefensive.sort(byPerfectFit);
  passesGrowth.sort(byPerfectFit);
  passesBoth.sort(byPerfectFit);

  // Shared Core: top 3 from passesBoth
  let core = passesBoth.slice(0, 3);
  const coreTickers = new Set(core.map((r) => r.ticker));

  // Each basket: prefer pure-bucket passes, then fall through to passesBoth (excluding core)
  let defensive = [
    ...passesDefensive,
    ...passesBoth.filter((r) => !coreTickers.has(r.ticker)),
  ].slice(0, freshPickLimit);

  let growth = [
    ...passesGrowth,
    ...passesBoth.filter((r) => !coreTickers.has(r.ticker)),
  ].slice(0, freshPickLimit);

  // Graceful fallback — if sector-fit gating left a basket nearly empty,
  // re-include the overweight-sector candidates we skipped, but flag
  // them so the UI shows "consider trimming first" copy. Better to
  // surface something with an honest caveat than show a blank card.
  const fallbackEmpty = (basketLen, label) => {
    if (basketLen >= 3) return [];
    const fallback = [];
    for (const row of combined) {
      if (row.source !== "fresh") continue;
      if (row._sectorFit?.gapType !== "overweight") continue;
      const c = classifyBasket(row);
      if (!c) continue;
      const matches =
        label === "defensive" ? c.defensive :
        label === "growth"    ? c.growth    :
                                (c.defensive && c.growth);
      if (!matches) continue;
      fallback.push({
        ...row,
        whyFit: `${row._sectorFit.canonical || row.sector || ""} already heavy — consider trimming first`,
      });
    }
    fallback.sort(byPerfectFit);
    return fallback;
  };
  if (defensive.length < 3) defensive = [...defensive, ...fallbackEmpty(defensive.length, "defensive")].slice(0, freshPickLimit);
  if (growth.length < 3)    growth    = [...growth,    ...fallbackEmpty(growth.length,    "growth")].slice(0, freshPickLimit);
  if (core.length < 3)      core      = [...core,      ...fallbackEmpty(core.length,      "core")].slice(0, 3);

  // New "Sector Gap Spotlight" basket — explicit "what your portfolio is
  // missing". Independent of Defensive/Growth/Core; pulls from fresh
  // picks whose sector is missing/underweight AND tailwind-favourable,
  // capped at 1/sector for diversity.
  const sectorGaps = selectSectorGapPicks(combined, sectorCtx, { limit: 5 });

  // Surface the tailwind set so the UI's spotlight subtitle can name
  // 1-2 sectors the user is missing — even when sectorGaps itself is
  // empty (e.g. user holds all 6 structural sectors at non-zero weight).
  const tailwindSummary = [];
  for (const [sector, info] of sectorCtx.tailwind) {
    if (sectorCtx.overweight.has(sector)) continue;
    const currentPct = sectorCtx.byCanonical.get(sector) ?? 0;
    tailwindSummary.push({
      sector,
      currentPct: +currentPct.toFixed(1),
      tailwindScore: info.score,
      gapType: currentPct === 0 ? "missing" : sectorCtx.underweight.has(sector) ? "underweight" : "healthy",
      evidence: info.evidence,
    });
  }
  tailwindSummary.sort((a, b) => {
    // Missing+high-score first
    const gapRank = (g) => g === "missing" ? 0 : g === "underweight" ? 1 : 2;
    const ga = gapRank(a.gapType), gb = gapRank(b.gapType);
    if (ga !== gb) return ga - gb;
    return b.tailwindScore - a.tailwindScore;
  });

  return {
    defensive,
    growth,
    core,
    sectorGaps,
    tailwindSummary,
    counts: {
      topup_in_portfolio: topupHoldings.length,
      fresh_picks_seed: freshRows.length,
      passes_defensive: passesDefensive.length,
      passes_growth: passesGrowth.length,
      passes_both: passesBoth.length,
      gated_overweight_sector: gatedOverweightSector,
      sector_gaps: sectorGaps.length,
    },
  };
}

function buildSectorOverlay(scoredHoldings) {
  const bySector = new Map();
  let totalCV = 0;
  for (const h of scoredHoldings) {
    const cv = num(h.currentValue, 0);
    totalCV += cv;
    // Same precedence as server.js's first pass: prefer the curated
    // stockList sector (proper case, consistent vocabulary) over the SWS
    // deep-file sector to keep the overlay from fragmenting into
    // case-variant duplicates ("energy" vs "Energy", "utilities" vs
    // "Utilities"). SWS only fills in when stockList has none.
    const sector = h.sector || (h.swsCovered ? h.sws.sector : null) || "Unclassified";
    if (!bySector.has(sector)) bySector.set(sector, { sector, currentValue: 0, holdings: [], avgSnowflake: 0, avgV3: 0, _snowSum: 0, _v3Sum: 0, _n: 0 });
    const row = bySector.get(sector);
    row.currentValue += cv;
    row.holdings.push(h.sws?.ticker || h.symbol);
    if (h.swsCovered) {
      row._snowSum += num(h.sws.snowflake_total, 0);
      row._v3Sum += num(h.sws.v4_score, 0);
      row._n += 1;
    }
  }
  const out = [];
  for (const row of bySector.values()) {
    out.push({
      sector: row.sector,
      currentValue: Math.round(row.currentValue),
      pct: totalCV > 0 ? Math.round((row.currentValue / totalCV) * 1000) / 10 : 0,
      holdings: row.holdings,
      avgSnowflake: row._n ? Math.round(row._snowSum / row._n * 10) / 10 : null,
      avgV3: row._n ? Math.round(row._v3Sum / row._n * 10) / 10 : null,
    });
  }
  out.sort((a, b) => b.currentValue - a.currentValue);
  return out;
}

function buildSnapshot(scoredHoldings) {
  let totalCV = 0;
  let totalInv = 0;
  let snowSum = 0;
  let snowN = 0;
  let v3Sum = 0;
  let v3N = 0;
  const verdictMix = {};
  const actionMix = {};
  let coveredCount = 0;

  for (const h of scoredHoldings) {
    totalCV += num(h.currentValue, 0);
    totalInv += num(h.invested, 0);
    if (h.action) actionMix[h.action] = (actionMix[h.action] || 0) + 1;
    if (h.swsCovered) {
      coveredCount++;
      snowSum += num(h.sws.snowflake_total, 0);
      snowN++;
      v3Sum += num(h.sws.v4_score, 0);
      v3N++;
      const verdict = h.sws.verdict || "n/a";
      verdictMix[verdict] = (verdictMix[verdict] || 0) + 1;
    }
  }

  return {
    totalInvested: Math.round(totalInv),
    totalCurrent: Math.round(totalCV),
    totalPnL: Math.round(totalCV - totalInv),
    totalPnLPct: totalInv > 0 ? Math.round((totalCV - totalInv) / totalInv * 1000) / 10 : 0,
    coveredCount,
    holdingsCount: scoredHoldings.length,
    avgSnowflake: snowN ? Math.round(snowSum / snowN * 10) / 10 : null,
    avgV3Score: v3N ? Math.round(v3Sum / v3N * 10) / 10 : null,
    verdictMix,
    actionMix,
  };
}

// Apply macro-regime tilt to a list of basket rows. Each row's v4_score
// is shifted by half the regime delta (portfolio scores move less than
// scanner scores per the legacy convention). Pure transform; mutates a
// copy, not the input.
function _applyMacroTilt(rows, regime) {
  if (!regime || !_computeMacroDelta) return rows.map((r) => ({ ...r }));
  return rows.map((r) => {
    const tilt = _computeMacroDelta(regime, r.sector);
    if (!tilt || !tilt.delta) return { ...r, macro_delta: 0, macro_reason: null };
    return {
      ...r,
      macro_delta: +(tilt.delta * 0.5).toFixed(2),
      macro_reason: tilt.reason,
      v4_score: num(r.v4_score, 0) + tilt.delta * 0.5,
    };
  });
}

/**
 * Recompute the action-driven slices of `report` after the cooldown-demotion
 * pass rewrites holdings' `action` field. Touches the minimum surface:
 * tiers A/C/D, sector-wipeout, snapshot.actionMix, holdingsByAction. Baskets
 * (Tier B) and sector overlay are left alone — they don't read `h.action`
 * for filtering, and rebuilding them would re-run the outside-picks scanner.
 */
export function rebuildTierAggregates(report, scoredHoldings) {
  if (!report || !Array.isArray(scoredHoldings)) return report;

  const tiers = buildTiers(scoredHoldings);

  const reductionTickers = new Set(
    tiers.tierA.map((h) => h.sws?.ticker || h.symbol).filter(Boolean),
  );
  const sectorWipeouts = detectSectorWipeout({ scoredHoldings, reductionTickers });

  const freedByTicker = new Map(
    tiers.tierA.map((h) => [h.sws?.ticker || h.symbol, h.freedRupees]),
  );
  const holdingsByAction = {};
  for (const h of scoredHoldings) {
    if (!h.action) continue;
    const tk = h.sws?.ticker || h.symbol;
    const enriched = { ...h, freedRupees: freedByTicker.get(tk) ?? null };
    (holdingsByAction[h.action] ||= []).push(enriched);
  }

  const actionMix = {};
  for (const h of scoredHoldings) {
    if (h.action) actionMix[h.action] = (actionMix[h.action] || 0) + 1;
  }

  const prevTierA = report.tiers?.A || {};
  const prevTierC = report.tiers?.C || {};
  const prevTierD = report.tiers?.D || {};
  report.tiers = {
    ...report.tiers,
    A: { ...prevTierA, rows: tiers.tierA, freedRupees: tiers.freedRupees, sector_wipeouts: sectorWipeouts },
    C: { ...prevTierC, rows: tiers.tierC },
    D: { ...prevTierD, rows: tiers.tierD },
  };
  report.holdingsByAction = holdingsByAction;
  if (report.snapshot) report.snapshot.actionMix = actionMix;

  return report;
}

export function buildSWSReport(scoredHoldings, opts = {}) {
  const freshCapitalInr = opts.freshCapitalInr ?? null;
  const freshPickLimit = opts.freshPickLimit ?? 8;
  const macroRegime = opts.macroRegime ?? null;
  const uploadedAtIso = opts.uploadedAtIso ?? null;
  const asOfDateIso = opts.asOfDateIso ?? null;
  const brokerSummary = opts.brokerSummary ?? null;

  attachDividendsToHoldings(scoredHoldings, loadDividendsUpcoming());

  const tiers = buildTiers(scoredHoldings);
  // sectorOverlay must be built before baskets — buildBaskets uses the
  // overlay to compute sector-fit scores ("perfect add for *this*
  // portfolio") and the new Sector Gap Spotlight basket.
  const sectorOverlay = buildSectorOverlay(scoredHoldings);
  const baskets = buildBaskets({
    scoredHoldings,
    freshPickLimit,
    sectorOverlay,
    macroRegime,
  });
  const snapshot = buildSnapshot(scoredHoldings);
  snapshot.portfolioHealth = computePortfolioHealth(snapshot, scoredHoldings, {
    macroRegime,
    asOf: new Date().toISOString(),
  });

  // PR-4: outside-portfolio fresh picks — surface 10-12 candidates from
  // picks-latest.json (set-diffed against held tickers) when fresh
  // capital is available OR top-5 holdings dominate the book. Gated by
  // OUTSIDE_PICKS=1 env flag (returns { available: false } otherwise).
  const outsidePicks = surfaceOutsidePicks({ scoredHoldings, freshCapitalInr });

  // Macro tilt — only applied to Tier B baskets (the recommendations
  // surface). The per-stock action grid (Tier A / C / D) shows the
  // un-tilted SWS view to keep the user-facing verdict deterministic.
  if (macroRegime) {
    baskets.defensive = _applyMacroTilt(baskets.defensive, macroRegime);
    baskets.growth = _applyMacroTilt(baskets.growth, macroRegime);
    baskets.core = _applyMacroTilt(baskets.core, macroRegime);
    baskets.sectorGaps = _applyMacroTilt(baskets.sectorGaps || [], macroRegime);
    baskets.macro_regime = {
      regime: macroRegime.regime || null,
      severity: macroRegime.severity || null,
      confidence: macroRegime.confidence || null,
    };
  }

  // Sector-wipeout guard — flag any sector that would be left at zero
  // exposure if all reductions executed. Surfaces gap #7 from the real
  // portfolio diagnostic (CIPLA Reduction-50% leaves zero pharma).
  const reductionTickers = new Set(
    tiers.tierA.map((h) => h.sws?.ticker || h.symbol).filter(Boolean),
  );
  const sectorWipeouts = detectSectorWipeout({ scoredHoldings, reductionTickers });

  const picks = loadPicksLatest();
  // Banner timestamp = when the user gave us this data, NOT when we last
  // scanned the universe. The legacy behaviour (snapshot_at = picks.scanned_at)
  // made every fresh upload look stale because the SWS pipeline timestamp
  // could be hours older than the upload. SWS scan time stays available as
  // a separate field (sws_scanned_at) so the renderer can show both.
  const banner = {
    engine: "SWS Engine (Beta)",
    snapshot_at: uploadedAtIso ?? null,
    statement_as_of: asOfDateIso ?? null,
    sws_scanned_at: picks?.scanned_at ?? null,
    universe_size: picks?.universe_size ?? null,
    coverage_text: `${snapshot.coveredCount}/${snapshot.holdingsCount} holdings have SWS data`,
    broker_summary: brokerSummary
      ? {
          invested: Number.isFinite(brokerSummary.invested) ? brokerSummary.invested : null,
          current: Number.isFinite(brokerSummary.current) ? brokerSummary.current : null,
          unrealisedPL: Number.isFinite(brokerSummary.unrealisedPL) ? brokerSummary.unrealisedPL : null,
          asOfDate: brokerSummary.asOfDate || null,
        }
      : null,
  };

  // Group every scored holding by its action so the Action Mix pills in
  // the UI can open a per-action stock list. Tier B baskets gate top-up
  // holdings through classifyBasket — so a holding can be counted in
  // actionMix without surfacing in any visible tier table. This map is
  // the source of truth for "show me the N stocks marked X".
  const freedByTicker = new Map(
    tiers.tierA.map((h) => [h.sws?.ticker || h.symbol, h.freedRupees]),
  );
  const holdingsByAction = {};
  for (const h of scoredHoldings) {
    if (!h.action) continue;
    const tk = h.sws?.ticker || h.symbol;
    const enriched = { ...h, freedRupees: freedByTicker.get(tk) ?? null };
    (holdingsByAction[h.action] ||= []).push(enriched);
  }

  return {
    engine: "sws",
    banner,
    snapshot,
    outsidePicks,
    tiers: {
      A: { label: "Reductions", rows: tiers.tierA, freedRupees: tiers.freedRupees, sector_wipeouts: sectorWipeouts },
      B: { label: "Eligible but unfunded add candidates", baskets },
      C: { label: "Hold as-is", rows: tiers.tierC },
      D: { label: "Watch (catalyst-driven)", rows: tiers.tierD },
    },
    holdingsByAction,
    sectorOverlay,
    capitalContext: {
      freshCapitalInr: Number.isFinite(Number(freshCapitalInr)) ? Number(freshCapitalInr) : 0,
    },
  };
}
