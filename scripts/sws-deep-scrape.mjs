// Helper functions for the SWS deep-scrape orchestrator.
// These are pure JS — no Chrome MCP. The slash commands interleave these calls with MCP browser ops.
//
// CLI sub-commands (callable via: node scripts/sws-deep-scrape.mjs <subcommand> [args]):
//   shard-state       SHARD_ID                                 → JSON dump of shard state + next stock
//   acquire-lock      SHARD_ID                                 → returns 0 if acquired, 1 if held
//   release-lock      SHARD_ID                                 → always 0
//   check-panic                                                → returns 0 if clear, 1 if panic flag set
//   record-panic      REASON SHARD_ID EVIDENCE                 → writes panic-stop.flag
//   check-rate-cap    SHARD_ID                                 → returns 0 if OK to proceed, 1 if at cap
//   save-stock        TICKER < parsed.json                     → atomic write to deep/<TICKER>.json
//   record-failed     TICKER FAILED_TAB ERROR                  → append to failed.json
//   advance-progress  SHARD_ID DONE_TICKER DURATION_MS         → mark done + bump next index
//   detect-signals    < pageText.txt                           → scans text for panic signals; exits 0 clean / 1 panic

import fs from "node:fs";
import path from "node:path";
import {
  PATHS, SHARD_COUNT, RATE_CAPS, PANIC_SIGNALS, HUMANISATION, indicesForShard,
} from "./sws-config.mjs";

function readJson(p, fallback = null) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}
function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}
function readStdin() {
  return new Promise((res, rej) => {
    let s = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (s += c));
    process.stdin.on("end", () => res(s));
    process.stdin.on("error", rej);
  });
}

// ---------- Universe slice for a shard ----------

export function loadUniverse() {
  const u = readJson(PATHS.universe);
  if (!u) throw new Error(`Universe not built. Run: node scripts/sws-build-universe.mjs --seed`);
  return u;
}

export function shardSlice(shardId) {
  const universe = loadUniverse();
  const idxs = indicesForShard(shardId, universe.length);
  return idxs.map((i) => universe[i]);
}

// ---------- Progress ----------

export function defaultProgress(shardId) {
  return {
    shard_id: shardId,
    next_local_index: 0,
    done_count: 0,
    last_global_index: null,
    last_ticker: null,
    last_run_at: null,
    started_at: new Date().toISOString(),
    complete: false,
    today_count: 0,
    today_date: new Date().toISOString().slice(0, 10),
    recent_completion_times: [], // ISO timestamps for last 5 stocks (for rate-cap)
    long_pause_due_after_count: 25, // re-rolled after each long pause
  };
}

export function loadShardState(shardId) {
  const slice = shardSlice(shardId);
  const progress = readJson(PATHS.progress(shardId)) || defaultProgress(shardId);
  // Reset today_count if day rolled over
  const today = new Date().toISOString().slice(0, 10);
  if (progress.today_date !== today) {
    progress.today_date = today;
    progress.today_count = 0;
  }
  const next = slice[progress.next_local_index] || null;
  return {
    shard_id: shardId,
    progress,
    slice_size: slice.length,
    next_stock: next,
    next_local_index: progress.next_local_index,
    is_complete: progress.next_local_index >= slice.length,
  };
}

export function advanceProgress(shardId, doneTicker, durationMs) {
  const slice = shardSlice(shardId);
  const progress = readJson(PATHS.progress(shardId)) || defaultProgress(shardId);
  progress.done_count = (progress.done_count || 0) + 1;
  progress.last_ticker = doneTicker;
  progress.last_global_index = slice[progress.next_local_index]?.index ?? null;
  progress.last_run_at = new Date().toISOString();
  progress.next_local_index = (progress.next_local_index || 0) + 1;
  progress.today_count = (progress.today_count || 0) + 1;
  progress.recent_completion_times = [
    new Date().toISOString(),
    ...(progress.recent_completion_times || []),
  ].slice(0, 5);
  progress.last_duration_ms = durationMs;
  if (progress.next_local_index >= slice.length) progress.complete = true;
  writeJsonAtomic(PATHS.progress(shardId), progress);
  return progress;
}

// ---------- Lock ----------

// Check if a PID is currently alive on this OS. `process.kill(pid, 0)` sends
// signal 0 — no actual signal, just permission/existence check. Throws ESRCH
// if the pid doesn't exist, EPERM if we lack permission (still alive).
function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but owned by another user — still alive
  }
}

export function acquireShardLock(shardId) {
  const lp = PATHS.shardLock(shardId);
  if (fs.existsSync(lp)) {
    const cur = readJson(lp);
    if (cur && cur.acquired_at) {
      const ageMs = Date.now() - new Date(cur.acquired_at).getTime();
      // If the pid is still alive, the lock is held regardless of age.
      // Only consider stale if the holding process is gone AND the lock is
      // older than 30 min (defensive double-check against rapid pid reuse).
      const holderAlive = isPidAlive(cur.pid);
      if (holderAlive) {
        return { acquired: false, reason: "lock_held", current: cur };
      }
      if (ageMs < 30 * 60 * 1000) {
        return { acquired: false, reason: "lock_held_recent", current: cur };
      }
      // Stale: holder is gone AND lock is old → safe to override.
    }
  }
  writeJsonAtomic(lp, { shard_id: shardId, pid: process.pid, acquired_at: new Date().toISOString() });
  return { acquired: true };
}
export function releaseShardLock(shardId) {
  const lp = PATHS.shardLock(shardId);
  try { fs.unlinkSync(lp); } catch {}
  return { released: true };
}

// ---------- Panic stop ----------

export function checkPanicStop() {
  if (!fs.existsSync(PATHS.panicStop)) return { halted: false };
  return { halted: true, info: readJson(PATHS.panicStop) };
}
export function recordPanicStop(reason, shardId, evidence) {
  writeJsonAtomic(PATHS.panicStop, {
    reason, shard_id: shardId, evidence,
    detected_at: new Date().toISOString(),
  });
}

// ---------- Page-text safety scan ----------

export function detectPanicSignalsInText(text, url = "") {
  const evidence = [];
  if (!text || text.length < PANIC_SIGNALS.minPageTextLength) {
    return { panic: true, reason: "page_too_short", evidence: [`length=${text ? text.length : 0}`] };
  }
  for (const re of PANIC_SIGNALS.pageTextRedFlags) {
    const m = text.match(re);
    if (m) evidence.push(`text_match:${m[0]}`);
  }
  for (const re of PANIC_SIGNALS.urlRedFlags) {
    if (re.test(url)) evidence.push(`url_match:${url}`);
  }
  if (evidence.length) return { panic: true, reason: "panic_signal_detected", evidence };
  return { panic: false };
}

// ---------- Rate cap ----------

export function checkRateCap(shardId) {
  const progress = readJson(PATHS.progress(shardId)) || defaultProgress(shardId);
  // Per-minute cap: if last 2 stocks finished within 60s, throttle
  const recent = progress.recent_completion_times || [];
  if (recent.length >= RATE_CAPS.maxStocksPerMinutePerShard) {
    const oldest = new Date(recent[RATE_CAPS.maxStocksPerMinutePerShard - 1]).getTime();
    const ageMs = Date.now() - oldest;
    if (ageMs < 60 * 1000) {
      return {
        ok: false,
        reason: "per_minute_cap",
        wait_ms: 60 * 1000 - ageMs,
      };
    }
  }
  return { ok: true };
}

// ---------- Stock JSON save ----------

export function saveStockJson(ticker, parsed) {
  const fp = path.join(PATHS.deepDir, `${ticker}.json`);
  writeJsonAtomic(fp, parsed);
  return fp;
}
export function recordFailedStock(ticker, failedTab, error) {
  const cur = readJson(PATHS.failed) || { entries: [] };
  cur.entries.push({
    ticker, failed_tab: failedTab, error,
    recorded_at: new Date().toISOString(),
  });
  writeJsonAtomic(PATHS.failed, cur);
}

// ---------- Concurrency token + pipeline lock (used by Playwright driver
// and the sws-refresh.sh pipeline orchestrator). ----------

const STALE_TOKEN_MS = 30 * 60 * 1000;

function readActiveShardsLock() {
  return readJson(PATHS.activeShardsLock, { active: [] });
}

function pruneStaleActive(active) {
  const cutoff = Date.now() - STALE_TOKEN_MS;
  // Keep entry if either: (a) the holding pid is still alive, OR
  // (b) the lock is recent (< 30 min). Drop only if BOTH conditions fail.
  return (active || []).filter((e) => {
    if (isPidAlive(e.pid)) return true;
    return new Date(e.acquired_at).getTime() > cutoff;
  });
}

export function claimActiveShard(shardId) {
  const cap = HUMANISATION.maxActiveShardsConcurrent || SHARD_COUNT;
  const cur = readActiveShardsLock();
  const fresh = pruneStaleActive(cur.active);
  const existing = fresh.find((e) => e.shard_id === shardId);
  if (existing) {
    existing.acquired_at = new Date().toISOString();
    writeJsonAtomic(PATHS.activeShardsLock, { active: fresh });
    return { acquired: true, refreshed: true };
  }
  if (fresh.length >= cap) {
    writeJsonAtomic(PATHS.activeShardsLock, { active: fresh });
    return { acquired: false, reason: "cap_reached", cap, current: fresh };
  }
  fresh.push({ shard_id: shardId, pid: process.pid, acquired_at: new Date().toISOString() });
  writeJsonAtomic(PATHS.activeShardsLock, { active: fresh });
  return { acquired: true };
}

export function releaseActiveShard(shardId) {
  const cur = readActiveShardsLock();
  const next = (cur.active || []).filter((e) => e.shard_id !== shardId);
  writeJsonAtomic(PATHS.activeShardsLock, { active: next });
  return { released: true };
}

export function claimPipelineLock() {
  if (fs.existsSync(PATHS.pipelineLock)) {
    const cur = readJson(PATHS.pipelineLock);
    if (cur && cur.acquired_at) {
      const age = Date.now() - new Date(cur.acquired_at).getTime();
      if (age < STALE_TOKEN_MS) return { acquired: false, current: cur };
    }
  }
  writeJsonAtomic(PATHS.pipelineLock, {
    pid: process.pid, acquired_at: new Date().toISOString(),
  });
  return { acquired: true };
}

export function releasePipelineLock() {
  try { fs.unlinkSync(PATHS.pipelineLock); } catch {}
  return { released: true };
}

// ---------- CLI ----------

async function cli() {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case "shard-state": {
      const sid = Number(args[0]);
      console.log(JSON.stringify(loadShardState(sid), null, 2));
      break;
    }
    case "acquire-lock": {
      const sid = Number(args[0]);
      const r = acquireShardLock(sid);
      console.log(JSON.stringify(r));
      process.exit(r.acquired ? 0 : 1);
    }
    case "release-lock": {
      releaseShardLock(Number(args[0]));
      console.log("released");
      break;
    }
    case "check-panic": {
      const r = checkPanicStop();
      console.log(JSON.stringify(r));
      process.exit(r.halted ? 1 : 0);
    }
    case "record-panic": {
      const [reason, sid, ...rest] = args;
      recordPanicStop(reason, Number(sid), rest.join(" "));
      console.log("recorded");
      break;
    }
    case "check-rate-cap": {
      const sid = Number(args[0]);
      const r = checkRateCap(sid);
      console.log(JSON.stringify(r));
      process.exit(r.ok ? 0 : 1);
    }
    case "save-stock": {
      const ticker = args[0];
      const raw = await readStdin();
      const parsed = JSON.parse(raw);
      const fp = saveStockJson(ticker, parsed);
      console.log(`wrote ${fp}`);
      break;
    }
    case "record-failed": {
      const [ticker, failedTab, ...errParts] = args;
      recordFailedStock(ticker, failedTab, errParts.join(" "));
      console.log("recorded failure");
      break;
    }
    case "advance-progress": {
      const [sid, ticker, dur] = args;
      const p = advanceProgress(Number(sid), ticker, Number(dur));
      console.log(JSON.stringify({ ok: true, done: p.done_count, next: p.next_local_index, complete: p.complete }));
      break;
    }
    case "detect-signals": {
      const text = await readStdin();
      const url = args[0] || "";
      const r = detectPanicSignalsInText(text, url);
      console.log(JSON.stringify(r));
      process.exit(r.panic ? 1 : 0);
    }
    case "claim-active-shard": {
      const r = claimActiveShard(Number(args[0]));
      console.log(JSON.stringify(r));
      process.exit(r.acquired ? 0 : 1);
    }
    case "release-active-shard": {
      releaseActiveShard(Number(args[0]));
      console.log("released");
      break;
    }
    case "claim-pipeline-lock": {
      const r = claimPipelineLock();
      console.log(JSON.stringify(r));
      process.exit(r.acquired ? 0 : 1);
    }
    case "release-pipeline-lock": {
      releasePipelineLock();
      console.log("released");
      break;
    }
    default:
      console.error(`Usage: node scripts/sws-deep-scrape.mjs <subcommand> [args]
Subcommands: shard-state | acquire-lock | release-lock | check-panic | record-panic |
             check-rate-cap | save-stock | record-failed | advance-progress | detect-signals |
             claim-active-shard | release-active-shard | claim-pipeline-lock | release-pipeline-lock`);
      process.exit(2);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) cli().catch((e) => { console.error(e); process.exit(1); });
