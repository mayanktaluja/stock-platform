/**
 * Format a watchlist-matched headline into a Telegram alert (NEWS class).
 *
 * Pure/deterministic — no network, no env. `headline` is a row from
 * fetchMacroHeadlines: { title, source, publishedAt, url }. `match` is the
 * watchlistGate result: { symbols:[], sectors:[] }.
 *
 * NEWS alerts are routine (not breaking) in Phase 1–2: there's no per-headline
 * severity until the LLM-triage funnel (P4), so they ride as silent push and
 * obey quiet hours. The dedup `key` is the ledger identity.
 */

import { escapeHtml } from "./telegramSender.js";
import { ledgerKey } from "./sentLedger.js";

const PROD_URL = "https://starbhai-stock-platform.vercel.app";

export function formatNewsAlert(headline, match) {
  const title = String(headline?.title || "").trim();
  const symbols = Array.isArray(match?.symbols) ? match.symbols.filter(Boolean) : [];
  if (!title || !symbols.length) return null;

  const tags = symbols.map((s) => `<code>${escapeHtml(s)}</code>`).join(" ");
  const source = headline.source ? ` · ${escapeHtml(String(headline.source))}` : "";
  const lines = [`📰 ${tags}${source}`, escapeHtml(title.slice(0, 240))];

  const url = headline.url && /^https?:\/\//.test(headline.url) ? headline.url : null;
  const buttons = [];
  if (url) buttons.push({ text: "📰 Source", url });
  buttons.push({ text: "📊 Open platform", url: `${PROD_URL}/?t=${encodeURIComponent(symbols[0])}` });

  // Dedup identity: the symbol set + a normalized title (so the same story from
  // two wires collapses to one alert within the ledger TTL window).
  const normTitle = title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
  const key = ledgerKey(["news", symbols.slice().sort().join(","), normTitle]);

  return { text: lines.join("\n"), breaking: false, key, buttons, symbols };
}
