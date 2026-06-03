// Coverage fallback for tickers SWS doesn't carry yet (e.g. recently
// demerged entities like TMCV.NS / TMPV.NS, freshly listed names).
//
// Without this layer the v1 engine returns { swsCovered: false, action: null }
// and the user gets ZERO opinion on what may be a top-N holding (real
// portfolio: TMCV is 12% of the book and gets no verdict). Fallback path:
//
//   1. Look up the ticker in fundamentals.json (744 NSE names, refreshed
//      by scripts/refresh-fundamentals.mjs).
//   2. Run fundamentalsV2.scoreFundamentalsV2 on the snapshot.
//   3. Synthesize an SWS-shaped result (snowflake from V2 pillar grades,
//      composite score, verdict).
//   4. Emit a low-confidence v2 recommendation tagged
//      `fallback_source: "fundamentalsV2"` so the UI can clearly mark it.
//
// Indian-risk + catalyst layers are still consulted if their inputs are
// available (surveillance data is universe-wide, not SWS-dependent).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreFundamentalsV2 } from "../fundamentalsV2.js";
import { num } from "./swsScoring.js";
import {
  buildDataQualityGate,
  buildReductionEvidence,
  buildSmallcapPolicy,
  classifyMarketCapBucket,
  gateReductionAction,
} from "./portfolioDecisionPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNDAMENTALS_PATH = path.resolve(__dirname, "..", "fundamentals.json");

let _fundCache = null;
function _loadFundamentals() {
  let stat;
  try { stat = fs.statSync(FUNDAMENTALS_PATH); } catch { return null; }
  if (_fundCache && _fundCache.mtimeMs === stat.mtimeMs) return _fundCache.snapshots;
  try {
    const raw = JSON.parse(fs.readFileSync(FUNDAMENTALS_PATH, "utf-8"));
    _fundCache = { mtimeMs: stat.mtimeMs, snapshots: raw?.snapshots || {} };
    return _fundCache.snapshots;
  } catch { return null; }
}

function _toNseKey(ticker) {
  if (!ticker) return null;
  let k = String(ticker).trim();
  if (!/\.(NS|BO|BSE|NSE)$/i.test(k)) k = `${k}.NS`;
  return k.replace(/\.(BO|BSE|NSE)$/i, ".NS");
}

// Translate fundamentalsV2's 0..5 pillar scores into the SWS Snowflake
// shape (0..6 ints) so downstream consumers can read the same field
// names. Approximation — sub-pillar mapping:
//   value      → valuation
//   future     → future_growth
//   past       → past_performance
//   health     → financial_health
//   dividend   → dividends
// Governance is dropped (no SWS slot).
function _v2ToSwsSnowflake(v2pillars) {
  const round = (s) => s == null ? 0 : Math.round((s / 5) * 6);
  const valuation = round(v2pillars.value?.score);
  const future_growth = round(v2pillars.future?.score);
  const past_performance = round(v2pillars.past?.score);
  const financial_health = round(v2pillars.health?.score);
  const dividends = round(v2pillars.dividend?.score);
  return {
    valuation,
    future_growth,
    past_performance,
    financial_health,
    dividends,
    total: valuation + future_growth + past_performance + financial_health + dividends,
  };
}

// Map V2 verdict + composite to an SWS-style action band. Conservative
// thresholds — fallback path always biases toward HOLD because we don't
// have the SWS catalyst-aware momentum overlay.
//
// When SWS_LADDER_V2 is enabled the labels promote to the granular ladder.
// We can't run the full pickTrimRung matrix here because we don't have
// position weight / sector weight at fallback time, so we map score-band
// to a conservative ladder rung. Round-trip is deterministic.
function _fallbackAction(v2score) {
  const v2Mode = process.env.SWS_LADDER_V2 !== "0";
  if (v2score == null) return "HOLD";
  if (v2score >= 70) return v2Mode ? "Top-up-25%" : "Top-up-modest";
  if (v2score >= 55) return "HOLD";
  if (v2score >= 40) return "HOLD";
  if (v2score >= 30) return v2Mode ? "Reduction-33%" : "Reduction-25-33%";
  if (v2score >= 14) return v2Mode ? "Reduction-50%" : "Reduction-50%";
  return v2Mode ? "EXIT-staged" : "EXIT";
}

function _v3FromV2(v2score) {
  // V2 composite is already 0..100. The v3 engine uses a slightly
  // different scale (universe-percentile-calibrated). For fallback, we
  // pin v3 ≈ v2 score with a -10 conservative haircut to reflect missing
  // SWS-specific signals.
  if (v2score == null) return null;
  return Math.max(0, v2score - 10);
}

// Coverage-fallback entrypoint. Returns null when no fundamentals.json
// snapshot exists either — the holding genuinely has no data anywhere.
//
// When it does return a result, the shape mirrors the SWS-covered branch
// of scoreHolding so downstream code can read the same fields. The
// `fallback` flag at the top level is the sole differentiator.
export function buildFallbackHolding({ ticker, name, sector, holding }) {
  const key = _toNseKey(ticker);
  if (!key) return null;
  const snapshots = _loadFundamentals();
  if (!snapshots) return null;
  const snap = snapshots[key];
  if (!snap) return null;

  let v2;
  try { v2 = scoreFundamentalsV2(snap); }
  catch (err) { console.warn(`[swsCoverageFallback] ${key} failed: ${err.message}`); return null; }
  if (!v2) return null;

  const fallbackSnow = _v2ToSwsSnowflake(v2.pillars || {});
  const v3 = _v3FromV2(v2.score);
  const rawAction = _fallbackAction(v2.score);
  const marketCapBucket = classifyMarketCapBucket(snap.marketCap);
  const smallcapPolicy = buildSmallcapPolicy({
    marketCapInr: snap.marketCap,
    marketCapBucket,
    positionWeight: num(holding?.positionWeight, 0),
  });
  const dataQualityGate = buildDataQualityGate({
    swsCovered: false,
    fallback: true,
    staleData: true,
    dataAgeHours: null,
    snowflakeDataQuality: null,
    marketCapBucket,
    valuationConfidence: "NONE",
  });
  const reductionEvidence = buildReductionEvidence({
    action: rawAction,
    legacyAction: rawAction,
    band: "FALLBACK",
    dataQualityGate,
    marketCapBucket,
    smallcapPolicy,
    positionWeight: num(holding?.positionWeight, 0),
    v4: v3,
    reconciled: { confidence: "NONE", upside_pct: null },
  });
  const gated = gateReductionAction({
    action: rawAction,
    band: "FALLBACK",
    reasons: [],
    reductionEvidence,
  });
  const action = gated.action;
  const reasons = [
    `Fallback path — SWS doesn't cover this ticker yet.`,
    `Independent fundamentals score: ${v2.score}/100 (verdict: ${v2.verdict}).`,
    `Snowflake (derived from V2 pillars): ${fallbackSnow.total}/30 (val ${fallbackSnow.valuation}, future ${fallbackSnow.future_growth}, past ${fallbackSnow.past_performance}, health ${fallbackSnow.financial_health}, div ${fallbackSnow.dividends}).`,
    `Action conservatively biased toward HOLD because catalyst, news, and analyst-PT signals are unavailable.`,
  ];

  return {
    ...holding,
    swsCovered: false,
    fallback: true,
    fallback_source: "fundamentalsV2",
    sws: {
      ticker: key.replace(/\.NS$/, ""),
      name: name || snap.name || key,
      sector: sector || snap.sector || null,
      sws_url: null,
      score: v2.score,
      v2_score: v2.score,
      v4_score: v3,
      v4_verdict: v2.verdict,
      verdict: v2.verdict,
      band: "FALLBACK",
      snowflake: fallbackSnow,
      snowflake_total: fallbackSnow.total,
      current_price_inr: num(snap.price, null),
      fair_value_inr: null,
      upside_pct: null,
      market_cap_inr: num(snap.marketCap, null),
      market_cap_bucket: marketCapBucket,
      smallcap_policy: smallcapPolicy,
      data_quality_gate: dataQualityGate,
      reduction_evidence: reductionEvidence,
      multiples: { pe: num(snap.pe, null), ps: null, pb: num(snap.priceToBook, null), ev_ebitda: num(snap.enterpriseToEbitda, null) },
      dividend_yield_pct: num(snap.dividendYield, null),
      net_margin_pct: num(snap.profitMargin, null),
      earnings_growth_pct: num(snap.earningsGrowthYoY, null),
      revenue_growth_pct: num(snap.revenueGrowthYoY, null),
      returns_pct: null,
      next_earnings_date: null,
      last_quarter_result: null,
      surveillance: null,
      data_freshness_at: null,
      data_age_hours: null,
      v2_recommendation: {
        version: "v2-fallback",
        action,
        action_source: "fallback",
        conviction: "LOW",
        net_delta: -2,
        layer_votes: { crosscheck: 0, catalyst: 0, indianRisk: 0 },
        agreement: { fallback: true },
        primary_reason: `**${action}** with **LOW** conviction — SWS layer unavailable, decision rests on independent fundamentals only.`,
        narrative_paragraphs: [
          `**${action}** with **low conviction** — SWS doesn't cover ${key.replace(/\.NS$/, "")} (likely demerger, fresh listing, or out-of-universe). Decision rests on independent fundamentals snapshot from yfinance/NSE.`,
          `Independent V2 composite: ${v2.score}/100 (${v2.verdict}). Snowflake-equivalent ${fallbackSnow.total}/30. PE ${num(snap.pe, null)?.toFixed?.(1) ?? "—"}x, ROE ${(num(snap.roe, null) * 100)?.toFixed?.(1) ?? "—"}%, debt/equity ${num(snap.debtToEquity, null)?.toFixed?.(2) ?? "—"}.`,
          `No catalyst, news, or analyst-PT signals available — verdict biased toward HOLD/Reduction. Re-evaluate when SWS coverage extends to this ticker.`,
        ],
        counter_thesis: `Counter-thesis: V2 fundamentals can mis-rate post-demerger entities — RoE / margin trends carry over from the parent and may not reflect standalone economics yet.`,
        falsification_trigger: `Hold the **${action}** view unless any of: (1) SWS coverage lands; (2) two consecutive standalone quarterly results post-demerger settle the new run-rate; (3) external broker initiates coverage with a target price.`,
      },
    },
    action,
    legacyAction: rawAction,
    displayActionIntent: reductionEvidence.status === "coverage_watch" ? "Review only" : undefined,
    reasonFamily: reductionEvidence.intent,
    actionFactors: [`reduction_${reductionEvidence.status}`],
    reductionEvidence,
    dataQualityGate,
    marketCapBucket,
    smallcapPolicy,
    counterEvidence: reductionEvidence.counterEvidence,
    decisionConfidence: reductionEvidence.decisionConfidence,
    blockedReasons: reductionEvidence.blockedReasons,
    reasons,
    timing: {
      verdict: action === "HOLD" ? "n/a" : "Yes-not-urgent",
      window: action === "HOLD" ? null : "post-lunch",
      reason: action === "HOLD" ? "Hold — no transaction needed (fallback verdict; await SWS coverage)." : "Fallback verdict — defer to post-lunch window if acting; not urgent.",
    },
  };
}
