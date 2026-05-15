/**
 * earningsLlmBatcher.js
 *
 * Orchestrates the earnings LLM signal across a whole calendar:
 *   - builds a hardened per-event context from the signals block + the
 *     SWS deep file's news / rewards / risks
 *   - hashes each context's STABLE inputs and consults a disk cache
 *     (data/catalysts/llm-signal-cache.json) — only un-cached events
 *     hit the model, so a typical refresh is ~95% cache hits
 *   - chunks the cache-misses into batches of ≤8 and runs them through
 *     the Groq → Gemini → heuristic chain (see earningsLlmSignal.js)
 *   - attaches `llm_signal` onto each event's signals block
 *
 * Cost: on the free Groq tier this is ~$0 even on a cold cache; the
 * hash cache means steady-state runs make a handful of calls at most.
 *
 * Runs LOCALLY inside refresh-earnings.mjs (between signal aggregation
 * and prediction) — never on a Vercel cron, never in CI (`--skip-llm`).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { buildNewsBlock, sanitiseText } from "./llmPromptHardener.js";
import { classifyBatch, heuristicClassify } from "./earningsLlmSignal.js";

const ROOT = process.cwd();
const DEEP_DIR = path.join(ROOT, "data", "sws", "deep");
const CACHE_PATH = path.join(ROOT, "data", "catalysts", "llm-signal-cache.json");

const DEFAULT_CHUNK_SIZE = 8;
const DEFAULT_CONCURRENCY = 4;
const CACHE_SCHEMA = "earnings-llm-cache-v1";
const CACHE_TTL_DAYS = 90;

/* ──────────────────── event-context builder ─────────────────────── */

function loadDeep(symbol, readSwsDeep) {
  if (typeof readSwsDeep === "function") return readSwsDeep(symbol);
  const p = path.join(DEEP_DIR, `${symbol}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Build the hardened LLM context for one signals-enriched event.
 * Pure given (event, swsDeep).
 */
export function buildEventContext(event, swsDeep) {
  const signals = event.signals || {};
  const upc = signals.sws_upcoming_earnings || {};
  const overview = (swsDeep && swsDeep.overview) || {};
  const { items: news } = buildNewsBlock(swsDeep && swsDeep.news, event.event_iso_date);

  const counterThesis = upc.counter_thesis || null;

  return {
    symbol: event.symbol,
    sector: signals.sector || event.sector || null,
    fiscal_quarter: event.fiscal_quarter || null,
    event_iso_date: event.event_iso_date || null,
    days_until: event.days_until ?? null,
    one_line: sanitiseText(upc.one_line, 200),
    counter_thesis_text: counterThesis ? sanitiseText(counterThesis.text, 300) : "",
    counter_thesis_bias: counterThesis ? counterThesis.verdict_bias || null : null,
    analyst_revisions: Array.isArray(upc.recent_analyst_revisions) ? upc.recent_analyst_revisions : [],
    rewards: Array.isArray(overview.rewards) ? overview.rewards.map((r) => sanitiseText(r, 160)).filter(Boolean) : [],
    risks: Array.isArray(overview.risks) ? overview.risks.map((r) => sanitiseText(r, 160)).filter(Boolean) : [],
    news,
  };
}

/**
 * Hash the STABLE inputs of an event context. The news window is
 * date-independent (see llmPromptHardener), so this hash is identical
 * on every run for a given event until its underlying SWS data
 * actually changes — making the cache key reliable.
 */
export function eventInputHash(ctx) {
  const newsKey = (ctx.news || []).map((n) => `${n.date}|${n.title}`).join("~");
  const canonical = [
    ctx.symbol,
    ctx.fiscal_quarter,
    ctx.event_iso_date,
    ctx.one_line,
    ctx.counter_thesis_text,
    ctx.counter_thesis_bias,
    newsKey,
  ].join("::");
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

/* ──────────────────────────── cache ─────────────────────────────── */

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return { schema_version: CACHE_SCHEMA, entries: {} };
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return j && j.entries ? j : { schema_version: CACHE_SCHEMA, entries: {} };
  } catch {
    return { schema_version: CACHE_SCHEMA, entries: {} };
  }
}

function writeCacheAtomic(cache) {
  const tmp = CACHE_PATH + ".tmp." + process.pid;
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CACHE_PATH);
}

// Worker-pool over chunk indices.
async function runChunks(chunks, fn, concurrency) {
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

/* ───────────────────────── orchestrator ─────────────────────────── */

/**
 * Attach `signals.llm_signal` to every event in a calendar.
 *
 * @param {Array}  events  signals-enriched events (post signalAggregator)
 * @param {object} [opts]
 * @param {boolean} [opts.skipLlm]   force the deterministic heuristic
 *                                   (CI / offline) — no network, no cache writes
 * @param {function} [opts.readSwsDeep]      inject for tests
 * @param {function} [opts.providerOverride] inject a fake LLM for tests
 * @param {number}  [opts.chunkSize]
 * @param {number}  [opts.concurrency]
 * @returns {Promise<{events, stats}>}
 */
export async function classifyBatchForCalendar(events, opts = {}) {
  if (!Array.isArray(events) || events.length === 0) {
    return { events: events || [], stats: { total: 0 } };
  }
  const chunkSize = Number.isFinite(opts.chunkSize) ? opts.chunkSize : DEFAULT_CHUNK_SIZE;
  const concurrency = Number.isFinite(opts.concurrency) ? opts.concurrency : DEFAULT_CONCURRENCY;

  // Build a context for every event. Skip LOW data_quality — the
  // predictor returns INSUFFICIENT_DATA for those, so an LLM signal
  // would never be read. (The batcher runs BEFORE prediction, so we
  // gate on data_quality, not the not-yet-computed verdict.)
  const contexts = events.map((e) => {
    if (!e || !e.symbol) return null;
    if (e.signals && e.signals.data_quality === "LOW") return null;
    return buildEventContext(e, loadDeep(e.symbol, opts.readSwsDeep));
  });

  // ── skip-llm: deterministic heuristic for everything, no cache I/O ──
  if (opts.skipLlm) {
    let n = 0;
    for (let i = 0; i < events.length; i++) {
      if (!contexts[i]) continue;
      events[i].signals = events[i].signals || {};
      events[i].signals.llm_signal = heuristicClassify(contexts[i]);
      n += 1;
    }
    return { events, stats: { total: events.length, classified: n, heuristic: n, cache_hits: 0, llm_calls: 0, skip_llm: true } };
  }

  // ── cache lookup ──
  const cache = loadCache();
  const hashes = contexts.map((c) => (c ? eventInputHash(c) : null));
  const missIdx = [];
  let cacheHits = 0;
  for (let i = 0; i < events.length; i++) {
    if (!contexts[i]) continue;
    const cached = cache.entries[hashes[i]];
    if (cached && cached.bias) {
      events[i].signals = events[i].signals || {};
      events[i].signals.llm_signal = stripCacheMeta(cached);
      cacheHits += 1;
    } else {
      missIdx.push(i);
    }
  }

  // ── chunk the misses, classify via the fallback chain ──
  const chunks = [];
  for (let i = 0; i < missIdx.length; i += chunkSize) {
    chunks.push(missIdx.slice(i, i + chunkSize));
  }
  let llmCalls = 0;
  let heuristicCount = 0;
  const nowIso = new Date().toISOString();

  const chunkResults = await runChunks(
    chunks,
    async (chunkIdxs) => {
      const ctxs = chunkIdxs.map((i) => contexts[i]);
      llmCalls += 1;
      const signals = await classifyBatch(ctxs, { providerOverride: opts.providerOverride });
      return { chunkIdxs, signals };
    },
    concurrency,
  );

  for (const { chunkIdxs, signals } of chunkResults) {
    chunkIdxs.forEach((eventIdx, j) => {
      const sig = signals[j] || heuristicClassify(contexts[eventIdx]);
      if (sig.classifier_provider === "heuristic") heuristicCount += 1;
      events[eventIdx].signals = events[eventIdx].signals || {};
      events[eventIdx].signals.llm_signal = sig;
      cache.entries[hashes[eventIdx]] = { ...sig, _cached_at: nowIso };
    });
  }

  // ── prune stale cache entries, write atomically ──
  pruneCache(cache, new Set(hashes.filter(Boolean)));
  cache.schema_version = CACHE_SCHEMA;
  cache.updated_at = nowIso;
  writeCacheAtomic(cache);

  return {
    events,
    stats: {
      total: events.length,
      classified: cacheHits + missIdx.length,
      cache_hits: cacheHits,
      llm_calls: llmCalls,
      heuristic: heuristicCount,
      skip_llm: false,
    },
  };
}

function stripCacheMeta(entry) {
  const { _cached_at, ...rest } = entry;
  return rest;
}

// Keep entries used this run, plus anything cached within the TTL.
function pruneCache(cache, usedHashes) {
  const cutoff = Date.now() - CACHE_TTL_DAYS * 86400000;
  for (const [hash, entry] of Object.entries(cache.entries)) {
    if (usedHashes.has(hash)) continue;
    const cachedMs = entry && entry._cached_at ? new Date(entry._cached_at).getTime() : 0;
    if (!Number.isFinite(cachedMs) || cachedMs < cutoff) delete cache.entries[hash];
  }
}
