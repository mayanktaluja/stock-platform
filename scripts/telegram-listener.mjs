#!/usr/bin/env node
/**
 * Phase-3b real-time news router (GramJS / MTProto).
 *
 * Persistent user-session client that subscribes to the channels in
 * data/alerts/news-sources.json, and for EVERY message (coverage-first — no
 * watchlist gate) routes it into the matching category topic of the delivery
 * group, deduped cross-channel, with ⭐ on watchlist hits and 🔴 (loud) on
 * high-impact macro keywords.
 *
 *   channel message --> newsRouter.routeMessage --> dedup(hasKey) -->
 *     dispatch(messageThreadId = topic-map[category]) --> recordSent
 *
 * Coverage-first means we do NOT suppress non-breaking messages overnight — they
 * post SILENTLY into their topic (disable_notification handles loud/quiet); the
 * user mutes topics natively to tune volume. The cross-channel dedup key is
 * channel-agnostic, so the same wire seen on N channels posts once.
 *
 * Dormant-safe: exits 0 with a logged reason when api creds / TG_SESSION /
 * channels are missing. KeepAlive plist uses SuccessfulExit:false so a clean
 * dormant exit never hot-loops. Generate TG_SESSION via telegram-session-login.mjs.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(REPO_ROOT, ".env"), override: false });

const { compileWatchlist } = await import("../services/alerts/watchlistGate.js");
const { compileMacroGate, matchMacro } = await import("../services/alerts/macroBreakingGate.js");
const { routeMessage } = await import("../services/alerts/newsRouter.js");
const { hasKey, recordSent } = await import("../services/alerts/sentLedger.js");
const { dispatch } = await import("../services/alerts/alertDispatcher.js");
const { ensureTopics } = await import("../services/alerts/topicManager.js");

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const sessionStr = process.env.TG_SESSION || "";

function loadJson(rel) {
  try { return JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf-8")); }
  catch { return null; }
}
function dormant(reason) {
  console.log(`[tg-router] dormant — ${reason}. Exiting 0.`);
  process.exit(0);
}

if (!apiId || !apiHash) dormant("TG_API_ID/TG_API_HASH missing (my.telegram.org)");
if (!sessionStr) dormant("TG_SESSION missing — run scripts/telegram-session-login.mjs");

const sourcesCfg = loadJson("data/alerts/news-sources.json") || { channels: [] };
const sources = (sourcesCfg.channels || []).filter((c) => c && c.enabled !== false && c.slug && c.category);
if (!sources.length) dormant("no enabled channels in data/alerts/news-sources.json");

// slug (lowercased) -> { name, category } for fast lookup on each message.
const bySlug = new Map(sources.map((c) => [String(c.slug).toLowerCase(), { name: c.name || c.slug, category: c.category }]));
const categories = [...new Set(sources.map((c) => c.category))];

const compiledWatchlist = compileWatchlist(loadJson("data/alerts/watchlist.json") || {});
const macroCompiled = compileMacroGate();
const macroGate = { match: (t) => matchMacro(t, macroCompiled) };

const pkg = await import("telegram");
const { TelegramClient } = pkg;
const { StringSession } = await import("telegram/sessions/index.js");
const { NewMessage } = await import("telegram/events/index.js");

let topicMap = {}; // category -> message_thread_id (empty → posts to chat root)

async function handleMessage(event) {
  try {
    const msg = event.message;
    const text = msg?.message || "";
    if (!text.trim()) return;

    let username = null;
    let title = "channel";
    try { const chat = await msg.getChat(); username = chat?.username || null; title = chat?.title || title; }
    catch { /* best-effort */ }

    const src = username ? bySlug.get(String(username).toLowerCase()) : null;
    const category = src?.category || "markets"; // fallback bucket if we can't resolve
    const channelName = src?.name || title;
    const link = username ? `https://t.me/${username}/${msg.id}` : null;
    const date = msg?.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();

    const alert = routeMessage(
      { text, channel: channelName, category, link, date },
      { compiledWatchlist, macroGate },
    );
    if (!alert) return;

    if (hasKey(alert.key)) return; // cross-channel dedup
    alert.messageThreadId = topicMap[alert.topic]; // undefined → chat root (pre-group fallback)

    const res = await dispatch(alert);
    if (res.ok && !res.skipped) recordSent(alert.key);
  } catch (err) {
    console.warn(`[tg-router] handler error (swallowed): ${err?.message || err}`);
  }
}

async function main() {
  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  if (!(await client.checkAuthorization())) dormant("session not authorized — regenerate TG_SESSION");

  // Ensure a topic exists per category (needs the bot admin in a Topics group).
  // If not ready, we still run and post to the chat root so nothing is lost.
  try {
    const t = await ensureTopics(categories, { env: process.env });
    if (t.ready) { topicMap = t.topics; console.log(`[tg-router] topics ready (${Object.keys(topicMap).length}) group=${t.groupId}`); }
    else console.warn(`[tg-router] topics not ready (${t.reason}) — posting to chat root until configured`);
  } catch (e) { console.warn(`[tg-router] ensureTopics failed (${e?.message}) — posting to chat root`); }

  const resolved = [];
  for (const slug of bySlug.keys()) {
    try { resolved.push(await client.getInputEntity(slug)); }
    catch (e) { console.warn(`[tg-router] cannot resolve channel ${slug} (not subscribed?): ${e?.message || e}`); }
  }
  if (!resolved.length) dormant("none of the configured channels could be resolved (join them with the session account)");

  client.addEventHandler(handleMessage, new NewMessage({ chats: resolved }));
  console.log(`[tg-router] live — ${resolved.length} channel(s), categories: ${categories.join(", ")}`);
  setInterval(() => console.log(`[tg-router] heartbeat ${new Date().toISOString()}`), 30 * 60 * 1000);
}

main().catch((err) => {
  console.error(`[tg-router] fatal: ${err?.message || err}`);
  process.exit(1);
});
