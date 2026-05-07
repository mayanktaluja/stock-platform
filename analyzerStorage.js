/**
 * Analyzer Storage Adapter — per-user "last upload" record
 *
 * Stores ONLY the holdings + metadata of the user's most recently uploaded
 * portfolio. The analysis report itself is NOT cached — every tab open
 * triggers a fresh rerun against current SWS data + live quotes (per the
 * "always-fresh" UX requirement).
 *
 * Two interchangeable backends (same pattern as portfolioStorage.js,
 * userStorage.js):
 *   1. FILE storage (local dev): JSON map at analyzer-last.json keyed by sub.
 *   2. VERCEL KV storage (prod): one key per user, `analyzer:last:{sub}`.
 *
 * Schema:
 *   {
 *     sub: "...",
 *     holdings: [{ symbol, name, quantity, avgPrice, sector, isin, purchaseDate }],
 *     mfHoldings: [...] | null,
 *     uploadedAt: "ISO-8601",
 *     sourceFile: "Groww_Holdings.xlsx" | null
 *   }
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYZER_PATH = path.join(__dirname, "analyzer-last.json");
const analyzerKey = (sub) => `analyzer:last:${sub}`;

// ── File adapter ──

class FileAnalyzerStorage {
  constructor() { this.name = "file"; }

  async _readAll() {
    if (!existsSync(ANALYZER_PATH)) return {};
    try { return JSON.parse(readFileSync(ANALYZER_PATH, "utf-8")); }
    catch { return {}; }
  }

  async _writeAll(map) {
    writeFileSync(ANALYZER_PATH, JSON.stringify(map, null, 2), "utf-8");
    return true;
  }

  async read(sub) {
    if (!sub) return null;
    const all = await this._readAll();
    return all[sub] || null;
  }

  async write(sub, data) {
    if (!sub) throw new Error("write: sub is required");
    const all = await this._readAll();
    all[sub] = { sub, ...data };
    await this._writeAll(all);
    return true;
  }
}

// ── Vercel KV adapter ──

class KVAnalyzerStorage {
  constructor() { this.name = "vercel-kv"; this._kv = null; }

  async _getKV() {
    if (this._kv) return this._kv;
    const mod = await import("@vercel/kv");
    this._kv = mod.kv;
    return this._kv;
  }

  async read(sub) {
    if (!sub) return null;
    try {
      const kv = await this._getKV();
      const data = await kv.get(analyzerKey(sub));
      if (!data) return null;
      return typeof data === "string" ? JSON.parse(data) : data;
    } catch (err) {
      console.warn("[ANALYZER:KV] read failed:", err.message);
      return null;
    }
  }

  async write(sub, data) {
    if (!sub) throw new Error("write: sub is required");
    try {
      const kv = await this._getKV();
      await kv.set(analyzerKey(sub), { sub, ...data });
      return true;
    } catch (err) {
      console.warn("[ANALYZER:KV] write failed:", err.message);
      return false;
    }
  }
}

// ── Adapter selection ──

let _storage = null;

export function getAnalyzerStorage() {
  if (_storage) return _storage;
  const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
  _storage = hasKV ? new KVAnalyzerStorage() : new FileAnalyzerStorage();
  console.log(`[ANALYZER] Using ${_storage.name} storage`);
  return _storage;
}
