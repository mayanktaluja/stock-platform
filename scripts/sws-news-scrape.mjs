#!/usr/bin/env node
/**
 * SWS news refresh — targeted scrape of displayed picks.
 *
 * India keeps its historical coverage union (picks + portfolio + watchlist).
 * US/KR/TW use every ticker displayed in their picks-latest.json sections so
 * any card the modal can open receives SWS Brief/Event activity.
 *
 * Pipeline:
 *   1. Build coverage union, intersected against the market universe.json.
 *   2. For each ticker, fetch CompanySummary (companyId) + getCompanyUpdates
 *      via the existing API client.
 *   3. Parse each response with the market parser (India / US / KR/TW).
 *   4. Merge only `news` + `overview.recent_news_count` into the existing
 *      deep/<TICKER>.json file (atomic read-mutate-write).
 *   5. Write data/sws[-market]/news-latest.json aggregate sorted DESC by date.
 *
 * Safety hooks (reuses existing infra):
 *   - panic-stop.flag: aborts if set (never auto-creates one — failures are
 *     non-fatal since news is enrichment, not core pipeline).
 *   - auth_expired / rate_limited / blocked errors propagate from the client
 *     and abort the run early to avoid burning rate-limit budget.
 *
 * Usage:
 *   node scripts/sws-news-scrape.mjs                    # full coverage set
 *   node scripts/sws-news-scrape.mjs --market us        # US displayed cards
 *   node scripts/sws-news-scrape.mjs --market kr        # Korea displayed cards
 *   node scripts/sws-news-scrape.mjs --market tw        # Taiwan displayed cards
 *   node scripts/sws-news-scrape.mjs --market us --shard-id 1 --shard-count 3
 *   node scripts/sws-news-scrape.mjs --market us --merge-shards --shard-count 3
 *   node scripts/sws-news-scrape.mjs --limit 5          # test small batch
 *   node scripts/sws-news-scrape.mjs --tickers RELIANCE,TCS,HDFCBANK
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, fetchStockData, TransportError } from "./sws-api-client.mjs";
import { parseStock } from "./sws-api-parser.mjs";
import { parseStockUS } from "./sws-api-parser-us.mjs";
import { PATHS as US_PATHS } from "./sws-config-us.mjs";
import { parseStockRegion } from "./sws-api-parser-region.mjs";
import { makeRegionConfig } from "./sws-config-region.mjs";
import { getRegion } from "./sws-regions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SWS_REPO_ROOT_OVERRIDE || path.resolve(__dirname, "..");

const PORTFOLIOS_PATH = path.join(REPO_ROOT, "portfolios.json");
const WATCHLIST_PATH = path.join(REPO_ROOT, ".watchlist.json");

// Pacing — half the deep-scrape pace since runtime is tiny.
const INTER_STOCK_MIN_MS = 1000;
const INTER_STOCK_MAX_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min));
const replaceJsonSuffix = (fp, suffix) => fp.replace(/\.json$/i, `${suffix}.json`);

function logEvent(obj) {
  console.log(JSON.stringify(obj));
}

export function makeNewsMarketConfig(market = "in") {
  const m = String(market || "in").toLowerCase();
  if (m === "in" || m === "india") {
    const dataDir = path.join(REPO_ROOT, "data", "sws");
    return {
      market: "in",
      label: "India",
      dataDir,
      universePath: path.join(dataDir, "universe.json"),
      picksPath: path.join(dataDir, "picks-latest.json"),
      deepDir: path.join(dataDir, "deep"),
      progressPath: path.join(dataDir, "news-progress.json"),
      newsLatestPath: path.join(dataDir, "news-latest.json"),
      panicFlag: path.join(dataDir, "panic-stop.flag"),
      parseApi: (api) => parseStock(api),
      fixedCoverageSections: COVERAGE_SECTIONS,
      includePortfolioWatchlist: true,
    };
  }
  if (m === "us") {
    const dataDir = US_PATHS.dataDir;
    return {
      market: "us",
      label: "US",
      dataDir,
      universePath: US_PATHS.universe,
      picksPath: US_PATHS.picksLatest,
      deepDir: US_PATHS.deepDir,
      progressPath: path.join(dataDir, "news-progress.json"),
      newsLatestPath: path.join(dataDir, "news-latest.json"),
      panicFlag: US_PATHS.panicStop,
      parseApi: (api) => parseStockUS(api),
      fixedCoverageSections: null,
      includePortfolioWatchlist: false,
    };
  }
  if (m === "kr" || m === "tw") {
    const region = getRegion(m);
    const cfg = makeRegionConfig(m);
    return {
      market: m,
      label: region.label,
      dataDir: cfg.PATHS.dataDir,
      universePath: cfg.PATHS.universe,
      picksPath: cfg.PATHS.picksLatest,
      deepDir: cfg.PATHS.deepDir,
      progressPath: path.join(cfg.PATHS.dataDir, "news-progress.json"),
      newsLatestPath: path.join(cfg.PATHS.dataDir, "news-latest.json"),
      panicFlag: cfg.PATHS.panicStop,
      parseApi: (api) => parseStockRegion(api, region),
      fixedCoverageSections: null,
      includePortfolioWatchlist: false,
    };
  }
  throw new Error(`unsupported market '${market}' (expected in|us|kr|tw)`);
}

function checkPanic(config) {
  return fs.existsSync(config.panicFlag);
}

export function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.warn(`[news] failed to read ${p}: ${e.message}`);
    return fallback;
  }
}

// ────────── Coverage-set assembly ──────────

// Sections we mine for picks. Mirrors NARRATE_SECTIONS in sws-narrate-picks.mjs
// plus the top-ranked section. `avoid` is intentionally INCLUDED — if a stock
// is on the user's avoid list, recent news is exactly how they'd validate the
// avoid call ("did the bad thing actually happen").
const COVERAGE_SECTIONS = [
  "top_ranked_30_v3",
  "best_to_buy_now",
  "deep_value",
  "quality_growth",
  "midterm",
  "dividend_aristocrats",
  "smallcap_gems",
  "insider_buying",
  "upcoming_earnings",
  "avoid",
];

export function tickersFromPicks(config = makeNewsMarketConfig()) {
  const picks = readJsonSafe(config.picksPath, null);
  if (!picks || !picks.sections) {
    console.warn(`[news:${config.market}] picks-latest.json missing or empty — skipping picks set`);
    return new Set();
  }
  const out = new Set();
  const sectionKeys = Array.isArray(config.fixedCoverageSections)
    ? config.fixedCoverageSections
    : Object.keys(picks.sections);
  for (const key of sectionKeys) {
    const arr = picks.sections[key];
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      if (p?.ticker) out.add(String(p.ticker).toUpperCase());
    }
  }
  return out;
}

function tickersFromWatchlist() {
  // Local-dev shape only. Production KV has its own scan but the nightly
  // job is laptop-side — see plan R4.
  const items = readJsonSafe(WATCHLIST_PATH, []);
  const out = new Set();
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    const sym = it?.symbol || it?.ticker;
    if (sym) out.add(String(sym).toUpperCase());
  }
  return out;
}

function tickersFromPortfolio() {
  // portfolios.json is `{ [sub]: { stocks: [...], mutualFunds: [...], ... } }`.
  // Walk every sub and union all stock symbols. (Mutual funds intentionally
  // ignored — SWS doesn't index Indian MF schemes.)
  const map = readJsonSafe(PORTFOLIOS_PATH, {});
  const out = new Set();
  if (!map || typeof map !== "object") return out;
  for (const sub of Object.keys(map)) {
    const stocks = map[sub]?.stocks;
    if (!Array.isArray(stocks)) continue;
    for (const s of stocks) {
      const sym = s?.symbol || s?.ticker;
      if (sym) out.add(String(sym).toUpperCase());
    }
  }
  return out;
}

function loadUniverse(config) {
  const raw = readJsonSafe(config.universePath, null);
  if (!raw) {
    throw new Error(`universe.json not found at ${config.universePath}`);
  }
  return Array.isArray(raw) ? raw : raw.stocks || raw.universe || [];
}

export function buildCoverageList(opts = {}, config = makeNewsMarketConfig(opts.market)) {
  // Returns: [{ ticker, canonicalUrl, name, sector }]
  const universe = loadUniverse(config);
  const indexByTicker = new Map();
  for (const u of universe) {
    if (u?.ticker) indexByTicker.set(String(u.ticker).toUpperCase(), u);
  }

  let union;
  if (opts.tickers) {
    union = new Set(opts.tickers.map((t) => String(t).toUpperCase()));
  } else {
    const picksSet = tickersFromPicks(config);
    if (config.includePortfolioWatchlist) {
      const watchSet = tickersFromWatchlist();
      const portSet = tickersFromPortfolio();
      union = new Set([...picksSet, ...watchSet, ...portSet]);
      console.log(
        `[news:${config.market}] coverage union: picks=${picksSet.size} watchlist=${watchSet.size} ` +
        `portfolio=${portSet.size} union=${union.size}`,
      );
    } else {
      union = picksSet;
      console.log(`[news:${config.market}] coverage union: displayed_sections=${picksSet.size}`);
    }
  }

  const list = [];
  const missing = [];
  for (const t of union) {
    const stock = indexByTicker.get(t);
    if (!stock) {
      missing.push(t);
      continue;
    }
    const canonicalUrl = (stock.sws_url || stock.canonicalUrl || stock.canonical_url || "").replace(/^https?:\/\/simplywall\.st/, "");
    if (!canonicalUrl) continue;
    list.push({
      ticker: t,
      canonicalUrl,
      name: stock.name || null,
      sector: stock.sector || null,
    });
  }
  if (missing.length) {
    console.log(`[news:${config.market}] ${missing.length} ticker(s) not in universe (skipped): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`);
  }
  // Stable order so progress + retries are deterministic.
  list.sort((a, b) => a.ticker.localeCompare(b.ticker));
  if (opts.limit) return list.slice(0, opts.limit);
  return list;
}

export function normaliseShardArgs(args = {}) {
  const shardCount = Number.parseInt(args.shardCount ?? 1, 10);
  const shardId = Number.parseInt(args.shardId ?? 1, 10);
  if (!Number.isFinite(shardCount) || shardCount < 1) {
    throw new Error(`invalid --shard-count '${args.shardCount}'`);
  }
  if (!Number.isFinite(shardId) || shardId < 1 || shardId > shardCount) {
    throw new Error(`invalid --shard-id '${args.shardId}' for shard-count ${shardCount}`);
  }
  return { shardId, shardCount };
}

export function shardCoverageList(list, args = {}) {
  const { shardId, shardCount } = normaliseShardArgs(args);
  if (shardCount <= 1) return list;
  return list.filter((_, idx) => idx % shardCount === shardId - 1);
}

export function progressPathForRun(config, args = {}) {
  const { shardId, shardCount } = normaliseShardArgs(args);
  return shardCount > 1 ? replaceJsonSuffix(config.progressPath, `-${shardId}`) : config.progressPath;
}

export function newsLatestPathForRun(config, args = {}) {
  const { shardId, shardCount } = normaliseShardArgs(args);
  return shardCount > 1 ? replaceJsonSuffix(config.newsLatestPath, `-${shardId}`) : config.newsLatestPath;
}

export function mergeShardAggregates(config, shardCount) {
  const count = Number.parseInt(shardCount, 10);
  if (!Number.isFinite(count) || count < 1) {
    throw new Error(`invalid shard count '${shardCount}'`);
  }
  const items = [];
  const shards = [];
  let coverageCount = 0;
  for (let shardId = 1; shardId <= count; shardId++) {
    const newsPath = newsLatestPathForRun(config, { shardId, shardCount: count });
    const progressPath = progressPathForRun(config, { shardId, shardCount: count });
    const aggregate = readJsonSafe(newsPath, null);
    const progress = readJsonSafe(progressPath, null);
    const shardItems = Array.isArray(aggregate?.items) ? aggregate.items : [];
    items.push(...shardItems);
    coverageCount += Number.isFinite(aggregate?.coverage_count) ? aggregate.coverage_count : 0;
    shards.push({
      shard_id: shardId,
      news_path: newsPath,
      progress_path: progressPath,
      coverage_count: aggregate?.coverage_count ?? 0,
      items_count: shardItems.length,
      done_count: progress?.done_count ?? 0,
      failed_count: Array.isArray(progress?.failed) ? progress.failed.length : 0,
      aborted: Boolean(progress?.aborted),
      finished_at: progress?.finished_at || null,
    });
  }

  const seen = new Set();
  const deduped = [];
  for (const item of items.sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0))) {
    const key = `${item.ticker || ""}|${item.date || ""}|${item.title || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  const out = {
    generated_at: new Date().toISOString(),
    window_days: 30,
    shard_count: count,
    coverage_count: coverageCount,
    items_count: deduped.length,
    shards,
    items: deduped,
  };
  fs.mkdirSync(path.dirname(config.newsLatestPath), { recursive: true });
  const tmp = `${config.newsLatestPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, config.newsLatestPath);

  const progressOut = {
    generated_at: out.generated_at,
    market: config.market,
    shard_count: count,
    done_count: shards.reduce((sum, s) => sum + s.done_count, 0),
    failed_count: shards.reduce((sum, s) => sum + s.failed_count, 0),
    shards,
  };
  fs.mkdirSync(path.dirname(config.progressPath), { recursive: true });
  const progressTmp = `${config.progressPath}.tmp`;
  fs.writeFileSync(progressTmp, JSON.stringify(progressOut, null, 2));
  fs.renameSync(progressTmp, config.progressPath);

  console.log(`[news:${config.market}] merged ${count} shard aggregate(s): ${deduped.length} items → ${config.newsLatestPath}`);
  return out;
}

// ────────── Per-stock fetch + merge ──────────

export function mergeParsedNewsIntoDeep(config, ticker, news, recentCount) {
  const deepPath = path.join(config.deepDir, `${ticker}.json`);
  if (!fs.existsSync(deepPath)) return false;
  const existing = JSON.parse(fs.readFileSync(deepPath, "utf8"));
  existing.news = Array.isArray(news) ? news : [];
  if (existing.overview && typeof existing.overview === "object") {
    existing.overview.recent_news_count = recentCount ?? 0;
  }
  const tmp = `${deepPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
  fs.renameSync(tmp, deepPath);
  return true;
}

async function refreshOneStock(client, stock, config) {
  const api = await fetchStockData(client, {
    ticker: stock.ticker,
    canonicalUrl: stock.canonicalUrl,
  });
  // The parser already extracts `news` from whatever GraphQL ops are present.
  // Use the market wrapper so currency / NSE-calendar behavior stays aligned
  // with the market's normal full parse path.
  const parsed = config.parseApi(api);
  const news = Array.isArray(parsed.news) ? parsed.news : [];
  const recentCount = parsed.overview?.recent_news_count ?? 0;

  // Atomic read-mutate-write of the existing deep file. If the deep file
  // doesn't exist yet (rare — picks set should always have one), we skip
  // the merge and rely on the next full scrape to create the file.
  try {
    mergeParsedNewsIntoDeep(config, stock.ticker, news, recentCount);
  } catch (e) {
    console.warn(`[news:${config.market}] merge failed for ${stock.ticker}: ${e.message}`);
  }
  return { ticker: stock.ticker, name: stock.name, sector: stock.sector, news };
}

// ────────── Aggregate writer ──────────

function writeAggregate(perStock, config, args = {}) {
  const items = [];
  for (const r of perStock) {
    if (!r || !Array.isArray(r.news)) continue;
    for (const n of r.news) {
      items.push({
        ticker: r.ticker,
        name: r.name,
        sector: r.sector,
        type: n.type,
        date: n.date,
        title: n.title,
        body: n.body,
        keyDevTypeId: n.keyDevTypeId,
        source_url: n.source_url,
      });
    }
  }
  // Window: last 30 days, sorted DESC. Older items still live on the per-stock
  // deep JSON; the aggregate is a UI-friendly fast-path.
  const cutoff = Date.now() - 30 * 86400 * 1000;
  const windowed = items
    .filter((it) => {
      const t = Date.parse(it.date);
      return Number.isFinite(t) ? t >= cutoff : false;
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  const out = {
    generated_at: new Date().toISOString(),
    window_days: 30,
    coverage_count: perStock.length,
    items_count: windowed.length,
    items: windowed,
  };
  const outPath = newsLatestPathForRun(config, args);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, outPath);
  console.log(`[news:${config.market}] aggregate written: ${windowed.length} items across ${perStock.length} stocks → ${outPath}`);
}

function saveProgress(config, state, args = {}) {
  const outPath = progressPathForRun(config, args);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(state, null, 2));
}

// ────────── Main ──────────

export function parseArgs(argv) {
  const envShardCount = Number.parseInt(process.env.SWS_NEWS_SHARD_COUNT || process.env.SWS_NEWS_SHARDS || "1", 10);
  const out = {
    market: "in",
    limit: null,
    tickers: null,
    shardId: 1,
    shardCount: Number.isFinite(envShardCount) && envShardCount > 0 ? envShardCount : 1,
    mergeShards: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") {
      const v = parseInt(argv[++i], 10);
      if (Number.isFinite(v) && v > 0) out.limit = v;
    } else if (a === "--tickers") {
      out.tickers = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--market") {
      out.market = argv[++i] || "in";
    } else if (a.startsWith("--market=")) {
      out.market = a.slice("--market=".length) || "in";
    } else if (a === "--shard-id") {
      out.shardId = Number.parseInt(argv[++i], 10);
    } else if (a.startsWith("--shard-id=")) {
      out.shardId = Number.parseInt(a.slice("--shard-id=".length), 10);
    } else if (a === "--shard-count") {
      out.shardCount = Number.parseInt(argv[++i], 10);
    } else if (a.startsWith("--shard-count=")) {
      out.shardCount = Number.parseInt(a.slice("--shard-count=".length), 10);
    } else if (a === "--merge-shards") {
      out.mergeShards = true;
    }
  }
  normaliseShardArgs(out);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = makeNewsMarketConfig(args.market);
  const shardLabel = args.shardCount > 1 ? ` shard ${args.shardId}/${args.shardCount}` : "";

  if (args.mergeShards) {
    mergeShardAggregates(config, args.shardCount);
    return;
  }

  if (checkPanic(config)) {
    console.error(`[news:${config.market}] panic-stop.flag is set — refusing to run. Inspect ${config.panicFlag} and remove it manually after review.`);
    process.exit(3);
  }

  const allCoverage = buildCoverageList(args, config);
  const coverage = shardCoverageList(allCoverage, args);
  if (!coverage.length) {
    console.error(`[news:${config.market}] empty coverage list${shardLabel} — nothing to fetch`);
    process.exit(1);
  }
  console.log(`[news:${config.market}] target: ${coverage.length}/${allCoverage.length} stocks (${config.label}${shardLabel})`);
  fs.mkdirSync(path.dirname(newsLatestPathForRun(config, args)), { recursive: true });

  const startedAt = new Date().toISOString();
  saveProgress(config, {
    started_at: startedAt,
    market: config.market,
    shard_id: args.shardId,
    shard_count: args.shardCount,
    full_target_count: allCoverage.length,
    target_count: coverage.length,
    done_count: 0,
    failed: [],
    finished_at: null,
  }, args);

  console.log(`[news:${config.market}] launching browser${shardLabel}…`);
  const client = await createClient({ shardId: args.shardId, headless: true });

  const perStock = [];
  const failed = [];
  let aborted = false;

  try {
    for (let i = 0; i < coverage.length; i++) {
      const stock = coverage[i];
      if (checkPanic(config)) {
        console.error(`[news:${config.market}] panic-stop detected mid-run — aborting`);
        aborted = true;
        break;
      }
      const t0 = Date.now();
      try {
        const r = await refreshOneStock(client, stock, config);
        perStock.push(r);
        logEvent({
          ev: "news.stock.ok",
          market: config.market,
          shard_id: args.shardId,
          shard_count: args.shardCount,
          ticker: stock.ticker,
          news_count: r.news.length,
          ms: Date.now() - t0,
          progress: `${i + 1}/${coverage.length}`,
        });
      } catch (e) {
        failed.push({ ticker: stock.ticker, error: String(e), kind: e?.kind || null });
        logEvent({
          ev: "news.stock.err",
          market: config.market,
          shard_id: args.shardId,
          shard_count: args.shardCount,
          ticker: stock.ticker,
          error: String(e),
          kind: e?.kind || null,
          ms: Date.now() - t0,
        });
        // Hard-abort on auth/rate/block — these mean every subsequent call
        // will also fail and may push us deeper into rate-limit jail.
        if (e instanceof TransportError) {
          if (e.kind === "auth_expired" || e.kind === "rate_limited" || e.kind === "blocked") {
            console.error(`[news:${config.market}] aborting on transport ${e.kind}`);
            aborted = true;
            break;
          }
        }
      }
      // Persist progress every 10 stocks so a Ctrl-C leaves an inspectable trail.
      if ((i + 1) % 10 === 0) {
        saveProgress(config, {
          started_at: startedAt,
          market: config.market,
          shard_id: args.shardId,
          shard_count: args.shardCount,
          full_target_count: allCoverage.length,
          target_count: coverage.length,
          done_count: perStock.length,
          failed,
          finished_at: null,
        }, args);
      }
      // Inter-stock pacing
      if (i < coverage.length - 1) {
        await sleep(randInt(INTER_STOCK_MIN_MS, INTER_STOCK_MAX_MS));
      }
    }
  } finally {
    await client.close();
  }

  // Always write aggregate even on partial run — gives the dashboard
  // something to show.
  writeAggregate(perStock, config, args);
  saveProgress(config, {
    started_at: startedAt,
    market: config.market,
    shard_id: args.shardId,
    shard_count: args.shardCount,
    full_target_count: allCoverage.length,
    target_count: coverage.length,
    done_count: perStock.length,
    failed,
    aborted,
    finished_at: new Date().toISOString(),
  }, args);

  console.log(
    `[news:${config.market}] done${shardLabel}. ok=${perStock.length} failed=${failed.length} aborted=${aborted} ` +
    `aggregate_items=${(readJsonSafe(newsLatestPathForRun(config, args), { items: [] }).items || []).length}`,
  );

  if (aborted) process.exit(2);
  // Soft-fail policy: if every fetch failed, exit non-zero so nightly can log
  // a warning. Otherwise exit 0 even with partial failures.
  if (perStock.length === 0 && failed.length > 0) process.exit(4);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("[news] fatal:", e);
    process.exit(1);
  });
}
