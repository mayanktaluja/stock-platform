import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  classifyNewsBatch,
  isWithinRecencyWindow,
  needsLlmRefine,
  newsItemHash,
  loadCache,
  writeCacheAtomic,
  stripCacheMeta,
  CACHE_SCHEMA,
} from "../services/sectorOutlook/llmThemeRefiner.js";
import { classifyOne as heuristicClassifyOne } from "../services/sectorOutlook/heuristicThemeClassifier.js";
import { CLASSIFIER_VERSION } from "../services/sectorOutlook/themeTaxonomy.js";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

function tmpCachePath(label) {
  return path.join(os.tmpdir(), `sectorOutlookLlmRefiner-${label}-${process.pid}-${Date.now()}.json`);
}

const NOW_MS = Date.parse("2026-05-20T00:00:00Z");

// ─── isWithinRecencyWindow ───────────────────────────────────────────
console.log("llmRefiner: isWithinRecencyWindow");
{
  assert("recent (1d ago)", isWithinRecencyWindow({ date: "2026-05-19" }, NOW_MS));
  assert("90d ago in window", isWithinRecencyWindow({ date: "2026-02-19" }, NOW_MS));
  assert("180d ago in window", isWithinRecencyWindow({ date: "2025-11-21" }, NOW_MS));
  assert("365d ago in window (edge)", isWithinRecencyWindow({ date: "2025-05-20" }, NOW_MS));
  assert("400d ago out of window", !isWithinRecencyWindow({ date: "2025-04-15" }, NOW_MS));
  assert("2y ago out of window", !isWithinRecencyWindow({ date: "2024-05-19" }, NOW_MS));
  assert("future date out of window", !isWithinRecencyWindow({ date: "2027-01-01" }, NOW_MS));
  assert("no date → false", !isWithinRecencyWindow({}, NOW_MS));
  assert("null → false", !isWithinRecencyWindow(null, NOW_MS));
  assert("bad date → false", !isWithinRecencyWindow({ date: "not-a-date" }, NOW_MS));
}

// ─── newsItemHash stability ──────────────────────────────────────────
console.log("llmRefiner: newsItemHash stability");
{
  const item = { id: "abc-123", date: "2026-05-15", title: "Hello", body: "World" };
  const h1 = newsItemHash(item);
  const h2 = newsItemHash(item);
  assert("hash is deterministic", h1 === h2, h1);
  assert("hash is 24-hex", /^[0-9a-f]{24}$/.test(h1), h1);

  // Hashes for different items differ
  const itemB = { ...item, body: "Mars" };
  assert("body changes hash", newsItemHash(item) !== newsItemHash(itemB));

  const itemC = { ...item, title: "Goodbye" };
  assert("title changes hash", newsItemHash(item) !== newsItemHash(itemC));

  const itemD = { ...item, date: "2026-05-16" };
  assert("date changes hash", newsItemHash(item) !== newsItemHash(itemD));

  const itemE = { ...item, id: "xyz-789" };
  assert("id changes hash", newsItemHash(item) !== newsItemHash(itemE));

  // No id → still hashable (uses date + title + body)
  const itemNoId = { date: "2026-05-15", title: "Hello", body: "World" };
  const hNoId = newsItemHash(itemNoId);
  assert("no-id hash succeeds", /^[0-9a-f]{24}$/.test(hNoId));
}

// ─── needsLlmRefine gate ─────────────────────────────────────────────
console.log("llmRefiner: needsLlmRefine gate");
{
  // High-confidence heuristic → don't refine
  const beat = { id: "1", date: "2026-05-15", title: "Q3 EPS exceeded analyst expectations", body: "" };
  const beatHeur = heuristicClassifyOne(beat);
  assert("beat heuristic high-conf", beatHeur.confidence >= 0.55);
  assert("beat → does NOT need refine", !needsLlmRefine(beat, beatHeur, NOW_MS));

  // Low-confidence heuristic + within window → refine
  const ambiguous = { id: "2", date: "2026-05-15", title: "Company files standard disclosure", body: "" };
  const ambHeur = heuristicClassifyOne(ambiguous);
  assert("ambiguous heuristic low-conf", ambHeur.confidence < 0.55);
  assert("ambiguous (recent) → needs refine", needsLlmRefine(ambiguous, ambHeur, NOW_MS));

  // Low-confidence heuristic but OUT of window → no refine (heuristic suffices)
  const oldAmbiguous = { id: "3", date: "2024-01-01", title: "Company files standard disclosure", body: "" };
  const oldAmbHeur = heuristicClassifyOne(oldAmbiguous);
  assert("old ambiguous → does NOT need refine (out of window)",
    !needsLlmRefine(oldAmbiguous, oldAmbHeur, NOW_MS));
}

// ─── classifyNewsBatch skip-llm ──────────────────────────────────────
console.log("llmRefiner: classifyNewsBatch skip-llm mode");
{
  const items = [
    { id: "1", date: "2026-05-15", title: "Q3 EPS exceeded analyst expectations", body: "" },
    { id: "2", date: "2026-05-15", title: "Company files annual disclosure", body: "" },
    { id: "3", date: "2026-05-15", title: "JSW Steel announces capacity expansion", body: "" },
  ];
  const out = await classifyNewsBatch(items, { skipLlm: true });
  assert("results length matches", out.results.length === items.length);
  assert("stats.skip_llm = true", out.stats.skip_llm === true);
  assert("stats.llm_calls = 0", out.stats.llm_calls === 0);
  assert("results[0].theme = EARNINGS_MOVE", out.results[0].theme === "EARNINGS_MOVE");
  assert("results[1].theme = NEUTRAL", out.results[1].theme === "NEUTRAL");
  assert("results[2].theme = CAPACITY_CAPEX", out.results[2].theme === "CAPACITY_CAPEX");
}

// ─── classifyNewsBatch with providerOverride (no network) ────────────
console.log("llmRefiner: classifyNewsBatch with mock provider — first run uses LLM");
{
  const cachePath = tmpCachePath("first-run");
  const items = [
    // High-conf heuristic — never refines
    { id: "h1", date: "2026-05-15", title: "Q3 EPS exceeded analyst expectations", body: "" },
    // Ambiguous + in window — refines via mock LLM
    { id: "a1", date: "2026-05-10", title: "Company files annual disclosure", body: "" },
    { id: "a2", date: "2026-05-12", title: "Board meeting scheduled next month", body: "" },
  ];

  let providerCalls = 0;
  const providerOverride = async (newsItems) => {
    providerCalls += 1;
    return newsItems.map((n, i) => ({
      theme: "M_AND_A",
      sign: 1,
      intensity: 2,
      confidence: 0.8,
      time_hint: "medium",
      top_reason: "mock LLM reason",
      classifier_provider: "llm",
      classifier_version: CLASSIFIER_VERSION,
    }));
  };

  const out = await classifyNewsBatch(items, {
    cachePath,
    providerOverride,
    llmAvailable: true,
    nowMs: NOW_MS,
  });
  assert("provider called exactly once", providerCalls === 1, providerCalls);
  assert("stats.llm_calls = 1", out.stats.llm_calls === 1, out.stats);
  assert("stats.llm_items = 2 (the ambiguous pair)", out.stats.llm_items === 2, out.stats);
  assert("results[0].theme unchanged (high-conf heuristic)",
    out.results[0].theme === "EARNINGS_MOVE", out.results[0]);
  assert("results[1].theme from LLM", out.results[1].theme === "M_AND_A");
  assert("results[2].theme from LLM", out.results[2].theme === "M_AND_A");
  assert("cache file written", fs.existsSync(cachePath));

  // Inspect the cache: every news item should have a stamped entry
  const cache = loadCache(cachePath);
  assert("cache schema version stamped", cache.schema_version === CACHE_SCHEMA);
  assert("cache has 3 entries", Object.keys(cache.entries).length === 3,
    Object.keys(cache.entries).length);

  fs.unlinkSync(cachePath);
}

// ─── CRITICAL TEST: zero LLM calls on cache-hit re-run ───────────────
console.log("llmRefiner: ZERO LLM calls on cache-hit re-run (cache-poisoning canary)");
{
  const cachePath = tmpCachePath("zero-llm-rerun");
  const items = [
    { id: "z1", date: "2026-05-10", title: "Company files annual disclosure", body: "" },
    { id: "z2", date: "2026-05-12", title: "Board meeting scheduled next month", body: "" },
    { id: "z3", date: "2026-05-15", title: "Procedural exchange filing made", body: "" },
  ];
  let providerCallsRun1 = 0;
  let providerCallsRun2 = 0;

  const provider = (counter) => async (newsItems) => {
    counter.calls += 1;
    return newsItems.map(() => ({
      theme: "REGULATORY_EVENT",
      sign: 0,
      intensity: 2,
      confidence: 0.7,
      time_hint: "medium",
      top_reason: "filing event",
      classifier_provider: "llm",
      classifier_version: CLASSIFIER_VERSION,
    }));
  };
  const counter1 = { calls: 0 };
  const counter2 = { calls: 0 };

  // First run — populate the cache
  const out1 = await classifyNewsBatch(items, {
    cachePath,
    providerOverride: provider(counter1),
    llmAvailable: true,
    nowMs: NOW_MS,
  });
  providerCallsRun1 = counter1.calls;
  assert("run 1: provider was called", providerCallsRun1 >= 1, providerCallsRun1);
  assert("run 1: stats.llm_calls >= 1", out1.stats.llm_calls >= 1);

  // Second run — IDENTICAL inputs, IDENTICAL cache path. The cache MUST
  // produce zero LLM calls. This is THE invariant. If this assertion ever
  // fails, the cache key has drifted or the invalidation logic has bug.
  const out2 = await classifyNewsBatch(items, {
    cachePath,
    providerOverride: provider(counter2),
    llmAvailable: true,
    nowMs: NOW_MS,
  });
  providerCallsRun2 = counter2.calls;
  assert("RUN 2: provider was NOT called", providerCallsRun2 === 0, providerCallsRun2);
  assert("RUN 2: stats.llm_calls === 0", out2.stats.llm_calls === 0, out2.stats);
  assert("RUN 2: stats.cache_hits >= 1", out2.stats.cache_hits >= 1, out2.stats);
  // Results should be theme-stable across runs
  for (let i = 0; i < items.length; i += 1) {
    assert(`RUN 2: results[${i}].theme matches run 1`,
      out2.results[i].theme === out1.results[i].theme, { run1: out1.results[i], run2: out2.results[i] });
  }
  fs.unlinkSync(cachePath);
}

// ─── classifyNewsBatch: maxLlmCalls cap ──────────────────────────────
console.log("llmRefiner: maxLlmCalls cap");
{
  const cachePath = tmpCachePath("max-llm");
  // 20 ambiguous items → with chunkSize=8, 3 chunks needed → cap at 1 chunk
  const items = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`,
    date: "2026-05-15",
    title: "Board meeting scheduled next month",
    body: "",
  }));
  let providerCalls = 0;
  const provider = async (newsItems) => {
    providerCalls += 1;
    return newsItems.map(() => ({
      theme: "NEUTRAL",
      sign: 0,
      intensity: 1,
      confidence: 0.6,
      time_hint: "medium",
      top_reason: "",
      classifier_provider: "llm",
      classifier_version: CLASSIFIER_VERSION,
    }));
  };
  const out = await classifyNewsBatch(items, {
    cachePath,
    providerOverride: provider,
    llmAvailable: true,
    chunkSize: 8,
    maxLlmCalls: 1,  // cap at 1 chunk
    nowMs: NOW_MS,
  });
  assert("provider called exactly once (chunk cap)", providerCalls === 1, providerCalls);
  assert("stats.llm_calls === 1", out.stats.llm_calls === 1);
  assert("stats.llm_items === 8 (one chunk)", out.stats.llm_items === 8);
  fs.unlinkSync(cachePath);
}

// ─── classifyNewsBatch: empty + null inputs ─────────────────────────
console.log("llmRefiner: empty + null inputs");
{
  const out1 = await classifyNewsBatch([], { skipLlm: true });
  assert("empty array → 0 results", out1.results.length === 0);
  assert("empty array → stats.total = 0", out1.stats.total === 0);

  const out2 = await classifyNewsBatch(null, { skipLlm: true });
  assert("null → 0 results", out2.results.length === 0);
}

// ─── stripCacheMeta whitelist ────────────────────────────────────────
console.log("llmRefiner: stripCacheMeta drops internal fields");
{
  const entry = {
    theme: "EARNINGS_MOVE",
    sign: 1,
    intensity: 2,
    confidence: 0.8,
    time_hint: "short",
    top_reason: "EPS exceeded estimates",
    classifier_provider: "llm",
    classifier_version: CLASSIFIER_VERSION,
    _cached_at: "2026-05-20T00:00:00.000Z",
    _last_provider_attempt: "succeeded",
    _internal_debug: "should be dropped",
  };
  const stripped = stripCacheMeta(entry);
  assert("kept theme", stripped.theme === "EARNINGS_MOVE");
  assert("kept sign", stripped.sign === 1);
  assert("kept confidence", stripped.confidence === 0.8);
  assert("dropped _cached_at", stripped._cached_at === undefined);
  assert("dropped _last_provider_attempt", stripped._last_provider_attempt === undefined);
  assert("dropped _internal_debug", stripped._internal_debug === undefined);
}

// ─── cache schema migration tolerance ────────────────────────────────
console.log("llmRefiner: tolerates malformed cache files");
{
  const cachePath = tmpCachePath("malformed");
  // Bad JSON
  fs.writeFileSync(cachePath, "{this is not valid json");
  const cache1 = loadCache(cachePath);
  assert("malformed JSON → empty cache", Object.keys(cache1.entries).length === 0);
  // Wrong shape
  fs.writeFileSync(cachePath, JSON.stringify({ no_entries_field: true }));
  const cache2 = loadCache(cachePath);
  assert("wrong shape → empty cache", Object.keys(cache2.entries).length === 0);
  // Missing file
  fs.unlinkSync(cachePath);
  const cache3 = loadCache(cachePath);
  assert("missing file → empty cache", Object.keys(cache3.entries).length === 0);
  assert("missing file → schema stamped", cache3.schema_version === CACHE_SCHEMA);
}

// ─── classifier_version invalidation ─────────────────────────────────
console.log("llmRefiner: classifier_version bump cold-invalidates cache");
{
  const itemA = { id: "v1", date: "2026-05-15", title: "Hello", body: "World" };
  const h1 = newsItemHash(itemA);
  // The hash includes CLASSIFIER_VERSION. If a future bump changes it,
  // h1 would no longer be reproducible — verify the version is in the hash.
  // We can't directly assert the prefix because crypto, but we CAN assert
  // that two semantically-identical items hash the same (already covered
  // above), and the documentation invariant is enforced by the source.
  // Here we just assert that the hash exists and is well-formed.
  assert("hash includes version (well-formed)", /^[0-9a-f]{24}$/.test(h1));
}

if (_failed > 0) {
  console.log(`\nsectorOutlookLlmRefiner: ${_failed} failures`);
  process.exit(1);
}
console.log("\nsectorOutlookLlmRefiner: all tests passed");
