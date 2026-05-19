// Promoter-pledge gate — auto-PASS candidates with high or rising
// promoter pledge. The blow-up risk on a 12% Anchor position dominates
// the strategy's downside math (see §4 of the plan), so we exclude
// rather than just penalise.
//
// Two input paths:
//   1. Structured pledge events: { symbol, event_date_iso,
//      pledge_pct_after, pledge_pct_before } from a future ingester.
//   2. Text-scan fallback: regex over NSE corporate-announcements
//      subject lines for "pledge|encumbrance|SAST.{0,3}31". Coarser,
//      but the only signal available until a structured ingester ships.

const HIGH_PLEDGE_PCT = 25;
const STEEP_INCREASE_PCT_POINTS = 10;
const WINDOW_DAYS = 90;
const PLEDGE_REGEX = /\b(pledge|pledged|encumbr|SAST[\s-]?31|invoked)\b/i;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function daysBetween(aIso, bIso) {
  const a = new Date(aIso);
  const b = new Date(bIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.floor((b - a) / 86_400_000);
}

// Structured path: returns FAIL if any event in last WINDOW_DAYS has
// pledge_pct_after ≥ HIGH_PLEDGE_PCT or delta ≥ STEEP_INCREASE_PCT_POINTS.
export function evaluatePledgeFromEvents({ symbol, events, now_iso }) {
  const reasons = [];
  const relevant = (Array.isArray(events) ? events : []).filter((e) => {
    if (!e || e.symbol !== symbol) return false;
    if (!e.event_date_iso) return false;
    const age = daysBetween(e.event_date_iso, now_iso);
    return age !== null && age >= 0 && age <= WINDOW_DAYS;
  });

  const high = relevant.find((e) => isFiniteNumber(e.pledge_pct_after) && e.pledge_pct_after >= HIGH_PLEDGE_PCT);
  if (high) {
    reasons.push(`pledge_${Math.round(high.pledge_pct_after)}pct_>=_${HIGH_PLEDGE_PCT}pct`);
  }

  const steep = relevant.find((e) => {
    if (!isFiniteNumber(e.pledge_pct_after) || !isFiniteNumber(e.pledge_pct_before)) return false;
    return e.pledge_pct_after - e.pledge_pct_before >= STEEP_INCREASE_PCT_POINTS;
  });
  if (steep) {
    const delta = steep.pledge_pct_after - steep.pledge_pct_before;
    reasons.push(`pledge_delta_${Math.round(delta)}pp_>=_${STEEP_INCREASE_PCT_POINTS}pp`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
    matched_events: relevant.length,
    source: "structured",
  };
}

// Text-scan fallback: returns FAIL on any pledge keyword hit in the
// symbol's recent NSE announcements. Coarser — flags both creations
// and releases as suspicious; releases are usually positive but warrant
// human review before deploying capital.
export function evaluatePledgeFromAnnouncements({ symbol, announcements, now_iso }) {
  const hits = (Array.isArray(announcements) ? announcements : []).filter((a) => {
    if (!a || a.symbol !== symbol) return false;
    if (!a.announced_at_iso) return false;
    const age = daysBetween(a.announced_at_iso, now_iso);
    if (age === null || age < 0 || age > WINDOW_DAYS) return false;
    const subject = String(a.subject || "");
    return PLEDGE_REGEX.test(subject);
  });

  return {
    pass: hits.length === 0,
    reasons: hits.length === 0 ? [] : [`pledge_keyword_hit_${hits.length}x_in_${WINDOW_DAYS}d`],
    matched_events: hits.length,
    source: "text_scan",
    sample_subjects: hits.slice(0, 3).map((h) => h.subject),
  };
}

// Orchestrator: structured wins when present; fallback otherwise.
export function evaluatePledge({ symbol, events, announcements, now_iso }) {
  if (Array.isArray(events) && events.length > 0) {
    return evaluatePledgeFromEvents({ symbol, events, now_iso });
  }
  if (Array.isArray(announcements) && announcements.length > 0) {
    return evaluatePledgeFromAnnouncements({ symbol, announcements, now_iso });
  }
  return { pass: true, reasons: [], matched_events: 0, source: "no_data" };
}

export const PLEDGE_GATE_CONFIG = Object.freeze({
  HIGH_PLEDGE_PCT,
  STEEP_INCREASE_PCT_POINTS,
  WINDOW_DAYS,
});
