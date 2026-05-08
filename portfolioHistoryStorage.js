/**
 * Portfolio History Storage Adapter — per-user snapshot history
 *
 * Keeps the last N portfolio snapshots per user, ordered newest-first
 * by broker-statement asOfDateIso (then uploadedAtIso as tiebreaker).
 * Powers the recommendation reconciler — without history, every upload
 * looks like the first upload and we can't detect what the user did.
 *
 * Two interchangeable backends (mirrors analyzerStorage.js / portfolioStorage.js):
 *   1. FILE storage (local dev): JSON map at portfolio-history.json keyed by sub.
 *   2. VERCEL KV storage (prod):  one key per user, `portfolio:history:{sub}`.
 *
 * Auto-selects based on KV_REST_API_URL env var presence.
 *
 * Schema:
 *   {
 *     sub: "...",
 *     schemaVersion: 1,
 *     snapshots: [Snapshot],   // newest-first by asOfDateIso desc
 *   }
 *
 *   Snapshot = {
 *     asOfDateIso: "YYYY-MM-DD",  // canonical broker-statement date (immutable)
 *     uploadedAtIso: "ISO-8601",  // server clock at upload (immutable)
 *     contentHash: "sha1-hex",    // content fingerprint for idempotency (immutable)
 *     sourceFile: string|null,
 *     sourceBroker: "groww-xlsx"|"zerodha-csv"|"upstox-xlsx"|"rerun:..."|null,
 *     backdated: boolean,         // asOfDateIso < max(prior asOfDateIso)
 *     asOfDateInferred: boolean,  // parser gave no date, fell back to uploadedAt
 *     holdings: [{ symbol, isin, name, quantity, avgPrice, sector }],
 *     facets:   [{ symbol, isin, positionWeight, pnlPercent, combinedScore,
 *                  fundamentalVerdict, action, factors, swsCovered, trimRupees,
 *                  topUpRupees, livePrice }]
 *   }
 *
 * Cap: HISTORY_CAP snapshots per user (eviction guard prevents dropping snapshots[0]).
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.join(__dirname, "portfolio-history.json");
const historyKey = (sub) => `portfolio:history:${sub}`;

export const HISTORY_CAP = 12;
export const HISTORY_SCHEMA_VERSION = 1;

const EMPTY = () => ({ snapshots: [], schemaVersion: HISTORY_SCHEMA_VERSION });

function compareSnapshotsDesc(a, b) {
  if (a.asOfDateIso !== b.asOfDateIso) {
    return a.asOfDateIso < b.asOfDateIso ? 1 : -1;
  }
  return (a.uploadedAtIso || "") < (b.uploadedAtIso || "") ? 1 : -1;
}

export function insertSnapshotSorted(snapshots, snap, cap = HISTORY_CAP) {
  const next = [...snapshots, snap].sort(compareSnapshotsDesc);
  if (next.length <= cap) return next;

  // Cap behaviour: drop oldest non-backdated first; if all remaining are
  // backdated, drop the oldest one. snapshots[0] (newest) is never evicted.
  for (let i = next.length - 1; i > 0; i--) {
    if (!next[i].backdated) {
      next.splice(i, 1);
      if (next.length <= cap) return next;
    }
  }
  while (next.length > cap) next.splice(next.length - 1, 1);
  return next;
}

export function isBackdated(snap, snapshots) {
  if (!snapshots || snapshots.length === 0) return false;
  const latest = snapshots[0];
  return snap.asOfDateIso < latest.asOfDateIso;
}

export function findByContentHash(snapshots, contentHash, asOfDateIso) {
  return snapshots.find(
    (s) => s.contentHash === contentHash && s.asOfDateIso === asOfDateIso,
  );
}

class FilePortfolioHistoryStorage {
  constructor() { this.name = "file"; }

  async _readAll() {
    if (!existsSync(HISTORY_PATH)) return {};
    try { return JSON.parse(readFileSync(HISTORY_PATH, "utf-8")); }
    catch { return {}; }
  }

  async _writeAll(map) {
    writeFileSync(HISTORY_PATH, JSON.stringify(map, null, 2), "utf-8");
    return true;
  }

  async read(sub) {
    if (!sub) return { sub: null, ...EMPTY() };
    const all = await this._readAll();
    const entry = all[sub];
    if (!entry) return { sub, ...EMPTY() };
    return {
      sub,
      schemaVersion: entry.schemaVersion || HISTORY_SCHEMA_VERSION,
      snapshots: Array.isArray(entry.snapshots) ? entry.snapshots : [],
    };
  }

  async appendSnapshot(sub, snap) {
    if (!sub) throw new Error("appendSnapshot: sub is required");
    if (!snap || !snap.asOfDateIso) throw new Error("appendSnapshot: snap.asOfDateIso required");
    const all = await this._readAll();
    const cur = all[sub] || EMPTY();
    const snapshots = Array.isArray(cur.snapshots) ? cur.snapshots : [];
    if (findByContentHash(snapshots, snap.contentHash, snap.asOfDateIso)) {
      return { written: false, reason: "duplicate" };
    }
    const next = insertSnapshotSorted(snapshots, snap);
    all[sub] = { schemaVersion: HISTORY_SCHEMA_VERSION, snapshots: next };
    await this._writeAll(all);
    return { written: true, snapshotCount: next.length };
  }
}

class KVPortfolioHistoryStorage {
  constructor() { this.name = "vercel-kv"; this._kv = null; }

  async _getKV() {
    if (this._kv) return this._kv;
    const mod = await import("@vercel/kv");
    this._kv = mod.kv;
    return this._kv;
  }

  async read(sub) {
    if (!sub) return { sub: null, ...EMPTY() };
    try {
      const kv = await this._getKV();
      const data = await kv.get(historyKey(sub));
      if (!data) return { sub, ...EMPTY() };
      const parsed = typeof data === "string" ? JSON.parse(data) : data;
      return {
        sub,
        schemaVersion: parsed.schemaVersion || HISTORY_SCHEMA_VERSION,
        snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
      };
    } catch (err) {
      console.warn("[HISTORY:KV] read failed:", err.message);
      return { sub, ...EMPTY() };
    }
  }

  async appendSnapshot(sub, snap) {
    if (!sub) throw new Error("appendSnapshot: sub is required");
    if (!snap || !snap.asOfDateIso) throw new Error("appendSnapshot: snap.asOfDateIso required");
    try {
      const cur = await this.read(sub);
      if (findByContentHash(cur.snapshots, snap.contentHash, snap.asOfDateIso)) {
        return { written: false, reason: "duplicate" };
      }
      const next = insertSnapshotSorted(cur.snapshots, snap);
      const kv = await this._getKV();
      await kv.set(historyKey(sub), { schemaVersion: HISTORY_SCHEMA_VERSION, snapshots: next });
      return { written: true, snapshotCount: next.length };
    } catch (err) {
      console.warn("[HISTORY:KV] append failed:", err.message);
      return { written: false, reason: "kv-error" };
    }
  }
}

let _storage = null;

export function getPortfolioHistoryStorage() {
  if (_storage) return _storage;
  const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
  _storage = hasKV ? new KVPortfolioHistoryStorage() : new FilePortfolioHistoryStorage();
  console.log(`[HISTORY] Using ${_storage.name} storage`);
  return _storage;
}

export function _resetForTests() {
  _storage = null;
}
