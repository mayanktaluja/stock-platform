/**
 * Watchlist Storage Adapter — per-user
 *
 * Two interchangeable backends (same per-sub pattern as portfolioStorage.js):
 *   1. FILE storage (local dev): JSON map at .watchlist.json keyed by sub,
 *      each value an array of watchlist items.
 *   2. VERCEL KV storage (prod): one hash per user at `watchlist:{sub}`,
 *      field = symbol, value = JSON item. O(1) add/remove, and a read never
 *      loads another user's list.
 *
 * Auto-selects based on KV_REST_API_URL env var presence.
 *
 * Every call requires `sub` (Google subject claim). The caller sources it
 * from userSub(req); writes THROW on a missing sub so a route that forgets
 * to pass it fails loudly instead of silently writing a shared bucket
 * (same defensive contract as portfolioStorage.js:49,83).
 *
 * Migration note: the pre-namespacing global list lived at the flat
 * `.watchlist.json` array (file) / `watchlist:items` hash (KV). Those legacy
 * keys are NOT read here anymore — scripts/migrate-watchlist-per-user.mjs
 * copies them into an owner namespace. See CLAUDE.md "auth iter 2".
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHLIST_PATH = path.join(__dirname, ".watchlist.json");
const watchlistKey = (sub) => `watchlist:${sub}`;

// ── File adapter ──

class FileWatchlistStorage {
  constructor() { this.name = "file"; }

  async _readAll() {
    if (!existsSync(WATCHLIST_PATH)) return {};
    try {
      const parsed = JSON.parse(readFileSync(WATCHLIST_PATH, "utf-8"));
      // Defensive: a pre-migration file is a bare array. Treat it as empty
      // per-user state — the migration script owns moving it to a sub.
      return Array.isArray(parsed) ? {} : (parsed || {});
    } catch { return {}; }
  }

  async _writeAll(map) {
    writeFileSync(WATCHLIST_PATH, JSON.stringify(map, null, 2), "utf-8");
    return true;
  }

  async read(sub) {
    if (!sub) return [];
    const all = await this._readAll();
    return Array.isArray(all[sub]) ? all[sub] : [];
  }

  async add(sub, item) {
    if (!sub) throw new Error("add: sub is required");
    const all = await this._readAll();
    const list = Array.isArray(all[sub]) ? all[sub] : [];
    if (list.some((s) => s.symbol === item.symbol)) return { action: "already_exists" };
    list.push(item);
    all[sub] = list;
    await this._writeAll(all);
    return { action: "added", count: list.length };
  }

  async remove(sub, symbol) {
    if (!sub) throw new Error("remove: sub is required");
    const all = await this._readAll();
    const list = (Array.isArray(all[sub]) ? all[sub] : []).filter((s) => s.symbol !== symbol);
    all[sub] = list;
    await this._writeAll(all);
    return { action: "removed", count: list.length };
  }
}

// ── Vercel KV adapter ──

class KVWatchlistStorage {
  constructor() { this.name = "vercel-kv"; this._kv = null; }

  async _getKV() {
    if (this._kv) return this._kv;
    const mod = await import("@vercel/kv");
    this._kv = mod.kv;
    return this._kv;
  }

  async read(sub) {
    if (!sub) return [];
    try {
      const kv = await this._getKV();
      const all = await kv.hgetall(watchlistKey(sub));
      if (!all) return [];
      return Object.values(all).map((v) => typeof v === "string" ? JSON.parse(v) : v);
    } catch (err) {
      console.warn("[WATCHLIST:KV] read failed:", err.message);
      return [];
    }
  }

  async add(sub, item) {
    if (!sub) throw new Error("add: sub is required");
    try {
      const kv = await this._getKV();
      const key = watchlistKey(sub);
      const existing = await kv.hget(key, item.symbol);
      if (existing) return { action: "already_exists" };
      await kv.hset(key, { [item.symbol]: JSON.stringify(item) });
      const count = await kv.hlen(key);
      return { action: "added", count };
    } catch (err) {
      console.warn("[WATCHLIST:KV] add failed:", err.message);
      return { action: "error", error: err.message };
    }
  }

  async remove(sub, symbol) {
    if (!sub) throw new Error("remove: sub is required");
    try {
      const kv = await this._getKV();
      const key = watchlistKey(sub);
      await kv.hdel(key, symbol);
      const count = await kv.hlen(key);
      return { action: "removed", count };
    } catch (err) {
      console.warn("[WATCHLIST:KV] remove failed:", err.message);
      return { action: "error", error: err.message };
    }
  }
}

// ── Adapter selection ──

let _storage = null;

export function getWatchlistStorage() {
  if (_storage) return _storage;
  const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
  _storage = hasKV ? new KVWatchlistStorage() : new FileWatchlistStorage();
  console.log(`[WATCHLIST] Using ${_storage.name} storage`);
  return _storage;
}

// Exposed for the migration script + isolation tests (mirrors portfolioStorage).
export { watchlistKey };
