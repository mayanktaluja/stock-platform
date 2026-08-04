#!/usr/bin/env node
/**
 * US SWS API scrape orchestrator — the US fork of sws-api-scrape.mjs.
 *
 * Walks data/sws-us/universe.json, calls the (shared) SWS API client per stock
 * with the US config, and persists to data/sws-us/deep-api/<TICKER>.json. Same
 * safety hooks as the India scraper: panic flag, pacing, burst pause, circadian
 * cap (enforced by the orchestrator), per-shard progress + fatal handlers so the
 * launcher's retry loop can resume.
 *
 * Differences from India: US paths/config, passes the US `cfg` to createClient
 * (own .sws-profile-us-* dirs), and NO Neon dual-write (US is file-only for v1).
 *
 * Usage:
 *   node scripts/sws-api-scrape-us.mjs <SHARD_ID:1|2|3>
 *   node scripts/sws-api-scrape-us.mjs <SHARD_ID> --limit 200      # seed batch
 *   node scripts/sws-api-scrape-us.mjs <SHARD_ID> --tickers AAPL,MSFT
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as usCfg from "./sws-config-us.mjs";
import { createClient, fetchStockData, TransportError } from "./sws-api-client.mjs";
import { shardSliceContiguous } from "./sws-shard-partition.mjs";

const { PATHS, SHARD_COUNT } = usCfg;
const UNIVERSE_PATH = PATHS.universe;
const OUT_DIR = PATHS.deepApiDir;
const PROGRESS_DIR = PATHS.dataDir;
const PANIC_FLAG = PATHS.panicStop;

// Pacing constants — same conservative values as India.
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

// Fatal-error net: log a grep-able JSON line with the shard id and exit(2) so
// the launcher (sws-refresh-us.sh) can tell a crash from a clean non-zero exit
// and resume from the last persisted next_local_index.
function installFatalHandlers() {
  const shardArg = parseInt(process.argv[2], 10);
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

// Alphabetical sort + contiguous split by shard — literally the same scheme as
// India, so it uses India's function rather than a third copy of it. The US
// shard count is passed explicitly because it comes from sws-config-us.mjs;
// the partition itself is region-agnostic.
const shardSlice = (universe, shardId, totalShards = SHARD_COUNT) =>
  shardSliceContiguous(universe, shardId, totalShards);

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
  const args = process.argv.slice(2);
  const shardId = parseInt(args[0], 10);
  if (!Number.isInteger(shardId) || shardId < 1 || shardId > SHARD_COUNT) {
    console.error(
      `usage: node scripts/sws-api-scrape-us.mjs <SHARD_ID:1..${SHARD_COUNT}> [--limit N] [--tickers A,B,C]`,
    );
    process.exit(2);
  }
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
  const tickersIdx = args.indexOf("--tickers");
  const explicitTickers =
    tickersIdx >= 0 ? args[tickersIdx + 1].split(",").map((s) => s.trim().toUpperCase()) : null;

  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (checkPanic()) {
    logEvent({ event: "halt", reason: "panic_flag_set_at_start" });
    process.exit(3);
  }

  const universe = loadUniverse();
  let slice;
  if (explicitTickers) {
    slice = universe.filter((s) => explicitTickers.includes((s.ticker || "").toUpperCase()));
  } else {
    slice = shardSlice(universe, shardId);
  }
  logEvent({ event: "start", region: "us", shard: shardId, slice_size: slice.length, limit });

  logEvent({ event: "client_start", shard: shardId });
  const client = await createClient({ shardId, headless: true, cfg: usCfg });
  logEvent({ event: "client_ready", shard: shardId });

  const progress = loadProgress(shardId);
  rollDailyCount(progress);

  let scrapedThisRun = 0;
  let exitCode = 0;
  const startIdx = explicitTickers ? 0 : progress.next_local_index || 0;

  try {
    for (let i = startIdx; i < slice.length && scrapedThisRun < limit; i++) {
      if (checkPanic()) {
        logEvent({ event: "halt", reason: "panic_mid_session", shard: shardId });
        break;
      }
      rollDailyCount(progress);

      const stock = slice[i];
      const ticker = stock.ticker;
      const canonicalUrl = (stock.sws_url || "").replace(/^https?:\/\/simplywall\.st/, "");
      if (!canonicalUrl) {
        logEvent({ event: "skip", shard: shardId, ticker, reason: "no_canonical_url" });
        progress.next_local_index = i + 1;
        saveProgress(shardId, progress);
        continue;
      }

      const t0 = Date.now();
      logEvent({ event: "stock_start", shard: shardId, ticker, idx: i });
      try {
        const data = await fetchStockData(client, { ticker, canonicalUrl });
        const outPath = path.join(OUT_DIR, `${ticker}.json`);
        fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
        const elapsed = Date.now() - t0;
        const score = data.graphql?.CompanySummary?.Company?.score || {};
        logEvent({
          event: "stock_done",
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
            logEvent({ event: "halt", reason: "auth_expired", shard: shardId });
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
          logEvent({ event: "halt", reason: "browser_closed", shard: shardId, ticker });
          exitCode = 6;
          break;
        }
        logEvent({ event: "stock_failed", shard: shardId, ticker, error: msg, kind: e?.kind });
      }

      progress.next_local_index = i + 1;
      saveProgress(shardId, progress);

      const interMs = randInt(INTER_STOCK_MIN_MS, INTER_STOCK_MAX_MS);
      await sleep(interMs);

      if (scrapedThisRun > 0 && scrapedThisRun % BURST_INTERVAL === 0) {
        const pauseMs = randInt(BURST_PAUSE_MIN_MS, BURST_PAUSE_MAX_MS);
        logEvent({ event: "burst_pause", shard: shardId, ms: pauseMs, after_count: scrapedThisRun });
        await sleep(pauseMs);
      }
    }
  } finally {
    logEvent({ event: "client_close", shard: shardId });
    await client.close();
    logEvent({ event: "session_end", shard: shardId, scraped: scrapedThisRun });
  }

  process.exit(exitCode);
}

main().catch((e) => {
  console.error("[scrape-us] fatal:", e);
  process.exit(1);
});
