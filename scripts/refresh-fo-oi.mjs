#!/usr/bin/env node
/**
 * F&O OI-Delta Swing Screener — refresh orchestrator (local + CI).
 *
 * Usage:
 *   node scripts/refresh-fo-oi.mjs                  # most-recent IST weekday
 *   node scripts/refresh-fo-oi.mjs --date=2026-05-05
 *   node scripts/refresh-fo-oi.mjs --force          # bypass 10-min mtime grace
 *
 * Single-flight: claims data/nse-fo/pipeline.lock; exits 0 cleanly if the
 * lock is held by another process. Vercel cron uses the API route directly
 * (services/foScreener.js#runOnce), so this script is for local dev,
 * manual replays, and shell-based scheduling.
 */

import fs from "node:fs";
import path from "node:path";

import {
  runOnce,
} from "../services/foScreener.js";
import {
  BhavcopyNotPublished,
  BhavcopyBlocked,
} from "../services/foBhavcopyFetcher.js";

const ROOT = process.cwd();
const FO_DIR = path.join(ROOT, "data", "nse-fo");
const LOCK_PATH = path.join(FO_DIR, "pipeline.lock");
const LOG_PATH = path.join(FO_DIR, "refresh.log");

function parseArgs(argv) {
  const out = { date: null, force: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--date=")) out.date = a.slice("--date=".length);
    else if (a === "--force" || a === "--force-refetch") out.force = true;
    else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, stamped);
  process.stdout.write(stamped);
}

function claimLock() {
  fs.mkdirSync(FO_DIR, { recursive: true });
  // Stale lock: if process referenced inside is gone, reclaim it.
  if (fs.existsSync(LOCK_PATH)) {
    try {
      const held = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
      const ageMs = Date.now() - new Date(held.acquiredAt).getTime();
      try {
        process.kill(held.pid, 0); // throws if process gone
        if (ageMs < 30 * 60 * 1000) return false; // legitimately held
        log(`stale lock from pid ${held.pid} (${ageMs}ms old) — reclaiming`);
      } catch {
        log(`abandoned lock from dead pid ${held.pid} — reclaiming`);
      }
    } catch {
      log("malformed lock file — reclaiming");
    }
  }
  fs.writeFileSync(
    LOCK_PATH,
    JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2),
  );
  return true;
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    /* already gone */
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const acquired = claimLock();
  if (!acquired) {
    log("pipeline.lock held by another process — exiting");
    process.exit(0);
  }

  const cleanup = () => releaseLock();
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    log(`starting F&O refresh${args.date ? ` (date=${args.date})` : ""}${args.force ? " [force]" : ""}`);
    const result = await runOnce({ date: args.date, forceRefetch: args.force });
    log(
      `done: asOf=${result.asOf} universe=${result.stats.totalUniverse} ` +
      `withSignal=${result.stats.withSignal} decoupled=${result.stats.decoupled} ` +
      `inBook=${result.stats.inBookCount} inPicks=${result.stats.inPicksCount} ` +
      `broader=${result.stats.broaderCount} walked=${result.walked} ` +
      `(${result.durationMs}ms)`,
    );
    process.exitCode = 0;
  } catch (err) {
    if (err instanceof BhavcopyNotPublished) {
      log(`bhavcopy not yet published for ${err.date} — exiting clean (cron will retry)`);
      process.exitCode = 0;
      return;
    }
    if (err instanceof BhavcopyBlocked) {
      log(`bhavcopy blocked (HTTP ${err.status}) for ${err.date} — exit 75 to signal retry-later`);
      process.exitCode = 75; // EX_TEMPFAIL
      return;
    }
    log(`error: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    releaseLock();
  }
}

main();
