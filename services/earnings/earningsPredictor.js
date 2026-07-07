/**
 * earningsPredictor.js
 *
 * Pure scoring function. Takes the per-event signals block produced by
 * signalAggregator and emits:
 *
 *   {
 *     verdict: "BEAT" | "INLINE" | "MISS" | "INSUFFICIENT_DATA",
 *     confidence_pct: 0–65 (V1 cap; lifted in M-F after backtest),
 *     score_100: 0–100,
 *     score_breakdown: { ... per-component points ... },
 *   }
 *
 * Mirrors the shape of `computeCompositeScore()` in scripts/sws-scoring.mjs:150
 * — same per-component breakdown style so a reviewer audits both with
 * the same mental model.
 *
 * V1 weighting reflects what's available offline today (no news,
 * announcements, or block-deal feeds yet — those land in Milestone D
 * and the formula will redistribute weight then). The plan's
 * canonical 7-component weighting lives in CLAUDE-friendly comments
 * at each section so a future change is auditable.
 *
 * Hard rules — non-negotiable:
 *   1. data_quality === "LOW" ⇒ verdict = "INSUFFICIENT_DATA". No
 *      score, no confidence, no price band downstream. SEBI-RA discipline.
 *   2. confidence_pct hard cap = 65 in V1. Lift only after
 *      earningsHistoryArchive (M-F) accumulates ≥30 result-pairs and
 *      backtest hit-rate ≥ 55% in the 60–65% bucket.
 */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ────────── Constants ──────────

export const PREDICTOR_VERSION = "earnings-predict-v3-2026-05";

/**
 * V1 confidence ceiling. The predictor will never claim more confidence
 * than this until earningsHistoryArchive (M-F) confirms calibration.
 */
export const V1_CONFIDENCE_CAP_PCT = 65;

/**
 * Verdict thresholds — v3 (P0-PR2 2026-05).
 *
 * Pre-v3 used static 65/35 cuts unconditionally. After the v2.1
 * missing-data penalty shipped, the observed score distribution
 * across 534 forward-looking predictions (refresh on 2026-05-17)
 * had mean=44.3, std=21.5, p33=33.8, p67=54.3. The empirical p67 of
 * 54.3 is dramatically below the static 65 BEAT cut — the predictor
 * was systematically under-emitting BEAT (17.8% vs ~36% actual base
 * rate).
 *
 * Empirical thresholds (frozen — not computed live to avoid the
 * feedback loop where the predictor's own distribution defines its
 * own thresholds and the MISS-pulling intent is neutralised):
 *
 *   MISS_CUT_EMPIRICAL = 34  (was 35; near observed p33)
 *   BEAT_CUT_EMPIRICAL = 56  (was 65; near observed p67)
 *
 * Static fallback retained for back-compat — used when called outside
 * the v3+ predictor or when an explicit override sets the env var
 * `EARNINGS_PREDICTOR_STATIC_THRESHOLDS=1`.
 */
export const MISS_CUT_EMPIRICAL = 34;
export const BEAT_CUT_EMPIRICAL = 56;
export const MISS_CUT_STATIC = 35;
export const BEAT_CUT_STATIC = 65;

function activeThresholds() {
  if (process.env.EARNINGS_PREDICTOR_STATIC_THRESHOLDS === "1") {
    return {
      missCut: MISS_CUT_STATIC,
      beatCut: BEAT_CUT_STATIC,
      source: "static_fallback",
      version: "v1",
    };
  }
  return {
    missCut: MISS_CUT_EMPIRICAL,
    beatCut: BEAT_CUT_EMPIRICAL,
    source: "empirical",
    version: "v3-2026-05",
  };
}

/**
 * Small directional nudge from the V3 composite verdict. Deliberately
 * tiny (±2) — the decomposed V3 pillars carry the real weight; this
 * just breaks ties consistently with SWS's own classification.
 */
const V3_VERDICT_NUDGE = {
  TOP_PICK: 2,
  STRONG: 1,
  ACCEPTABLE: 0,
  WATCH: -1,
  AVOID: -2,
};

// ────────── Component scorers ──────────
// Each returns a `{ pts, why }` blob. `why` is a short tag-like string
// the rationale narrator (Milestone C/3) lifts verbatim into ¶1.

/**
 * Component 1a — V4 future + past pillars.
 *
 * v2 replaces the old ±32 `scoreSwsQuality` (which just echoed the
 * blunt composite verdict — the thing that made 73% of predictions
 * cluster on INLINE) with the decomposed SWS V4 100-pt breakdown.
 *
 * `pts_future` (0–22 since v4.1, SWS forward-earnings-growth pillar) and
 * `pts_past` (0–16, earnings-trajectory pillar) are the two V4 pillars
 * most predictive of a next-quarter beat/miss. They are anchored at
 * their neutral midpoint (a 3/6 snowflake pillar) so a weak-future
 * stock scores genuinely NEGATIVE rather than merely zero — the old
 * verdict echo could only ever subtract via an explicit AVOID label.
 *
 * Max: ±18 pts (±12 future + ±6 past, plus a ±2 verdict nudge, clamped).
 */
function swsV4Signal(signals) {
  return signals?.v4 || signals?.v3 || null;
}

function scoreV3FuturePast(signals) {
  const swsSignal = swsV4Signal(signals);
  const b = swsSignal?.breakdown;
  if (!b) return { pts: 0, breakdown: { futurePts: 0, pastPts: 0 }, why: "no V4 signal" };

  const ptsFuture = num(b.pts_future) ?? 11; // v4.1: neutral = (3/6)*22
  const ptsPast = num(b.pts_past) ?? 8; // V4: neutral = (3/6)*16 (Past is 0–16)
  // Anchor at the neutral midpoint, scale to ±12 / ±6. (v4.1: Future is now
  // 0–22, so the neutral anchor + scale move 10→11 — else a neutral 3/6 stock
  // lands at 11 and reads as a phantom +1.2 BEAT bias.)
  const futureContrib = clamp(((ptsFuture - 11) / 11) * 12, -12, 12);
  const pastContrib = clamp(((ptsPast - 8) / 8) * 6, -6, 6); // V4 Past 0–16, neutral 8
  const verdict = swsSignal.v4_verdict || swsSignal.v3_verdict;
  const verdictNudge = num(V3_VERDICT_NUDGE[verdict]) ?? 0;

  const pts = Math.round(clamp(futureContrib + pastContrib + verdictNudge, -18, 18) * 10) / 10;
  return {
    pts,
    breakdown: {
      futurePts: Math.round(futureContrib * 10) / 10,
      pastPts: Math.round(pastContrib * 10) / 10,
      verdictNudge,
    },
    why: `V4 future ${ptsFuture.toFixed(0)}/22 · past ${ptsPast.toFixed(0)}/16` +
      (verdict ? ` (${verdict})` : ""),
  };
}

/**
 * Component 1b — V3 valuation (fair-value upside) pillar.
 *
 * Folds the old standalone `scoreFvUpside` component. Uses the V3
 * `pts_fv_upside` tier (0–12, neutral 6 = fair value) anchored so a
 * deep discount is a positive BEAT setup and an overvalued stock is a
 * genuine fade signal. Falls back to the raw `upside_pct` heuristic
 * only when there's no V3 block at all.
 *
 * Max: ±8 pts.
 */
function scoreV3Valuation(signals) {
  const b = swsV4Signal(signals)?.breakdown;
  if (!b || num(b.pts_fv_total) == null) {
    // Fallback — no V4 FV composite; score off raw FV upside.
    return scoreFvUpside(signals);
  }
  const ptsFv = num(b.pts_fv_total); // 0..12, neutral 6 (renormalised V4 composite)
  let raw = ((ptsFv - 6) / 6) * 8;
  // MED-9 guard: a single-signal composite (e.g. cheap-P/E with NO analyst FV)
  // is a weaker BEAT/fade signal than a two-signal one — halve its weight so a
  // P/E-only stock can't masquerade as a max-discount BEAT. fv_imputed (zero
  // signals) is already neutral (ptsFv=6 → 0).
  if (num(b.fv_subsignals_present) === 1) raw *= 0.5;
  const pts = Math.round(clamp(raw, -8, 8) * 10) / 10;
  return {
    pts,
    breakdown: { fvPts: pts, pts_fv_total: ptsFv, subsignals: b.fv_subsignals_present ?? null, imputed: !!b.fv_imputed },
    why: b.fv_imputed
      ? "V4 valuation: fair-value imputed (no FV anchor)"
      : pts > 0
        ? `V4 valuation: ${ptsFv}/12 FV-composite (discount → BEAT setup)`
        : pts < 0
          ? `V4 valuation: ${ptsFv}/12 FV-composite (rich → fade risk)`
          : "V4 valuation: fairly valued",
  };
}

/**
 * Component 1c — V3 risk overlay.
 *
 * Pure penalty, never positive. Carries the V3 `pts_overlay` (NSE
 * surveillance ASM/GSM, falling-knife, catalyst-chase) straight
 * through, capped at −10. A stock on the surveillance list heading
 * into a result deserves a hard haircut regardless of how good the
 * other signals look.
 *
 * Max: −10 pts (0 when no flags).
 */
function scoreV3Overlay(signals) {
  const b = swsV4Signal(signals)?.breakdown;
  if (!b || num(b.pts_overlay) == null) {
    return { pts: 0, breakdown: { overlayPts: 0 }, why: "no V4 risk flags" };
  }
  const pts = clamp(num(b.pts_overlay), -10, 0);
  const reasons = Array.isArray(b.overlay_reasons) ? b.overlay_reasons : [];
  return {
    pts,
    breakdown: { overlayPts: pts, overlay_reasons: reasons },
    why: pts < 0
      ? `V4 risk overlay: ${reasons.join("; ") || "flagged"}`
      : "no V4 risk flags",
  };
}

/**
 * Component 2 — Pre-runup signal. Asymmetric: a smooth informed-flow
 * runup is mildly positive, a chase-spike is negative (priced-in risk),
 * lagging is mildly positive (room to surprise).
 *
 * Max: ±15 pts.
 */
function scoreRunup(signals) {
  const r = signals.momentum?.pre_runup_signal || "neutral";
  const delta = num(signals.momentum?.runup_vs_sector_pct) ?? 0;

  let pts = 0;
  let why = "neutral runup vs sector";
  if (r === "spike") {
    pts = -12;
    why = `pre-runup spike (+${delta.toFixed(1)}% vs sector — priced-in risk)`;
  } else if (r === "smooth") {
    pts = 8;
    why = `smooth runup (+${delta.toFixed(1)}% vs sector — informed flow)`;
  } else if (r === "lagging") {
    pts = 5;
    why = `lagging sector (${delta.toFixed(1)}% vs sector — room to surprise)`;
  }
  return { pts, breakdown: { runupPts: pts }, why };
}

/**
 * Component 3 — Sector momentum (peer-tide proxy). When peers are
 * rallying, the sector tide lifts even mediocre results. Compute from
 * the sector's avg 1M return relative to a neutral baseline (0%).
 *
 * P2.7 — Vol-scaled (Sharpe-like). The legacy scaler treated a noisy
 * +8% sector month identically to a clean +8% rotation. We now divide
 * by the cross-sectional 1M dispersion when available:
 *   - vol < 2%  : low-noise sector → full points (1.0× multiplier).
 *   - vol >= 2% : multiplier = min(2 / vol_pct, 1.0). A 4%-vol sector
 *                 gets half points; a 10%-vol sector gets 0.2× — high-
 *                 vol bounces are downweighted.
 *   - vol null  : legacy unscaled path, preserves prior verdicts.
 *
 * The 2% floor + cap-at-1.0 is a heuristic — when the raw daily-returns
 * data lands (Phase 4 SQL `stddev(returns_daily) GROUP BY sector` over
 * a 21-trading-day window), this multiplier should be retuned against
 * the backtest. For now it's the most-defensible shape we can ship
 * without breaking the legacy behaviour for null-vol callers.
 *
 * Max: ±10 pts.
 */
function scoreSectorMomentum(signals) {
  const sectorAvg = num(signals.momentum?.sector_avg_1m_pct);
  if (sectorAvg == null) return { pts: 0, breakdown: { sectorPts: 0 }, why: "no sector flow" };

  // Linear scale: +10% sector return = +5 pts; ±20% = ±10 pts.
  let pts = clamp(sectorAvg / 2, -10, 10);

  // P2.7 — Sharpe-like vol scaling.
  const sectorVol = num(signals.momentum?.sector_volatility_1m_pct);
  let volMultiplier = 1;
  let volScaled = false;
  if (sectorVol != null && sectorVol >= 2) {
    volMultiplier = Math.min(2 / sectorVol, 1);
    pts = pts * volMultiplier;
    volScaled = true;
  } else if (sectorVol != null) {
    // vol < 2% — treat as noisy-zero, no downweight applied. The flag
    // still records "scaled" so the audit trail is honest about the
    // path taken.
    volScaled = true;
  }
  pts = Math.round(pts * 10) / 10;
  const volNote =
    sectorVol == null
      ? ""
      : volScaled && sectorVol >= 2
        ? ` (vol ${sectorVol.toFixed(1)}% → ${volMultiplier.toFixed(2)}× downweight)`
        : ` (vol ${sectorVol.toFixed(1)}%)`;
  return {
    pts,
    breakdown: {
      sectorPts: pts,
      sector_vol_1m_pct: sectorVol,
      vol_multiplier: Math.round(volMultiplier * 100) / 100,
      vol_scaled: volScaled,
    },
    why:
      `sector ${signals.sector || "?"} ${sectorAvg >= 0 ? "+" : ""}${sectorAvg.toFixed(1)}% over 1M` +
      volNote,
  };
}

/**
 * Component 4 — Trajectory. EPS YoY growth from the last reported
 * quarter pair. Often null (fundamentalsHistory only covers ~1,086 of
 * the 5,400+ NSE names) — the function returns 0 pts in that case
 * rather than imputing.
 *
 * P2.4 — When data_quality_flags.trajectory === "absent", the 0 pts
 * stay (so the verdict math is unchanged from legacy behaviour) but
 * the breakdown surfaces a `status: "absent"` + an explicit note so
 * the rationale narrator and the UI can say "UNKNOWN, not BAD". This
 * fixes the silent score-understatement for the ~80% of NSE tickers
 * that fundamentalsHistory does not cover.
 *
 * Max: ±15 pts. Symmetric.
 */
function scoreTrajectory(signals) {
  const epsYoY = num(signals.trajectory?.eps_yoy_pct);
  const trajectoryFlag = signals.data_quality_flags?.trajectory || null;

  if (epsYoY == null) {
    // Distinguish "absent" (data we do not have) from "present but
    // null" (data we have but cannot compute YoY for). Both score 0
    // pts; only "absent" gets the explicit UNKNOWN note. This keeps
    // the verdict identical for both paths but lets the narrator
    // surface the data-quality story.
    if (trajectoryFlag === "absent") {
      return {
        pts: 0,
        breakdown: {
          trajectoryPts: 0,
          status: "absent",
          note:
            "EPS trajectory data unavailable for this ticker — " +
            "component scored as neutral 0 (NOT negative)",
        },
        why: "EPS trajectory unknown (not negative)",
      };
    }
    return { pts: 0, breakdown: { trajectoryPts: 0 }, why: "no trajectory data" };
  }
  // 25%+ YoY EPS growth → +10 pts; 50%+ → +15 cap; -25% → -10; -50% → -15.
  let pts = clamp(epsYoY / 2.5, -15, 15);
  pts = Math.round(pts * 10) / 10;
  return {
    pts,
    breakdown: { trajectoryPts: pts, status: "covered" },
    why: `EPS YoY ${epsYoY >= 0 ? "+" : ""}${epsYoY.toFixed(1)}%`,
  };
}

/**
 * Component 5 — Fair value upside. Stocks trading well below SWS fair
 * value have an asymmetric BEAT setup (any reasonable result re-rates
 * them up). Trading well above FV is a fade signal.
 *
 * Max: ±8 pts.
 */
function scoreFvUpside(signals) {
  const upside = num(signals.upside_pct);
  if (upside == null) return { pts: 0, breakdown: { fvPts: 0 }, why: "no FV anchor" };
  // 30% upside → +6 pts; 50%+ → +8; -20% (overvalued) → -5; -40% → -8.
  let pts;
  if (upside >= 0) pts = clamp(upside / 6, 0, 8);
  else pts = clamp(upside / 5, -8, 0);
  pts = Math.round(pts * 10) / 10;
  return {
    pts,
    breakdown: { fvPts: pts },
    why: upside >= 0
      ? `+${upside.toFixed(1)}% to SWS fair value`
      : `${upside.toFixed(1)}% above SWS fair value (overvalued)`,
  };
}

/**
 * Component 6 — Last quarter result echo. If we know the last quarter
 * was a beat/miss, give a mild persistence bias. Companies don't
 * usually flip from beat to miss without a visible catalyst.
 *
 * Max: ±5 pts.
 */
function scoreLastQuarterEcho(signals) {
  const last = signals.sws_upcoming_earnings?.last_quarter_result;
  if (!last) return { pts: 0, breakdown: { echoPts: 0 }, why: "no last-quarter signal" };
  if (last === "beat") return { pts: 4, breakdown: { echoPts: 4 }, why: "last quarter beat" };
  if (last === "miss") return { pts: -4, breakdown: { echoPts: -4 }, why: "last quarter missed" };
  return { pts: 0, breakdown: { echoPts: 0 }, why: `last quarter ${last}` };
}

/**
 * Component 7 — Recent corporate-announcement materiality (Milestone D).
 *
 * Sums materiality scores of the top-3 most-material announcements in
 * the last 30 days, signed by classification:
 *   ORDER_WIN, CAPACITY_EXPANSION, MA_DEAL, BUYBACK, BONUS  →  positive
 *   LITIGATION                                              →  negative
 *   RATING_ACTION, FUND_RAISING, MGMT_CHANGE                →  context-only (signed by separate heuristic)
 *
 * Max: ±10 pts. The materiality_score raw values land in 0–8 per
 * announcement, top-3 sum at 24 max — we scale and cap.
 */
function scoreAnnouncements(signals) {
  const ann = signals.announcements;
  if (!ann || !Array.isArray(ann.top3) || ann.top3.length === 0) {
    return { pts: 0, breakdown: { announcementsPts: 0 }, why: "no recent announcements" };
  }
  let raw = 0;
  for (const a of ann.top3) {
    const m = num(a.materiality_score) || 0;
    const cls = a.classification || "OTHER";
    if (["ORDER_WIN", "CAPACITY_EXPANSION", "MA_DEAL", "BUYBACK", "BONUS"].includes(cls)) {
      raw += m; // positive contribution
    } else if (cls === "LITIGATION") {
      raw -= m; // negative
    } else if (cls === "RATING_ACTION") {
      // Rating actions need direction — not in V1 schema. Treat as 0.
      raw += 0;
    } else if (cls === "FUND_RAISING") {
      raw += m * 0.3; // mildly positive (capital structure expansion ≈ growth ahead)
    } else {
      // SHAREHOLDER_MEET, RESULT_INTIMATION, MGMT_CHANGE, DIVIDEND, OTHER
      raw += 0;
    }
  }
  const pts = clamp(Math.round(raw * 10) / 10, -10, 10);
  const topClass = ann.top3[0]?.classification || "OTHER";
  const why = pts > 0
    ? `material catalyst: ${topClass}${ann.top3.length > 1 ? ` (+${ann.top3.length - 1} more)` : ""}`
    : pts < 0
      ? `material risk: ${topClass}`
      : `recent announcements (no directional weight)`;
  return { pts, breakdown: { announcementsPts: pts }, why };
}

/**
 * Component 8 — Bulk/block deal flow (Milestone D).
 *
 * Signed institutional-flow signal over the last 7 days. Net positive
 * notional = accumulation (mild bullish), net negative = distribution
 * (mild bearish). The notional is in INR; we compare it to the
 * stock's market cap to bound impact — a ₹10 Cr deal in a ₹50,000 Cr
 * stock should not move the predictor.
 *
 * Max: ±7 pts.
 */
function scoreDealFlow(signals) {
  const deals = signals.deals_7d;
  if (!deals) return { pts: 0, breakdown: { dealsPts: 0 }, why: "no recent bulk/block deals" };

  const netNotional = num(deals.net_notional_inr) ?? 0;
  const mcap = num(signals.market_cap_inr) ?? 0;
  if (Math.abs(netNotional) < 1e7 || mcap < 1e7) {
    return { pts: 0, breakdown: { dealsPts: 0 }, why: "deal flow below threshold" };
  }
  const pctOfMcap = (netNotional / mcap) * 100;

  // 0.5% of mcap = ±3 pts. 1.5% of mcap = ±7 pts. Capped.
  let pts = clamp(pctOfMcap * 5, -7, 7);
  pts = Math.round(pts * 10) / 10;

  const sign = netNotional >= 0 ? "buy" : "sell";
  const why =
    pts === 0
      ? "deal flow below threshold"
      : `net institutional ${sign} ${(Math.abs(pctOfMcap)).toFixed(2)}% of mcap last 7d`;
  return { pts, breakdown: { dealsPts: pts }, why };
}

/**
 * Component 9 — LLM qualitative signal.
 *
 * A small qualitative read of the SWS narrative + counter-thesis +
 * recent news, produced by the Groq → Gemini → heuristic chain in
 * earningsLlmBatcher (attached to signals.llm_signal before the
 * predictor runs). Deliberately capped at ±10 so a bad LLM call cannot
 * flip a borderline INLINE to BEAT — its real value is the rationale
 * uplift, not swinging the verdict.
 *
 * `bias` gives the sign, |confidence_delta_pct| / 5 scales magnitude.
 * Null or neutral → 0 pts (graceful — the predictor runs fine with no
 * LLM signal at all, e.g. under --skip-llm or a provider outage).
 *
 * Max: ±10 pts.
 */
function scoreLlmSignal(signals) {
  const llm = signals.llm_signal;
  if (!llm || !llm.bias || llm.bias === "neutral") {
    return {
      pts: 0,
      breakdown: { llmPts: 0 },
      why: llm ? `LLM read: neutral (${llm.classifier_provider || "?"})` : "no LLM signal",
    };
  }
  const sign = llm.bias === "lean_beat" ? 1 : -1;
  const delta = num(llm.confidence_delta_pct) ?? 0;
  const pts = Math.round(clamp(sign * (Math.abs(delta) / 5) * 10, -10, 10) * 10) / 10;
  return {
    pts,
    breakdown: { llmPts: pts, bias: llm.bias, provider: llm.classifier_provider },
    why: `LLM (${llm.classifier_provider || "?"}): ${llm.top_reason || llm.bias}`,
  };
}

/**
 * Component 10 — Missing-data caution penalty (v2.1, P0-PR1 2026-05).
 *
 * SEBI-RA stance: absence of evidence is NOT evidence of absence. When
 * the key qualitative inputs we'd use to identify a MISS are missing
 * (V3 breakdown, EPS trajectory, recent announcements, LLM signal),
 * the predictor leans toward caution by a small capped amount rather
 * than scoring as if those signals were neutral.
 *
 * Pre-v2.1 the predictor never emitted MISS across 47 resolved history
 * rows (vs. 34% actual MISS rate). Root cause: ~80% of NSE tickers
 * landed near score=50 because all four missing-data branches silently
 * returned 0 pts.
 *
 * Gated by data_quality so we don't double-penalise the MEDIUM rows
 * that lack inUpcomingEarnings + V3 by definition:
 *   HIGH:   -2 pts per missing component, capped at -6 total.
 *   MEDIUM: total capped at -3 (single small lean, not a stack).
 *   LOW:    n/a (predictor returns INSUFFICIENT_DATA upstream).
 *
 * Distinguishes LLM=null (signal failed to produce) from LLM=neutral
 * (we read the news and it was genuinely neutral): only null counts
 * as missing. A non-null `classifier_provider` proves we read it.
 *
 * Max: 0 to -6 pts.
 */
function scoreMissingDataPenalty(signals) {
  const missing = [];
  if (!swsV4Signal(signals)?.breakdown) missing.push("v4");
  if (signals.data_quality_flags?.trajectory === "absent") missing.push("trajectory");
  const annTop3 = signals.announcements?.top3;
  if (!Array.isArray(annTop3) || annTop3.length === 0) missing.push("announcements");
  if (!signals.llm_signal || !signals.llm_signal.classifier_provider) missing.push("llm");

  if (missing.length === 0) {
    return { pts: 0, breakdown: { missingDataPenaltyPts: 0, missing: [] }, why: "all qualitative signals present" };
  }

  const dq = signals.data_quality || "MEDIUM";
  const perComponent = -2;
  const cap = dq === "HIGH" ? -6 : -3;

  const raw = missing.length * perComponent;
  const pts = Math.max(raw, cap);

  return {
    pts,
    breakdown: { missingDataPenaltyPts: pts, missing, data_quality: dq, cap },
    why: `missing-data caution: ${missing.join(", ")} unavailable (${pts} pts, ${dq})`,
  };
}

// ────────── Main predictor ──────────

/**
 * Compute prediction for one event-with-signals.
 *
 * @param {{signals: SignalsBlock}} event — event from signalAggregator.
 * @returns {{verdict, confidence_pct, score_100, score_breakdown, components}}
 */
export function predictEarningsOutcome(event) {
  const signals = event?.signals;
  if (!signals) {
    return {
      verdict: "INSUFFICIENT_DATA",
      confidence_pct: null,
      score_100: null,
      score_breakdown: null,
      reasons_top: [],
      reasons_against: [],
      predictor_version: PREDICTOR_VERSION,
    };
  }

  if (signals.data_quality === "LOW") {
    return {
      verdict: "INSUFFICIENT_DATA",
      confidence_pct: null,
      score_100: null,
      score_breakdown: { reason: "data_quality:LOW" },
      reasons_top: [],
      reasons_against: [],
      predictor_version: PREDICTOR_VERSION,
    };
  }

  // ── Run each component scorer ──
  // v2: the old ±32 `scoreSwsQuality` verdict-echo is split into three
  // decomposed V3 components (future+past, valuation, overlay); the old
  // standalone FV-upside component is folded into v3Valuation.
  const v3FuturePast = scoreV3FuturePast(signals);
  const v3Valuation = scoreV3Valuation(signals);
  const v3Overlay = scoreV3Overlay(signals);
  const runup = scoreRunup(signals);
  const sectorMom = scoreSectorMomentum(signals);
  const trajectory = scoreTrajectory(signals);
  const echo = scoreLastQuarterEcho(signals);
  const announcements = scoreAnnouncements(signals);
  const dealFlow = scoreDealFlow(signals);
  const llmSignal = scoreLlmSignal(signals);
  const missingDataPenalty = scoreMissingDataPenalty(signals);

  // ── Sum to a 0–100 scale anchored at 50 = neutral INLINE ──
  // Component max sums to ~108 on the positive side (18+8+10+15+10+15+
  // 5+10+7+10); overlay is penalty-only and missingDataPenalty is also
  // penalty-only (v2.1, 0 to -6). Anchor at 50 so a truly neutral
  // stock (0 from every component) lands in the middle. The hard
  // clamp at [0,100] catches the rare extreme.
  const raw =
    v3FuturePast.pts + v3Valuation.pts + v3Overlay.pts + runup.pts +
    sectorMom.pts + trajectory.pts + echo.pts + announcements.pts +
    dealFlow.pts + llmSignal.pts + missingDataPenalty.pts;
  const score_100 = clamp(Math.round((50 + raw) * 10) / 10, 0, 100);

  // ── Verdict mapping (v3 — empirical thresholds) ──
  const thresholds = activeThresholds();
  let verdict;
  if (score_100 >= thresholds.beatCut) verdict = "BEAT";
  else if (score_100 < thresholds.missCut) verdict = "MISS";
  else verdict = "INLINE";

  // ── Confidence ──
  // Distance from the nearest verdict boundary, scaled and capped.
  // The formula parameterises on the active thresholds so a borderline
  // BEAT at the new (lower) BEAT_CUT still computes a positive
  // distance — pre-v3 the formula was hardcoded to 65/35 and would
  // produce negative confidence numbers for borderline calls at
  // empirical thresholds, all of which then clamped to the 50% floor
  // (creating a flat-50 cluster the user couldn't distinguish from
  // dead-centre INLINE).
  const { missCut, beatCut } = thresholds;
  const inlineCenter = (missCut + beatCut) / 2;
  const inlineHalfWidth = (beatCut - missCut) / 2;
  let conf;
  if (verdict === "BEAT") conf = 50 + (score_100 - beatCut) * 1.0;
  else if (verdict === "MISS") conf = 50 + (missCut - score_100) * 1.0;
  else conf = 50 + (inlineHalfWidth - Math.abs(score_100 - inlineCenter)) * 0.6;
  const confidence_pct = clamp(Math.round(conf), 50, V1_CONFIDENCE_CAP_PCT);

  // ── Pull top reasons in/against the verdict for the rationale narrator ──
  const allComponents = [
    { name: "v3_future_past", ...v3FuturePast },
    { name: "v3_valuation", ...v3Valuation },
    { name: "v3_overlay", ...v3Overlay },
    { name: "runup", ...runup },
    { name: "sector_momentum", ...sectorMom },
    { name: "trajectory", ...trajectory },
    { name: "last_quarter_echo", ...echo },
    { name: "announcements", ...announcements },
    { name: "deal_flow", ...dealFlow },
    { name: "llm_signal", ...llmSignal },
    { name: "missing_data_penalty", ...missingDataPenalty },
  ];
  const sortedByImpact = allComponents.slice().sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts));
  const inFavour = (verdict === "BEAT")
    ? allComponents.filter((c) => c.pts > 0)
    : verdict === "MISS"
      ? allComponents.filter((c) => c.pts < 0)
      : allComponents.filter((c) => Math.abs(c.pts) <= 3);
  const opposing = (verdict === "BEAT")
    ? allComponents.filter((c) => c.pts < 0)
    : verdict === "MISS"
      ? allComponents.filter((c) => c.pts > 0)
      : []; // INLINE has no clear opposing set
  const reasons_top = inFavour
    .slice()
    .sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))
    .slice(0, 3)
    .map((c) => c.why);
  const reasons_against = opposing
    .slice()
    .sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))
    .slice(0, 3)
    .map((c) => c.why);

  return {
    verdict,
    confidence_pct,
    score_100,
    score_breakdown: {
      v3_future_past: v3FuturePast.pts,
      v3_valuation: v3Valuation.pts,
      v3_overlay: v3Overlay.pts,
      runup: runup.pts,
      sector_momentum: sectorMom.pts,
      trajectory: trajectory.pts,
      last_quarter_echo: echo.pts,
      announcements: announcements.pts,
      deal_flow: dealFlow.pts,
      llm_signal: llmSignal.pts,
      missing_data_penalty: missingDataPenalty.pts,
      missing_data_components: missingDataPenalty.breakdown?.missing || [],
      raw_sum: Math.round(raw * 10) / 10,
      // v1→v2 aliases — kept one release so the UI never renders NaN for
      // archived or mid-rollout rows. Removed in PR 6.
      sws_quality: v3FuturePast.pts,
      fv_upside: v3Valuation.pts,
      // v3 — threshold provenance for backtest version-isolation.
      threshold_version: thresholds.version,
      threshold_source: thresholds.source,
      miss_cut: thresholds.missCut,
      beat_cut: thresholds.beatCut,
    },
    reasons_top,
    reasons_against,
    components_by_impact: sortedByImpact.map((c) => ({ name: c.name, pts: c.pts, why: c.why })),
    predictor_version: PREDICTOR_VERSION,
  };
}

/**
 * Apply the predictor to every event in a calendar. Returns a new array
 * — never mutates input. Each event gains a `prediction` field beside
 * its existing `signals`.
 */
export function predictCalendar(events) {
  if (!Array.isArray(events)) return [];
  return events.map((e) => ({ ...e, prediction: predictEarningsOutcome(e) }));
}

/**
 * Roll-up stats for the tab header — counts of each verdict + average
 * confidence.
 */
export function summarisePredictions(events) {
  const tiers = { BEAT: 0, INLINE: 0, MISS: 0, INSUFFICIENT_DATA: 0 };
  let confSum = 0, confCount = 0;
  for (const e of events || []) {
    const v = e.prediction?.verdict;
    if (v && tiers[v] != null) tiers[v] += 1;
    const c = num(e.prediction?.confidence_pct);
    if (c != null) {
      confSum += c;
      confCount += 1;
    }
  }
  return {
    by_verdict: tiers,
    avg_confidence_pct: confCount > 0 ? Math.round(confSum / confCount) : null,
    confidence_cap_pct: V1_CONFIDENCE_CAP_PCT,
    predictor_version: PREDICTOR_VERSION,
  };
}
