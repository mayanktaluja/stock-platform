/**
 * Route one incoming channel message into a categorized Telegram alert.
 *
 * Pure/deterministic — no network, no env, no macro import. The macro matcher
 * is INJECTED (`deps.macroGate`) so the listener wires the real gate and tests
 * pass a fake. `message` is one wire off a subscribed channel:
 *   { text, channel, category, link, date }
 * where `category` is the Telegram topic name the listener maps to a thread id.
 *
 * Coverage-first posture: unlike the watchlist NEWS class, the router does NOT
 * filter to the watchlist — it forwards every non-empty message, tags watchlist
 * hits with ⭐, and marks macro hits as breaking (loud). The dedup `key` is
 * deliberately CHANNEL-AGNOSTIC: the same wire arriving on several channels
 * collapses to one alert through the sent ledger.
 */

import { escapeHtml } from "./telegramSender.js";
import { ledgerKey } from "./sentLedger.js";
import { matchHeadline } from "./watchlistGate.js";

const MAX_TEXT = 350;

export function routeMessage(message, deps = {}) {
  const text = String(message?.text || "").trim();
  if (!text) return null;

  const { compiledWatchlist, macroGate } = deps;
  const category = String(message?.category || "");
  const channel = String(message?.channel || "");

  const watchlistHit = matchHeadline(text, compiledWatchlist) || { matched: false };
  const macroResult = (macroGate && typeof macroGate.match === "function")
    ? macroGate.match(text)
    : { matched: false, hits: [] };

  // A big macro headline OR one about the owner's own stock pings loud.
  const breaking = Boolean(macroResult?.matched) || Boolean(watchlistHit.matched);

  const tags = watchlistHit.matched ? ["⭐"] : [];
  const symbols = Array.isArray(watchlistHit.symbols) ? watchlistHit.symbols : [];

  const headLabel = channel || category;
  const body = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  const lines = [`${tags.join("")} <b>${escapeHtml(headLabel)}</b>`, escapeHtml(body)];
  if (symbols.length) lines.push(`<i>${symbols.map(escapeHtml).join(" · ")}</i>`);

  const url = message?.link && /^https?:\/\//.test(message.link) ? message.link : null;
  const buttons = url ? [{ text: "🔗 Source", url }] : [];

  // Channel-agnostic dedup identity: only the normalized title participates, so
  // the same wire on multiple channels collapses to one alert in the ledger.
  const normTitle = text.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
  const key = ledgerKey(["router", normTitle]);

  return { topic: category, breaking, text: lines.join("\n"), key, buttons, tags, symbols };
}
