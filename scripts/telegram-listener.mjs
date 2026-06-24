#!/usr/bin/env node
/**
 * Phase-3 Telegram-channel listener (NEWS class).
 *
 * Persistent MTProto client (GramJS) that watches the channels in
 * data/alerts/channels.json for messages mentioning a data/alerts/watchlist.json
 * ticker, dedups against the same canonical NEWS-class ledger as the RSS poller,
 * and pushes Telegram via the shared dispatcher. This is the lowest-latency
 * source — desks post here before the wires.
 *
 * Runs headless from a saved user session (TG_SESSION). It is DORMANT until
 * configured: missing api creds / session / channels → logs why and exits 0
 * (the KeepAlive wrapper won't hot-loop because a launchd ThrottleInterval
 * spaces restarts). Generate TG_SESSION once via scripts/telegram-session-login.mjs.
 *
 * Self-skips its sends exactly like every other alert path when TG_BOT_TOKEN is
 * unset (alertsState), so it never throws into the process.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(REPO_ROOT, ".env"), override: false });

const { compileWatchlist } = await import("../services/alerts/watchlistGate.js");
const { channelAlertFor } = await import("../services/alerts/channelMessageHandler.js");
const { hasKey, recordSent } = await import("../services/alerts/sentLedger.js");
const { dispatch } = await import("../services/alerts/alertDispatcher.js");
const { suppressNews } = await import("../services/alerts/quietHours.js");

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const sessionStr = process.env.TG_SESSION || "";

function loadJson(rel) {
  try { return JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf-8")); }
  catch { return null; }
}

function dormant(reason) {
  console.log(`[tg-listener] dormant — ${reason}. Exiting 0.`);
  process.exit(0);
}

if (!apiId || !apiHash) dormant("TG_API_ID/TG_API_HASH missing (my.telegram.org)");
if (!sessionStr) dormant("TG_SESSION missing — run scripts/telegram-session-login.mjs");

const channelsCfg = loadJson("data/alerts/channels.json") || { channels: [] };
const channelIds = (channelsCfg.channels || [])
  .filter((c) => c && c.enabled !== false)
  .map((c) => (typeof c === "string" ? c : c.id || c.username))
  .filter(Boolean);
if (!channelIds.length) dormant("no enabled channels in data/alerts/channels.json");

const watchlist = loadJson("data/alerts/watchlist.json");
const compiled = compileWatchlist(watchlist || {});
if (!compiled.perSymbol.length) dormant("watchlist has no usable tickers");

const pkg = await import("telegram");
const { TelegramClient } = pkg;
const { StringSession } = await import("telegram/sessions/index.js");
const { NewMessage } = await import("telegram/events/index.js");

async function handleMessage(event) {
  try {
    const msg = event.message;
    const text = msg?.message || "";
    if (!text.trim()) return;

    let channelTitle = "channel";
    let username = null;
    try { const chat = await msg.getChat(); channelTitle = chat?.title || channelTitle; username = chat?.username || null; }
    catch { /* entity fetch best-effort */ }

    const link = username ? `https://t.me/${username}/${msg.id}` : null;
    const date = msg?.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();

    const alert = channelAlertFor({ text, channel: channelTitle, link, date }, compiled);
    if (!alert) return;
    if (suppressNews({ breaking: alert.breaking, date: new Date() })) return;
    if (hasKey(alert.key)) return;

    const res = await dispatch(alert);
    if (res.ok && !res.skipped) recordSent(alert.key);
  } catch (err) {
    console.warn(`[tg-listener] handler error (swallowed): ${err?.message || err}`);
  }
}

async function main() {
  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  if (!(await client.checkAuthorization())) dormant("session not authorized — regenerate TG_SESSION");

  // Resolve channels so the NewMessage filter is precise; warn on any we can't.
  const resolved = [];
  for (const id of channelIds) {
    try { resolved.push(await client.getInputEntity(id)); }
    catch (e) { console.warn(`[tg-listener] cannot resolve channel ${id}: ${e?.message || e}`); }
  }
  if (!resolved.length) dormant("none of the configured channels could be resolved");

  client.addEventHandler(handleMessage, new NewMessage({ chats: resolved }));
  console.log(`[tg-listener] live — watching ${resolved.length} channel(s), ${compiled.perSymbol.length} watchlist tickers`);

  // Heartbeat so launchd logs show liveness; GramJS keeps the socket + event loop alive.
  setInterval(() => console.log(`[tg-listener] heartbeat ${new Date().toISOString()}`), 30 * 60 * 1000);
}

main().catch((err) => {
  console.error(`[tg-listener] fatal: ${err?.message || err}`);
  process.exit(1);
});
