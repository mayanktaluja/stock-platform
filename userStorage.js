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
const ADMIN_EMAIL = "mthaluja11@gmail.com";

// Cap on per-user login history. We store the most recent N events inline on
// the user record so the admin drill-down can show "every visit" without an
// extra round-trip. Older events fall off — high-frequency users would
// otherwise bloat the record indefinitely.
const MAX_LOGIN_EVENTS = 50;

// A "session" ends after this much inactivity. Next authenticated request
// after the gap counts as a new session. 30 min matches Google Analytics
// default and our intuition for "they came back to use the platform".
const SESSION_GAP_MS = 30 * 60 * 1000;

// Skip the touch() write if lastSeenAt was bumped within this window.
// Keeps the gate middleware cheap — most authenticated requests don't
// hit storage. New sessions still write because gap > SESSION_GAP_MS
// implies gap > TOUCH_DEBOUNCE_MS.
const TOUCH_DEBOUNCE_MS = 5 * 60 * 1000;

// Migration helper. Old records (pre-session-tracking) have no sessionCount;
// seed it from loginEvents.length so the column shows something useful right
// away rather than 0 for every existing user.
function _seedSessionCount(existing) {
  if (existing && typeof existing.sessionCount === "number") return existing.sessionCount;
  if (existing && Array.isArray(existing.loginEvents)) return existing.loginEvents.length;
  return 0;
}

// Shared merge for the OAuth-callback path. A login is by definition a new
// session, so sessionCount always +1 here.
function _mergeOnLogin(existing, sub, payload, now) {
  const event = { ts: now, ip: payload.ip || null, ua: payload.ua || null };
  const priorEvents = (existing && Array.isArray(existing.loginEvents)) ? existing.loginEvents : [];
  return {
    sub,
    email: payload.email || (existing && existing.email) || "",
    name: payload.name || (existing && existing.name) || "",
    picture: payload.picture || (existing && existing.picture) || "",
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
    lastLoginAt: now,
    lastSeenAt: now,
    sessionCount: _seedSessionCount(existing) + 1,
    isAdmin: computeIsAdmin(payload.email || (existing && existing.email)),
    loginEvents: [...priorEvents, event].slice(-MAX_LOGIN_EVENTS),
  };
}

// Shared logic for the heartbeat (touch) path. Returns { write, record }:
//   - write=false if the touch is debounced (existing returned unchanged).
//   - write=true with the updated record otherwise — sessionCount bumps
//     only when gap > SESSION_GAP_MS.
function _computeTouch(existing, now) {
  if (!existing) return { write: false, record: null };
  const lastSeenAt = existing.lastSeenAt || existing.lastLoginAt || 0;
  const gap = now - lastSeenAt;
  if (gap < TOUCH_DEBOUNCE_MS) return { write: false, record: existing };
  const isNewSession = gap > SESSION_GAP_MS;
  return {
    write: true,
    record: {
      ...existing,
      lastSeenAt: now,
      sessionCount: _seedSessionCount(existing) + (isNewSession ? 1 : 0),
    },
  };
}

// Exported so server-side authorization sites can recompute admin status from
// the canonical owner email on every request, rather than trusting the
// persisted `isAdmin` flag (which only updates at login).
export function computeIsAdmin(email) {
  return String(email || "").trim().toLowerCase() === ADMIN_EMAIL;
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
    const merged = _mergeOnLogin(all[sub] || null, sub, payload, Date.now());
    all[sub] = merged;
    await this._writeAll(all);
    return merged;
  }

  async touch(sub) {
    if (!sub) return null;
    const all = await this._readAll();
    const { write, record } = _computeTouch(all[sub] || null, Date.now());
    if (!write) return record;
    all[sub] = record;
    await this._writeAll(all);
    return record;
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
    const merged = _mergeOnLogin(existing, sub, payload, Date.now());
    try {
      const kv = await this._getKV();
      await kv.set(userKey(sub), merged);
    } catch (err) {
      console.warn("[USER:KV] write failed:", err.message);
    }
    return merged;
  }

  async touch(sub) {
    if (!sub) return null;
    const existing = await this.read(sub);
    const { write, record } = _computeTouch(existing, Date.now());
    if (!write) return record;
    try {
      const kv = await this._getKV();
      await kv.set(userKey(sub), record);
    } catch (err) {
      console.warn("[USER:KV] touch write failed:", err.message);
    }
    return record;
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
