/**
 * portfolioEarningsSection.js
 *
 * Selects the "upcoming results in your portfolio" rows for the daily
 * SWS-input-alert email. Pure: no I/O, no clock reads except the injected
 * `nowMs`, no imports from server.js.
 *
 * The caller passes an ALREADY-NORMALIZED snapshot — i.e. the output of
 * `normalizeEarningsSnapshot(recomputeDaysUntil(loadEarningsSnapshot()))`.
 * Reading the raw file instead would leave `days_until` baked at `built_at`
 * (up to ~12h stale) and past events still sitting in `events[]`.
 *
 * Scope is deliberately narrow. The email carries symbol / company / date /
 * verdict / confidence / a 3-branch guidance tree — and NOT price bands,
 * position sizing, or entry/stoploss/target strings. The email footer asserts
 * "This email contains no buy/sell instruction"; shipping ₹ targets and a size
 * multiplier would make that line false. Tactical detail stays behind a click
 * in the Earnings Watch tab.
 *
 * Guidance (RAISE/MAINTAIN/CUT) is NOT predicted — reactionPlaybook.js:232-243
 * is explicit that it's unknowable until the concall. So we render all three
 * branches as a decision tree rather than naming one "primary" setup.
 */

import { canonicalSwsTicker } from "../swsInputSnapshot.js";

export const EARNINGS_EMAIL_SECTION_VERSION = "earnings-email-section-v1-2026-07";

/** Events reporting within this many days land in the email. */
export const DEFAULT_MAX_DAYS = 7;

/**
 * earnings-watch-latest.json is baked into the immutable Vercel deployment at
 * build time. If the local refresh job (or its auto-merge PR) stalls, the file
 * silently ages. Past this bound we suppress the section rather than imply a
 * calendar we can no longer vouch for.
 */
export const DEFAULT_MAX_STALENESS_MS = 72 * 60 * 60 * 1000;

const GUIDANCE_ORDER = Object.freeze(["RAISE", "MAINTAIN", "CUT"]);

export const VERDICT_LABELS = Object.freeze({
  BEAT: "BEAT",
  INLINE: "INLINE",
  MISS: "MISS",
  INSUFFICIENT_DATA: "Insufficient data",
});

/**
 * Render `days_until` as words, never as a bare number.
 *
 * escapeHtml() in swsPortfolioInputAlerts.js is `String(s || "")`, so
 * `escapeHtml(0) === ""` — a `days_until: 0` row (the single most valuable row
 * in this feature: "reports today") would render as a blank cell. Formatting to
 * a non-empty string here sidesteps the coercion entirely.
 */
export function formatDaysUntil(days) {
  if (!Number.isFinite(days)) return "—";
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `in ${days} days`;
}

/** `confidence_pct` is null for INSUFFICIENT_DATA. Never render "null%". */
export function formatConfidence(pct) {
  return Number.isFinite(pct) ? `${pct}%` : "—";
}

/**
 * True only for a pre-result playbook that actually carries the three branches.
 *
 * Two shapes must be rejected:
 *   - INSUFFICIENT_DATA (reactionPlaybook.js:249-258) returns six keys with
 *     `tradable: false`, `primary: null`, `branches: []`, and NO
 *     `position_size_tier`. Touching `.position_size_tier.label` throws.
 *   - mode "t1" carries `plan`/`cell_key` and no `branches` at all. Unreachable
 *     today, but predictionFreeze.js:153 swaps an ARCHIVED playbook into every
 *     `days_until === 0` row, so schema drift is a matter of time.
 */
export function isPreviewPlaybook(playbook) {
  return (
    playbook?.mode === "preview" &&
    playbook?.tradable === true &&
    Array.isArray(playbook?.branches)
  );
}

/**
 * "RAISE → Beat + Raise (strongest) · MAINTAIN → … · CUT → …"
 *
 * Returns "" unless all three guidance branches are present — a partial tree
 * would read as a guidance call by omission. Cell labels only; the plan's
 * entry/stoploss/target strings are trade instructions and stay out of email.
 */
export function formatBranchTree(playbook) {
  if (!isPreviewPlaybook(playbook)) return "";
  const byGuidance = new Map();
  for (const branch of playbook.branches) {
    const guidance = String(branch?.guidance || "").toUpperCase();
    const label = String(branch?.plan?.label || "").trim();
    if (GUIDANCE_ORDER.includes(guidance) && label) byGuidance.set(guidance, label);
  }
  if (byGuidance.size !== GUIDANCE_ORDER.length) return "";
  return GUIDANCE_ORDER.map((g) => `${g} → ${byGuidance.get(g)}`).join(" · ");
}

/**
 * Copy scalars out of the event. Never retain `playbook` / `price_band` /
 * `signals` objects — predictionFreeze.js:144-155 hands those out BY REFERENCE
 * from a module-scope cache whose lifetime is the whole lambda container.
 */
function toRow(event) {
  const prediction = event?.prediction || {};
  const symbol = canonicalSwsTicker(event?.symbol);
  const confidencePct = Number.isFinite(prediction.confidence_pct)
    ? prediction.confidence_pct
    : null;
  const verdict = typeof prediction.verdict === "string" && prediction.verdict
    ? prediction.verdict
    : "INSUFFICIENT_DATA";
  return {
    symbol,
    company: String(event?.company || "").trim() || symbol,
    event_iso_date: typeof event?.event_iso_date === "string" ? event.event_iso_date : "",
    days_until: event.days_until,
    days_until_label: formatDaysUntil(event.days_until),
    fiscal_quarter: String(event?.fiscal_quarter || "").trim() || "—",
    verdict,
    verdict_label: VERDICT_LABELS[verdict] || VERDICT_LABELS.INSUFFICIENT_DATA,
    confidence_pct: confidencePct,
    confidence_label: formatConfidence(confidencePct),
    branch_tree: formatBranchTree(event?.playbook),
  };
}

/**
 * Join a user's held tickers against the upcoming-earnings window.
 *
 * @param {object} snapshot     normalized earnings snapshot
 * @param {Iterable<string>} heldTickers  bare or .NS/.BO-suffixed; unfiltered
 *                                        (zero-qty positions included)
 * @returns {{rows: object[], suppressed_reason: null|"missing"|"stale"}}
 *
 * `suppressed_reason` is surfaced to the cron response. Returning a bare `[]`
 * for a stalled refresh would be indistinguishable from "you hold nothing that
 * reports this week" — the failure has to be observable.
 */
export function buildPortfolioEarningsRows(snapshot, heldTickers, opts = {}) {
  const {
    nowMs = Date.now(),
    maxDays = DEFAULT_MAX_DAYS,
    maxStalenessMs = DEFAULT_MAX_STALENESS_MS,
  } = opts;

  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    snapshot._missing === true ||
    !Array.isArray(snapshot.events)
  ) {
    return { rows: [], suppressed_reason: "missing" };
  }

  // Fail CLOSED on an unparseable built_at. `Date.parse(null)` is NaN, and
  // `NaN > maxStalenessMs` is false — a naive comparison would let a corrupt
  // snapshot through as "fresh".
  const builtAtMs = Date.parse(snapshot.built_at);
  if (!Number.isFinite(builtAtMs) || nowMs - builtAtMs > maxStalenessMs) {
    return { rows: [], suppressed_reason: "stale" };
  }

  const held = new Set();
  for (const ticker of heldTickers || []) {
    const canonical = canonicalSwsTicker(ticker);
    if (canonical) held.add(canonical);
  }
  if (held.size === 0) return { rows: [], suppressed_reason: null };

  const rows = snapshot.events
    // normalizeEarningsSnapshot keeps rows whose days_until is non-numeric
    // (earningsWatchService.js:208). They must not reach the sort comparator —
    // `undefined - 3` is NaN and the resulting order is implementation-defined.
    .filter(
      (e) =>
        Number.isFinite(e?.days_until) && e.days_until >= 0 && e.days_until <= maxDays,
    )
    .filter((e) => held.has(canonicalSwsTicker(e?.symbol)))
    .map(toRow)
    .sort((a, b) => a.days_until - b.days_until || a.symbol.localeCompare(b.symbol));

  return { rows, suppressed_reason: null };
}
