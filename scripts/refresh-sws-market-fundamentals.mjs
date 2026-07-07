#!/usr/bin/env node
/**
 * Refresh modal-ready Yahoo fundamentals for US/KR/TW SWS picks.
 *
 * Offline-only data job: this script imports yahoo-finance2, writes compact
 * fundamentals-latest.json snapshots under data/sws-us/, and the server
 * only reads the committed JSON. No modal-open runtime fetches.
 *
 * Examples:
 *   node scripts/refresh-sws-market-fundamentals.mjs --region all
 *   node scripts/refresh-sws-market-fundamentals.mjs --region us --scope scored --limit 200
 *   node scripts/refresh-sws-market-fundamentals.mjs --region us --only-missing
 */

import fs from "node:fs";
import path from "node:path";
import YahooFinance from "yahoo-finance2";
import { PATHS as US_PATHS } from "./sws-config-us.mjs";
import { makeRegionConfig } from "./sws-config-region.mjs";
import { getRegion } from "./sws-regions.mjs";
import {
  MARKET_FUNDAMENTALS_FILE,
  MARKET_FUNDAMENTALS_SCHEMA_VERSION,
  compactFundamentalsRecord,
  hasAnyFundamentalMetric,
  normalizeYahooFundamentals,
  normaliseTickerKey,
  yahooSymbolCandidates,
} from "../services/swsMarketFundamentals.js";

const DEFAULTS = {
  region: "all",
  scope: "picks",
  limit: null,
  onlyMissing: false,
  ttlDays: 7,
  concurrency: 4,
};

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--region") opts.region = String(argv[++i] || "").toLowerCase();
    else if (a === "--scope") opts.scope = String(argv[++i] || "").toLowerCase();
    else if (a === "--limit") opts.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--only-missing") opts.onlyMissing = true;
    else if (a === "--ttl-days") opts.ttlDays = Math.max(1, Number(argv[++i]) || DEFAULTS.ttlDays);
    else if (a === "--concurrency") opts.concurrency = Math.max(1, Number(argv[++i]) || DEFAULTS.concurrency);
    else if (a === "--help" || a === "-h") {
      console.log("usage: node scripts/refresh-sws-market-fundamentals.mjs --region us|kr|tw|all [--scope picks|scored] [--limit N] [--only-missing] [--ttl-days N] [--concurrency N]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!["us", "all"].includes(opts.region)) throw new Error("--region must be us|all");
  if (!["picks", "scored"].includes(opts.scope)) throw new Error("--scope must be picks|scored");
  return opts;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function regionRuntime(code) {
  if (code === "us") {
    const region = getRegion("us");
    return {
      code,
      label: region.label,
      currency: region.currencyIso,
      dataDir: US_PATHS.dataDir,
      picksLatest: US_PATHS.picksLatest,
      scoredUniverse: US_PATHS.scoredUniverse,
      outputPath: path.join(US_PATHS.dataDir, MARKET_FUNDAMENTALS_FILE),
    };
  }
  const cfg = makeRegionConfig(code);
  return {
    code,
    label: cfg.region.label,
    currency: cfg.region.currencyIso,
    dataDir: cfg.PATHS.dataDir,
    picksLatest: cfg.PATHS.picksLatest,
    scoredUniverse: cfg.PATHS.scoredUniverse,
    outputPath: path.join(cfg.PATHS.dataDir, MARKET_FUNDAMENTALS_FILE),
  };
}

function tickersFromPicks(raw) {
  const seen = new Set();
  for (const items of Object.values(raw?.sections || {})) {
    if (!Array.isArray(items)) continue;
    for (const row of items) {
      const key = normaliseTickerKey(row?.ticker);
      if (key) seen.add(key);
    }
  }
  return [...seen];
}

function tickersFromScored(raw) {
  const rows = Array.isArray(raw) ? raw : raw?.stocks || [];
  const seen = new Set();
  for (const row of rows) {
    const key = normaliseTickerKey(row?.ticker);
    if (key) seen.add(key);
  }
  return [...seen];
}

function loadTickerList(runtime, scope) {
  if (scope === "scored") return tickersFromScored(readJson(runtime.scoredUniverse, {}));
  return tickersFromPicks(readJson(runtime.picksLatest, {}));
}

function recordIsFresh(record, ttlDays) {
  const t = Date.parse(record?.fetched_at || "");
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= ttlDays * 24 * 60 * 60 * 1000;
}

function isRateLimitError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return /429|too many requests|rate.?limit/.test(msg) || err?.response?.status === 429;
}

async function fetchForSymbol(yf, ticker, yahooSymbol) {
  const period1 = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000);
  const [summary, timeSeriesRows] = await Promise.all([
    yf.quoteSummary(yahooSymbol, {
      modules: ["financialData", "defaultKeyStatistics", "summaryDetail", "price"],
    }),
    yf.fundamentalsTimeSeries(yahooSymbol, {
      period1,
      type: "annual",
      module: "all",
    }).catch((err) => {
      if (isRateLimitError(err)) throw err;
      return [];
    }),
  ]);
  return compactFundamentalsRecord(normalizeYahooFundamentals({
    ticker,
    yahooSymbol,
    summary,
    timeSeriesRows,
    fetchedAt: new Date().toISOString(),
  }));
}

async function fetchTicker(yf, runtime, ticker) {
  const candidates = yahooSymbolCandidates(ticker, runtime.code);
  let lastError = null;
  for (const yahooSymbol of candidates) {
    try {
      const record = await fetchForSymbol(yf, ticker, yahooSymbol);
      if (hasAnyFundamentalMetric(record)) return { ticker, record, yahooSymbol };
      lastError = new Error("no_modal_metrics");
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      lastError = err;
    }
  }
  return {
    ticker,
    failure: {
      ticker,
      yahoo_symbols_tried: candidates,
      failed_at: new Date().toISOString(),
      error: String(lastError?.message || lastError || "unknown_error").slice(0, 500),
    },
  };
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const results = [];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function refreshRegion(yf, runtime, opts) {
  const previous = readJson(runtime.outputPath, {});
  const stocks = { ...(previous.stocks || {}) };
  const failures = { ...(previous.failures || {}) };
  let tickers = loadTickerList(runtime, opts.scope);
  if (opts.limit != null) tickers = tickers.slice(0, opts.limit);

  const toFetch = [];
  let skipped = 0;
  for (const ticker of tickers) {
    const existing = stocks[ticker];
    if (opts.onlyMissing && existing) {
      skipped += 1;
      continue;
    }
    if (!opts.onlyMissing && existing && recordIsFresh(existing, opts.ttlDays)) {
      skipped += 1;
      continue;
    }
    toFetch.push(ticker);
  }

  console.log(`[${runtime.code}] ${tickers.length} ${opts.scope} tickers · ${toFetch.length} refresh · ${skipped} skip`);

  let refreshed = 0;
  let failed = 0;
  await runPool(toFetch, opts.concurrency, async (ticker, i) => {
    const result = await fetchTicker(yf, runtime, ticker);
    if (result.record) {
      stocks[ticker] = result.record;
      delete failures[ticker];
      refreshed += 1;
      console.log(`[${runtime.code}] ${i + 1}/${toFetch.length} ok ${ticker} via ${result.yahooSymbol}`);
    } else {
      failures[ticker] = result.failure;
      failed += 1;
      console.log(`[${runtime.code}] ${i + 1}/${toFetch.length} fail ${ticker}: ${result.failure.error}`);
    }
  });

  const snapshot = {
    schema_version: MARKET_FUNDAMENTALS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    region: runtime.code.toUpperCase(),
    currency: runtime.currency,
    source: "yahoo-finance2",
    scope: opts.scope,
    ttl_days: opts.ttlDays,
    requested: tickers.length,
    refreshed,
    skipped,
    failed,
    stocks,
    failures,
  };
  writeJson(runtime.outputPath, snapshot);
  console.log(`[${runtime.code}] wrote ${runtime.outputPath} (${Object.keys(stocks).length} stocks, ${Object.keys(failures).length} failures)`);
}

async function main() {
  const opts = parseArgs();
  const codes = opts.region === "all" ? ["us"] : [opts.region];
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });
  for (const code of codes) {
    await refreshRegion(yf, regionRuntime(code), opts);
  }
}

main().catch((err) => {
  console.error(`[sws-market-fundamentals] ${err.stack || err.message || err}`);
  process.exit(1);
});
