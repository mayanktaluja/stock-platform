/**
 * Sent-alert dedup ledger — check-and-set so a headline alerts at most once.
 *
 * Adversarial-driven design:
 *   - **Absolute canonical path** (C2). Defaults to <repo>/data/alerts resolved
 *     from THIS module's __dirname (the poller has no worktree, so __dirname is
 *     the canonical repo). `ALERTS_LEDGER_DIR` overrides. NEVER a cwd-relative
 *     path — that would resolve into a throwaway worktree and the ledger would
 *     vanish every run.
 *   - **PID-mkdir lock** around read-then-append (C3) so the 30-min poller and a
 *     manual run can't lost-update each other. mkdir is atomic on every POSIX fs;
 *     a stale lock (dead holder) is cleared by mtime age.
 *   - **Monthly NDJSON** + TTL window so the file self-prunes and an old key
 *     can legitimately re-alert after the window (e.g. a recurring story).
 *
 * Only the NEWS class uses this. The REGIME class dedups via the macro cron's
 * ship-gate and never touches the ledger.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, rmdirSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(__dirname, "..", "..", "data", "alerts");
const DEFAULT_TTL_MS = 24 * 3600 * 1000; // a key re-alerts at most once per 24h
const LOCK_STALE_MS = 30 * 1000;
const LOCK_RETRIES = 10;
const LOCK_WAIT_MS = 50;

export function ledgerDir(env = process.env) {
  return String(env.ALERTS_LEDGER_DIR || "").trim() || DEFAULT_DIR;
}

export function ledgerPath(dir, now = Date.now()) {
  const d = new Date(now);
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return path.join(dir, `sent-${ym}.ndjson`);
}

/** Stable short key for a (class, identity, content) tuple. */
export function ledgerKey(parts) {
  const raw = (Array.isArray(parts) ? parts : [parts]).map((p) => String(p == null ? "" : p)).join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function syncSleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no-op */ }
}

function acquireLock(dir) {
  const lock = path.join(dir, ".ledger.lock");
  for (let i = 0; i < LOCK_RETRIES; i += 1) {
    try { mkdirSync(lock); return lock; }
    catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Held — clear if stale, else wait and retry.
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmdirSync(lock); continue; }
      } catch { /* lock vanished between calls — retry */ }
      syncSleep(LOCK_WAIT_MS);
    }
  }
  return null; // couldn't acquire — caller proceeds best-effort
}

function releaseLock(lock) {
  if (lock) { try { rmdirSync(lock); } catch { /* already gone */ } }
}

function readKeys(file, ttlMs, now) {
  if (!existsSync(file)) return new Map();
  const live = new Map();
  try {
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const { key, ts } = JSON.parse(line);
        if (key && Number.isFinite(ts) && now - ts < ttlMs) live.set(key, ts);
      } catch { /* skip corrupt line */ }
    }
  } catch { /* unreadable — treat as empty */ }
  return live;
}

/**
 * Mark `key` as sent if it hasn't been seen within the TTL window.
 *   { fresh: true }   — first time (within window); caller should send
 *   { fresh: false }  — already sent recently; caller should skip
 * Never throws; on any I/O failure resolves `{ fresh: true, degraded: true }`
 * so a broken ledger fails OPEN (better a rare duplicate than a missed alert).
 */
export function markIfNew(key, { env = process.env, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const dir = ledgerDir(env);
  try { mkdirSync(dir, { recursive: true }); } catch { return { fresh: true, degraded: true }; }

  const lock = acquireLock(dir);
  try {
    const file = ledgerPath(dir, now);
    const keys = readKeys(file, ttlMs, now);
    if (keys.has(key)) return { fresh: false };
    appendFileSync(file, JSON.stringify({ key, ts: now }) + "\n", "utf-8");
    return { fresh: true };
  } catch {
    return { fresh: true, degraded: true };
  } finally {
    releaseLock(lock);
  }
}
