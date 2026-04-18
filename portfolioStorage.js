/**
 * Portfolio Storage Adapter
 *
 * Two interchangeable backends (same pattern as watchlistStorage.js,
 * paperTradesStorage.js):
 *   1. FILE storage (local dev): JSON object at portfolio.json
 *   2. VERCEL KV storage (prod): single key `portfolio:data`
 *
 * Auto-selects based on KV_REST_API_URL env var presence.
 *
 * WHY THIS EXISTS: the previous code wrote portfolio.json directly to disk.
 * On Vercel the filesystem is read-only, so every `POST /api/portfolio` in
 * production silently dropped the payload and the next import was lost.
 * This adapter routes writes to Vercel KV in production, keeping dev/disk
 * behaviour unchanged.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTFOLIO_PATH = path.join(__dirname, "portfolio.json");
const KV_KEY = "portfolio:data";

const EMPTY = { stocks: [], mutualFunds: [], lastUpdated: null };

// ── File adapter ──

class FilePortfolioStorage {
  constructor() { this.name = "file"; }

  async read() {
    if (!existsSync(PORTFOLIO_PATH)) return { ...EMPTY };
    try { return JSON.parse(readFileSync(PORTFOLIO_PATH, "utf-8")); }
    catch { return { ...EMPTY }; }
  }

  async write(data) {
    writeFileSync(PORTFOLIO_PATH, JSON.stringify(data, null, 2), "utf-8");
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

  async read() {
    try {
      const kv = await this._getKV();
      const data = await kv.get(KV_KEY);
      if (!data) return { ...EMPTY };
      return typeof data === "string" ? JSON.parse(data) : data;
    } catch (err) {
      console.warn("[PORTFOLIO:KV] read failed:", err.message);
      return { ...EMPTY };
    }
  }

  async write(data) {
    try {
      const kv = await this._getKV();
      await kv.set(KV_KEY, data);
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
