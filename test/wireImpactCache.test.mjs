import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CACHE_SCHEMA_VERSION, buildCacheKey, loadCache, saveCache, getEntry, setEntry,
  isFreshLlm, failedRecently, stripCacheMeta, pruneCache, FAILED_RETRY_MS,
} from "../services/newsWire/wireImpactCache.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); pass++; }
  catch (err) { console.log(`  not ok - ${name}\n      ${err.message}`); fail++; }
}
function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wireImpactCache-"));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const sig = (over = {}) => ({
  direction: "bearish", impact: 7, confidence: 0.7, tickers: [], sectors: [],
  category: "markets", why: "why", classifier_provider: "gemini",
  model_id: "gemini-2.5-flash", signal_version: "news-wire-v1", generated_at: "2026-07-08T09:00:00Z",
  ...over,
});

test("[H2] buildCacheKey is content-only (cluster.key), independent of source_count", () => {
  assert.equal(buildCacheKey({ key: "abc", source_count: 2 }), "abc");
  assert.equal(buildCacheKey({ key: "abc", source_count: 5 }), "abc", "more sources must not change the key");
});

test("setEntry stamps meta; failed records _failed_at, others clear it", () => {
  const cache = { schema_version: CACHE_SCHEMA_VERSION, entries: {} };
  const e = setEntry(cache, "k", sig(), { providerAttempt: "succeeded", now: 1000 });
  assert.equal(e._last_provider_attempt, "succeeded");
  assert.ok(e._cached_at && e._last_used_at === 1000);
  assert.ok(!("_failed_at" in e));
  const f = setEntry(cache, "k", sig({ classifier_provider: "heuristic" }), { providerAttempt: "failed", now: 2000 });
  assert.equal(f._failed_at, 2000);
});

test("isFreshLlm true only for real providers", () => {
  assert.ok(isFreshLlm({ classifier_provider: "gemini" }));
  assert.ok(isFreshLlm({ classifier_provider: "groq" }));
  assert.ok(!isFreshLlm({ classifier_provider: "heuristic" }));
  assert.ok(!isFreshLlm(null));
});

test("[H1] failedRecently honors the backoff window", () => {
  const now = 10_000_000;
  const recent = { _last_provider_attempt: "failed", _failed_at: now - 60_000 };
  const stale = { _last_provider_attempt: "failed", _failed_at: now - FAILED_RETRY_MS - 1 };
  assert.ok(failedRecently(recent, { now }), "within window → still backing off");
  assert.ok(!failedRecently(stale, { now }), "past window → retry eligible");
  assert.ok(!failedRecently({ _last_provider_attempt: "succeeded" }, { now }));
});

test("stripCacheMeta drops _-prefixed internals", () => {
  const stripped = stripCacheMeta(setEntry({ entries: {} }, "k", sig(), { now: 1 }));
  assert.ok(!Object.keys(stripped).some((k) => k.startsWith("_")));
  assert.equal(stripped.direction, "bearish");
  assert.equal(stripped.classifier_provider, "gemini");
});

test("loadCache cold-flushes on schema mismatch", () => {
  withTmp((dir) => {
    const p = path.join(dir, "c.json");
    fs.writeFileSync(p, JSON.stringify({ schema_version: "OLD", entries: { x: sig() } }));
    const c = loadCache(p);
    assert.equal(c.schema_version, CACHE_SCHEMA_VERSION);
    assert.deepEqual(c.entries, {});
  });
});

test("saveCache/loadCache atomic round-trip", () => {
  withTmp((dir) => {
    const p = path.join(dir, "c.json");
    const cache = { schema_version: CACHE_SCHEMA_VERSION, entries: {} };
    setEntry(cache, "k1", sig(), { now: 1 });
    saveCache(cache, p);
    const back = loadCache(p);
    assert.equal(getEntry(back, "k1").direction, "bearish");
  });
});

test("pruneCache drops unused stale entries, keeps used ones", () => {
  const now = 100 * 24 * 3600 * 1000;
  const cache = { schema_version: CACHE_SCHEMA_VERSION, entries: {} };
  setEntry(cache, "used", sig(), { now });
  setEntry(cache, "staleUnused", sig(), { now: now - 10 * 24 * 3600 * 1000 });
  const pruned = pruneCache(cache, new Set(["used"]), { now });
  assert.equal(pruned, 1);
  assert.ok(getEntry(cache, "used"));
  assert.ok(!getEntry(cache, "staleUnused"));
});

test("[migration] a v1 cache carrying category:'short' cold-flushes to empty", () => {
  withTmp((dir) => {
    const p = path.join(dir, "impact-cache.json");
    // Exactly what production holds today: v1 entries whose LLM-written category
    // is the literal placeholder string the prompt leaked.
    fs.writeFileSync(p, JSON.stringify({
      schema_version: "news-wire-impact-cache-v1",
      entries: { abc: sig({ category: "short" }) },
    }));
    const c = loadCache(p);
    assert.equal(c.schema_version, CACHE_SCHEMA_VERSION);
    assert.deepEqual(c.entries, {}, "poisoned v1 entries must not survive the bump");
    assert.equal(getEntry(c, "abc"), null);
  });
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
