#!/usr/bin/env node
/**
 * Walks data/sws/deep/*.json, classifies every news[] item via the
 * heuristic-first + LLM-refine pipeline, and writes per-ticker JSONL
 * to data/sectorOutlook/classified-news/<TICKER>.jsonl.
 *
 * Runs LOCALLY (chained into scripts/sws-refresh-api.sh step 7.5) — never on
 * Vercel cron. The Gemini/Groq keys live on the developer's machine. CI calls
 * with --skip-llm.
 *
 * Cost story: ~6.1k tickers × ~8 news ≈ 50k items, and ~96% of them are
 * LLM-refine candidates (the heuristic is rarely high-confidence and SWS news
 * is almost all inside the 365d window). --max-llm-calls=N (8 items/call) is
 * the nightly ceiling, so a cold cache takes many nights to cover; the cache
 * (data/sectorOutlook/llm-theme-cache.json, gitignored local state) is what
 * carries that work forward night to night.
 *
 * The walk ALWAYS finishes. The LLM is an optional refinement; the per-ticker
 * JSONL rewrite is not — a ticker the walk never reaches keeps whatever JSONL
 * is on disk (in the nightly's worktree: the stale copy in git), so a walk cut
 * off at "M" erases 90-day evidence for every sector whose names sort late.
 * That is how 2026-10-14 zeroed Growing Sector Value. So LLM calls stop for
 * good, and the rest of the walk runs on cache + heuristic, when either:
 *   - the --max-llm-calls budget is spent;
 *   - --llm-budget-sec of wall clock has passed (leaves the step timeout room
 *     to finish the walk).
 * They PAUSE while every provider's circuit breaker is open (3 consecutive
 * failures each, e.g. Gemini's daily-quota 429s) — each circuit re-admits a
 * probe after a 120s cooldown, so a per-minute rate limit costs minutes, not
 * the night.
 * The cache is loaded once, checkpointed every --checkpoint-every tickers or
 * 30s, written at the end (also on a throw), and flushed on SIGTERM/SIGINT so
 * a kill from the outer timeout keeps every classification already paid for.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  classifyNewsBatch,
  createLlmCircuitBreaker,
  llmUnavailableReason,
  loadCache,
  pruneCache,
  writeCacheAtomic,
  CACHE_PATH,
  CACHE_SCHEMA,
} from "../services/sectorOutlook/llmThemeRefiner.js";
import { CLASSIFIER_VERSION } from "../services/sectorOutlook/themeTaxonomy.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const DEEP_DIR = path.join(ROOT, "data", "sws", "deep");
const OUT_DIR = path.join(ROOT, "data", "sectorOutlook", "classified-news");
const BODY_SNIPPET_MAX = 500;
const DEFAULT_CHECKPOINT_EVERY = 100;
const DEFAULT_CHECKPOINT_MS = 30_000;

// "--max-llm-calls=0" means zero, not unlimited: it is the no-LLM re-run that
// sws-refresh-api.sh falls back to when the main run is killed.
export function parseNonNegative(raw) {
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n >= 0 ? n : Infinity;
}

export function parseArgs(argv) {
  const args = {
    dryRun: false,
    skipLlm: false,
    maxLlmCalls: Infinity,
    llmBudgetSec: Infinity,
    checkpointEvery: DEFAULT_CHECKPOINT_EVERY,
    shard: null,
    nShards: 1,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--skip-llm") args.skipLlm = true;
    else if (arg.startsWith("--max-llm-calls=")) {
      args.maxLlmCalls = parseNonNegative(arg.split("=")[1]);
    } else if (arg.startsWith("--llm-budget-sec=")) {
      args.llmBudgetSec = parseNonNegative(arg.split("=")[1]);
    } else if (arg.startsWith("--checkpoint-every=")) {
      const n = parseNonNegative(arg.split("=")[1]);
      if (Number.isFinite(n) && n >= 1) args.checkpointEvery = n;
    } else if (arg.startsWith("--shard=")) {
      const [i_, n_] = arg.split("=")[1].split("/").map(Number);
      if (Number.isInteger(i_) && Number.isInteger(n_)) {
        args.shard = i_;
        args.nShards = n_;
      }
    } else if (arg === "--verbose" || arg === "-v") args.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: refresh-sector-news-themes.mjs [options]\n" +
        "  --dry-run              don't write JSONL files; print what would be done\n" +
        "  --skip-llm             heuristic-only, no cache I/O (CI / no keys)\n" +
        "  --max-llm-calls=N      cap LLM batches across all tickers (default: unlimited;\n" +
        "                         0 = cache + heuristic only, no network)\n" +
        "  --llm-budget-sec=N     stop LLM calls after N s of wall clock; the walk still\n" +
        "                         finishes on cache + heuristic (default: unlimited)\n" +
        `  --checkpoint-every=N   write the cache every N tickers (default: ${DEFAULT_CHECKPOINT_EVERY}; also every 30s)\n` +
        "  --shard=i/n            process only ticker shard i of n (1-indexed)\n" +
        "  --verbose              print per-ticker progress\n"
      );
      process.exit(0);
    }
  }
  return args;
}

function loadDeep(tickerFile) {
  try {
    return JSON.parse(fs.readFileSync(tickerFile, "utf8"));
  } catch {
    return null;
  }
}

function inShard(ticker, shard, nShards) {
  if (!shard || nShards < 2) return true;
  // Hash-based shard assignment
  let h = 0;
  for (let i = 0; i < ticker.length; i += 1) {
    h = ((h << 5) - h + ticker.charCodeAt(i)) | 0;
  }
  const bucket = (Math.abs(h) % nShards) + 1;
  return bucket === shard;
}

function writeJsonlAtomic(filePath, rows) {
  const tmp = filePath + ".tmp." + process.pid;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function boundedSnippet(value, max = BODY_SNIPPET_MAX) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The walk. Exported so tests can drive it with fixture dirs, a fake clock and
 * fake providers. Returns a summary; never throws on LLM trouble.
 */
export async function refreshSectorNewsThemes(opts = {}) {
  const {
    deepDir = DEEP_DIR,
    outDir = OUT_DIR,
    cachePath = CACHE_PATH,
    skipLlm = false,
    dryRun = false,
    maxLlmCalls = Infinity,
    llmBudgetSec = Infinity,
    shard = null,
    nShards = 1,
    verbose = false,
    checkpointEvery = DEFAULT_CHECKPOINT_EVERY,
    checkpointMs = DEFAULT_CHECKPOINT_MS,
    providerOverride,
    providers,
    breaker: breakerOpt,
    now = () => Date.now(),
    log = console.log,
    installSignalHandlers = false,
  } = opts;
  // On the walk's clock, so a fake clock drives the breaker's cooldown too.
  const breaker = breakerOpt || createLlmCircuitBreaker({ now });

  if (!fs.existsSync(deepDir)) throw new Error(`${deepDir} not found`);

  const allTickerFiles = fs.readdirSync(deepDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const shardedTickerFiles = allTickerFiles.filter((f) => {
    const ticker = f.replace(/\.json$/, "");
    return inShard(ticker, shard, nShards);
  });

  log(`[sector-outlook-themes] universe=${allTickerFiles.length} shard=${shardedTickerFiles.length}`);

  const startedMs = now();
  const llmBudgetMs = Number.isFinite(llmBudgetSec) ? llmBudgetSec * 1000 : Infinity;
  const providerOpts = { providerOverride, providers };
  // Whether any provider is configured at all (keys or test hooks) — decides
  // "failed" vs "none" stamps and whether cached heuristics are worth retrying.
  const llmConfigured = llmUnavailableReason(null, providerOpts) !== "no_llm_provider";
  let llmCallsRemaining = maxLlmCalls;
  let llmStoppedReason = null;
  let llmStoppedAtTicker = null;
  let llmPausedReason = null;
  let llmPausedAtTicker = null;
  let llmPauses = 0;
  let currentTicker = null;
  const elapsedSec = () => Math.round((now() - startedMs) / 1000);

  // Checked before every chunk and every provider attempt. The call cap and
  // the wall-clock budget are terminal (sticky). "No provider usable right
  // now" is a pause, not a stop: an open circuit re-admits a probe after its
  // cooldown and a Groq quota window expires, so later tickers ask again — a
  // per-minute 429 must not cost the rest of the night's LLM coverage.
  const llmGate = () => {
    if (llmStoppedReason) return false;
    let terminal = null;
    if (llmCallsRemaining <= 0) terminal = "max_llm_calls";
    else if (now() - startedMs >= llmBudgetMs) terminal = "llm_budget_sec";
    if (terminal) {
      llmStoppedReason = terminal;
      llmStoppedAtTicker = currentTicker;
      if (maxLlmCalls !== 0) {
        log(`[sector-outlook-themes] LLM stopped (${terminal}) at ${currentTicker || "start"} after ` +
          `${elapsedSec()}s — finishing the walk on cache + heuristic`);
      }
      return false;
    }
    const unavailable = llmUnavailableReason(breaker, providerOpts);
    if (unavailable) {
      if (llmPausedReason === null) {
        llmPausedReason = unavailable;
        llmPausedAtTicker = currentTicker;
        llmPauses += 1;
        log(`[sector-outlook-themes] LLM paused (${unavailable}) at ${currentTicker || "start"} after ` +
          `${elapsedSec()}s — cache + heuristic until a provider is usable again`);
      }
      return false;
    }
    if (llmPausedReason !== null) {
      log(`[sector-outlook-themes] LLM resumed at ${currentTicker} after ${elapsedSec()}s`);
      llmPausedReason = null;
      llmPausedAtTicker = null;
    }
    return true;
  };

  // Load once; the per-call load/write in classifyNewsBatch is what made the
  // cache cost minutes per run. null for --skip-llm / --dry-run (no cache I/O).
  const cache = (skipLlm || dryRun) ? null : loadCache(cachePath);
  const usedHashes = new Set();
  let dirty = false;
  let checkpoints = 0;
  let tickersSinceCheckpoint = 0;
  let lastCheckpointMs = startedMs;

  const flushCache = () => {
    if (!cache || !dirty) return false;
    cache.schema_version = CACHE_SCHEMA;
    cache.updated_at = new Date(now()).toISOString();
    writeCacheAtomic(cache, cachePath);
    dirty = false;
    checkpoints += 1;
    tickersSinceCheckpoint = 0;
    lastCheckpointMs = now();
    return true;
  };

  const onSignal = (signal) => {
    // Handlers run between event-loop turns, never inside a sync write, so the
    // cache object is consistent here. Exit code mirrors the default for the
    // signal so with_timeout / the caller still sees a kill.
    let flushed = false;
    try { flushed = flushCache(); } catch (err) { log(`[sector-outlook-themes] cache flush on ${signal} failed: ${err.message}`); }
    log(`[sector-outlook-themes] ${signal} at ${currentTicker || "start"} — cache ${flushed ? "flushed" : "unchanged"}; exiting`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  if (installSignalHandlers) {
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }

  let totalProcessed = 0;
  let totalNews = 0;
  let totalLlmCalls = 0;
  let totalCacheHits = 0;
  let totalDeferred = 0;
  let orphanedTickers = 0;

  try {
    for (const file of shardedTickerFiles) {
      // One macrotask turn per ticker. Once LLM calls stop, the walk is sync
      // reads/writes plus already-resolved promises — the event loop would
      // never turn, and a SIGTERM handler that never runs never flushes.
      await new Promise((resolve) => setImmediate(resolve));
      const ticker = file.replace(/\.json$/, "");
      currentTicker = ticker;
      const deep = loadDeep(path.join(deepDir, file));
      if (!deep || !Array.isArray(deep.news) || deep.news.length === 0) {
        continue;
      }
      const sourceSector = deep?.overview?.sector || deep?.sector || null;
      if (!sourceSector) {
        orphanedTickers += 1;
        continue;
      }

      // Pass ticker into each news item so the aggregator (downstream)
      // can associate the entry back to the ticker.
      const news = deep.news.map((n) => ({
        ...n,
        _ticker: ticker,
      }));

      if (dryRun) {
        log(`[dry-run] ${ticker}: ${news.length} news items`);
        totalNews += news.length;
        continue;
      }

      const perTickerMaxLlm = !skipLlm && llmGate()
        ? Math.max(0, Math.min(llmCallsRemaining, Math.ceil(news.length / 8)))
        : 0;
      const { results, stats } = await classifyNewsBatch(news, {
        skipLlm,
        maxLlmCalls: perTickerMaxLlm,
        cachePath,
        cache: cache || undefined,
        usedHashes,
        llmGate,
        llmAvailable: llmConfigured,
        breaker,
        providerOverride,
        providers,
        nowMs: now(),
      });
      llmCallsRemaining = Math.max(0, llmCallsRemaining - (stats.llm_calls || 0));

      // Build per-ticker JSONL rows
      const rows = [];
      for (let i = 0; i < news.length; i += 1) {
        const n = news[i];
        const r = results[i];
        if (!r) continue;
        rows.push({
          ticker,
          source_sector: sourceSector,
          news_id: n.id || null,
          date: n.date || null,
          title: n.title || "",
          body_snippet: boundedSnippet(n.body || n.summary || n.description || ""),
          theme: r.theme,
          sign: r.sign,
          intensity: r.intensity,
          confidence: r.confidence,
          time_hint: r.time_hint,
          top_reason: r.top_reason || "",
          classifier_provider: r.classifier_provider,
          classifier_version: r.classifier_version,
        });
      }
      writeJsonlAtomic(path.join(outDir, `${ticker}.jsonl`), rows);

      totalProcessed += 1;
      totalNews += rows.length;
      totalLlmCalls += stats.llm_calls || 0;
      totalCacheHits += stats.cache_hits || 0;
      totalDeferred += stats.llm_deferred || 0;
      if ((stats.cache_writes || 0) > 0) dirty = true;
      tickersSinceCheckpoint += 1;
      if (dirty && (tickersSinceCheckpoint >= checkpointEvery || now() - lastCheckpointMs >= checkpointMs)) {
        flushCache();
      }
      if (verbose) {
        log(`[${totalProcessed}/${shardedTickerFiles.length}] ${ticker}: ${rows.length} news · ${stats.llm_calls || 0} llm · ${stats.cache_hits || 0} cache hits`);
      }
      // Periodic progress every 100 tickers
      if (!verbose && totalProcessed % 100 === 0) {
        log(`[sector-outlook-themes] processed=${totalProcessed} news=${totalNews} llm=${totalLlmCalls} cacheHits=${totalCacheHits} llmRemaining=${llmCallsRemaining === Infinity ? "∞" : llmCallsRemaining}`);
      }
    }
    currentTicker = null;

    // Prune only after a full, unsharded walk: usedHashes then covers every
    // live news item, so only entries for news that left the deep briefs AND
    // are older than the TTL go.
    if (cache && !shard) {
      const before = Object.keys(cache.entries).length;
      pruneCache(cache, usedHashes);
      if (Object.keys(cache.entries).length !== before) dirty = true;
    }
  } finally {
    // Also on a throw mid-walk (ENOSPC, a bug): keep what was paid for since
    // the last checkpoint.
    try { flushCache(); } catch (err) { log(`[sector-outlook-themes] final cache write failed: ${err.message}`); }
    if (installSignalHandlers) {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
  }

  const summary = {
    universe: allTickerFiles.length,
    tickers_in_shard: shardedTickerFiles.length,
    tickers_processed: totalProcessed,
    news_classified: totalNews,
    llm_calls: totalLlmCalls,
    llm_deferred_items: totalDeferred,
    cache_hits: totalCacheHits,
    cache_entries: cache ? Object.keys(cache.entries).length : null,
    cache_checkpoints: checkpoints,
    orphaned_tickers: orphanedTickers,
    // Terminal stop, else a provider pause still in force at the end.
    llm_stopped_reason: llmStoppedReason || llmPausedReason,
    llm_stopped_at_ticker: llmStoppedReason ? llmStoppedAtTicker : llmPausedAtTicker,
    llm_pauses: llmPauses,
    breaker: breaker.snapshot(),
    elapsed_sec: Math.round((now() - startedMs) / 1000),
  };

  log("");
  log(`[sector-outlook-themes] complete`);
  log(`  tickers processed: ${totalProcessed}/${shardedTickerFiles.length}`);
  log(`  news classified:   ${totalNews}`);
  log(`  LLM calls:         ${totalLlmCalls} (${totalDeferred} items deferred to a later run)`);
  log(`  LLM stopped:       ${summary.llm_stopped_reason ? `${summary.llm_stopped_reason} at ${summary.llm_stopped_at_ticker || "start"}` : "no"} · ${llmPauses} provider pause(s)`);
  log(`  providers:         ${Object.entries(summary.breaker).map(([n, s]) => `${n} ok=${s.successes} fail=${s.failures}${s.times_opened ? ` opened×${s.times_opened}` : ""}${s.open ? " OPEN" : ""}`).join(" · ") || "none called"}`);
  log(`  cache hits:        ${totalCacheHits} · entries ${summary.cache_entries ?? "n/a"} · ${checkpoints} writes`);
  log(`  orphaned tickers:  ${orphanedTickers}`);
  log(`  classifier:        ${CLASSIFIER_VERSION} · ${summary.elapsed_sec}s`);

  return summary;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`[sector-outlook-themes] starting · ${new Date().toISOString()}`);
  console.log(`[sector-outlook-themes] classifier=${CLASSIFIER_VERSION} skipLlm=${args.skipLlm} maxLlmCalls=${args.maxLlmCalls} llmBudgetSec=${args.llmBudgetSec}${args.shard ? ` shard=${args.shard}/${args.nShards}` : ""}`);
  await refreshSectorNewsThemes({ ...args, installSignalHandlers: true });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error(`[sector-outlook-themes] FATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });
}
