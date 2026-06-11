import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = path.join(__dirname, "sws-input-alert-ledger.json");
const ledgerKey = (sub) => `sws-input-alert-ledger:${sub}`;
const SCHEMA_VERSION = 1;

export function swsInputAlertEventId({ sub, run_id, digest, type }) {
  return createHash("sha256")
    .update([sub, run_id, digest, type].map((v) => String(v || "")).join("|"))
    .digest("hex")
    .slice(0, 24);
}

function empty(sub) {
  return { sub, schemaVersion: SCHEMA_VERSION, events: [] };
}

function normalizeEntry(sub, entry) {
  if (!entry) return empty(sub);
  return {
    sub,
    schemaVersion: entry.schemaVersion || SCHEMA_VERSION,
    events: Array.isArray(entry.events) ? entry.events : [],
  };
}

class FileSwsInputAlertLedgerStorage {
  constructor() { this.name = "file"; }

  async _readAll() {
    if (!existsSync(LEDGER_PATH)) return {};
    try { return JSON.parse(readFileSync(LEDGER_PATH, "utf-8")); }
    catch { return {}; }
  }

  async _writeAll(map) {
    writeFileSync(LEDGER_PATH, JSON.stringify(map, null, 2) + "\n", "utf-8");
    return true;
  }

  async read(sub) {
    if (!sub) return empty(null);
    return normalizeEntry(sub, (await this._readAll())[sub]);
  }

  async appendEvents(sub, newEvents) {
    if (!sub) throw new Error("appendEvents: sub is required");
    const all = await this._readAll();
    const cur = normalizeEntry(sub, all[sub]);
    const ids = new Set(cur.events.map((e) => e.id).filter(Boolean));
    let appended = 0;
    for (const event of Array.isArray(newEvents) ? newEvents : []) {
      if (!event?.type || !event?.run_id || !event?.digest) continue;
      const id = event.id || swsInputAlertEventId({ ...event, sub });
      if (ids.has(id)) continue;
      ids.add(id);
      cur.events.push({ ...event, id, sub, at: event.at || new Date().toISOString() });
      appended++;
    }
    all[sub] = { schemaVersion: SCHEMA_VERSION, events: cur.events.slice(-500) };
    await this._writeAll(all);
    return { appended, total: all[sub].events.length };
  }

  async hasEvent(sub, { type, run_id, digest }) {
    const entry = await this.read(sub);
    return entry.events.some((e) => e.type === type && e.run_id === run_id && e.digest === digest);
  }

  async hasEmailSentForRun(sub, run_id) {
    if (!run_id) return false;
    const entry = await this.read(sub);
    return entry.events.some((e) => e.type === "EMAIL_SENT" && e.run_id === run_id);
  }
}

class KVSwsInputAlertLedgerStorage {
  constructor() { this.name = "vercel-kv"; this._kv = null; }

  async _getKV() {
    if (this._kv) return this._kv;
    const mod = await import("@vercel/kv");
    this._kv = mod.kv;
    return this._kv;
  }

  async read(sub) {
    if (!sub) return empty(null);
    try {
      const kv = await this._getKV();
      const data = await kv.get(ledgerKey(sub));
      return normalizeEntry(sub, typeof data === "string" ? JSON.parse(data) : data);
    } catch (err) {
      console.warn("[SWS-INPUT-ALERT-LEDGER:KV] read failed:", err.message);
      return empty(sub);
    }
  }

  async appendEvents(sub, newEvents) {
    if (!sub) throw new Error("appendEvents: sub is required");
    const cur = await this.read(sub);
    const ids = new Set(cur.events.map((e) => e.id).filter(Boolean));
    let appended = 0;
    for (const event of Array.isArray(newEvents) ? newEvents : []) {
      if (!event?.type || !event?.run_id || !event?.digest) continue;
      const id = event.id || swsInputAlertEventId({ ...event, sub });
      if (ids.has(id)) continue;
      ids.add(id);
      cur.events.push({ ...event, id, sub, at: event.at || new Date().toISOString() });
      appended++;
    }
    try {
      const kv = await this._getKV();
      await kv.set(ledgerKey(sub), { schemaVersion: SCHEMA_VERSION, events: cur.events.slice(-500) });
    } catch (err) {
      console.warn("[SWS-INPUT-ALERT-LEDGER:KV] write failed:", err.message);
    }
    return { appended, total: cur.events.length };
  }

  async hasEvent(sub, criteria) {
    const entry = await this.read(sub);
    return entry.events.some((e) => e.type === criteria.type && e.run_id === criteria.run_id && e.digest === criteria.digest);
  }

  async hasEmailSentForRun(sub, run_id) {
    if (!run_id) return false;
    const entry = await this.read(sub);
    return entry.events.some((e) => e.type === "EMAIL_SENT" && e.run_id === run_id);
  }
}

let _storage = null;
export function getSwsInputAlertLedgerStorage() {
  if (_storage) return _storage;
  const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
  _storage = hasKV ? new KVSwsInputAlertLedgerStorage() : new FileSwsInputAlertLedgerStorage();
  console.log(`[SWS-INPUT-ALERT-LEDGER] Using ${_storage.name} storage`);
  return _storage;
}
