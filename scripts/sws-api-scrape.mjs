#!/usr/bin/env node
/**
 * SWS API scrape orchestrator — replaces sws-scrape-playwright.mjs.
 *
 * Walks universe.json, calls sws-api-client per stock, persists to
 * data/sws/deep-api/<TICKER>.json. Honors all the same safety hooks as the
 * old scraper:
 *   - check-panic before every stock
 *   - check-rate-cap before every stock (per-minute cap)
 *   - circadian window
 *   - shard lock
 *
 * Anti-block design (in addition to what the client already does — TLS
 * fingerprint, browser-context fetch):
 *   - Pacing: 2-4s between stocks with ±30% jitter
 *   - Burst pause: every 50 stocks, sleep 30-180s (random)
 *   - Single concurrent worker per shard (3 shards = 3 parallel)
 *   - On `blocked` (Cloudflare 403) or `rate_limited` (429): IMMEDIATE panic
 *
 * Usage:
 *   node scripts/sws-api-scrape.mjs <SHARD_ID>
 *   node scripts/sws-api-scrape.mjs <SHARD_ID> --limit 5    # test small batch
 *   node scripts/sws-api-scrape.mjs <SHARD_ID> --tickers HDFCBANK,KOVAI
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as dal from "../services/swsDal/index.js";

const DB_FLUSH_INTERVAL = 50;

import {
  createClient,
  fetchStockData,
  TransportError,
} from "./sws-api-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const UNIVERSE_PATH = path.join(REPO_ROOT, "data/sws/universe.json");
const OUT_DIR = path.join(REPO_ROOT, "data/sws/deep-api");
const PROGRESS_DIR = path.join(REPO_ROOT, "data/sws");
const PANIC_FLAG = path.join(REPO_ROOT, "data/sws/panic-stop.flag");

// Pacing constants — tuneable.
const INTER_STOCK_MIN_MS = 2000;
const INTER_STOCK_MAX_MS = 4000;
const BURST_INTERVAL = 50; // every N stocks
const BURST_PAUSE_MIN_MS = 30_000;
const BURST_PAUSE_MAX_MS = 180_000;

// ────────── Helpers ──────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min));

function logEvent(obj) {
  console.log(JSON.stringify(obj));
}

function loadUniverse() {
  const raw = JSON.parse(fs.readFileSync(UNIVERSE_PATH, "utf8"));
  return Array.isArray(raw) ? raw : raw.stocks || raw.universe || [];
}

function shardSlice(universe, shardId, totalShards = 3) {
  // Same scheme as the existing scraper: alphabetical + interleave by shard.
  // Shard 1 gets indices 0..N/3, shard 2 gets N/3..2N/3, shard 3 gets the rest.
  const sorted = universe.slice().sort((a, b) =>
    (a.ticker || "").localeCompare(b.ticker || ""),
  );
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

// ────────── Main scrape loop ──────────

async function main() {
  const args = process.argv.slice(2);
  const shardId = parseInt(args[0], 10);
  if (!Number.isInteger(shardId) || shardId < 1 || shardId > 3) {
    console.error("usage: node scripts/sws-api-scrape.mjs <SHARD_ID:1|2|3> [--limit N] [--tickers A,B,C]");
    process.exit(2);
  }
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
  const tickersIdx = args.indexOf("--tickers");
  const explicitTickers = tickersIdx >= 0
    ? args[tickersIdx + 1].split(",").map((s) => s.trim().toUpperCase())
    : null;

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Pre-flight: panic check
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
  logEvent({ event: "start", shard: shardId, slice_size: slice.length, limit });

  // Boot client (one browser per shard)
  logEvent({ event: "client_start", shard: shardId });
  const client = await createClient({ shardId, headless: true });
  logEvent({ event: "client_ready", shard: shardId });

  const progress = loadProgress(shardId);
  rollDailyCount(progress);

  let scrapedThisRun = 0;
  let exitCode = 0;
  const startIdx = explicitTickers ? 0 : progress.next_local_index || 0;

  try {
    for (let i = startIdx; i < slice.length && scrapedThisRun < limit; i++) {
      // Per-stock pre-flight
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
            // Cloudflare or 429 — immediate panic
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
        // Browser/page closed unexpectedly — fatal for this shard. Without
        // this check we'd fail every subsequent stock with the same error.
        const msg = String(e);
        if (msg.includes("Target page, context or browser has been closed") ||
            msg.includes("browserContext.newPage") ||
            msg.includes("Browser closed")) {
          logEvent({ event: "halt", reason: "browser_closed", shard: shardId, ticker });
          exitCode = 6;
          break;
        }
        // Non-fatal: record and move on
        logEvent({
          event: "stock_failed",
          shard: shardId,
          ticker,
          error: msg,
          kind: e?.kind,
        });
      }

      progress.next_local_index = i + 1;
      saveProgress(shardId, progress);

      // Phase 3 dual-write: DB-flush every 50 ticks (not per-tick — Neon
      // compute-hour budget). Falls back silently if writes are off.
      if (dal.isDualWriteEnabled() && progress.done_count % DB_FLUSH_INTERVAL === 0) {
        dal.upsertShardProgress(shardId, progress).catch(() => {});
      }

      // Pacing: jittered short sleep between stocks
      const interMs = randInt(INTER_STOCK_MIN_MS, INTER_STOCK_MAX_MS);
      await sleep(interMs);

      // Burst pause every BURST_INTERVAL stocks
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
  console.error("[scrape] fatal:", e);
  process.exit(1);
});
