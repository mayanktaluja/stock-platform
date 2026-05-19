// Batched LLM disagreement orchestrator (PR 2).
//
// Iterates the risk-lab universe, applies the V3≥50 floor, hits the cache,
// and only calls the LLM on the residue. The pattern is the same as
// services/earnings/earningsLlmBatcher.js — concurrency-bounded, never
// throws on individual failures, returns per-stock decisions + an
// aggregate stats block.

import {
  assessDisagreement,
  heuristicAssess,
  LLM_DISAGREE_VERSION,
} from "./llmDisagreementChecker.js";
import {
  buildCacheKey,
  getEntry,
  setEntry,
  loadCache,
  saveCache,
  cacheStats,
} from "./llmDisagreementCache.js";

export const V3_FLOOR = 50;
export const DEFAULT_CONCURRENCY = 4;

// Limit how many fresh LLM calls per run so a one-off big calendar can't
// blow through the free tier in a single invocation. The lab universe is
// ~1900 stocks; with V3≥50 floor + BEAT-only this typically drops to
// ~250-350 candidates, well inside Gemini's 1500 RPD.
export const DEFAULT_MAX_LLM_CALLS = 500;

async function _runWithConcurrency(items, fn, concurrency = DEFAULT_CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.max(1, concurrency); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

// Each row needs: ticker, predicted_verdict (must be BEAT for the LLM
// path; non-BEAT shortcircuits to disagrees=false), v3_score, plus the
// substrate text (counter_thesis_text, risks, news, falsification_triggers,
// quality_flags). The caller hydrates these from picks-latest + SWS deep.
export async function classifyBatch(rows, opts = {}) {
  const cachePath = opts.cachePath;
  const cache = opts.cache || loadCache(cachePath);
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const maxLlmCalls = opts.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;
  const v3Floor = opts.v3Floor ?? V3_FLOOR;
  const skipLlmAll = opts.skipLlm === true;

  const decisions = new Array(rows.length);
  const stats = {
    total: rows.length,
    eligible_beat: 0,
    below_v3_floor: 0,
    not_beat: 0,
    cache_hit: 0,
    cache_miss_attempted: 0,
    cache_miss_capped: 0,
    classifier_provider: { gemini: 0, groq: 0, heuristic: 0, other: 0 },
    disagreed: 0,
  };

  let freshCallsRemaining = maxLlmCalls;

  await _runWithConcurrency(
    rows,
    async (row, i) => {
      if (!row?.ticker) {
        decisions[i] = null;
        return;
      }
      const isBeat = String(row.predicted_verdict || "").toUpperCase() === "BEAT";
      if (!isBeat) {
        stats.not_beat += 1;
        decisions[i] = heuristicAssess(row, row.quality_flags || []);
        _bumpProvider(stats, decisions[i].classifier_provider);
        if (decisions[i].disagrees) stats.disagreed += 1;
        return;
      }

      const v3 = Number(row.v3_score ?? row.v3_score_100 ?? NaN);
      const belowFloor = Number.isFinite(v3) && v3 < v3Floor;
      if (belowFloor) {
        stats.below_v3_floor += 1;
        decisions[i] = heuristicAssess(row, row.quality_flags || []);
        _bumpProvider(stats, decisions[i].classifier_provider);
        if (decisions[i].disagrees) stats.disagreed += 1;
        return;
      }

      stats.eligible_beat += 1;

      const key = buildCacheKey(row);
      const cached = getEntry(cache, key);
      if (cached) {
        stats.cache_hit += 1;
        decisions[i] = cached;
        _bumpProvider(stats, cached.classifier_provider);
        if (cached.disagrees) stats.disagreed += 1;
        return;
      }

      if (skipLlmAll || freshCallsRemaining <= 0) {
        if (freshCallsRemaining <= 0) stats.cache_miss_capped += 1;
        decisions[i] = heuristicAssess(row, row.quality_flags || []);
        _bumpProvider(stats, decisions[i].classifier_provider);
        if (decisions[i].disagrees) stats.disagreed += 1;
        return;
      }

      freshCallsRemaining -= 1;
      stats.cache_miss_attempted += 1;
      const fresh = await assessDisagreement(row, row.quality_flags || []);
      decisions[i] = fresh;
      setEntry(cache, key, fresh);
      _bumpProvider(stats, fresh.classifier_provider);
      if (fresh.disagrees) stats.disagreed += 1;
    },
    concurrency,
  );

  if (!opts.skipCacheWrite) saveCache(cache, cachePath);

  return {
    signal_version: LLM_DISAGREE_VERSION,
    decisions,
    stats: {
      ...stats,
      cache_total: cacheStats(cache).total,
      disagreement_rate_pct: stats.total ? Math.round((stats.disagreed / stats.total) * 1000) / 10 : null,
    },
  };
}

function _bumpProvider(stats, provider) {
  const slot = stats.classifier_provider[provider] !== undefined ? provider : "other";
  stats.classifier_provider[slot] += 1;
}

export default { classifyBatch, V3_FLOOR, DEFAULT_CONCURRENCY, DEFAULT_MAX_LLM_CALLS };
