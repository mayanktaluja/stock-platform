/**
 * Portfolio Storage Adapter — per-user
 *
 * Two interchangeable backends (same pattern as userStorage.js,
 * watchlistStorage.js, paperTradesStorage.js):
 *   1. FILE storage (local dev): JSON map at portfolios.json keyed by sub.
 *   2. VERCEL KV storage (prod): one key per user, `portfolio:data:{sub}`.
 *
 * Auto-selects based on KV_REST_API_URL env var presence.
 *
 * Per-key (not single-hash) on KV so each lookup is O(1) and we never
 * load every user to read one. The signature requires `sub` on every
 * call — the caller is responsible for sourcing it from req.user.sub.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTFOLIOS_PATH = path.join(__dirname, "portfolios.json");
const portfolioKey = (sub) => `portfolio:data:${sub}`;

const EMPTY = { stocks: [], mutualFunds: [], lastUpdated: null };

// ── File adapter ──

class FilePortfolioStorage {
  constructor() { this.name = "file"; }

  async _readAll() {
    if (!existsSync(PORTFOLIOS_PATH)) return {};
    try { return JSON.parse(readFileSync(PORTFOLIOS_PATH, "utf-8")); }
    catch { return {}; }
  }

  async _writeAll(map) {
    writeFileSync(PORTFOLIOS_PATH, JSON.stringify(map, null, 2), "utf-8");
    return true;
  }

  async read(sub) {
    if (!sub) return { ...EMPTY };
    const all = await this._readAll();
    return all[sub] || { ...EMPTY };
  }

  async write(sub, data) {
    if (!sub) throw new Error("write: sub is required");
    const all = await this._readAll();
    all[sub] = data;
    await this._writeAll(all);
    return true;
  }
}

// ── Vercel KV adapter ──

class KVPortfolioStorage {
  constructor() { this.name = "vercel-kv"; this._kv = null; }

  async _getKV() {
    if (this._kv) return this._kv;
    const mod = await import("@vercel/kv");
    this._kv = mod.kv;
    return this._kv;
  }

  async read(sub) {
    if (!sub) return { ...EMPTY };
    try {
      const kv = await this._getKV();
      const data = await kv.get(portfolioKey(sub));
      if (!data) return { ...EMPTY };
      return typeof data === "string" ? JSON.parse(data) : data;
    } catch (err) {
      console.warn("[PORTFOLIO:KV] read failed:", err.message);
      return { ...EMPTY };
    }
  }

  async write(sub, data) {
    if (!sub) throw new Error("write: sub is required");
    try {
      const kv = await this._getKV();
      await kv.set(portfolioKey(sub), data);
      return true;
    } catch (err) {
      console.warn("[PORTFOLIO:KV] write failed:", err.message);
      return false;
    }
  }
}

// ── Adapter selection ──

let _storage = null;

export function getPortfolioStorage() {
  if (_storage) return _storage;
  const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
  _storage = hasKV ? new KVPortfolioStorage() : new FilePortfolioStorage();
  console.log(`[PORTFOLIO] Using ${_storage.name} storage`);
  return _storage;
}
