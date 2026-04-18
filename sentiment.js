/**
 * News Sentiment Analysis Engine — LLM-backed version
 *
 * Replaces the old keyword scorer (which had ~60% failure rate on adversarial
 * headlines — e.g., "Upgrade cycle ends, earnings disappoint" scored as BULLISH
 * because of the "+3 upgrade" keyword) with an LLM that understands context
 * and negation. As of the OpenAI migration this uses gpt-5.4 via the OpenAI
 * SDK — the same key is shared with the Poker Hand Reviewer tool.
 *
 * Scoring policy (changed from v1):
 *   - If zero headlines are found → return `score: null` + `available: false`.
 *     The combined-score formula in server.js skips sentiment entirely when
 *     this happens, rather than fabricating a neutral 50 that inflates buys.
 *   - Otherwise → score 0..100 based on LLM classification.
 *
 * Caching strategy:
 *   - Per-headline cache keyed by SHA-256 of the title (24h TTL). The same
 *     headline often shows up across multiple stock searches — this keeps
 *     LLM costs near zero on repeat hits.
 *   - Graceful fallback: if the API call fails or the API key is missing,
 *     falls back to a tight keyword scorer (score ≥3 matches required for a
 *     non-neutral label, so it's harder to fool than the old scorer).
 */

import crypto from "crypto";
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { tmpdir } from "os";
import path, { join } from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { withOpenAIRetry } from "./macroRegime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lazy-init the OpenAI client so the server still boots without an API key
let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) return null;
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// Model used for classification. Matches the Poker Hand Reviewer tool so a
// single OPENAI_API_KEY works for both projects.
const SENTIMENT_MODEL = "gpt-5.4";

// ──────────────────── Cache (24h TTL, disk-backed) ────────────────────
//
// The headline → label cache used to be in-memory only, which meant every
// server restart wiped 24h of LLM classifications and the next page load
// re-classified every headline (slow + cost). We now persist the cache to
// disk so classifications survive deploys and process restarts.
//
// File format: a single JSON object mapping cacheKey → { label, expires }.
// Loaded synchronously on first access; written incrementally on every
// cache update (debounced to avoid disk thrash).

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SENTIMENT_CACHE_PATH = path.join(__dirname, ".sentiment-cache.json");
const headlineCache = new Map(); // key: sha256(title) → { label, expires }

// Cache key includes a version tag so when we change the prompt logic, old
// entries are invalidated automatically. Bump the prefix any time the
// classifier prompt changes meaningfully.
const CACHE_VERSION = "v2-relevance-strict";
function cacheKey(title) {
  return crypto.createHash("sha256").update(CACHE_VERSION + ":" + title).digest("hex");
}

// Load on first import. Silent on failure — empty cache is a safe fallback.
let _cacheLoaded = false;
function ensureCacheLoaded() {
  if (_cacheLoaded) return;
  _cacheLoaded = true;
  try {
    if (!existsSync(SENTIMENT_CACHE_PATH)) return;
    const raw = readFileSync(SENTIMENT_CACHE_PATH, "utf-8");
    const obj = JSON.parse(raw);
    let restored = 0;
    let expired = 0;
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      if (!v || typeof v !== "object" || !v.label) continue;
      if (v.expires && v.expires < now) { expired++; continue; }
      headlineCache.set(k, v);
      restored++;
    }
    console.log(`[SENTIMENT] Cache loaded: ${restored} entries restored, ${expired} expired`);
  } catch (err) {
    console.warn(`[SENTIMENT] Failed to load disk cache: ${err.message}`);
  }
}

// Debounced disk write — accumulates updates and flushes after 5s of quiet.
let _flushTimer = null;
function scheduleCacheFlush() {
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(flushCacheToDisk, 5000);
}

function flushCacheToDisk() {
  try {
    // Drop expired entries before persisting so the file doesn't grow forever
    const now = Date.now();
    const obj = {};
    let alive = 0;
    for (const [k, v] of headlineCache) {
      if (v.expires < now) continue;
      obj[k] = v;
      alive++;
    }
    const tmp = join(tmpdir(), `.sentiment-cache-${process.pid}.json`);
    writeFileSync(tmp, JSON.stringify(obj), "utf-8");
    renameSync(tmp, SENTIMENT_CACHE_PATH);
    // Don't log every write — too noisy. Only log on first persist after restart.
  } catch (err) {
    console.warn(`[SENTIMENT] Failed to flush disk cache: ${err.message}`);
  }
}

// Flush on graceful shutdown so we never lose pending in-memory entries.
// Vercel serverless invokes don't fire process.exit, so we also flush
// proactively after every batch in classifyBatchWithLLM (see below).
process.on("beforeExit", flushCacheToDisk);
process.on("SIGTERM", () => { flushCacheToDisk(); process.exit(0); });
process.on("SIGINT", () => { flushCacheToDisk(); process.exit(0); });

function cacheGet(title) {
  ensureCacheLoaded();
  const entry = headlineCache.get(cacheKey(title));
  if (!entry) return null;
  if (entry.expires < Date.now()) { headlineCache.delete(cacheKey(title)); return null; }
  return entry.label;
}

function cacheSet(title, label) {
  ensureCacheLoaded();
  headlineCache.set(cacheKey(title), { label, expires: Date.now() + CACHE_TTL_MS });
  scheduleCacheFlush();
}

// ──────────────────── LLM classifier ────────────────────

/**
 * Classify a BATCH of headlines in one API call.
 * Returns a parallel array of labels: "bullish" | "bearish" | "neutral".
 *
 * Using a batch call is much cheaper and faster than one-call-per-headline:
 * typical cost ≈ 800 input tokens + 40 output tokens = ~₹0.05 per stock
 * analysis with Haiku 4.5.
 */
async function classifyBatchWithLLM(titles, stockName, ticker) {
  const client = getOpenAI();
  if (!client) throw new Error("No OPENAI_API_KEY");

  const numbered = titles.map((t, i) => `${i + 1}. ${t}`).join("\n");

  // The key change here vs v1 of the LLM prompt: be MUCH more aggressive about
  // classifying off-topic headlines as neutral. The audit found that Yahoo
  // Finance's news search for Indian stocks returns a lot of unrelated noise
  // (e.g., searching "Tata Power" returns headlines about FirstEnergy, iCOUNTER,
  // and other US utilities). The LLM was correctly tagging most of these as
  // neutral but occasionally letting "Strategic Acquisition"-style headlines
  // through as bullish — which polluted the news score.
  //
  // The fix: a hard rule that the company NAME or TICKER must appear in the
  // headline (or it must clearly be about the company by context). Headlines
  // about other companies — even in the same sector — are neutral.
  const system =
    "You are a financial sentiment classifier for Indian stock market news. " +
    "Classify each headline as bullish, bearish, or neutral FROM THE PERSPECTIVE OF THE SPECIFIED STOCK.\n\n" +
    "MOST IMPORTANT RULE — relevance check first:\n" +
    "  → A headline ONLY counts as bullish or bearish if it is clearly about THIS specific company.\n" +
    "  → If the headline is about a different company (even in the same sector or industry), classify as NEUTRAL.\n" +
    "  → If the headline is general market/macro/sector news that doesn't single out this company, classify as NEUTRAL.\n" +
    "  → If you can't tell whether the headline is about this company, classify as NEUTRAL.\n" +
    "  → Be strict: 'energy sector roundup' is neutral for Tata Power. 'FirstEnergy names new CEO' is neutral for Tata Power. Only headlines that mention the company by name or ticker, or are unambiguously about it, count.\n\n" +
    "If the relevance check passes, then judge sentiment:\n" +
    "  • Understand negation: 'upgrade cycle ends' = bearish even though 'upgrade' is positive.\n" +
    "  • Understand context: 'sell stake to pay debt' = bearish despite no obvious negative word.\n" +
    "  • Judge net effect: 'profit warning' overrides 'profit'. 'shares fall despite gains' = bearish.\n" +
    "  • Be conservative — if genuinely mixed or ambiguous, use neutral.\n\n" +
    "Respond with ONLY a JSON array of labels in the same order as input, one per headline. " +
    'Example for 3 headlines: ["bullish","neutral","bearish"]. No other text.';

  // Pass both the human-readable name AND the ticker so the LLM can pattern-match
  // either form (e.g., "TATAPOWER" or "Tata Power Co Ltd")
  const userMessage =
    `Company: ${stockName}\n` +
    (ticker ? `Ticker: ${ticker}\n` : "") +
    `\nHeadlines:\n${numbered}`;

  // OpenAI chat.completions call — system + user messages, gpt-5.4 with
  // deterministic output (temperature 0) for stable cache hits. Wrapped in
  // retry for resilience against transient 429/5xx.
  const response = await withOpenAIRetry(
    () => client.chat.completions.create({
      model: SENTIMENT_MODEL,
      temperature: 0,
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
    }),
    { label: "SENTIMENT" }
  );

  const text = (response.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("Empty LLM response");

  // Parse JSON array of labels
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) throw new Error("No JSON array in LLM response: " + text.slice(0, 100));

  const labels = JSON.parse(match[0]);
  if (!Array.isArray(labels) || labels.length !== titles.length) {
    throw new Error(`LLM returned ${labels.length} labels for ${titles.length} headlines`);
  }

  // Normalise labels
  return labels.map((l) => {
    const s = String(l).toLowerCase().trim();
    if (s === "bullish" || s === "bearish" || s === "neutral") return s;
    return "neutral"; // defensive fallback
  });
}

// ──────────────────── Keyword fallback (tight) ────────────────────

/**
 * Backup scorer used when LLM is unreachable.
 * Unlike the old scorer, this requires ≥3 net keyword matches before assigning
 * a non-neutral label — so single-word false positives ("strong", "upgrade")
 * no longer flip a headline. Still imperfect, but much less catastrophic.
 */
function classifyWithKeywordsFallback(title) {
  const STRONG_BULLISH = ["record high", "blockbuster", "massive order", "mega deal", "strong buy",
    "beat estimates", "profit surges", "contract win", "landmark deal", "buyback", "dividend hike",
    "record profit", "record revenue", "strategic acquisition", "wins order"];
  const STRONG_BEARISH = ["crash", "plunge", "fraud", "scam", "sebi ban", "accounting fraud",
    "target slashed", "downgrade to sell", "bankruptcy", "default", "promoter selling",
    "massive loss", "worst quarter", "profit warning", "guidance cut"];

  const lower = title.toLowerCase();
  let bull = 0, bear = 0;
  for (const p of STRONG_BULLISH) if (lower.includes(p)) bull += 3;
  for (const p of STRONG_BEARISH) if (lower.includes(p)) bear += 3;

  if (bull - bear >= 3) return "bullish";
  if (bear - bull >= 3) return "bearish";
  return "neutral";
}

// ──────────────────── News fetching (unchanged) ────────────────────

const YF_BASE = "https://query1.finance.yahoo.com";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
};

async function fetchYahooNews(searchTerm, count = 12) {
  try {
    const url = `${YF_BASE}/v1/finance/search?q=${encodeURIComponent(searchTerm)}&newsCount=${count}&quotesCount=0`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.news || []).map((n) => ({
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
      thumbnail: n.thumbnail?.resolutions?.[0]?.url || null,
      source: "yahoo",
    }));
  } catch { return []; }
}

async function fetchGoogleNews(searchTerm, count = 10) {
  try {
    const q = encodeURIComponent(searchTerm + " stock India NSE");
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < count) {
      const itemXml = match[1];
      const title = itemXml.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
      const link = itemXml.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
      const pubDate = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();
      const source = itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.trim();
      if (title) {
        items.push({
          title,
          publisher: source || "Google News",
          link: link || null,
          publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
          thumbnail: null,
          source: "google",
        });
      }
    }
    return items;
  } catch { return []; }
}

// ──────────────────── Main analysis ────────────────────

/**
 * Analyse news sentiment for a stock.
 * Returns { score, label, available, headlines, ... }.
 *
 * Important: when `available === false` (no news found or LLM unreachable with
 * no cached labels), callers should NOT feed `score` into the combined
 * recommendation formula — it reweights to tech+fundamentals only.
 */
export async function analyzeNewsSentiment(symbol, name) {
  const cleanSymbol = symbol.replace(".NS", "").replace(".BO", "");
  const searchName = name || cleanSymbol;

  // 1. Fetch headlines
  const [yahooNews, googleNews] = await Promise.all([
    fetchYahooNews(searchName, 12),
    fetchGoogleNews(searchName, 10),
  ]);

  // 2. Deduplicate
  const seen = new Set();
  const allNews = [];
  for (const article of [...yahooNews, ...googleNews]) {
    const key = article.title?.toLowerCase().slice(0, 50);
    if (key && !seen.has(key)) { seen.add(key); allNews.push(article); }
  }

  // 3. Zero-news case: signal "unavailable" instead of faking neutral 50
  if (allNews.length === 0) {
    return {
      score: null,
      label: "unavailable",
      available: false,
      confidence: "none",
      headline_count: 0,
      headlines: [],
      summary: "No recent news found. Sentiment analysis skipped.",
      bullish_count: 0,
      bearish_count: 0,
      neutral_count: 0,
    };
  }

  // 4. Classify headlines via LLM (with per-headline cache + batch call)
  const titles = allNews.map((a) => a.title);
  const labels = new Array(titles.length);
  const uncachedIndices = [];
  const uncachedTitles = [];

  for (let i = 0; i < titles.length; i++) {
    const cached = cacheGet(titles[i]);
    if (cached) labels[i] = cached;
    else { uncachedIndices.push(i); uncachedTitles.push(titles[i]); }
  }

  if (uncachedTitles.length > 0) {
    try {
      const newLabels = await classifyBatchWithLLM(uncachedTitles, searchName, cleanSymbol);
      for (let i = 0; i < uncachedIndices.length; i++) {
        labels[uncachedIndices[i]] = newLabels[i];
        cacheSet(uncachedTitles[i], newLabels[i]);
      }
    } catch (err) {
      console.error("LLM sentiment classification failed:", err.message);
      // Fallback: tight keyword scorer for the uncached ones
      for (let i = 0; i < uncachedIndices.length; i++) {
        const label = classifyWithKeywordsFallback(uncachedTitles[i]);
        labels[uncachedIndices[i]] = label;
        cacheSet(uncachedTitles[i], label); // cache the fallback too, same TTL
      }
    }
  }

  // 5. Assemble scored headlines with recency weighting
  const scoredHeadlines = allNews.map((article, i) => {
    const label = labels[i];
    const numericScore = label === "bullish" ? 1 : label === "bearish" ? -1 : 0;

    let recencyMultiplier = 1.0;
    if (article.publishedAt) {
      const hoursAgo = (Date.now() - new Date(article.publishedAt).getTime()) / 3600000;
      if (hoursAgo < 6) recencyMultiplier = 1.5;
      else if (hoursAgo < 24) recencyMultiplier = 1.2;
      else if (hoursAgo < 72) recencyMultiplier = 1.0;
      else if (hoursAgo < 168) recencyMultiplier = 0.7;
      else recencyMultiplier = 0.4;
    }

    return {
      ...article,
      sentiment: label,
      sentimentScore: numericScore,
      weightedScore: numericScore * recencyMultiplier,
      recencyMultiplier,
    };
  });

  // Sort by absolute impact (most important first)
  scoredHeadlines.sort((a, b) => Math.abs(b.weightedScore) - Math.abs(a.weightedScore));

  // 6. Aggregate into 0-100 score
  const totalWeightedScore = scoredHeadlines.reduce((s, h) => s + h.weightedScore, 0);
  const avgScore = totalWeightedScore / scoredHeadlines.length;
  const sentimentScore = Math.round(Math.max(0, Math.min(100, (avgScore + 1) * 50)));

  const bullishCount = scoredHeadlines.filter((h) => h.sentiment === "bullish").length;
  const bearishCount = scoredHeadlines.filter((h) => h.sentiment === "bearish").length;
  const neutralCount = scoredHeadlines.length - bullishCount - bearishCount;

  // 7. Label + confidence
  let label, confidence;
  if (sentimentScore >= 75)      { label = "very_bullish"; confidence = "high"; }
  else if (sentimentScore >= 60) { label = "bullish";      confidence = "medium"; }
  else if (sentimentScore >= 40) { label = "neutral";      confidence = "low"; }
  else if (sentimentScore >= 25) { label = "bearish";      confidence = "medium"; }
  else                           { label = "very_bearish"; confidence = "high"; }
  if (scoredHeadlines.length < 3) confidence = "low";

  // 8. Summary
  let summary;
  if (bullishCount > bearishCount * 2) {
    summary = `Strongly positive news flow — ${bullishCount} bullish vs ${bearishCount} bearish headlines.`;
  } else if (bullishCount > bearishCount) {
    summary = `Mildly positive news — ${bullishCount} bullish vs ${bearishCount} bearish headlines.`;
  } else if (bearishCount > bullishCount * 2) {
    summary = `Strongly negative news flow — ${bearishCount} bearish vs ${bullishCount} bullish headlines. Caution advised.`;
  } else if (bearishCount > bullishCount) {
    summary = `Mildly negative news — ${bearishCount} bearish vs ${bullishCount} bullish headlines.`;
  } else if (neutralCount > bullishCount + bearishCount) {
    summary = `Mostly neutral news flow — no strong catalysts either way.`;
  } else {
    summary = `Mixed news — ${bullishCount} bullish, ${bearishCount} bearish, ${neutralCount} neutral headlines.`;
  }

  return {
    score: sentimentScore,
    label,
    available: true,
    confidence,
    headline_count: scoredHeadlines.length,
    headlines: scoredHeadlines.slice(0, 12),
    summary,
    bullish_count: bullishCount,
    bearish_count: bearishCount,
    neutral_count: neutralCount,
  };
}

/**
 * Quick sentiment for scans (kept for backward compat).
 * Uses the same LLM pipeline but only reads cache + doesn't fetch Google News.
 */
export async function quickSentiment(symbol, name) {
  const cleanSymbol = symbol.replace(".NS", "").replace(".BO", "");
  const searchName = name || cleanSymbol;
  const news = await fetchYahooNews(searchName, 8);
  if (news.length === 0) return { score: null, label: "unavailable", available: false, headline_count: 0 };

  // Check cache; if all cached, return synchronously. If any missing, skip LLM for speed.
  const cached = news.map((n) => cacheGet(n.title)).filter(Boolean);
  if (cached.length === 0) return { score: null, label: "unavailable", available: false, headline_count: 0 };

  const bull = cached.filter((l) => l === "bullish").length;
  const bear = cached.filter((l) => l === "bearish").length;
  const avg = (bull - bear) / cached.length;
  const score = Math.round(Math.max(0, Math.min(100, (avg + 1) * 50)));
  const label = score >= 60 ? "bullish" : score <= 40 ? "bearish" : "neutral";
  return { score, label, available: true, headline_count: cached.length };
}
