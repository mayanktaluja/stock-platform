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

export const PREDICTOR_VERSION = "earnings-predict-v2-2026-05";

/**
 * V1 confidence ceiling. The predictor will never claim more confidence
 * than this until earningsHistoryArchive (M-F) confirms calibration.
 */
export const V1_CONFIDENCE_CAP_PCT = 65;

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
 * Component 1a — V3 future + past pillars.
 *
 * v2 replaces the old ±32 `scoreSwsQuality` (which just echoed the
 * blunt composite verdict — the thing that made 73% of predictions
 * cluster on INLINE) with the *decomposed* SWS V3 100-pt breakdown.
 *
 * `pts_future` (0–20, SWS forward-earnings-growth pillar) and
 * `pts_past` (0–12, earnings-trajectory pillar) are the two V3 pillars
 * most predictive of a next-quarter beat/miss. They are anchored at
 * their neutral midpoint (a 3/6 snowflake pillar) so a weak-future
 * stock scores genuinely NEGATIVE rather than merely zero — the old
 * verdict echo could only ever subtract via an explicit AVOID label.
 *
 * Max: ±18 pts (±12 future + ±6 past, plus a ±2 verdict nudge, clamped).
 */
function scoreV3FuturePast(signals) {
  const b = signals.v3?.breakdown;
  if (!b) return { pts: 0, breakdown: { futurePts: 0, pastPts: 0 }, why: "no V3 signal" };

  const ptsFuture = num(b.pts_future) ?? 10; // neutral = (3/6)*20
  const ptsPast = num(b.pts_past) ?? 6; // neutral = (3/6)*12
  // Anchor at the neutral midpoint, scale to ±12 / ±6.
  const futureContrib = clamp(((ptsFuture - 10) / 10) * 12, -12, 12);
  const pastContrib = clamp(((ptsPast - 6) / 6) * 6, -6, 6);
  const verdictNudge = num(V3_VERDICT_NUDGE[signals.v3?.v3_verdict]) ?? 0;

  const pts = Math.round(clamp(futureContrib + pastContrib + verdictNudge, -18, 18) * 10) / 10;
  return {
    pts,
    breakdown: {
      futurePts: Math.round(futureContrib * 10) / 10,
      pastPts: Math.round(pastContrib * 10) / 10,
      verdictNudge,
    },
    why: `V3 future ${ptsFuture.toFixed(0)}/20 · past ${ptsPast.toFixed(0)}/12` +
      (signals.v3?.v3_verdict ? ` (${signals.v3.v3_verdict})` : ""),
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
  const b = signals.v3?.breakdown;
  if (!b || num(b.pts_fv_upside) == null) {
    // Fallback — no V3 block; score off raw FV upside (rare: the
    // predictor only runs when SWS deep exists, which yields a V3 block).
    return scoreFvUpside(signals);
  }
  const ptsFv = num(b.pts_fv_upside); // 0..12, neutral 6
  const pts = Math.round(clamp(((ptsFv - 6) / 6) * 8, -8, 8) * 10) / 10;
  return {
    pts,
    breakdown: { fvPts: pts, pts_fv_upside: ptsFv, imputed: !!b.fv_imputed },
    why: b.fv_imputed
      ? "V3 valuation: fair-value imputed (no FV anchor)"
      : pts > 0
        ? `V3 valuation: ${ptsFv}/12 fv-upside tier (discount → BEAT setup)`
        : pts < 0
          ? `V3 valuation: ${ptsFv}/12 fv-upside tier (rich → fade risk)`
          : "V3 valuation: fairly valued",
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
  const b = signals.v3?.breakdown;
  if (!b || num(b.pts_overlay) == null) {
    return { pts: 0, breakdown: { overlayPts: 0 }, why: "no V3 risk flags" };
  }
  const pts = clamp(num(b.pts_overlay), -10, 0);
  const reasons = Array.isArray(b.overlay_reasons) ? b.overlay_reasons : [];
  return {
    pts,
    breakdown: { overlayPts: pts, overlay_reasons: reasons },
    why: pts < 0
      ? `V3 risk overlay: ${reasons.join("; ") || "flagged"}`
      : "no V3 risk flags",
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
 * Max: ±10 pts.
 */
function scoreSectorMomentum(signals) {
  const sectorAvg = num(signals.momentum?.sector_avg_1m_pct);
  if (sectorAvg == null) return { pts: 0, breakdown: { sectorPts: 0 }, why: "no sector flow" };

  // Linear scale: +10% sector return = +5 pts; ±20% = ±10 pts.
  let pts = clamp(sectorAvg / 2, -10, 10);
  pts = Math.round(pts * 10) / 10;
  return {
    pts,
    breakdown: { sectorPts: pts },
    why: `sector ${signals.sector || "?"} ${sectorAvg >= 0 ? "+" : ""}${sectorAvg.toFixed(1)}% over 1M`,
  };
}

/**
 * Component 4 — Trajectory. EPS YoY growth from the last reported
 * quarter pair. Often null (fundamentalsHistory only covers 494
 * symbols) — the function returns 0 pts in that case rather than
 * imputing.
 *
 * Max: ±15 pts. Symmetric.
 */
function scoreTrajectory(signals) {
  const epsYoY = num(signals.trajectory?.eps_yoy_pct);
  if (epsYoY == null) {
    return { pts: 0, breakdown: { trajectoryPts: 0 }, why: "no trajectory data" };
  }
  // 25%+ YoY EPS growth → +10 pts; 50%+ → +15 cap; -25% → -10; -50% → -15.
  let pts = clamp(epsYoY / 2.5, -15, 15);
  pts = Math.round(pts * 10) / 10;
  return {
    pts,
    breakdown: { trajectoryPts: pts },
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

  // ── Sum to a 0–100 scale anchored at 50 = neutral INLINE ──
  // Component max sums to ~98 (18+8+10+15+10+15+5+10+7 on the positive
  // side; overlay is penalty-only). Anchor at 50 so a truly neutral
  // stock (0 from every component) lands in the middle. The hard clamp
  // at [0,100] catches the rare extreme.
  const raw =
    v3FuturePast.pts + v3Valuation.pts + v3Overlay.pts + runup.pts +
    sectorMom.pts + trajectory.pts + echo.pts + announcements.pts + dealFlow.pts;
  const score_100 = clamp(Math.round((50 + raw) * 10) / 10, 0, 100);

  // ── Verdict mapping ──
  let verdict;
  if (score_100 >= 65) verdict = "BEAT";
  else if (score_100 < 35) verdict = "MISS";
  else verdict = "INLINE";

  // ── Confidence ──
  // Distance from the nearest verdict boundary, scaled and capped.
  // Score 65 → 50% confidence (just over the line)
  // Score 80 → 65% confidence (V1 cap reached)
  // Score 35 → 50% confidence (just under the line)
  // Score 20 → 65% confidence
  // Score 50 (dead-centre INLINE) → 50% confidence (we know it's a
  // coin-flip, that's a confident INLINE call).
  let conf;
  if (verdict === "BEAT") conf = 50 + (score_100 - 65) * 1.0;
  else if (verdict === "MISS") conf = 50 + (35 - score_100) * 1.0;
  else conf = 50 + (15 - Math.abs(score_100 - 50)) * 0.6;
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
      raw_sum: Math.round(raw * 10) / 10,
      // v1→v2 aliases — kept one release so the UI never renders NaN for
      // archived or mid-rollout rows. Removed in PR 6.
      sws_quality: v3FuturePast.pts,
      fv_upside: v3Valuation.pts,
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
