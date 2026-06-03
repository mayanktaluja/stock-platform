// Per-action timing observation — answers "is today the right day?"
// for every non-HOLD action emitted by the SWS engine.
//
// Promoted from a stub in swsHoldingEngine.js as part of PR-3 of the
// SEBI-RA-grade analyzer plan. The richer inputs (NSE market-state
// derived from IST clock, macro-regime severity, sector impact)
// produce a deterministic verdict + suggested NSE intraday window.
//
// Pure function. No I/O, no LLM, deterministic given inputs — testable
// with frozen Date.now() and a fixed marketState. Output schema:
//
//   {
//     verdict: "Yes" | "Yes-not-urgent" | "Soft-no" | "No" |
//              "Wait-for-open" | "n/a"
//     window:  null | "next-session" | "mid-morning" |
//              "post-lunch" | "closing-vwap"
//     reason:  short plain-English string
//   }
//
// SEBI framing: this is observational research, not a directive.
// The window suggestions match standard NSE microstructure heuristics
// — mid-morning (10:30-12:00) avoids the open volatility, post-lunch
// (13:30-14:30) catches afternoon liquidity, closing-VWAP defers to
// the auction so single-print impact is dampened.

import { num } from "./swsScoring.js";

// NSE regular session: 09:15-15:30 IST, Mon-Fri.
// Pre-open auction: 09:00-09:15. Post-close: 15:40-16:00 (admin).
// We model: Closed (pre-09:00 + post-16:00 + weekends),
// Pre-open (09:00-09:15), Open (09:15-15:30), Post-close (15:30-16:00 ish).
const NSE_OPEN_MIN = 9 * 60 + 15;   // 09:15
const NSE_CLOSE_MIN = 15 * 60 + 30; // 15:30
const NSE_PREOPEN_MIN = 9 * 60;     // 09:00

/**
 * Derive NSE market state from a Date (defaults to now). Pure math —
 * no network call. IST = UTC+5:30. Caller can override by passing an
 * explicit marketState string to computeTimingObservation.
 */
export function deriveIstMarketState(now = new Date()) {
  // IST minutes-since-midnight
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const day = ist.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return "Closed";
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (minutes < NSE_PREOPEN_MIN) return "Closed";
  if (minutes < NSE_OPEN_MIN) return "Pre-open";
  if (minutes <= NSE_CLOSE_MIN) return "Open";
  return "Post-close";
}

// Action label classification — handles both legacy and ladder-v2 labels.
const TRIM_OR_EXIT_ACTIONS = new Set([
  "EXIT", "EXIT-now", "EXIT-staged",
  "Reduction-25%", "Reduction-25-33%", "Reduction-33%", "Reduction-50%", "Reduction-66%",
]);
const TOPUP_ACTIONS = new Set([
  "Top-up-modest", "Top-up", "STRONG Top-up",
  "Top-up-25%", "Top-up-33%", "Top-up-50%", "Top-up-100%",
]);

// Build a compact earnings-note fragment for use in timing reason strings.
// Returns "" when the prediction isn't trustworthy enough to surface
// (missing, LOW quality, INSUFFICIENT_DATA, or no concrete days_until).
// Format: "Q-result in 3d predicted BEAT (64% conf)" — short enough to
// append inline to any timing reason without bloating the chip.
function _earningsNoteFragment({ predictionVerdict, predictionConfidence, predictionQuality, epsDays }) {
  if (epsDays == null || epsDays < 0) return "";
  if (!predictionVerdict || predictionVerdict === "INSUFFICIENT_DATA") return "";
  if (predictionQuality === "LOW") return "";
  const conf = Number.isFinite(predictionConfidence) ? Math.round(predictionConfidence) : null;
  const dayLabel = epsDays === 0 ? "today" : epsDays === 1 ? "tomorrow" : `in ${epsDays}d`;
  const confSuffix = conf != null ? ` (${conf}% conf)` : "";
  return `Q-result ${dayLabel} predicted ${predictionVerdict}${confSuffix}`;
}

/**
 * Compute the timing observation for a holding's recommended action.
 *
 * @param {object} input
 * @param {string} input.action          Action label (legacy or ladder-v2)
 * @param {object} [input.scored]        SWS-scored payload (overview block)
 * @param {Date}   [input.now]           Override clock (for tests)
 * @param {string} [input.marketState]   Override market state (for tests)
 * @param {number} [input.regimeSeverity] 0-5 from macroRegime
 * @param {number} [input.sectorImpact]   -3..+3 sector impact under regime
 * @param {string} [input.predictionVerdict]    "BEAT" | "INLINE" | "MISS"
 * @param {number} [input.predictionConfidence] 0-100 confidence percentage
 * @param {string} [input.predictionQuality]    "HIGH" | "MEDIUM" | "LOW"
 *
 * The prediction* inputs are sourced from the catalyst layer's
 * `prediction` metadata block. They never CHANGE the verdict — they
 * only enrich the human-readable reason string so the timing chip
 * surfaces the upcoming-earnings context the user is already seeing in
 * the stock-detail modal. See the rationale in services/swsCatalystLayer.js:
 * _buildPredictionMeta for why the prediction is shadow-only at this stage.
 */
export function computeTimingObservation({
  action,
  scored = null,
  now = new Date(),
  marketState = null,
  regimeSeverity = 0,
  sectorImpact = 0,
  predictionVerdict = null,
  predictionConfidence = null,
  predictionQuality = null,
}) {
  // 1. HOLD → no transaction → n/a.
  if (!action || action === "HOLD") {
    return { verdict: "n/a", window: null, reason: "Hold — no transaction needed." };
  }

  // Compute eps proximity once — used both for the market-closed earnings
  // alert AND the per-branch earnings note suffix below.
  const ov = scored?.overview || {};
  const next = ov.next_earnings_date;
  const epsDays = next
    ? Math.ceil((Date.parse(next + "T00:00:00Z") - now.getTime()) / 86400000)
    : null;
  const earningsNote = _earningsNoteFragment({ predictionVerdict, predictionConfidence, predictionQuality, epsDays });
  // earnings_alert is attached to every return shape when eps_days <= 7 and a
  // valid prediction is available — the UI uses this to render a small badge
  // alongside the existing verdict, so a user looking at "Wait-for-open" at
  // midnight IST can also see "Q-result in 3d, BEAT 64%" without expanding
  // any row.
  const earningsAlert = (epsDays != null && epsDays >= 0 && epsDays <= 7 && earningsNote)
    ? {
        eps_days: epsDays,
        verdict: predictionVerdict,
        confidence_pct: Number.isFinite(predictionConfidence) ? Math.round(predictionConfidence) : null,
        data_quality: predictionQuality || null,
      }
    : null;
  const earningsSuffix = (epsDays != null && epsDays >= 0 && epsDays <= 14 && earningsNote)
    ? ` (${earningsNote})`
    : "";

  // 2. NSE closed → defer to next regular session.
  // Bug fix (May 2026): previously these branches returned early and the
  // earnings-proximity check below was unreachable when the market was
  // closed — so a user looking at the analyzer at midnight IST never saw
  // the "Q-result in 3d" warning. Now we append the earnings note to the
  // reason string and attach earnings_alert when applicable.
  const ms = marketState || deriveIstMarketState(now);
  const closedSuffix = (epsDays != null && epsDays >= 0 && epsDays <= 7 && earningsNote)
    ? ` Also: ${earningsNote} — consider waiting through the event.`
    : "";
  if (ms === "Closed") {
    return {
      verdict: "Wait-for-open",
      window: "next-session",
      reason: `NSE closed — next regular session at 09:15 IST.${closedSuffix}`,
      earnings_alert: earningsAlert,
    };
  }
  if (ms === "Pre-open") {
    return {
      verdict: "Wait-for-open",
      window: "next-session",
      reason: `Pre-open auction in progress — regular session opens at 09:15 IST; use this as a liquidity caution, not an action prompt.${closedSuffix}`,
      earnings_alert: earningsAlert,
    };
  }
  if (ms === "Post-close") {
    return {
      verdict: "Wait-for-open",
      window: "next-session",
      reason: `Post-close period — next regular session at 09:15 IST tomorrow.${closedSuffix}`,
      earnings_alert: earningsAlert,
    };
  }

  // 3. Earnings proximity. Imminent earnings (≤3d) overrule everything
  // except already-closed market — gap risk on event days dominates any
  // timing edge from intraday windows.
  if (epsDays != null && epsDays >= 0 && epsDays <= 3) {
    return {
      verdict: "No",
      window: null,
      reason: `Earnings in ${epsDays}d — wait for results; intraday timing irrelevant against an event-day gap.${earningsNote ? ` Predictor: ${predictionVerdict}${Number.isFinite(predictionConfidence) ? ` ${Math.round(predictionConfidence)}% conf` : ""}.` : ""}`,
      earnings_alert: earningsAlert,
    };
  }
  if (epsDays != null && epsDays >= 4 && epsDays <= 7) {
    return {
      verdict: "Soft-no",
      window: "closing-vwap",
      reason: `Earnings in ${epsDays}d — let positioning settle; if acting, closing VWAP dampens single-print impact.${earningsNote ? ` Predictor: ${predictionVerdict}${Number.isFinite(predictionConfidence) ? ` ${Math.round(predictionConfidence)}% conf` : ""}.` : ""}`,
      earnings_alert: earningsAlert,
    };
  }

  // 4. Recent analyst-PT downward revision. Even outside earnings,
  // a fresh PT cut introduces unstable price discovery — closing VWAP
  // is the disciplined response.
  const recentDownRev = Array.isArray(ov.recent_analyst_revisions)
    && ov.recent_analyst_revisions.some((r) => r?.direction === "decreased");
  if (recentDownRev) {
    return {
      verdict: "Soft-no",
      window: "closing-vwap",
      reason: `Recent analyst PT cut — let the re-rating settle; target closing VWAP if acting.${earningsSuffix}`,
      earnings_alert: earningsAlert,
    };
  }

  // 5. Momentum-based windows.
  const ret1m = num((ov.returns_pct || {})["1M"], 0);
  if (ret1m > 15 && TRIM_OR_EXIT_ACTIONS.has(action)) {
    return {
      verdict: "Soft-no",
      window: "closing-vwap",
      reason: `1M return +${ret1m.toFixed(1)}% — overshot; deferring trim to closing VWAP avoids selling into a parabolic print.${earningsSuffix}`,
      earnings_alert: earningsAlert,
    };
  }
  if (ret1m < -15) {
    if (TOPUP_ACTIONS.has(action)) {
      return {
        verdict: "Yes",
        window: "mid-morning",
        reason: `1M return ${ret1m.toFixed(1)}% — averaging window; mid-morning (10:30-12:00) avoids open volatility while liquidity is still deep.${earningsSuffix}`,
        earnings_alert: earningsAlert,
      };
    }
    if (TRIM_OR_EXIT_ACTIONS.has(action)) {
      return {
        verdict: "Yes-not-urgent",
        window: "post-lunch",
        reason: `1M return ${ret1m.toFixed(1)}% — avoid panic exit at the open; post-lunch (13:30-14:30) intraday stability is better.${earningsSuffix}`,
        earnings_alert: earningsAlert,
      };
    }
  }

  // 6. Macro regime headwind against this sector. Severity≥4 + sector
  // impact ≤-2 = a fast-moving regime working against your position;
  // closing-VWAP execution dampens reflexivity vs. discrete intraday timing.
  if (regimeSeverity >= 4 && sectorImpact <= -2 && TRIM_OR_EXIT_ACTIONS.has(action)) {
    return {
      verdict: "Soft-no",
      window: "closing-vwap",
      reason: `Severe macro regime against your sector — review exposure against closing VWAP, not intraday urgency.${earningsSuffix}`,
      earnings_alert: earningsAlert,
    };
  }

  // 7. Default — clean of catalyst, momentum, and macro shocks.
  return {
    verdict: "Yes",
    window: "mid-morning",
    reason: `No proximate catalyst or volatility shock — standard mid-morning window (10:30-12:00) for a balance of liquidity and stability.${earningsSuffix}`,
    earnings_alert: earningsAlert,
  };
}
