/**
 * Sector Outlook — LLM Theme Refiner.
 *
 * Second-pass classifier that only sees the ~5% of news items the
 * heuristic flagged as ambiguous (`isHighConfidenceHeuristic(...) === false`)
 * AND that are still within the 365-day recency window (anything older
 * than that doesn't contribute to even the long-horizon aggregator
 * window, so spending LLM budget on it is wasted).
 *
 * Pattern mirrors services/earnings/earningsLlmBatcher.js — same hash-
 * cache discipline, same Gemini → Groq → heuristic provider chain via
 * withOpenAIRetry, same `_last_provider_attempt` tri-state cache schema
 * that prevents the cache-poisoning class of bug documented in
 * earningsLlmBatcher.js:24-28.
 *
 * Critical differences from the earnings batcher:
 *   1. Per-news-item cache (not per-event). Cache key includes
 *      classifier_version so a taxonomy bump cold-invalidates.
 *   2. No V3 floor — we want full sector breadth. Recency + ambiguity
 *      are the scoping levers instead.
 *   3. Output shape matches the heuristic classifier exactly so the
 *      aggregator (PR 3) doesn't care which path produced the row.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import OpenAI from "openai";

import { withOpenAIRetry, getGroqQuotaState } from "../../macroRegime.js";
import { sanitiseText } from "../earnings/llmPromptHardener.js";
import {
  canonicalizeTheme,
  CLASSIFIER_VERSION,
  MIN_CONFIDENCE,
  VALID_SIGNS,
  VALID_INTENSITIES,
} from "./themeTaxonomy.js";
import {
  classifyOne as heuristicClassifyOne,
  isHighConfidenceHeuristic,
} from "./heuristicThemeClassifier.js";

const ROOT = process.cwd();
export const CACHE_PATH = path.join(ROOT, "data", "sectorOutlook", "llm-theme-cache.json");
export const CACHE_SCHEMA = "sector-theme-cache-v1";

const GROQ_MODEL = process.env.SECTOR_OUTLOOK_LLM_MODEL || "llama-3.3-70b-versatile";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GEMINI_MODEL = process.env.SECTOR_OUTLOOK_LLM_GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

const DEFAULT_CHUNK_SIZE = 8;
const DEFAULT_CONCURRENCY = 2;
const CACHE_TTL_DAYS = 90;
const FAILED_RETRY_MS = 24 * 60 * 60 * 1000;
const RECENCY_WINDOW_DAYS = 365;

// Whitelist of fields that constitute the wire contract for a theme entry.
// Anything starting with "_" is internal cache metadata and is stripped
// before the entry is attached to a news item (mirrors earningsLlmBatcher
// SIGNAL_WIRE_FIELDS).
const THEME_WIRE_FIELDS = [
  "theme",
  "sign",
  "intensity",
  "confidence",
  "time_hint",
  "top_reason",
  "classifier_provider",
  "classifier_version",
];

/* ──────────────────────── cache primitives ──────────────────────── */

export function loadCache(p = CACHE_PATH) {
  if (!fs.existsSync(p)) return { schema_version: CACHE_SCHEMA, entries: {} };
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j && j.entries ? j : { schema_version: CACHE_SCHEMA, entries: {} };
  } catch {
    return { schema_version: CACHE_SCHEMA, entries: {} };
  }
}

export function writeCacheAtomic(cache, p = CACHE_PATH) {
  const tmp = p + ".tmp." + process.pid;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * Hash STABLE per-news-item inputs into a 24-hex cache key. Includes
 * the classifier_version so a taxonomy bump cold-invalidates every
 * cached entry. SWS news bodies are immutable per (id, date) per the
 * brief, so this key is permanent.
 */
export function newsItemHash(newsItem) {
  const id = newsItem?.id || "";
  const date = newsItem?.date || "";
  const titleSlice = sanitiseText(newsItem?.title || "", 220);
  const bodySlice = sanitiseText(newsItem?.body || "", 400);
  const canonical = [CLASSIFIER_VERSION, id, date, titleSlice, bodySlice].join("::");
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

// Whitelist-strip cache metadata before attaching to a news item.
export function stripCacheMeta(entry) {
  const out = {};
  for (const k of THEME_WIRE_FIELDS) {
    if (entry[k] !== undefined) out[k] = entry[k];
  }
  return out;
}

function pruneCache(cache, usedHashes) {
  const cutoff = Date.now() - CACHE_TTL_DAYS * 86400000;
  for (const [hash, entry] of Object.entries(cache.entries)) {
    if (usedHashes.has(hash)) continue;
    const cachedMs = entry && entry._cached_at ? new Date(entry._cached_at).getTime() : 0;
    if (!Number.isFinite(cachedMs) || cachedMs < cutoff) delete cache.entries[hash];
  }
}

/* ──────────────────── recency + scoping helpers ─────────────────── */

/**
 * True if a news item's `date` is within RECENCY_WINDOW_DAYS of `now`.
 * Older items skip the LLM entirely (heuristic is good enough at that
 * range — those items get blended into the 365d aggregator window via
 * heuristic theme classification, but never burn LLM budget).
 */
export function isWithinRecencyWindow(newsItem, nowMs = Date.now()) {
  if (!newsItem || !newsItem.date) return false;
  const t = new Date(newsItem.date).getTime();
  if (!Number.isFinite(t)) return false;
  const ageDays = (nowMs - t) / 86400000;
  return ageDays >= 0 && ageDays <= RECENCY_WINDOW_DAYS;
}

/**
 * The LLM only sees items the heuristic was uncertain about AND are
 * within the recency window. This is THE cost lever — it scopes the
 * 83k-item cold-cache walk down to ~5k items per refresh.
 */
export function needsLlmRefine(newsItem, heuristicResult, nowMs = Date.now()) {
  if (isHighConfidenceHeuristic(heuristicResult)) return false;
  return isWithinRecencyWindow(newsItem, nowMs);
}

/* ──────────────────────── LLM provider chain ────────────────────── */

let _groq = null;
function getGroqClient() {
  if (_groq) return _groq;
  if (!process.env.GROQ_API_KEY) return null;
  _groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
  return _groq;
}

let _gemini = null;
function getGeminiClient() {
  if (_gemini) return _gemini;
  if (!process.env.GEMINI_API_KEY) return null;
  _gemini = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: GEMINI_BASE_URL });
  return _gemini;
}

function buildSystemPrompt() {
  return (
    "You classify Indian-equity stock news items into one of 8 sector-outlook themes.\n" +
    "Available themes (exact label set, choose one):\n" +
    "  CAPACITY_CAPEX — capacity expansion, plant commissioning, capex commitment\n" +
    "  M_AND_A — acquisition, divestiture, demerger, JV restructure\n" +
    "  ORDER_WINS — large contract / order wins, backlog ramp\n" +
    "  REGULATORY_EVENT — policy, tariff, license, ban, subsidy\n" +
    "  MARGIN_MOVE — gross / operating margin expansion or compression\n" +
    "  EARNINGS_MOVE — quarterly beat / miss\n" +
    "  STRATEGIC_GEOPOLITICAL — geopolitical, trade-relations, sanctions, currency\n" +
    "  NEUTRAL — no clear theme; default\n\n" +
    "For each news item return ONE JSON object:\n" +
    "{\n" +
    '  "index": <the item number, integer 1..N>,\n' +
    '  "theme": <one of the labels above>,\n' +
    '  "sign": <-1 | 0 | 1>,  // -1 = headwind, 0 = neutral, 1 = tailwind\n' +
    '  "intensity": <1 | 2 | 3>,  // 1 = minor mention, 2 = clearly material, 3 = blockbuster\n' +
    '  "confidence": <0.0..1.0>,  // your certainty in the (theme, sign) tuple\n' +
    '  "time_hint": "short" | "medium" | "long",  // 30d / 3-12m / 1-3y signal\n' +
    '  "top_reason": "<= 140 chars, the strongest qualitative reason"\n' +
    "}\n\n" +
    "RULES:\n" +
    "  1. Be conservative — default to NEUTRAL with sign=0 unless the signal is one-sided.\n" +
    "  2. Sign MUST match the news direction — a regulatory BAN is -1, a SUBSIDY is +1.\n" +
    "  3. Judge on the company-level news content, NOT on price action.\n" +
    "  4. Output JSON ONLY, no prose, no code fence.\n" +
    "  5. If the news is purely procedural (AGM scheduled, disclosure filed), classify as NEUTRAL."
  );
}

function buildBatchUserMessage(newsItems) {
  const blocks = newsItems.map((n, i) => {
    const title = sanitiseText(n.title || "", 220);
    const body = sanitiseText(n.body || "", 800);
    return (
      `### Item ${i + 1}\n` +
      `Ticker: ${n._ticker || "n/a"}\n` +
      `Date: ${n.date || "n/a"}\n` +
      `Title: ${title}\n` +
      `Body: <news_body>${body}</news_body>`
    );
  });
  return (
    `Classify these ${newsItems.length} news items. Return one signal per item.\n\n` +
    blocks.join("\n\n") +
    `\n\nReturn strict JSON only: { "signals": [ ... ] }`
  );
}

function normaliseSignal(row, meta) {
  const theme = canonicalizeTheme(row?.theme);
  let sign = Number(row?.sign);
  if (!VALID_SIGNS.includes(sign)) sign = 0;
  let intensity = Number(row?.intensity);
  if (!VALID_INTENSITIES.includes(intensity)) intensity = 1;
  let confidence = Number(row?.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const timeHintRaw = String(row?.time_hint || "").toLowerCase();
  const time_hint = ["short", "medium", "long"].includes(timeHintRaw) ? timeHintRaw : "medium";
  const top_reason = sanitiseText(row?.top_reason || "", 140);
  return {
    theme,
    sign,
    intensity,
    confidence,
    time_hint,
    top_reason,
    classifier_provider: meta?.provider || "llm",
    classifier_version: CLASSIFIER_VERSION,
  };
}

function parseBatchResponse(text, newsItems, meta) {
  let parsed = null;
  const jsonMatch = String(text || "").match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]); } catch { parsed = null; }
  }
  const rows = parsed && Array.isArray(parsed.signals) ? parsed.signals : [];
  const byIndex = new Map();
  for (const row of rows) {
    const idx = Number(row && row.index);
    if (Number.isInteger(idx) && idx >= 1 && idx <= newsItems.length) {
      byIndex.set(idx, row);
    }
  }
  return newsItems.map((n, i) => {
    const row = byIndex.get(i + 1);
    return row ? normaliseSignal(row, meta) : heuristicClassifyOne(n);
  });
}

async function classifyBatchViaProvider(newsItems, { client, model, label }) {
  const response = await withOpenAIRetry(
    () => client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 1600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildBatchUserMessage(newsItems) },
      ],
    }),
    { label },
  );
  const text = (response.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("empty LLM response");
  return parseBatchResponse(text, newsItems, {
    provider: label.split("/")[1] || label,
  });
}

/**
 * Classify a batch of ≤8 news items with Gemini → Groq → heuristic
 * fallback. Never throws. Mirrors earningsLlmSignal.classifyBatch shape.
 */
export async function classifyBatch(newsItems, opts = {}) {
  if (!Array.isArray(newsItems) || newsItems.length === 0) return [];

  // Test hook — bypass the network entirely.
  if (typeof opts.providerOverride === "function") {
    try {
      const out = await opts.providerOverride(newsItems);
      if (Array.isArray(out) && out.length === newsItems.length) return out;
    } catch {
      // fall through to heuristic
    }
    return newsItems.map(heuristicClassifyOne);
  }

  const gemini = getGeminiClient();
  if (gemini) {
    try {
      return await classifyBatchViaProvider(newsItems, {
        client: gemini, model: GEMINI_MODEL, label: "SECTOR-OUTLOOK-LLM/gemini",
      });
    } catch (err) {
      console.warn(`[sector-outlook-llm] Gemini failed: ${err.message} — trying Groq`);
    }
  }

  const groq = getGroqClient();
  if (groq && !getGroqQuotaState().limited) {
    try {
      return await classifyBatchViaProvider(newsItems, {
        client: groq, model: GROQ_MODEL, label: "SECTOR-OUTLOOK-LLM/groq",
      });
    } catch (err) {
      console.warn(`[sector-outlook-llm] Groq failed: ${err.message} — using heuristic`);
    }
  }

  return newsItems.map(heuristicClassifyOne);
}

// Worker-pool over chunk indices — mirror earningsLlmBatcher.runChunks
export async function runChunks(chunks, fn, concurrency) {
  let idx = 0;
  const out = [];
  async function worker() {
    while (idx < chunks.length) {
      const my = idx++;
      out[my] = await fn(chunks[my], my);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));
  return out;
}

/* ─────────────────────────── orchestrator ───────────────────────── */

/**
 * Classify a list of news items end-to-end. Each item gets a heuristic
 * pass first; high-confidence heuristics short-circuit. Ambiguous items
 * within the recency window get LLM-refined and cached.
 *
 * @param {Array<{id?, date, title?, body?, _ticker?}>} newsItems
 * @param {object} [opts]
 * @param {boolean} [opts.skipLlm]           force heuristic, no cache I/O
 * @param {boolean} [opts.llmAvailable]      override env-key detection
 * @param {string}  [opts.cachePath]         override cache file path
 * @param {function}[opts.providerOverride]  inject a fake LLM
 * @param {number}  [opts.chunkSize]
 * @param {number}  [opts.concurrency]
 * @param {number}  [opts.maxLlmCalls]       cap LLM batches; remainder
 *                                            heuristic-only this run
 * @param {number}  [opts.nowMs]             override Date.now() for tests
 * @returns {Promise<{results, stats}>}
 *          results[i] aligns with newsItems[i]
 */
export async function classifyNewsBatch(newsItems, opts = {}) {
  if (!Array.isArray(newsItems) || newsItems.length === 0) {
    return { results: [], stats: { total: 0 } };
  }
  const chunkSize = Number.isFinite(opts.chunkSize) ? opts.chunkSize : DEFAULT_CHUNK_SIZE;
  const concurrency = Number.isFinite(opts.concurrency) ? opts.concurrency : DEFAULT_CONCURRENCY;
  const llmAvailable = opts.llmAvailable
    ?? !!(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY)
    ?? false;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const maxLlmCalls = Number.isFinite(opts.maxLlmCalls) ? opts.maxLlmCalls : Infinity;

  // Pass 1 — heuristic for every item.
  const heuristics = newsItems.map(heuristicClassifyOne);

  // skip-llm: deterministic heuristic for everything, no cache I/O.
  if (opts.skipLlm) {
    return {
      results: heuristics.map((h) => stripCacheMeta({ ...h, top_reason: "" })),
      stats: {
        total: newsItems.length,
        heuristic: newsItems.length,
        cache_hits: 0,
        llm_calls: 0,
        llm_items: 0,
        skip_llm: true,
      },
    };
  }

  // Pass 2 — cache lookup for items that need refinement.
  const cachePath = opts.cachePath || CACHE_PATH;
  const cache = loadCache(cachePath);
  const hashes = newsItems.map(newsItemHash);
  const refineCandidates = [];
  let cacheHits = 0;
  let heuristicCacheInvalidations = 0;

  for (let i = 0; i < newsItems.length; i += 1) {
    if (!needsLlmRefine(newsItems[i], heuristics[i], nowMs)) continue;
    const cached = cache.entries[hashes[i]];
    const isCachedHeuristic = cached && cached.classifier_provider === "heuristic";
    const priorAttempt = cached && cached._last_provider_attempt;
    const cachedMs = cached && cached._cached_at ? new Date(cached._cached_at).getTime() : 0;
    const failedRetryEligible = priorAttempt === "failed"
      && Number.isFinite(cachedMs)
      && (nowMs - cachedMs) >= FAILED_RETRY_MS;
    const isStaleHeuristic = isCachedHeuristic && llmAvailable && (
      priorAttempt === "none" || priorAttempt === undefined ||
      (priorAttempt === "failed" && failedRetryEligible)
    );
    if (cached && cached.theme && !isStaleHeuristic) {
      cacheHits += 1;
      // Cache hit — overwrite heuristic[i] with the cached entry.
      heuristics[i] = stripCacheMeta(cached);
    } else {
      if (isStaleHeuristic) heuristicCacheInvalidations += 1;
      refineCandidates.push(i);
    }
  }

  // Pass 3 — LLM chunk over remaining ambiguous items, capped by maxLlmCalls.
  const chunks = [];
  let llmItems = 0;
  for (let i = 0; i < refineCandidates.length; i += chunkSize) {
    if (chunks.length >= maxLlmCalls) break;
    const slice = refineCandidates.slice(i, i + chunkSize);
    chunks.push(slice);
    llmItems += slice.length;
  }

  let llmCalls = 0;
  let llmHeuristicCount = 0;

  const chunkResults = await runChunks(
    chunks,
    async (chunkIdxs) => {
      const items = chunkIdxs.map((idx) => newsItems[idx]);
      llmCalls += 1;
      const signals = await classifyBatch(items, { providerOverride: opts.providerOverride });
      return { chunkIdxs, signals };
    },
    concurrency,
  );

  for (const { chunkIdxs, signals } of chunkResults) {
    chunkIdxs.forEach((newsIdx, j) => {
      const sig = signals[j] || heuristicClassifyOne(newsItems[newsIdx]);
      const wire = stripCacheMeta(sig);
      if (sig.classifier_provider === "heuristic") llmHeuristicCount += 1;
      heuristics[newsIdx] = wire;
      cache.entries[hashes[newsIdx]] = {
        ...wire,
        _cached_at: nowIso,
        _last_provider_attempt:
          sig.classifier_provider === "heuristic"
            ? (llmAvailable ? "failed" : "none")
            : "succeeded",
      };
    });
  }

  // For uncached items that ran the heuristic (heuristic was high-conf
  // OR item was outside the recency window), also stamp the cache so
  // subsequent runs are zero-LLM. This is the "zero LLM call on cache-
  // hit re-run" invariant the PR-2 test asserts.
  for (let i = 0; i < newsItems.length; i += 1) {
    if (cache.entries[hashes[i]]) continue;
    const wire = stripCacheMeta({ ...heuristics[i], top_reason: heuristics[i].top_reason || "" });
    cache.entries[hashes[i]] = {
      ...wire,
      _cached_at: nowIso,
      _last_provider_attempt: "heuristic-only",
    };
  }

  // Prune + write atomically.
  pruneCache(cache, new Set(hashes));
  cache.schema_version = CACHE_SCHEMA;
  cache.updated_at = nowIso;
  writeCacheAtomic(cache, cachePath);

  return {
    results: heuristics,
    stats: {
      total: newsItems.length,
      heuristic: newsItems.length - llmCalls * chunkSize + llmHeuristicCount,
      cache_hits: cacheHits,
      heuristic_cache_invalidations: heuristicCacheInvalidations,
      llm_calls: llmCalls,
      llm_items: llmItems,
      llm_available: llmAvailable,
      skip_llm: false,
    },
  };
}

export default {
  classifyNewsBatch,
  classifyBatch,
  isWithinRecencyWindow,
  needsLlmRefine,
  newsItemHash,
  loadCache,
  writeCacheAtomic,
  stripCacheMeta,
  CACHE_PATH,
  CACHE_SCHEMA,
};
