/**
 * Recommendation Ledger Storage Adapter — per-user append-only event log
 *
 * The ledger is the source of truth for the lifecycle of every recommendation
 * the analyzer has emitted for a user. Each rec is identified by a stable
 * recId; the rec's "current state" is derived by reducing the events whose
 * recId matches. Storage NEVER mutates a past event.
 *
 * Append-only design avoids the two-tab race that would corrupt a mutable
 * record list (Vercel KV has no transactions). Two browsers running
 * concurrent reconciles on the same user produce additive event streams
 * that converge on the same state.
 *
 * Two interchangeable backends (mirrors analyzerStorage.js):
 *   1. FILE storage (local dev): JSON map at recommendation-ledger.json keyed by sub.
 *   2. VERCEL KV storage (prod):  one key per user, `recommendation-ledger:{sub}`.
 *
 * Schema:
 *   {
 *     sub: "...",
 *     schemaVersion: 1,
 *     events: [LedgerEvent],   // chronological (oldest-first)
 *   }
 *
 *   LedgerEvent (discriminated union; see plan for full field list):
 *     | { type: "ISSUED",                  recId, at, symbol, isin, action,
 *                                          reductionPct?, addPct?, severity?,
 *                                          trimRupees?, topUpRupees?, factors,
 *                                          reasoning?, sourceSnapshot,
 *                                          qtyAtIssue, weightAtIssue?, scoreAtIssue?,
 *                                          convictionAtIssue?, surveillanceAtIssue?,
 *                                          bypassReason? }
 *     | { type: "EXECUTED",                recId, at, ratio, qtyDelta, sourceSnapshot,
 *                                          actionAtExecution?, severityAtExecution?,
 *                                          scoreAtExecution?, factorsAtExecution?,
 *                                          convictionAtExecution?, surveillanceAtExecution? }
 *     | { type: "EXECUTED_PARTIAL",        recId, at, ratio, qtyDelta, remainingPct, sourceSnapshot,
 *                                          actionAtExecution?, severityAtExecution?,
 *                                          scoreAtExecution?, factorsAtExecution?,
 *                                          convictionAtExecution?, surveillanceAtExecution? }
 *     | { type: "EXECUTED_OVER",           recId, at, ratio, qtyDelta, sourceSnapshot,
 *                                          actionAtExecution?, severityAtExecution?,
 *                                          scoreAtExecution?, factorsAtExecution?,
 *                                          convictionAtExecution?, surveillanceAtExecution? }
 *     | { type: "SUPERSEDED",              recId, at, bySupersedingRecId, reason, sourceSnapshot }
 *     | { type: "RESOLVED_NATURAL",        recId, at, reason, sourceSnapshot }
 *     | { type: "RESOLVED_THESIS_INVERTED",recId, at, scoreDelta, sourceSnapshot }
 *     | { type: "RESOLVED_NO_DATA",        recId, at, consecutiveNoDataCount, sourceSnapshot }
 *     | { type: "ORPHANED",                recId, at, reason, sourceSnapshot }
 *
 * Eviction: events older than LEDGER_TTL_MONTHS may be dropped, but ONLY
 * when their recId's terminal state is closed. Open recs (PENDING /
 * EXECUTED_PARTIAL) are never evicted regardless of age — they are still
 * the source of suppression on the live UI.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = path.join(__dirname, "recommendation-ledger.json");
const ledgerKey = (sub) => `recommendation-ledger:${sub}`;

export const LEDGER_SCHEMA_VERSION = 1;
export const LEDGER_TTL_MONTHS = 24;

const TERMINAL_TYPES = new Set([
  "EXECUTED",
  "EXECUTED_OVER",
  "SUPERSEDED",
  "RESOLVED_NATURAL",
  "RESOLVED_THESIS_INVERTED",
  "RESOLVED_NO_DATA",
  "ORPHANED",
]);

const EMPTY = () => ({ events: [], schemaVersion: LEDGER_SCHEMA_VERSION });

function recIdLastType(events, recId) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].recId === recId) return events[i].type;
  }
  return null;
}

export function isClosedTerminal(type) {
  return TERMINAL_TYPES.has(type);
}

export function evictExpiredClosedEvents(events, now = new Date(), ttlMonths = LEDGER_TTL_MONTHS) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - ttlMonths);
  const cutoffIso = cutoff.toISOString();

  const closedRecIds = new Set();
  for (const e of events) {
    if (TERMINAL_TYPES.has(e.type)) closedRecIds.add(e.recId);
  }
  return events.filter((e) => {
    if (e.at >= cutoffIso) return true;
    if (!closedRecIds.has(e.recId)) return true;
    return false;
  });
}

class FileRecommendationLedgerStorage {
  constructor() { this.name = "file"; }

  async _readAll() {
    if (!existsSync(LEDGER_PATH)) return {};
    try { return JSON.parse(readFileSync(LEDGER_PATH, "utf-8")); }
    catch (err) {
      console.error("[LEDGER:FILE] parse error — treating as empty (no overwrite):", err.message);
      return {};
    }
  }

  async _writeAll(map) {
    writeFileSync(LEDGER_PATH, JSON.stringify(map, null, 2), "utf-8");
    return true;
  }

  async read(sub) {
    if (!sub) return { sub: null, ...EMPTY() };
    const all = await this._readAll();
    const entry = all[sub];
    if (!entry) return { sub, ...EMPTY() };
    return {
      sub,
      schemaVersion: entry.schemaVersion || LEDGER_SCHEMA_VERSION,
      events: Array.isArray(entry.events) ? entry.events : [],
    };
  }

  async appendEvents(sub, newEvents) {
    if (!sub) throw new Error("appendEvents: sub is required");
    if (!Array.isArray(newEvents) || newEvents.length === 0) {
      return { appended: 0, total: null };
    }
    const all = await this._readAll();
    const cur = all[sub] || EMPTY();
    const events = Array.isArray(cur.events) ? [...cur.events] : [];

    let appended = 0;
    for (const e of newEvents) {
      if (!e || !e.type || !e.recId || !e.at) {
        console.warn("[LEDGER] skipping malformed event:", e);
        continue;
      }
      // ISSUED idempotency: if the same recId was already ISSUED and is
      // still open or closed, do not append a duplicate ISSUED.
      if (e.type === "ISSUED") {
        const lastType = recIdLastType(events, e.recId);
        if (lastType === "ISSUED" || lastType === "EXECUTED_PARTIAL") continue;
        if (lastType !== null && TERMINAL_TYPES.has(lastType)) continue;
      }
      events.push(e);
      appended += 1;
    }

    const evicted = evictExpiredClosedEvents(events);
    all[sub] = { schemaVersion: LEDGER_SCHEMA_VERSION, events: evicted };
    await this._writeAll(all);
    return { appended, total: evicted.length };
  }
}

class KVRecommendationLedgerStorage {
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
      const data = await kv.get(ledgerKey(sub));
      if (!data) return { sub, ...EMPTY() };
      const parsed = typeof data === "string" ? JSON.parse(data) : data;
      return {
        sub,
        schemaVersion: parsed.schemaVersion || LEDGER_SCHEMA_VERSION,
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch (err) {
      console.warn("[LEDGER:KV] read failed:", err.message);
      return { sub, ...EMPTY() };
    }
  }

  async appendEvents(sub, newEvents) {
    if (!sub) throw new Error("appendEvents: sub is required");
    if (!Array.isArray(newEvents) || newEvents.length === 0) {
      return { appended: 0, total: null };
    }
    try {
      const cur = await this.read(sub);
      const events = [...cur.events];
      let appended = 0;
      for (const e of newEvents) {
        if (!e || !e.type || !e.recId || !e.at) continue;
        if (e.type === "ISSUED") {
          const lastType = recIdLastType(events, e.recId);
          if (lastType === "ISSUED" || lastType === "EXECUTED_PARTIAL") continue;
          if (lastType !== null && TERMINAL_TYPES.has(lastType)) continue;
        }
        events.push(e);
        appended += 1;
      }
      const evicted = evictExpiredClosedEvents(events);
      const kv = await this._getKV();
      await kv.set(ledgerKey(sub), { schemaVersion: LEDGER_SCHEMA_VERSION, events: evicted });
      return { appended, total: evicted.length };
    } catch (err) {
      console.warn("[LEDGER:KV] append failed:", err.message);
      return { appended: 0, total: null };
    }
  }
}

let _storage = null;

export function getRecommendationLedgerStorage() {
  if (_storage) return _storage;
  const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
  _storage = hasKV ? new KVRecommendationLedgerStorage() : new FileRecommendationLedgerStorage();
  console.log(`[LEDGER] Using ${_storage.name} storage`);
  return _storage;
}

export function _resetForTests() {
  _storage = null;
}
