#!/usr/bin/env node
/**
 * SWS API research — passive network capture.
 *
 * Opens an authenticated SWS session via the existing .sws-profile-1 profile
 * and logs every network request/response while you navigate to a stock page.
 * Saves to data/sws/api-research/ for later analysis.
 *
 * Pacing is intentionally human (no rush): 1 stock at a time, ~30-60s between
 * navigations, just to capture what the browser naturally does.
 *
 * Usage:
 *   node scripts/sws-api-research.mjs <ticker>          # capture one stock
 *   node scripts/sws-api-research.mjs RELIANCE KOVAI    # capture multiple
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchShardContext, profilePathForShard } from "./sws-stealth-context.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
// Reuse shard-1's profile via the project's stealth launcher — same auth +
// fingerprint as the actual scraper. Critical for getting the paid-sub JWT.
const SHARD_FOR_RESEARCH = 1;
const PROFILE = profilePathForShard(SHARD_FOR_RESEARCH);
const OUT_DIR = path.join(REPO_ROOT, "data/sws/api-research");
const UNIVERSE_PATH = path.join(REPO_ROOT, "data/sws/universe.json");

let _universeIndex = null;
function lookupUniverseUrl(ticker) {
  if (!_universeIndex) {
    const raw = JSON.parse(fs.readFileSync(UNIVERSE_PATH, "utf8"));
    const items = Array.isArray(raw) ? raw : raw.stocks || raw.universe || [];
    _universeIndex = new Map();
    for (const it of items) {
      if (it.ticker) _universeIndex.set(it.ticker.toUpperCase(), it.sws_url);
    }
  }
  return _universeIndex.get(ticker.toUpperCase()) || null;
}

// Endpoints we care about (GraphQL + REST API). Static asset noise goes to a
// separate log file so it doesn't drown out signal.
const SIGNAL_PATTERNS = [
  /\/graphql/i,
  /api\.simplywall/i,
  /\/api\//i,
  /\/_next\/data\//i, // Next.js data calls — often have full stock JSON
];
const NOISE_PATTERNS = [
  /\.(png|jpg|jpeg|gif|svg|webp|woff2?|ttf|css|ico)(\?|$)/i,
  /google-analytics|googletagmanager|gtag|hotjar|mixpanel|segment/i,
];

function classify(url) {
  if (SIGNAL_PATTERNS.some((p) => p.test(url))) return "signal";
  if (NOISE_PATTERNS.some((p) => p.test(url))) return "noise";
  return "other";
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function captureStock(page, ticker, runId) {
  const stockDir = path.join(OUT_DIR, runId, ticker);
  ensureDir(stockDir);

  const signalEvents = []; // {time, method, url, status, reqHeaders, reqBody, respBodySnippet, contentType}
  const otherEvents = [];
  const noiseUrls = []; // just URLs

  // Map<request, entry> — uses request object identity as key so we can match
  // multiple POSTs to the same URL correctly.
  const requestMap = new WeakMap();
  let counter = 0;

  page.on("request", (req) => {
    const url = req.url();
    const klass = classify(url);
    if (klass === "noise") {
      noiseUrls.push(url);
      return;
    }
    counter++;
    const entry = {
      _id: counter,
      time: Date.now(),
      method: req.method(),
      url,
      reqHeaders: req.headers(),
      reqBody: req.postData() || null,
      class: klass,
    };
    if (klass === "signal") signalEvents.push(entry);
    else otherEvents.push(entry);
    requestMap.set(req, entry);
  });

  page.on("response", async (resp) => {
    const req = resp.request();
    const entry = requestMap.get(req);
    if (!entry) return;
    entry.status = resp.status();
    entry.respHeaders = resp.headers();
    entry.contentType = resp.headers()["content-type"] || "";
    // Save body for any signal event (regardless of content-type — GraphQL
    // responses sometimes have unusual MIME types).
    if (entry.class === "signal") {
      try {
        const body = await resp.text();
        const bodyPath = path.join(stockDir, `${entry._id}-body.json`);
        fs.writeFileSync(bodyPath, body);
        entry.respBodyFile = path.basename(bodyPath);
        entry.respBodySize = body.length;
      } catch (e) {
        entry.respBodyError = String(e);
      }
    }
  });

  // Use canonical URL from universe.json; fall back to search.
  let targetUrl = lookupUniverseUrl(ticker);
  if (!targetUrl) {
    console.log(`[research] ${ticker} not in universe, using search fallback`);
    targetUrl = `https://simplywall.st/search?q=${ticker}`;
  }
  console.log(`[research] navigating to ${ticker}: ${targetUrl}`);

  try {
    await page.goto(targetUrl, { timeout: 60000, waitUntil: "domcontentloaded" });
  } catch (e) {
    console.log(`[research] navigation failed for ${ticker}: ${e.message}`);
  }

  // Wait long enough for the page to fully load + all XHRs to fire.
  // SPAs typically batch their data fetches in the first 5-15s after navigation.
  console.log(`[research] waiting 30s for XHRs to settle...`);
  await sleep(30000);

  // Try clicking sub-tab buttons via text-based locator (more reliable than URL guessing).
  const tabLabels = ["Valuation", "Future Growth", "Past Performance", "Financial Health", "Dividend", "Management", "Ownership"];
  for (const label of tabLabels) {
    console.log(`[research]   tab: ${label}`);
    try {
      const tab = page.getByRole("tab", { name: label }).or(page.getByRole("link", { name: label })).first();
      await tab.click({ timeout: 5000 });
    } catch (e) {
      console.log(`[research]     ${label} click skipped: ${e.message.split("\n")[0]}`);
    }
    await sleep(7000 + Math.random() * 3000);
  }

  // Final settle
  await sleep(8000);

  // Save the index
  const index = {
    ticker,
    runId,
    capturedAt: new Date().toISOString(),
    targetUrl,
    finalUrl: page.url(),
    counts: {
      signal: signalEvents.length,
      other: otherEvents.length,
      noise: noiseUrls.length,
    },
    signal: signalEvents,
    other: otherEvents,
    // Don't save full noise URLs, just unique hosts/patterns for context
    noiseHosts: Array.from(new Set(noiseUrls.map((u) => new URL(u).host))),
  };
  fs.writeFileSync(path.join(stockDir, "_index.json"), JSON.stringify(index, null, 2));
  console.log(`[research] ${ticker}: ${signalEvents.length} signal, ${otherEvents.length} other, ${noiseUrls.length} noise`);
  console.log(`[research] saved to: ${stockDir}`);
}

async function main() {
  const tickers = process.argv.slice(2);
  if (tickers.length === 0) {
    console.error("usage: node scripts/sws-api-research.mjs TICKER [TICKER...]");
    process.exit(2);
  }

  ensureDir(OUT_DIR);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(`[research] run ID: ${runId}`);
  console.log(`[research] profile: ${PROFILE}`);
  console.log(`[research] tickers: ${tickers.join(", ")}`);

  if (!fs.existsSync(PROFILE)) {
    console.error(`[research] profile not found: ${PROFILE}`);
    process.exit(1);
  }

  // Use the project's stealth launcher so we get:
  //   - playwright-extra + stealth plugin (masks webdriver fingerprint)
  //   - System Chrome channel (much harder to fingerprint than bundled Chromium)
  //   - SHARED_FINGERPRINT viewport/userAgent/timezone/locale
  //   - launch args matching the production shards
  // Net effect: SWS sees the EXACT same fingerprint as the shard scraper, so
  // we get the same paid-subscription JWT and login state.
  const ctx = await launchShardContext(SHARD_FOR_RESEARCH, { headless: false });
  const page = await ctx.newPage();

  // Console log capture (sometimes hints at API errors)
  const consoleLog = [];
  page.on("console", (msg) => {
    consoleLog.push({ time: Date.now(), type: msg.type(), text: msg.text() });
  });

  try {
    for (const ticker of tickers) {
      await captureStock(page, ticker, runId);
      // Inter-stock pause — simulate a human looking at the data
      if (tickers.indexOf(ticker) < tickers.length - 1) {
        const pauseMs = 30000 + Math.random() * 30000; // 30-60s
        console.log(`[research] pausing ${Math.round(pauseMs / 1000)}s before next ticker (human pacing)...`);
        await sleep(pauseMs);
      }
    }

    // Save console log to run dir
    const runDir = path.join(OUT_DIR, runId);
    fs.writeFileSync(path.join(runDir, "_console.json"), JSON.stringify(consoleLog, null, 2));

    console.log(`\n[research] ✅ DONE. Inspect: ${path.join(OUT_DIR, runId)}`);
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error("[research] fatal:", e);
  process.exit(1);
});
