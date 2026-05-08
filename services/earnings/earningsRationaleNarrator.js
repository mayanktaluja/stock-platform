/**
 * earningsRationaleNarrator.js
 *
 * Deterministic 3-paragraph narrative builder. Mirrors the structure
 * of services/swsReasonNarrator.js:69 buildReasonNarrative() so a
 * reviewer reading both feels at home.
 *
 * Why deterministic (no LLM): SEBI-RA discipline. Every word in the
 * rationale must trace back to a structured input the audit_trail
 * captures. An LLM call obscures provenance and introduces
 * non-reproducibility, so V1 stays string-template.
 *
 * Output shape:
 *   {
 *     headline: short single-line summary,
 *     paragraphs: [p1, p2, p3],
 *     falsification_triggers: [t1, t2, t3],
 *   }
 */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const NARRATOR_VERSION = "earnings-narrate-v1-2026-05";

/**
 * Build the narrative for one event-with-prediction.
 *
 * @param {{symbol, days_until, fiscal_quarter, signals, prediction, price_band}} event
 * @returns {{headline, paragraphs, falsification_triggers, version}}
 */
export function buildEarningsNarrative(event) {
  const pred = event?.prediction;
  const signals = event?.signals;
  const band = event?.price_band;

  if (!pred || pred.verdict === "INSUFFICIENT_DATA") {
    return {
      headline:
        signals?.data_quality === "LOW"
          ? "Calendar event only — insufficient signal coverage to predict outcome."
          : "Insufficient data to predict.",
      paragraphs: [
        signals?.data_quality === "LOW"
          ? "This stock isn't covered in the SWS deep-scrape, has no fundamentalsHistory entry, or both. We can confirm the board meeting is scheduled but cannot score directional risk."
          : "Required signals are missing.",
        "Watch the actual print for direction — we'll re-score the post-result T+1 playbook once outcome data lands.",
        "Position sizing should reflect this opacity: treat as a binary unknown, not a directional bet.",
      ],
      falsification_triggers: [],
      version: NARRATOR_VERSION,
    };
  }

  const verdict = pred.verdict;
  const conf = pred.confidence_pct;
  const fq = event.fiscal_quarter || "next quarter";
  const days = event.days_until;
  const daysStr = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days}d`;
  const sector = signals.sector || "?";
  const upcDays = num(signals.sws_upcoming_earnings?.composite_verdict);

  // ── Paragraph 1 — what we predict and the headline driver ──
  const top1 = pred.reasons_top?.[0];
  const top2 = pred.reasons_top?.[1];
  const verdictPhrase =
    verdict === "BEAT"
      ? "to BEAT"
      : verdict === "MISS"
        ? "to MISS"
        : "to land INLINE";
  const p1 =
    `${event.symbol} reports ${fq} ${daysStr}. ` +
    `Our model expects the result ${verdictPhrase}, with ${conf}% confidence (V1 cap is 65% — see methodology). ` +
    (top1
      ? `Strongest input: ${top1}${top2 ? `; reinforced by ${top2}.` : "."}`
      : "Multiple weak signals combine; no single dominant driver.");

  // ── Paragraph 2 — components in/against, plus M-D catalyst echo ──
  const allReasons = (pred.reasons_top || []).concat(pred.reasons_against || []);
  const opposing = pred.reasons_against?.[0];
  const score = num(pred.score_100);
  const scoreStr = score != null ? ` (${score.toFixed(0)}/100 composite)` : "";

  // Surface Milestone-D signals explicitly when they're material.
  // The reasons_top list usually already includes these via the
  // predictor's components_by_impact ranking, but a dedicated callout
  // makes them audit-readable rather than buried in a "; "-joined list.
  const annTop = signals.announcements?.top3?.[0];
  const annClass = annTop?.classification;
  const annCallout = annClass && !["OTHER", "SHAREHOLDER_MEET", "RESULT_INTIMATION", "DIVIDEND"].includes(annClass)
    ? ` Recent corporate filing flagged: ${annClass}.`
    : "";

  const dealFlow = signals.deals_7d;
  const dealCallout = (() => {
    if (!dealFlow) return "";
    const net = num(dealFlow.net_notional_inr);
    const mcap = num(signals.market_cap_inr);
    if (net == null || mcap == null || Math.abs(net) < 1e7 || mcap < 1e7) return "";
    const pctMcap = (net / mcap) * 100;
    if (Math.abs(pctMcap) < 0.05) return "";
    const direction = net >= 0 ? "accumulation" : "distribution";
    return ` Bulk/block flow shows institutional ${direction} (${pctMcap.toFixed(2)}% of market cap, last 7d).`;
  })();

  const p2 =
    `Component breakdown${scoreStr}: ` +
    (allReasons.length > 0
      ? `pulling toward ${verdict}: ${(pred.reasons_top || []).slice(0, 3).join("; ")}. `
      : "") +
    (opposing
      ? `Opposing signal: ${opposing}. `
      : verdict === "INLINE"
        ? "No strong opposing signal — INLINE reflects balanced inputs, not absent ones. "
        : "") +
    `Sector ${sector} momentum acts as the prevailing tide; treat any single-stock thesis as conditional on it not flipping mid-week.` +
    annCallout +
    dealCallout;

  // ── Paragraph 3 — price band + position sizing reminder ──
  let p3;
  if (band && band.anchored && band.bull && band.base && band.bear) {
    const bandStr = `Bull ₹${band.bull.price_inr} (${band.bull.pct >= 0 ? "+" : ""}${band.bull.pct}%) · ` +
                    `Base ₹${band.base.price_inr} · ` +
                    `Bear ₹${band.bear.price_inr} (${band.bear.pct >= 0 ? "+" : ""}${band.bear.pct}%)`;
    p3 =
      `1-day post-result band: ${bandStr}. ` +
      `Magnitudes are confidence-scaled and capped at ±${15}%. ` +
      `Earnings are binary events — size positions to survive a Bear-case print, not to maximise the Bull case.`;
  } else if (band && !band.anchored && band.bull) {
    p3 =
      `1-day post-result range: bull ${band.bull.pct >= 0 ? "+" : ""}${band.bull.pct}%, ` +
      `base ${band.base.pct >= 0 ? "+" : ""}${band.base.pct}%, ` +
      `bear ${band.bear.pct >= 0 ? "+" : ""}${band.bear.pct}% (no live price anchor — SWS row not present). ` +
      `Earnings are binary events — size to survive bear, not maximise bull.`;
  } else {
    p3 =
      `Price band unavailable. Treat the prediction as directional only; ` +
      `size positions to survive any one-day move and check the T+1 playbook once results print.`;
  }

  // ── Falsification triggers ──
  // Reuse SWS counter_thesis triggers when present; synthesize from the
  // verdict otherwise.
  const swsTriggers = signals.sws_upcoming_earnings?.counter_thesis?.falsification_trigger;
  let triggers;
  if (Array.isArray(swsTriggers) && swsTriggers.length > 0) {
    triggers = swsTriggers.slice(0, 3);
  } else {
    triggers = synthesiseFalsificationTriggers(verdict, signals);
  }

  return {
    headline:
      verdict === "INLINE"
        ? `INLINE expected (${conf}% conf) — ${event.symbol} ${fq} ${daysStr}.`
        : `${verdict} expected (${conf}% conf) — ${event.symbol} ${fq} ${daysStr}.`,
    paragraphs: [p1, p2, p3],
    falsification_triggers: triggers,
    version: NARRATOR_VERSION,
  };
}

/**
 * When SWS counter_thesis isn't present (MEDIUM tier), generate three
 * verdict-appropriate falsification triggers from the same shapes the
 * picks pipeline uses.
 */
function synthesiseFalsificationTriggers(verdict, signals) {
  const triggers = [];
  if (verdict === "BEAT") {
    triggers.push("Reported EPS or revenue YoY misses estimates by ≥ 5%");
    if (signals.momentum?.pre_runup_signal === "spike") {
      triggers.push("Stock fades >3% intraday despite a beat — confirms priced-in");
    } else {
      triggers.push("Guidance is maintained or cut despite the headline beat");
    }
    triggers.push("Concall flags margin compression or order-book softness");
  } else if (verdict === "MISS") {
    triggers.push("Reported EPS beats consensus by ≥ 5%");
    triggers.push("Guidance is RAISED on the concall regardless of the print");
    triggers.push("A material positive catalyst (large order, capex tailwind) hits the tape pre-print");
  } else {
    // INLINE
    triggers.push("Reported EPS or revenue surprises by ≥ 5% in either direction");
    triggers.push("Guidance is materially raised or cut");
    triggers.push("Pre-result block-deal flow flips heavily institutional in 48h before");
  }
  return triggers;
}

/**
 * Apply the narrator to every event in a calendar. Returns a new array.
 */
export function narrateCalendar(events) {
  if (!Array.isArray(events)) return [];
  return events.map((e) => ({ ...e, rationale: buildEarningsNarrative(e) }));
}
