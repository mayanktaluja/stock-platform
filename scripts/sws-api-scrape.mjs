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
 *   - On `blocked` (Cloudflare 403) or `rate_limited` (429): IMMEDIATE panic,
 *     unless SWS_PANIC_LADDER=1 — then a challenge/429 first goes through the
 *     retry ladder + cross-shard quorum in sws-panic-ladder.mjs, and only a
 *     confirmed, corroborated block (or a hard block) writes the global flag.
 *
 * Exit codes: 0 done / halted by a peer's flag, 1 fatal, 2 crash (retried by
 * sws-refresh-api.sh), 3 flag set at start, 4 this shard wrote the flag,
 * 5 auth expired, 6 browser closed, 7 ladder exhausted without quorum — this
 * shard halts alone, the run continues (retried with a fresh browser).
 *
 * Test hook (no Chrome, no network): SWS_INJECT_BLOCK=<n> swaps the browser
 * page for a fake whose first n requests are blocked (SWS_INJECT_BLOCK_KIND
 * challenge|hard_block|unclassified|rate_limited, SWS_INJECT_RETRY_AFTER sec,
 * SWS_INJECT_BLOCK_MATCH=<substring> to block only matching requests).
 * Only in that mode, SWS_INJECT_DATA_DIR relocates data/sws and
 * SWS_INJECT_TIME_SCALE compresses every sleep, so tests drive the real loop.
 *
 * Usage:
 *   node scripts/sws-api-scrape.mjs <SHARD_ID>
 *   node scripts/sws-api-scrape.mjs <SHARD_ID> --limit 5    # test small batch
 *   node scripts/sws-api-scrape.mjs <SHARD_ID> --tickers HDFCBANK,KOVAI
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as dal from "../services/swsDal/index.js";
import { shardSliceContiguous } from "./sws-shard-partition.mjs";

const DB_FLUSH_INTERVAL = 50;

import {
  createClient,
  createInjectedClient,
  ensureOnSite,
  fetchStockData,
  probeTicker,
  reprimePage,
  TransportError,
} from "./sws-api-client.mjs";
import { recordTrip } from "./sws-panic-policy.mjs";
import {
  handleBlockIncident,
  hasVote,
  loadIncidentState,
  withdrawVote,
  writeJsonAtomic,
  MAX_NOT_BEFORE_WAIT_MS,
  REPRIME_MAX_WAIT_MS,
  SHARD_LOCAL_HALT_EXIT,
} from "./sws-panic-ladder.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Test hook — see the header. Everything below that moves files or time is
// gated on it, so a production run cannot be relocated or sped up by env.
const INJECT = (process.env.SWS_INJECT_BLOCK ?? "") !== "";
const DATA_DIR = INJECT && process.env.SWS_INJECT_DATA_DIR
  ? path.resolve(process.env.SWS_INJECT_DATA_DIR)
  : path.join(REPO_ROOT, "data/sws");
const TIME_SCALE = INJECT && Number(process.env.SWS_INJECT_TIME_SCALE) > 0
  ? Number(process.env.SWS_INJECT_TIME_SCALE)
  : 1;
const LADDER_ENABLED = process.env.SWS_PANIC_LADDER === "1";

const UNIVERSE_PATH = path.join(DATA_DIR, "universe.json");
const OUT_DIR = path.join(DATA_DIR, "deep-api");
const PROGRESS_DIR = DATA_DIR;
const PANIC_FLAG = path.join(DATA_DIR, "panic-stop.flag");

// Pacing constants — tuneable.
// The two maxima are exported because the panic quorum's confirm window
// (QUORUM_CONFIRM_MS in sws-panic-ladder.mjs) must outlast a healthy shard's
// longest silence; test/swsPanicLadder.test.mjs pins that.
const INTER_STOCK_MIN_MS = 2000;
export const INTER_STOCK_MAX_MS = 4000;
const BURST_INTERVAL = 50; // every N stocks
const BURST_PAUSE_MIN_MS = 30_000;
export const BURST_PAUSE_MAX_MS = 180_000;

// ────────── Helpers ──────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms * TIME_SCALE));
// Ladder deps already hold scaled durations (schedule × scale); no double scaling.
const sleepExact = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min));

function logEvent(obj) {
  console.log(JSON.stringify(obj));
}

// True only when this file was launched as `node scripts/sws-api-scrape.mjs`,
// false when it is imported. Everything with a process-wide side effect —
// the fatal handlers and main() itself — hangs off this, so importing the
// module to reuse `shardSlice` neither hijacks the importer's error handling
// nor kicks off a real scrape. (Same guard PR #1166 had to add to
// sws-universe-from-sitemap.mjs for the same reason.)
const isEntrypoint = () =>
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

// Top-level safety net for unhandled errors. Without these handlers, Node
// terminates the process on any unhandled rejection / uncaught exception.
// With them, we log a grep-able JSON line carrying the shard id and
// exit(2) so the launcher's retry loop in scripts/sws-refresh-api.sh can
// distinguish a fatal crash from a clean non-zero exit and resume from
// the last persisted next_local_index.
function installFatalHandlers() {
  const shardArg = parseInt(process.argv[2], 10);
  const shardId = Number.isFinite(shardArg) ? shardArg : null;
  let firing = false; // guard against re-entrancy if the handler itself throws
  const finish = (kind, err) => {
    if (firing) return;
    firing = true;
    try {
      console.error(JSON.stringify({
        event: "shard_fatal",
        kind,
        shard: shardId,
        message: err?.message ?? String(err),
        code: err?.code ?? null,
        severity: err?.severity ?? null,
        stack: err?.stack ?? null,
        at: new Date().toISOString(),
      }));
    } catch { /* logging itself must never throw */ }
    process.exit(2);
  };
  process.on("unhandledRejection", (err) => finish("unhandledRejection", err));
  process.on("uncaughtException", (err) => finish("uncaughtException", err));
}
if (isEntrypoint()) installFatalHandlers();

function loadUniverse() {
  const raw = JSON.parse(fs.readFileSync(UNIVERSE_PATH, "utf8"));
  return Array.isArray(raw) ? raw : raw.stocks || raw.universe || [];
}

// Re-exported so anything deriving a cursor for progress-api-<n>.json (notably
// `--reset-progress` in sws-universe-from-sitemap.mjs) can bind to the exact
// function this scraper walks, instead of re-deriving the partition and drifting.
//
// Must be a real local const, NOT `export { shardSliceContiguous as shardSlice }`.
// That form renames the EXPORT only; it creates no `shardSlice` binding in module
// scope, so main()'s own call below throws ReferenceError while every importer —
// and every test that asserts on the export — still sees a correct function.
// That is exactly how #1215 shipped: all three nightly shards died in ~30s
// (`ReferenceError: shardSlice is not defined`) and the pipeline logged a
// healthy-looking re-parse of stale raw payloads on top of it.
const shardSlice = shardSliceContiguous;
export { shardSlice };

/**
 * Derive the stock list this invocation will walk: an explicit `--tickers` set
 * if one was passed, otherwise the shard's slice of the universe.
 *
 * Extracted out of main() purely so the `shardSlice` call site is reachable from
 * a test. main() runs only behind `isEntrypoint()` and boots a real Chrome two
 * lines later, so nothing in-process could previously execute this branch — which
 * is why #1215's ReferenceError reached production with a green suite. Assertions
 * on the *export* cannot cover an internal call; assertions on this function can.
 *
 * @param {Array<{ticker?: string}>} universe
 * @param {number} shardId 1-based
 * @param {string[]|null} explicitTickers already upper-cased by the arg parser
 * @returns {Array} the entries to scrape, in walk order
 */
export function resolveSlice(universe, shardId, explicitTickers) {
  if (explicitTickers) {
    return universe.filter((s) => explicitTickers.includes((s.ticker || "").toUpperCase()));
  }
  return shardSlice(universe, shardId);
}

// Existence, not expiry: the run-start gates (sws-nightly.sh step 0,
// sws-refresh-api.sh step 1) archive an expired flag before any shard starts,
// so a flag seen here was written by this run and must halt it.
function checkPanic() {
  return fs.existsSync(PANIC_FLAG);
}

// Stamps expires_at + escalation via the shared policy — a bare writeFileSync
// here is what made one transient 403 refuse every night until a human
// noticed (2026-09-30 → 10-09). See scripts/sws-panic-policy.mjs.
function recordPanic(reason, shardId, evidence, extra = {}) {
  recordTrip({ dataDir: path.dirname(PANIC_FLAG), reason, shardId, evidence, extra });
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

// Atomic (tmp + rename): peers read this file mid-run for the panic quorum's
// last_ok_sent_at, and a torn read there must not look like "no evidence".
function saveProgress(shardId, progress, client = null) {
  if (client?.lastOkSentAt) progress.last_ok_sent_at = new Date(client.lastOkSentAt).toISOString();
  writeJsonAtomic(path.join(PROGRESS_DIR, `progress-api-${shardId}.json`), progress);
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
  // The injected page returns synthetic payloads; they must never land in the
  // real data/sws/deep-api (a stray SWS_INJECT_BLOCK in .env would otherwise
  // overwrite the universe with fake scores).
  if (INJECT && !process.env.SWS_INJECT_DATA_DIR) {
    console.error("SWS_INJECT_BLOCK requires SWS_INJECT_DATA_DIR (a throwaway data dir) — refusing to run");
    process.exit(2);
  }

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

  // Test hook: fire an unhandled rejection to exercise installFatalHandlers
  // and the launcher's retry loop. Only fires on the FIRST attempt
  // (SWS_RESUME != "1"), so a retried shard runs normally and the
  // launcher can prove its retry succeeded.
  if (process.env.SWS_INJECT_REJECTION === "1" && process.env.SWS_RESUME !== "1") {
    setImmediate(() => {
      Promise.reject(new Error("SWS_INJECT_REJECTION=1 — synthetic crash for retry test"));
    });
    // Park long enough for the rejection to fire and the handler to exit.
    await sleep(5000);
    return;
  }

  // Pre-flight: panic check
  if (checkPanic()) {
    logEvent({ event: "halt", reason: "panic_flag_set_at_start" });
    process.exit(3);
  }

  const universe = loadUniverse();
  const slice = resolveSlice(universe, shardId, explicitTickers);
  logEvent({ event: "start", shard: shardId, slice_size: slice.length, limit });

  // Ladder state. SWS_PANIC_RUN_ID is exported once per sws-refresh-api.sh
  // run, so a shard restarted by its rc-retry loop resumes its confirmed-
  // incident count (panic-incidents-<N>.json) instead of starting at 0.
  const runId = process.env.SWS_PANIC_RUN_ID || null;
  const incident = LADDER_ENABLED ? loadIncidentState(DATA_DIR, shardId, runId) : null;
  if (incident?.resumed) {
    logEvent({ event: "incident_state_resumed", shard: shardId, run_id: runId, opened: incident.opened, cleared: incident.cleared, skipped: incident.skipped, confirmed: incident.confirmed, not_before: incident.not_before });
  }

  // A Retry-After from this run's last confirmed incident binds the restart
  // too — checked BEFORE the browser boots, because createClient() itself
  // loads /dashboard. Too far out to wait for → halt alone, sending nothing.
  const notBeforeMs = Date.parse(incident?.not_before ?? "");
  if (Number.isFinite(notBeforeMs) && notBeforeMs > Date.now()) {
    const waitMs = notBeforeMs - Date.now();
    if (waitMs > MAX_NOT_BEFORE_WAIT_MS * TIME_SCALE) {
      logEvent({ event: "halt", reason: "retry_after_not_before", shard: shardId, not_before: incident.not_before });
      process.exit(SHARD_LOCAL_HALT_EXIT);
    }
    logEvent({ event: "retry_after_wait", shard: shardId, not_before: incident.not_before, wait_ms: waitMs });
    while (Date.now() < notBeforeMs) {
      if (checkPanic()) {
        logEvent({ event: "halt", reason: "panic_flag_set_at_start" });
        process.exit(3);
      }
      await sleepExact(Math.min(5000 * TIME_SCALE, notBeforeMs - Date.now()));
    }
  }

  // Boot client (one browser per shard)
  logEvent({ event: "client_start", shard: shardId, ...(INJECT ? { injected: true, data_dir: DATA_DIR } : {}) });
  const client = INJECT
    ? createInjectedClient({
        shardId,
        blocks: Number(process.env.SWS_INJECT_BLOCK) || 0,
        kind: process.env.SWS_INJECT_BLOCK_KIND || "challenge",
        retryAfterSec: process.env.SWS_INJECT_RETRY_AFTER ? Number(process.env.SWS_INJECT_RETRY_AFTER) : null,
        match: process.env.SWS_INJECT_BLOCK_MATCH || null,
      })
    : await createClient({ shardId, headless: true });
  logEvent({ event: "client_ready", shard: shardId });

  const progress = loadProgress(shardId);
  rollDailyCount(progress);

  // Control ticker for the ladder: the last stock SWS served this shard. On
  // an rc-retry restart that is progress.last_ticker from the previous attempt.
  const urlOf = (s) => (s?.sws_url || "").replace(/^https?:\/\/simplywall\.st/, "");
  let lastServed = null;
  if (LADDER_ENABLED && progress.last_ticker) {
    const prev = universe.find((s) => s.ticker === progress.last_ticker);
    if (urlOf(prev)) lastServed = { ticker: prev.ticker, canonicalUrl: urlOf(prev) };
  }
  // A vote left by this shard's previous attempt is withdrawn at the first
  // stock SWS serves us — it no longer describes this shard.
  let voteOutstanding = LADDER_ENABLED && hasVote(DATA_DIR, shardId);

  let scrapedThisRun = 0;
  let exitCode = 0;
  const startIdx = explicitTickers ? 0 : progress.next_local_index || 0;

  try {
    stocks: for (let i = startIdx; i < slice.length && scrapedThisRun < limit; i++) {
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
        saveProgress(shardId, progress, client);
        continue;
      }

      // Re-entered only when a ladder cleared: the same stock is fetched again.
      let laddersForTicker = 0;
      attempt: for (;;) {
        // Only the ladder navigates mid-run; a failed reprime can leave the
        // page off-site (chrome-error://), where every in-page fetch fails.
        if (LADDER_ENABLED) {
          const site = await ensureOnSite(client, { maxWaitMs: REPRIME_MAX_WAIT_MS * TIME_SCALE, pollMs: 1000 * TIME_SCALE });
          if (!site.ok) logEvent({ event: "page_recovered", shard: shardId, from: site.url, error: site.reprime?.error ?? null });
        }
        const t0 = Date.now();
        logEvent({ event: "stock_start", shard: shardId, ticker, idx: i, ...(laddersForTicker ? { after_ladder: laddersForTicker } : {}) });
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
          lastServed = { ticker, canonicalUrl };
          if (voteOutstanding) {
            withdrawVote(DATA_DIR, shardId);
            voteOutstanding = false;
            logEvent({ event: "vote_withdrawn", shard: shardId, ticker, reason: "served" });
          }
          break attempt;
        } catch (e) {
          if (e instanceof TransportError && (e.kind === "blocked" || e.kind === "rate_limited")) {
            if (!LADDER_ENABLED) {
              // Cloudflare or 429 — immediate panic
              logEvent({
                event: "panic_recorded",
                shard: shardId,
                ticker,
                reason: e.kind,
                status: e.status,
                cf_class: e.cfClass,
                body: (typeof e.body === "string" ? e.body : JSON.stringify(e.body || {})).slice(0, 200),
              });
              recordPanic(`api:${e.kind}`, shardId, `status=${e.status}`, {
                ticker,
                cf_class: e.cfClass,
                cf_ray: e.cfRay,
                body_head: (typeof e.body === "string" ? e.body : JSON.stringify(e.body || {})).slice(0, 200),
              });
              exitCode = 4;
              break stocks;
            }
            const r = await handleBlockIncident({
              err: e,
              ticker,
              shardId,
              runId,
              dataDir: DATA_DIR,
              incident,
              laddersForTicker,
              scale: TIME_SCALE,
              deps: {
                now: Date.now,
                sleep: sleepExact,
                checkFlag: checkPanic,
                probe: () => probeTicker(client, { canonicalUrl }),
                probeControl: lastServed && lastServed.ticker !== ticker
                  ? async () => ({ ...(await probeTicker(client, { canonicalUrl: lastServed.canonicalUrl })), ticker: lastServed.ticker })
                  : null,
                reprime: () => reprimePage(client, { maxWaitMs: REPRIME_MAX_WAIT_MS * TIME_SCALE, pollMs: 1000 * TIME_SCALE }),
                log: logEvent,
                flagPollMs: 5000 * TIME_SCALE,
                recordGlobal: (reason, evidence, extra) => {
                  logEvent({
                    event: "panic_recorded",
                    shard: shardId,
                    ticker,
                    reason,
                    status: e.status,
                    cf_class: e.cfClass,
                    body: (typeof e.body === "string" ? e.body : JSON.stringify(e.body || {})).slice(0, 200),
                  });
                  recordPanic(reason, shardId, evidence, {
                    ...extra,
                    body_head: (typeof e.body === "string" ? e.body : JSON.stringify(e.body || {})).slice(0, 200),
                  });
                },
              },
            });
            if (r.next === "retry") {
              laddersForTicker++;
              continue attempt;
            }
            if (r.next === "skip") {
              logEvent({ event: "stock_failed", shard: shardId, ticker, error: String(e), kind: r.reason });
              break attempt;
            }
            if (r.next === "halted") {
              logEvent({ event: "halt", reason: "panic_mid_ladder", shard: shardId, ticker });
              break stocks;
            }
            if (r.next === "halt_local") {
              voteOutstanding = true;
              logEvent({ event: "halt", reason: "ladder_no_quorum", detail: r.reason, shard: shardId, ticker });
            }
            exitCode = r.exitCode;
            break stocks;
          }
          if (e instanceof TransportError && e.kind === "auth_expired") {
            logEvent({ event: "halt", reason: "auth_expired", shard: shardId });
            exitCode = 5;
            break stocks;
          }
          // Browser/page closed unexpectedly — fatal for this shard. Without
          // this check we'd fail every subsequent stock with the same error.
          const msg = String(e);
          if (msg.includes("Target page, context or browser has been closed") ||
              msg.includes("browserContext.newPage") ||
              msg.includes("Browser closed")) {
            logEvent({ event: "halt", reason: "browser_closed", shard: shardId, ticker });
            exitCode = 6;
            break stocks;
          }
          // Non-fatal: record and move on
          logEvent({
            event: "stock_failed",
            shard: shardId,
            ticker,
            error: msg,
            kind: e?.kind,
          });
          break attempt;
        }
      }

      progress.next_local_index = i + 1;
      saveProgress(shardId, progress, client);

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
    // Persist last_ok_sent_at even on a halt mid-stock: peers' quorum reads it.
    try { saveProgress(shardId, progress, client); } catch { /* best effort */ }
    logEvent({ event: "client_close", shard: shardId });
    await client.close();
    logEvent({ event: "session_end", shard: shardId, scraped: scrapedThisRun });
  }

  process.exit(exitCode);
}

if (isEntrypoint()) {
  main().catch((e) => {
    console.error("[scrape] fatal:", e);
    process.exit(1);
  });
}
