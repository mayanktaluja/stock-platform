/**
 * User Storage Adapter
 *
 * Two interchangeable backends (same pattern as portfolioStorage.js,
 * watchlistStorage.js, paperTradesStorage.js):
 *   1. FILE storage (local dev): JSON map at users.json keyed by sub.
 *   2. VERCEL KV storage (prod): one key per user, `user:{sub}`.
 *
 * Auto-selects based on KV_REST_API_URL env var presence.
 *
 * Per-key (not single-hash) on KV so each lookup is O(1) and we never
 * load every user to read one. Cheap to scan later if we need an admin
 * list; but typical reads (auth/me) hit a single key.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_PATH = path.join(__dirname, "users.json");

const userKey = (sub) => `user:${sub}`;
const USER_KEY_PREFIX = "user:";

// Cap on per-user login history. We store the most recent N events inline on
// the user record so the admin drill-down can show "every visit" without an
// extra round-trip. Older events fall off — high-frequency users would
// otherwise bloat the record indefinitely.
const MAX_LOGIN_EVENTS = 50;

function parseAdminEmails() {
  const raw = process.env.ADMIN_EMAILS || "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function computeIsAdmin(email) {
  const list = parseAdminEmails();
  return !!email && list.includes(String(email).toLowerCase());
}

// ── File adapter ──

class FileUserStorage {
  constructor() { this.name = "file"; }

  async _readAll() {
    if (!existsSync(USERS_PATH)) return {};
    try { return JSON.parse(readFileSync(USERS_PATH, "utf-8")); }
    catch { return {}; }
  }

  async _writeAll(map) {
    writeFileSync(USERS_PATH, JSON.stringify(map, null, 2), "utf-8");
    return true;
  }

  async read(sub) {
    if (!sub) return null;
    const all = await this._readAll();
    return all[sub] || null;
  }

  async upsert(sub, payload) {
    if (!sub) throw new Error("upsert: sub is required");
    const all = await this._readAll();
    const existing = all[sub] || null;
    const now = Date.now();
    const event = { ts: now, ip: payload.ip || null, ua: payload.ua || null };
    const priorEvents = (existing && Array.isArray(existing.loginEvents)) ? existing.loginEvents : [];
    const merged = {
      sub,
      email: payload.email || (existing && existing.email) || "",
      name: payload.name || (existing && existing.name) || "",
      picture: payload.picture || (existing && existing.picture) || "",
      createdAt: existing && existing.createdAt ? existing.createdAt : now,
      lastLoginAt: now,
      isAdmin: computeIsAdmin(payload.email || (existing && existing.email)),
      loginEvents: [...priorEvents, event].slice(-MAX_LOGIN_EVENTS),
    };
    all[sub] = merged;
    await this._writeAll(all);
    return merged;
  }

  async list() {
    const all = await this._readAll();
    return Object.values(all);
  }
}

// ── Vercel KV adapter ──

class KVUserStorage {
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
      const data = await kv.get(userKey(sub));
      if (!data) return null;
      return typeof data === "string" ? JSON.parse(data) : data;
    } catch (err) {
      console.warn("[USER:KV] read failed:", err.message);
      return null;
    }
  }

  async upsert(sub, payload) {
    if (!sub) throw new Error("upsert: sub is required");
    const existing = await this.read(sub);
    const now = Date.now();
    const event = { ts: now, ip: payload.ip || null, ua: payload.ua || null };
    const priorEvents = (existing && Array.isArray(existing.loginEvents)) ? existing.loginEvents : [];
    const merged = {
      sub,
      email: payload.email || (existing && existing.email) || "",
      name: payload.name || (existing && existing.name) || "",
      picture: payload.picture || (existing && existing.picture) || "",
      createdAt: existing && existing.createdAt ? existing.createdAt : now,
      lastLoginAt: now,
      isAdmin: computeIsAdmin(payload.email || (existing && existing.email)),
      loginEvents: [...priorEvents, event].slice(-MAX_LOGIN_EVENTS),
    };
    try {
      const kv = await this._getKV();
      await kv.set(userKey(sub), merged);
    } catch (err) {
      console.warn("[USER:KV] write failed:", err.message);
    }
    return merged;
  }

  async list() {
    try {
      const kv = await this._getKV();
      const keys = await kv.keys(`${USER_KEY_PREFIX}*`);
      if (!keys.length) return [];
      const records = await Promise.all(keys.map((k) => kv.get(k)));
      return records
        .filter(Boolean)
        .map((r) => (typeof r === "string" ? JSON.parse(r) : r));
    } catch (err) {
      console.warn("[USER:KV] list failed:", err.message);
      return [];
    }
  }
}

// ── Adapter selection ──

let _storage = null;

export function getUserStorage() {
  if (_storage) return _storage;
  const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
  _storage = hasKV ? new KVUserStorage() : new FileUserStorage();
  console.log(`[USER] Using ${_storage.name} storage`);
  return _storage;
}
