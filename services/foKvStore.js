/**
 * Vercel KV persistence for the F&O OI screener.
 *
 * Mirrors the pattern in fundamentals.js:
 *   • Lazy @vercel/kv import — local dev never loads the module.
 *   • KV is the source of truth in production.
 *   • Disk is the fallback / boot-seed (committed oi-deltas-latest.json).
 *
 * Two keys, both atomic blobs (single get/set):
 *   fo:screener:v1 — the served payload (asOf, sections, methodology, stats)
 *   fo:history:v1  — { [ticker]: { ticker, points: [...] } }, 30D rolling
 *
 * The history bundle replaces the per-ticker files on Vercel (where the
 * filesystem is ephemeral between cron invocations). On a local box the
 * disk files remain authoritative; KV is just a mirror.
 */

import fs from "node:fs";
import path from "node:path";

const KV_SCREENER_KEY = "fo:screener:v1";
const KV_HISTORY_KEY = "fo:history:v1";
const HISTORY_DIR = path.join(process.cwd(), "data", "nse-fo", "history");

/**
 * Lazy KV client. Returns null in local dev (no env vars set) so callers
 * fall through to the disk path.
 */
async function getFoKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return null;
  }
  try {
    const mod = await import("@vercel/kv");
    return mod.kv;
  } catch (err) {
    console.warn("[FO-KV] @vercel/kv import failed:", err.message);
    return null;
  }
}

export async function loadFoScreenerFromKV() {
  try {
    const kv = await getFoKv();
    if (!kv) return null;
    const data = await kv.get(KV_SCREENER_KEY);
    if (!data || !data.sections) return null;
    return data;
  } catch (err) {
    console.warn("[FO-KV] loadFoScreenerFromKV failed:", err.message);
    return null;
  }
}

export async function saveFoScreenerToKV(payload) {
  try {
    const kv = await getFoKv();
    if (!kv) return false;
    await kv.set(KV_SCREENER_KEY, payload);
    return true;
  } catch (err) {
    console.error("[FO-KV] saveFoScreenerToKV failed:", err.message);
    return false;
  }
}

export async function loadFoHistoryFromKV() {
  try {
    const kv = await getFoKv();
    if (!kv) return null;
    const data = await kv.get(KV_HISTORY_KEY);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch (err) {
    console.warn("[FO-KV] loadFoHistoryFromKV failed:", err.message);
    return null;
  }
}

/**
 * Read every per-ticker disk file under data/nse-fo/history/, bundle into
 * one object, write to KV. Called at the end of runOnce after history is
 * appended for today.
 */
export async function saveFoHistoryToKVFromDisk() {
  try {
    const kv = await getFoKv();
    if (!kv) return false;
    if (!fs.existsSync(HISTORY_DIR)) return false;
    const bundle = {};
    for (const file of fs.readdirSync(HISTORY_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), "utf8"));
        if (obj?.ticker) bundle[obj.ticker] = obj;
      } catch {
        /* corrupt single file — skip */
      }
    }
    await kv.set(KV_HISTORY_KEY, bundle);
    return true;
  } catch (err) {
    console.error("[FO-KV] saveFoHistoryToKVFromDisk failed:", err.message);
    return false;
  }
}

/**
 * Read the bundled history from KV and rehydrate it onto disk so the
 * existing disk-based foHistory.js code path can use it transparently.
 * Returns the count of files written, or 0 if KV miss / not configured.
 *
 * Called at the START of runOnce on Vercel — the disk is ephemeral, so
 * we have to seed it from KV before computeVolumeRatios runs.
 */
export async function restoreFoHistoryFromKVToDisk() {
  try {
    const kv = await getFoKv();
    if (!kv) return 0;
    const bundle = await kv.get(KV_HISTORY_KEY);
    if (!bundle || typeof bundle !== "object") return 0;

    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    let written = 0;
    for (const [ticker, obj] of Object.entries(bundle)) {
      if (!obj?.ticker) continue;
      const target = path.join(HISTORY_DIR, `${ticker}.json`);
      // Only seed if the disk doesn't already have a fresher copy. On a
      // local machine with real disk files, the disk wins — KV is just a
      // backup. On Vercel the disk is empty so KV always wins.
      if (fs.existsSync(target)) continue;
      fs.writeFileSync(target, JSON.stringify(obj, null, 2));
      written += 1;
    }
    return written;
  } catch (err) {
    console.warn("[FO-KV] restoreFoHistoryFromKVToDisk failed:", err.message);
    return 0;
  }
}
