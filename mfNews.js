/**
 * Per-MF news classifier — Phase 3 of the recommender.
 *
 * For each MF in the user's book, fetches Google News RSS for the scheme
 * name and classifies items via GPT-5 into:
 *   • MATERIAL (manager change, scheme merger, AMC restructure, regulatory
 *     action, large redemption pressure, sub-advisor change, sponsor exit)
 *   • CONTEXT  (market commentary mentioning the scheme — useful but not
 *     decision-changing)
 *   • NOISE    (generic listicles, "top 10 funds" coverage, recap pieces)
 *
 * Output is the union of MATERIAL + CONTEXT items, capped at 5 per fund,
 * sorted MATERIAL first then by publication date.
 *
 * Cost-conscious by design:
 *   • Per-scheme cache (24h) so the same scheme isn't reclassified every
 *     analyze call
 *   • Single GPT-5 call per scheme batches all candidate items
 *   • Skip the LLM call entirely when zero items return from RSS
 *   • Returns gracefully {items: [], note: "..."} on every failure mode
 *     so the UI can render "no recent material news" without crashing
 *
 * SEBI compliance:
 *   • Headlines are factual aggregation from public sources — not advice
 *   • Sentiment label is observational ("Positive"/"Negative"/"Neutral"),
 *     never directive ("Buy on this news")
 *   • Source link surfaced on every item so the RA can verify before relay
 */

import NodeCache from "node-cache";

const newsCache = new NodeCache({ stdTTL: 24 * 3600, checkperiod: 1800 });

// Material-event taxonomy used by the GPT-5 system prompt. Stable codes
// so the UI can attach badge styling per kind.
const EVENT_KINDS = {
  MANAGER_CHANGE:    "Manager change",
  SCHEME_MERGER:     "Scheme merger / wind-up",
  AMC_RESTRUCTURE:   "AMC restructure / sponsor exit",
  REGULATORY_ACTION: "Regulatory action (SEBI/AMFI)",
  LARGE_REDEMPTION:  "Large redemption / outflow stress",
  CATEGORY_RECLASS:  "SEBI category reclassification",
  EXPENSE_CHANGE:    "Expense ratio change",
  PORTFOLIO_SHIFT:   "Material portfolio shift",
  COMMENTARY:        "Market commentary",
  OTHER:             "Other material event",
};

const SYSTEM_PROMPT = `You are a SEBI-registered Research Analyst classifying news items about Indian mutual fund schemes for a Portfolio Analyzer tool.

For each headline, decide:
  1. materiality: "MATERIAL" (changes the investment thesis), "CONTEXT" (useful background but doesn't change the call), or "NOISE" (generic listicles, recap, top-10 lists, ads)
  2. eventKind: one of MANAGER_CHANGE, SCHEME_MERGER, AMC_RESTRUCTURE, REGULATORY_ACTION, LARGE_REDEMPTION, CATEGORY_RECLASS, EXPENSE_CHANGE, PORTFOLIO_SHIFT, COMMENTARY, OTHER
  3. sentiment: "POSITIVE", "NEGATIVE", or "NEUTRAL" — from the perspective of an existing unit-holder
  4. summary: one sentence (≤140 chars) explaining what happened

CRITICAL RULES:
  • If the headline only mentions "top 10 funds" or "best ELSS funds 2026" without specifically discussing an event affecting THIS scheme → NOISE
  • Recap headlines like "5 funds delivered 25% CAGR" → NOISE unless they discuss a fundamental change
  • Manager exits, fund mergers, SEBI action → always MATERIAL
  • Treat language carefully — observational not advisory

Return STRICTLY a JSON object with this shape (no markdown, no prose):
{
  "items": [
    { "idx": 0, "materiality": "MATERIAL", "eventKind": "MANAGER_CHANGE", "sentiment": "NEGATIVE", "summary": "Long-tenure manager exits after 12 years; new appointee from rival AMC." },
    { "idx": 1, "materiality": "NOISE", "eventKind": "OTHER", "sentiment": "NEUTRAL", "summary": "" }
  ]
}

Where idx matches the input item index. Include EVERY input item in the output (NOISE entries can have empty summary).`;

// ──────────────────── Google News RSS ────────────────────

const RSS_BASE = "https://news.google.com/rss/search";

/**
 * Fetch RSS items for a scheme name. Restricts to last 30 days via
 * Google's `when:30d` operator. Returns parsed { title, link, pubDate,
 * source } items, max 10.
 */
async function fetchGoogleNews(query) {
  const q = encodeURIComponent(`"${query}" mutual fund when:30d`);
  const url = `${RSS_BASE}?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "StarBhai-Analyzer/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseRssItems(xml).slice(0, 10);
    return items;
  } catch (err) {
    console.warn(`[MF-NEWS] RSS fetch failed for "${query}":`, err.message);
    return [];
  }
}

function parseRssItems(xml) {
  const items = [];
  // Tolerant regex parser — RSS XML is small + well-formed from Google,
  // but bringing in a full XML parser for one tag pattern is overkill.
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

/**
 * Classify a batch of news items via GPT-5. `openai` is the OpenAI
 * client (passed in to avoid this module importing openai directly —
 * the server.js layer owns the client).
 */
async function classifyBatch(openai, schemeName, items) {
  if (!openai) return items.map(() => ({ materiality: "CONTEXT", eventKind: "OTHER", sentiment: "NEUTRAL", summary: "" }));
  if (items.length === 0) return [];

  const NEWS_MODEL = process.env.MF_NEWS_MODEL || "gpt-5.4";
  const userMessage = `Scheme: ${schemeName}\n\nClassify these ${items.length} headline(s):\n\n${items.map((it, i) => `${i}. ${it.title}`).join("\n")}`;

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
    const text = (resp.choices?.[0]?.message?.content || "").trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in LLM response");
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.items)) throw new Error("LLM response missing items[]");

    // Map back by idx so order is preserved even if LLM reorders
    const byIdx = new Map(parsed.items.map((it) => [Number(it.idx), it]));
    return items.map((_, i) => byIdx.get(i) || {
      materiality: "CONTEXT", eventKind: "OTHER", sentiment: "NEUTRAL", summary: "",
    });
  } catch (err) {
    console.warn("[MF-NEWS] GPT classification failed:", err.message);
    // Fail-safe: surface all items as CONTEXT/NEUTRAL with no summary.
    // Better to show titles unclassified than to drop them entirely —
    // the RA can read them and decide.
    return items.map(() => ({
      materiality: "CONTEXT", eventKind: "OTHER", sentiment: "NEUTRAL", summary: "",
    }));
  }
}

// ──────────────────── Public API ────────────────────

/**
 * Fetch + classify news for one MF scheme.
 *
 * @param {object} params
 * @param {string} params.schemeName - exact AMFI / Groww name
 * @param {string|null} params.amc - AMC short-name (improves search precision)
 * @param {object|null} params.openai - OpenAI client (graceful when null)
 * @returns {{ items: [...], schemeName, asOfDate }}
 */
export async function fetchSchemeNews({ schemeName, amc = null, openai = null }) {
  if (!schemeName) return { items: [], schemeName, asOfDate: null, note: "no scheme name" };

  // Cache key includes openai presence — uncached fallback differs
  const cacheKey = `news.${schemeName.toLowerCase()}.${openai ? "llm" : "raw"}`;
  const cached = newsCache.get(cacheKey);
  if (cached) return cached;

  // Strip plan suffixes from the search query so RSS finds the scheme
  // not the specific plan variant
  const queryName = String(schemeName)
    .replace(/\b(direct|regular)\s*(plan|growth)?\b/gi, "")
    .replace(/\b(growth|growth\s*option)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const rssItems = await fetchGoogleNews(queryName);
  if (rssItems.length === 0) {
    const out = { items: [], schemeName, asOfDate: new Date().toISOString().slice(0,10), note: "no recent news" };
    newsCache.set(cacheKey, out);
    return out;
  }

  const classifications = await classifyBatch(openai, schemeName, rssItems);
  const merged = rssItems.map((it, i) => ({
    title: it.title,
    link: it.link,
    pubDate: it.pubDate,
    source: it.source,
    ...classifications[i],
  }));

  // Filter out NOISE; keep MATERIAL + CONTEXT, sorted MATERIAL first then by date desc
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
    schemeName,
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
 * Bulk: enrich each MF holding with `news`. Concurrency 3 to stay polite
 * to both Google News RSS + OpenAI rate limits.
 */
export async function enrichMfNews(mfHoldings = [], { openai = null } = {}) {
  if (!Array.isArray(mfHoldings) || mfHoldings.length === 0) return mfHoldings;

  // De-duplicate by scheme name — same Axis ELSS in 2 folios shares one
  // news fetch + classification.
  const byScheme = new Map();
  for (const h of mfHoldings) {
    const key = (h.amfi?.schemeName || h.name || "").trim();
    if (!key) continue;
    if (!byScheme.has(key)) byScheme.set(key, []);
    byScheme.get(key).push(h);
  }

  const CONCURRENCY = 3;
  const schemes = [...byScheme.keys()];
  let i = 0;
  async function worker() {
    while (i < schemes.length) {
      const idx = i++;
      const schemeName = schemes[idx];
      const holdings = byScheme.get(schemeName);
      const amc = holdings[0]?.amfi?.fundHouse || holdings[0]?.amc || null;
      try {
        const news = await fetchSchemeNews({ schemeName, amc, openai });
        for (const h of holdings) h.news = news;
      } catch (err) {
        console.warn(`[MF-NEWS] enrich failed for ${schemeName}:`, err.message);
        for (const h of holdings) h.news = { items: [], note: "fetch failed" };
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return mfHoldings;
}

export { EVENT_KINDS };
