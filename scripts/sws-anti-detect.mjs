// Humanisation / anti-detection layer for the Playwright SWS scraper.
// Pure utilities — no Playwright import here so the unit-test surface stays small.
// All knobs come from sws-config.mjs HUMANISATION block.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HUMANISATION, TIMING, PATHS, randInt } from "./sws-config.mjs";

// ---------- Sleep ----------

// Gaussian via Box-Muller, clamped to [min, max].
function gaussianBetween(min, max) {
  const mean = (min + max) / 2;
  const sigma = (max - min) / 4; // ~95% within range
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const v = mean + sigma * z;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function pickMs(timingKey) {
  const range = TIMING[timingKey];
  if (!range) throw new Error(`Unknown TIMING key: ${timingKey}`);
  if (HUMANISATION.sleepDistribution === "gaussian") {
    return gaussianBetween(range.min, range.max);
  }
  return randInt(range.min, range.max);
}

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function jitteredSleep(timingKey) {
  await sleep(pickMs(timingKey));
}

// ---------- Tab order ----------

export function shuffleTabs(tabs) {
  if (!HUMANISATION.shuffleTabs) return [...tabs];
  const a = [...tabs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function maybePickRevisitTab(tabsVisited) {
  if (!HUMANISATION.tabRevisitProbability) return null;
  if (Math.random() > HUMANISATION.tabRevisitProbability) return null;
  if (!tabsVisited || tabsVisited.length < 2) return null;
  return tabsVisited[Math.floor(Math.random() * tabsVisited.length)];
}

// ---------- Per-tab humanisation (called with a Playwright Page) ----------

export async function humaniseTab(page) {
  const opts = HUMANISATION.microActions || {};
  if (opts.scroll) {
    const [yMin, yMax] = opts.scrollYRange || [200, 1500];
    const targetY = randInt(yMin, yMax);
    try {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: "smooth" }), targetY);
    } catch {}
  }
  if (opts.dwellMsRange) {
    await sleep(randInt(opts.dwellMsRange[0], opts.dwellMsRange[1]));
  }
  if (opts.mouseMove) {
    try {
      const x1 = randInt(100, 1200);
      const y1 = randInt(100, 600);
      const x2 = randInt(100, 1200);
      const y2 = randInt(100, 600);
      await page.mouse.move(x1, y1, { steps: 6 });
      await page.mouse.move(x2, y2, { steps: 8 });
    } catch {}
  }
}

// Closing ritual — navigate to /dashboard and dwell, then resolve.
// Only the home dwell; caller closes the context after this returns.
export async function performClosingRitual(page) {
  const [dMin, dMax] = HUMANISATION.closingDwellMsRange || [3000, 8000];
  try {
    await page.goto("https://simplywall.st/dashboard", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  } catch {}
  await sleep(randInt(dMin, dMax));
}

// ---------- Session length ----------

export function pickSessionStockCount() {
  const [a, b] = HUMANISATION.sessionStockCountRange || [30, 60];
  return randInt(a, b);
}

// ---------- Circadian window ----------

// Returns true if "now in IST" is inside the active window for today.
// The daily start jitter is seeded by date, so two checks within the same
// minute return the same answer.
export function withinCircadianWindow(now = new Date()) {
  const w = HUMANISATION.circadianWindow;
  if (!w) return true;
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const dayKey = ist.toISOString().slice(0, 10);
  const seed = crypto.createHash("sha256").update("circadian:" + dayKey).digest();
  const jitterRange = HUMANISATION.circadianStartJitterMinutes || 0;
  // Map first 4 bytes of seed to [-jitter, +jitter] minutes.
  const raw = seed.readUInt32BE(0) % (2 * jitterRange + 1);
  const jitter = raw - jitterRange;

  const startMin = w.startHour * 60 + (w.startMinute || 0) + jitter;
  const endMin = w.endHour * 60 + (w.endMinute || 0);
  const nowMin = ist.getHours() * 60 + ist.getMinutes();
  return nowMin >= startMin && nowMin < endMin;
}

// ---------- Weekly rest day ----------

// Returns true if THIS shard rests today. Seed = ISO week + shard id, so the
// rest day is fixed for the week but unpredictable across weeks.
export function isWeeklyRestDay(shardId, now = new Date()) {
  if (!HUMANISATION.weeklyRest || !HUMANISATION.weeklyRest.enabled) return false;
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  // ISO week computation
  const tmp = new Date(Date.UTC(ist.getFullYear(), ist.getMonth(), ist.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
  const weekKey = `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}-S${shardId}`;
  const seed = crypto.createHash("sha256").update("weekrest:" + weekKey).digest();
  const restDay = seed.readUInt8(0) % 7; // 0..6, where 0=Monday in ISO terms
  // ISO weekday: Monday=1..Sunday=7 → match against (restDay+1)
  const isoWeekday = ist.getDay() === 0 ? 7 : ist.getDay();
  return isoWeekday === restDay + 1;
}

// ---------- Concurrency token (cross-process file semaphore) ----------

function readCounter() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.activeShardsLock, "utf-8"));
  } catch {
    return { active: [] };
  }
}

function writeCounterAtomic(obj) {
  fs.mkdirSync(path.dirname(PATHS.activeShardsLock), { recursive: true });
  const tmp = PATHS.activeShardsLock + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, PATHS.activeShardsLock);
}

const STALE_TOKEN_MS = 30 * 60 * 1000; // 30 min — same as shard lock TTL
function pruneStale(active) {
  const cutoff = Date.now() - STALE_TOKEN_MS;
  return active.filter((e) => new Date(e.acquired_at).getTime() > cutoff);
}

// Optimistic-CAS file semaphore. Returns true if acquired.
export function tryAcquireConcurrencyToken(shardId) {
  const cap = HUMANISATION.maxActiveShardsConcurrent || 99;
  const cur = readCounter();
  const fresh = pruneStale(cur.active || []);
  // Re-entrant: if this shard already holds a token, refresh it.
  const existing = fresh.find((e) => e.shard_id === shardId);
  if (existing) {
    existing.acquired_at = new Date().toISOString();
    writeCounterAtomic({ active: fresh });
    return true;
  }
  if (fresh.length >= cap) {
    writeCounterAtomic({ active: fresh });
    return false;
  }
  fresh.push({ shard_id: shardId, pid: process.pid, acquired_at: new Date().toISOString() });
  writeCounterAtomic({ active: fresh });
  return true;
}

export function releaseConcurrencyToken(shardId) {
  const cur = readCounter();
  const next = (cur.active || []).filter((e) => e.shard_id !== shardId);
  writeCounterAtomic({ active: next });
}

// Block until a concurrency slot frees up. Polls every 30 s. Returns once
// acquired. Caller is responsible for releasing.
export async function awaitConcurrencyToken(shardId, { pollMs = 30000, maxWaitMs = null } = {}) {
  const startedAt = Date.now();
  while (true) {
    if (tryAcquireConcurrencyToken(shardId)) return true;
    if (maxWaitMs && Date.now() - startedAt > maxWaitMs) return false;
    await sleep(pollMs);
  }
}
