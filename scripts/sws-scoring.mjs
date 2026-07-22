// Composite score + verdict + category logic for SWS-scraped per-stock JSONs.
// Pure-JS, deterministic, runs after Layer 1 scrape completes.
// Inputs: per-stock JSON written by sws-parse-capture.mjs.
// Outputs: { composite_score_100, verdict, categories[] } added to each stock,
//          V4 score contracts and a leaderboard JSON written to data/sws/picks-latest.json.

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./sws-config.mjs";
import { computeV4Score, verdictV4FromScore, buildFvCompositeIndustryAverages } from "./swsScoringV4.mjs";
import { buildFvUpsideBenchmark } from "../services/scoring/fvUpsideRelative.js";
import { stampEntryTimingOnSections } from "../services/entry/stampEntryTiming.js";
import { getTechnicals } from "../services/entry/technicalStoreReader.js";
import {
  reconcileFairValue,
  valuationBandFromUpside as canonicalValuationBandFromUpside,
  withReconciledFairValue,
  applyUpsideHaircut,
} from "../services/fvReconciliation.js";
import { buildGrowingSectorValueSection } from "../services/swsGrowingSectorValue.js";
import { buildSnowflakeGapLabSection, buildSnowflakeGapPeerAverages } from "../services/swsSnowflakeGapLab.js";
import {
  buildActionableTodayAudit,
  buildEntryBand,
  compareIndiaSectionRank,
  isActionableTodayCandidate,
  swsFundamentalsSubtotal,
} from "../services/swsIndiaSectionPolicy.js";

// Surveillance lookup is optional — gracefully degrades if module not available.
// Loaded once at module init; the underlying snapshot is cached in surveillance.js.
let _getSurveillanceFlag = () => null;
try {
  const mod = await import("../surveillance.js");
  if (typeof mod.getSurveillanceFlag === "function") _getSurveillanceFlag = mod.getSurveillanceFlag;
} catch {}

// ---------- Composite score (0-100) ----------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

// Schema/scoring versions emitted in picks-latest.json so external readers
// (UI, audit consumers, partner dashboards) can detect a model migration.
// Bump PICKS_SCHEMA_VERSION on a breaking field rename; bump
// PICKS_SCORING_VERSION when scoring math changes.
export const PICKS_SCHEMA_VERSION = "picks-latest-v4";
export const PICKS_SCORING_VERSION = "sws-v4.1-100pt-2026-07";

// 13 input fields the scoring engine looks at. Track which were populated
// so we can flag thin-coverage names rather than silently scoring missing
// inputs as zero.
const _COMPLETENESS_FIELDS = 13;
function dataCompletenessPct(stock) {
  const ov = stock.overview || {};
  const sn = ov.snowflake || {};
  const r = ov.returns_pct || {};
  const isFin = (v) => typeof v === "number" && Number.isFinite(v);
  const populated = [
    isFin(sn.financial_health ?? sn.health),
    isFin(sn.future ?? sn.future_growth),
    isFin(sn.valuation ?? sn.value),
    isFin(sn.past ?? sn.past_performance),
    isFin(sn.dividends ?? sn.dividend),
    isFin(ov.upside_pct),
    isFin(r["1Y"]),
    isFin(r["3M"]),
    isFin(r["1M"]),
    isFin(ov.net_margin_pct),
    isFin(ov.multiples?.pe),
    isFin(ov.dividend?.yield_pct),
    isFin(ov.market_cap_inr),
  ].filter(Boolean).length;
  return Math.round((populated / _COMPLETENESS_FIELDS) * 100);
}

// Lite counter-thesis emitter for the static picks file. Mirrors the helper
// in services/swsScoring.js — keep in sync. Inputs are overview, snowflake,
// V4 breakdown; no holding-level layer outputs needed.
function buildPickCounterThesis(stock) {
  const ov = stock.overview || {};
  const sn = ov.snowflake || {};
  const v4 = stock.v4_breakdown || {};
  const verdict = stock.v4_verdict || "WATCH";
  const isBull = verdict === "TOP_PICK" || verdict === "STRONG";
  const isBear = verdict === "AVOID";

  const opposing = [];
  if (isBull) {
    const risksCount = (ov.risks || []).length;
    if (risksCount >= 4) opposing.push(`${risksCount} flagged risks in SWS profile`);
    if (v4.surveillance) opposing.push(`stock is on NSE ${v4.surveillance.list} surveillance`);
    if (v4.fv_imputed) opposing.push(`fair-value upside imputed (no SWS analyst FV) — score may overstate price-vs-FV cushion`);
    const valSnow = num(sn.valuation ?? sn.value, 6);
    if (valSnow <= 2) opposing.push(`valuation pillar weak (${valSnow}/6) despite overall ${verdict}`);
    if (num(ov.upside_pct, 0) < 0) opposing.push(`current price already above SWS analyst FV (${num(ov.upside_pct, 0).toFixed(1)}%)`);
    const ret1m = num((ov.returns_pct || {})["1M"], null);
    if (ret1m != null && ret1m > 25) opposing.push(`+${ret1m.toFixed(1)}% in 1M — momentum chase risk`);
    if (ov.next_earnings_date) {
      const days = Math.ceil((new Date(ov.next_earnings_date + "T00:00:00Z") - new Date()) / 86400000);
      if (days >= 0 && days <= 14) opposing.push(`earnings in ${days}d — binary event`);
    }
  } else if (isBear) {
    if (num(ov.snowflake_total, 0) >= 18) opposing.push(`snowflake ${ov.snowflake_total}/30 still solid despite AVOID verdict`);
    if (num(ov.upside_pct, 0) >= 30) opposing.push(`+${num(ov.upside_pct, 0).toFixed(1)}% to SWS FV — discount may price the negatives in`);
    const insiderBuys = (ov.insider_activity || []).filter((x) => x?.direction === "buy").length;
    if (insiderBuys >= 1) opposing.push(`${insiderBuys} insider buy(s) on file`);
    if ((ov.recent_analyst_revisions || []).some((rev) => rev.direction === "increased")) opposing.push(`recent analyst PT raise — broker view diverges`);
    const ret1y = num((ov.returns_pct || {})["1Y"], null);
    if (ret1y != null && ret1y > 20) opposing.push(`+${ret1y.toFixed(1)}% over 1Y — trend is up despite verdict`);
  } else {
    if (num(ov.snowflake_total, 0) >= 22) opposing.push(`snowflake ${ov.snowflake_total}/30 above ACCEPTABLE cut`);
    if ((ov.risks || []).length >= 4) opposing.push(`${(ov.risks || []).length} flagged risks weigh against any optimistic read`);
  }

  const text = opposing.length === 0
    ? `No strong opposing signal in the layer outputs — single-source view; verify thesis independently before acting.`
    : opposing.join("; ") + ".";

  const triggers = [];
  if (isBull) {
    triggers.push("next quarterly result misses estimates");
    triggers.push("a new India-risk overlay materialises (ASM/GSM, promoter pledge spike)");
    if (num(ov.upside_pct, 0) > 20) triggers.push(`upside vs SWS FV compresses below 5% (currently ${num(ov.upside_pct, 0).toFixed(1)}%)`);
    else triggers.push("snowflake total drops by ≥ 4 points on next refresh");
  } else if (isBear) {
    triggers.push("next quarterly result beats consensus by ≥ 10%");
    triggers.push("a new analyst PT is raised by ≥ 15%");
    if (v4.surveillance) triggers.push(`NSE removes the ${v4.surveillance.list} surveillance flag`);
    else triggers.push("snowflake total rebounds above 22 on next refresh");
  } else {
    triggers.push("a material catalyst lands in the next 30 days (PT raise / beat / surveillance change)");
    triggers.push("V4 score moves into TOP_PICK (≥59) or AVOID (<28) on next refresh");
  }

  return {
    verdict_bias: isBull ? "bullish" : isBear ? "bearish" : "neutral",
    text,
    falsification_trigger: triggers,
  };
}

// Slim per-pick audit blob — captures the inputs that drove the score so a
// compliance-style review can reconstruct the verdict from the static file
// without hitting the live API. ~250 bytes per pick.
function buildPickAuditTrail(stock) {
  const ov = stock.overview || {};
  const r = ov.returns_pct || {};
  const regulatoryFlags = buildRegulatoryFlags(stock);
  return {
    scoring_version: PICKS_SCORING_VERSION,
    inputs_used: {
      snowflake_total: ov.snowflake_total ?? null,
      upside_pct: ov.upside_pct ?? null,
      returns_1y: r["1Y"] ?? null,
      returns_3m: r["3M"] ?? null,
      returns_1m: r["1M"] ?? null,
      risks_count: (ov.risks || []).length,
      surveillance: regulatoryFlags.surveillance || null,
      market_cap_inr: ov.market_cap_inr ?? null,
    },
    imputations: {
      fv_imputed: stock.v4_breakdown?.fv_imputed || false,
      momentum_imputed: stock.v4_breakdown?.momentum_imputed || false,
    },
    categories_assigned: stock.categories || [],
  };
}

// 6M added for the entry-timing slow-bleeder leg (Two-Key Entry PR-2) — deep briefs
// carry it; rows previously dropped it.
const PICK_RETURN_KEYS = ["1D", "7D", "1M", "3M", "6M", "1Y"];

export function compactReturnsPct(returnsPct = {}) {
  const out = {};
  for (const key of PICK_RETURN_KEYS) {
    const v = returnsPct?.[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

export function computeCompositeScore(stock) {
  const ov = stock.overview || {};
  const snowTotal = num(ov.snowflake_total, 0); // 0-30
  const upside = num(ov.upside_pct, 0); // can be negative if overvalued
  const risks = (ov.risks || []).length;
  const netMargin = num(ov.net_margin_pct, 0);
  const ret5y = num((ov.returns_pct || {})["5Y"], 0);
  const fwdGrowth = num(ov.forward_earnings_growth_pct, null);
  // Forward growth is in rewards as "Earnings are forecast to grow X% per year" — extract here as fallback
  const fwdGrowthFromReward = (() => {
    if (fwdGrowth != null) return fwdGrowth;
    for (const r of (ov.rewards || [])) {
      const m = String(r).match(/forecast to grow ([\d.]+)\s*%\s*per year/i);
      if (m) return Number(m[1]);
    }
    return 0;
  })();
  const divYield = num(ov.dividend && ov.dividend.yield_pct, 0);
  const divPayout = num(ov.dividend && ov.dividend.payout_pct, 100);
  const divSnow = num((ov.snowflake || {}).dividends, 0);
  const insiderBuys = (ov.insider_activity || []).filter((x) => x.direction === "buy").length;

  // ---- Component points ----
  const pts_snowflake = (snowTotal / 30) * 35; // up to 35
  const pts_upside = clamp(upside, 0, 50) / 50 * 20; // up to 20
  const pts_risks = -clamp(risks, 0, 5) * 3; // -15 to 0
  const pts_margin = clamp(netMargin, 0, 30) / 30 * 10; // up to 10
  const pts_ret5y = clamp(ret5y, 0, 200) / 200 * 10; // up to 10
  const pts_growth = clamp(fwdGrowthFromReward, 0, 25) / 25 * 15; // up to 15
  const pts_dividend = (divSnow >= 5 && divPayout < 70 && divYield >= 1.5) ? 5 : 0;
  const pts_insider = insiderBuys >= 1 ? 5 : 0;

  const total = pts_snowflake + pts_upside + pts_risks + pts_margin + pts_ret5y + pts_growth + pts_dividend + pts_insider;
  const composite_score_100 = clamp(Math.round(total * 10) / 10, 0, 100);

  return {
    composite_score_100,
    breakdown: {
      pts_snowflake: Math.round(pts_snowflake * 10) / 10,
      pts_upside: Math.round(pts_upside * 10) / 10,
      pts_risks: Math.round(pts_risks * 10) / 10,
      pts_margin: Math.round(pts_margin * 10) / 10,
      pts_ret5y: Math.round(pts_ret5y * 10) / 10,
      pts_growth: Math.round(pts_growth * 10) / 10,
      pts_dividend,
      pts_insider,
    },
    forward_growth_used_pct: fwdGrowthFromReward,
  };
}

// ---------- Verdict tier (matches /fundamentals.js convention) ----------

export function verdictFromScore(score) {
  if (score >= 72) return "DEEP_VALUE";
  if (score >= 62) return "QUALITY_GROWTH";
  if (score >= 48) return "FAIR_VALUE";
  if (score >= 40) return "FULLY_VALUED";
  return "OVERVALUED";
}

// ---------- v3 verdict tier ----------
//
// v3 score has a wider distribution than v1/v2 (v3 p50≈29, p95≈59, max≈86
// vs v1 p50≈12, p95≈43, max≈71), so the v1 thresholds (72/62/48/40) don't
// translate. v3 thresholds are calibrated to universe percentiles:
//   TOP_PICK    ≥ 60  (top  ~5%)
//   STRONG      ≥ 45  (top ~15%)
//   ACCEPTABLE  ≥ 30  (top ~50%)
//   WATCH       ≥ 22  (top ~75%)
//   AVOID       < 22  (bottom ~25%)
//
// Labels intentionally differ from v1's value-tier names because v3 is a
// quality+momentum+valuation composite, not a pure valuation-tier score.

// verdictV3FromScore REMOVED (2026-05 V3→V4 migration). Use verdictV4FromScore
// (absolute cutoffs) from swsScoringV4.mjs.

// PR 2.3 — `valuation_band` is a SEPARATE signal from the composite-score
// verdict. Mirror of services/swsScoring.js::valuationBandFromUpside; keep
// the two implementations in lockstep so the picks JSON written by the
// offline pipeline matches what the live API emits.
export function valuationBandFromUpside(upside) {
  return canonicalValuationBandFromUpside(upside);
}

// ---------- v2 score: multi-factor with risk overlay ----------
//
// v1 `composite_score_100` is a fundamentals-only roll-up. v2 sits on top of
// it and adds two things v1 doesn't see:
//   1) Regulatory risk (NSE ASM/GSM surveillance flag) — major red flag the
//      reader must see in the score, not buried in a sub-tab.
//   2) Catalyst bonus (imminent-earnings beat setup, recent insider buying).
//
// The breakdown is preserved on each card so the modal can show the reader
// exactly which components moved the score.
//
// Score band: same v1 verdict thresholds apply to v2 for backward compat.

export function computeV2Score(stock, opts = {}) {
  const v1 = num(stock.composite_score_100, 0);
  const ov = stock.overview || {};
  const surveillance = opts.surveillanceFlag ?? _getSurveillanceFlag(stock.ticker);

  // Catalyst bonus (max +5)
  let pts_catalyst = 0;
  const next = ov.next_earnings_date;
  if (next) {
    const days = Math.ceil((new Date(next + "T00:00:00Z") - new Date()) / 86400000);
    if (days >= 0 && days <= 30 && ov.last_quarter_result === "beat") pts_catalyst += 3;
  }
  const insiderBuys = (ov.insider_activity || []).filter((x) => x.direction === "buy").length;
  if (insiderBuys >= 1) pts_catalyst += 2;
  const recentUpgrade = (ov.recent_analyst_revisions || []).some((r) => r.direction === "increased");
  if (recentUpgrade) pts_catalyst += 2;
  pts_catalyst = clamp(pts_catalyst, 0, 5);

  // Risk overlay (capped at -15, can be 0)
  let pts_risk_overlay = 0;
  if (surveillance) {
    if (surveillance.list === "GSM") pts_risk_overlay -= 10;
    else if (surveillance.list === "ASM") {
      pts_risk_overlay -= surveillance.timeframe === "shortterm" ? 8 : 5;
    }
  }
  const beta = num(ov.beta, null);
  if (beta != null && beta > 1.5) pts_risk_overlay -= 3;
  const risks = (ov.risks || []).length;
  if (risks >= 4) pts_risk_overlay -= 3;
  pts_risk_overlay = clamp(pts_risk_overlay, -15, 0);

  const v2_score_100 = clamp(Math.round((v1 + pts_catalyst + pts_risk_overlay) * 10) / 10, 0, 100);

  return {
    v2_score_100,
    v2_breakdown: {
      v1_fundamentals: Math.round(v1 * 10) / 10,
      pts_catalyst,
      pts_risk_overlay,
      surveillance: surveillance ? { list: surveillance.list, timeframe: surveillance.timeframe } : null,
      beta_flag: beta != null && beta > 1.5,
      risks_flag: risks >= 4,
    },
  };
}

export function normaliseSurveillanceFlag(flag) {
  if (!flag) return null;
  if (flag === true) return { list: "SURVEILLANCE", timeframe: null };
  const list = flag.list || flag.type || null;
  const timeframe = flag.timeframe || flag.term || null;
  return list || timeframe ? { list, timeframe } : null;
}

export function buildRegulatoryFlags(stock = {}) {
  const surveillance = normaliseSurveillanceFlag(
    stock.regulatory_flags?.surveillance ||
      stock.v4_breakdown?.surveillance ||
      stock.v2_breakdown?.surveillance ||
      null,
  );
  return { surveillance };
}

export function buildRiskOverlay(stock = {}) {
  const ov = stock.overview || {};
  const v4 = stock.v4_breakdown || {};
  const v2 = stock.v2_breakdown || {};
  const regulatoryFlags = buildRegulatoryFlags(stock);
  const beta = num(ov.beta, null);
  const risksCount = Array.isArray(ov.risks) ? ov.risks.length : 0;
  return {
    surveillance: regulatoryFlags.surveillance,
    pts_overlay: typeof v4.pts_overlay === "number" ? v4.pts_overlay : null,
    overlay_reasons: Array.isArray(v4.overlay_reasons) ? v4.overlay_reasons : [],
    pts_risk_overlay: typeof v2.pts_risk_overlay === "number" ? v2.pts_risk_overlay : null,
    beta_flag: v2.beta_flag ?? (beta != null && beta > 1.5),
    risks_flag: v2.risks_flag ?? risksCount >= 4,
    risks_count: risksCount,
  };
}

export function buildCanonicalScore(stock = {}) {
  const value = num(stock.v4_score_100 ?? stock.v4_score, null);
  return {
    version: "v4",
    model: PICKS_SCORING_VERSION,
    source: value == null ? null : "sws",
    value,
    verdict: stock.v4_verdict ?? stock.composite_verdict ?? null,
  };
}

// ---------- v3 score: 50%-coverage-gated scorecard ----------
//
// v3 is built from the ground up to satisfy a SEBI-RA framework rule: only
// score on factors where ≥50% of the deep-scrape universe actually has data.
// Everything below the gate (P/E 17%, net margin 17%, dividend yield 39%,
// beta 14%, sector 1%, forward earnings 2%, insider activity 0%, 5Y return
// 10%, risks/rewards 5–14%) is excluded as a continuous factor.
//
// What survives:
//   1. Five SWS snowflake pillars — 99%+ coverage each:
//        Health 22 · Future 20 · Valuation 12 · Past 12 · Dividends 8  = 74
//   2. AnalystConsensus FV upside — 69% coverage. Graded 0–12 with NEUTRAL
//      imputation (6 pts) when FV is missing, so the 31% of stocks SWS
//      doesn't fair-value aren't systematically penalized in the ranking.
//   3. Universe-percentile momentum — 97%+ coverage for 1M/3M/1Y windows.
//        1Y rel 8 · 3M rel 4 · 1M rel 2  = 14
//
// Plus overlays (subtract from continuous score, capped at -15):
//   - NSE ASM/GSM surveillance (sparse-by-design — absence ≠ missing data).
//   - Falling-knife filter: ret_1m < -25% AND health ≤ 2/6 → -5.
//   - Catalyst-chase filter: ret_1m > +30% AND valuation ≤ 2/6 → -3.
//
// Effective split: 74 fundamentals · 14 momentum · ±15 safety overlay.
//
// Note: momentum needs the universe distribution. Pass `opts.universe`
// (built via buildUniverseStats) for a calibrated score. Without it,
// momentum points fall back to neutral (50th-percentile) and the breakdown
// flags `momentum_imputed: true` so callers can detect uncalibrated scores.

export function buildUniverseStats(stocks) {
  const r1m = [], r3m = [], r1y = [];
  for (const s of stocks) {
    const r = s?.overview?.returns_pct || {};
    if (typeof r["1M"] === "number" && Number.isFinite(r["1M"])) r1m.push(r["1M"]);
    if (typeof r["3M"] === "number" && Number.isFinite(r["3M"])) r3m.push(r["3M"]);
    if (typeof r["1Y"] === "number" && Number.isFinite(r["1Y"])) r1y.push(r["1Y"]);
  }
  r1m.sort((a, b) => a - b);
  r3m.sort((a, b) => a - b);
  r1y.sort((a, b) => a - b);
  return { r1m, r3m, r1y };
}

// Sibling of buildUniverseStats: classify each loaded stock into "has momentum"
// vs "missing momentum" per window, name the missing tickers, and return a
// JSON-serialisable coverage report.
//
// Why split this out: buildUniverseStats returns sorted number arrays so the
// percentile rank lookup stays cheap. The audit / observability surface needs
// the NAMES of the gap stocks, not just the count — keeping that in its own
// helper avoids changing buildUniverseStats's shape (which would ripple into
// scoreStock + computeV3Score).
//
// Sample size: the JSON only carries the first 25 missing tickers (sorted
// alphabetically) so the file doesn't bloat when the gap grows. The full list
// is recomputable any time by re-reading data/sws/deep/.
export function buildMomentumCoverageReport(stocks) {
  const SAMPLE_SIZE = 25;
  const total = Array.isArray(stocks) ? stocks.length : 0;
  const missing = { r1m: [], r3m: [], r1y: [] };
  let withAll = 0;
  for (const s of stocks) {
    const t = s?.ticker || s?.overview?.ticker || null;
    const r = s?.overview?.returns_pct || {};
    const has1m = typeof r["1M"] === "number" && Number.isFinite(r["1M"]);
    const has3m = typeof r["3M"] === "number" && Number.isFinite(r["3M"]);
    const has1y = typeof r["1Y"] === "number" && Number.isFinite(r["1Y"]);
    if (!has1m && t) missing.r1m.push(t);
    if (!has3m && t) missing.r3m.push(t);
    if (!has1y && t) missing.r1y.push(t);
    if (has1m && has3m && has1y) withAll += 1;
  }
  const sortAndSample = (arr) => {
    const sorted = arr.slice().sort();
    return { count: sorted.length, sample: sorted.slice(0, SAMPLE_SIZE) };
  };
  const r1m = sortAndSample(missing.r1m);
  const r3m = sortAndSample(missing.r3m);
  const r1y = sortAndSample(missing.r1y);
  // missing_all_windows = stocks where ALL three return windows are absent.
  // This is the dominant gap pattern in practice (thinly-traded BSE-only
  // tickers without liquid price history); SWS returns returns_pct: null
  // for the whole object, not a single window.
  const missingAll = sortAndSample(
    missing.r1m.filter((t) => missing.r3m.includes(t) && missing.r1y.includes(t)),
  );
  return {
    scored: total,
    with_all_windows: withAll,
    completeness_pct: total > 0 ? Math.round((withAll / total) * 1000) / 10 : 0,
    missing_per_window: {
      r1m: { count: r1m.count, sample_first_25: r1m.sample },
      r3m: { count: r3m.count, sample_first_25: r3m.sample },
      r1y: { count: r1y.count, sample_first_25: r1y.sample },
    },
    missing_all_windows: {
      count: missingAll.count,
      sample_first_25: missingAll.sample,
    },
    // Why these tickers are absent (best-current-understanding, surfaced for
    // audit triage): the dominant pattern is BSE-only numeric-code tickers
    // (500223, 501111…) and a handful of delisted / distressed names. SWS
    // doesn't compute returns_pct for stocks without a liquid intraday tape,
    // so the gap is upstream and not closable by re-running the scorer.
    // computeV3Score handles missing momentum by imputing the 50th
    // percentile and flagging breakdown.momentum_imputed = true — these
    // stocks are still scored, just without a momentum lift/drag.
    notes:
      "missing_all_windows entries are typically thinly-traded BSE-only tickers (numeric codes) " +
      "or delisted names where SWS upstream returns returns_pct: null. These stocks are still " +
      "scored — computeV3Score imputes momentum at the 50th percentile and stamps " +
      "breakdown.momentum_imputed: true. The gap is an upstream data limitation, not a scorer bug.",
  };
}

// Companion to buildUniverseStats: returns the FULL list of tickers that
// have NO momentum window at all (1M, 3M, 1Y all missing/non-finite). These
// are the stocks excluded from BOTH `universe_size` and the percentile
// arrays in v3-universe-stats.json — surfaced here as `excluded_for_momentum`
// so the gap is structurally closed and fully auditable.
//
// Differs from buildMomentumCoverageReport in two ways:
//   1. Returns objects ({ticker, reason}) not just names, so audit consumers
//      can grow the reason taxonomy without re-deriving from the deep dir.
//   2. Returns the COMPLETE list, not a first-25 sample — the universe is
//      bounded (~5500 stocks, ~53 excluded) so the file bloat is tolerable.
//
// The reason string is a single bucket today ("no momentum windows…");
// future versions may split on "thinly-traded BSE-only" vs "new listing"
// vs "delisted" by inspecting the deep file's metadata. Tests should match
// on the prefix, not the full string.
export function collectExcludedForMomentum(stocks) {
  const excluded = [];
  for (const s of stocks) {
    const t = s?.ticker || s?.overview?.ticker || null;
    if (!t) continue;
    const r = s?.overview?.returns_pct || {};
    const has1m = typeof r["1M"] === "number" && Number.isFinite(r["1M"]);
    const has3m = typeof r["3M"] === "number" && Number.isFinite(r["3M"]);
    const has1y = typeof r["1Y"] === "number" && Number.isFinite(r["1Y"]);
    if (!has1m && !has3m && !has1y) {
      excluded.push({
        ticker: t,
        reason: "no momentum windows — thinly-traded BSE-only or new listings",
      });
    }
  }
  excluded.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return excluded;
}

function _percentileRank(value, sorted) {
  if (value == null || !Number.isFinite(value) || !sorted?.length) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

// computeV3Score REMOVED (2026-05 V3→V4 migration). computeV4Score
// (swsScoringV4.mjs, imported above) is the platform's sole composite score.
// The momentum helpers above (buildUniverseStats / _percentileRank) are shared
// and reused by V4 unchanged.

// ---------- Category filters ----------
//
// Categorisation is v3-aware: gates use stock.v4_verdict and the snowflake
// future-growth / health pillars rather than v1's verdict labels and the
// forward-earnings-growth field (which is null for ~98% of the universe
// because the SWS API capture has no forecast years).
//
// Categories that depend on data the parser doesn't currently populate
// (insider_buying → ownership.insider_activity, upcoming_earnings →
// overview.next_earnings_date) are kept as no-ops here — the UI auto-hides
// empty sections, and re-enabling them is a data-collection task, not a
// scoring change.

export function categoriseStock(stock) {
  const ov = stock.overview || {};
  const sn = ov.snowflake || {};
  const v4Verdict = stock.v4_verdict || "WATCH";
  const upsideRaw = num(ov.upside_pct, null);
  const upside = upsideRaw != null ? upsideRaw : 0;
  const hasUpside = upsideRaw != null;
  const ret1y = num((ov.returns_pct || {})["1Y"], null);
  const ret3m = num((ov.returns_pct || {})["3M"], null);
  const valSnow = num(sn.valuation ?? sn.value, 0);
  const futureSnow = num(sn.future ?? sn.future_growth, 0);
  const healthSnow = num(sn.financial_health ?? sn.health, 0);
  const divSnow = num(sn.dividends ?? sn.dividend, 0);
  const snowTotal = num(ov.snowflake_total, 0);
  const divYield = num(ov.dividend?.yield_pct, 0);
  const divPayout = num(ov.dividend?.payout_pct, 100);
  const mcap = num(ov.market_cap_inr, 0);
  const risks = (ov.risks || []).length;
  const insiderBuys = (ov.insider_activity || []).filter((x) => x.direction === "buy").length;
  const nextEarnings = ov.next_earnings_date;

  const cats = [];

  // Deep value: top-tier v3 + cheap valuation pillar + meaningful upside.
  if (v4Verdict === "TOP_PICK" && valSnow >= 4 && hasUpside && upside >= 20) {
    cats.push("deep_value");
  }

  // Quality growth: strong/top v3 + balance-sheet health + future-growth signal.
  // futureSnow ≥ 4 stands in for the historical "5Y EPS growth" requirement —
  // it's the SWS analyst-derived future-growth pillar, populated for 99% of
  // the universe (vs <14% for the rewards-text regex this used to use).
  if (["TOP_PICK", "STRONG"].includes(v4Verdict) && healthSnow >= 5 && futureSnow >= 4) {
    cats.push("quality_growth");
  }

  // Midterm: acceptable+ v3 + positive 1Y or 3M momentum + meaningful upside.
  // Replaces the old fwdGrowth ≥ 8 requirement (forward earnings growth is
  // ~2% covered) with the future-growth pillar at ≥3.
  const positiveMomentum = (ret1y != null && ret1y > 0) || (ret3m != null && ret3m > 5);
  if (["TOP_PICK", "STRONG", "ACCEPTABLE"].includes(v4Verdict) && positiveMomentum && hasUpside && upside >= 15 && futureSnow >= 3) {
    cats.push("midterm");
  }

  // Dividend aristocrats: SWS dividend pillar + sustainable payout + real
  // yield, AND a value floor (upside ≥ 0 OR valuation snowflake ≥ 4).
  // PR 2.6 — without the value floor the list surfaced OVERVALUED +
  // negative-upside names just because their dividend pillar was strong.
  if (
    divSnow >= 5 &&
    divPayout < 70 &&
    divYield >= 1.5 &&
    (upside >= 0 || valSnow >= 4)
  ) {
    cats.push("dividend_aristocrats");
  }

  // Smallcap gems: true smallcap (mcap < ₹15,000cr, NSE rank 251+) + strong
  // snowflake + meaningful upside. The previous 5e11 (₹50,000cr) threshold
  // surfaced mid-caps under the smallcap label.
  if (mcap > 0 && mcap < 1.5e11 && snowTotal >= 22 && hasUpside && upside >= 15) {
    cats.push("smallcap_gems");
  }

  // Insider buying — kept gated; data field is not currently populated.
  if (insiderBuys >= 1) cats.push("insider_buying");

  // Upcoming earnings — kept gated; next_earnings_date is not currently populated.
  if (nextEarnings) {
    const days = Math.ceil((new Date(nextEarnings + "T00:00:00Z") - new Date()) / 86400000);
    if (days >= 0 && days <= 75) cats.push("upcoming_earnings");
  }

  // Avoid: v3 says AVOID + meaningful liquidity (mcap ≥ ₹500cr). The mcap
  // gate filters out illiquid micro-caps where AVOID-tier is meaningless —
  // SEBI-aligned advice cares about names a real book might hold/exit, not
  // 4,000 obscure ₹50cr listings. Backstop branch (snowTotal < 12 + risks ≥ 3)
  // bypasses the mcap gate so genuinely terrible large-caps still surface.
  if ((v4Verdict === "AVOID" && mcap >= 5e9) || (snowTotal < 12 && risks >= 3)) cats.push("avoid");

  return cats;
}

// ---------- Top-level: score one stock ----------
//
// `opts.universe` (built via buildUniverseStats over the full deep universe)
// calibrates v3 momentum percentiles. When omitted (e.g. single-stock CLI),
// v3 momentum falls back to neutral and the breakdown flags it.

export function scoreStock(stock, opts = {}) {
  const scoringStock = withReconciledFairValue(stock);
  const sc = computeCompositeScore(scoringStock);
  stock.composite_score_100 = sc.composite_score_100;
  stock.score_breakdown = sc.breakdown;
  stock.forward_growth_used_pct = sc.forward_growth_used_pct;
  stock.verdict = verdictFromScore(sc.composite_score_100);
  // v2 layered on top — needs v1 score in place first.
  scoringStock.composite_score_100 = sc.composite_score_100;
  const v2 = computeV2Score(scoringStock);
  stock.v2_score_100 = v2.v2_score_100;
  stock.v2_breakdown = v2.v2_breakdown;
  // v4 — the platform's sole composite score. Verdict is ABSOLUTE (no bands),
  // resolved directly here so every call site gets it.
  const v4 = computeV4Score(scoringStock, opts);
  stock.v4_score_100 = v4.v4_score_100;
  stock.v4_breakdown = v4.v4_breakdown;
  stock.v4_verdict = verdictV4FromScore(v4.v4_score_100);
  stock.regulatory_flags = buildRegulatoryFlags(stock);
  stock.risk_overlay = buildRiskOverlay(stock);
  stock.canonical_score = buildCanonicalScore(stock);
  // Categorise AFTER v4 — categories key off v4_verdict.
  scoringStock.v4_score_100 = v4.v4_score_100;
  scoringStock.v4_breakdown = v4.v4_breakdown;
  scoringStock.v4_verdict = stock.v4_verdict;
  stock.categories = categoriseStock(scoringStock);
  return stock;
}

// ---------- Build leaderboard for picks-latest.json ----------

function shortReason(stock, reconciled = null) {
  const ov = stock.overview || {};
  const bits = [];
  const pe = ov.multiples && ov.multiples.pe;
  if (pe != null) bits.push(`P/E ${pe.toFixed(1)}x`);
  // Use reconciled upside (null when SWS shipped a junk FV) so the row
  // doesn't read "+1316% to fair value" alongside a "FV —" cell.
  const upside = reconciled ? reconciled.upside_pct : ov.upside_pct;
  if (upside != null) bits.push(`${upside > 0 ? "+" : ""}${upside.toFixed(1)}% to fair value`);
  const dY = ov.dividend && ov.dividend.yield_pct;
  if (dY != null && dY >= 1.5) bits.push(`${dY.toFixed(1)}% div`);
  const sn = ov.snowflake_total;
  if (sn != null) bits.push(`snow ${sn}/30`);
  return bits.slice(0, 4).join(" · ");
}

// Reconcile fair-value / upside_pct on the leaderboard card via the shared
// services/fvReconciliation.js policy. SWS is the primary FV source: finite raw
// SWS FV is preserved even when the FV/price ratio is unusually high or low,
// and display upside is computed from FV + current price when both are present.
// Returns { upside_pct, fair_value_inr, fv_reconcile_reason }. The reason
// is one of:
//   - "ok"                       FV present and within normal ratio telemetry
//   - "ok_sws_raw_fv"            FV present with unusual ratio; raw SWS FV kept
//   - "source_fv_missing"        deep file had no finite fair_value_inr
//   - "source_price_missing"     deep file had no current_price_inr / non-positive
//
// PR-A2 (2026-05-18): the `fv_reconcile_reason` field was added in response
// to audit finding #4. It now distinguishes "source genuinely missing" from
// "SWS supplied an extreme FV that we preserved", without re-walking deep JSON.
export function _reconcilePickFV(ov) {
  return reconcileFairValue(ov);
}

export function pickCardFields(stock) {
  const ov = stock.overview || {};
  const reconciled = _reconcilePickFV(ov);
  // Display-side honesty: when the FV composite flagged the analyst target as an
  // inflated range-MAX (thin coverage), de-rate the DISPLAYED upside by the stored
  // factor so the card number matches how the score already treats it. Factor is 1
  // (no-op) for the well-covered majority. `renderPickCard` badges the card when
  // `upside_haircut_applied`. See services/swsScoringV4.js `_fvCompositeV4`.
  const haircutFactor = stock.v4_breakdown?.upside_haircut_factor ?? 1;
  const displayUpside = applyUpsideHaircut(reconciled.upside_pct, haircutFactor);
  return {
    ticker: stock.ticker,
    name: stock.name || stock.ticker,
    sector: stock.sector || null,
    sws_url: stock.sws_url || null,
    score: stock.composite_score_100,
    v2_score: stock.v2_score_100,
    v2_breakdown: stock.v2_breakdown,
    // v4 — the platform's sole composite score (absolute verdict).
    v4_score: stock.v4_score_100,
    v4_score_100: stock.v4_score_100,
    v4_breakdown: stock.v4_breakdown,
    v4_verdict: stock.v4_verdict,
    canonical_score: stock.canonical_score || buildCanonicalScore(stock),
    score_model: PICKS_SCORING_VERSION,
    score_source: "sws_v4",
    regulatory_flags: stock.regulatory_flags || buildRegulatoryFlags(stock),
    risk_overlay: stock.risk_overlay || buildRiskOverlay(stock),
    verdict: stock.verdict,
    // PR 2.3 — explicit aliases. Composite (multi-factor) and valuation
    // (price-vs-FV) are two SEPARATE signals; the UI keeps them as two
    // distinct badges so users never see them collapsed into one.
    composite_verdict: stock.v4_verdict,
    valuation_band: valuationBandFromUpside(displayUpside),
    snowflake_total: ov.snowflake_total,
    snowflake: ov.snowflake,
    current_price_inr: ov.current_price_inr,
    fair_value_inr: reconciled.fair_value_inr,
    upside_pct: displayUpside,
    // Carried so the serve-time live-price recompute (server.js enrichPickRow /
    // applyReconciledFvToCard) can re-apply the same de-rate — the slim serve-side
    // FV map has no analyst range, so it cannot re-derive the factor itself.
    upside_haircut_factor: haircutFactor,
    upside_haircut_applied: haircutFactor < 1,
    upside_display_basis: stock.v4_breakdown?.upside_display_basis || null,
    fv_reconcile_reason: reconciled.fv_reconcile_reason,
    fair_value_confidence: reconciled.fair_value_confidence,
    fair_value_source: reconciled.fair_value_source,
    upside_source: reconciled.upside_source,
    market_cap_inr: ov.market_cap_inr,
    returns_pct: compactReturnsPct(ov.returns_pct),
    next_earnings_date: ov.next_earnings_date,
    last_quarter_result: ov.last_quarter_result,
    one_line: shortReason(stock, reconciled),
    data_freshness_at: stock.parsed_at || null,
    // % of 13 input fields the scorer had to work with. UI flags <60 as
    // "thin coverage" so missing inputs don't get silently scored as zero.
    data_completeness_pct: dataCompletenessPct(stock),
    // Balanced rationale — the case against the call + observable events
    // that would reverse it. Always emitted (never null).
    counter_thesis: buildPickCounterThesis(stock),
    // Per-pick audit blob — slim, self-contained, ~250 bytes.
	    audit_trail: buildPickAuditTrail(stock),
	    entry_band: buildEntryBand(stock),
	    // Two-Key Entry (PR-2): baked additively so the nightly entry-timing stamp and
	    // any serve-time consumer can read 52w position + the analyst FV range without
	    // reaching into data/sws/deep/ (frozen on prod). Both come straight from the parser.
	    fifty_two_week: ov.fifty_two_week || null,
	    fair_value_range_inr: ov.fair_value_range_inr || null,
	  };
	}

// Slim projection for the picks-tab global search index. ~3× smaller than
// pickCardFields — drops v2_breakdown bulk, v4_breakdown, full snowflake
// (renderPickCard only reads snowflake_total), and the upcoming-earnings-only
// fields. Adds in_sections so the front-end can skip stocks already shown in
// curated sections.
function slimUniverseEntry(stock, inSections) {
  const card = pickCardFields(stock);
  return {
    ticker: card.ticker,
    name: card.name,
    sector: card.sector,
    sws_url: card.sws_url,
    score: card.score,
    v2_score: card.v2_score,
    v4_score: card.v4_score,
    v4_score_100: card.v4_score_100,
    v4_verdict: card.v4_verdict,
    canonical_score: card.canonical_score,
    score_model: card.score_model,
    score_source: card.score_source,
    regulatory_flags: card.regulatory_flags,
    risk_overlay: card.risk_overlay,
    composite_verdict: card.composite_verdict,
    valuation_band: card.valuation_band,
    verdict: card.verdict,
    v2_breakdown: card.v2_breakdown ? { surveillance: card.v2_breakdown.surveillance || null } : null,
    snowflake_total: card.snowflake_total,
    current_price_inr: card.current_price_inr,
    fair_value_inr: card.fair_value_inr,
    upside_pct: card.upside_pct,
    fv_reconcile_reason: card.fv_reconcile_reason,
    fair_value_confidence: card.fair_value_confidence,
    fair_value_source: card.fair_value_source,
    upside_source: card.upside_source,
    market_cap_inr: card.market_cap_inr,
    one_line: card.one_line,
    data_freshness_at: card.data_freshness_at,
    data_completeness_pct: card.data_completeness_pct,
    in_sections: inSections,
  };
}

// Atomic write helper: stage to .tmp then rename so a mid-write crash or
// concurrent reader (the API route) never sees a half-written JSON file.
function writeJsonAtomic(filePath, value) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, filePath);
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeUniverseStatsPayload(payload) {
  const dir = path.dirname(PATHS.picksLatest);
  writeJsonAtomic(path.join(dir, "v4-universe-stats.json"), payload);
  writeJsonAtomic(path.join(dir, "v3-universe-stats.json"), payload);
}

export function buildLeaderboard(scoredStocks, opts = {}) {
  // Sort once, descending by V4 — canonical across every section except
  // upcoming_earnings (which re-sorts by date below). Card headlines render
  // V4, so the section rank order matches the number the user sees.
  //
  // PR 2.7 — drop pure-numeric BSE codes (e.g. "538992") at the universe
  // boundary. They were leaking into Avoid + Deep Value lists alongside
  // proper NSE symbols and confusing readers.
  const isPureBSEcode = (t) => typeof t === "string" && /^\d+$/.test(t);
	  const ordered = [...scoredStocks]
	    .filter((s) => !isPureBSEcode(s.ticker))
	    .sort(compareIndiaSectionRank);

  // Hygiene gate for the universe-wide Top-30. Market cap ≥ ₹500cr (skip
  // illiquid micro-caps that need a different analysis frame); exclude GSM
  // (heavy regulatory red flag — the score overlay deduction isn't enough).
  const MIN_MCAP_INR = 5_000_000_000; // ₹500cr
  const hygiene = (s) => {
    const mcap = num(s.overview?.market_cap_inr, 0);
    if (mcap < MIN_MCAP_INR) return false;
    const surv = buildRegulatoryFlags(s).surveillance;
    if (surv && surv.list === "GSM") return false;
    return true;
  };

	  // Best Stocks to Buy Now keeps the legacy best_to_buy_now key, but now requires
	  // clean FV, positive sane upside, freshness, liquidity, and no ASM/GSM.
	  const bestToBuy = ordered
	    .filter((s) => isActionableTodayCandidate(s, { now: opts.now }))
	    .slice(0, 25)
	    .map(pickCardFields);

  const cat = (key) => ordered.filter((s) => (s.categories || []).includes(key)).map(pickCardFields);

  // Upcoming earnings — sort by date ascending, not by score
	  const upcoming = ordered
	    .filter((s) => (s.categories || []).includes("upcoming_earnings"))
	    .sort((a, b) => (a.overview?.next_earnings_date || "9999").localeCompare(b.overview?.next_earnings_date || "9999") || compareIndiaSectionRank(a, b))
    .map((s) => {
      const c = pickCardFields(s);
      const d = s.overview?.next_earnings_date;
      c.days_until = d ? Math.ceil((new Date(d + "T00:00:00Z") - new Date()) / 86400000) : null;
      c.recent_analyst_revisions = s.overview?.recent_analyst_revisions || [];
      return c;
    });

  // Universe-wide top 30 by V4 composite — canonical headline section.
  const top30 = ordered.filter(hygiene).slice(0, 30).map(pickCardFields);

  // Best Fundamentals — matches the score-breakdown modal's "Fundamentals 74"
  // line exactly: 5 SWS pillars + AnalystConsensus FV upside (max 74 label,
  // theoretical max 86 when FV upside is at +12). Same hygiene gate as Top
  // 30. Ship 100 so the UI can expand past the inline cap of 30.
	  const bestFundamentals = [...scoredStocks]
	    .filter((s) => !isPureBSEcode(s.ticker))
	    .filter(hygiene)
	    .sort((a, b) => swsFundamentalsSubtotal(b) - swsFundamentalsSubtotal(a) || compareIndiaSectionRank(a, b))
    .slice(0, 100)
    .map(pickCardFields);

  const growingSectorValue = buildGrowingSectorValueSection(scoredStocks, {
    pickCardFields,
    sectorOutlook: opts.sectorOutlook || null,
    macroRegime: opts.macroRegime || null,
    now: opts.now,
  });
  const snowflakeGapLab = buildSnowflakeGapLabSection(scoredStocks, {
    pickCardFields,
    universe: opts.universe || null,
  });

  const sections = {
    top_ranked_30_v4: top30,
    // Temporary compatibility alias. New first-party readers use V4.
    top_ranked_30_v3: top30,
    best_to_buy_now: bestToBuy,
    deep_value: cat("deep_value"),
    growing_sector_value: growingSectorValue.items,
    snowflake_gap_lab: snowflakeGapLab.items,
    quality_growth: cat("quality_growth"),
    best_fundamentals: bestFundamentals,
    midterm: cat("midterm"),
    dividend_aristocrats: cat("dividend_aristocrats"),
    smallcap_gems: cat("smallcap_gems"),
    insider_buying: cat("insider_buying"),
    upcoming_earnings: upcoming,
    avoid: cat("avoid"),
  };
  Object.defineProperty(sections, "__section_audit", {
    value: {
	      growing_sector_value: growingSectorValue.audit,
	      snowflake_gap_lab: snowflakeGapLab.audit,
	      best_to_buy_now: buildActionableTodayAudit(ordered, bestToBuy, { now: opts.now }),
	    },
    enumerable: false,
  });
  return sections;
}

// ---------- Top-level: read all per-stock files, score, write picks-latest.json ----------

export function runFullScoring() {
  const files = fs.readdirSync(PATHS.deepDir).filter((f) => f.endsWith(".json"));

  // Two-pass: v3 momentum percentiles need the full universe distribution
  // before any one stock can be scored, so load everything first.
  const loaded = [];
  let failed = 0;
  for (const f of files) {
    try {
      loaded.push(JSON.parse(fs.readFileSync(path.join(PATHS.deepDir, f), "utf-8")));
    } catch (e) {
      failed++;
      console.error(`Failed to load ${f}: ${e.message}`);
    }
  }
  const universe = buildUniverseStats(loaded);
  // Relative FV-upside benchmark (PR #426) — median/MAD of signed-log upside
  // over the universe, micro-caps (< ₹500cr) excluded. computeV4Score reads
  // universe.fvBenchmark for the magnitude-aware analyst-upside leg.
  universe.fvBenchmark = buildFvUpsideBenchmark(
    loaded.map((s) => ({
      upside_pct: reconcileFairValue(s?.overview).upside_pct,
      market_cap_inr: s?.overview?.market_cap_inr,
    })),
    { microCapFloorInr: 5e9 },
  );
  universe.fvCompositeIndustryAverages = buildFvCompositeIndustryAverages(loaded, universe.fvBenchmark);
  universe.snowflakeGapPeerAverages = buildSnowflakeGapPeerAverages(loaded);

  const scored = [];
  for (const stock of loaded) {
    try {
      scored.push(scoreStock(stock, { universe }));
    } catch (e) {
      failed++;
      console.error(`Failed to score ${stock?.ticker || "?"}: ${e.message}`);
    }
  }
  const sectorOutlook = readJsonIfExists(path.join(PATHS.repoRoot, "data", "sectorOutlook", "outlook-latest.json"));
  const macroRegime = readJsonIfExists(path.join(PATHS.repoRoot, "data", "macroRegime.json"));
  const sections = buildLeaderboard(scored, { sectorOutlook, macroRegime, universe });
  const sectionAudit = sections.__section_audit || {};

  // Two-Key Entry (PR-2): stamp entry_timing + entry_plan onto section rows.
  // MUST read the PREVIOUS night's picks-latest BEFORE it is overwritten below —
  // prevState drives hysteresis + the alert dwell counter, and the ladder anchor
  // carries forward while the state is unchanged. Fail-open: an error here ships
  // rows without the stamp (cards render exactly as before).
  try {
    const prevPicks = readJsonIfExists(PATHS.picksLatest);
    const stampStats = stampEntryTimingOnSections({
      sections,
      universeR3m: universe.r3m,
      macroRegime,
      prevSections: prevPicks?.sections || null,
      scannedAt: new Date().toISOString(),
      getTechnicals, // Tier-2 sidecar lookup; fail-open (missing/stale → Tier-1)
    });
    console.log(`Entry timing stamped: ${stampStats.stamped} rows (${stampStats.eligibleRows} plan-eligible)`);

  } catch (e) {
    console.error(`Entry-timing stamp failed (non-fatal, rows ship unstamped): ${e.message}`);
  }

  // Compute scrape duration estimate from file mtimes if available
  let earliest = null, latest = null;
  for (const f of files) {
    const stat = fs.statSync(path.join(PATHS.deepDir, f));
    if (!earliest || stat.mtime < earliest) earliest = stat.mtime;
    if (!latest || stat.mtime > latest) latest = stat.mtime;
  }
  const durationHours = earliest && latest ? (latest - earliest) / 3600000 : null;

  const out = {
    schema_version: PICKS_SCHEMA_VERSION,
    scoring_version: PICKS_SCORING_VERSION,
    scanned_at: new Date().toISOString(),
    scrape_duration_hours: durationHours ? Math.round(durationHours * 10) / 10 : null,
    model_split: { scrape: "claude-sonnet-4-6", score: "claude-opus-4-7" },
    universe_size: scored.length + failed,
    scored_count: scored.length,
    failed_count: failed,
    section_audit: sectionAudit,
    sections,
  };
  fs.writeFileSync(PATHS.picksLatest, JSON.stringify(out, null, 2));

  // Sibling: scored-universe index for the picks-tab global search.
  // Includes EVERY scored stock (not just those in sections) with a slim
  // subset of fields renderPickCard needs, plus an `in_sections` array so
  // the UI can dedupe search hits against the visible curated sections.
  // Atomic write — the /api/sws-universe route reads this file directly.
  const tickerToSections = new Map();
  for (const [sectionKey, items] of Object.entries(sections)) {
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it || !it.ticker) continue;
      if (!tickerToSections.has(it.ticker)) tickerToSections.set(it.ticker, []);
      tickerToSections.get(it.ticker).push(sectionKey);
    }
  }
  const universeStocks = scored.map((s) => slimUniverseEntry(s, tickerToSections.get(s.ticker) || []));
  const scoredUniversePath = path.join(path.dirname(PATHS.picksLatest), "sws-scored-universe.json");
  writeJsonAtomic(scoredUniversePath, {
    generated_at: new Date().toISOString(),
    scored_count: universeStocks.length,
    stocks: universeStocks,
  });

  // Persist v3 universe distribution so the live action engine
  // (services/swsHoldingEngine.js) can score holdings with calibrated
  // momentum percentiles without having to re-scan all deep files on
  // every server start.
  //
  // Also emit a `momentum_coverage` block naming the stocks that have NO
  // returns_pct at all in their SWS deep file — those stocks are scored
  // by computeV3Score with momentum imputed (50th percentile) and the
  // breakdown stamped `momentum_imputed: true`. Surfacing the names here
  // makes the universe coverage gap auditable without scanning the full
  // deep dir.
  //
  // universe_size is the size of the momentum-percentile universe — i.e.
  // it equals r1m.length === r3m.length === r1y.length by construction.
  // Tickers without any momentum window (thinly-traded BSE-only, new
  // listings) are excluded from BOTH universe_size and the percentile
  // arrays, and persisted in `excluded_for_momentum[]` for audit. This
  // structurally closes the prior 53-row gap (PR #279 only documented
  // it via momentum_coverage; Option A makes the column semantically
  // accurate). Per-stock scoring still covers ALL loaded stocks — the
  // 53 excluded tickers go through computeV3Score with imputed
  // momentum (breakdown.momentum_imputed: true).
  const coverage = buildMomentumCoverageReport(loaded);
  const excludedForMomentum = collectExcludedForMomentum(loaded);
  writeUniverseStatsPayload({
    generated_at: new Date().toISOString(),
    universe_size: universe.r1m.length,
    counts: { r1m: universe.r1m.length, r3m: universe.r3m.length, r1y: universe.r1y.length },
    fv_benchmark: universe.fvBenchmark,
    fv_composite_industry_averages: universe.fvCompositeIndustryAverages,
    momentum_coverage: coverage,
    excluded_for_momentum: excludedForMomentum,
    notes:
      "universe_size matches momentum-percentile universe by construction " +
      "(universe_size === r1m.length === r3m.length === r1y.length). Tickers " +
      "without any momentum window are listed in excluded_for_momentum[] for " +
      "audit; they are still scored by computeV3Score with momentum imputed " +
      "at the 50th percentile (breakdown.momentum_imputed: true).",
    r1m: universe.r1m,
    r3m: universe.r3m,
    r1y: universe.r1y,
  });

  return out;
}

/**
 * Rebuild data/sws/v4-universe-stats.json plus the temporary
 * data/sws/v3-universe-stats.json compatibility mirror from the current deep dir.
 *
 * Use this when you've changed the v3-universe-stats schema (e.g. added
 * the momentum_coverage block) and want to regenerate the file without
 * re-running the full scoring pass (which would overwrite picks-latest
 * and require a long warm-up). Math is bit-identical with the writer in
 * runFullScoring above.
 *
 * Returns the parsed JSON payload that was written.
 */
export function rebuildUniverseStatsOnly() {
  const files = fs.readdirSync(PATHS.deepDir).filter((f) => f.endsWith(".json"));
  const loaded = [];
  for (const f of files) {
    try {
      loaded.push(JSON.parse(fs.readFileSync(path.join(PATHS.deepDir, f), "utf-8")));
    } catch {}
  }
  const universe = buildUniverseStats(loaded);
  universe.fvBenchmark = buildFvUpsideBenchmark(
    loaded.map((s) => ({
      upside_pct: reconcileFairValue(s?.overview).upside_pct,
      market_cap_inr: s?.overview?.market_cap_inr,
    })),
    { microCapFloorInr: 5e9 },
  );
  universe.fvCompositeIndustryAverages = buildFvCompositeIndustryAverages(loaded, universe.fvBenchmark);
  const coverage = buildMomentumCoverageReport(loaded);
  const excludedForMomentum = collectExcludedForMomentum(loaded);
  // universe_size === r1m.length === r3m.length === r1y.length by construction.
  // See runFullScoring above for the rationale and the audit/scoring split.
  const payload = {
    generated_at: new Date().toISOString(),
    universe_size: universe.r1m.length,
    counts: { r1m: universe.r1m.length, r3m: universe.r3m.length, r1y: universe.r1y.length },
    fv_benchmark: universe.fvBenchmark,
    fv_composite_industry_averages: universe.fvCompositeIndustryAverages,
    momentum_coverage: coverage,
    excluded_for_momentum: excludedForMomentum,
    notes:
      "universe_size matches momentum-percentile universe by construction " +
      "(universe_size === r1m.length === r3m.length === r1y.length). Tickers " +
      "without any momentum window are listed in excluded_for_momentum[] for " +
      "audit; they are still scored by computeV3Score with momentum imputed " +
      "at the 50th percentile (breakdown.momentum_imputed: true).",
    r1m: universe.r1m,
    r3m: universe.r3m,
    r1y: universe.r1y,
  };
  writeUniverseStatsPayload(payload);
  return payload;
}

// CLI: `node scripts/sws-scoring.mjs` → score all + write picks-latest.json
// CLI: `node scripts/sws-scoring.mjs TICKER` → score one stock, print result
// CLI: `node scripts/sws-scoring.mjs --rebuild-universe-stats` → metadata-only
//      refresh of data/sws/v4-universe-stats.json plus the v3 mirror without re-scoring picks.
//      Useful after schema changes (e.g. adding momentum_coverage) or to
//      observe the current upstream-coverage gap without a 30-min refresh.
if (import.meta.url === `file://${process.argv[1]}`) {
  const ticker = process.argv[2];
  if (ticker === "--rebuild-universe-stats") {
    const payload = rebuildUniverseStatsOnly();
    const cov = payload.momentum_coverage;
    const excluded = payload.excluded_for_momentum?.length || 0;
    console.log(
      `Rebuilt v4-universe-stats.json (+ v3 mirror): universe_size=${payload.universe_size} ` +
        `(== r1m.length == r3m.length == r1y.length by construction), ` +
        `coverage ${cov.completeness_pct}% (${cov.with_all_windows}/${cov.scored} loaded), ` +
        `${excluded} excluded_for_momentum (deep-file scan covered ${cov.scored} stocks)`,
    );
    process.exit(0);
  }
  if (ticker) {
    const fp = path.join(PATHS.deepDir, `${ticker}.json`);
    if (!fs.existsSync(fp)) {
      console.error(`No such stock file: ${fp}`);
      process.exit(1);
    }
    const stock = JSON.parse(fs.readFileSync(fp, "utf-8"));
    // Single-stock CLI: no universe → v3 momentum is neutral-imputed and
    // breakdown.momentum_imputed will be true. Run runFullScoring for a
    // calibrated v3 momentum percentile.
    const scored = scoreStock(stock);
    console.log(JSON.stringify({
      ticker: scored.ticker,
      composite_score_100: scored.composite_score_100,
      v2_score_100: scored.v2_score_100,
      v4_score_100: scored.v4_score_100,
      verdict: scored.verdict,
      categories: scored.categories,
      breakdown_v1: scored.score_breakdown,
      breakdown_v2: scored.v2_breakdown,
      breakdown_v4: scored.v4_breakdown,
    }, null, 2));
  } else {
    const out = runFullScoring();
    console.log(`Scored ${out.scored_count} stocks (${out.failed_count} failed). Wrote ${PATHS.picksLatest}`);
    console.log(`Sections:`);
    for (const [k, v] of Object.entries(out.sections)) {
      console.log(`  ${k}: ${v.length}`);
    }
  }
}
