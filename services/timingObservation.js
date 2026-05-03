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
 */
export function computeTimingObservation({
  action,
  scored = null,
  now = new Date(),
  marketState = null,
  regimeSeverity = 0,
  sectorImpact = 0,
}) {
  // 1. HOLD → no transaction → n/a.
  if (!action || action === "HOLD") {
    return { verdict: "n/a", window: null, reason: "Hold — no transaction needed." };
  }

  // 2. NSE closed → defer to next regular session.
  const ms = marketState || deriveIstMarketState(now);
  if (ms === "Closed") {
    return {
      verdict: "Wait-for-open",
      window: "next-session",
      reason: "NSE closed — next regular session at 09:15 IST.",
    };
  }
  if (ms === "Pre-open") {
    return {
      verdict: "Wait-for-open",
      window: "next-session",
      reason: "Pre-open auction in progress — regular session opens at 09:15 IST; orders here only at limit, no market orders.",
    };
  }
  if (ms === "Post-close") {
    return {
      verdict: "Wait-for-open",
      window: "next-session",
      reason: "Post-close period — next regular session at 09:15 IST tomorrow.",
    };
  }

  const ov = scored?.overview || {};

  // 3. Earnings proximity. Imminent earnings (≤3d) overrule everything
  // except already-closed market — gap risk on event days dominates any
  // timing edge from intraday windows.
  const next = ov.next_earnings_date;
  const epsDays = next
    ? Math.ceil((Date.parse(next + "T00:00:00Z") - now.getTime()) / 86400000)
    : null;
  if (epsDays != null && epsDays >= 0 && epsDays <= 3) {
    return {
      verdict: "No",
      window: null,
      reason: `Earnings in ${epsDays}d — wait for results; intraday timing irrelevant against an event-day gap.`,
    };
  }
  if (epsDays != null && epsDays >= 4 && epsDays <= 7) {
    return {
      verdict: "Soft-no",
      window: "closing-vwap",
      reason: `Earnings in ${epsDays}d — let positioning settle; if acting, closing VWAP dampens single-print impact.`,
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
      reason: "Recent analyst PT cut — let the re-rating settle; target closing VWAP if acting.",
    };
  }

  // 5. Momentum-based windows.
  const ret1m = num((ov.returns_pct || {})["1M"], 0);
  if (ret1m > 15 && TRIM_OR_EXIT_ACTIONS.has(action)) {
    return {
      verdict: "Soft-no",
      window: "closing-vwap",
      reason: `1M return +${ret1m.toFixed(1)}% — overshot; deferring trim to closing VWAP avoids selling into a parabolic print.`,
    };
  }
  if (ret1m < -15) {
    if (TOPUP_ACTIONS.has(action)) {
      return {
        verdict: "Yes",
        window: "mid-morning",
        reason: `1M return ${ret1m.toFixed(1)}% — averaging window; mid-morning (10:30-12:00) avoids open volatility while liquidity is still deep.`,
      };
    }
    if (TRIM_OR_EXIT_ACTIONS.has(action)) {
      return {
        verdict: "Yes-not-urgent",
        window: "post-lunch",
        reason: `1M return ${ret1m.toFixed(1)}% — avoid panic exit at the open; post-lunch (13:30-14:30) intraday stability is better.`,
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
      reason: "Severe macro regime against your sector — scale out via closing VWAP, not market orders.",
    };
  }

  // 7. Default — clean of catalyst, momentum, and macro shocks.
  return {
    verdict: "Yes",
    window: "mid-morning",
    reason: "No proximate catalyst or volatility shock — standard mid-morning window (10:30-12:00) for a balance of liquidity and stability.",
  };
}
