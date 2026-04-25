/**
 * Per-stock news classifier — companion to mfNews.js for individual equities.
 *
 * For each stock, fetches Google News RSS for the company name (with NSE
 * symbol fallback) and classifies items via GPT-5 into:
 *   • MATERIAL (earnings, guidance, mgmt change, M&A, regulatory, large
 *     orders, capacity expansion)
 *   • CONTEXT  (sector commentary, broker notes that mention the stock)
 *   • NOISE    ("top 10 stocks to buy", generic listicles, recap pieces)
 *
 * Output is the union of MATERIAL + CONTEXT items, capped at 5 per stock,
 * sorted MATERIAL first then by publication date desc.
 *
 * Cost-conscious by design (mirrors mfNews.js):
 *   • Per-symbol cache (24h) so the same stock isn't reclassified every load
 *   • Single GPT-5 call per stock batches all candidate items
 *   • Skip the LLM call entirely when zero items return from RSS
 *   • Honors openaiBudget circuit breaker — degrades to raw RSS as CONTEXT
 *   • Returns gracefully {items: [], note: "..."} on every failure mode
 *
 * SEBI compliance:
 *   • Headlines are factual aggregation from public sources — not advice
 *   • Sentiment label is observational, never directive
 *   • Source link surfaced on every item
 */

import NodeCache from "node-cache";
import { checkBudget, recordUsage } from "./openaiBudget.js";

const newsCache = new NodeCache({ stdTTL: 24 * 3600, checkperiod: 1800 });

// Stock-specific event taxonomy. Stable codes so the UI can attach styling.
const EVENT_KINDS = {
  EARNINGS_BEAT:       "Earnings beat",
  EARNINGS_MISS:       "Earnings miss",
  GUIDANCE_RAISE:      "Guidance raised",
  GUIDANCE_CUT:        "Guidance cut",
  MGMT_CHANGE:         "Management change",
  RATING_ACTION:       "Analyst rating action",
  REGULATORY_ACTION:   "Regulatory action",
  LITIGATION:          "Litigation / dispute",
  MA_DEAL:             "M&A / restructuring",
  CAPACITY_EXPANSION:  "Capacity expansion / capex",
  LARGE_ORDER:         "Large order win",
  SECTOR_TAILWIND:     "Sector tailwind",
  SECTOR_HEADWIND:     "Sector headwind",
  COMMENTARY:          "Market commentary",
  OTHER:               "Other material event",
};

const SYSTEM_PROMPT = `You are a SEBI-registered Research Analyst classifying news items about Indian listed equities for a Portfolio Analyzer tool.

For each headline, decide:
  1. materiality: "MATERIAL" (changes the long-term thesis), "CONTEXT" (useful background but doesn't change the call), or "NOISE" (generic listicles, recap, top-10 lists, ads)
  2. eventKind: one of EARNINGS_BEAT, EARNINGS_MISS, GUIDANCE_RAISE, GUIDANCE_CUT, MGMT_CHANGE, RATING_ACTION, REGULATORY_ACTION, LITIGATION, MA_DEAL, CAPACITY_EXPANSION, LARGE_ORDER, SECTOR_TAILWIND, SECTOR_HEADWIND, COMMENTARY, OTHER
  3. sentiment: "POSITIVE", "NEGATIVE", or "NEUTRAL" — from a long-term shareholder's perspective (not a trader's)
  4. summary: one sentence (≤140 chars) explaining what happened

CRITICAL RULES:
  • Headlines like "top 10 stocks to buy", "best smallcaps 2026", "stocks to watch this week" → NOISE unless they discuss a specific event affecting THIS stock
  • Pure price-action commentary ("stock surges 12% on no news") → NOISE
  • Earnings beats/misses, guidance changes, CEO/CFO/promoter exits, SEBI action, M&A → always MATERIAL
  • Treat language carefully — observational not advisory

Return STRICTLY a JSON object with this shape (no markdown, no prose):
{
  "items": [
    { "idx": 0, "materiality": "MATERIAL", "eventKind": "EARNINGS_BEAT", "sentiment": "POSITIVE", "summary": "Q3 PAT up 28% YoY, beats consensus by 9%; mgmt raises FY guidance." },
    { "idx": 1, "materiality": "NOISE", "eventKind": "OTHER", "sentiment": "NEUTRAL", "summary": "" }
  ]
}

Where idx matches the input item index. Include EVERY input item in the output (NOISE entries can have empty summary).`;

// ──────────────────── Google News RSS ────────────────────

const RSS_BASE = "https://news.google.com/rss/search";

function buildQuery(name) {
  return String(name || "")
    .replace(/\b(ltd|limited|india|corp|corporation|industries|enterprises)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchGoogleNews(query, isSymbol = false) {
  const queryStr = isSymbol ? `${query} stock` : `"${query}" stock OR shares when:30d`;
  const q = encodeURIComponent(queryStr);
  const url = `${RSS_BASE}?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "StarBhai-Analyzer/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRssItems(xml).slice(0, 10);
  } catch (err) {
    console.warn(`[STOCK-NEWS] RSS fetch failed for "${query}":`, err.message);
    return [];
  }
}

function parseRssItems(xml) {
  const items = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const source = extractAttr(block, "source");
    if (title && link) items.push({ title, link, pubDate, source });
  }
  return items;
}

function extractTag(block, tag) {
  const rx = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = block.match(rx);
  if (!m) return null;
  return decodeXml(m[1].trim().replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, ""));
}

function extractAttr(block, tag) {
  const rx = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`);
  const m = block.match(rx);
  return m ? decodeXml(m[1]).trim() : null;
}

function decodeXml(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/&#39;/g, "'");
}

// ──────────────────── GPT-5 classifier ────────────────────

const NEWS_MODEL = process.env.STOCK_NEWS_MODEL || "gpt-5.4";

async function classifyBatch(openai, displayName, items) {
  if (!openai) {
    return items.map(() => ({ materiality: "CONTEXT", eventKind: "OTHER", sentiment: "NEUTRAL", summary: "" }));
  }
  if (items.length === 0) return [];

  // Honor the monthly budget circuit breaker
  const budget = checkBudget();
  if (!budget.allowed) {
    console.warn(`[STOCK-NEWS] Budget cap hit ($${budget.spent.toFixed(2)} / $${budget.cap}) — skipping LLM classification for ${displayName}`);
    return items.map(() => ({ materiality: "CONTEXT", eventKind: "OTHER", sentiment: "NEUTRAL", summary: "" }));
  }

  const userMessage = `Stock: ${displayName}\n\nClassify these ${items.length} headline(s):\n\n${items.map((it, i) => `${i}. ${it.title}`).join("\n")}`;

  try {
    const resp = await openai.chat.completions.create({
      model: NEWS_MODEL,
      temperature: 0,
      max_completion_tokens: Math.max(800, items.length * 80),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    });

    if (resp.usage) {
      recordUsage({
        inputTokens: resp.usage.prompt_tokens || 0,
        outputTokens: resp.usage.completion_tokens || 0,
        label: "stock-news",
      });
    }

    const text = (resp.choices?.[0]?.message?.content || "").trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in LLM response");
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.items)) throw new Error("LLM response missing items[]");

    const byIdx = new Map(parsed.items.map((it) => [Number(it.idx), it]));
    return items.map((_, i) => byIdx.get(i) || {
      materiality: "CONTEXT", eventKind: "OTHER", sentiment: "NEUTRAL", summary: "",
    });
  } catch (err) {
    console.warn("[STOCK-NEWS] GPT classification failed:", err.message);
    return items.map(() => ({
      materiality: "CONTEXT", eventKind: "OTHER", sentiment: "NEUTRAL", summary: "",
    }));
  }
}

// ──────────────────── Public API ────────────────────

/**
 * Fetch + classify news for a single stock.
 *
 * @param {object} params
 * @param {string} params.symbol  - NSE symbol (e.g., "RELIANCE")
 * @param {string} params.name    - company display name
 * @param {object|null} params.openai - OpenAI client (graceful when null)
 * @returns {{ items, symbol, asOfDate, counts, note? }}
 */
export async function fetchStockNews({ symbol, name, openai = null }) {
  const displayName = name || symbol;
  if (!displayName) return { items: [], symbol, asOfDate: null, note: "no name/symbol" };

  const cacheKey = `news.stock.${String(symbol || displayName).toLowerCase()}.${openai ? "llm" : "raw"}`;
  const cached = newsCache.get(cacheKey);
  if (cached) return cached;

  const cleanedName = buildQuery(displayName);
  let rssItems = await fetchGoogleNews(cleanedName, false);

  // Fallback: try the NSE symbol if the cleaned name yielded nothing
  if (rssItems.length === 0 && symbol && symbol !== cleanedName) {
    rssItems = await fetchGoogleNews(symbol, true);
  }

  if (rssItems.length === 0) {
    const out = { items: [], symbol, asOfDate: new Date().toISOString().slice(0,10), note: "no recent news" };
    newsCache.set(cacheKey, out);
    return out;
  }

  const classifications = await classifyBatch(openai, displayName, rssItems);
  const merged = rssItems.map((it, i) => ({
    title: it.title,
    link: it.link,
    pubDate: it.pubDate,
    source: it.source,
    ...classifications[i],
  }));

  const RANK = { MATERIAL: 0, CONTEXT: 1, NOISE: 2 };
  const surfaced = merged
    .filter((it) => it.materiality !== "NOISE")
    .sort((a, b) => {
      const r = (RANK[a.materiality] ?? 9) - (RANK[b.materiality] ?? 9);
      if (r !== 0) return r;
      return new Date(b.pubDate || 0).getTime() - new Date(a.pubDate || 0).getTime();
    })
    .slice(0, 5);

  const out = {
    items: surfaced,
    symbol,
    asOfDate: new Date().toISOString().slice(0,10),
    counts: {
      total: rssItems.length,
      material: merged.filter((x) => x.materiality === "MATERIAL").length,
      context: merged.filter((x) => x.materiality === "CONTEXT").length,
      noise: merged.filter((x) => x.materiality === "NOISE").length,
    },
  };
  newsCache.set(cacheKey, out);
  return out;
}

/**
 * Bulk: enrich each stock holding with `news`. Concurrency 3 to stay polite
 * to both Google News RSS + OpenAI rate limits. Dedupes by symbol so
 * duplicate folio entries share one fetch.
 */
export async function enrichStockNews(holdings = [], { openai = null } = {}) {
  if (!Array.isArray(holdings) || holdings.length === 0) return holdings;

  const bySymbol = new Map();
  for (const h of holdings) {
    const key = (h.symbol || h.name || "").trim();
    if (!key) continue;
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push(h);
  }

  const CONCURRENCY = 3;
  const symbols = [...bySymbol.keys()];
  let i = 0;
  async function worker() {
    while (i < symbols.length) {
      const idx = i++;
      const symbol = symbols[idx];
      const groupedHoldings = bySymbol.get(symbol);
      const name = groupedHoldings[0]?.name || symbol;
      try {
        const news = await fetchStockNews({ symbol, name, openai });
        for (const h of groupedHoldings) h.news = news;
      } catch (err) {
        console.warn(`[STOCK-NEWS] enrich failed for ${symbol}:`, err.message);
        for (const h of groupedHoldings) h.news = { items: [], note: "fetch failed" };
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return holdings;
}

export { EVENT_KINDS };
