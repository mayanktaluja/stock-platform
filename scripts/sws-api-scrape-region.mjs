#!/usr/bin/env node
/**
 * Region SWS API scrape orchestrator — the generalization of sws-api-scrape-us.mjs.
 *
 * Walks data/sws-<code>/universe.json, calls the (shared) SWS API client per
 * stock with the region config, and persists to data/sws-<code>/deep-api/<KEY>.json
 * (KEY is the canonical dotted ticker, e.g. 005930.KS / 2330.TW). Same safety
 * hooks as India/US: panic flag, pacing, burst pause, per-shard progress + fatal
 * handlers so the launcher's retry loop can resume. File-only (no Neon dual-write).
 *
 * The fetch is driven entirely by the universe entry's sws_url, so the canonical
 * key (a-prefix KR / bare-numeric TW) is fully decoupled from the scraper.
 *
 * Usage:
 *   node scripts/sws-api-scrape-region.mjs --region kr --shard 1
 *   node scripts/sws-api-scrape-region.mjs --region kr --shard 1 --limit 200      # seed batch
 *   node scripts/sws-api-scrape-region.mjs --region tw --shard 2 --tickers 2330.TW,2454.TW
 */

import fs from "node:fs";
import path from "node:path";
import { makeRegionConfig } from "./sws-config-region.mjs";
import { createClient, fetchStockData, TransportError } from "./sws-api-client.mjs";

function argVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const ARGS = process.argv.slice(2);
const REGION_CODE = argVal(ARGS, "--region");
if (!REGION_CODE) {
  console.error("usage: --region <code> --shard <n> [--limit N] [--tickers A,B,C]");
  process.exit(2);
}
const cfg = makeRegionConfig(REGION_CODE);
const { PATHS, SHARD_COUNT } = cfg;
const UNIVERSE_PATH = PATHS.universe;
const OUT_DIR = PATHS.deepApiDir;
const PROGRESS_DIR = PATHS.dataDir;
const PANIC_FLAG = PATHS.panicStop;

// Pacing constants — same conservative values as India/US.
const INTER_STOCK_MIN_MS = 2000;
const INTER_STOCK_MAX_MS = 4000;
const BURST_INTERVAL = 50;
const BURST_PAUSE_MIN_MS = 30_000;
const BURST_PAUSE_MAX_MS = 180_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min));

function logEvent(obj) {
  console.log(JSON.stringify(obj));
}

function installFatalHandlers() {
  const shardArg = parseInt(argVal(ARGS, "--shard"), 10);
  const shardId = Number.isFinite(shardArg) ? shardArg : null;
  let firing = false;
  const finish = (kind, err) => {
    if (firing) return;
    firing = true;
    try {
      console.error(
        JSON.stringify({
          event: "shard_fatal",
          kind,
          region: REGION_CODE,
          shard: shardId,
          message: err?.message ?? String(err),
          code: err?.code ?? null,
          stack: err?.stack ?? null,
          at: new Date().toISOString(),
        }),
      );
    } catch {
      /* logging itself must never throw */
    }
    process.exit(2);
  };
  process.on("unhandledRejection", (err) => finish("unhandledRejection", err));
  process.on("uncaughtException", (err) => finish("uncaughtException", err));
}
installFatalHandlers();

function loadUniverse() {
  const raw = JSON.parse(fs.readFileSync(UNIVERSE_PATH, "utf8"));
  return Array.isArray(raw) ? raw : raw.stocks || raw.universe || [];
}

function shardSlice(universe, shardId, totalShards = SHARD_COUNT) {
  const sorted = universe.slice().sort((a, b) => (a.ticker || "").localeCompare(b.ticker || ""));
  const total = sorted.length;
  const sliceSize = Math.floor(total / totalShards);
  const startIdx = (shardId - 1) * sliceSize;
  const endIdx = shardId === totalShards ? total : startIdx + sliceSize;
  return sorted.slice(startIdx, endIdx);
}

function checkPanic() {
  return fs.existsSync(PANIC_FLAG);
}

function recordPanic(reason, shardId, evidence) {
  const info = {
    reason,
    shard_id: shardId,
    evidence: typeof evidence === "string" ? evidence : JSON.stringify(evidence),
    detected_at: new Date().toISOString(),
  };
  fs.writeFileSync(PANIC_FLAG, JSON.stringify(info, null, 2));
}

function loadProgress(shardId) {
  const p = path.join(PROGRESS_DIR, `progress-api-${shardId}.json`);
  if (!fs.existsSync(p)) {
    return {
      shard_id: shardId,
      region: REGION_CODE,
      next_local_index: 0,
      done_count: 0,
      today_count: 0,
      today_date: new Date().toISOString().slice(0, 10),
      started_at: new Date().toISOString(),
    };
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveProgress(shardId, progress) {
  const p = path.join(PROGRESS_DIR, `progress-api-${shardId}.json`);
  fs.writeFileSync(p, JSON.stringify(progress, null, 2));
}

function rollDailyCount(progress) {
  const today = new Date().toISOString().slice(0, 10);
  if (progress.today_date !== today) {
    progress.today_date = today;
    progress.today_count = 0;
  }
}

async function main() {
  const shardId = parseInt(argVal(ARGS, "--shard"), 10);
  if (!Number.isInteger(shardId) || shardId < 1 || shardId > SHARD_COUNT) {
    console.error(`usage: --region ${REGION_CODE} --shard <1..${SHARD_COUNT}> [--limit N] [--tickers A,B,C]`);
    process.exit(2);
  }
  const limitRaw = argVal(ARGS, "--limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : Infinity;
  const tickersRaw = argVal(ARGS, "--tickers");
  const explicitTickers = tickersRaw ? tickersRaw.split(",").map((s) => s.trim().toUpperCase()) : null;

  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (checkPanic()) {
    logEvent({ event: "halt", reason: "panic_flag_set_at_start", region: REGION_CODE });
    process.exit(3);
  }

  const universe = loadUniverse();
  let slice;
  if (explicitTickers) {
    slice = universe.filter((s) => explicitTickers.includes((s.ticker || "").toUpperCase()));
  } else {
    slice = shardSlice(universe, shardId);
  }
  logEvent({ event: "start", region: REGION_CODE, shard: shardId, slice_size: slice.length, limit });

  logEvent({ event: "client_start", region: REGION_CODE, shard: shardId });
  const client = await createClient({ shardId, headless: true, cfg });
  logEvent({ event: "client_ready", region: REGION_CODE, shard: shardId });

  const progress = loadProgress(shardId);
  rollDailyCount(progress);

  let scrapedThisRun = 0;
  let exitCode = 0;
  const startIdx = explicitTickers ? 0 : progress.next_local_index || 0;

  try {
    for (let i = startIdx; i < slice.length && scrapedThisRun < limit; i++) {
      if (checkPanic()) {
        logEvent({ event: "halt", reason: "panic_mid_session", region: REGION_CODE, shard: shardId });
        break;
      }
      rollDailyCount(progress);

      const stock = slice[i];
      const ticker = stock.ticker;
      const canonicalUrl = (stock.sws_url || "").replace(/^https?:\/\/simplywall\.st/, "");
      if (!canonicalUrl) {
        logEvent({ event: "skip", region: REGION_CODE, shard: shardId, ticker, reason: "no_canonical_url" });
        progress.next_local_index = i + 1;
        saveProgress(shardId, progress);
        continue;
      }

      const t0 = Date.now();
      logEvent({ event: "stock_start", region: REGION_CODE, shard: shardId, ticker, idx: i });
      try {
        const data = await fetchStockData(client, { ticker, canonicalUrl });
        const outPath = path.join(OUT_DIR, `${ticker}.json`);
        fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
        const elapsed = Date.now() - t0;
        const score = data.graphql?.CompanySummary?.Company?.score || {};
        logEvent({
          event: "stock_done",
          region: REGION_CODE,
          shard: shardId,
          ticker,
          elapsed_ms: elapsed,
          errors: data.errors.length,
          score: { v: score.value, f: score.future, p: score.past, h: score.health, d: score.dividend },
        });
        progress.done_count = (progress.done_count || 0) + 1;
        progress.today_count = (progress.today_count || 0) + 1;
        progress.last_ticker = ticker;
        progress.last_run_at = new Date().toISOString();
        progress.last_duration_ms = elapsed;
        scrapedThisRun++;
      } catch (e) {
        if (e instanceof TransportError) {
          if (e.kind === "blocked" || e.kind === "rate_limited") {
            logEvent({
              event: "panic_recorded",
              region: REGION_CODE,
              shard: shardId,
              ticker,
              reason: e.kind,
              status: e.status,
              body: (typeof e.body === "string" ? e.body : JSON.stringify(e.body || {})).slice(0, 200),
            });
            recordPanic(`api:${e.kind}`, shardId, `status=${e.status}`);
            exitCode = 4;
            break;
          }
          if (e.kind === "auth_expired") {
            logEvent({ event: "halt", reason: "auth_expired", region: REGION_CODE, shard: shardId });
            exitCode = 5;
            break;
          }
        }
        const msg = String(e);
        if (
          msg.includes("Target page, context or browser has been closed") ||
          msg.includes("browserContext.newPage") ||
          msg.includes("Browser closed")
        ) {
          logEvent({ event: "halt", reason: "browser_closed", region: REGION_CODE, shard: shardId, ticker });
          exitCode = 6;
          break;
        }
        logEvent({ event: "stock_failed", region: REGION_CODE, shard: shardId, ticker, error: msg, kind: e?.kind });
      }

      progress.next_local_index = i + 1;
      saveProgress(shardId, progress);

      const interMs = randInt(INTER_STOCK_MIN_MS, INTER_STOCK_MAX_MS);
      await sleep(interMs);

      if (scrapedThisRun > 0 && scrapedThisRun % BURST_INTERVAL === 0) {
        const pauseMs = randInt(BURST_PAUSE_MIN_MS, BURST_PAUSE_MAX_MS);
        logEvent({ event: "burst_pause", region: REGION_CODE, shard: shardId, ms: pauseMs, after_count: scrapedThisRun });
        await sleep(pauseMs);
      }
    }
  } finally {
    logEvent({ event: "client_close", region: REGION_CODE, shard: shardId });
    await client.close();
    logEvent({ event: "session_end", region: REGION_CODE, shard: shardId, scraped: scrapedThisRun });
  }

  process.exit(exitCode);
}

main().catch((e) => {
  console.error(`[scrape-${REGION_CODE}] fatal:`, e);
  process.exit(1);
});
