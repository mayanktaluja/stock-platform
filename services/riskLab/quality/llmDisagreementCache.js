// Hash-cached store for llmDisagreementChecker outputs (PR 2).
//
// Mirrors data/catalysts/llm-signal-cache.json — same shape, same atomic
// write pattern, same provider-attempt log so we can tell "groq said
// disagree=true on 2026-05-12" from "heuristic floor said no on 2026-05-19".
//
// Storage: data/risk-lab/llm-disagreement-cache.json
//
// Cache key (must be stable across runs — no "now()"):
//   sha256(ticker | predicted_verdict | counter_thesis_hash | news_window_hash | risks_hash)
//
// On read: cache hit returns the stored signal; cache miss returns null.
// On write: append-or-replace by key; flushAtomic to disk.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
export const DEFAULT_CACHE_PATH = path.join(REPO_ROOT, "data", "risk-lab", "llm-disagreement-cache.json");
export const CACHE_SCHEMA_VERSION = "risk-lab-llm-disagree-cache-v1";

function _hash(str) {
  return createHash("sha256").update(String(str || "")).digest("hex").slice(0, 24);
}

// Stable cache key — deliberately omits sector and confidence so a tiny
// confidence drift doesn't invalidate the whole row. The substantive
// inputs (counter_thesis text, news, risks) drive the hash.
export function buildCacheKey(input) {
  const ticker = String(input?.ticker || "").toUpperCase();
  const verdict = String(input?.predicted_verdict || "").toUpperCase();
  const counter = _hash(input?.counter_thesis_text || "");
  const risksJoin = Array.isArray(input?.risks)
    ? input.risks.map((r) => (typeof r === "string" ? r : r?.title || r?.body || "")).join("|")
    : "";
  const newsJoin = Array.isArray(input?.news)
    ? input.news.map((n) => `${n?.title || ""}::${(n?.body || "").slice(0, 200)}::${n?.date || ""}`).join("|")
    : "";
  const triggers = Array.isArray(input?.falsification_triggers)
    ? input.falsification_triggers.join("|")
    : "";
  return [ticker, verdict, counter, _hash(risksJoin), _hash(newsJoin), _hash(triggers)].join(":");
}

export function loadCache(cachePath = DEFAULT_CACHE_PATH) {
  if (!fs.existsSync(cachePath)) {
    return { schema_version: CACHE_SCHEMA_VERSION, entries: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (parsed?.schema_version !== CACHE_SCHEMA_VERSION) {
      // Schema migration: start fresh, don't try to massage old entries.
      return { schema_version: CACHE_SCHEMA_VERSION, entries: {} };
    }
    return parsed;
  } catch {
    return { schema_version: CACHE_SCHEMA_VERSION, entries: {} };
  }
}

export function saveCache(cache, cachePath = DEFAULT_CACHE_PATH) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
  fs.renameSync(tmp, cachePath);
}

export function getEntry(cache, key) {
  return cache?.entries?.[key] || null;
}

export function setEntry(cache, key, assessment) {
  if (!cache.entries) cache.entries = {};
  const prior = cache.entries[key] || {};
  cache.entries[key] = {
    ...prior,
    ...assessment,
    _cached_at: new Date().toISOString(),
    _last_provider_attempt: assessment.classifier_provider || prior._last_provider_attempt || null,
  };
  return cache.entries[key];
}

export function cacheStats(cache) {
  const entries = Object.values(cache?.entries || {});
  const providers = { gemini: 0, groq: 0, heuristic: 0, other: 0 };
  for (const e of entries) {
    const p = e.classifier_provider;
    if (providers[p] !== undefined) providers[p] += 1;
    else providers.other += 1;
  }
  const disagreed = entries.filter((e) => e.disagrees === true).length;
  return {
    total: entries.length,
    providers,
    disagreed_count: disagreed,
    disagreement_rate_pct: entries.length ? Math.round((disagreed / entries.length) * 1000) / 10 : null,
  };
}

export default {
  DEFAULT_CACHE_PATH,
  CACHE_SCHEMA_VERSION,
  buildCacheKey,
  loadCache,
  saveCache,
  getEntry,
  setEntry,
  cacheStats,
};
