// Per-holding SWS scoring + action engine.
//
// Reads data/sws/deep/{TICKER}.json (mtime-cached), runs the SWS scorer to
// derive composite + v2_score + v3_score + verdict, then maps to a portfolio
// action (EXIT / Reduction-50% / Reduction-25-33% / HOLD / Top-up-modest /
// Top-up / STRONG Top-up) using portfolio-context modifiers (position_weight,
// sector_weight, P&L %).
//
// Score driving the action engine: v3_score_100. v3 is the 50%-coverage-gated
// scorecard (74 fundamentals · 14 momentum · ±15 safety overlay) that uses
// every input we actually have data for and skips the sparse fields v1/v2
// included as zeros. Thresholds in scoreBandAction are calibrated to v3's
// distribution (universe p25≈21, p50≈29, p75≈39, p95≈59), not v1/v2's.
//
// The data shape was studied empirically against the 2026-04-28 API-pipeline
// snapshot. Notable: rewards[]/risks[] are universally empty in this snapshot,
// so narrative-phrase hard overrides are replaced with structured-data overrides
// pulled from the `fiscal` and `overview.snowflake` blocks.

import { scoreStock, num } from "./swsScoring.js";
import * as dal from "./swsDal/index.js";
import { crosscheckHolding } from "./swsLayerCrosscheck.js";
import { extractCatalystSignals } from "./swsCatalystLayer.js";
import { extractIndianRiskSignals } from "./swsIndianRiskLayer.js";
import { computeRecommendationV2 } from "./swsConvictionEngine.js";
import { isV1Only, isV2Primary, getRecommenderMode } from "./swsRecommenderMode.js";
import { findPeerSubstitutes } from "./swsPeerLayer.js";
import { buildFallbackHolding } from "./swsCoverageFallback.js";
import { buildAuditTrail } from "./swsAuditTrail.js";
import { promoteToLadderV2, parseTrimPct, parseTopUpPct } from "./actionLadder.js";
import { computeTimingObservation as computeTimingObservationFromModule } from "./timingObservation.js";
import { gateActionByTier, getLiquidityTier } from "./swsTierGate.js";

// V3-universe and per-ticker deep loads now go through services/swsDal.
// Backwards-compatible re-exports — many modules import these names; the
// underlying caching, file paths, and ticker normalisation live in the DAL
// (see services/swsDal/jsonBackend.js).
export function loadV3Universe() {
  return dal.getV3UniverseStats();
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

// Reconcile the SWS-scraped FV / upside_pct trio. Empirically the deep JSONs
// in data/sws/deep ship with several failure modes:
//
//   1. price present, FV null, upside_pct = a junk number (WIPRO: -3671.4)
//   2. price present, FV is a placeholder ratio not a price (BALUFORGE: 1.66)
//   3. price ≈ FV (scraper re-used current price as FV) but upside_pct still
//      carries the analyst-consensus number (LODHA, HAL, JWL: 32.1 / 15.6 / 16)
//   4. price + FV both present, upside_pct null (ITC: should be +26.7%)
//
// We trust this hierarchy:
//   • If FV/price ratio is plausible and FV != price → recompute upside.
//   • If FV ≈ price → the recompute is ~0; prefer the SWS-quoted upside if
//     it lies in a sane range (the analyst consensus is the live SWS view).
//   • If FV is missing or implausibly off price → the FV is junk, fall back
//     to the SWS-quoted upside only if it's in [-95%, +500%] — otherwise null.
//
// Returns { upside_pct, fair_value_inr } — both possibly null. The caller
// should overwrite `sws.upside_pct` and `sws.fair_value_inr` with these so
// the rest of the report (Tier-B classifier, basket rows, reason text) sees
// the same reconciled view.
export function _reconcileFVUpside(ov) {
  const price = num(ov?.current_price_inr, null);
  const rawFv = num(ov?.fair_value_inr, null);
  const rawUp = num(ov?.upside_pct, null);
  const inSaneRange = (v) => v != null && Number.isFinite(v) && v >= -95 && v <= 500;

  // Case A: both price + FV present.
  if (price != null && price > 0 && rawFv != null && rawFv > 0) {
    const ratio = rawFv / price;
    // Plausible-ratio guard: a real DCF FV shouldn't be < 1/10 of the price
    // or > 10× the price — anything outside that window is a scraper artefact.
    if (ratio >= 0.1 && ratio <= 10) {
      const computed = ((rawFv - price) / price) * 100;
      // FV ≈ price (placeholder) → trust the SWS-quoted upside if sane.
      if (Math.abs(computed) <= 1 && inSaneRange(rawUp)) {
        return { upside_pct: Math.round(rawUp * 10) / 10, fair_value_inr: rawFv };
      }
      // Otherwise prefer the math.
      return { upside_pct: Math.round(computed * 10) / 10, fair_value_inr: rawFv };
    }
    // Implausible ratio → FV is junk; both fields nulled so the UI doesn't
    // surface "(₹2 vs ₹548)" garbage.
    return { upside_pct: null, fair_value_inr: null };
  }

  // Case B: only one (or neither) present. Trust the SWS-quoted upside iff sane.
  return {
    upside_pct: inSaneRange(rawUp) ? Math.round(rawUp * 10) / 10 : null,
    fair_value_inr: rawFv,
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
export function evaluateHardOverrides({ scored, holding, snow, fiscal, position_weight, sector_weight, upside }) {
  const surveillance = scored.v2_breakdown?.surveillance || null;

  // GSM surveillance is special — exits the holding entirely, not a partial
  // trim. Returns immediately with a single regulatory reason.
  if (surveillance && surveillance.list === "GSM") {
    return { action: "EXIT", reasons: [`Listed on NSE GSM surveillance (${surveillance.timeframe || "—"}) — regulatory red flag, exit per SEBI-aligned framework.`] };
  }

  const pnl = num(holding.pnlPercent, 0);
  const snowTotal = snow.total;
  const fwdGrowth = num(fiscal.earnings_growth_pct, null);
  const pw = num(position_weight, 0);
  const sw = num(sector_weight, 0);
  const up = Number.isFinite(upside) ? upside : null;

  const reasons = [];

  // ─── Override A: single-stock concentration cap ──────────────────
  // SEBI RA risk-management observation: single-issuer concentration above
  // a threshold is a portfolio-level risk independent of the issuer's
  // fundamentals. Even a high-quality compounder at 40%+ weight is sizing
  // imprudence, not stock-selection genius. Forces partial trim — the
  // severity escalator (pw>30 → ≥0.55) then promotes to Red-66%.
  if (pw > 35) {
    reasons.push(`Position weight ${pw.toFixed(1)}% exceeds 35% concentration cap — single-name risk independent of fundamentals (SEBI RA risk-management observation).`);
  } else if (pw > 25) {
    reasons.push(`Position weight ${pw.toFixed(1)}% exceeds 25% concentration threshold — partial trim to restore single-name risk discipline.`);
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
    } else if (up <= -30 && snowTotal <= 14) {
      reasons.push(`Trading ${Math.abs(up).toFixed(1)}% above AnalystConsensus FV with weak fundamentals (Snowflake ${snowTotal}/30) — overvaluation + thin fundamental support.`);
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
  }

  // ─── Existing earnings-declining override (preserved) ────────────
  if (fwdGrowth != null && fwdGrowth < -10) {
    reasons.push(`Earnings declining ${fwdGrowth.toFixed(1)}% YoY (fiscal block) — structurally weak, reduce exposure.`);
  }

  // ─── Existing fragile-balance + extreme-PE override (preserved) ──
  if (snow.financial_health <= 1 && (scored.overview?.multiples?.pe ?? 0) > 100) {
    reasons.push(`Fragile balance sheet (Health ${snow.financial_health}/6) at extreme valuation (P/E ${scored.overview?.multiples?.pe?.toFixed?.(1) ?? "—"}x).`);
  }

  // ─── Existing narrative-red override (preserved) ─────────────────
  // Rarely fires on current API-pipeline snapshots (rewards/risks empty)
  // but covered for older snapshots and any future re-population.
  const risksList = scored.overview?.risks || [];
  for (const r of risksList) {
    if (NARRATIVE_RED.test(String(r))) {
      reasons.push(`SWS narrative flag: "${String(r).slice(0, 120)}".`);
      break;
    }
  }

  if (reasons.length === 0) return null;
  // All firing overrides emit Reduction-50% legacy. The V3 severity model
  // then picks the specific rung — Red-66% for pw>30 via the severity
  // escalator, Red-50% otherwise.
  return { action: "Reduction-50%", reasons };
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
function scoreBandAction({ v3, snow, upside, position_weight, sector_weight, risks_count }) {
  // scoreBandAction always emits LEGACY labels. The ladder-v2 promotion
  // runs as a post-stage on the FINAL action (after the conviction
  // engine + position guardrails), in scoreHolding below — that's the
  // only place where conviction proxy + the post-guardrail action are
  // both known, so granular rung selection sees the full factor stack.
  if (v3 < 14) return { action: "EXIT", band: "AVOID" };

  // Trim band — every v3<22 stock starts at Reduction-50% legacy and lets
  // severity → rung pick the realised label. Position-weight no longer
  // gates which legacy label we emit; severity has concentration baked in.
  if (v3 < 22) return { action: "Reduction-50%", band: "WATCH" };

  // NEW band — v3 22-30 enters the trim path at Reduction-25-33% legacy.
  // The severity model decides whether it lands at Red-25, Red-33, or even
  // Red-50 for chunky/losing positions. Below the 0.10 severity floor it
  // falls through to HOLD via the V3 promoter's null path.
  if (v3 < 30) return { action: "Reduction-25-33%", band: "WATCH-MILD" };

  if (v3 < 40) return { action: "HOLD", band: "ACCEPTABLE" };

  // PR 2.4 — every Top-up rung now requires a positive upside-to-AnalystFV.
  // Previously the STRONG and TOP_PICK Top-up-modest paths fell through with
  // no upside floor, so we'd recommend doubling down on already-overvalued
  // names (SUZLON Top-up-100% on +15.6% upside but verdict OVERVALUED;
  // HDFCBANK Top-up-25% on +13.4% upside; BSOFT/NAVNETEDUL fresh top-up at
  // negative upside). When a Top-up rung's upside floor isn't met we fall
  // through to HOLD instead of a different rung — never push capital into a
  // position whose price is at or above estimated fair value.
  if (v3 < 50) {
    if (position_weight <= 8 && sector_weight <= 25 && upside >= 5) {
      return { action: "Top-up-modest", band: "ACCEPTABLE-PLUS" };
    }
    return { action: "HOLD", band: "ACCEPTABLE-PLUS" };
  }

  if (v3 < 65) {
    if (upside >= 15 && risks_count === 0 && position_weight <= 6) {
      return { action: "Top-up", band: "STRONG" };
    }
    if (position_weight <= 8 && sector_weight <= 25 && upside >= 5) {
      return { action: "Top-up-modest", band: "STRONG" };
    }
    return { action: "HOLD", band: "STRONG" };
  }

  // v3 ≥ 65 (TOP_PICK band) — STRONG Top-up tightened from upside ≥ 10 to
  // ≥ 15 so the most aggressive rung (Top-up-100% via ladder-v2) only fires
  // on a clear discount.
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
  if (scored.v2_breakdown?.surveillance) {
    const s = scored.v2_breakdown.surveillance;
    reasons.push(`NSE ${s.list}${s.timeframe ? ` (${s.timeframe})` : ""} surveillance.`);
  }

  return reasons;
}

/**
 * Backward-compatibility shim. The real timing logic moved to
 * services/timingObservation.js as part of PR-3 (richer inputs:
 * NSE market state from IST clock, macro-regime severity, sector
 * impact). Existing callers still hit this name; new callers use
 * computeTimingObservationFromModule directly.
 */
export function computeTimingObservation({ deep, scored, action, livePrice, now, marketState, regimeSeverity, sectorImpact } = {}) {
  return computeTimingObservationFromModule({
    action,
    scored,
    now: now instanceof Date ? now : new Date(),
    marketState,
    regimeSeverity,
    sectorImpact,
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
  // Reconcile FV / upside_pct once — every downstream consumer (action
  // mapping, reasons, basket classifier) reads the same clean numbers.
  const reconciled = _reconcileFVUpside(ov);

  const position_weight = num(holding.positionWeight, 0);
  const sector_weight = num(portfolioContext.sectorWeights?.[scored.sector] ?? holding.sectorWeight, 0);
  const upside = num(reconciled.upside_pct, 0);
  const risks_count = scored.v2_breakdown?.risks_count ?? (ov.risks?.length || 0);

  const surveillance = scored.v2_breakdown?.surveillance || null;

  const hard = evaluateHardOverrides({
    scored, holding, snow, fiscal,
    position_weight, sector_weight, upside,
  });
  let action, band, reasons;
  if (hard) {
    action = hard.action;
    band = "HARD_OVERRIDE";
    reasons = hard.reasons;
  } else {
    const sb = scoreBandAction({
      v3: num(scored.v3_score_100, 0),
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

  // Pass regime severity + sector impact from portfolioContext when the
  // server provides them (analyzer route does — computed once per
  // request from the macro-regime layer). When missing, the timing
  // module degrades gracefully — momentum + earnings + market-state
  // signals remain.
  const timing = computeTimingObservation({
    deep: scored,
    scored,
    action,
    now: portfolioContext.now instanceof Date ? portfolioContext.now : undefined,
    marketState: portfolioContext.marketState,
    regimeSeverity: num(portfolioContext.regimeSeverity, 0),
    sectorImpact: num(portfolioContext.sectorImpactBySector?.[scored.sector], 0),
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
    swsV3Score: num(scored.v3_score_100, null),
  });

  // Layer-3 (Indian-specific risk) and Layer-4 (catalyst) shadow attaches.
  const catalyst = extractCatalystSignals(scored);
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
        sws_v3: num(scored.v3_score_100, null),
        sws_verdict: scored.v3_verdict,
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
    v3: num(scored.v3_score_100, 0),
    snow_total: snow?.total ?? 0,
    position_weight,
    sector_weight,
    upside,
    risks_count,
    surveillance: scored.v2_breakdown?.surveillance || null,
    pnlPercent: num(holding.pnlPercent, 0),
    // V4 inputs (silently ignored when SWS_LADDER_V4 is off)
    pillars: snow,
    daysHeld: _daysHeld,
    fiftyTwoWeekHigh: num(holding.fiftyTwoWeekHigh, null),
    fiftyTwoWeekLow:  num(holding.fiftyTwoWeekLow, null),
    currentPrice:     _currentPrice,
    currentValue:     _currentValue > 0 ? _currentValue : null,
    materialDisclosure: false, // wire from a disclosure feed when one lands
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
  const dataAgeHours = dataFreshnessMs(scored) != null ? Math.round(dataFreshnessMs(scored) / 3600000) : null;
  const staleData = Number.isFinite(dataAgeHours) && dataAgeHours > 36;
  if (staleData) {
    finalReasons = [`SWS data ${dataAgeHours}h old — verify before acting.`, ...finalReasons];
  }

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
      v3_score: scored.v3_score_100,
      v3_verdict: scored.v3_verdict,
      verdict: scored.verdict,
      band,
      crosscheck,
      catalyst,
      indianRisk,
      snowflake: snow,
      snowflake_total: snow.total,
      current_price_inr: ov.current_price_inr,
      fair_value_inr: reconciled.fair_value_inr,
      upside_pct: reconciled.upside_pct,
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
      surveillance: scored.v2_breakdown?.surveillance || null,
      data_freshness_at: scored.parsed_at,
      data_age_hours: dataFreshnessMs(scored) != null ? Math.round(dataFreshnessMs(scored) / 3600000) : null,
      breakdown: scored.score_breakdown,
      v2_breakdown: scored.v2_breakdown,
      v3_breakdown: scored.v3_breakdown,
      v2_recommendation: v2recommendation,
      recommender_mode: getRecommenderMode(),
      peer_substitute: findPeerSubstitutes({
        ticker: scored.ticker,
        sector: scored.sector,
        sws_v3: num(scored.v3_score_100, null),
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
    staleData,
    reasons: finalReasons,
    timing,
    audit: buildAuditTrail({
      holding: { ...holding, sws: { ticker: scored.ticker, snowflake: snow, fair_value_inr: reconciled.fair_value_inr, crosscheck, catalyst, indianRisk, peer_substitute: { top_peer: null }, v2_recommendation: v2recommendation, v3_score: num(scored.v3_score_100, null), v3_verdict: scored.v3_verdict }, action: finalAction },
      scored,
      recommenderMode: getRecommenderMode(),
    }),
  };
}
