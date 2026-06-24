#!/usr/bin/env node
/**
 * Telegram public-mirror news poller (fast-news Phase 3b — reliable path).
 *
 * Polls https://t.me/s/<slug> for each enabled channel in news-sources.json,
 * parses the public web preview (no MTProto / no session — plain HTTPS), and
 * routes fresh messages into the delivery group's category topics, reusing the
 * SAME routeMessage → dedup → dispatch pipeline as the live listener. Chosen
 * over the MTProto listener because this environment can't hold a persistent
 * update connection; an ~1-minute cron poll is the dependable substitute.
 *
 * Coverage-first: forwards every fresh message, ⭐ watchlist hits, 🔴 macro
 * breaking, cross-channel deduped. First-run flood is bounded by the freshness
 * window (only messages newer than --window-min) plus the ledger.
 *
 * Always exits 0.
 *   node scripts/refresh-mirror-news.mjs               # poll + send
 *   node scripts/refresh-mirror-news.mjs --dry-run     # parse + log, no send
 *   node scripts/refresh-mirror-news.mjs --window-min 3
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(REPO_ROOT, ".env"), override: false });

const { parseMirrorHtml } = await import("../services/alerts/telegramMirrorParser.js");
const { compileWatchlist } = await import("../services/alerts/watchlistGate.js");
const { compileMacroGate, matchMacro } = await import("../services/alerts/macroBreakingGate.js");
const { compileNoiseGate, matchNoise } = await import("../services/alerts/noiseFilter.js");
const { routeMessage } = await import("../services/alerts/newsRouter.js");
const { markIfNew } = await import("../services/alerts/sentLedger.js");
const { dispatch } = await import("../services/alerts/alertDispatcher.js");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const wIdx = argv.indexOf("--window-min");
const WINDOW_MIN = wIdx >= 0 ? Number(argv[wIdx + 1]) || 3 : 3;

function loadJson(rel) {
  try { return JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf-8")); } catch { return null; }
}

async function fetchText(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", "Accept-Language": "en" },
      signal: ctrl.signal,
    });
    return res.ok ? await res.text() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const now = Date.now();
  const sourcesCfg = loadJson("data/alerts/news-sources.json") || { channels: [] };
  const sources = (sourcesCfg.channels || []).filter((c) => c && c.enabled !== false && c.slug && c.category);
  if (!sources.length) { console.warn("[mirror] no enabled channels"); return 0; }

  const topicMap = loadJson("data/alerts/topic-map.json") || { groupId: null, topics: {} };
  const compiledWatchlist = compileWatchlist(loadJson("data/alerts/watchlist.json") || {});
  const macroCompiled = compileMacroGate();
  const macroGate = { match: (t) => matchMacro(t, macroCompiled) };
  const noiseCompiled = compileNoiseGate((loadJson("data/alerts/mute-keywords.json") || {}).keywords || []);
  const noiseGate = { match: (t) => matchNoise(t, noiseCompiled) };

  let fetched = 0, fresh = 0, matched = 0, sent = 0, dup = 0;

  for (const c of sources) {
    const html = await fetchText(`https://t.me/s/${c.slug}`);
    if (!html) { console.warn(`[mirror] fetch failed: ${c.slug}`); await delay(300); continue; }
    const rows = parseMirrorHtml(html);
    fetched += rows.length;

    for (const row of rows) {
      // Freshness: undated → skip (can't prove fresh — no first-run flood).
      if (!row.publishedAt) continue;
      const ts = new Date(row.publishedAt).getTime();
      if (!Number.isFinite(ts) || now - ts > WINDOW_MIN * 60 * 1000) continue;
      fresh += 1;

      const alert = routeMessage(
        { text: row.text, channel: c.name || c.slug, category: c.category, link: row.url, date: row.publishedAt },
        { compiledWatchlist, macroGate, noiseGate },
      );
      if (!alert) continue;
      matched += 1;

      if (!DRY_RUN && !markIfNew(alert.key).fresh) { dup += 1; continue; }

      // Route to the group's category topic.
      if (topicMap.groupId) {
        alert.chatId = topicMap.groupId;
        alert.messageThreadId = topicMap.topics?.[alert.topic];
      }
      const res = await dispatch(alert, { dryRun: DRY_RUN });
      if (res.ok && !res.skipped) { sent += 1; await delay(1100); } // ~1 msg/s into the group (Bot API per-chat limit)
      else if (DRY_RUN && res.skipped) sent += 1;
      if (DRY_RUN) console.log(`[mirror] would send [${alert.topic}]${alert.breaking ? " 🔴" : ""}: ${row.text.slice(0, 80)}`);
    }
    await delay(400); // polite gap between channels
  }

  console.log(`[mirror] channels=${sources.length} parsed=${fetched} fresh<=${WINDOW_MIN}m=${fresh} matched=${matched} sent=${sent} dedup=${dup}`);
  return 0;
}

main().then((c) => process.exit(c)).catch((err) => { console.warn(`[mirror] fatal (swallowed): ${err?.message || err}`); process.exit(0); });
