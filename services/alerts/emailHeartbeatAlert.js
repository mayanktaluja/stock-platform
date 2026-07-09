/**
 * emailHeartbeatAlert.js
 *
 * Two pure helpers that make a silent SWS-portfolio-input-alert email outage
 * loud. No I/O, no clock reads except the injected `nowMs`. The dispatcher
 * (services/alerts/alertDispatcher.js) decides whether to actually send; these
 * only render / decide. Mirrors services/alerts/regimeAlert.js.
 *
 * Why this exists: the daily SWS-input-alert email has no schedule of its own —
 * it rides on the SWS nightly producing a NEW run_id and its post-deploy trigger
 * firing. On a stale/unchanged run_id every recipient is deduped
 * (server.js hasEmailSentForRun → counts.deduped) and counts.sent === 0,
 * SILENTLY. These two helpers surface that:
 *
 *   - formatEmailHeartbeat  — the in-trigger ping when a send that DID run
 *     delivered to nobody (deduped / artifact-not-email-eligible / send failure).
 *   - buildStalenessVerdict — the independent daily watchdog's decision, keyed on
 *     whether a FRESH run_id exists for today (run_id's IST calendar date), NOT
 *     `generated_at` build-age. Build-age cannot separate a healthy-but-late
 *     nightly from a real outage (a late-deploying healthy artifact and a
 *     stuck-pipeline artifact can be the same age at any fixed check time); the
 *     run_id's IST date can — a fresh nightly stamps a run_id whose IST date ==
 *     today, a stuck pipeline leaves yesterday's.
 *
 * Disclaimer is covered by the site-wide footer; none is inlined.
 */

import { escapeHtml } from "./telegramSender.js";

const PROD_URL = "https://starbhai-stock-platform.vercel.app";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** UTC epoch ms → IST calendar date string "YYYY-MM-DD" (null if not finite). */
export function istDateString(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The in-trigger heartbeat. Fires only when a real (non-dry) send reached the
 * route and delivered to nobody. Returns { text, breaking, key, buttons } or
 * null when `recipientCount > 0` (nothing wrong — caller skips).
 */
export function formatEmailHeartbeat({ runId, recipientCount, reason, counts } = {}) {
  const n = Number(recipientCount);
  if (Number.isFinite(n) && n > 0) return null;

  const deduped = Number(counts?.deduped);
  const why = reason
    ? String(reason)
    : Number.isFinite(deduped) && deduped > 0
      ? `all ${deduped} recipients deduped — run_id already mailed (no fresh SWS run)`
      : "no recipients";

  const lines = [
    "🚨 <b>SWS input-alert email: 0 delivered</b>",
    `run_id <code>${escapeHtml(runId || "<none>")}</code>`,
    escapeHtml(why),
    "<i>The daily portfolio email did not go out. Check the SWS nightly / run_id freshness.</i>",
  ];
  return {
    text: lines.join("\n"),
    breaking: true,
    key: `email-heartbeat:${runId || "none"}`,
    buttons: [{ text: "📊 Open platform", url: PROD_URL }],
  };
}

/**
 * The independent watchdog's verdict. `artifact` is the object returned by
 * loadMarketWideSwsInputChanges(). Stale (→ page) when no fresh SWS run exists
 * for today: run_id's IST calendar date is before today's, or run_id is missing
 * / unparseable. A fresh-run day still pending two_consecutive_full_runs
 * confirmation (artifact_email_eligible !== true) is deliberately NOT stale —
 * that's a legitimate no-mail-*yet* day, not an outage.
 */
export function buildStalenessVerdict(artifact, nowMs = Date.now()) {
  const runId = artifact?.run_id || null;
  const today = istDateString(nowMs);
  if (!runId) {
    return { stale: true, reason: "missing-run-id", run_id: null, run_id_ist_date: null, today_ist_date: today };
  }
  const runMs = Date.parse(runId);
  if (!Number.isFinite(runMs)) {
    return { stale: true, reason: "unparseable-run-id", run_id: runId, run_id_ist_date: null, today_ist_date: today };
  }
  const runDate = istDateString(runMs);
  if (runDate < today) {
    return { stale: true, reason: "no-fresh-run-today", run_id: runId, run_id_ist_date: runDate, today_ist_date: today };
  }
  return { stale: false, reason: null, run_id: runId, run_id_ist_date: runDate, today_ist_date: today };
}

/**
 * The watchdog alert body, built from a stale verdict. Returns null when the
 * verdict is not stale (caller skips).
 */
export function formatStalenessAlert(verdict) {
  if (!verdict || !verdict.stale) return null;
  const lines = [
    "🚨 <b>SWS input-alert email: no fresh run today</b>",
    `reason <code>${escapeHtml(verdict.reason || "?")}</code>`,
    `run_id <code>${escapeHtml(verdict.run_id || "<none>")}</code>` +
      ` (${escapeHtml(verdict.run_id_ist_date || "?")} IST) · today ${escapeHtml(verdict.today_ist_date || "?")}`,
    "<i>No SWS run_id for today — the daily portfolio email will not send. Check the nightly.</i>",
  ];
  return {
    text: lines.join("\n"),
    breaking: true,
    key: `email-heartbeat-stale:${verdict.run_id || "none"}`,
    buttons: [{ text: "📊 Open platform", url: PROD_URL }],
  };
}
