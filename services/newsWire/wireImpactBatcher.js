// Market Wire — LLM triage batcher (Phase 4).
//
// Cloned from services/earnings/earningsLlmBatcher.js (chunk + concurrency pool +
// cache tri-state), but re-ordered to fix the adversarial H1 finding: the earnings
// floor gate opens the LLM floodgates during a storm because `breaking` correlates
// with storms. Here the builder ranks the WHOLE set on the cheap heuristic first,
// then this batcher LLM-refines only the top-N that clear a relevance floor —
// spend is bounded by a hard per-build cap (MAX_LLM_CLUSTERS), not by how many
// clusters happen to be breaking.
//
// [H2] The LLM scores story CONTENT only; corroboration/recency are layered on at
// rank time (wireBuilder), so the content cache key is stable and a new source
// never triggers a re-call. [H1] A `failed` cache entry backs off (FAILED_RETRY_MS)
// instead of being re-hammered every build.

import { heuristicClassifyCluster } from "./wireHeuristic.js";
import { buildClusterContext, classifyWireBatch, wireLlmAvailable } from "./wireImpactSignal.js";
import {
  DEFAULT_CACHE_PATH, buildCacheKey, loadCache, saveCache, getEntry, setEntry,
  touch, isFreshLlm, failedRecently, stripCacheMeta, pruneCache, FAILED_RETRY_MS,
} from "./wireImpactCache.js";

// Requests/day is the cap that actually binds on the Gemini free tier (Google
// deleted the published RPD table on 2025-12-06 — the live number is auth-gated
// and unknowable from outside, so plan against the ceiling, not a guess).
//
// The build cron fires ~228×/day (5-min interval over the 19h IST active window).
// chunkSize 18 means ceil(18/18) = ONE request per build instead of three:
// worst case 684 → 228 RPD at IDENTICAL cluster coverage, and FEWER total tokens
// (the system prompt is paid once per build, not three times). Lowering
// MAX_LLM_CLUSTERS would hit the same RPD by dropping 10 clusters to the
// heuristic — strictly worse. In steady state the content-keyed cache means most
// builds fire zero requests anyway.
//
// All three are env-tunable so the cadence can be throttled without a deploy.
export const MAX_LLM_CLUSTERS = Number(process.env.WIRE_MAX_LLM_CLUSTERS) || 18;
export const DEFAULT_CHUNK_SIZE = Number(process.env.WIRE_LLM_CHUNK_SIZE) || 18;
export const DEFAULT_CONCURRENCY = Number(process.env.WIRE_LLM_CONCURRENCY) || 2;

/**
 * Relevance floor — only corroborated / breaking / watchlist-tagged clusters are
 * worth an LLM call. Singletons from noisy channels get the heuristic floor.
 */
export function meetsWireFloor(cluster) {
  return (Number(cluster?.source_count) || 0) >= 2 ||
    !!cluster?.breaking ||
    (Array.isArray(cluster?.symbols) && cluster.symbols.length > 0);
}

/** Simple index-cursor worker pool (concurrency-capped). */
async function runChunks(chunks, fn, concurrency = DEFAULT_CONCURRENCY) {
  const out = new Array(chunks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < chunks.length) {
      const i = cursor;
      cursor += 1;
      out[i] = await fn(chunks[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return out;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * classifyClusters(rankedClusters, opts) → { signalsByKey: Map, stats }
 *
 * rankedClusters MUST be best-first (the builder ranks on the heuristic pass).
 * Walks them in rank order and LLM-refines the first MAX_LLM_CLUSTERS that clear
 * the floor and aren't a fresh cache hit / recent failure; everything else uses
 * the heuristic (cache-stamped so it can be promoted on a future build).
 */
export async function classifyClusters(rankedClusters, {
  heuristicByKey = null,
  skipLlm = false,
  llmAvailable = null,
  classifyFn = classifyWireBatch,
  providerOverride = null,
  cachePath = DEFAULT_CACHE_PATH,
  maxLlm = MAX_LLM_CLUSTERS,
  chunkSize = DEFAULT_CHUNK_SIZE,
  concurrency = DEFAULT_CONCURRENCY,
  failedRetryMs = FAILED_RETRY_MS,
  now = Date.now(),
} = {}) {
  const clusters = Array.isArray(rankedClusters) ? rankedClusters : [];
  const signalsByKey = new Map();
  const heur = (c) => (heuristicByKey && heuristicByKey.get(c.key)) || heuristicClassifyCluster(c, { now });
  const stats = { clusters: clusters.length, llm_calls: 0, cache_hits: 0, heuristic: 0, below_floor: 0, failed: 0, provider: skipLlm ? "skipped" : "heuristic" };

  // The LLM runs only when NOT skipped AND either a test override is injected or
  // real providers are configured. classifyWireBatch itself floors to heuristic,
  // so this gate just avoids the pointless chunk machinery when no keys exist.
  const effectiveAvailable = llmAvailable === null ? wireLlmAvailable() : llmAvailable;
  const canLlm = !skipLlm && (providerOverride != null || effectiveAvailable);
  const cache = skipLlm ? null : loadCache(cachePath);
  const usedKeys = new Set();

  // Select clusters for a live LLM call, in rank order, up to the cap.
  const selected = [];
  for (const c of clusters) {
    const key = buildCacheKey(c);
    usedKeys.add(key);
    const entry = cache ? getEntry(cache, key) : null;

    if (!skipLlm && isFreshLlm(entry)) {
      // Reuse a prior real-LLM score (content-stable key → corroboration handled at rank).
      signalsByKey.set(c.key, stripCacheMeta(entry));
      if (cache) touch(cache, key, now);
      stats.cache_hits += 1;
      continue;
    }
    if (canLlm && meetsWireFloor(c) && selected.length < maxLlm && !failedRecently(entry, { now, failedRetryMs })) {
      selected.push({ cluster: c, key });
      continue;
    }
    // Heuristic for this build. Stamp intent so a future build can promote it.
    const sig = heur(c);
    signalsByKey.set(c.key, sig);
    stats.heuristic += 1;
    if (cache) {
      if (failedRecently(entry, { now, failedRetryMs })) { /* keep failed backoff */ touch(cache, key, now); }
      else if (!meetsWireFloor(c)) { setEntry(cache, key, sig, { providerAttempt: "below_floor", now }); stats.below_floor += 1; }
      else setEntry(cache, key, sig, { providerAttempt: "none", now }); // above floor, out of budget — retry next build
    } else if (!meetsWireFloor(c)) {
      stats.below_floor += 1;
    }
  }

  // Run the selected clusters through the LLM in chunks (bounded fan-out).
  if (selected.length) {
    const chunks = chunkArray(selected, chunkSize);
    const results = await runChunks(chunks, async (chunk) => {
      const ctxs = chunk.map((s) => buildClusterContext(s.cluster));
      const res = await classifyFn(ctxs, { providerOverride, now });
      return { chunk, res };
    }, concurrency);

    for (const { chunk, res } of results) {
      const real = res.provider === "gemini" || res.provider === "groq";
      if (real) stats.llm_calls += 1;
      if (res.failed) stats.failed += 1;
      chunk.forEach((s, i) => {
        const sig = res.signals[i] || heur(s.cluster);
        signalsByKey.set(s.cluster.key, sig);
        if (real) setEntry(cache, s.key, sig, { providerAttempt: "succeeded", now });
        else if (res.failed) { setEntry(cache, s.key, sig, { providerAttempt: "failed", now }); stats.heuristic += 1; }
        else { setEntry(cache, s.key, sig, { providerAttempt: "none", now }); stats.heuristic += 1; }
      });
    }
    stats.provider = results.find((r) => r.res.provider === "gemini" || r.res.provider === "groq")?.res.provider || "heuristic";
  } else if (!skipLlm && stats.cache_hits > 0) {
    // Everything was already scored by a real provider — say so rather than
    // reporting "heuristic", which would misread as a quality degradation.
    stats.provider = "cache";
  }

  if (cache) {
    pruneCache(cache, usedKeys, { now });
    try { saveCache(cache, cachePath); } catch (e) { console.warn(`[wire-llm] cache save failed: ${e?.message || e}`); }
  }

  return { signalsByKey, stats };
}

export default { classifyClusters, meetsWireFloor, MAX_LLM_CLUSTERS, DEFAULT_CHUNK_SIZE, DEFAULT_CONCURRENCY };
