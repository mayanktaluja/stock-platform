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

  const { compiledWatchlist, macroGate, noiseGate, marketGate, loudGate } = deps;

  // Mute filter: drop disaster/weather spam (earthquake/tsunami/…) before it can
  // become an alert.
  if (noiseGate && typeof noiseGate.match === "function" && noiseGate.match(text)) return null;

  const category = String(message?.category || "");
  const channel = String(message?.channel || "");

  const watchlistHit = matchHeadline(text, compiledWatchlist) || { matched: false };
  const macroResult = (macroGate && typeof macroGate.match === "function")
    ? macroGate.match(text)
    : { matched: false, hits: [] };

  // Relevance gate: only forward news that relates to a stock or moves the
  // market — a watchlist ticker, a macro-breaking keyword, OR a market keyword.
  // Everything else (general/crime/weather/celebrity) is dropped. (When no
  // marketGate is injected, matchMarket fails open so tests/callers still work.)
  const hasMarketGate = marketGate && typeof marketGate.match === "function";
  const marketRelevant = !hasMarketGate // no gate injected → don't filter (fail-open)
    || Boolean(watchlistHit.matched)
    || Boolean(macroResult?.matched)
    || marketGate.match(text);
  if (!marketRelevant) return null;

  // A big macro headline OR one about the owner's own stock pings loud.
  //
  // When a `loudGate` is injected, loudness becomes severity+intensity aware:
  // a broad keyword like "trump" or "nifty" no longer pings on its own, while
  // war/crash/rate-decision always do and a watchlist ticker always does. Absent
  // the dep, behaviour is EXACTLY as before (backwards compatible — the existing
  // callers and specs keep today's semantics). `breaking` drives the 🔴 prefix,
  // the loud notification, and the IMPORTANT cross-post, so gating it here gates
  // all three at once. Non-loud messages still post SILENTLY to their topic.
  let breaking;
  let impact = null;
  let severity = null;
  if (loudGate && typeof loudGate.decide === "function") {
    const d = loudGate.decide({
      text,
      macroHits: macroResult?.hits || [],
      macroHit: Boolean(macroResult?.matched),
      watchlistHit: Boolean(watchlistHit.matched),
      symbols: Array.isArray(watchlistHit.symbols) ? watchlistHit.symbols : [],
      category,
    }) || {};
    breaking = Boolean(d.loud);
    impact = Number.isFinite(d.impact) ? d.impact : null;
    severity = d.tier ?? null;
  } else {
    breaking = Boolean(macroResult?.matched) || Boolean(watchlistHit.matched);
  }

  const tags = watchlistHit.matched ? ["⭐"] : [];
  const symbols = Array.isArray(watchlistHit.symbols) ? watchlistHit.symbols : [];

  const headLabel = channel || category;
  const body = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  // 🔴 marks breaking (loud); ⭐ marks a watchlist hit. (Bot API has no DND
  // override — loudness is disable_notification; these prefixes are the visual cue.)
  const prefix = `${breaking ? "🔴 " : ""}${tags.join("")}`.trim();
  const head = prefix ? `${prefix} <b>${escapeHtml(headLabel)}</b>` : `<b>${escapeHtml(headLabel)}</b>`;
  const lines = [head, escapeHtml(body)];
  if (symbols.length) lines.push(`<i>${symbols.map(escapeHtml).join(" · ")}</i>`);

  const url = message?.link && /^https?:\/\//.test(message.link) ? message.link : null;
  const buttons = url ? [{ text: "🔗 Source", url }] : [];

  // Channel-agnostic dedup identity: the FULL normalized text participates (not a
  // prefix) so the same wire on multiple channels collapses to one alert, while
  // two genuinely-different headlines sharing a long prefix do NOT false-collapse
  // (adversarial M1). ledgerKey sha256s, so length is free.
  const normTitle = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = ledgerKey(["router", normTitle]);

  return { topic: category, breaking, text: lines.join("\n"), key, buttons, tags, symbols, impact, severity };
}
