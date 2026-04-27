// Per-shard Playwright driver for the SWS deep-scrape pipeline.
//
// CLI:
//   node scripts/sws-scrape-playwright.mjs <shardId> [--mode quick|full] [--max N] [--dry-run]
//
// Behaviour:
//   1. Acquires the shard lock (existing PATHS.shardLock(N)).
//   2. Awaits a concurrency token (Tier 0 cap; max 2 of 3 active).
//   3. Picks a session-stock-count from HUMANISATION.sessionStockCountRange.
//   4. For each stock until limit / completion / panic:
//      - Pre-flight panic + rate-cap check (fail-closed).
//      - Navigate overview, parse, walk sub-tabs in shuffled order, optionally
//        revisit one tab, humanise between actions.
//      - Detect panic signals on every page (URL + body text). On match:
//        record panic, release locks, exit with code 2.
//      - Atomically save per-stock JSON via existing saveStockJson() and
//        advance progress via existing advanceProgress().
//      - Inter-stock cooldown (jittered).
//   5. Closing ritual + clean exit.
//
// Output JSON shape is identical to the legacy Chrome-MCP driver because both
// paths feed the same parseStock() in sws-parse-capture.mjs.

import fs from "node:fs";
import path from "node:path";
import {
  PATHS, SUB_TABS, TIMING, HUMANISATION,
} from "./sws-config.mjs";
import {
  loadShardState, advanceProgress, acquireShardLock, releaseShardLock,
  checkPanicStop, recordPanicStop, detectPanicSignalsInText,
  saveStockJson, recordFailedStock, checkRateCap,
} from "./sws-deep-scrape.mjs";
import {
  jitteredSleep, sleep, shuffleTabs, maybePickRevisitTab, humaniseTab,
  performClosingRitual, pickSessionStockCount, withinCircadianWindow,
  isWeeklyRestDay, awaitConcurrencyToken, releaseConcurrencyToken,
} from "./sws-anti-detect.mjs";
import { parseStock } from "./sws-parse-capture.mjs";
import { launchShardContext } from "./sws-stealth-context.mjs";

// ---------- CLI parsing ----------

function parseArgs(argv) {
  const args = { shardId: null, mode: "full", max: null, dryRun: false, ignoreWindow: false };
  args.shardId = Number(argv[0]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--ignore-window") args.ignoreWindow = true;
    else if (a === "--max") args.max = Number(argv[++i]);
    else if (a === "--mode") args.mode = argv[++i];
  }
  if (!Number.isInteger(args.shardId) || args.shardId < 1 || args.shardId > 3) {
    throw new Error(`Bad shardId: pass 1, 2, or 3`);
  }
  if (!["quick", "full", "earnings"].includes(args.mode)) {
    throw new Error(`Bad mode: ${args.mode} — expected quick|full|earnings`);
  }
  return args;
}

// ---------- URL helpers ----------

function tabUrl(stockUrl, tab) {
  // Overview is the bare sws_url; sub-tabs append slug.
  if (tab === "overview") return stockUrl;
  return stockUrl.replace(/\/$/, "") + "/" + tab;
}

// ---------- Page text + safety check ----------

async function getPageInnerText(page) {
  // SWS parsers were authored against innerText (Chrome MCP get_page_text),
  // not full HTML. Match that contract.
  try {
    return await page.evaluate(() => document.body && document.body.innerText || "");
  } catch {
    return "";
  }
}

async function safeNavigate(page, url, { waitMs = 8000 } = {}) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    return { ok: false, err: String(e), text: "" };
  }
  await sleep(waitMs);
  const text = await getPageInnerText(page);
  return { ok: true, text };
}

// ---------- Snowflake via GraphQL (CompanySummary query) ----------
//
// SWS renders snowflake scores as an SVG radar chart with no text labels in
// the DOM. The values DO live in their GraphQL CompanySummary response, so
// we fetch them directly with the page's auth context.

const COMPANY_SUMMARY_GQL = `query CompanySummary($canonicalUrl: String!) {
  Company(canonicalURL: $canonicalUrl) {
    id
    score { dividend future health past value }
  }
}`;

function canonicalUrlFromSwsUrl(swsUrl) {
  try {
    return new URL(swsUrl).pathname.replace(/\/$/, "");
  } catch { return null; }
}

async function fetchSnowflakeFromApi(page, swsUrl) {
  const canonicalUrl = canonicalUrlFromSwsUrl(swsUrl);
  if (!canonicalUrl) return null;
  // Fire the GraphQL fetch from inside the browser context (page.evaluate)
  // so it uses the real Chrome TLS/headers/cookie path. ctx.request.post()
  // gets blocked by Cloudflare (different fingerprint).
  try {
    const score = await page.evaluate(async ({ query, vars }) => {
      const resp = await fetch("https://simplywall.st/graphql", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
        },
        body: JSON.stringify({ operationName: "CompanySummary", query, variables: vars }),
      });
      if (!resp.ok) return { _err: "http_" + resp.status };
      const j = await resp.json();
      return j?.data?.Company?.score ?? { _err: "no_score" };
    }, { query: COMPANY_SUMMARY_GQL, vars: { canonicalUrl } });
    if (!score || score._err || typeof score !== "object") return null;
    return {
      valuation: score.value ?? null,
      future_growth: score.future ?? null,
      past_performance: score.past ?? null,
      financial_health: score.health ?? null,
      dividends: score.dividend ?? null,
    };
  } catch {
    return null;
  }
}

// ---------- Per-stock scrape ----------

async function scrapeOneStock(page, stock, mode) {
  const captures = {};
  const ticker = stock.ticker;
  const ctx = page.context();

  // 1. Overview (always).
  const overviewWait = (HUMANISATION.sleepDistribution === "gaussian"
    ? gaussianMidWait("overviewWaitMs") : TIMING.overviewWaitMs.max);
  const overview = await safeNavigate(page, tabUrl(stock.sws_url, "overview"), {
    waitMs: overviewWait,
  });
  if (!overview.ok) {
    return { ok: false, reason: "overview_navigation_failed", error: overview.err };
  }
  const panic = detectPanicSignalsInText(overview.text, page.url());
  if (panic.panic) return { ok: false, reason: "panic", evidence: panic.evidence, tab: "overview" };
  captures.overview = overview.text;

  // 1b. Snowflake scores (from GraphQL — not in the DOM). Fire from inside
  // the page context so the fetch goes through the real browser (Cloudflare
  // blocks ctx.request.post). Failure here is non-fatal.
  const apiSnowflake = await fetchSnowflakeFromApi(page, stock.sws_url);
  if (apiSnowflake) captures._api_snowflake = apiSnowflake;

  if (mode === "quick" || mode === "earnings") {
    // Overview-only modes: skip sub-tabs.
    return { ok: true, captures };
  }

  // 2. Sub-tabs (shuffled), with optional revisit.
  const order = shuffleTabs(SUB_TABS);
  for (const tab of order) {
    await jitteredSleep("subTabWaitMs");
    await humaniseTab(page);
    const r = await safeNavigate(page, tabUrl(stock.sws_url, tab), {
      waitMs: pickJitter("subTabWaitMs"),
    });
    if (!r.ok) {
      // A single failed sub-tab is recoverable — record and skip.
      recordFailedStock(ticker, tab, "navigation_failed: " + r.err);
      captures[tab] = "";
      continue;
    }
    const sigs = detectPanicSignalsInText(r.text, page.url());
    if (sigs.panic) return { ok: false, reason: "panic", evidence: sigs.evidence, tab };
    captures[tab] = r.text;
  }

  // 3. Optional revisit (humanisation).
  const revisit = maybePickRevisitTab(order);
  if (revisit) {
    await jitteredSleep("subTabWaitMs");
    await safeNavigate(page, tabUrl(stock.sws_url, revisit), { waitMs: 2000 });
    // Don't overwrite captures[revisit] — the existing capture is the canonical one.
  }

  return { ok: true, captures };
}

// Tiny helper — pick a sleep ms from a TIMING range (gaussian or uniform).
function pickJitter(key) {
  if (HUMANISATION.sleepDistribution === "gaussian") return gaussianMidWait(key);
  const r = TIMING[key];
  return Math.floor(Math.random() * (r.max - r.min + 1)) + r.min;
}

function gaussianMidWait(key) {
  const r = TIMING[key];
  const mean = (r.min + r.max) / 2;
  const sigma = (r.max - r.min) / 4;
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(r.min, Math.min(r.max, Math.round(mean + sigma * z)));
}

// ---------- Pipeline status writer (consumed by Picks tab in Phase 2) ----------

function writePipelineStatus(shardId, payload) {
  try {
    const cur = fs.existsSync(PATHS.pipelineStatus)
      ? JSON.parse(fs.readFileSync(PATHS.pipelineStatus, "utf-8")) : { shards: {} };
    cur.shards = cur.shards || {};
    cur.shards[shardId] = { ...(cur.shards[shardId] || {}), ...payload, updated_at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(PATHS.pipelineStatus), { recursive: true });
    const tmp = PATHS.pipelineStatus + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
    fs.renameSync(tmp, PATHS.pipelineStatus);
  } catch {}
}

// ---------- Main shard loop ----------

async function runShard(args) {
  const { shardId, mode, max, dryRun, ignoreWindow } = args;

  // 0. Circadian + weekly-rest gates.
  if (!ignoreWindow && !withinCircadianWindow()) {
    console.log(JSON.stringify({ event: "skip", reason: "outside_circadian_window", shard: shardId }));
    return 0;
  }
  if (isWeeklyRestDay(shardId)) {
    console.log(JSON.stringify({ event: "skip", reason: "weekly_rest_day", shard: shardId }));
    return 0;
  }

  // 1. Panic check.
  const panic = checkPanicStop();
  if (panic.halted) {
    console.log(JSON.stringify({ event: "skip", reason: "panic_flag_set", info: panic.info }));
    return 0;
  }

  // 2. Shard lock.
  const lock = acquireShardLock(shardId);
  if (!lock.acquired) {
    console.log(JSON.stringify({ event: "skip", reason: "shard_lock_held", current: lock.current }));
    return 0;
  }

  // 3. Concurrency token (Tier 0).
  console.log(JSON.stringify({ event: "awaiting_concurrency_token", shard: shardId }));
  await awaitConcurrencyToken(shardId);

  let exitCode = 0;
  try {
    const sessionLimit = max != null ? max : pickSessionStockCount();
    const state = loadShardState(shardId);
    if (state.is_complete) {
      console.log(JSON.stringify({ event: "shard_complete", shard: shardId }));
      writePipelineStatus(shardId, { complete: true, mode });
      return 0;
    }

    if (dryRun) {
      console.log(JSON.stringify({
        event: "dry_run",
        shard: shardId,
        mode,
        next_stock: state.next_stock,
        session_limit: sessionLimit,
      }));
      return 0;
    }

    // Lazy-launch browser only after all gates pass.
    const ctx = await launchShardContext(shardId);
    const page = ctx.pages()[0] || await ctx.newPage();

    let scraped = 0;
    let cur = loadShardState(shardId);
    while (!cur.is_complete && scraped < sessionLimit) {
      // Per-stock pre-flight.
      const p = checkPanicStop();
      if (p.halted) {
        console.log(JSON.stringify({ event: "halt", reason: "panic_mid_session", info: p.info }));
        break;
      }
      const cap = checkRateCap(shardId);
      if (!cap.ok) {
        const waitMs = cap.wait_ms || 60000;
        console.log(JSON.stringify({ event: "rate_cap_wait", reason: cap.reason, wait_ms: waitMs }));
        await sleep(waitMs);
        continue;
      }

      const stock = cur.next_stock;
      if (!stock) break;
      const startedAt = Date.now();
      console.log(JSON.stringify({ event: "stock_start", shard: shardId, ticker: stock.ticker, idx: cur.next_local_index }));
      writePipelineStatus(shardId, {
        in_progress_ticker: stock.ticker,
        next_local_index: cur.next_local_index,
        slice_size: cur.slice_size,
        mode,
      });

      const result = await scrapeOneStock(page, stock, mode);

      if (!result.ok) {
        if (result.reason === "panic") {
          recordPanicStop(`panic:${result.tab}`, shardId, result.evidence.join(","));
          console.log(JSON.stringify({
            event: "panic_recorded", shard: shardId, ticker: stock.ticker,
            tab: result.tab, evidence: result.evidence,
          }));
          exitCode = 2;
          break;
        }
        recordFailedStock(stock.ticker, result.tab || "overview", result.reason || result.error || "unknown");
        // Advance past it so we don't loop.
        advanceProgress(shardId, stock.ticker, Date.now() - startedAt);
        cur = loadShardState(shardId);
        scraped++;
        continue;
      }

      // Parse + save.
      let parsed;
      try {
        parsed = parseStock(result.captures, stock.ticker);
      } catch (e) {
        recordFailedStock(stock.ticker, "parse", String(e));
        advanceProgress(shardId, stock.ticker, Date.now() - startedAt);
        cur = loadShardState(shardId);
        scraped++;
        continue;
      }
      // Merge GraphQL snowflake (more authoritative than text-extracted, since
      // SWS renders snowflake as SVG without text labels). Compute the total
      // from the integer dimensions.
      if (result.captures._api_snowflake) {
        parsed.overview.snowflake = result.captures._api_snowflake;
        parsed.overview.snowflake_total = Object.values(result.captures._api_snowflake)
          .reduce((a, v) => (typeof v === "number" ? a + v : a), 0);
        parsed.overview.snowflake_source = "graphql";
      }
      saveStockJson(stock.ticker, parsed);
      const dur = Date.now() - startedAt;
      advanceProgress(shardId, stock.ticker, dur);
      console.log(JSON.stringify({ event: "stock_done", shard: shardId, ticker: stock.ticker, duration_ms: dur }));

      cur = loadShardState(shardId);
      scraped++;
      if (scraped >= sessionLimit || cur.is_complete) break;
      await jitteredSleep("interStockCooldownMs");
    }

    // Closing ritual.
    try { await performClosingRitual(page); } catch {}
    try { await ctx.close(); } catch {}

    writePipelineStatus(shardId, {
      complete: cur.is_complete,
      mode,
      done_count: cur.progress.done_count,
    });
    console.log(JSON.stringify({
      event: "session_end", shard: shardId, scraped, complete: cur.is_complete,
    }));
  } finally {
    releaseConcurrencyToken(shardId);
    releaseShardLock(shardId);
  }
  return exitCode;
}

// ---------- Entry ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const code = await runShard(args);
  process.exit(code || 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
