#!/usr/bin/env node
/**
 * Weekly Groww/Refinitiv P/E cache for the SWS FV relative-P/E leg.
 *
 * Groww's stock pages expose Refinitiv-backed fundamentals in __NEXT_DATA__:
 *   props.pageProps.stockData.header / stockData.stats
 *
 * The SWS nightly calls this script before parsing raw SWS API payloads. The
 * script is TTL-gated by default, so twice-daily SWS runs reuse the last good
 * Groww snapshot unless it is older than --max-age-days.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const DEFAULT_CACHE_PATH = path.join(REPO_ROOT, "data/sws/groww-pe-latest.json");
export const DEFAULT_FAILURE_PATH = path.join(REPO_ROOT, "data/sws/groww-pe-failed.json");
const DEFAULT_UNIVERSE_PATH = path.join(REPO_ROOT, "data/sws/universe.json");
const BASE_URL = "https://groww.in";
const FILTER_URL = `${BASE_URL}/stocks/filter`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (minMs = 120, maxMs = 550) =>
  minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs));

function daysToMs(days) {
  return Number(days) * 86400 * 1000;
}

function toIso(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function sanePe(value) {
  const n = asNumber(value);
  return n != null && n > 0 && n < 500 ? n : null;
}

export function normalizeTicker(value) {
  if (value == null) return null;
  const t = String(value).trim().toUpperCase();
  if (!t) return null;
  return t
    .replace(/^NSE:/, "")
    .replace(/^BSE:/, "")
    .replace(/\.NS$/, "")
    .replace(/\.BO$/, "");
}

function extractNextData(html) {
  if (typeof html !== "string" || !html) return null;
  const m = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export function parseGrowwNextData(html, url = null, fetchedAt = new Date().toISOString()) {
  const next = extractNextData(html);
  const stockData = next?.props?.pageProps?.stockData;
  const header = stockData?.header || {};
  const stats = stockData?.stats || {};
  const peRatio = sanePe(stats.peRatio);
  const industryPe = sanePe(stats.industryPe ?? stats.sectorPe);
  const sectorPe = sanePe(stats.sectorPe);

  return {
    searchId: header.searchId || null,
    growwCompanyId: header.growwCompanyId || header.growwContractId || null,
    isin: header.isin || null,
    industryId: header.industryId ?? null,
    industryName: header.industryName || null,
    nseScriptCode: header.nseScriptCode || null,
    bseScriptCode: header.bseScriptCode != null ? String(header.bseScriptCode) : null,
    peRatio,
    epsTtm: asNumber(stats.epsTtm),
    industryPe,
    sectorPe,
    fetchedAt,
    url: url || (header.searchId ? `${BASE_URL}/stocks/${header.searchId}` : null),
  };
}

export function parseGrowwScreenerRecords(html) {
  const next = extractNextData(html);
  const screener = next?.props?.pageProps?.screenerData;
  const records = Array.isArray(screener?.records) ? screener.records : [];
  return {
    records,
    totalRecords: Number.isFinite(Number(screener?.totalRecords))
      ? Number(screener.totalRecords)
      : null,
  };
}

export function isCacheFresh(cache, now = new Date(), maxAgeDays = 7) {
  if (!cache || typeof cache !== "object") return false;
  const fetchedAt = Date.parse(cache.fetched_at || cache.fetchedAt || "");
  if (!Number.isFinite(fetchedAt)) return false;
  const expiresAt = Date.parse(cache.expires_at || "");
  if (Number.isFinite(expiresAt)) return now.getTime() < expiresAt;
  return now.getTime() - fetchedAt < daysToMs(maxAgeDays);
}

export function isCacheUsable(cache, now = new Date(), staleGraceDays = 21) {
  if (!cache || typeof cache !== "object") return false;
  const fetchedAt = Date.parse(cache.fetched_at || cache.fetchedAt || "");
  if (!Number.isFinite(fetchedAt)) return false;
  if (now.getTime() - fetchedAt > daysToMs(staleGraceDays)) return false;
  const byTicker = cache.by_ticker || {};
  return Object.keys(byTicker).length > 0;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
}

function loadUniverseTickers(file) {
  const raw = readJson(file);
  const arr = Array.isArray(raw) ? raw : (raw?.stocks || raw?.universe || []);
  return arr
    .map((row) => normalizeTicker(row?.ticker || row?.symbol || row))
    .filter(Boolean);
}

export function buildTickerMap(records) {
  const map = new Map();
  for (const rec of records || []) {
    const keys = [
      rec.nseScriptCode,
      rec.bseScriptCode,
      rec.nseTradingSymbol,
      rec.bseTradingSymbol,
    ].map(normalizeTicker).filter(Boolean);
    for (const key of keys) {
      if (!map.has(key)) map.set(key, rec);
    }
  }
  return map;
}

function parseArgs(argv) {
  const opts = {
    out: DEFAULT_CACHE_PATH,
    failureOut: DEFAULT_FAILURE_PATH,
    universe: DEFAULT_UNIVERSE_PATH,
    maxAgeDays: 7,
    staleGraceDays: 21,
    concurrency: 6,
    retries: 2,
    timeoutMs: 15000,
    minCoveragePct: 70,
    force: false,
    dryRun: false,
    tickers: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") opts.force = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--out") opts.out = path.resolve(argv[++i]);
    else if (arg === "--failure-out") opts.failureOut = path.resolve(argv[++i]);
    else if (arg === "--universe") opts.universe = path.resolve(argv[++i]);
    else if (arg === "--max-age-days") opts.maxAgeDays = Number(argv[++i]);
    else if (arg === "--stale-grace-days") opts.staleGraceDays = Number(argv[++i]);
    else if (arg === "--concurrency") opts.concurrency = Number(argv[++i]);
    else if (arg === "--retries") opts.retries = Number(argv[++i]);
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (arg === "--min-coverage-pct") opts.minCoveragePct = Number(argv[++i]);
    else if (arg === "--tickers") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) opts.tickers.push(argv[++i]);
    } else if (!arg.startsWith("--")) {
      opts.tickers.push(arg);
    }
  }
  opts.tickers = opts.tickers.map(normalizeTicker).filter(Boolean);
  return opts;
}

async function fetchText(url, { timeoutMs = 15000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) await sleep((attempt + 1) * 700 + jitter());
    }
  }
  throw lastErr || new Error("fetch failed");
}

async function fetchScreenerRecords(opts) {
  const records = [];
  let totalRecords = null;
  for (let page = 0; page < 80; page++) {
    const url = `${FILTER_URL}?page=${page}&size=100`;
    const html = await fetchText(url, opts);
    const parsed = parseGrowwScreenerRecords(html);
    if (totalRecords == null && parsed.totalRecords != null) totalRecords = parsed.totalRecords;
    if (!parsed.records.length) break;
    records.push(...parsed.records);
    if (totalRecords != null && records.length >= totalRecords) break;
    await sleep(jitter(150, 450));
  }
  return { records, totalRecords };
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function refreshCache(opts) {
  const now = new Date();
  const fetchedAt = now.toISOString();
  const targetTickers = opts.tickers.length
    ? [...new Set(opts.tickers)]
    : [...new Set(loadUniverseTickers(opts.universe))];
  if (!targetTickers.length) throw new Error(`no tickers found in ${opts.universe}`);

  console.log(`[groww-pe] target tickers=${targetTickers.length}`);
  console.log("[groww-pe] loading Groww screener map...");
  const { records, totalRecords } = await fetchScreenerRecords({
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
  });
  const tickerMap = buildTickerMap(records);
  console.log(`[groww-pe] screener records=${records.length}${totalRecords != null ? `/${totalRecords}` : ""}, ticker keys=${tickerMap.size}`);

  const unmapped = [];
  const targets = [];
  for (const ticker of targetTickers) {
    const rec = tickerMap.get(ticker);
    if (!rec?.searchId) {
      unmapped.push(ticker);
      continue;
    }
    targets.push({ ticker, rec });
  }

  const byTicker = {};
  const fetchFailed = [];
  const fetched = await mapLimit(targets, opts.concurrency, async ({ ticker, rec }) => {
    const url = `${BASE_URL}/stocks/${rec.searchId}`;
    try {
      await sleep(jitter(80, 350));
      const html = await fetchText(url, { timeoutMs: opts.timeoutMs, retries: opts.retries });
      const parsed = parseGrowwNextData(html, url, fetchedAt);
      if (!parsed.searchId) throw new Error("stockData missing");
      return { ticker, parsed };
    } catch (err) {
      return { ticker, error: err?.message || String(err), searchId: rec.searchId, url };
    }
  });

  for (const item of fetched) {
    if (item?.parsed) byTicker[item.ticker] = item.parsed;
    else if (item) fetchFailed.push(item);
  }

  const usableCount = Object.values(byTicker)
    .filter((entry) => sanePe(entry.peRatio) != null && sanePe(entry.industryPe) != null)
    .length;
  const coveragePct = targetTickers.length ? (usableCount / targetTickers.length) * 100 : 0;
  const cache = {
    schema_version: "groww-pe-v1",
    source: "groww_refinitiv",
    fetched_at: fetchedAt,
    expires_at: new Date(now.getTime() + daysToMs(opts.maxAgeDays)).toISOString(),
    max_age_days: opts.maxAgeDays,
    stale_grace_days: opts.staleGraceDays,
    coverage: {
      target_count: targetTickers.length,
      screener_records_count: records.length,
      screener_total_records: totalRecords,
      mapped_count: targets.length,
      fetched_count: Object.keys(byTicker).length,
      usable_count: usableCount,
      coverage_pct: Math.round(coveragePct * 100) / 100,
    },
    by_ticker: byTicker,
    missing: {
      unmapped,
      fetch_failed: fetchFailed,
    },
  };

  return cache;
}

function writeFailureReport(file, report) {
  try {
    writeJsonAtomic(file, {
      schema_version: "groww-pe-failure-v1",
      source: "groww_refinitiv",
      generated_at: new Date().toISOString(),
      ...report,
    });
  } catch (err) {
    console.warn(`[groww-pe] failed to write failure report: ${err.message}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const existing = readJson(opts.out);

  if (!opts.force && isCacheFresh(existing, new Date(), opts.maxAgeDays)) {
    const cov = existing.coverage || {};
    console.log(`[groww-pe] cache fresh (${existing.fetched_at}); usable=${cov.usable_count ?? "?"}/${cov.target_count ?? "?"}, coverage=${cov.coverage_pct ?? "?"}%`);
    return;
  }

  let cache;
  try {
    cache = await refreshCache(opts);
  } catch (err) {
    const usableExisting = isCacheUsable(existing, new Date(), opts.staleGraceDays);
    writeFailureReport(opts.failureOut, {
      status: usableExisting ? "refresh_failed_using_stale_cache" : "refresh_failed_no_usable_cache",
      error: err?.message || String(err),
      previous_cache_fetched_at: existing?.fetched_at || null,
    });
    if (usableExisting) {
      console.warn(`[groww-pe] refresh failed (${err.message}); using stale cache from ${existing.fetched_at}`);
      return;
    }
    throw err;
  }

  const coveragePct = Number(cache.coverage?.coverage_pct ?? 0);
  const previousUsable = isCacheUsable(existing, new Date(), opts.staleGraceDays);
  if (coveragePct < opts.minCoveragePct && previousUsable) {
    writeFailureReport(opts.failureOut, {
      status: "coverage_below_floor_using_stale_cache",
      coverage: cache.coverage,
      previous_cache_fetched_at: existing?.fetched_at || null,
      missing: cache.missing,
    });
    console.warn(`[groww-pe] coverage ${coveragePct}% below ${opts.minCoveragePct}%; keeping stale cache from ${existing.fetched_at}`);
    return;
  }
  if (coveragePct < opts.minCoveragePct) {
    writeFailureReport(opts.failureOut, {
      status: "coverage_below_floor_no_usable_cache",
      coverage: cache.coverage,
      missing: cache.missing,
    });
    throw new Error(`Groww P/E coverage ${coveragePct}% below floor ${opts.minCoveragePct}%`);
  }

  if (opts.dryRun) {
    console.log(`[groww-pe] dry-run: would write ${opts.out}`);
  } else {
    writeJsonAtomic(opts.out, cache);
    writeFailureReport(opts.failureOut, {
      status: "ok",
      coverage: cache.coverage,
      missing: {
        unmapped_count: cache.missing.unmapped.length,
        fetch_failed_count: cache.missing.fetch_failed.length,
        unmapped_sample: cache.missing.unmapped.slice(0, 25),
        fetch_failed_sample: cache.missing.fetch_failed.slice(0, 10),
      },
    });
  }
  console.log(`[groww-pe] cache ${opts.dryRun ? "validated" : "written"}: usable=${cache.coverage.usable_count}/${cache.coverage.target_count}, coverage=${cache.coverage.coverage_pct}%`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[groww-pe] ERROR: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}
