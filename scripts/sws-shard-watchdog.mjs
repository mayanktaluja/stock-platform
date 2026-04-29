#!/usr/bin/env node
// Watchdog for the 3 SWS Playwright shards.
//
// Default mode: print a status table; if any shard is unhealthy, kill all
// shard processes + Playwright-spawned Chromium, wait 20s, relaunch.
//
// Flags:
//   --check-only   print the table only, never recover
//   --force        run recovery flow regardless of health
//
// "Unhealthy" = lock file exists with a dead PID, OR last_run_at is older
// than STALE_MS (default 10 min), OR the lock is missing while progress
// shows the slice is incomplete (no scraper running on an unfinished shard).

import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SWS_DIR = path.join(ROOT, "data/sws");

const STALE_MS = 10 * 60 * 1000;
const RESTART_WAIT_MS = 20_000;
const SHARD_STAGGER_MS = 20_000;

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function statusFor(id) {
  const prog = readJSON(path.join(SWS_DIR, `progress-${id}.json`));
  const lock = readJSON(path.join(SWS_DIR, `scan-${id}.lock`));
  const now = Date.now();
  const lastMs = prog?.last_run_at ? new Date(prog.last_run_at).getTime() : 0;
  const ageMin = lastMs ? Math.round((now - lastMs) / 60000) : null;
  const alive = pidAlive(lock?.pid);
  const stale = lastMs && (now - lastMs) > STALE_MS;
  const complete = !!prog?.complete;

  let health;
  if (complete) health = "complete";
  else if (lock && !alive) health = "dead-pid";
  else if (lock && alive && stale) health = "stalled";
  else if (!lock) health = "no-lock";
  else health = "ok";

  return {
    id,
    health,
    done: prog?.done_count ?? 0,
    idx: prog?.next_local_index ?? 0,
    slice: prog?._slice_size ?? null,
    last: prog?.last_ticker ?? "-",
    ageMin,
    pid: lock?.pid ?? null,
    aliveLockPid: alive,
  };
}

function readAllStatus() {
  return [1, 2, 3].map(statusFor);
}

function printTable(rows) {
  const ts = new Date().toISOString();
  const lines = [];
  lines.push(`\n=== SWS shard watchdog @ ${ts} ===`);
  lines.push("shard | health    |  done | idx/slice    | last ticker  |  age | pid");
  lines.push("------+-----------+-------+--------------+--------------+------+-------");
  for (const r of rows) {
    const slice = `${r.idx}/${r.slice ?? "?"}`.padEnd(12);
    const age = r.ageMin == null ? "  -  " : `${r.ageMin}m`.padStart(5);
    lines.push(
      `  ${r.id}   | ${r.health.padEnd(9)} | ${String(r.done).padStart(5)} | ${slice} | ${(r.last || "-").padEnd(12)} | ${age} | ${r.pid ?? "-"}`
    );
  }
  console.log(lines.join("\n"));
}

function unhealthy(rows) {
  return rows.filter(r => r.health === "dead-pid" || r.health === "stalled" || r.health === "no-lock");
}

function trySh(cmd) {
  try { execSync(cmd, { stdio: "ignore" }); } catch { /* ok */ }
}

function killShardProcs(rows) {
  // 1. SIGTERM the lock-pids that are still alive.
  for (const r of rows) {
    if (r.pid && r.aliveLockPid) {
      try { process.kill(r.pid, "SIGTERM"); console.log(`  SIGTERM → shard ${r.id} pid ${r.pid}`); }
      catch (e) { console.log(`  SIGTERM ${r.pid} failed: ${e.message}`); }
    }
  }
  // 2. Sweep any orphaned sws-scrape-playwright processes by cmdline.
  trySh(`pkill -TERM -f "sws-scrape-playwright\\.mjs" 2>/dev/null`);
}

function killChromeScrapers() {
  // Playwright's bundled chromium lives under node_modules/playwright (or the
  // global ms-playwright cache). Match those, plus "Chrome for Testing"
  // which is what newer Playwright builds spawn. We deliberately do NOT
  // touch the user's regular "Google Chrome.app".
  trySh(`pkill -TERM -f "ms-playwright/chromium" 2>/dev/null`);
  trySh(`pkill -TERM -f "playwright.*chromium" 2>/dev/null`);
  trySh(`pkill -TERM -f "Chrome for Testing" 2>/dev/null`);
  trySh(`pkill -TERM -f "Chromium\\.app/Contents/MacOS/Chromium" 2>/dev/null`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ensureDead(rows) {
  // Wait up to 5s for SIGTERM, then SIGKILL anything still alive.
  for (let i = 0; i < 10; i++) {
    if (!rows.some(r => r.pid && pidAlive(r.pid))) return;
    await sleep(500);
  }
  for (const r of rows) {
    if (r.pid && pidAlive(r.pid)) {
      try { process.kill(r.pid, "SIGKILL"); console.log(`  SIGKILL → shard ${r.id} pid ${r.pid}`); }
      catch { /* ok */ }
    }
  }
  trySh(`pkill -KILL -f "sws-scrape-playwright\\.mjs" 2>/dev/null`);
  trySh(`pkill -KILL -f "ms-playwright/chromium" 2>/dev/null`);
  trySh(`pkill -KILL -f "Chrome for Testing" 2>/dev/null`);
}

function clearStaleLocks() {
  for (const id of [1, 2, 3]) {
    const p = path.join(SWS_DIR, `scan-${id}.lock`);
    try { fs.unlinkSync(p); console.log(`  removed ${path.basename(p)}`); } catch { /* ok */ }
  }
  // Also clear the umbrella pipeline lock if a previous refresh.sh died holding it.
  trySh(`node scripts/sws-deep-scrape.mjs release-pipeline-lock >/dev/null 2>&1`);
}

function relaunchShards() {
  const launched = [];
  for (const id of [1, 2, 3]) {
    const logPath = path.join(SWS_DIR, `refresh-shard-${id}.log`);
    const out = fs.openSync(logPath, "a");
    const child = spawn(
      "node",
      ["scripts/sws-scrape-playwright.mjs", String(id), "--ignore-window"],
      { cwd: ROOT, detached: true, stdio: ["ignore", out, out] }
    );
    child.unref();
    launched.push({ id, pid: child.pid });
    console.log(`  spawned shard ${id} → pid ${child.pid}`);
  }
  return launched;
}

async function recover(rows) {
  console.log("\n--- recovery: stopping shards ---");
  killShardProcs(rows);
  await ensureDead(rows);
  console.log("--- recovery: closing scraper Chrome ---");
  killChromeScrapers();
  await sleep(1000);
  console.log("--- recovery: clearing stale locks ---");
  clearStaleLocks();
  console.log(`--- recovery: waiting ${RESTART_WAIT_MS / 1000}s ---`);
  await sleep(RESTART_WAIT_MS);
  console.log("--- recovery: relaunching shards (20s stagger) ---");
  // Stagger spawns so they don't burst-open chromium together.
  const launched = [];
  for (const id of [1, 2, 3]) {
    const logPath = path.join(SWS_DIR, `refresh-shard-${id}.log`);
    const out = fs.openSync(logPath, "a");
    const child = spawn(
      "node",
      ["scripts/sws-scrape-playwright.mjs", String(id), "--ignore-window"],
      { cwd: ROOT, detached: true, stdio: ["ignore", out, out] }
    );
    child.unref();
    launched.push({ id, pid: child.pid });
    console.log(`  spawned shard ${id} → pid ${child.pid}`);
    if (id < 3) await sleep(SHARD_STAGGER_MS);
  }
  await sleep(3000);
  console.log("--- post-restart status ---");
  printTable(readAllStatus());
}

(async function main() {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has("--check-only");
  const force = args.has("--force");

  const rows = readAllStatus();
  printTable(rows);

  const bad = unhealthy(rows);
  if (!force && bad.length === 0) {
    console.log("→ all shards healthy");
    return;
  }

  if (force) {
    console.log("→ --force set: triggering recovery regardless of health");
  } else {
    console.log(`→ unhealthy: ${bad.map(r => `#${r.id}(${r.health})`).join(", ")}`);
  }

  if (checkOnly) {
    console.log("→ --check-only: skipping recovery");
    process.exit(bad.length === 0 ? 0 : 1);
  }

  await recover(rows);
})();
