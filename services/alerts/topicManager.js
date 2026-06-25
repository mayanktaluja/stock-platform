/**
 * Forum-topic manager for the news-router delivery group.
 *
 * The categorized news lands in ONE Telegram group with Topics (forum mode), one
 * topic thread per category. This helper ensures each category has a topic and
 * persists the category→message_thread_id map to data/alerts/topic-map.json.
 *
 * Idempotent: it only creates topics for categories missing from the saved map,
 * so re-runs are no-ops. The map file (committed) is the source of truth — the
 * Bot API has no clean "list topics" call, so we trust the map rather than
 * re-discovering, which also prevents duplicate-topic creation.
 *
 * Group id comes from the saved map's `groupId` or env `TG_GROUP_ID`. Requires
 * the bot to be an admin of the group with "Manage Topics". Never throws.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { botToken } from "./alertsState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAP_PATH = path.join(__dirname, "..", "..", "data", "alerts", "topic-map.json");
const API_BASE = "https://api.telegram.org";

// Category → human topic title (the order also defines creation order).
export const CATEGORY_TITLES = {
  markets: "📈 Markets",
  macro: "🏦 Macro / Fed",
  trump: "🇺🇸 Trump",
  geopolitics: "🌍 Geopolitics",
  traders: "📊 Traders",
  crypto: "🪙 Crypto",
  india: "🇮🇳 India",
  mystocks: "⭐ My Stocks",
};

export function loadTopicMap(mapPath = MAP_PATH) {
  try { return JSON.parse(readFileSync(mapPath, "utf-8")); }
  catch { return { groupId: null, topics: {} }; }
}

function saveTopicMap(map, mapPath = MAP_PATH) {
  mkdirSync(path.dirname(mapPath), { recursive: true });
  const tmp = `${mapPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", "utf-8");
  renameSync(tmp, mapPath);
}

async function createForumTopic(token, groupId, name, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/bot${token}/createForumTopic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: groupId, name }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(`createForumTopic ${res.status}: ${json.description || "?"}`);
  return json.result.message_thread_id;
}

/**
 * Ensure a topic exists for each category in `categories`. Returns
 *   { ready: true, groupId, topics }            — map is usable
 *   { ready: false, reason }                     — not configured / failed
 * `mapPath`, `fetchImpl` injectable for tests. Never throws.
 */
export async function ensureTopics(categories, { env = process.env, mapPath = MAP_PATH, fetchImpl = fetch } = {}) {
  const token = botToken(env);
  if (!token) return { ready: false, reason: "TG_BOT_TOKEN missing" };

  const map = existsSync(mapPath) ? loadTopicMap(mapPath) : { groupId: null, topics: {} };
  map.groupId = map.groupId || String(env.TG_GROUP_ID || "").trim() || null;
  map.topics = map.topics || {};
  if (!map.groupId) return { ready: false, reason: "TG_GROUP_ID missing (create a Topics group, add the bot as admin)" };

  const wanted = [...new Set(categories.filter((c) => CATEGORY_TITLES[c]))];
  let created = 0;
  for (const cat of wanted) {
    if (map.topics[cat] != null) continue; // already mapped — idempotent skip
    try {
      map.topics[cat] = await createForumTopic(token, map.groupId, CATEGORY_TITLES[cat], fetchImpl);
      created += 1;
    } catch (err) {
      return { ready: false, reason: `topic create failed for ${cat}: ${err.message}`, groupId: map.groupId, topics: map.topics };
    }
  }
  if (created > 0) {
    try { saveTopicMap(map, mapPath); } catch (err) { return { ready: false, reason: `map save failed: ${err.message}` }; }
  }
  return { ready: true, groupId: map.groupId, topics: map.topics, created };
}
