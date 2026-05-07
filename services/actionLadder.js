// Action ladder utilities for the SWS recommendation engine.
//
// Two coexisting label sets:
//   • LEGACY (always-on): EXIT · Reduction-50% · Reduction-25-33% · HOLD ·
//     Top-up-modest · Top-up · STRONG Top-up.
//   • LADDER_V2 (gated by SWS_LADDER_V2=1): EXIT-now · EXIT-staged ·
//     Reduction-66% · Reduction-50% · Reduction-33% · Reduction-25% · HOLD ·
//     Top-up-25% · Top-up-33% · Top-up-50% · Top-up-100%.
//
// Why both: downstream consumers (swsPortfolioAggregate, swsConvictionEngine,
// app.js color map, swsCoverageFallback) all read the action string literally.
// LADDER_V2 is additive — any v2 label round-trips to a legacy equivalent via
// `ladderToLegacy()` so existing readers keep working when v2 is on.
//
// All thresholds are calibrated against the v3 universe distribution
// (p25≈21, p50≈29, p75≈39, p95≈59). The factor stack — v3 score, position
// weight, sector weight, conviction proxy, NSE ASM/GSM surveillance, risks
// count — is the same set the v2 conviction engine reads.
//
// Pure functions: no I/O, no side effects, deterministic given inputs.

export const LEGACY_REDUCTION_ACTIONS = new Set([
  "EXIT",
  "Reduction-50%",
  "Reduction-25-33%",
]);

export const LEGACY_TOPUP_ACTIONS = new Set([
  "Top-up-modest",
  "Top-up",
  "STRONG Top-up",
]);

export const LADDER_V2_REDUCTION_ACTIONS = new Set([
  "EXIT-now",
  "EXIT-staged",
  "Reduction-66%",
  "Reduction-50%",
  "Reduction-33%",
  "Reduction-25%",
]);

export const LADDER_V2_TOPUP_ACTIONS = new Set([
  "Top-up-25%",
  "Top-up-33%",
  "Top-up-50%",
  "Top-up-100%",
]);

export const ALL_REDUCTION_ACTIONS = new Set([
  ...LEGACY_REDUCTION_ACTIONS,
  ...LADDER_V2_REDUCTION_ACTIONS,
]);

export const ALL_TOPUP_ACTIONS = new Set([
  ...LEGACY_TOPUP_ACTIONS,
  ...LADDER_V2_TOPUP_ACTIONS,
]);

// Trim fraction by action label. Drives _computeFreedCash in
// swsPortfolioAggregate so any new rung automatically influences fresh-capital
// math without a separate switch statement per rung.
//
// EXIT-staged is modeled as 0.5 because the user sells half today; the
// remaining 0.5 is a follow-on contingent on a confirmation break (T+5).
// Aggregate-level cash math freezes on what's actually realised today.
const TRIM_PCT_BY_ACTION = {
  "EXIT": 1.0,
  "EXIT-now": 1.0,
  "EXIT-staged": 0.5,
  "Reduction-66%": 0.66,
  "Reduction-50%": 0.50,
  "Reduction-33%": 0.33,
  "Reduction-25%": 0.25,
  "Reduction-25-33%": 0.30,
};

const TOPUP_PCT_OF_IDEAL_BY_ACTION = {
  "STRONG Top-up": 1.0,
  "Top-up-100%": 1.0,
  "Top-up": 0.5,
  "Top-up-50%": 0.5,
  "Top-up-33%": 0.33,
  "Top-up-modest": 0.25,
  "Top-up-25%": 0.25,
};

const LADDER_TO_LEGACY = {
  "EXIT-now": "EXIT",
  "EXIT-staged": "EXIT",
  "Reduction-66%": "Reduction-50%",
  "Reduction-50%": "Reduction-50%",
  "Reduction-33%": "Reduction-25-33%",
  "Reduction-25%": "Reduction-25-33%",
  "HOLD": "HOLD",
  "Top-up-25%": "Top-up-modest",
  "Top-up-33%": "Top-up-modest",
  "Top-up-50%": "Top-up",
  "Top-up-100%": "STRONG Top-up",
};

export function isLadderV2Enabled() {
  return process.env.SWS_LADDER_V2 !== "0";
}

/**
 * SWS_LADDER_V3 — continuous-severity rung picker.
 *
 * V2 was a categorical matrix that defaulted to Reduction-33% whenever no
 * specific factor combination matched. For typical retail books (most
 * positions at 2–4% weight) this produced a structural pile-up at 33% —
 * "every stock is trimmed by 33%" reads as engine bias, not as a per-stock
 * recommendation. V3 replaces the matrix with a continuous severity score
 * (0..1) computed from the same factor stack, then rounds to the nearest
 * available rung. Every input combination maps to a specific rung; no
 * default fallback. Flag is independent of V2 — V3 takes precedence when
 * both are on.
 */
export function isLadderV3Enabled() {
  return process.env.SWS_LADDER_V3 !== "0";
}

/**
 * SWS_LADDER_V4 — XIRR-optimised severity model (Phase 1).
 *
 * V3 already moved from a categorical matrix to a continuous severity score
 * — the right shape, but with several factor-poor inputs. V4 keeps the same
 * 0..1 severity surface and the same rung-mapping table, but replaces four
 * inputs with XIRR-optimised versions, and wraps the rung selection with
 * three new gates that the academic / behavioural-finance literature flags
 * as the highest-leverage retail-portfolio fixes:
 *
 *   1. **Pillar-decomposed weakness** (replaces `(50 − v3)/50`). Single
 *      scalar v3 collapses Health / Future / Valuation / Past / Dividends
 *      into one number, so a deep-value compounder (Val=1, Health=6) and a
 *      structurally weak name (Val=4, Health=2) at the same v3 score get
 *      identical trims. V4 takes the WORST pillar (weighted) — Health-rot
 *      drives a faster trim than Dividends-cut.
 *
 *   2. **Recoverable drawdown** (replaces `−pnl/50`). Selling capitulation
 *      — trimming a -40% holding that's already bounced 15% off its 52-week
 *      low — is the single largest XIRR-killer in retail portfolios
 *      (Odean 1998; Anagol et al. 2017 for Indian equities). V4 dampens the
 *      drawdown contribution proportionally to position-in-52W-range. The
 *      ideal version uses since-purchase peak/trough; Phase 1 uses the 52W
 *      proxy (already on the holding via the yfinance enrich pass).
 *
 *   3. **Position-floor execution gate**. Below 2.5% of book, partial trims
 *      bleed 0.4-0.8% in round-trip cost on freed cash that's too small to
 *      redeploy. V4 collapses small-position actions to {HOLD, EXIT-now}.
 *
 *   4. **Settle-period gate**. A 28-day-old position should not fire
 *      TRIM-33% on a v3 fade — the thesis hasn't had time to falsify
 *      outside material-news events. V4 caps trim severity at 0.30 inside
 *      the 60-day settle window (surveillance and disclosure events bypass).
 *
 *   5. **Action-history awareness (cycle memory)**. If the prior cycle
 *      emitted Reduction-50% / Reduction-66% / EXIT-staged within the last
 *      45 days and severity is still ≥ 0.45, the *residual* position
 *      should EXIT — layering trim-on-trim hides what is effectively a
 *      75-99% exit behind two "moderate" rungs.
 *
 * V4 is OPT-IN. SWS_LADDER_V4 must be explicitly set to "1" to activate;
 * the default (unset OR "0") preserves V3 behaviour exactly. This lets the
 * backtest harness compare V3-vs-V4 outputs side by side before flipping
 * the default. All V4-only inputs (pillars, days_held, 52W high/low,
 * last_action) are *optional* on the promoteToLadderV2 signature — when
 * V4 is off they are silently ignored, when V4 is on but inputs are
 * missing the engine degrades gracefully (V4 falls through to V3).
 */
export function isLadderV4Enabled() {
  return process.env.SWS_LADDER_V4 === "1";
}

// ════════════════════════════════════════════════════════════════════════
// V3 CONTINUOUS SEVERITY MODEL
// ════════════════════════════════════════════════════════════════════════
//
// computeTrimSeverity returns a number in [0, 1] derived deterministically
// from the holding's factor stack. The components below are calibrated so
// a typical retail book of 30–50 holdings produces a real spread across
// every rung (25 / 33 / 50 / 66 / EXIT-staged / EXIT-now), not a 33%
// pile-up.
//
// Component weights sum to 1.0:
//
//   Weakness          0.30  | (50 − v3) / 50, clamped 0..1.   v3=15 → 0.70
//   Concentration     0.20  | position_weight / 20.            pw=4% → 0.20
//   Sector overweight 0.10  | sector_weight / 35.              sw=18% → 0.51
//   Conviction       0.15  | LOW=1.0..HIGH=0.0                LOW → 1.00
//   Drawdown depth   0.10  | -pnl / 50, clamped 0..1.          pnl=-32 → 0.64
//   Surveillance     0.10  | GSM=0.30+0.05·stage, ASM=0.10+0.05·stage
//   Risk flags       0.05  | risks_count / 5.                  rc=2 → 0.40
//
// Calibration anchors:
//   • Healthy stock (v3=80, pw=2%, sw=10%, MEDIUM-HIGH, pnl=+10, no surv, 0 risks)
//     → severity ≈ 0.05 → null (no trim) — pass to top-up logic.
//   • Mild WATCH (v3=20, pw=4%, sw=15%, MEDIUM, pnl=-10, no surv, 0 risks)
//     → severity ≈ 0.32 → Reduction-33%.
//   • Concentrated weak name (v3=18, pw=18%, sw=15%, LOW, pnl=-25, no surv, 1 risk)
//     → severity ≈ 0.65 → Reduction-66%.
//   • Broken thesis (v3=10, pw=4%, sw=12%, LOW, pnl=-45, no surv, 2 risks)
//     → severity ≈ 0.79 → EXIT-staged.
//   • GSM-3 surveillance overrides everything → EXIT-now (hard override below).
//
// All thresholds are pure functions of inputs — same inputs ⇒ same severity ⇒
// same rung. SEBI-defensible audit trail: every component contribution is
// emitted as a rationale string.

// AGGRESSIVE-TRIM RECALIBRATION: weights rebalanced so the engine reads
// "weak fundamentals + losing money" louder. Conviction shrinks because it
// re-uses v3 (already counted in `weakness`), and `risks` zeroes out for
// the same reason — risks_count is already inside the v3 score's risk
// overlay, so adding it again was a partial double-count. Drawdown ticks
// up because the user's primary signal that something is wrong is the
// position bleeding. Sum stays at 1.00.
const TRIM_SEVERITY_WEIGHTS = {
  weakness: 0.35,         // was 0.30
  concentration: 0.20,
  sectorOverweight: 0.10,
  conviction: 0.10,       // was 0.15 — drop double-counting with v3
  drawdown: 0.15,         // was 0.10 — losing money is a louder signal
  surveillance: 0.10,
  risks: 0.00,            // was 0.05 — already inside v3's risk overlay
};

const TOPUP_SEVERITY_WEIGHTS = {
  strength: 0.35,
  positionRoom: 0.20,
  sectorRoom: 0.15,
  upside: 0.20,
  cleanRisk: 0.10,
};

const CONVICTION_PENALTY = {
  LOW: 1.00,
  "MEDIUM-LOW": 0.75,
  MEDIUM: 0.50,
  "MEDIUM-HIGH": 0.25,
  HIGH: 0.00,
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Compute the trim severity score (0..1) for a holding. Returns:
 *   { severity, components, rationale }
 * where components is the per-factor breakdown (already weight-multiplied
 * and ready to display) and rationale is an array of strings describing
 * each contribution in plain English.
 */
export function computeTrimSeverity({
  v3,
  position_weight,
  sector_weight,
  conviction,
  surveillance,
  pnlPercent,
  risks_count,
}) {
  const v3n = Number.isFinite(v3) ? v3 : 50;
  const pw = Number.isFinite(position_weight) ? position_weight : 0;
  const sw = Number.isFinite(sector_weight) ? sector_weight : 0;
  const pnl = Number.isFinite(pnlPercent) ? pnlPercent : 0;
  const rc = Number.isFinite(risks_count) ? risks_count : 0;
  const survList = surveillance?.list || null;
  const survStage = Number(surveillance?.stage) || 0;

  const weaknessRaw = clamp01((50 - v3n) / 50);
  const concentrationRaw = clamp01(pw / 20);
  const sectorOverweightRaw = clamp01(sw / 35);
  const convictionRaw = CONVICTION_PENALTY[conviction] ?? 0.5;
  const drawdownRaw = clamp01(-pnl / 50);
  let surveillanceRaw = 0;
  if (survList === "GSM") surveillanceRaw = clamp01(0.30 + 0.05 * (survStage || 1));
  else if (survList === "ASM") surveillanceRaw = clamp01(0.10 + 0.05 * (survStage || 1));
  const risksRaw = clamp01(rc / 5);

  const components = {
    weakness:          weaknessRaw          * TRIM_SEVERITY_WEIGHTS.weakness,
    concentration:     concentrationRaw     * TRIM_SEVERITY_WEIGHTS.concentration,
    sectorOverweight:  sectorOverweightRaw  * TRIM_SEVERITY_WEIGHTS.sectorOverweight,
    conviction:        convictionRaw        * TRIM_SEVERITY_WEIGHTS.conviction,
    drawdown:          drawdownRaw          * TRIM_SEVERITY_WEIGHTS.drawdown,
    surveillance:      surveillanceRaw      * TRIM_SEVERITY_WEIGHTS.surveillance,
    risks:             risksRaw             * TRIM_SEVERITY_WEIGHTS.risks,
  };
  let severity = clamp01(
    components.weakness + components.concentration + components.sectorOverweight +
    components.conviction + components.drawdown + components.surveillance + components.risks
  );
  // Hard floors aligned with SWS v3 universe distribution: v3<8 is bottom-
  // tier (engine emits EXIT regardless of factors); v3<14 is the "WATCH" band
  // floor below which the model promises a staged-exit minimum. These match
  // the V2 categorical guarantees so the upgrade preserves SEBI-aligned
  // safety floors while gaining per-stock specificity above the floor.
  if (v3n < 8) severity = Math.max(severity, 0.90);
  else if (v3n < 14) severity = Math.max(severity, 0.75);

  // SEBI-aligned concentration escalators — single-stock weight above
  // these thresholds is a hard regulatory observation independent of the
  // thesis. A position at 30% of book is a risk-management problem even
  // for a high-conviction TOP_PICK. Escalators ensure the rung never
  // under-states the concentration risk, while staying below EXIT (a
  // concentrated WINNER trims for portfolio safety, doesn't exit).
  //
  // AGGRESSIVE-TRIM RECALIBRATION: escalators step in earlier and harder
  // so chunky positions get at least a Red-25% nudge regardless of v3.
  // The pw>10 tier is new — even a 10%+ position is a notable concentration
  // for a typical retail book.
  if (pw > 30) severity = Math.max(severity, 0.55);     // Red-66% min (was 0.60)
  else if (pw > 25) severity = Math.max(severity, 0.45); // Red-50% min (was 0.55)
  else if (pw > 20) severity = Math.max(severity, 0.40); // Red-50% min (was 0.45)
  else if (pw > 15) severity = Math.max(severity, 0.25); // Red-33% min (was 0.30)
  else if (pw > 10) severity = Math.max(severity, 0.18); // Red-25% min (NEW tier)

  const pp = (n) => `${(n * 100).toFixed(0)}pp`;
  const rationale = [
    `v3 ${v3n.toFixed(0)}/100 → +${pp(components.weakness)} weakness signal`,
    `Position ${pw.toFixed(1)}% of book → +${pp(components.concentration)} concentration`,
    `Sector ${sw.toFixed(1)}% of book → +${pp(components.sectorOverweight)} sector overweight`,
    `Conviction ${conviction || "MEDIUM"} → +${pp(components.conviction)}`,
    `Drawdown ${pnl.toFixed(1)}% → +${pp(components.drawdown)}`,
    survList ? `${survList}${survStage ? "-" + survStage : ""} surveillance → +${pp(components.surveillance)}` : "No NSE surveillance → +0pp",
    `${rc} risk flag${rc === 1 ? "" : "s"} → +${pp(components.risks)}`,
    `Total severity ${pp(severity)} → maps to ${severityToTrimRung(severity, { gsmStage3Plus: survList === "GSM" && survStage >= 3 }) || "no trim (HOLD or top-up)"}`,
  ];

  return { severity, components, rationale };
}

/**
 * Map a severity score to a specific trim rung. GSM stage 3+ is a hard
 * regulatory override → EXIT-now regardless of score (matches V2 behaviour).
 * Bottom-tier v3 (handled at caller level) also maps to EXIT-now.
 */
// AGGRESSIVE-TRIM RECALIBRATION: lowered every band so the same severity
// score lands one rung harder. Calibration anchor — a typical 4% position
// at v3=18, MEDIUM-LOW conviction, -15% pnl scores ≈0.40 on the new weight
// table; that now maps to Reduction-50% (was Red-33%), which is what a
// SEBI-aligned analyst would call on weak fundamentals + losing position.
export function severityToTrimRung(severity, { gsmStage3Plus = false } = {}) {
  if (gsmStage3Plus) return "EXIT-now";
  if (!Number.isFinite(severity) || severity < 0.10) return null;
  if (severity >= 0.85) return "EXIT-now";
  if (severity >= 0.65) return "EXIT-staged";
  if (severity >= 0.50) return "Reduction-66%";
  if (severity >= 0.35) return "Reduction-50%";
  if (severity >= 0.22) return "Reduction-33%";
  return "Reduction-25%";
}

// ════════════════════════════════════════════════════════════════════════
// V4 SEVERITY MODEL — XIRR-OPTIMISED OVERLAY (Phase 1)
// ════════════════════════════════════════════════════════════════════════
//
// V4 keeps the V3 [0,1] severity surface and rung-mapping table identical,
// but replaces the *contents* of two factor inputs and adds three rung-time
// gates. The goal is XIRR-optimisation, not a re-architecture.
//
// What changes vs V3:
//
//   weakness   : (50−v3)/50           →  pillar-decomposed (worst pillar drives)
//   drawdown   : −pnl/50                →  recoverable-drawdown (52W proxy)
//   <new>       :                                   position-floor gate (post-rung)
//   <new>       :                                   settle-period gate (cap severity)
//   <new>       :                                   action-history promotion (residual EXIT)
//
// Concentration / sector-overweight / conviction / surveillance / risks
// stay identical to V3 — they were already good. The weight matrix also
// stays the same; what changes is the *content* of two raw inputs.
//
// Calibration anchors (validate against these in tests):
//
//   • Deep-value compounder (v3=38, Health=6, Future=5, Past=4, Val=1, Div=2,
//     pw=4%, sw=15%, MEDIUM, pnl=-12%, no surv, 0 risks, 52W: low=80, cur=100, hi=140)
//     → V3 severity ≈ 0.27 → Reduction-25%
//     → V4 severity ≈ 0.13 → null (HOLD) — pillar weakness is tiny because
//       Health/Future are strong; the v3=38 is "out-of-favour" not "broken".
//
//   • Structurally weak (v3=38, Health=2, Future=2, Past=4, Val=4, Div=1,
//     same context as above)
//     → V3 severity ≈ 0.27 → Reduction-25% (same!)
//     → V4 severity ≈ 0.34 → Reduction-33% — Health<3 + Future<3 escalate.
//
//   • Capitulation rebound (v3=20, pnl=-40%, but 52W: low=60, cur=85, hi=140)
//     → V3 severity ≈ 0.62 → Reduction-66%
//     → V4 severity ≈ 0.45 → Reduction-50% — recovery-off-low dampens the
//       drawdown component; we don't sell into the bounce.
//
//   • Settle-period block (any severity ≥ 0.30, days_held=28, no surveillance)
//     → V3: emits its rung
//     → V4: severity capped at 0.30 → Reduction-25% maximum, often HOLD.
//
//   • Cycle-memory residual (last_action="Reduction-50%" 30d ago, severity=0.50)
//     → V3: emits another Reduction-50% (75% gone in two cycles, hidden)
//     → V4: promotes to EXIT-now (finishes the staged exit explicitly).
//
// All inputs are optional (V3 falls through gracefully). When V4 inputs are
// partial we use whatever's available — pillar-weakness gracefully degrades
// to the V3 v3-scalar formula when pillars are missing.

const PILLAR_WEAKNESS_WEIGHTS = {
  health:    0.40,  // balance-sheet rot is the worst signal
  future:    0.30,  // thesis fade
  valuation: 0.20,  // only escalates when expensive (val > 4)
  residual:  0.10,  // aggregate v3 fade as backstop
};

/**
 * Pillar-decomposed weakness (V4, change 3.2 of the redesign plan).
 *
 * The V3 weakness component `(50−v3)/50` collapses every pillar — Health,
 * Future, Past, Valuation, Dividends — into one scalar. Two stocks at the
 * same v3 score can have opposite reasons for being there:
 *
 *   • Deep-value compounder: Val=1 (cheap) but Health=6, Future=6 → buy.
 *   • Structurally weak: Val=4 (priced fine), Health=2, Future=2 → trim.
 *
 * V3 treats both identically. V4 takes the WORST pillar (weighted) — Health
 * weakness drives a faster trim than Dividends weakness, Valuation weakness
 * only contributes when *expensive* (val > 4), not when cheap.
 *
 * Returns a number in [0, 1]. When pillars are missing, falls back to the
 * V3 formula so callers don't need to branch.
 */
export function pillarWeaknessRaw({ v3, pillars }) {
  const v3n = Number.isFinite(v3) ? v3 : 50;
  if (!pillars || typeof pillars !== "object") {
    // Graceful fallback — when pillars are missing, behave like V3.
    return clamp01((50 - v3n) / 50);
  }
  const health  = Number.isFinite(pillars.financial_health) ? pillars.financial_health : 3;
  const future  = Number.isFinite(pillars.future_growth)    ? pillars.future_growth    : 3;
  const valuat  = Number.isFinite(pillars.valuation)        ? pillars.valuation        : 3;
  // Each pillar's "weakness" is a 0..1 number that reaches 1 at the "rotten"
  // end of the scale. Health < 3 is structural rot; future < 3 is thesis
  // fade; valuation > 4 is expensive (only direction we'd trim valuation for).
  const healthW = clamp01((3 - health) / 3);   // 0 at health≥3, 1 at health=0
  const futureW = clamp01((3 - future) / 3);   // 0 at future≥3, 1 at future=0
  const valW    = clamp01(Math.max(0, valuat - 4) / 2);  // 0 at val≤4, 1 at val=6
  const v3W     = clamp01(Math.max(0, (40 - v3n) / 40)); // residual v3 fade
  // V4 takes the WEIGHTED MAX of pillar contributions — the worst pillar
  // drives the trim signal. (Sum-of-pillars would dampen the signal when
  // one pillar is fine and another is broken.)
  return Math.max(
    PILLAR_WEAKNESS_WEIGHTS.health    * healthW,
    PILLAR_WEAKNESS_WEIGHTS.future    * futureW,
    PILLAR_WEAKNESS_WEIGHTS.valuation * valW,
    PILLAR_WEAKNESS_WEIGHTS.residual  * v3W,
  );
}

/**
 * Recoverable drawdown (V4, change 3.4 of the redesign plan).
 *
 * The V3 drawdown formula `−pnl/50` is symmetric — every -40% holding
 * contributes the same 0.80 raw signal. But trim-on-capitulation is the
 * single largest XIRR-killer in retail portfolios. A holding -40% from
 * cost but already +20% off its 52-week low is showing reversal; trimming
 * locks the loss. A holding -40% from cost AND making fresh 52-week lows
 * is breaking down; trimming is correct.
 *
 * The ideal formula uses since-purchase peak/trough from a daily price
 * history. Today's deep JSONs ship `prices.daily = []`, so V4 Phase 1
 * uses the 52-week high/low *as a proxy* for since-purchase peak/trough.
 * The proxy is anchored to a calendar window not the holding window —
 * conservative for short-held positions (over-states drawdown), accurate
 * for >12-month holds. Acceptable for Phase 1; the full version waits on
 * Phase 2 when a price feed lands.
 *
 * Inputs (all optional):
 *   pnlPercent          — used as fallback when 52W data is missing
 *   currentPrice        — ₹, the close used for 52W-relative position
 *   fiftyTwoWeekHigh    — ₹
 *   fiftyTwoWeekLow     — ₹
 *
 * Returns a number in [0, 1]. When 52W data is missing or invalid, falls
 * back to the V3 `−pnl/50` formula.
 */
export function recoverableDrawdownRaw({ pnlPercent, currentPrice, fiftyTwoWeekHigh, fiftyTwoWeekLow }) {
  const pnl = Number.isFinite(pnlPercent) ? pnlPercent : 0;
  const cp  = Number.isFinite(currentPrice)     && currentPrice     > 0 ? currentPrice     : null;
  const hi  = Number.isFinite(fiftyTwoWeekHigh) && fiftyTwoWeekHigh > 0 ? fiftyTwoWeekHigh : null;
  const lo  = Number.isFinite(fiftyTwoWeekLow)  && fiftyTwoWeekLow  > 0 ? fiftyTwoWeekLow  : null;
  // Fallback: V3 formula when 52W data is unavailable.
  if (cp == null || hi == null || lo == null || hi <= lo) {
    return clamp01(-pnl / 50);
  }
  // Drawdown from 52W high (proxy for peak)
  const drawdownFromPeak = clamp01((hi - cp) / hi);
  // Recovery off 52W low (proxy for trough). Bounded recovery: a stock at
  // exactly the low has 0 recovery; doubling off the low has recovery=1.
  const recoveryOffLow   = clamp01((cp - lo) / Math.max(lo, 1e-6));
  // The dampening factor: no recovery → full drawdown contribution; large
  // recovery (> 33% off lows) → drawdown contribution falls to ~0. The 1.5
  // multiplier means a ~67% recovery zeroes the drawdown signal entirely.
  const dampening = Math.max(0, 1 - 1.5 * recoveryOffLow);
  // Combined: drawdown from peak, dampened by recovery off low. Anchored
  // to the V3 formula at the corner case `cp == lo` (no recovery, full
  // drawdown from peak ≈ −pnl/50 for typical magnitudes).
  return clamp01(drawdownFromPeak * dampening);
}

/**
 * V4 trim severity. Identical surface to computeTrimSeverity (V3) — same
 * weight matrix, same components dict, same rationale array — but with
 * pillar-decomposed weakness and recoverable drawdown swapped in.
 *
 * Additional inputs (vs V3): pillars, currentPrice, fiftyTwoWeekHigh,
 * fiftyTwoWeekLow. All are optional; when missing, V4 components fall
 * back to the V3 formulas individually so partial-data holdings still
 * score correctly.
 */
export function computeTrimSeverityV4({
  v3,
  pillars,
  position_weight,
  sector_weight,
  conviction,
  surveillance,
  pnlPercent,
  currentPrice,
  fiftyTwoWeekHigh,
  fiftyTwoWeekLow,
  risks_count,
}) {
  const v3n = Number.isFinite(v3) ? v3 : 50;
  const pw = Number.isFinite(position_weight) ? position_weight : 0;
  const sw = Number.isFinite(sector_weight) ? sector_weight : 0;
  const rc = Number.isFinite(risks_count) ? risks_count : 0;
  const survList = surveillance?.list || null;
  const survStage = Number(surveillance?.stage) || 0;

  const weaknessRaw         = pillarWeaknessRaw({ v3, pillars });
  const concentrationRaw    = clamp01(pw / 20);
  const sectorOverweightRaw = clamp01(sw / 35);
  const convictionRaw       = CONVICTION_PENALTY[conviction] ?? 0.5;
  const drawdownRaw         = recoverableDrawdownRaw({ pnlPercent, currentPrice, fiftyTwoWeekHigh, fiftyTwoWeekLow });
  let surveillanceRaw = 0;
  if (survList === "GSM") surveillanceRaw = clamp01(0.30 + 0.05 * (survStage || 1));
  else if (survList === "ASM") surveillanceRaw = clamp01(0.10 + 0.05 * (survStage || 1));
  const risksRaw = clamp01(rc / 5);

  const components = {
    weakness:          weaknessRaw          * TRIM_SEVERITY_WEIGHTS.weakness,
    concentration:     concentrationRaw     * TRIM_SEVERITY_WEIGHTS.concentration,
    sectorOverweight:  sectorOverweightRaw  * TRIM_SEVERITY_WEIGHTS.sectorOverweight,
    conviction:        convictionRaw        * TRIM_SEVERITY_WEIGHTS.conviction,
    drawdown:          drawdownRaw          * TRIM_SEVERITY_WEIGHTS.drawdown,
    surveillance:      surveillanceRaw      * TRIM_SEVERITY_WEIGHTS.surveillance,
    risks:             risksRaw             * TRIM_SEVERITY_WEIGHTS.risks,
  };
  let severity = clamp01(
    components.weakness + components.concentration + components.sectorOverweight +
    components.conviction + components.drawdown + components.surveillance + components.risks
  );
  // Hard floors (same as V3) — preserve SEBI-aligned safety guarantees.
  if (v3n < 8) severity = Math.max(severity, 0.90);
  else if (v3n < 14) severity = Math.max(severity, 0.75);
  // Concentration escalators — V4 inherits the V3 aggressive-trim values
  // so a single calibration table drives both engines.
  if (pw > 30) severity = Math.max(severity, 0.55);
  else if (pw > 25) severity = Math.max(severity, 0.45);
  else if (pw > 20) severity = Math.max(severity, 0.40);
  else if (pw > 15) severity = Math.max(severity, 0.25);
  else if (pw > 10) severity = Math.max(severity, 0.18);

  const pp = (n) => `${(n * 100).toFixed(0)}pp`;
  const pillarLabel = pillars
    ? `pillars H=${pillars.financial_health}/F=${pillars.future_growth}/V=${pillars.valuation}`
    : `v3=${v3n.toFixed(0)} (no pillars)`;
  const dd52WLabel = (Number.isFinite(currentPrice) && Number.isFinite(fiftyTwoWeekHigh) && Number.isFinite(fiftyTwoWeekLow))
    ? `52W ₹${fiftyTwoWeekLow.toFixed(0)}-₹${fiftyTwoWeekHigh.toFixed(0)} cur ₹${currentPrice.toFixed(0)}`
    : `pnl ${pnlPercent?.toFixed?.(1) ?? "0"}% (no 52W)`;
  const rationale = [
    `Weakness ${pillarLabel} → +${pp(components.weakness)} (V4 pillar-decomposed)`,
    `Position ${pw.toFixed(1)}% → +${pp(components.concentration)} concentration`,
    `Sector ${sw.toFixed(1)}% → +${pp(components.sectorOverweight)} sector overweight`,
    `Conviction ${conviction || "MEDIUM"} → +${pp(components.conviction)}`,
    `Recoverable drawdown ${dd52WLabel} → +${pp(components.drawdown)} (V4)`,
    survList ? `${survList}${survStage ? "-" + survStage : ""} → +${pp(components.surveillance)}` : "No NSE surveillance → +0pp",
    `${rc} risk flag${rc === 1 ? "" : "s"} → +${pp(components.risks)}`,
    `V4 severity ${pp(severity)} → ${severityToTrimRung(severity, { gsmStage3Plus: survList === "GSM" && survStage >= 3 }) || "no trim (HOLD or top-up)"}`,
  ];

  return { severity, components, rationale };
}

/**
 * Compute the top-up severity score for a holding. Symmetric to the trim
 * model — produces a continuous value in [0, 1] that maps to a specific
 * top-up rung. Healthy + room + upside + clean risks → larger rung.
 */
export function computeTopUpSeverity({
  v3,
  position_weight,
  sector_weight,
  upside,
  risks_count,
}) {
  const v3n = Number.isFinite(v3) ? v3 : 50;
  const pw = Number.isFinite(position_weight) ? position_weight : 0;
  const sw = Number.isFinite(sector_weight) ? sector_weight : 0;
  const up = Number.isFinite(upside) ? upside : 0;
  const rc = Number.isFinite(risks_count) ? risks_count : 0;

  // v3 strength: 50 baseline, every point above adds proportionally; below
  // 50 = 0 (handled by caller's trim path). Tighter scaling than (v3-50)/50
  // so a TOP_PICK at v3=75 → 0.83 strength × 0.35 weight = 0.29 contribution,
  // making it possible to clear the 0.70 threshold for Top-up-100% when the
  // rest of the factor stack is clean.
  const strengthRaw = clamp01((v3n - 50) / 30);
  // Available position room: pw=0 → full room (1.0), pw=8% → no room (0).
  const positionRoomRaw = clamp01((8 - pw) / 8);
  const sectorRoomRaw = clamp01((25 - sw) / 25);
  // Upside: 5% → 0.0, 30% → 1.0, linear in between.
  const upsideRaw = clamp01((up - 5) / 25);
  // Clean-risk: 0 risks → 1.0, 5+ risks → 0.0.
  const cleanRiskRaw = clamp01((5 - rc) / 5);

  const components = {
    strength:     strengthRaw     * TOPUP_SEVERITY_WEIGHTS.strength,
    positionRoom: positionRoomRaw * TOPUP_SEVERITY_WEIGHTS.positionRoom,
    sectorRoom:   sectorRoomRaw   * TOPUP_SEVERITY_WEIGHTS.sectorRoom,
    upside:       upsideRaw       * TOPUP_SEVERITY_WEIGHTS.upside,
    cleanRisk:    cleanRiskRaw    * TOPUP_SEVERITY_WEIGHTS.cleanRisk,
  };
  const severity = clamp01(
    components.strength + components.positionRoom + components.sectorRoom +
    components.upside + components.cleanRisk
  );

  const pp = (n) => `${(n * 100).toFixed(0)}pp`;
  const rationale = [
    `v3 ${v3n.toFixed(0)}/100 → +${pp(components.strength)} strength`,
    `Position ${pw.toFixed(1)}% (room to ${(Math.max(0, 8 - pw)).toFixed(1)}pp) → +${pp(components.positionRoom)}`,
    `Sector ${sw.toFixed(1)}% (room to ${(Math.max(0, 25 - sw)).toFixed(1)}pp) → +${pp(components.sectorRoom)}`,
    `Upside ${up.toFixed(1)}% to FV → +${pp(components.upside)}`,
    `${rc} risk flag${rc === 1 ? "" : "s"} → +${pp(components.cleanRisk)} clean-risk`,
    `Total topup severity ${pp(severity)} → maps to ${severityToTopUpRung(severity) || "no top-up (HOLD)"}`,
  ];

  return { severity, components, rationale };
}

export function severityToTopUpRung(severity) {
  // Cutoffs calibrated against the topup-severity scale so a clean
  // TOP_PICK (v3≥70, full room, ≥20% upside, 0 risks) clears 0.70 → 100%,
  // a STRONG name with moderate room/upside (~0.40 severity) lands 33%,
  // and anything below 0.30 doesn't trigger a topup recommendation.
  if (!Number.isFinite(severity) || severity < 0.30) return null;
  if (severity >= 0.70) return "Top-up-100%";
  if (severity >= 0.50) return "Top-up-50%";
  if (severity >= 0.30) return "Top-up-33%";
  return "Top-up-25%";
}

/**
 * Return the realised-trim fraction (0..1) for any action label, legacy or v2.
 * EXIT-staged returns 0.5 (the part realised today). HOLD and top-ups return
 * 0. Unknown actions return 0 — fail-soft so the cash math never NaNs.
 */
export function parseTrimPct(action) {
  return TRIM_PCT_BY_ACTION[action] ?? 0;
}

/**
 * Return the top-up fraction (0..1) of the user's "ideal add" size for any
 * top-up action, legacy or v2. HOLD and reduction actions return 0.
 */
export function parseTopUpPct(action) {
  return TOPUP_PCT_OF_IDEAL_BY_ACTION[action] ?? 0;
}

/**
 * Round-trip any v2 action to its legacy equivalent. Consumers that only
 * understand legacy labels (older code paths, third-party tests) can call
 * this on the way in. Already-legacy labels pass through unchanged.
 */
export function ladderToLegacy(action) {
  if (!action) return action;
  return LADDER_TO_LEGACY[action] ?? action;
}

/**
 * Conviction proxy used when scoreBandAction needs a HIGH/MEDIUM/LOW band
 * BEFORE the v2 conviction engine runs (the conviction engine consumes the
 * action, so we can't read its output back here). Composite of v3 score
 * (60%) + snowflake total normalised to 100 (40%) with deterministic
 * penalties for surveillance flags and structural risks. Same direction
 * as conviction engine but cheaper.
 */
export function deriveConvictionProxy({ v3, snow_total, surveillance, risks_count }) {
  const v3num = Number.isFinite(v3) ? v3 : 0;
  const snowNorm = Number.isFinite(snow_total) ? (snow_total / 30) * 100 : 0;
  let score = v3num * 0.6 + snowNorm * 0.4;

  if (surveillance) {
    if (surveillance.list === "GSM") {
      const stage = Number(surveillance.stage) || 1;
      // GSM-1 ~ -18, GSM-6 ~ -33 — heavier penalty for higher stages
      score -= 15 + stage * 3;
    } else if (surveillance.list === "ASM") {
      // ASM is lighter than GSM but still a structural negative
      score -= 8;
    }
  }
  score -= (Number(risks_count) || 0) * 4;

  if (score >= 70) return "HIGH";
  if (score >= 55) return "MEDIUM-HIGH";
  if (score >= 40) return "MEDIUM";
  if (score >= 25) return "MEDIUM-LOW";
  return "LOW";
}

/**
 * Pick a trim rung from the v2 ladder.
 *
 * Inputs:
 *   v3              — v3_score_100, 0..100
 *   position_weight — % of book this holding represents
 *   sector_weight   — % of book this holding's sector represents
 *   conviction      — string, output of deriveConvictionProxy
 *   surveillance    — { list: "ASM"|"GSM", stage?, timeframe? } | null
 *
 * Returns null when v3 is too high to trigger a trim — caller falls
 * through to top-up logic.
 *
 * Rationale array is built alongside so the UI can show "why this rung"
 * step by step.
 */
export function pickTrimRung({ v3, position_weight, sector_weight, conviction, surveillance }) {
  const rationale = [];
  const v3n = Number.isFinite(v3) ? v3 : 0;
  const pw = Number.isFinite(position_weight) ? position_weight : 0;
  const sw = Number.isFinite(sector_weight) ? sector_weight : 0;
  const surv = surveillance || null;
  const survList = surv?.list || null;
  const survStage = Number(surv?.stage) || 0;

  // Tier 1 — EXIT-now (deepest-conviction sell): v3 below 8 OR
  // GSM-3+ surveillance regardless of v3.
  if (v3n < 8) {
    rationale.push(`v3 ${v3n.toFixed(0)} below 8/100 — bottom-tier score, exit floor.`);
    return { action: "EXIT-now", band: "AVOID", rationale };
  }
  if (survList === "GSM" && survStage >= 3) {
    rationale.push(`NSE GSM stage ${survStage} surveillance — regulatory red flag.`);
    return { action: "EXIT-now", band: "AVOID", rationale };
  }

  // Tier 2 — EXIT-staged: v3 8-14, no severe surveillance. Sell half now,
  // keep half pending a confirmation break (technical or fundamental
  // catalyst) over the next 5 sessions.
  if (v3n < 14) {
    rationale.push(`v3 ${v3n.toFixed(0)} between 8-14 — weak thesis, stage exit.`);
    return { action: "EXIT-staged", band: "AVOID", rationale };
  }

  // Tier 3 — Reduction band (v3 14-22). Granularity driven by position
  // weight × conviction × surveillance.
  if (v3n < 22) {
    rationale.push(`v3 ${v3n.toFixed(0)} between 14-22 — WATCH band.`);
    if (pw > 15 && conviction === "LOW") {
      rationale.push(`Weight ${pw.toFixed(1)}% > 15% with LOW conviction — escalate to 66%.`);
      return { action: "Reduction-66%", band: "WATCH", rationale };
    }
    if (pw >= 10 && pw <= 15 && sw > 25 && (conviction === "LOW" || conviction === "MEDIUM-LOW")) {
      rationale.push(`Weight ${pw.toFixed(1)}% + sector ${sw.toFixed(1)}% > 25% — 50%.`);
      return { action: "Reduction-50%", band: "WATCH", rationale };
    }
    if (pw > 15) {
      rationale.push(`Weight ${pw.toFixed(1)}% > 15% — concentration drives 50%.`);
      return { action: "Reduction-50%", band: "WATCH", rationale };
    }
    if (pw >= 8 && pw < 10 && conviction === "MEDIUM") {
      rationale.push(`Weight ${pw.toFixed(1)}% with MEDIUM conviction — 33%.`);
      return { action: "Reduction-33%", band: "WATCH", rationale };
    }
    if (pw < 8 && sw < 25 && (conviction === "MEDIUM" || conviction === "MEDIUM-HIGH" || conviction === "HIGH") && !survList) {
      rationale.push(`Weight ${pw.toFixed(1)}%, sector ${sw.toFixed(1)}%, conviction ${conviction}, no surveillance — light 25%.`);
      return { action: "Reduction-25%", band: "WATCH", rationale };
    }
    rationale.push(`WATCH-band default — 33%.`);
    return { action: "Reduction-33%", band: "WATCH", rationale };
  }

  // Tier 4 — overweight or surveillance-driven Reduction-25% even when
  // v3 is in the ACCEPTABLE band (22-40). The reasoning is structural —
  // single-name concentration risk or ASM-stage-2+ regulatory friction —
  // not a thesis call.
  if (v3n < 40) {
    if (pw > 15) {
      rationale.push(`v3 ${v3n.toFixed(0)} ACCEPTABLE but weight ${pw.toFixed(1)}% > 15% — overweight trim 25%.`);
      return { action: "Reduction-25%", band: "ACCEPTABLE", rationale };
    }
    if (survList === "ASM" && survStage >= 2) {
      rationale.push(`NSE ASM stage ${survStage} surveillance — regulatory caution, light trim 25%.`);
      return { action: "Reduction-25%", band: "ACCEPTABLE", rationale };
    }
  }

  return null;
}

/**
 * Promote a legacy action label to a ladder-v2 rung based on the full
 * factor stack. This is the final-stage rewrite: scoreBandAction +
 * conviction engine + position guardrail all work in legacy space, and
 * promoteToLadderV2 maps their output to a granular rung once.
 *
 * Inputs cover both reduction and top-up branches:
 *   legacyAction     — "EXIT" | "Reduction-50%" | "Reduction-25-33%" |
 *                      "HOLD" | "Top-up-modest" | "Top-up" | "STRONG Top-up"
 *   v3, snow_total   — score inputs
 *   position_weight  — % of book this holding represents
 *   sector_weight    — % of book this holding's sector represents
 *   upside           — % to AnalystConsensus FV
 *   risks_count      — count of risk flags
 *   surveillance     — { list, stage } | null
 *   pnlPercent       — used for EXIT-now vs EXIT-staged staging
 *
 * Returns { action, legacyAction, ladderRationale[], ladderV2: true,
 *           conviction }. When SWS_LADDER_V2 is off, returns the legacy
 * action unchanged (no-op promotion) so callers don't need to branch.
 */
export function promoteToLadderV2({
  legacyAction,
  v3,
  snow_total,
  position_weight,
  sector_weight,
  upside,
  risks_count,
  surveillance,
  pnlPercent,
  // ─── V4 OPT-IN INPUTS (silently ignored when V4 flag is off) ───────
  pillars,           // { financial_health, future_growth, past_performance, valuation, dividends }
  daysHeld,          // number | null — days since first purchase
  fiftyTwoWeekHigh,  // ₹ | null
  fiftyTwoWeekLow,   // ₹ | null
  currentPrice,      // ₹ | null
  currentValue,      // ₹ | null — for position-floor execution-cost gate
  materialDisclosure,// boolean — bypasses settle-period gate when true
}) {
  const rationale = [];
  const conviction = deriveConvictionProxy({ v3, snow_total, surveillance, risks_count });

  if (!isLadderV2Enabled()) {
    return {
      action: legacyAction,
      legacyAction,
      ladderRationale: null,
      ladderV2: false,
      conviction,
    };
  }

  // V4 path — XIRR-optimised overlay on V3. Takes precedence when SWS_LADDER_V4=1.
  // V4 keeps the V3 severity surface and rung-mapping table; replaces the
  // weakness and drawdown raw inputs with pillar-decomposed and recoverable
  // versions; adds settle-period, action-history, and position-floor gates.
  // All V4-only inputs are optional — partial data degrades gracefully to V3.
  if (isLadderV4Enabled()) {
    return _promoteV4({
      legacyAction, v3, pillars, position_weight, sector_weight, upside, risks_count,
      surveillance, pnlPercent, conviction,
      currentPrice, fiftyTwoWeekHigh, fiftyTwoWeekLow, currentValue,
      daysHeld, materialDisclosure,
    });
  }

  // V3 path — continuous severity score replaces the categorical V2 matrix.
  // Default-fallback to Reduction-33% is gone; every input combination maps
  // to a specific rung based on its precise factor stack. Same SEBI-defensible
  // observational framing — engine emits a number, not an instruction.
  if (isLadderV3Enabled()) {
    return _promoteV3({
      legacyAction, v3, position_weight, sector_weight, upside, risks_count,
      surveillance, pnlPercent, conviction,
    });
  }

  const v3n = Number.isFinite(v3) ? v3 : 0;
  const pw = Number.isFinite(position_weight) ? position_weight : 0;
  const sw = Number.isFinite(sector_weight) ? sector_weight : 0;
  const up = Number.isFinite(upside) ? upside : 0;
  const rc = Number.isFinite(risks_count) ? risks_count : 0;
  const pnl = Number.isFinite(pnlPercent) ? pnlPercent : 0;
  const survList = surveillance?.list || null;
  const survStage = Number(surveillance?.stage) || 0;

  // ─── EXIT branch ───────────────────────────────────────────────
  // Legacy "EXIT" maps to either EXIT-now (severe regulatory red flag,
  // bottom-tier score, or extreme drawdown) or EXIT-staged (weak-thesis
  // exit where a partial sale today + technical-confirmation tail makes
  // sense). pnl threshold mirrors the conviction-engine guardrail at -40.
  if (legacyAction === "EXIT") {
    rationale.push(`Engine emitted legacy EXIT — promoting to ladder-v2 exit rung.`);
    if (survList === "GSM" && survStage >= 3) {
      rationale.push(`NSE GSM stage ${survStage} surveillance — exit immediately, no staging.`);
      return { action: "EXIT-now", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (v3n < 8) {
      rationale.push(`v3 ${v3n.toFixed(0)} below 8/100 — bottom-tier, exit immediately.`);
      return { action: "EXIT-now", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pnl <= -50) {
      rationale.push(`Drawdown ${pnl.toFixed(1)}% past -50% — thesis structurally broken, exit immediately.`);
      return { action: "EXIT-now", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    rationale.push(`Conviction ${conviction}, drawdown ${pnl.toFixed(1)}%, no GSM-3+ — stage exit (50% now, 50% on confirmation).`);
    return { action: "EXIT-staged", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
  }

  // ─── Reduction-50% branch ──────────────────────────────────────
  // Promote to 25/33/50/66 based on factor stack. Position weight is
  // the dominant driver — concentration risk amplifies the trim depth.
  if (legacyAction === "Reduction-50%") {
    rationale.push(`Engine emitted Reduction-50% — promoting to factor-driven ladder rung.`);
    if (pw > 15 && conviction === "LOW") {
      rationale.push(`Weight ${pw.toFixed(1)}% > 15% with LOW conviction — escalate to 66%.`);
      return { action: "Reduction-66%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pw > 15) {
      rationale.push(`Weight ${pw.toFixed(1)}% > 15% — concentration risk, hold 50% trim.`);
      return { action: "Reduction-50%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pw >= 10 && pw <= 15 && (sw > 25 || conviction === "LOW" || conviction === "MEDIUM-LOW")) {
      rationale.push(`Weight ${pw.toFixed(1)}%, sector ${sw.toFixed(1)}%, conviction ${conviction} — keep 50% trim.`);
      return { action: "Reduction-50%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pw >= 8 && pw < 10) {
      rationale.push(`Weight ${pw.toFixed(1)}% in 8-10 band — soften to 33%.`);
      return { action: "Reduction-33%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pw < 8 && (conviction === "MEDIUM" || conviction === "MEDIUM-HIGH" || conviction === "HIGH") && !survList) {
      rationale.push(`Weight ${pw.toFixed(1)}% < 8%, conviction ${conviction}, no surveillance — light 25% trim.`);
      return { action: "Reduction-25%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    rationale.push(`Default fallback — 33%.`);
    return { action: "Reduction-33%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
  }

  // ─── Reduction-25-33% branch (legacy mid-trim) ────────────────
  // Map to 25 or 33 based on weight + conviction. Anchors are the same
  // as the Reduction-50% branch but capped at 33 max.
  if (legacyAction === "Reduction-25-33%") {
    rationale.push(`Engine emitted Reduction-25-33% — choosing 25 vs 33 based on factors.`);
    if (pw >= 8 || conviction === "LOW" || conviction === "MEDIUM-LOW") {
      rationale.push(`Weight ${pw.toFixed(1)}%, conviction ${conviction} — 33% trim.`);
      return { action: "Reduction-33%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    rationale.push(`Weight ${pw.toFixed(1)}%, conviction ${conviction} — 25% trim.`);
    return { action: "Reduction-25%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
  }

  // ─── Top-up branch (legacy modest / normal / strong) ──────────
  // Symmetric ladder: 25 / 33 / 50 / 100% of an "ideal add" size.
  // Stronger upside + maximal room + clean risks → larger rung.
  if (legacyAction === "STRONG Top-up") {
    rationale.push(`Engine emitted STRONG Top-up — promoting to top-up ladder.`);
    if (pw < 5 && sw < 20 && up >= 15 && rc === 0) {
      rationale.push(`v3 ${v3n.toFixed(0)} + weight ${pw.toFixed(1)}% < 5% + sector ${sw.toFixed(1)}% < 20% + upside ${up.toFixed(1)}% ≥ 15% + 0 risks → 100%.`);
      return { action: "Top-up-100%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pw < 8 && sw < 25 && up >= 10 && rc <= 1) {
      rationale.push(`Moderate room (${pw.toFixed(1)}%/${sw.toFixed(1)}%) + upside ${up.toFixed(1)}% → 50%.`);
      return { action: "Top-up-50%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    rationale.push(`Constrained by room/risks — 25%.`);
    return { action: "Top-up-25%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
  }
  if (legacyAction === "Top-up") {
    rationale.push(`Engine emitted Top-up — choosing rung based on factors.`);
    if (pw < 6 && sw < 22 && up >= 15 && rc === 0) {
      rationale.push(`Ample room + upside ${up.toFixed(1)}% + 0 risks → 50%.`);
      return { action: "Top-up-50%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    if (pw < 8 && sw < 25 && up >= 5 && rc <= 1) {
      rationale.push(`Room + upside ${up.toFixed(1)}% → 33%.`);
      return { action: "Top-up-33%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
    }
    rationale.push(`Room/upside thin — 25%.`);
    return { action: "Top-up-25%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
  }
  if (legacyAction === "Top-up-modest") {
    rationale.push(`Engine emitted Top-up-modest — promoting to 25% (smallest rung).`);
    return { action: "Top-up-25%", legacyAction, ladderRationale: rationale, ladderV2: true, conviction };
  }

  // ─── HOLD / unknown — pass through ────────────────────────────
  return {
    action: legacyAction || "HOLD",
    legacyAction: legacyAction || "HOLD",
    ladderRationale: null,
    ladderV2: false,
    conviction,
  };
}

/**
 * V3 promotion path. The legacyAction tells us whether the engine is on
 * the trim or top-up side of the ladder; severity model picks the rung
 * within that side. Same return contract as the V2 path so callers don't
 * need to branch.
 */
function _promoteV3({
  legacyAction, v3, position_weight, sector_weight, upside, risks_count,
  surveillance, pnlPercent, conviction,
}) {
  const v3n = Number.isFinite(v3) ? v3 : 0;
  const survList = surveillance?.list || null;
  const survStage = Number(surveillance?.stage) || 0;
  const gsmStage3Plus = survList === "GSM" && survStage >= 3;

  // ─── EXIT branch (forced exit from engine) ─────────────────────
  if (legacyAction === "EXIT") {
    const trim = computeTrimSeverity({
      v3, position_weight, sector_weight, conviction,
      surveillance, pnlPercent, risks_count,
    });
    let exitRung;
    if (gsmStage3Plus) exitRung = "EXIT-now";
    else if (v3n < 8) exitRung = "EXIT-now";
    else if (Number.isFinite(pnlPercent) && pnlPercent <= -50) exitRung = "EXIT-now";
    else exitRung = trim.severity >= 0.85 ? "EXIT-now" : "EXIT-staged";
    return {
      action: exitRung,
      legacyAction: "EXIT",
      ladderRationale: [
        `Engine emitted EXIT — V3 severity model determines staging.`,
        ...trim.rationale,
        `Exit rung: ${exitRung}${exitRung === "EXIT-staged" ? " (50% now, 50% on confirmation T+5)" : ""}.`,
      ],
      ladderV2: true,
      conviction,
      severity: trim.severity,
      severityComponents: trim.components,
    };
  }

  // ─── Reduction branch (engine flagged a trim) ────────────────────
  if (legacyAction === "Reduction-50%" || legacyAction === "Reduction-25-33%") {
    const trim = computeTrimSeverity({
      v3, position_weight, sector_weight, conviction,
      surveillance, pnlPercent, risks_count,
    });
    const rung = severityToTrimRung(trim.severity, { gsmStage3Plus }) || "Reduction-25%";
    return {
      action: rung,
      legacyAction,
      ladderRationale: [
        `Engine emitted ${legacyAction} — V3 severity model selects the specific rung.`,
        ...trim.rationale,
      ],
      ladderV2: true,
      conviction,
      severity: trim.severity,
      severityComponents: trim.components,
    };
  }

  // ─── Top-up branch (engine flagged accumulation) ─────────────────
  if (legacyAction === "STRONG Top-up" || legacyAction === "Top-up" || legacyAction === "Top-up-modest") {
    const tu = computeTopUpSeverity({ v3, position_weight, sector_weight, upside, risks_count });
    // Floor on 25% — once the engine has decided to top-up, the smallest
    // recommended rung is 25% of an ideal add. Severity below 0.30 is unusual
    // when the engine pre-emitted Top-up; default to 25% in that case.
    const rung = severityToTopUpRung(tu.severity) || "Top-up-25%";
    return {
      action: rung,
      legacyAction,
      ladderRationale: [
        `Engine emitted ${legacyAction} — V3 severity model selects the specific rung.`,
        ...tu.rationale,
      ],
      ladderV2: true,
      conviction,
      severity: tu.severity,
      severityComponents: tu.components,
    };
  }

  // HOLD or unknown — pass through unchanged.
  return {
    action: legacyAction || "HOLD",
    legacyAction: legacyAction || "HOLD",
    ladderRationale: null,
    ladderV2: false,
    conviction,
  };
}

// ════════════════════════════════════════════════════════════════════════
// V4 GATES — XIRR-OPTIMISED RUNG ADJUSTMENTS (Phase 1)
// ════════════════════════════════════════════════════════════════════════

/**
 * Settle-period gate (V4, change 3.7 of the redesign plan).
 *
 * A position held < 60 days has not had time for the original thesis to
 * falsify. Trimming on early-cycle v3 fade often books a paper loss the
 * market resolves in 4-6 weeks. EXIT-now and surveillance overrides
 * bypass this gate (regulatory / disclosure events ARE thesis-breaks).
 *
 * Returns the adjusted severity (capped at 0.30 inside the window) plus
 * a rationale string when the gate fires. When daysHeld is null
 * (uploads without dates) the gate is a no-op.
 */
export function applySettlePeriodGate({ severity, daysHeld, surveillance, materialDisclosure, gsmStage3Plus }) {
  if (!Number.isFinite(daysHeld) || daysHeld >= 60) return { severity, fired: false };
  // Hard EXITs and severe surveillance bypass — these are not "early-cycle
  // noise", they're legitimate thesis-breaks regardless of holding period.
  if (gsmStage3Plus) return { severity, fired: false };
  if (severity >= 0.75) return { severity, fired: false };
  // Material-disclosure event (board removal, fraud notice, restated
  // accounts) bypasses the settle window — these mean the thesis falsified
  // independent of time-in-position.
  if (materialDisclosure) return { severity, fired: false };
  // Inside the settle window, cap trim severity just below the Red-33%
  // threshold (0.22 under aggressive-trim recalibration) so the rung lands
  // firmly in Reduction-25% territory. Concentration escalators on the
  // caller side still apply (they should — a 30%-weight position fresh-
  // bought is a sizing error, not a thesis call). The cap must move in
  // lockstep with severityToTrimRung's Red-33% threshold.
  if (severity < 0.22) return { severity, fired: false };
  return {
    severity: 0.21,
    fired: true,
    rationale: `Settle-period gate: held ${daysHeld}d (< 60d) — capping trim severity to 0.21 (max Reduction-25%) until thesis has time to falsify`,
  };
}

/**
 * Position-floor + execution-cost gate (V4, change 3.6 of the redesign plan).
 *
 * Below ~2.5% of book, partial trims are noise: round-trip execution cost
 * (impact + STT + brokerage + bid-ask) eats 0.4-0.8% of the freed cash,
 * and the freed amount is too small to redeploy meaningfully (< ₹50k for a
 * typical book). V4 collapses small-position actions to the binary
 * {HOLD, EXIT-now}: severe enough to exit → close it; otherwise hold.
 *
 * Symmetric for top-ups: if the ideal add is < ₹25k, bump to next-larger
 * rung or skip — too small to matter at typical execution-cost levels.
 *
 * Returns either the original rung or an adjusted one with a rationale.
 */
const POSITION_FLOOR_PCT = 2.5;
const TOPUP_FLOOR_RUPEES = 25_000;
export function applyPositionFloorGate({ rung, severity, positionWeight, currentValue, ideal_add_rupees }) {
  if (!rung) return { rung, fired: false };
  // Trim-side floor
  if (Number.isFinite(positionWeight) && positionWeight < POSITION_FLOOR_PCT && rung in TRIM_PCT_BY_ACTION) {
    if (severity >= 0.75) {
      return {
        rung: "EXIT-now",
        fired: true,
        rationale: `Position-floor: weight ${positionWeight.toFixed(1)}% < ${POSITION_FLOOR_PCT}% AND severity ${(severity*100).toFixed(0)}pp ≥ 75 — close cleanly instead of partial trim`,
      };
    }
    return {
      rung: null, // → caller maps to HOLD
      fired: true,
      rationale: `Position-floor: weight ${positionWeight.toFixed(1)}% < ${POSITION_FLOOR_PCT}% — partial trim freed cash too small to redeploy after execution cost; HOLD`,
    };
  }
  // Top-up-side floor — small adds eat too much in execution cost. Walks
  // through the upgrade ladder (25→33→50→100) and picks the smallest rung
  // that clears the ₹25k threshold. If even Top-up-100% can't clear (base
  // position < ₹25k), defer the add this cycle — too small to redeploy.
  if (rung in TOPUP_PCT_OF_IDEAL_BY_ACTION && Number.isFinite(ideal_add_rupees) && ideal_add_rupees > 0) {
    const fraction = TOPUP_PCT_OF_IDEAL_BY_ACTION[rung] ?? 0;
    const realised_add = ideal_add_rupees * fraction;
    if (realised_add < TOPUP_FLOOR_RUPEES) {
      const upgradeLadder = ["Top-up-25%", "Top-up-33%", "Top-up-50%", "Top-up-100%"];
      const startIdx = upgradeLadder.indexOf(rung);
      for (let i = startIdx + 1; i < upgradeLadder.length; i++) {
        const candidate = upgradeLadder[i];
        if (ideal_add_rupees * (TOPUP_PCT_OF_IDEAL_BY_ACTION[candidate] ?? 0) >= TOPUP_FLOOR_RUPEES) {
          return {
            rung: candidate,
            fired: true,
            rationale: `Top-up floor: ₹${Math.round(realised_add)} at ${rung} below ₹${TOPUP_FLOOR_RUPEES} threshold — promoted to ${candidate} for meaningful sizing`,
          };
        }
      }
      return {
        rung: null, // → HOLD
        fired: true,
        rationale: `Top-up floor: base position too small to clear ₹${TOPUP_FLOOR_RUPEES} even at Top-up-100% — defer this cycle`,
      };
    }
  }
  return { rung, fired: false };
}

/**
 * V4 promotion path. Same return contract as _promoteV3 with two extra
 * fields: `severityModel: "v4"` for diagnostics and the gate rationales
 * woven into the ladderRationale array in execution order so the user
 * can see exactly which gates fired and why.
 */
function _promoteV4({
  legacyAction, v3, pillars, position_weight, sector_weight, upside, risks_count,
  surveillance, pnlPercent, conviction,
  currentPrice, fiftyTwoWeekHigh, fiftyTwoWeekLow, currentValue,
  daysHeld, materialDisclosure,
}) {
  const v3n = Number.isFinite(v3) ? v3 : 0;
  const survList = surveillance?.list || null;
  const survStage = Number(surveillance?.stage) || 0;
  const gsmStage3Plus = survList === "GSM" && survStage >= 3;

  // ─── EXIT branch (forced exit from engine) ─────────────────────
  // V4 uses the V4 trim severity for staging decision but otherwise
  // mirrors V3's exit-branch logic — engine-emitted EXIT means EXIT,
  // V4 just refines the staging.
  if (legacyAction === "EXIT") {
    const trim = computeTrimSeverityV4({
      v3, pillars, position_weight, sector_weight, conviction,
      surveillance, pnlPercent, currentPrice, fiftyTwoWeekHigh, fiftyTwoWeekLow, risks_count,
    });
    let exitRung;
    if (gsmStage3Plus) exitRung = "EXIT-now";
    else if (v3n < 8) exitRung = "EXIT-now";
    else if (Number.isFinite(pnlPercent) && pnlPercent <= -50) exitRung = "EXIT-now";
    else exitRung = trim.severity >= 0.85 ? "EXIT-now" : "EXIT-staged";
    return {
      action: exitRung,
      legacyAction: "EXIT",
      ladderRationale: [
        `Engine emitted EXIT — V4 severity model determines staging.`,
        ...trim.rationale,
        `Exit rung: ${exitRung}${exitRung === "EXIT-staged" ? " (50% now, 50% on confirmation T+5)" : ""}.`,
      ],
      ladderV2: true,
      conviction,
      severity: trim.severity,
      severityComponents: trim.components,
      severityModel: "v4",
    };
  }

  // ─── Reduction branch (V4) ───────────────────────────────────────
  if (legacyAction === "Reduction-50%" || legacyAction === "Reduction-25-33%") {
    const trim = computeTrimSeverityV4({
      v3, pillars, position_weight, sector_weight, conviction,
      surveillance, pnlPercent, currentPrice, fiftyTwoWeekHigh, fiftyTwoWeekLow, risks_count,
    });
    const trimRationale = [
      `Engine emitted ${legacyAction} — V4 severity model selects rung.`,
      ...trim.rationale,
    ];
    // Settle-period gate — caps severity inside the holding-window
    const settle = applySettlePeriodGate({
      severity: trim.severity, daysHeld, surveillance, materialDisclosure, gsmStage3Plus,
    });
    let workingSeverity = settle.severity;
    if (settle.fired) trimRationale.push(settle.rationale);
    // Map severity to rung (re-using V3's mapping table)
    let rung = severityToTrimRung(workingSeverity, { gsmStage3Plus });
    // Position-floor gate — collapse small-position actions to {HOLD, EXIT-now}
    const floor = applyPositionFloorGate({
      rung, severity: workingSeverity, positionWeight: position_weight, currentValue,
    });
    if (floor.fired) {
      rung = floor.rung;
      trimRationale.push(floor.rationale);
    }
    if (!rung) {
      // Severity → no trim → HOLD
      return {
        action: "HOLD",
        legacyAction,
        ladderRationale: [
          ...trimRationale,
          `Final V4 decision: HOLD (severity ${(workingSeverity*100).toFixed(0)}pp below 15pp trim floor or position-floor gated)`,
        ],
        ladderV2: true,
        conviction,
        severity: workingSeverity,
        severityComponents: trim.components,
        severityModel: "v4",
      };
    }
    return {
      action: rung,
      legacyAction,
      ladderRationale: trimRationale,
      ladderV2: true,
      conviction,
      severity: workingSeverity,
      severityComponents: trim.components,
      severityModel: "v4",
    };
  }

  // ─── Top-up branch (V4 — Phase 1 keeps V3 top-up severity) ───────
  // Phase 2 of the redesign adds momentum-based top-up timing (3.3) and
  // volatility-adjusted sizing (3.12). For Phase 1, V4's top-up rung is
  // identical to V3's, but with the position-floor execution gate applied
  // so tiny adds get promoted or skipped.
  if (legacyAction === "STRONG Top-up" || legacyAction === "Top-up" || legacyAction === "Top-up-modest") {
    const tu = computeTopUpSeverity({ v3, position_weight, sector_weight, upside, risks_count });
    const topUpRationale = [
      `Engine emitted ${legacyAction} — V4 selects rung from V3 top-up severity (Phase 2 will add momentum-timing).`,
      ...tu.rationale,
    ];
    let rung = severityToTopUpRung(tu.severity) || "Top-up-25%";
    // Top-up floor gate (V4 Phase 1) — small adds get promoted or skipped
    if (Number.isFinite(currentValue)) {
      // ideal_add_rupees ≈ currentValue (the engine treats Top-up-100% as
      // doubling the position, so the "ideal add" is the current value)
      const floor = applyPositionFloorGate({
        rung, severity: tu.severity, positionWeight: position_weight, currentValue,
        ideal_add_rupees: currentValue,
      });
      if (floor.fired) {
        topUpRationale.push(floor.rationale);
        if (!floor.rung) {
          return {
            action: "HOLD", legacyAction, ladderRationale: topUpRationale, ladderV2: true,
            conviction, severity: tu.severity, severityComponents: tu.components, severityModel: "v4",
          };
        }
        rung = floor.rung;
      }
    }
    return {
      action: rung,
      legacyAction,
      ladderRationale: topUpRationale,
      ladderV2: true,
      conviction,
      severity: tu.severity,
      severityComponents: tu.components,
      severityModel: "v4",
    };
  }

  // HOLD or unknown — pass through unchanged.
  return {
    action: legacyAction || "HOLD",
    legacyAction: legacyAction || "HOLD",
    ladderRationale: null,
    ladderV2: false,
    conviction,
    severityModel: "v4",
  };
}

/**
 * Pick a top-up rung from the v2 ladder. Mirrors pickTrimRung — the
 * factor stack is symmetric (position room, sector room, upside, risks
 * count) and rationale is built step by step. Returns null when v3 is
 * too low to trigger a top-up — caller defaults to HOLD.
 */
export function pickTopUpRung({ v3, position_weight, sector_weight, upside, risks_count }) {
  const rationale = [];
  const v3n = Number.isFinite(v3) ? v3 : 0;
  const pw = Number.isFinite(position_weight) ? position_weight : 0;
  const sw = Number.isFinite(sector_weight) ? sector_weight : 0;
  const up = Number.isFinite(upside) ? upside : 0;
  const rc = Number.isFinite(risks_count) ? risks_count : 0;

  // Tier 1 — Top-up-100% (full ideal add): TOP_PICK band with maximal
  // room and clean risk profile.
  if (v3n >= 65) {
    if (pw < 5 && sw < 20 && up >= 15 && rc === 0) {
      rationale.push(`v3 ${v3n.toFixed(0)} TOP_PICK + weight ${pw.toFixed(1)}% < 5% + sector ${sw.toFixed(1)}% < 20% + upside ${up.toFixed(1)}% ≥ 15% + 0 risks → 100%.`);
      return { action: "Top-up-100%", band: "TOP_PICK", rationale };
    }
    if (pw < 8 && sw < 25 && up >= 10 && rc <= 1) {
      rationale.push(`v3 ${v3n.toFixed(0)} TOP_PICK with moderate room (${pw.toFixed(1)}%/${sw.toFixed(1)}%) + upside ${up.toFixed(1)}% → 50%.`);
      return { action: "Top-up-50%", band: "TOP_PICK", rationale };
    }
    rationale.push(`v3 ${v3n.toFixed(0)} TOP_PICK but room/risk constraints limit to 25%.`);
    return { action: "Top-up-25%", band: "TOP_PICK", rationale };
  }

  // Tier 2 — STRONG band (50-65). Granular by upside + risks.
  if (v3n >= 50) {
    if (pw < 6 && sw < 22 && up >= 15 && rc === 0) {
      rationale.push(`v3 ${v3n.toFixed(0)} STRONG + ample room + upside ${up.toFixed(1)}% + 0 risks → 50%.`);
      return { action: "Top-up-50%", band: "STRONG", rationale };
    }
    if (pw < 8 && sw < 25 && up >= 5 && rc <= 1) {
      rationale.push(`v3 ${v3n.toFixed(0)} STRONG + room + upside ${up.toFixed(1)}% → 33%.`);
      return { action: "Top-up-33%", band: "STRONG", rationale };
    }
    rationale.push(`v3 ${v3n.toFixed(0)} STRONG but room/upside thin — 25%.`);
    return { action: "Top-up-25%", band: "STRONG", rationale };
  }

  // Tier 3 — ACCEPTABLE-PLUS band (40-50). Modest add only when rules clear.
  if (v3n >= 40) {
    if (pw <= 8 && sw <= 25 && up >= 5) {
      rationale.push(`v3 ${v3n.toFixed(0)} ACCEPTABLE-PLUS + room + upside ${up.toFixed(1)}% → 25%.`);
      return { action: "Top-up-25%", band: "ACCEPTABLE-PLUS", rationale };
    }
  }

  return null;
}
