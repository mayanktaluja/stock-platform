// Market Wire — LLM impact-signal cache (Phase 4).
//
// Cloned from services/riskLab/quality/llmDisagreementCache.js: schema-versioned,
// atomic tmp+rename write, stable content key. Per-machine and gitignored — the
// single wire cron host keeps it warm; production reads the finished wire from KV.
//
// [H2] The cache key is the cluster's STABLE anchor id ONLY (cluster.key). It
// deliberately excludes source_count and the member set, so a new corroborating
// source never invalidates a cached score — corroboration is applied as a rank
// multiplier OUTSIDE the cache (wireBuilder). This kills the thrash-vs-staleness
// dilemma: the LLM scores story CONTENT once; the builder layers recency and
// corroboration on top deterministically.
//
// [H1] The _last_provider_attempt tri-state (none|failed|below_floor|succeeded)
// plus _failed_at drive backoff: a quota-exhausted run must not freeze a cluster
// at "heuristic" forever, and a "failed" cluster must not be re-hammered every
// build during a sustained outage.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const DEFAULT_CACHE_PATH = path.join(REPO_ROOT, "data", "news-wire", "impact-cache.json");
export const CACHE_SCHEMA_VERSION = "news-wire-impact-cache-v1";
export const FAILED_RETRY_MS = 6 * 3600 * 1000; // a failed LLM attempt is retry-eligible after 6h
export const CACHE_TTL_MS = 4 * 24 * 3600 * 1000; // drop entries unused for 4 days

// Only these fields leave the cache to the wire output. Anything _-prefixed is
// internal bookkeeping and never surfaces.
export const SIGNAL_WIRE_FIELDS = [
  "direction", "impact", "confidence", "tickers", "sectors", "category", "why",
  "classifier_provider", "model_id", "signal_version", "generated_at",
];

function _hash(str) {
  return createHash("sha256").update(String(str || "")).digest("hex").slice(0, 24);
}

/**
 * Content-only cache key: the cluster's stable anchor id (cluster.key), which is
 * itself derived from the earliest member's channel|routerKey (a content hash).
 * Falls back to a hash of the representative text if key is somehow missing.
 */
export function buildCacheKey(cluster) {
  return String(cluster?.key || _hash(cluster?.representative || ""));
}

export function loadCache(cachePath = DEFAULT_CACHE_PATH) {
  if (!fs.existsSync(cachePath)) return { schema_version: CACHE_SCHEMA_VERSION, entries: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (parsed?.schema_version !== CACHE_SCHEMA_VERSION) {
      return { schema_version: CACHE_SCHEMA_VERSION, entries: {} }; // schema bump → cold flush
    }
    return parsed;
  } catch {
    return { schema_version: CACHE_SCHEMA_VERSION, entries: {} };
  }
}

export function saveCache(cache, cachePath = DEFAULT_CACHE_PATH) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache), "utf-8");
  fs.renameSync(tmp, cachePath);
}

export function getEntry(cache, key) {
  return cache?.entries?.[key] || null;
}

/**
 * Store a signal + provider-attempt bookkeeping.
 * @param providerAttempt one of "none"|"failed"|"below_floor"|"succeeded"
 */
export function setEntry(cache, key, signal, { providerAttempt = "succeeded", now = Date.now() } = {}) {
  if (!cache.entries) cache.entries = {};
  const prior = cache.entries[key] || {};
  const entry = {
    ...prior,
    ...signal,
    _cached_at: new Date(now).toISOString(),
    _last_used_at: now,
    _last_provider_attempt: providerAttempt,
  };
  if (providerAttempt === "failed") entry._failed_at = now;
  else delete entry._failed_at;
  cache.entries[key] = entry;
  return entry;
}

/** Touch an entry's last-used stamp so a still-relevant cluster survives prune. */
export function touch(cache, key, now = Date.now()) {
  if (cache?.entries?.[key]) cache.entries[key]._last_used_at = now;
}

/** A cached entry produced by a real LLM provider is a reusable hit. */
export function isFreshLlm(entry) {
  return !!entry && (entry.classifier_provider === "gemini" || entry.classifier_provider === "groq");
}

/** True while a failed LLM attempt is still inside its backoff window. */
export function failedRecently(entry, { now = Date.now(), failedRetryMs = FAILED_RETRY_MS } = {}) {
  return !!entry && entry._last_provider_attempt === "failed" &&
    Number.isFinite(entry._failed_at) && (now - entry._failed_at) < failedRetryMs;
}

/** Strip internal (_-prefixed) bookkeeping before the signal leaves the cache. */
export function stripCacheMeta(entry) {
  if (!entry) return null;
  const out = {};
  for (const f of SIGNAL_WIRE_FIELDS) if (f in entry) out[f] = entry[f];
  return out;
}

/** Drop entries not touched this run AND older than the TTL. */
export function pruneCache(cache, usedKeys, { ttlMs = CACHE_TTL_MS, now = Date.now() } = {}) {
  const used = usedKeys instanceof Set ? usedKeys : new Set(usedKeys || []);
  let pruned = 0;
  for (const [k, e] of Object.entries(cache.entries || {})) {
    if (used.has(k)) continue;
    const last = Number.isFinite(e?._last_used_at) ? e._last_used_at : 0;
    if (now - last > ttlMs) { delete cache.entries[k]; pruned += 1; }
  }
  return pruned;
}

export default {
  DEFAULT_CACHE_PATH, CACHE_SCHEMA_VERSION, FAILED_RETRY_MS, CACHE_TTL_MS, SIGNAL_WIRE_FIELDS,
  buildCacheKey, loadCache, saveCache, getEntry, setEntry, touch, isFreshLlm, failedRecently,
  stripCacheMeta, pruneCache,
};
