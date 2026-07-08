// Market Wire — builder + ranking (Phase 5).
//
// The orchestrator: read the buffer window → cluster → heuristic-score all →
// rank → LLM-refine only the top-N → re-rank with the refined signals →
// bucket + shape → write the wire artifact. NEVER throws.
//
// Ranking layers corroboration + recency ON TOP of the (cached) content signal
// (H2): rank = impact × recencyDecay × corroborationBoost. rankClusters runs
// twice — once on the cheap heuristic to pick which clusters are worth an LLM
// call, once on the refined signals to order the final feed — so a fresh
// corroborating source lifts an item without any LLM re-call.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadWireWindow, resolveReadDir } from "./wireArchive.js";
import { clusterMessages } from "./wireClusterer.js";
import { heuristicClassifyCluster, WIRE_SIGNAL_VERSION } from "./wireHeuristic.js";
import { classifyClusters } from "./wireImpactBatcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const DEFAULT_WIRE_PATH = path.join(REPO_ROOT, "data", "news-wire", "wire-latest.json");
export const KV_WIRE_KEY = "news:wire:latest";
export const MAX_ITEMS = 40;
const HALF_LIFE_MIN = 90;

function recencyDecay(lastSeenIso, now) {
  const t = lastSeenIso ? new Date(lastSeenIso).getTime() : now;
  const ageMin = Math.max(0, (now - t) / 60000);
  return Math.exp(-ageMin / HALF_LIFE_MIN);
}

/**
 * rankClusters(scored, {now}) → same items with a `rank`, sorted best-first.
 * scored: [{ cluster, signal }]. Pure — exported for unit test.
 */
export function rankClusters(scored, { now = Date.now() } = {}) {
  return (scored || [])
    .map(({ cluster, signal }) => {
      const impact = Number(signal?.impact) || 0;
      const corro = 1 + Math.log2(Math.max(1, Number(cluster?.source_count) || 1));
      const base = impact * recencyDecay(cluster?.last_seen, now) * corro;
      const rank = Math.round((base + (cluster?.breaking ? 0.5 : 0)) * 1000) / 1000;
      return { cluster, signal, rank };
    })
    .sort((a, b) => b.rank - a.rank);
}

function heatBucket(impact, breaking) {
  const i = Number(impact) || 0;
  if (i >= 7 || (breaking && i >= 5)) return "high";
  if (i >= 4) return "med";
  return "low";
}

function distinctSources(members) {
  const byChannel = new Map();
  for (const m of members || []) {
    const ch = m.channel || "unknown";
    const prev = byChannel.get(ch);
    // keep the earliest sighting per channel
    if (!prev || (m.publishedAt && (!prev.publishedAt || m.publishedAt < prev.publishedAt))) {
      byChannel.set(ch, { channel: ch, url: m.url || null, publishedAt: m.publishedAt || null });
    }
  }
  return [...byChannel.values()].slice(0, 8);
}

function buildItem(cluster, signal, rank) {
  return {
    id: cluster.key,
    headline: cluster.representative,
    direction: signal.direction,
    heat_bucket: heatBucket(signal.impact, cluster.breaking),
    confidence: signal.confidence,
    breaking: !!cluster.breaking,
    category: signal.category,
    tickers: signal.tickers || [],
    sectors: signal.sectors || [],
    why: signal.why || "",
    source_count: cluster.source_count,
    sources: distinctSources(cluster.members),
    first_seen: cluster.first_seen,
    last_seen: cluster.last_seen,
    classifier_provider: signal.classifier_provider,
    rank,
  };
}

function computeMarketStatus(now) {
  // NSE cash session ~09:15–15:30 IST, Mon–Fri. IST = UTC+5:30.
  const istMs = now + 5.5 * 3600 * 1000;
  const d = new Date(istMs);
  const day = d.getUTCDay(); // 0 Sun .. 6 Sat (of the IST-shifted clock)
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const open = day >= 1 && day <= 5 && mins >= 555 && mins <= 930;
  return open ? "OPEN" : "CLOSED";
}

function writeMirrorAtomic(wire, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(wire), "utf-8");
  fs.renameSync(tmp, outPath);
}

async function publishToKv(wire, kvKey) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return { published: false, reason: "KV not configured" };
  }
  try {
    const { kv } = await import("@vercel/kv");
    await kv.set(kvKey, wire);
    return { published: true };
  } catch (e) {
    return { published: false, reason: e?.message || String(e) };
  }
}

/**
 * buildWire(opts) → { wire, stats }. NEVER throws.
 *   - records: inject a message array (tests); otherwise read the buffer window.
 *   - skipLlm: heuristic only, no cache/LLM.
 *   - writeMirror: atomic-write the local wire-latest.json mirror (default true).
 *   - publish: push to Vercel KV when configured (default false; the CLI sets it).
 */
export async function buildWire({
  windowHours = 6,
  now = Date.now(),
  skipLlm = false,
  records = null,
  writeMirror = true,
  outPath = DEFAULT_WIRE_PATH,
  publish = false,
  kvKey = KV_WIRE_KEY,
  cachePath,
  maxItems = MAX_ITEMS,
  ...batchOpts
} = {}) {
  try {
    const msgs = Array.isArray(records) ? records : loadWireWindow(windowHours, { now });
    const { clusters } = clusterMessages(msgs);

    const heuristicByKey = new Map();
    for (const c of clusters) heuristicByKey.set(c.key, heuristicClassifyCluster(c, { now }));

    // Pre-rank on the heuristic to decide which clusters earn an LLM call.
    const preRanked = rankClusters(clusters.map((c) => ({ cluster: c, signal: heuristicByKey.get(c.key) })), { now }).map((r) => r.cluster);

    const { signalsByKey, stats: llmStats } = await classifyClusters(preRanked, {
      heuristicByKey, skipLlm, cachePath, now, ...batchOpts,
    });

    // Re-rank with the refined signals (corroboration/recency re-applied outside the cache).
    const finalScored = clusters.map((c) => ({ cluster: c, signal: signalsByKey.get(c.key) || heuristicByKey.get(c.key) }));
    const ranked = rankClusters(finalScored, { now }).slice(0, maxItems);
    const items = ranked.map(({ cluster, signal, rank }) => buildItem(cluster, signal, rank));

    const wire = {
      schema_version: WIRE_SIGNAL_VERSION,
      generatedAt: new Date(now).toISOString(),
      window_hours: windowHours,
      market_status: computeMarketStatus(now),
      counts: {
        messages: msgs.length,
        clusters: clusters.length,
        llm_calls: llmStats.llm_calls,
        cache_hits: llmStats.cache_hits,
        heuristic: llmStats.heuristic,
        below_floor: llmStats.below_floor,
      },
      items,
    };

    if (writeMirror) {
      try { writeMirrorAtomic(wire, outPath); } catch (e) { console.warn(`[wire] mirror write failed: ${e?.message || e}`); }
    }
    let publishResult = { published: false, reason: "not requested" };
    if (publish) publishResult = await publishToKv(wire, kvKey);

    return { wire, stats: { ...llmStats, publish: publishResult } };
  } catch (e) {
    console.warn(`[wire] build failed (swallowed): ${e?.message || e}`);
    const wire = {
      schema_version: WIRE_SIGNAL_VERSION,
      generatedAt: new Date(now).toISOString(),
      window_hours: windowHours,
      market_status: computeMarketStatus(now),
      counts: { messages: 0, clusters: 0, llm_calls: 0, cache_hits: 0, heuristic: 0, below_floor: 0 },
      items: [],
    };
    return { wire, stats: { error: e?.message || String(e) } };
  }
}

export default { buildWire, rankClusters, DEFAULT_WIRE_PATH, KV_WIRE_KEY, MAX_ITEMS };
