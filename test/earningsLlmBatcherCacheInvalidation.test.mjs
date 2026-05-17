// Cache-invalidation behaviour of earningsLlmBatcher (post-#247 fix).
//
// The bug this test pins down: before the fix, a heuristic cache entry
// (classifier_provider === "heuristic") was always served back as a hit,
// even when the LLM tier had become available again. So a single nightly
// run with broken env-loading would poison the cache with up to 90 days
// of stale heuristic entries, silently masking a broken LLM lever.
//
// The fix differentiates two kinds of cached heuristic:
//   - "_last_provider_attempt: 'none'"   → no keys at write time;
//                                          INVALIDATE when LLM available
//   - "_last_provider_attempt: 'failed'" → both LLMs ran and errored;
//                                          PRESERVE so we don't loop on the
//                                          events most likely to keep failing
//   - missing (pre-v2 entries)           → treated as "none" once, gets a
//                                          fresh attempt + stamp on next run
//
// Tests use a tmpdir cache + an injectable `llmAvailable` so behaviour is
// independent of contributor shell env. `providerOverride` returns a real
// groq-flavoured signal so we can prove the LLM tier was actually called.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  classifyBatchForCalendar,
  stripCacheMeta,
  CACHE_SCHEMA,
  loadCache,
  writeCacheAtomic,
  meetsLlmCompositeFloor,
} from "../services/earnings/earningsLlmBatcher.js";

let ok = 0, fail = 0;
const tests = [];
function it(name, fn) { tests.push({ name, fn }); }

/* ───────────────────── shared fixtures ──────────────────────────── */

const sampleEvent = {
  symbol: "TESTCO",
  event_iso_date: "2026-05-20",
  fiscal_quarter: "Q4-2026",
  days_until: 3,
  sector: "IT",
  signals: {
    data_quality: "HIGH",
    sector: "IT",
    v3: { v3_score_100: 75, v3_verdict: "BUY" },  // above the 50 floor by default
    sws_upcoming_earnings: {
      one_line: "Strong order book and margin tailwinds expected.",
      counter_thesis: { text: "Slowing US BFSI demand", verdict_bias: "lean_miss" },
      recent_analyst_revisions: [{ direction: "up" }],
    },
  },
};

function withV3(event, score) {
  return {
    ...event,
    signals: { ...event.signals, v3: score == null ? null : { v3_score_100: score, v3_verdict: "BUY" } },
  };
}

const sampleDeep = {
  overview: { rewards: ["Trading below FV"], risks: ["Customer concentration"] },
  news: [],
};

function tmpCachePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earnings-llm-cache-"));
  return path.join(dir, "llm-signal-cache.json");
}

function seedCache(cachePath, entries) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  writeCacheAtomic({ schema_version: CACHE_SCHEMA, entries }, cachePath);
}

// Build the canonical hash for the sample event by running one classify
// pass with an empty cache and pulling the hash off the resulting cache
// file. Avoids re-importing eventInputHash and re-deriving the canonical
// context — the test stays robust if the hash inputs ever change.
async function computeSampleHash(cachePath, providerCalled) {
  const events = [structuredClone(sampleEvent)];
  await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: providerCalled ? makeGroqProvider() : undefined,
    readSwsDeep: () => sampleDeep,
  });
  const cache = loadCache(cachePath);
  const hashes = Object.keys(cache.entries);
  assert.equal(hashes.length, 1, "expected exactly one cache entry after seed pass");
  return hashes[0];
}

// Returns a `providerOverride` fn that yields a groq-flavoured signal for
// every context AND counts how many times it was called. The counter is
// the test's primary "did the LLM actually fire?" probe.
function makeGroqProvider() {
  const fn = async (ctxs) => {
    fn.calls += 1;
    return ctxs.map(() => ({
      bias: "lean_beat",
      confidence_delta_pct: 4,
      top_reason: "fake LLM positive read",
      top_risk: "fake LLM caution",
      classifier_provider: "groq",
      model_id: "fake-groq-model",
      signal_version: "earnings-llm-test",
      generated_at: new Date().toISOString(),
    }));
  };
  fn.calls = 0;
  return fn;
}

/* ───────────────────── Layer A — invalidation ──────────────────── */

console.log("[1] heuristic-from-no-keys IS invalidated when LLM becomes available");
it("invalidates _last_provider_attempt: 'none' heuristic when llmAvailable=true", async () => {
  const cachePath = tmpCachePath();
  // First seed the cache with a heuristic entry tagged as "none" (the
  // shape produced by a previous run without LLM keys loaded).
  const hash = await computeSampleHash(cachePath, false);
  seedCache(cachePath, {
    [hash]: {
      bias: "neutral",
      confidence_delta_pct: 0,
      top_reason: "no clear catalyst",
      top_risk: "no clear risk",
      classifier_provider: "heuristic",
      model_id: "heuristic-v2",
      signal_version: "earnings-llm-v1-2026-05",
      generated_at: new Date().toISOString(),
      _cached_at: new Date().toISOString(),
      _last_provider_attempt: "none",
    },
  });

  const events = [structuredClone(sampleEvent)];
  const provider = makeGroqProvider();
  const { stats } = await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: provider,
    readSwsDeep: () => sampleDeep,
  });

  assert.equal(provider.calls, 1, "provider must be invoked (cache hit was suppressed)");
  assert.equal(stats.cache_hits, 0);
  assert.equal(stats.llm_calls, 1);
  assert.equal(stats.heuristic_cache_invalidations, 1);
  assert.equal(events[0].signals.llm_signal.classifier_provider, "groq");

  // Cache now holds a "succeeded" entry, not the seeded heuristic.
  const post = loadCache(cachePath);
  assert.equal(post.entries[hash]._last_provider_attempt, "succeeded");
  assert.equal(post.entries[hash].classifier_provider, "groq");
});

console.log("[2] heuristic-from-failed-LLM is PRESERVED (no infinite loop)");
it("keeps _last_provider_attempt: 'failed' heuristic as a hit even when LLM is available", async () => {
  const cachePath = tmpCachePath();
  const hash = await computeSampleHash(cachePath, false);
  seedCache(cachePath, {
    [hash]: {
      bias: "neutral",
      confidence_delta_pct: 0,
      top_reason: "no clear catalyst",
      top_risk: "no clear risk",
      classifier_provider: "heuristic",
      model_id: "heuristic-v2",
      signal_version: "earnings-llm-v1-2026-05",
      generated_at: new Date().toISOString(),
      _cached_at: new Date().toISOString(),
      _last_provider_attempt: "failed",
    },
  });

  const events = [structuredClone(sampleEvent)];
  const provider = makeGroqProvider();
  const { stats } = await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: provider,
    readSwsDeep: () => sampleDeep,
  });

  assert.equal(provider.calls, 0, "provider must NOT be invoked — the heuristic was from a real LLM failure");
  assert.equal(stats.cache_hits, 1);
  assert.equal(stats.llm_calls, 0);
  assert.equal(stats.heuristic_cache_invalidations, 0);
  assert.equal(events[0].signals.llm_signal.classifier_provider, "heuristic");
});

console.log("[2b] 'failed' attempts older than 24h ARE retried (quota windows reset)");
it("invalidates a stale 'failed' heuristic when _cached_at >= 24h ago (quota reset boundary)", async () => {
  const cachePath = tmpCachePath();
  const hash = await computeSampleHash(cachePath, false);
  const longAgoIso = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  seedCache(cachePath, {
    [hash]: {
      bias: "neutral",
      confidence_delta_pct: 0,
      top_reason: "no clear catalyst",
      top_risk: "no clear risk",
      classifier_provider: "heuristic",
      model_id: "heuristic-v2",
      signal_version: "earnings-llm-v1-2026-05",
      generated_at: longAgoIso,
      _cached_at: longAgoIso,         // 25h ago
      _last_provider_attempt: "failed",
    },
  });

  const events = [structuredClone(sampleEvent)];
  const provider = makeGroqProvider();
  const { stats } = await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: provider,
    readSwsDeep: () => sampleDeep,
  });

  assert.equal(provider.calls, 1, "failed attempts older than 24h must be retried");
  assert.equal(stats.heuristic_cache_invalidations, 1);
  const post = loadCache(cachePath);
  assert.equal(post.entries[hash]._last_provider_attempt, "succeeded");
});

console.log("[3] heuristic served as hit when LLM is NOT available (offline/no-keys)");
it("treats heuristic cache as valid when llmAvailable=false, regardless of _last_provider_attempt", async () => {
  const cachePath = tmpCachePath();
  const hash = await computeSampleHash(cachePath, false);
  // Tag as "none" — would normally invalidate, but llmAvailable=false should win.
  seedCache(cachePath, {
    [hash]: {
      bias: "neutral",
      confidence_delta_pct: 0,
      top_reason: "no clear catalyst",
      top_risk: "no clear risk",
      classifier_provider: "heuristic",
      model_id: "heuristic-v2",
      signal_version: "earnings-llm-v1-2026-05",
      generated_at: new Date().toISOString(),
      _cached_at: new Date().toISOString(),
      _last_provider_attempt: "none",
    },
  });

  const events = [structuredClone(sampleEvent)];
  const provider = makeGroqProvider();
  const { stats } = await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: false,
    providerOverride: provider,
    readSwsDeep: () => sampleDeep,
  });

  assert.equal(provider.calls, 0);
  assert.equal(stats.cache_hits, 1);
  assert.equal(stats.heuristic_cache_invalidations, 0);
});

console.log("[4] non-heuristic cached entry (groq/gemini) is ALWAYS a hit");
it("groq cache entry is a hit even when LLM is available (no needless re-classification)", async () => {
  const cachePath = tmpCachePath();
  const hash = await computeSampleHash(cachePath, false);
  seedCache(cachePath, {
    [hash]: {
      bias: "lean_beat",
      confidence_delta_pct: 4,
      top_reason: "real LLM read from a prior run",
      top_risk: "real LLM risk",
      classifier_provider: "groq",
      model_id: "groq-model",
      signal_version: "earnings-llm-v1-2026-05",
      generated_at: new Date().toISOString(),
      _cached_at: new Date().toISOString(),
      _last_provider_attempt: "succeeded",
    },
  });

  const events = [structuredClone(sampleEvent)];
  const provider = makeGroqProvider();
  const { stats } = await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: provider,
    readSwsDeep: () => sampleDeep,
  });

  assert.equal(provider.calls, 0);
  assert.equal(stats.cache_hits, 1);
  assert.equal(events[0].signals.llm_signal.classifier_provider, "groq");
});

console.log("[5] pre-v2 heuristic entry (missing _last_provider_attempt) is treated as 'none'");
it("pre-v2 heuristic entry is invalidated once when llmAvailable=true", async () => {
  const cachePath = tmpCachePath();
  const hash = await computeSampleHash(cachePath, false);
  seedCache(cachePath, {
    [hash]: {
      bias: "neutral",
      confidence_delta_pct: 0,
      top_reason: "no clear catalyst",
      top_risk: "no clear risk",
      classifier_provider: "heuristic",
      model_id: "heuristic-v1",
      signal_version: "earnings-llm-v1-2026-05",
      generated_at: new Date().toISOString(),
      _cached_at: new Date().toISOString(),
      // intentionally NO _last_provider_attempt — simulates pre-v2 entries
    },
  });

  const events = [structuredClone(sampleEvent)];
  const provider = makeGroqProvider();
  const { stats } = await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: provider,
    readSwsDeep: () => sampleDeep,
  });

  assert.equal(provider.calls, 1, "pre-v2 entries must be re-classified once when LLM is available");
  assert.equal(stats.heuristic_cache_invalidations, 1);
});

/* ───────────────────── _last_provider_attempt stamping ─────────── */

console.log("[6] cache writes stamp _last_provider_attempt: 'succeeded' on LLM success");
it("successful LLM classification writes _last_provider_attempt='succeeded'", async () => {
  const cachePath = tmpCachePath();
  const events = [structuredClone(sampleEvent)];
  await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: makeGroqProvider(),
    readSwsDeep: () => sampleDeep,
  });
  const post = loadCache(cachePath);
  const entry = Object.values(post.entries)[0];
  assert.equal(entry._last_provider_attempt, "succeeded");
});

console.log("[7] cache writes stamp 'none' when llmAvailable=false");
it("heuristic from llmAvailable=false stamps _last_provider_attempt='none'", async () => {
  const cachePath = tmpCachePath();
  const events = [structuredClone(sampleEvent)];
  // No providerOverride — falls through to heuristicClassify. But the
  // batcher itself doesn't gate on llmAvailable inside the chunked-misses
  // path (the gate is on the cache lookup), so the LLM IS attempted via
  // providerOverride. To simulate the no-keys case for the stamp test we
  // give a provider that returns a heuristic-tagged signal, which is what
  // earningsLlmSignal.classifyBatch would produce when both clients are
  // null.
  const heuristicProvider = async (ctxs) => ctxs.map(() => ({
    bias: "neutral",
    confidence_delta_pct: 0,
    top_reason: "no clear catalyst",
    top_risk: "no clear risk",
    classifier_provider: "heuristic",
    model_id: "heuristic-v2",
    signal_version: "earnings-llm-v1-2026-05",
    generated_at: new Date().toISOString(),
  }));
  await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: false,
    providerOverride: heuristicProvider,
    readSwsDeep: () => sampleDeep,
  });
  const post = loadCache(cachePath);
  const entry = Object.values(post.entries)[0];
  assert.equal(entry.classifier_provider, "heuristic");
  assert.equal(entry._last_provider_attempt, "none");
});

console.log("[8] cache writes stamp 'failed' when llmAvailable=true but heuristic returned");
it("heuristic returned from a provider with llmAvailable=true stamps 'failed'", async () => {
  const cachePath = tmpCachePath();
  const events = [structuredClone(sampleEvent)];
  // The provider simulates an LLM-failure-fallback by returning a
  // heuristic-tagged signal even though llmAvailable=true.
  const failedProvider = async (ctxs) => ctxs.map(() => ({
    bias: "neutral",
    confidence_delta_pct: 0,
    top_reason: "no clear catalyst",
    top_risk: "no clear risk",
    classifier_provider: "heuristic",
    model_id: "heuristic-v2",
    signal_version: "earnings-llm-v1-2026-05",
    generated_at: new Date().toISOString(),
  }));
  await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: failedProvider,
    readSwsDeep: () => sampleDeep,
  });
  const post = loadCache(cachePath);
  const entry = Object.values(post.entries)[0];
  assert.equal(entry.classifier_provider, "heuristic");
  assert.equal(entry._last_provider_attempt, "failed");
});

/* ───────────────────── stripCacheMeta whitelist ────────────────── */

console.log("[9] stripCacheMeta whitelist drops internal fields");
it("stripCacheMeta drops _cached_at, _last_provider_attempt, and any future _-prefixed fields", () => {
  const entry = {
    bias: "lean_beat",
    confidence_delta_pct: 4,
    top_reason: "x",
    top_risk: "y",
    classifier_provider: "groq",
    model_id: "groq-model",
    signal_version: "earnings-llm-v1-2026-05",
    generated_at: "2026-05-17T12:00:00.000Z",
    _cached_at: "2026-05-17T12:00:00.000Z",
    _last_provider_attempt: "succeeded",
    _internal_future_field: "should also be dropped",
  };
  const wire = stripCacheMeta(entry);
  assert.equal(wire._cached_at, undefined);
  assert.equal(wire._last_provider_attempt, undefined);
  assert.equal(wire._internal_future_field, undefined);
  // Documented wire fields are preserved
  assert.equal(wire.bias, "lean_beat");
  assert.equal(wire.classifier_provider, "groq");
  assert.equal(wire.signal_version, "earnings-llm-v1-2026-05");
});

console.log("[10] stripCacheMeta is also applied at write-time so attached signals stay clean");
it("events[*].signals.llm_signal never has _cached_at after a fresh classify", async () => {
  const cachePath = tmpCachePath();
  const events = [structuredClone(sampleEvent)];
  await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: makeGroqProvider(),
    readSwsDeep: () => sampleDeep,
  });
  const attached = events[0].signals.llm_signal;
  assert.ok(attached, "signal attached");
  assert.equal(attached._cached_at, undefined);
  assert.equal(attached._last_provider_attempt, undefined);
});

/* ───────────────────── injectable llmAvailable ─────────────────── */

console.log("[11] llmAvailable opt overrides process.env detection");
it("when opts.llmAvailable=true is passed, behaviour is independent of GROQ/GEMINI env vars", async () => {
  const cachePath = tmpCachePath();
  // Even with no env vars (or env vars set), opts.llmAvailable wins.
  // This makes the test deterministic in any contributor's shell.
  const prevGroq = process.env.GROQ_API_KEY;
  const prevGemini = process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const events = [structuredClone(sampleEvent)];
    const provider = makeGroqProvider();
    const { stats } = await classifyBatchForCalendar(events, {
      cachePath,
      llmAvailable: true,
      providerOverride: provider,
      readSwsDeep: () => sampleDeep,
    });
    assert.equal(stats.llm_available, true);
    assert.equal(provider.calls, 1);
  } finally {
    if (prevGroq != null) process.env.GROQ_API_KEY = prevGroq;
    if (prevGemini != null) process.env.GEMINI_API_KEY = prevGemini;
  }
});

/* ───────────────────── Layer I — V3 composite floor ───────────── */

console.log("[12] meetsLlmCompositeFloor pure helper");
it("score < 50 → below floor; >= 50 → meets floor; null/missing → below", () => {
  const make = (s) => withV3(sampleEvent, s);
  assert.equal(meetsLlmCompositeFloor(make(49)), false);
  assert.equal(meetsLlmCompositeFloor(make(50)), true);
  assert.equal(meetsLlmCompositeFloor(make(75)), true);
  assert.equal(meetsLlmCompositeFloor(make(null)), false);
  assert.equal(meetsLlmCompositeFloor({ signals: {} }), false);
  assert.equal(meetsLlmCompositeFloor({}), false);
});

console.log("[13] events below the V3 floor are routed to heuristic, NOT the LLM");
it("v3_score_100 = 40 → LLM NOT called, heuristic attached, _last_provider_attempt='below_floor'", async () => {
  const cachePath = tmpCachePath();
  const events = [withV3(sampleEvent, 40)];
  const provider = makeGroqProvider();
  const { stats } = await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: provider,
    readSwsDeep: () => sampleDeep,
  });
  assert.equal(provider.calls, 0, "below-floor events must NOT hit the LLM");
  assert.equal(stats.below_v3_floor, 1);
  assert.equal(stats.llm_calls, 0);
  assert.equal(events[0].signals.llm_signal.classifier_provider, "heuristic");
  const cached = Object.values(loadCache(cachePath).entries)[0];
  assert.equal(cached._last_provider_attempt, "below_floor");
});

console.log("[14] events at the floor boundary (=50) DO go to the LLM");
it("v3_score_100 = 50 boundary → LLM IS called", async () => {
  const cachePath = tmpCachePath();
  const events = [withV3(sampleEvent, 50)];
  const provider = makeGroqProvider();
  await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: provider,
    readSwsDeep: () => sampleDeep,
  });
  assert.equal(provider.calls, 1);
  assert.equal(events[0].signals.llm_signal.classifier_provider, "groq");
});

console.log("[15] events with no v3 block are below floor (null score)");
it("event.signals.v3 = null → heuristic, no LLM call", async () => {
  const cachePath = tmpCachePath();
  const events = [withV3(sampleEvent, null)];
  const provider = makeGroqProvider();
  const { stats } = await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: provider,
    readSwsDeep: () => sampleDeep,
  });
  assert.equal(provider.calls, 0);
  assert.equal(stats.below_v3_floor, 1);
});

console.log("[16] floor-crossing UP invalidates the cached below_floor heuristic");
it("a stock that crossed from 40 → 75 gets re-classified by the LLM", async () => {
  const cachePath = tmpCachePath();
  // Seed cache: the SAME event-hash with a below_floor heuristic from a
  // prior run. The current event passes v3=75 → must invalidate + re-classify.
  const hash = await computeSampleHash(cachePath, false);
  seedCache(cachePath, {
    [hash]: {
      bias: "neutral",
      confidence_delta_pct: 0,
      top_reason: "no clear catalyst",
      top_risk: "no clear risk",
      classifier_provider: "heuristic",
      model_id: "heuristic-v2",
      signal_version: "earnings-llm-v1-2026-05",
      generated_at: new Date().toISOString(),
      _cached_at: new Date().toISOString(),
      _last_provider_attempt: "below_floor",
    },
  });
  const events = [withV3(sampleEvent, 75)];
  const provider = makeGroqProvider();
  const { stats } = await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: provider,
    readSwsDeep: () => sampleDeep,
  });
  assert.equal(provider.calls, 1, "floor-crossing UP must trigger re-classify");
  assert.equal(stats.cross_floor_invalidations, 1);
  assert.equal(events[0].signals.llm_signal.classifier_provider, "groq");
});

console.log("[17] floor-crossing DOWN keeps the cached LLM signal (no waste)");
it("a stock that crossed from 75 → 40 keeps its existing groq cache hit", async () => {
  const cachePath = tmpCachePath();
  const hash = await computeSampleHash(cachePath, false);
  seedCache(cachePath, {
    [hash]: {
      bias: "lean_beat",
      confidence_delta_pct: 4,
      top_reason: "real LLM read from a prior run",
      top_risk: "real LLM risk",
      classifier_provider: "groq",
      model_id: "groq-model",
      signal_version: "earnings-llm-v1-2026-05",
      generated_at: new Date().toISOString(),
      _cached_at: new Date().toISOString(),
      _last_provider_attempt: "succeeded",
    },
  });
  const events = [withV3(sampleEvent, 40)];   // now below floor
  const provider = makeGroqProvider();
  const { stats } = await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    providerOverride: provider,
    readSwsDeep: () => sampleDeep,
  });
  assert.equal(provider.calls, 0, "we already paid for the groq signal — don't waste it");
  assert.equal(stats.cache_hits, 1);
  assert.equal(events[0].signals.llm_signal.classifier_provider, "groq");
});

console.log("[18] custom compositeFloor opt overrides the default");
it("opts.compositeFloor=80 sends events with score 75 to heuristic", async () => {
  const cachePath = tmpCachePath();
  const events = [withV3(sampleEvent, 75)];
  const provider = makeGroqProvider();
  const { stats } = await classifyBatchForCalendar(events, {
    cachePath,
    llmAvailable: true,
    compositeFloor: 80,
    providerOverride: provider,
    readSwsDeep: () => sampleDeep,
  });
  assert.equal(provider.calls, 0);
  assert.equal(stats.below_v3_floor, 1);
  assert.equal(stats.composite_floor, 80);
});

/* ─────────────────────────── runner ─────────────────────────────── */

(async () => {
  for (const t of tests) {
    try { await t.fn(); console.log("  ✓", t.name); ok += 1; }
    catch (e) { console.log("  ✗", t.name, "\n   ", e && e.message); fail += 1; }
  }
  console.log(`\n=== ${ok} passed, ${fail} failed ===`);
  if (fail) process.exit(1);
})();
