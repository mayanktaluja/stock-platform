/**
 * Alerts config gate — mirrors services/resendMailer.js::mailerState().
 *
 * The whole alert pipeline self-skips (never throws, never crashes the cron)
 * when Telegram isn't configured. A fresh checkout, a launchd run that didn't
 * `source .env`, or a deliberate kill-switch all resolve to
 * `{ enabled: false, reason }` — callers log the reason and move on.
 *
 * Secrets live in .env (gitignored) only:
 *   TG_BOT_TOKEN   bot token from @BotFather
 *   TG_CHAT_ID     destination chat id (owner DM)
 *   ALERTS_ENABLED 0 to hard-disable (kill switch), unset/1 = on
 */

export function boolFlag(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export function botToken(env = process.env) {
  return String(env.TG_BOT_TOKEN || "").trim();
}

export function chatId(env = process.env) {
  return String(env.TG_CHAT_ID || "").trim();
}

/**
 * Resolve whether alerts can be sent.
 *   { enabled: true, reason: null }                  — ready
 *   { enabled: false, reason: "<why>" }              — self-skip
 */
export function alertsState(env = process.env) {
  if (env.ALERTS_ENABLED === "0") return { enabled: false, reason: "ALERTS_ENABLED=0" };
  if (!botToken(env)) return { enabled: false, reason: "TG_BOT_TOKEN missing" };
  if (!chatId(env)) return { enabled: false, reason: "TG_CHAT_ID missing" };
  return { enabled: true, reason: null };
}
