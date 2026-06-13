#!/usr/bin/env node
/**
 * Walks data/sws/deep/*.json, classifies every news[] item via the
 * heuristic-first + LLM-refine pipeline, and writes per-ticker JSONL
 * to data/sectorOutlook/classified-news/<TICKER>.jsonl.
 *
 * Runs LOCALLY (chained into scripts/sws-nightly.sh after the SWS deep
 * refresh) — never on Vercel cron. The Gemini/Groq keys live on the
 * developer's machine. CI calls with --skip-llm.
 *
 * Cost story: 5,517 tickers × ~15 news avg ≈ 83k items. With heuristic-
 * first scoping (high-confidence pass-through) and 365d recency, the
 * LLM-refine slice is typically ~2-5k items on a cold cache and <500
 * per day steady-state. Fits Gemini free tier (15 RPM × 1500 RPD) with
 * --max-llm-calls=N as the hard ceiling.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyNewsBatch,
  CACHE_PATH,
} from "../services/sectorOutlook/llmThemeRefiner.js";
import { CLASSIFIER_VERSION } from "../services/sectorOutlook/themeTaxonomy.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const DEEP_DIR = path.join(ROOT, "data", "sws", "deep");
const OUT_DIR = path.join(ROOT, "data", "sectorOutlook", "classified-news");
const BODY_SNIPPET_MAX = 500;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    skipLlm: false,
    maxLlmCalls: Infinity,
    shard: null,
    nShards: 1,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--skip-llm") args.skipLlm = true;
    else if (arg.startsWith("--max-llm-calls=")) {
      args.maxLlmCalls = Number(arg.split("=")[1]) || Infinity;
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
        "  --dry-run            don't write JSONL files; print what would be done\n" +
        "  --skip-llm           heuristic-only (CI / no keys)\n" +
        "  --max-llm-calls=N    cap LLM batches across all tickers (default: unlimited)\n" +
        "  --shard=i/n          process only ticker shard i of n (1-indexed)\n" +
        "  --verbose            print per-ticker progress\n"
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

async function main() {
  const args = parseArgs(process.argv);
  console.log(`[sector-outlook-themes] starting · ${new Date().toISOString()}`);
  console.log(`[sector-outlook-themes] classifier=${CLASSIFIER_VERSION} skipLlm=${args.skipLlm} maxLlmCalls=${args.maxLlmCalls}${args.shard ? ` shard=${args.shard}/${args.nShards}` : ""}`);

  if (!fs.existsSync(DEEP_DIR)) {
    console.error(`[sector-outlook-themes] FATAL: ${DEEP_DIR} not found`);
    process.exit(1);
  }

  const allTickerFiles = fs.readdirSync(DEEP_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const shardedTickerFiles = allTickerFiles.filter((f) => {
    const ticker = f.replace(/\.json$/, "");
    return inShard(ticker, args.shard, args.nShards);
  });

  console.log(`[sector-outlook-themes] universe=${allTickerFiles.length} shard=${shardedTickerFiles.length}`);

  let totalProcessed = 0;
  let totalNews = 0;
  let totalLlmCalls = 0;
  let totalCacheHits = 0;
  let orphanedTickers = 0;
  let llmCallsRemaining = args.maxLlmCalls;

  for (const file of shardedTickerFiles) {
    const ticker = file.replace(/\.json$/, "");
    const deep = loadDeep(path.join(DEEP_DIR, file));
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

    if (args.dryRun) {
      console.log(`[dry-run] ${ticker}: ${news.length} news items`);
      totalNews += news.length;
      continue;
    }

    const perTickerMaxLlm = Math.max(0, Math.min(llmCallsRemaining, Math.ceil(news.length / 8)));
    const { results, stats } = await classifyNewsBatch(news, {
      skipLlm: args.skipLlm,
      maxLlmCalls: perTickerMaxLlm,
      cachePath: CACHE_PATH,
    });
    llmCallsRemaining = Math.max(0, llmCallsRemaining - stats.llm_calls);

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
    writeJsonlAtomic(path.join(OUT_DIR, `${ticker}.jsonl`), rows);

    totalProcessed += 1;
    totalNews += rows.length;
    totalLlmCalls += stats.llm_calls;
    totalCacheHits += stats.cache_hits;
    if (args.verbose) {
      console.log(`[${totalProcessed}/${shardedTickerFiles.length}] ${ticker}: ${rows.length} news · ${stats.llm_calls} llm · ${stats.cache_hits} cache hits`);
    }
    // Periodic progress every 100 tickers
    if (!args.verbose && totalProcessed % 100 === 0) {
      console.log(`[sector-outlook-themes] processed=${totalProcessed} news=${totalNews} llm=${totalLlmCalls} cacheHits=${totalCacheHits} llmRemaining=${llmCallsRemaining === Infinity ? "∞" : llmCallsRemaining}`);
    }
  }

  console.log("");
  console.log(`[sector-outlook-themes] complete`);
  console.log(`  tickers processed: ${totalProcessed}`);
  console.log(`  news classified:   ${totalNews}`);
  console.log(`  LLM calls:         ${totalLlmCalls}`);
  console.log(`  cache hits:        ${totalCacheHits}`);
  console.log(`  orphaned tickers:  ${orphanedTickers}`);
  console.log(`  classifier:        ${CLASSIFIER_VERSION}`);
}

main().catch((err) => {
  console.error(`[sector-outlook-themes] FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
