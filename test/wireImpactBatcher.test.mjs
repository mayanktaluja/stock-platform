import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyClusters, meetsWireFloor } from "../services/newsWire/wireImpactBatcher.js";
import { CACHE_SCHEMA_VERSION } from "../services/newsWire/wireImpactCache.js";

let pass = 0;
let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function tmpCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wireBatcher-"));
  return { dir, path: path.join(dir, "impact-cache.json"), clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const cluster = (key, over = {}) => ({
  key,
  representative: over.text || "Fed slashes rates markets plunge",
  members: [{ text: over.text || "Fed slashes rates markets plunge", publishedAt: "2026-07-08T09:00:00Z", channel: "A" }],
  source_count: over.source_count ?? 2,
  breaking: over.breaking ?? false,
  symbols: over.symbols ?? [],
  categories: ["markets"],
});

// Deterministic fake LLM: tags every ctx bearish/impact 7 via provider "gemini".
const fakeGemini = async (ctxs, { now }) => ({
  provider: "gemini",
  attempted: true,
  failed: false,
  signals: ctxs.map(() => ({
    direction: "bearish", impact: 7, confidence: 0.7, tickers: [], sectors: [],
    category: "markets", why: "llm", classifier_provider: "gemini",
    model_id: "gemini-2.5-flash", signal_version: "news-wire-v1", generated_at: new Date(now).toISOString(),
  })),
});
const throwingFn = async () => { throw new Error("classifyFn must not be called"); };

test("meetsWireFloor: corroborated / breaking / ticker pass; noisy singleton fails", () => {
  assert.ok(meetsWireFloor({ source_count: 2 }));
  assert.ok(meetsWireFloor({ source_count: 1, breaking: true }));
  assert.ok(meetsWireFloor({ source_count: 1, symbols: ["TCS"] }));
  assert.ok(!meetsWireFloor({ source_count: 1, breaking: false, symbols: [] }));
});

test("floor routing: corroborated → LLM, noisy singleton → heuristic", async () => {
  const c = tmpCache();
  try {
    const { signalsByKey, stats } = await classifyClusters(
      [cluster("corr", { source_count: 3 }), cluster("noise", { source_count: 1, text: "random weather note nothing market" })],
      { classifyFn: fakeGemini, llmAvailable: true, cachePath: c.path, now: 1000 },
    );
    assert.equal(signalsByKey.get("corr").classifier_provider, "gemini");
    assert.equal(signalsByKey.get("noise").classifier_provider, "heuristic");
    assert.ok(stats.below_floor >= 1);
  } finally { c.clean(); }
});

test("[H1] per-build LLM cap holds under a storm", async () => {
  const c = tmpCache();
  try {
    const clusters = Array.from({ length: 30 }, (_, i) => cluster(`k${i}`, { source_count: 3 }));
    const { signalsByKey, stats } = await classifyClusters(clusters, {
      classifyFn: fakeGemini, llmAvailable: true, cachePath: c.path, maxLlm: 5, chunkSize: 8, now: 1000,
    });
    const llmScored = [...signalsByKey.values()].filter((s) => s.classifier_provider === "gemini").length;
    assert.equal(llmScored, 5, "no more than maxLlm clusters hit the LLM");
    assert.equal(stats.heuristic, 25, "the rest fall to heuristic");
    assert.ok(stats.llm_calls <= 1, "5 clusters → at most one 8-wide chunk");
  } finally { c.clean(); }
});

test("skipLlm → all heuristic, no cache file written", async () => {
  const c = tmpCache();
  try {
    const { signalsByKey } = await classifyClusters([cluster("a"), cluster("b")], {
      skipLlm: true, cachePath: c.path, now: 1000,
    });
    assert.ok([...signalsByKey.values()].every((s) => s.classifier_provider === "heuristic"));
    assert.ok(!fs.existsSync(c.path), "skipLlm writes no cache");
  } finally { c.clean(); }
});

test("[H2] fresh-LLM cache hit is reused, LLM NOT re-called", async () => {
  const c = tmpCache();
  try {
    fs.writeFileSync(c.path, JSON.stringify({
      schema_version: CACHE_SCHEMA_VERSION,
      entries: {
        cached: {
          direction: "bullish", impact: 6, confidence: 0.6, tickers: [], sectors: [],
          category: "markets", why: "from cache", classifier_provider: "gemini",
          model_id: "gemini-2.5-flash", signal_version: "news-wire-v1", generated_at: "2026-07-08T08:00:00Z",
          _cached_at: "2026-07-08T08:00:00Z", _last_used_at: 900, _last_provider_attempt: "succeeded",
        },
      },
    }));
    const { signalsByKey, stats } = await classifyClusters([cluster("cached", { source_count: 3 })], {
      classifyFn: throwingFn, llmAvailable: true, cachePath: c.path, now: 1000,
    });
    assert.equal(stats.cache_hits, 1);
    assert.equal(signalsByKey.get("cached").why, "from cache");
  } finally { c.clean(); }
});

test("[H1] a recently-failed cluster backs off (heuristic this build, no LLM call)", async () => {
  const c = tmpCache();
  try {
    const now = 10_000_000;
    fs.writeFileSync(c.path, JSON.stringify({
      schema_version: CACHE_SCHEMA_VERSION,
      entries: {
        flaky: {
          direction: "neutral", impact: 2, confidence: 0.3, classifier_provider: "heuristic",
          _last_provider_attempt: "failed", _failed_at: now - 60_000, _last_used_at: now - 60_000,
        },
      },
    }));
    const { signalsByKey } = await classifyClusters([cluster("flaky", { source_count: 3 })], {
      classifyFn: throwingFn, llmAvailable: true, cachePath: c.path, now,
    });
    assert.equal(signalsByKey.get("flaky").classifier_provider, "heuristic");
  } finally { c.clean(); }
});

test("providerOverride='heuristic' forces the floor even with keys", async () => {
  const c = tmpCache();
  try {
    const { signalsByKey } = await classifyClusters([cluster("x", { source_count: 3 })], {
      providerOverride: "heuristic", llmAvailable: true, cachePath: c.path, now: 1000,
    });
    assert.equal(signalsByKey.get("x").classifier_provider, "heuristic");
  } finally { c.clean(); }
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok - ${name}`); pass++; }
  catch (err) { console.log(`  not ok - ${name}\n      ${err.message}`); fail++; }
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
