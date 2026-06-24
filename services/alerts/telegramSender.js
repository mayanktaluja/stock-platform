/**
 * Telegram Bot API sender — the one HTTP send for the alert pipeline.
 *
 * Pure-fetch, no SDK: runs unchanged on a local Mac cron and on Vercel. Mirrors
 * the resendMailer posture — pure payload builders are exported for unit tests,
 * the network send self-skips when alertsState() is disabled and never throws
 * into the caller (an alert must never unwind the macro refresh).
 *
 * parse_mode=HTML (easier escaping than MarkdownV2). Link previews disabled so
 * alerts stay compact. 429 responses honor Telegram's retry_after.
 */

import { alertsState, botToken, chatId } from "./alertsState.js";

const API_BASE = "https://api.telegram.org";

// Telegram sendMessage hard-rejects text > 4096 chars with a non-retryable 400.
// Truncate below that with margin for the ellipsis + any trailing tag.
const MAX_TEXT = 3900;

/** Escape the 3 characters Telegram HTML mode treats as markup. */
export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build the sendMessage request body. `text` is sent verbatim (callers escape
 * their own interpolations via escapeHtml); `buttons` is an optional flat list
 * of { text, url } rendered as a single inline-keyboard row.
 */
export function buildTelegramPayload({ text, breaking = false, buttons = [], messageThreadId } = {}, env = process.env) {
  if (!String(text || "").trim()) throw new Error("telegram payload requires non-empty text");
  const safeText = String(text).length > MAX_TEXT
    ? `${String(text).slice(0, MAX_TEXT - 1)}…`
    : String(text);
  const body = {
    chat_id: chatId(env),
    text: safeText,
    parse_mode: "HTML",
    // breaking = make a sound; routine = silent push (no DND-override exists in
    // the Bot API — loud-BREAKING via Pushover is a later phase).
    disable_notification: !breaking,
    link_preview_options: { is_disabled: true },
  };
  // Forum-topic routing: when set, the message lands in a specific topic thread
  // of a Topics-enabled group. Omitted → posts to the chat root (backward-compatible
  // with the P1/P2 DM bot).
  if (messageThreadId != null && String(messageThreadId).trim() !== "") {
    body.message_thread_id = Number(messageThreadId);
  }
  const row = (Array.isArray(buttons) ? buttons : [])
    .filter((b) => b && b.text && b.url)
    .map((b) => ({ text: String(b.text), url: String(b.url) }));
  if (row.length) body.reply_markup = { inline_keyboard: [row] };
  return body;
}

/**
 * Send a Telegram message.
 *   { ok: true, skipped: false, result }                 — delivered
 *   { ok: true, skipped: true, reason }                  — self-skipped (not configured / dry-run)
 *   { ok: false, skipped: false, reason, status }        — API rejected (caught, not thrown)
 *
 * `fetchImpl` is injectable for tests. `maxRetries` bounds 429 backoff so a
 * throttled API can't wedge the cron.
 */
export async function sendTelegram(message, { env = process.env, dryRun = false, fetchImpl = fetch, maxRetries = 2, sleep } = {}) {
  const state = alertsState(env);
  if (!state.enabled) return { ok: true, skipped: true, reason: state.reason };

  let payload;
  try {
    payload = buildTelegramPayload(message, env);
  } catch (err) {
    return { ok: false, skipped: false, reason: err.message, status: 0 };
  }

  if (dryRun) return { ok: true, skipped: true, reason: "dry_run", payload };

  const url = `${API_BASE}/bot${botToken(env)}/sendMessage`;
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Network error — transient; retry within budget, else give up cleanly.
      if (attempt < maxRetries) { await wait(1000); continue; }
      return { ok: false, skipped: false, reason: `network: ${err.message}`, status: 0 };
    }

    if (res.status === 429) {
      let retryAfter = 1;
      try { retryAfter = (await res.json())?.parameters?.retry_after ?? 1; } catch { /* keep default */ }
      if (attempt < maxRetries) { await wait(retryAfter * 1000); continue; }
      return { ok: false, skipped: false, reason: "rate_limited", status: 429 };
    }

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json())?.description || ""; } catch { /* ignore */ }
      return { ok: false, skipped: false, reason: `telegram_${res.status}${detail ? `: ${detail}` : ""}`, status: res.status };
    }

    let result = null;
    try { result = await res.json(); } catch { /* body optional */ }
    return { ok: true, skipped: false, result };
  }

  return { ok: false, skipped: false, reason: "exhausted_retries", status: 429 };
}
