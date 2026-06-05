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
 *
 * Cache schema v2 (was v1): each entry now carries `_last_provider_attempt`
 * so the lookup can distinguish a "heuristic because keys were missing"
 * entry (eligible for re-classify the moment keys come back) from a
 * "heuristic because both LLMs failed at runtime" entry (keep until input
 * hash or TTL changes, otherwise we'd burn quota retrying the events most
 * likely to keep failing). v1 entries still parse — they're treated as
 * `"none"` attempts and get re-classified once on the next run with keys.
 * See PR after #247 for the cache-poisoning incident that motivated this.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { buildNewsBlock, sanitiseText } from "./llmPromptHardener.js";
import { classifyBatch, heuristicClassify } from "./earningsLlmSignal.js";

const ROOT = process.cwd();
const DEEP_DIR = path.join(ROOT, "data", "sws", "deep");
export const CACHE_PATH = path.join(ROOT, "data", "catalysts", "llm-signal-cache.json");

const DEFAULT_CHUNK_SIZE = 8;
// Concurrency 2 (was 4) — Gemini-2.5-flash free tier is ~15 RPM. With
// chunk size 8 and ~100+ chunks on a cold cache, concurrency 4 would
// burst past the per-minute ceiling → 429s → fallback to heuristic, which
// the new cache-invalidation logic would then keep retrying. Two
// concurrent chunks stay comfortably under provider limits even on cold
// caches and still finish a ~100-chunk run in ~60s.
const DEFAULT_CONCURRENCY = 2;
export const CACHE_SCHEMA = "earnings-llm-cache-v2";
const CACHE_TTL_DAYS = 90;
// "failed" attempts are kept for FAILED_RETRY_MS so we don't loop on
// events the LLM is actively failing on (a per-minute Gemini 429 or a
// Groq TPD that clears in ~25min). After this window, a failed entry
// is eligible for re-classification — daily quota will have fully
// reset, so a stuck-at-the-end-of-yesterday's-window snapshot can
// recover on tomorrow's run. Without this, ONE quota-exhausted refresh
// permanently freezes the cache at heuristic for that event.
const FAILED_RETRY_MS = 24 * 60 * 60 * 1000;

// Composite floor — only events whose underlying stock has a V4 100-pt
// composite score >= V3_COMPOSITE_FLOOR are sent to the (paid / rate-limited)
// LLM. 47 = the V4 STRONG cutoff (~top 25%), recalibrated from the old V3 50
// in the 2026-05 migration to keep the LLM budget tight on the lower V4
// distribution (V4 median ~37). Stocks below the floor are platform-disliked
// on fundamentals; spending scarce free-tier Gemini RPM / Groq TPD on them is
// wasted budget. They still get a deterministic heuristic signal. Field:
// event.signals.v4.v4_score_100. A temporary v3 alias is accepted for old
// event snapshots. Fail-closed: null/missing → below floor.
const V3_COMPOSITE_FLOOR = 47;
export function meetsLlmCompositeFloor(event, floor = V3_COMPOSITE_FLOOR) {
  const score = event?.signals?.v4?.v4_score_100 ?? event?.signals?.v3?.v3_score_100;
  return typeof score === "number" && score >= floor;
}

// Whitelist of fields that constitute the wire contract for an llm_signal.
// Anything starting with "_" is treated as internal cache metadata and is
// stripped before the entry is attached to an event. Maintaining this as
// an explicit list (vs blacklisting `_cached_at`) means future internal
// fields like `_last_provider_attempt` never accidentally leak into
// data/catalysts/earnings-watch-latest.json.
const SIGNAL_WIRE_FIELDS = [
  "bias",
  "confidence_delta_pct",
  "top_reason",
  "top_risk",
  "classifier_provider",
  "model_id",
  "signal_version",
  "generated_at",
];

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

// Optional path override on both helpers so unit tests can point at a
// tmpdir without trampling the real cache. Production callers omit `p`.
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
 * @param {boolean} [opts.llmAvailable] override env-key detection (tests inject true/false
 *                                      so behaviour is independent of contributor shell env)
 * @param {string}  [opts.cachePath]    override cache file path (tests point at a tmpdir)
 * @param {number}  [opts.compositeFloor] V3 composite floor below which events
 *                                        are routed to heuristic instead of the
 *                                        LLM (default V3_COMPOSITE_FLOOR = 50)
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
  // Injectable so unit tests can pin behaviour regardless of the shell env
  // they happen to run in. Production callers leave this undefined and
  // we read process.env.
  const llmAvailable = opts.llmAvailable ?? !!(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY);
  const compositeFloor = Number.isFinite(opts.compositeFloor) ? opts.compositeFloor : V3_COMPOSITE_FLOOR;
  const meetsFloor = (event) => meetsLlmCompositeFloor(event, compositeFloor);

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
    return {
      events,
      stats: {
        total: events.length,
        classified: n,
        heuristic: n,
        cache_hits: 0,
        llm_calls: 0,
        heuristic_cache_invalidations: 0,
        skip_llm: true,
      },
    };
  }

  // ── cache lookup ──
  // A cached entry is a hit unless it's a "stale heuristic":
  //   classifier_provider === "heuristic"
  //   AND LLM is available now
  //   AND the prior attempt was NOT "failed" (i.e. the LLM never actually
  //       ran — entry came from a no-keys run or is a pre-v2 entry).
  // Failed-LLM heuristics keep their slot so we don't infinite-loop
  // retrying the events most likely to keep timing out.
  const cachePath = opts.cachePath || CACHE_PATH;
  const cache = loadCache(cachePath);
  const hashes = contexts.map((c) => (c ? eventInputHash(c) : null));
  const missIdx = [];
  let cacheHits = 0;
  let heuristicCacheInvalidations = 0;
  let crossFloorInvalidations = 0;
  const nowMs = Date.now();
  for (let i = 0; i < events.length; i++) {
    if (!contexts[i]) continue;
    const cached = cache.entries[hashes[i]];
    const isCachedHeuristic = cached && cached.classifier_provider === "heuristic";
    // Pre-v2 entries have no `_last_provider_attempt`; treat undefined as "none"
    // (the cautious default — invalidate once, re-classify with the LLM, and
    // the next write stamps the real attempt outcome).
    const priorAttempt = cached && cached._last_provider_attempt;
    const cachedMs = cached && cached._cached_at ? new Date(cached._cached_at).getTime() : 0;
    const failedRetryEligible = priorAttempt === "failed"
      && Number.isFinite(cachedMs)
      && (nowMs - cachedMs) >= FAILED_RETRY_MS;
    // Layer I — floor-crossing invalidation: if the event was cached as
    // "below_floor" and its V3 score has now crossed up to >= floor, the
    // LLM should get to refine it. Below-floor heuristics for events that
    // are STILL below the floor remain valid hits (don't waste cycles).
    const crossedFloorUp = priorAttempt === "below_floor" && meetsFloor(events[i]);
    // Invalidate when (a) we never tried the LLM (no keys / pre-v2 entry),
    // OR (b) we tried + failed >= FAILED_RETRY_MS ago (quota windows have
    // reset; safe to retry).
    // OR (c) the event crossed the V3 floor upward and we can now afford
    //         a real LLM read.
    const isStaleHeuristic = isCachedHeuristic && llmAvailable && (
      priorAttempt === "none" || priorAttempt === undefined ||
      (priorAttempt === "failed" && failedRetryEligible) ||
      crossedFloorUp
    );
    if (cached && cached.bias && !isStaleHeuristic) {
      events[i].signals = events[i].signals || {};
      events[i].signals.llm_signal = stripCacheMeta(cached);
      cacheHits += 1;
    } else {
      if (isStaleHeuristic) heuristicCacheInvalidations += 1;
      if (crossedFloorUp) crossFloorInvalidations += 1;
      missIdx.push(i);
    }
  }

  // ── Layer I — split misses by V3 composite floor ──
  // Above-floor: go through the LLM chunk-classify path (paid signal).
  // Below-floor: skip the LLM entirely, run heuristic locally, stamp
  // `_last_provider_attempt: "below_floor"` so subsequent runs know NOT
  // to re-attempt (unless the score crosses the floor upward — see the
  // crossedFloorUp check above).
  const llmMissIdx = [];
  const belowFloorIdx = [];
  for (const i of missIdx) {
    if (meetsFloor(events[i])) llmMissIdx.push(i);
    else belowFloorIdx.push(i);
  }

  let llmCalls = 0;
  let heuristicCount = 0;
  let belowFloorCount = belowFloorIdx.length;
  const nowIso = new Date().toISOString();

  // Below-floor: synchronous heuristic + cache stamp. No network, no provider.
  for (const eventIdx of belowFloorIdx) {
    const sig = heuristicClassify(contexts[eventIdx]);
    heuristicCount += 1;
    events[eventIdx].signals = events[eventIdx].signals || {};
    events[eventIdx].signals.llm_signal = stripCacheMeta(sig);
    cache.entries[hashes[eventIdx]] = {
      ...sig,
      _cached_at: nowIso,
      _last_provider_attempt: "below_floor",
    };
  }

  // Above-floor: existing chunk-classify path.
  const chunks = [];
  for (let i = 0; i < llmMissIdx.length; i += chunkSize) {
    chunks.push(llmMissIdx.slice(i, i + chunkSize));
  }

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
      events[eventIdx].signals.llm_signal = stripCacheMeta(sig);
      // Stamp `_last_provider_attempt` so a future run knows whether
      // this heuristic came from no-keys or from a real LLM failure.
      cache.entries[hashes[eventIdx]] = {
        ...sig,
        _cached_at: nowIso,
        _last_provider_attempt:
          sig.classifier_provider === "heuristic"
            ? (llmAvailable ? "failed" : "none")
            : "succeeded",
      };
    });
  }

  // ── prune stale cache entries, write atomically ──
  pruneCache(cache, new Set(hashes.filter(Boolean)));
  cache.schema_version = CACHE_SCHEMA;
  cache.updated_at = nowIso;
  writeCacheAtomic(cache, cachePath);

  return {
    events,
    stats: {
      total: events.length,
      classified: cacheHits + missIdx.length,
      cache_hits: cacheHits,
      llm_calls: llmCalls,
      heuristic: heuristicCount,
      heuristic_cache_invalidations: heuristicCacheInvalidations,
      cross_floor_invalidations: crossFloorInvalidations,
      below_v3_floor: belowFloorCount,
      composite_floor: compositeFloor,
      llm_available: llmAvailable,
      skip_llm: false,
    },
  };
}

// Whitelist-based — preserves only documented signal wire fields, drops
// internal metadata (`_cached_at`, `_last_provider_attempt`, anything
// added in future). Exported for the unit tests.
export function stripCacheMeta(entry) {
  const out = {};
  for (const k of SIGNAL_WIRE_FIELDS) {
    if (entry[k] !== undefined) out[k] = entry[k];
  }
  return out;
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
