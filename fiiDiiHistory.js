/**
 * FII / DII history persistence.
 *
 * Holds a rolling window (default 30 sessions) of {date, fii, dii} entries
 * so the Market Intelligence card can plot a 5–10 session sparkline. NSE
 * publishes once per session at ~18:30 IST, so writes are at most one per
 * day — no batching, no debouncing needed.
 *
 * Storage backend mirrors the paperTradesStorage / portfolioStorage pattern:
 *   - Local dev (no KV env vars):   file at .fii-dii-history.json (repo root)
 *   - Vercel prod (KV configured):  key "fii_dii_history" in Vercel KV
 *
 * Both backends store the same shape — a JSON array, newest-first:
 *   [
 *     { "date": "30-Apr-2026", "fii": -8047.86, "dii": 3487.10, "savedAt": "2026-04-30T18:34:12.000Z" },
 *     { "date": "29-Apr-2026", "fii": ..., "dii": ... },
 *     ...
 *   ]
 *
 * appendIfNew is idempotent on the `date` field: re-running the fetcher
 * within a session is a no-op. The same calendar date is never written
 * twice.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FILE_PATH = path.join(__dirname, ".fii-dii-history.json");
const KV_KEY = "fii_dii_history";
const MAX_ENTRIES = 30;

let _kvClient = null;
async function getKV() {
  if (_kvClient) return _kvClient;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  const mod = await import("@vercel/kv");
  _kvClient = mod.kv;
  return _kvClient;
}

async function readAllRaw() {
  // Vercel KV first — the canonical source on prod
  const kv = await getKV().catch(() => null);
  if (kv) {
    try {
      const arr = await kv.get(KV_KEY);
      if (Array.isArray(arr)) return arr;
      return [];
    } catch (err) {
      console.warn("[FII-DII-HIST:KV] read failed:", err.message);
      // fall through to file in case KV is transiently down
    }
  }
  // File backend (local dev)
  if (!existsSync(FILE_PATH)) return [];
  try {
    const raw = readFileSync(FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("[FII-DII-HIST:FILE] read failed:", err.message);
    return [];
  }
}

async function writeAllRaw(arr) {
  const kv = await getKV().catch(() => null);
  if (kv) {
    try {
      await kv.set(KV_KEY, arr);
      return { backend: "kv", ok: true };
    } catch (err) {
      console.warn("[FII-DII-HIST:KV] write failed:", err.message);
      // fall through to file as best-effort backup
    }
  }
  try {
    writeFileSync(FILE_PATH, JSON.stringify(arr, null, 2), "utf-8");
    return { backend: "file", ok: true };
  } catch (err) {
    // Vercel filesystem outside /tmp is read-only; skip silently in that case
    if (err.code !== "EROFS" && err.code !== "EACCES") {
      console.warn("[FII-DII-HIST:FILE] write failed:", err.message);
    }
    return { backend: "none", ok: false, error: err.message };
  }
}

/**
 * Append a new session entry if its date is not already at the top of the
 * history. Returns { written: bool, total: <length after> }.
 *
 * `entry` shape: { date: "30-Apr-2026", fii: <number>, dii: <number> }
 * Both fii and dii are net values in ₹ Cr. Either can be null/undefined when
 * the upstream feed is incomplete; we still record the row so the gap shows
 * in the sparkline.
 */
export async function appendIfNew(entry) {
  if (!entry || !entry.date) return { written: false, total: 0, reason: "missing date" };
  const all = await readAllRaw();
  if (all.length > 0 && all[0].date === entry.date) {
    return { written: false, total: all.length, reason: "same date already at top" };
  }
  const next = [
    {
      date: entry.date,
      fii: Number.isFinite(entry.fii) ? entry.fii : null,
      dii: Number.isFinite(entry.dii) ? entry.dii : null,
      savedAt: new Date().toISOString(),
    },
    ...all,
  ].slice(0, MAX_ENTRIES);
  const result = await writeAllRaw(next);
  return { written: result.ok, total: next.length, backend: result.backend };
}

/**
 * Read the most recent `n` sessions, newest first. Returns at most
 * MAX_ENTRIES rows even if a larger n is requested.
 */
export async function readRecent(n = 10) {
  const all = await readAllRaw();
  return all.slice(0, Math.min(n, MAX_ENTRIES));
}
