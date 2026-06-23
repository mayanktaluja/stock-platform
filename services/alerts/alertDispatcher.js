/**
 * Alert dispatcher — the single choke-point every alert source calls.
 *
 * v1 (Phase 1): state-gate → send. No dedup/quiet-hours here yet — the regime
 * path dedups upstream via the macro cron's ship-gate (only material regime
 * flips reach a dispatch). Phase 2 adds the sentLedger + quiet-hours/throttle
 * for the noisier watchlist-news class.
 *
 * Contract: **never throws** into the caller. An alert must never unwind the
 * macro refresh. All failures resolve to a logged `{ ok:false }`.
 */

import { alertsState } from "./alertsState.js";
import { sendTelegram } from "./telegramSender.js";

/**
 * Dispatch a pre-formatted alert.
 *   alert = { text, breaking?, buttons?, key? }
 * Returns the sendTelegram result, or a caught-error shape. Always resolves.
 */
export async function dispatch(alert, { env = process.env, dryRun = false, logger = console } = {}) {
  try {
    const state = alertsState(env);
    if (!state.enabled) {
      logger.warn?.(`[alert] skipped — ${state.reason}`);
      return { ok: true, skipped: true, reason: state.reason };
    }
    if (!alert || !String(alert.text || "").trim()) {
      logger.warn?.("[alert] skipped — empty alert text");
      return { ok: false, skipped: true, reason: "empty_alert" };
    }

    const res = await sendTelegram(
      { text: alert.text, breaking: !!alert.breaking, buttons: alert.buttons || [] },
      { env, dryRun },
    );

    if (res.ok && !res.skipped) {
      logger.log?.(`[alert] sent${alert.breaking ? " (breaking)" : ""}${alert.key ? ` key=${alert.key}` : ""}`);
    } else if (res.skipped) {
      logger.log?.(`[alert] not sent — ${res.reason}`);
    } else {
      // A loud, distinct line so a silently-not-sending alert is visible in the
      // cron log (adversarial M3).
      logger.warn?.(`[alert] send FAILED — ${res.reason} (status ${res.status ?? "?"})`);
    }
    return res;
  } catch (err) {
    logger.warn?.(`[alert] dispatch threw (swallowed): ${err.message}`);
    return { ok: false, skipped: false, reason: `threw: ${err.message}` };
  }
}
