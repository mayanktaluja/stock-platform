/**
 * Watchlist Storage Adapter
 *
 * Two interchangeable backends (same pattern as paperTradesStorage.js):
 *   1. FILE storage (local dev): JSON array at .watchlist.json
 *   2. VERCEL KV storage (prod): Redis hash at watchlist:items
 *
 * Auto-selects based on KV_REST_API_URL env var presence.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHLIST_PATH = path.join(__dirname, ".watchlist.json");
const KV_KEY = "watchlist:items";

// ── File adapter ──

class FileWatchlistStorage {
  constructor() { this.name = "file"; }

  async readAll() {
    if (!existsSync(WATCHLIST_PATH)) return [];
    try { return JSON.parse(readFileSync(WATCHLIST_PATH, "utf-8")); }
    catch { return []; }
  }

  async add(item) {
    const list = await this.readAll();
    if (list.some((s) => s.symbol === item.symbol)) return { action: "already_exists" };
    list.push(item);
    writeFileSync(WATCHLIST_PATH, JSON.stringify(list, null, 2), "utf-8");
    return { action: "added", count: list.length };
  }

  async remove(symbol) {
    const list = (await this.readAll()).filter((s) => s.symbol !== symbol);
    writeFileSync(WATCHLIST_PATH, JSON.stringify(list, null, 2), "utf-8");
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

  async readAll() {
    try {
      const kv = await this._getKV();
      const all = await kv.hgetall(KV_KEY);
      if (!all) return [];
      return Object.values(all).map((v) => typeof v === "string" ? JSON.parse(v) : v);
    } catch (err) {
      console.warn("[WATCHLIST:KV] readAll failed:", err.message);
      return [];
    }
  }

  async add(item) {
    try {
      const kv = await this._getKV();
      const existing = await kv.hget(KV_KEY, item.symbol);
      if (existing) return { action: "already_exists" };
      await kv.hset(KV_KEY, { [item.symbol]: JSON.stringify(item) });
      const count = await kv.hlen(KV_KEY);
      return { action: "added", count };
    } catch (err) {
      console.warn("[WATCHLIST:KV] add failed:", err.message);
      return { action: "error", error: err.message };
    }
  }

  async remove(symbol) {
    try {
      const kv = await this._getKV();
      await kv.hdel(KV_KEY, symbol);
      const count = await kv.hlen(KV_KEY);
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
