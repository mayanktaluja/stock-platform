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
const { compileNoiseGate, matchNoise } = await import("../services/alerts/noiseFilter.js");
const { compileMarketGate, matchMarket } = await import("../services/alerts/marketRelevanceGate.js");
const { routeMessage } = await import("../services/alerts/newsRouter.js");
const { markIfNew } = await import("../services/alerts/sentLedger.js");
const { dispatch } = await import("../services/alerts/alertDispatcher.js");
const { ensureTopics } = await import("../services/alerts/topicManager.js");
const { createThrottleQueue } = await import("../services/alerts/throttleQueue.js");
// Parity with the mirror poller: severity-aware loudness + cross-channel near-dup
// collapse. Without these the listener would silently bypass the de-noise if this
// host ever became the live ingestion path.
const { makeLoudGate } = await import("../services/alerts/loudGate.js");
const { loadRecentStories, findNearDup, recordStory, normalizeTokens, DEFAULT_WINDOW_MS } =
  await import("../services/alerts/nearDupGate.js");

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
const noiseCompiled = compileNoiseGate((loadJson("data/alerts/mute-keywords.json") || {}).keywords || []);
const noiseGate = { match: (t) => matchNoise(t, noiseCompiled) };
const marketCompiled = compileMarketGate((loadJson("data/alerts/market-keywords.json") || {}).keywords || []);
const marketGate = { match: (t) => matchMarket(t, marketCompiled) };

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
// username (lowercased) → { name, category }. Routing is by username (skip if
// unknown — M2) rather than by channel id, which GramJS marks inconsistently.
const bySlug = new Map(sources.map((c) => [String(c.slug).toLowerCase(), { name: c.name || c.slug, category: c.category }]));

const loudGate = makeLoudGate();
// Rolling near-dup window, seeded from disk so a restart doesn't re-blast the
// stories the previous process already delivered.
let recentStories = loadRecentStories({});

async function sendWithFallback(alert, tokens) {
  const res = await dispatch(alert);
  // L2: a stale/invalid topic thread → retry once at the group root.
  if (!res.ok && alert.messageThreadId != null && /thread|topic/i.test(res.reason || "")) {
    await dispatch({ ...alert, messageThreadId: undefined });
  }
  // Record only after a confirmed delivery (never claim-before-send).
  if (res.ok && !res.skipped && tokens) {
    recordStory(alert.key, tokens);
    recentStories.push({ key: alert.key, ts: Date.now(), tokens });
  }
}

async function handleMessage(event) {
  try {
    const msg = event.message;
    const text = msg?.message || "";
    if (!text.trim()) return;

    let username = null; let chat = null;
    try { chat = await msg.getChat(); username = chat?.username || null; } catch { /* entity fetch best-effort */ }
    const src = username ? bySlug.get(String(username).toLowerCase()) : null;
    if (!src) return; // unknown channel → skip rather than misroute (M2)

    const link = username ? `https://t.me/${username}/${msg.id}` : null;
    const date = msg?.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();

    const alert = routeMessage(
      { text, channel: src.name, category: src.category, link, date },
      { compiledWatchlist, macroGate, noiseGate, marketGate, loudGate },
    );
    if (!alert) return;

    // Atomic dedup at receipt (M3) — collapses the same wire arriving on several
    // channels near-simultaneously before either is sent.
    if (!markIfNew(alert.key).fresh) return;

    // Cross-channel NEAR-dup collapse (reworded copies the exact-hash key misses).
    // Prune the window first, then compare. Fails open.
    const cutoff = Date.now() - DEFAULT_WINDOW_MS;
    recentStories = recentStories.filter((r) => r.ts >= cutoff);
    const tokens = normalizeTokens(text);
    if (findNearDup(tokens, recentStories).matched) return;

    // Route to the GROUP topic (C1) when topics are ready; else DM root fallback.
    const threadId = topicState.topics?.[alert.topic];
    if (topicState.groupId && threadId != null) {
      alert.chatId = topicState.groupId;
      alert.messageThreadId = threadId;
    }
    queue.enqueue(() => sendWithFallback(alert, tokens));

    // Cross-post BREAKING to the IMPORTANT priority group (separate, loud).
    const impGroup = process.env.TG_IMPORTANT_GROUP_ID;
    if (alert.breaking && impGroup && markIfNew(`imp:${alert.key}`).fresh) {
      queue.enqueue(() => dispatch({ text: alert.text, breaking: true, buttons: alert.buttons || [], chatId: impGroup }));
    }
  } catch (err) {
    console.warn(`[tg-router] handler error (swallowed): ${err?.message || err}`);
  }
}

async function main() {
  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 5 });
  // start() (not bare connect()) engages GramJS's update loop reliably. The
  // session is already authorized, so the auth callbacks below are never called.
  await client.start({
    phoneNumber: async () => { throw new Error("session expected to be authorized — regenerate TG_SESSION"); },
    password: async () => { throw new Error("session expected to be authorized"); },
    phoneCode: async () => { throw new Error("session expected to be authorized"); },
    onError: (e) => console.warn(`[tg-router] start error: ${e?.message || e}`),
  });
  if (!(await client.checkAuthorization())) dormant("session not authorized — regenerate TG_SESSION");

  // Warm the entity/dialog cache so getChat() resolves channel usernames.
  try { await client.getDialogs({ limit: 50 }); } catch (e) { console.warn(`[tg-router] getDialogs prime failed (non-fatal): ${e?.message}`); }

  // Ensure a topic per category (bot admin in a Topics group + TG_GROUP_ID).
  // If not ready, run anyway and post to the chat root so nothing is lost.
  try {
    const t = await ensureTopics(categories, { env: process.env });
    if (t.ready) { topicState = { groupId: t.groupId, topics: t.topics }; console.log(`[tg-router] topics ready (${Object.keys(t.topics).length}) group=${t.groupId}`); }
    else console.warn(`[tg-router] topics not ready (${t.reason}) — posting to chat root until configured`);
  } catch (e) { console.warn(`[tg-router] ensureTopics failed (${e?.message}) — posting to chat root`); }

  // Build the NewMessage filter from channel USERNAMES (strings). GramJS's
  // _intoIdSet re-resolves each `chats` entry via getInputEntity; passing entity
  // or InputPeer OBJECTS makes it stringify them to "[object Object]" and throw
  // on the first update — only usernames/ids resolve. We pre-resolve each slug
  // (so an un-joined channel is dropped + logged, not fatal) then pass the slug
  // strings that succeeded. The session account must have JOINED each channel.
  const resolved = [];
  for (const c of sources) {
    try { await client.getInputEntity(c.slug); resolved.push(c.slug); }
    catch (e) { console.warn(`[tg-router] cannot resolve ${c.slug} (join it with the session account?): ${e?.message || e}`); }
  }
  if (!resolved.length) dormant("none of the configured channels could be resolved");

  // No chats filter: GramJS's NewMessage `chats` resolution is unreliable here
  // (entity/InputPeer objects throw, and username filtering didn't deliver), so
  // we listen to ALL new messages and filter in-handler by username via bySlug
  // (skip-if-unknown — M2). Non-source chats are dropped immediately, cheaply.
  client.addEventHandler(handleMessage, new NewMessage({}));
  console.log(`[tg-router] live — ${resolved.length} channel(s), categories: ${categories.join(", ")}`);
  setInterval(() => console.log(`[tg-router] heartbeat ${new Date().toISOString()} queue=${queue.size()} dropped=${queue.dropped()}`), 30 * 60 * 1000);
}

main().catch((err) => {
  console.error(`[tg-router] fatal: ${err?.message || err}`);
  process.exit(1);
});
