/**
 * Phase 3 — turn a Telegram-channel message into a NEWS-class alert.
 *
 * Pure glue: adapts a channel message to the same shape the RSS poller uses,
 * then reuses the exact watchlist gate + alert formatter from Phase 2. So a
 * channel post about a watchlist ticker dedups against the same ledger as the
 * RSS path (same NEWS class, same key scheme) — a story that breaks on a
 * channel AND a wire alerts once, not twice.
 *
 * No network, no env — testable in isolation. The listener (scripts/
 * telegram-listener.mjs) owns the GramJS connection and calls this per message.
 */

import { matchHeadline } from "./watchlistGate.js";
import { formatNewsAlert } from "./newsAlert.js";

/**
 * message = { text, channel?, link?, date? }
 * compiled = compileWatchlist(...) result
 * Returns a formatted alert ({text, breaking, key, buttons, symbols}) or null
 * when the message is empty or mentions no watchlist ticker.
 */
export function channelAlertFor(message, compiled) {
  const text = String(message?.text || "").trim();
  if (!text) return null;

  const m = matchHeadline(text, compiled);
  if (!m.matched) return null;

  // Channel messages are often multi-line; the formatter trims to a sane
  // length. Source = channel name so the alert says where it came from.
  return formatNewsAlert(
    {
      title: text.replace(/\s+/g, " ").trim(),
      source: message.channel ? `TG: ${message.channel}` : "Telegram",
      url: message.link || null,
      publishedAt: message.date || null,
    },
    m,
  );
}
