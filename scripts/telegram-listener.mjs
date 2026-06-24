#!/usr/bin/env node
/**
 * Phase-3b real-time news router (GramJS / MTProto).
 *
 * Persistent user-session client that subscribes to the channels in
 * data/alerts/news-sources.json and routes EVERY message (coverage-first — no
 * watchlist gate) into the matching category topic of the delivery group,
 * deduped cross-channel, ⭐ on watchlist hits, 🔴 (loud) on macro keywords.
 *
 *   channel message → newsRouter.routeMessage → markIfNew (dedup) →
 *     throttle queue (≤ ~1 msg/s into the group) → dispatch(chatId=group, thread)
 *
 * Hardened per adversarial review:
 *  - C1: topic messages target the GROUP (alert.chatId), not the DM.
 *  - C2: the GramJS import is guarded → dormant-exit 0 if the dep is missing.
 *  - H1: a throttle queue paces sends under the Bot API per-chat limit so a
 *        firehose can't 429-drop messages.
 *  - M2: category comes from a channel-id map (no "markets" misroute default).
 *  - M3: atomic markIfNew dedup (no hasKey/recordSent race between two writers).
 *  - L2: a thread-not-found send retries once at the group root.
 *
 * Coverage-first: no quiet-hours drop — non-breaking posts SILENTLY into its
 * topic (disable_notification); the user mutes topics natively to tune volume.
 *
 * Dormant-safe (KeepAlive SuccessfulExit:false → no hot-loop): exits 0 with a
 * reason when api creds / TG_SESSION / channels / GramJS are missing.
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
const { markIfNew } = await import("../services/alerts/sentLedger.js");
const { dispatch } = await import("../services/alerts/alertDispatcher.js");
const { ensureTopics } = await import("../services/alerts/topicManager.js");
const { createThrottleQueue } = await import("../services/alerts/throttleQueue.js");

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

const categories = [...new Set(sources.map((c) => c.category))];
const compiledWatchlist = compileWatchlist(loadJson("data/alerts/watchlist.json") || {});
const macroCompiled = compileMacroGate();
const macroGate = { match: (t) => matchMacro(t, macroCompiled) };

// GramJS import guarded (C2): a missing dep dormant-exits 0 (no KeepAlive hot-loop).
let TelegramClient; let StringSession; let NewMessage;
try {
  ({ TelegramClient } = await import("telegram"));
  ({ StringSession } = await import("telegram/sessions/index.js"));
  ({ NewMessage } = await import("telegram/events/index.js"));
} catch (err) {
  dormant(`GramJS (telegram) not installed: ${err?.message || err}`);
}

const queue = createThrottleQueue({ minGapMs: 1100 }); // ~1 msg/s into the one group
let topicState = { groupId: null, topics: {} };
const idToSource = new Map(); // channel id (string) → { category, name }

async function sendWithFallback(alert) {
  const res = await dispatch(alert);
  // L2: a stale/invalid topic thread → retry once at the group root.
  if (!res.ok && alert.messageThreadId != null && /thread|topic/i.test(res.reason || "")) {
    await dispatch({ ...alert, messageThreadId: undefined });
  }
}

async function handleMessage(event) {
  try {
    const msg = event.message;
    const text = msg?.message || "";
    if (!text.trim()) return;

    const cid = String(event.chatId ?? msg?.chatId ?? "");
    const src = idToSource.get(cid);
    if (!src) return; // unknown channel → skip rather than misroute (M2)

    const link = src.username ? `https://t.me/${src.username}/${msg.id}` : null;
    const date = msg?.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();

    const alert = routeMessage(
      { text, channel: src.name, category: src.category, link, date },
      { compiledWatchlist, macroGate },
    );
    if (!alert) return;

    // Atomic dedup at receipt (M3) — collapses the same wire arriving on several
    // channels near-simultaneously before either is sent.
    if (!markIfNew(alert.key).fresh) return;

    // Route to the GROUP topic (C1) when topics are ready; else DM root fallback.
    const threadId = topicState.topics?.[alert.topic];
    if (topicState.groupId && threadId != null) {
      alert.chatId = topicState.groupId;
      alert.messageThreadId = threadId;
    }
    queue.enqueue(() => sendWithFallback(alert));
  } catch (err) {
    console.warn(`[tg-router] handler error (swallowed): ${err?.message || err}`);
  }
}

async function main() {
  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  if (!(await client.checkAuthorization())) dormant("session not authorized — regenerate TG_SESSION");

  // Ensure a topic per category (bot admin in a Topics group + TG_GROUP_ID).
  // If not ready, run anyway and post to the chat root so nothing is lost.
  try {
    const t = await ensureTopics(categories, { env: process.env });
    if (t.ready) { topicState = { groupId: t.groupId, topics: t.topics }; console.log(`[tg-router] topics ready (${Object.keys(t.topics).length}) group=${t.groupId}`); }
    else console.warn(`[tg-router] topics not ready (${t.reason}) — posting to chat root until configured`);
  } catch (e) { console.warn(`[tg-router] ensureTopics failed (${e?.message}) — posting to chat root`); }

  // Resolve each enabled channel to its entity; map its id → category (M2). The
  // session account must have JOINED the channel or getEntity throws (skip it).
  const resolved = [];
  for (const c of sources) {
    try {
      const ent = await client.getEntity(c.slug);
      resolved.push(ent);
      idToSource.set(String(ent.id), { category: c.category, name: c.name || c.slug, username: ent.username || c.slug });
    } catch (e) {
      console.warn(`[tg-router] cannot resolve ${c.slug} (join it with the session account?): ${e?.message || e}`);
    }
  }
  if (!resolved.length) dormant("none of the configured channels could be resolved");

  client.addEventHandler(handleMessage, new NewMessage({ chats: resolved }));
  console.log(`[tg-router] live — ${resolved.length} channel(s), categories: ${categories.join(", ")}`);
  setInterval(() => console.log(`[tg-router] heartbeat ${new Date().toISOString()} queue=${queue.size()} dropped=${queue.dropped()}`), 30 * 60 * 1000);
}

main().catch((err) => {
  console.error(`[tg-router] fatal: ${err?.message || err}`);
  process.exit(1);
});
