#!/usr/bin/env node
/**
 * SWS news refresh — targeted scrape of picks + portfolio + watchlist.
 *
 * Coverage scope is intentionally narrow (~300 stocks vs the full 5,517-stock
 * universe scrape) because per-stock news activity falls off a cliff outside
 * the user's actual buy-list. Runs in ~3 min wall-clock with sequential pacing.
 *
 * Pipeline:
 *   1. Build coverage union: picks-latest.json sections ∪ portfolio holdings
 *      ∪ watchlist symbols, intersected against universe.json.
 *   2. For each ticker, fetch CompanySummary (companyId) + getCompanyUpdates
 *      via the existing API client. ~600ms × 300 ≈ 3 min.
 *   3. Parse each response with the existing parseStock() pipeline.
 *   4. For each stock, merge `news` + `overview.recent_news_count` into the
 *      existing data/sws/deep/<TICKER>.json file (atomic read-mutate-write).
 *      The dashboard endpoint /api/sws-stock/:ticker already serves this file,
 *      so the new news field flows to the modal automatically.
 *   5. Write data/sws/news-latest.json — cross-portfolio aggregate sorted
 *      DESC by date, used by the daily PDF and any future "what's new" UI.
 *
 * Safety hooks (reuses existing infra):
 *   - panic-stop.flag: aborts if set (never auto-creates one — failures are
 *     non-fatal since news is enrichment, not core pipeline).
 *   - auth_expired / rate_limited / blocked errors propagate from the client
 *     and abort the run early to avoid burning rate-limit budget.
 *
 * Usage:
 *   node scripts/sws-news-scrape.mjs                    # full coverage set
 *   node scripts/sws-news-scrape.mjs --limit 5          # test small batch
 *   node scripts/sws-news-scrape.mjs --tickers RELIANCE,TCS,HDFCBANK
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, fetchStockData, TransportError } from "./sws-api-client.mjs";
import { parseStock } from "./sws-api-parser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SWS_REPO_ROOT_OVERRIDE || path.resolve(__dirname, "..");

const UNIVERSE_PATH = path.join(REPO_ROOT, "data/sws/universe.json");
const PICKS_PATH = path.join(REPO_ROOT, "data/sws/picks-latest.json");
const DEEP_DIR = path.join(REPO_ROOT, "data/sws/deep");
const PROGRESS_PATH = path.join(REPO_ROOT, "data/sws/news-progress.json");
const NEWS_LATEST_PATH = path.join(REPO_ROOT, "data/sws/news-latest.json");
const PANIC_FLAG = path.join(REPO_ROOT, "data/sws/panic-stop.flag");
const PORTFOLIOS_PATH = path.join(REPO_ROOT, "portfolios.json");
const WATCHLIST_PATH = path.join(REPO_ROOT, ".watchlist.json");

// Pacing — half the deep-scrape pace since runtime is tiny.
const INTER_STOCK_MIN_MS = 1000;
const INTER_STOCK_MAX_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min));

function logEvent(obj) {
  console.log(JSON.stringify(obj));
}

function checkPanic() {
  return fs.existsSync(PANIC_FLAG);
}

function readJsonSafe(p, fallback) {
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

function tickersFromPicks() {
  const picks = readJsonSafe(PICKS_PATH, null);
  if (!picks || !picks.sections) {
    console.warn(`[news] picks-latest.json missing or empty — skipping picks set`);
    return new Set();
  }
  const out = new Set();
  for (const key of COVERAGE_SECTIONS) {
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

function loadUniverse() {
  const raw = readJsonSafe(UNIVERSE_PATH, null);
  if (!raw) {
    throw new Error(`universe.json not found at ${UNIVERSE_PATH}`);
  }
  return Array.isArray(raw) ? raw : raw.stocks || raw.universe || [];
}

function buildCoverageList(opts = {}) {
  // Returns: [{ ticker, canonicalUrl, name, sector }]
  const universe = loadUniverse();
  const indexByTicker = new Map();
  for (const u of universe) {
    if (u?.ticker) indexByTicker.set(String(u.ticker).toUpperCase(), u);
  }

  let union;
  if (opts.tickers) {
    union = new Set(opts.tickers.map((t) => String(t).toUpperCase()));
  } else {
    const picksSet = tickersFromPicks();
    const watchSet = tickersFromWatchlist();
    const portSet = tickersFromPortfolio();
    union = new Set([...picksSet, ...watchSet, ...portSet]);
    console.log(
      `[news] coverage union: picks=${picksSet.size} watchlist=${watchSet.size} ` +
      `portfolio=${portSet.size} union=${union.size}`,
    );
  }

  const list = [];
  const missing = [];
  for (const t of union) {
    const stock = indexByTicker.get(t);
    if (!stock) {
      missing.push(t);
      continue;
    }
    const canonicalUrl = (stock.sws_url || "").replace(/^https?:\/\/simplywall\.st/, "");
    if (!canonicalUrl) continue;
    list.push({
      ticker: t,
      canonicalUrl,
      name: stock.name || null,
      sector: stock.sector || null,
    });
  }
  if (missing.length) {
    console.log(`[news] ${missing.length} ticker(s) not in universe (skipped): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`);
  }
  // Stable order so progress + retries are deterministic.
  list.sort((a, b) => a.ticker.localeCompare(b.ticker));
  if (opts.limit) return list.slice(0, opts.limit);
  return list;
}

// ────────── Per-stock fetch + merge ──────────

async function refreshOneStock(client, stock) {
  const api = await fetchStockData(client, {
    ticker: stock.ticker,
    canonicalUrl: stock.canonicalUrl,
  });
  // The parser already extracts `news` from whatever GraphQL ops are present.
  // We pass through full parseStock() so news + recent_news_count + the parser's
  // best-effort enrichment all land cleanly. Sector map / NSE calendar are
  // optional; news doesn't depend on them.
  const parsed = parseStock(api);
  const news = Array.isArray(parsed.news) ? parsed.news : [];
  const recentCount = parsed.overview?.recent_news_count ?? 0;

  // Atomic read-mutate-write of the existing deep file. If the deep file
  // doesn't exist yet (rare — picks set should always have one), we skip
  // the merge and rely on the next full scrape to create the file.
  const deepPath = path.join(DEEP_DIR, `${stock.ticker}.json`);
  if (fs.existsSync(deepPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(deepPath, "utf8"));
      existing.news = news;
      if (existing.overview && typeof existing.overview === "object") {
        existing.overview.recent_news_count = recentCount;
      }
      // Atomic write via tmp + rename so a partial write can never corrupt.
      const tmp = `${deepPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
      fs.renameSync(tmp, deepPath);
    } catch (e) {
      console.warn(`[news] merge failed for ${stock.ticker}: ${e.message}`);
    }
  }
  return { ticker: stock.ticker, name: stock.name, sector: stock.sector, news };
}

// ────────── Aggregate writer ──────────

function writeAggregate(perStock) {
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
  const tmp = `${NEWS_LATEST_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, NEWS_LATEST_PATH);
  console.log(`[news] aggregate written: ${windowed.length} items across ${perStock.length} stocks → ${NEWS_LATEST_PATH}`);
}

function saveProgress(state) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(state, null, 2));
}

// ────────── Main ──────────

function parseArgs(argv) {
  const out = { limit: null, tickers: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") {
      const v = parseInt(argv[++i], 10);
      if (Number.isFinite(v) && v > 0) out.limit = v;
    } else if (a === "--tickers") {
      out.tickers = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

async function main() {
  if (checkPanic()) {
    console.error(`[news] panic-stop.flag is set — refusing to run. Inspect ${PANIC_FLAG} and remove it manually after review.`);
    process.exit(3);
  }

  const args = parseArgs(process.argv.slice(2));
  const coverage = buildCoverageList(args);
  if (!coverage.length) {
    console.error(`[news] empty coverage list — nothing to fetch`);
    process.exit(1);
  }
  console.log(`[news] target: ${coverage.length} stocks`);
  fs.mkdirSync(path.dirname(NEWS_LATEST_PATH), { recursive: true });

  const startedAt = new Date().toISOString();
  saveProgress({
    started_at: startedAt,
    target_count: coverage.length,
    done_count: 0,
    failed: [],
    finished_at: null,
  });

  console.log(`[news] launching browser…`);
  const client = await createClient({ shardId: 1, headless: true });

  const perStock = [];
  const failed = [];
  let aborted = false;

  try {
    for (let i = 0; i < coverage.length; i++) {
      const stock = coverage[i];
      if (checkPanic()) {
        console.error(`[news] panic-stop detected mid-run — aborting`);
        aborted = true;
        break;
      }
      const t0 = Date.now();
      try {
        const r = await refreshOneStock(client, stock);
        perStock.push(r);
        logEvent({
          ev: "news.stock.ok",
          ticker: stock.ticker,
          news_count: r.news.length,
          ms: Date.now() - t0,
          progress: `${i + 1}/${coverage.length}`,
        });
      } catch (e) {
        failed.push({ ticker: stock.ticker, error: String(e), kind: e?.kind || null });
        logEvent({
          ev: "news.stock.err",
          ticker: stock.ticker,
          error: String(e),
          kind: e?.kind || null,
          ms: Date.now() - t0,
        });
        // Hard-abort on auth/rate/block — these mean every subsequent call
        // will also fail and may push us deeper into rate-limit jail.
        if (e instanceof TransportError) {
          if (e.kind === "auth_expired" || e.kind === "rate_limited" || e.kind === "blocked") {
            console.error(`[news] aborting on transport ${e.kind}`);
            aborted = true;
            break;
          }
        }
      }
      // Persist progress every 10 stocks so a Ctrl-C leaves an inspectable trail.
      if ((i + 1) % 10 === 0) {
        saveProgress({
          started_at: startedAt,
          target_count: coverage.length,
          done_count: perStock.length,
          failed,
          finished_at: null,
        });
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
  writeAggregate(perStock);
  saveProgress({
    started_at: startedAt,
    target_count: coverage.length,
    done_count: perStock.length,
    failed,
    aborted,
    finished_at: new Date().toISOString(),
  });

  console.log(
    `[news] done. ok=${perStock.length} failed=${failed.length} aborted=${aborted} ` +
    `aggregate_items=${(readJsonSafe(NEWS_LATEST_PATH, { items: [] }).items || []).length}`,
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
