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
const { compileMarketGate, matchMarket } = await import("../services/alerts/marketRelevanceGate.js");
const { routeMessage } = await import("../services/alerts/newsRouter.js");
const { markIfNew } = await import("../services/alerts/sentLedger.js");
const { dispatch } = await import("../services/alerts/alertDispatcher.js");
// Market Wire persistence sink — captures each routed message to the on-disk
// buffer so the wire builder can cluster/triage/rank it for the website. NO-OPs
// when NEWS_WIRE_DIR is unset (never breaks the firehose). See services/newsWire.
const { archiveWireMessages, pruneWireBuffer } = await import("../services/newsWire/wireArchive.js");
// Alert de-noise: severity-aware loudness + cross-channel near-duplicate collapse.
// Both reuse the Market Wire's brain (heuristic scorer + token-set clusterer).
const { makeLoudGate } = await import("../services/alerts/loudGate.js");
const { loadRecentStories, findNearDup, recordStory, pruneRecentStories, normalizeTokens } =
  await import("../services/alerts/nearDupGate.js");

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
  const marketCompiled = compileMarketGate((loadJson("data/alerts/market-keywords.json") || {}).keywords || []);
  const marketGate = { match: (t) => matchMarket(t, marketCompiled) };
  // Severity+intensity loudness gate. Without it every "trump"/"nifty" mention
  // pinged loudly; now only HIGH-severity events, strongly-worded MED ones, and
  // watchlist tickers do. Non-loud messages still post silently to their topic.
  const loudGate = makeLoudGate();

  // Cross-channel near-dup window (reworded copies the exact-hash ledger misses).
  const recent = loadRecentStories({ now });

  let fetched = 0, fresh = 0, matched = 0, sent = 0, dup = 0, nearDup = 0, loud = 0;
  const wireBatch = []; // Market Wire sink — flushed once per run after the channel loop.

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
        { compiledWatchlist, macroGate, noiseGate, marketGate, loudGate },
      );
      if (!alert) continue;
      matched += 1;
      if (alert.breaking) loud += 1;

      // Capture for the Market Wire BEFORE the Telegram dedup, so cross-channel
      // copies of the same story are all archived (the clusterer counts distinct
      // sources). Store raw row.text, not the HTML-wrapped alert.text.
      wireBatch.push({
        channel: c.name || c.slug, category: c.category, text: row.text, url: row.url,
        publishedAt: row.publishedAt, breaking: alert.breaking, symbols: alert.symbols,
        tags: alert.tags, routerKey: alert.key,
      });

      // Cross-channel near-dup collapse. The wire buffer above already captured
      // this copy (so the website still shows an honest "N sources"); we only
      // suppress the redundant TELEGRAM send. Fails open — a load/parse error
      // yields matched:false and the alert goes out.
      const tokens = normalizeTokens(row.text);
      const nd = findNearDup(tokens, recent);
      if (nd.matched) {
        nearDup += 1;
        if (DRY_RUN) console.log(`[mirror] would SUPPRESS near-dup (sim=${nd.similarity.toFixed(2)}): ${row.text.slice(0, 60)}`);
        continue;
      }

      if (!DRY_RUN && !markIfNew(alert.key).fresh) { dup += 1; continue; }

      // Route to the group's category topic.
      if (topicMap.groupId) {
        alert.chatId = topicMap.groupId;
        alert.messageThreadId = topicMap.topics?.[alert.topic];
      }
      const res = await dispatch(alert, { dryRun: DRY_RUN });
      const delivered = (res.ok && !res.skipped) || (DRY_RUN && res.skipped);
      if (res.ok && !res.skipped) { sent += 1; await delay(1100); } // ~1 msg/s into the group (Bot API per-chat limit)
      else if (DRY_RUN && res.skipped) sent += 1;
      if (DRY_RUN) {
        const sev = alert.severity ? ` sev=${alert.severity}` : "";
        const imp = alert.impact != null ? ` impact=${alert.impact}` : "";
        console.log(`[mirror] would send [${alert.topic}]${alert.breaking ? " 🔴 LOUD" : " (silent)"}${sev}${imp}: ${row.text.slice(0, 80)}`);
      }

      // Record the story ONLY after a confirmed delivery — never claim-before-send,
      // or a skipped/failed send would permanently swallow the story. The in-memory
      // push makes later channels in THIS SAME run dedup against it.
      if (delivered) {
        if (!DRY_RUN) recordStory(alert.key, tokens);
        recent.push({ key: alert.key, ts: Date.now(), tokens });
      }

      // Cross-post BREAKING (macro-moving or watchlist) to the IMPORTANT priority
      // group — a separate, loud destination the user keeps unmuted. Separate
      // ledger key ("imp:") so it delivers there once in addition to its topic.
      const impGroup = process.env.TG_IMPORTANT_GROUP_ID;
      if (alert.breaking && impGroup && (DRY_RUN || markIfNew(`imp:${alert.key}`).fresh)) {
        const r2 = await dispatch({ text: alert.text, breaking: true, buttons: alert.buttons || [], chatId: impGroup }, { dryRun: DRY_RUN });
        if (r2.ok && !r2.skipped) await delay(1100);
        if (DRY_RUN) console.log(`[mirror]   ↳ ALSO → IMPORTANT: ${row.text.slice(0, 60)}`);
      }
    }
    await delay(400); // polite gap between channels
  }

  // Flush the Market Wire buffer once per run. Skipped under --dry-run so a
  // manual smoke run never pollutes the builder's input. try/catch so a buffer
  // failure can never break the firehose.
  if (!DRY_RUN) {
    try {
      const w = archiveWireMessages(wireBatch);
      pruneWireBuffer();
      pruneRecentStories();
      if (w.written) console.log(`[wire] archived ${w.written} (skipped ${w.skipped})${w.reason ? " — " + w.reason : ""}`);
      else if (w.reason) console.log(`[wire] ${w.reason}`);
    } catch (e) {
      console.warn(`[wire] archive skipped: ${e?.message || e}`);
    }
  }

  console.log(
    `[mirror] channels=${sources.length} parsed=${fetched} fresh<=${WINDOW_MIN}m=${fresh} matched=${matched} ` +
    `loud=${loud} sent=${sent} dedup=${dup} near_dup_suppressed=${nearDup}`,
  );
  return 0;
}

main().then((c) => process.exit(c)).catch((err) => { console.warn(`[mirror] fatal (swallowed): ${err?.message || err}`); process.exit(0); });
