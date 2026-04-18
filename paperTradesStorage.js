/**
 * Paper-Trade Storage Adapter
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two interchangeable backends for the paper-trade tracker:
 *
 *   1. FILE storage (local dev):   JSONL append-only file at .paper-trades.json
 *   2. VERCEL KV storage (prod):   sorted set keyed by snapshot timestamp
 *
 * The right backend is auto-selected at startup based on whether the
 * KV_REST_API_URL environment variable is set. Local development without KV
 * env vars uses the file adapter (unchanged behavior). Vercel production with
 * KV provisioned uses the KV adapter (true persistence).
 *
 * WHY TWO BACKENDS:
 *   - File storage is simple, synchronous, zero network — perfect for local dev
 *   - Vercel serverless filesystem is read-only outside /tmp, and /tmp is
 *     wiped between cold starts. A write-anywhere storage like KV is the only
 *     way the tracker can accumulate data across serverless invocations.
 *
 * BOTH backends implement the same async interface:
 *   async readAll(): Promise<Trade[]>           — all trades, newest-first
 *   async append(trades: Trade[]): Promise<{written, skipped}>
 *   async hasToday(type: string): Promise<boolean>
 *   async getStats(): Promise<{exists, lineCount, oldest, newest}>
 *   async clear(): Promise<void>                — wipes all trades (dev only)
 *
 * Trade shape (see paperTrades.js buildTradeEntry):
 *   { id, dateKey, type, symbol, name, sector, snapshotAt, priceAtSnapshot,
 *     niftyAtSnapshot, scoreAtSnapshot, macroBoostAtSnapshot, ... }
 *
 * The `id` field is a stable SHA-256 hash of (dateKey, type, symbol) so
 * dedupe checks are cheap across both backends.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, statSync, unlinkSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────── File adapter ───────────────────────────────

const TRADES_PATH = path.join(__dirname, ".paper-trades.json");

class FileStorage {
  constructor() {
    this.name = "file";
    this.path = TRADES_PATH;
  }

  async readAll() {
    if (!existsSync(this.path)) return [];
    try {
      const raw = readFileSync(this.path, "utf-8");
      return raw
        .split("\n")
        .filter((l) => l.trim())
        .map((line) => {
          try { return JSON.parse(line); }
          catch { return null; }
        })
        .filter(Boolean);
    } catch (err) {
      console.warn("[PAPERTRADES:FILE] Read failed:", err.message);
      return [];
    }
  }

  async append(trades) {
    if (!Array.isArray(trades) || trades.length === 0) {
      return { written: 0, skipped: 0 };
    }
    // Dedup against existing IDs before writing — same-day re-runs of a
    // scanner should not produce duplicate rows.
    const existing = await this.readAll();
    const existingIds = new Set(existing.map((t) => t.id));
    const newTrades = trades.filter((t) => t && !existingIds.has(t.id));
    if (newTrades.length === 0) {
      return { written: 0, skipped: trades.length };
    }
    const lines = newTrades.map((e) => JSON.stringify(e)).join("\n") + "\n";
    appendFileSync(this.path, lines, "utf-8");
    return { written: newTrades.length, skipped: trades.length - newTrades.length };
  }

  async hasToday(type, todayKey) {
    const trades = await this.readAll();
    return trades.some((e) => e.dateKey === todayKey && e.type === type);
  }

  async getStats() {
    if (!existsSync(this.path)) {
      return { exists: false, lineCount: 0, sizeBytes: 0, oldest: null, newest: null };
    }
    const stats = statSync(this.path);
    const trades = await this.readAll();
    if (trades.length === 0) {
      return { exists: true, lineCount: 0, sizeBytes: stats.size, oldest: null, newest: null };
    }
    const sorted = [...trades].sort((a, b) => a.snapshotAt.localeCompare(b.snapshotAt));
    return {
      exists: true,
      lineCount: trades.length,
      sizeBytes: stats.size,
      oldest: sorted[0].snapshotAt,
      newest: sorted[sorted.length - 1].snapshotAt,
    };
  }

  async clear() {
    if (existsSync(this.path)) unlinkSync(this.path);
  }
}

// ────────────────────────────── Vercel KV adapter ──────────────────────────

/**
 * KV storage uses a single Redis sorted set. Each trade is stored with its
 * snapshot timestamp (ms since epoch) as the score, and the JSON blob as
 * the member.
 *
 *   ZADD paper_trades {timestamp} {jsonBlob}
 *   ZRANGE paper_trades 0 -1 REV        -> all trades newest first
 *   ZRANGEBYSCORE paper_trades min max  -> filter by date range
 *   ZCARD paper_trades                  -> total count
 *
 * Dedup is handled by checking against existing IDs in the set before insert.
 * Redis ZADD with `nx` doesn't help because the member is the full JSON blob,
 * not the ID — two blobs with the same ID but different timestamps would
 * both appear. Instead we fetch existing trades for today and filter client-side.
 *
 * For a tracker with ~30 writes/day and ~5 reads/day, this is well within
 * the free-tier 30k commands/day budget (~1,000 commands/day worst case).
 */

const KV_KEY = "paper_trades";

class VercelKVStorage {
  constructor() {
    this.name = "vercel-kv";
    this._kv = null; // lazy
  }

  async _getKV() {
    if (this._kv) return this._kv;
    // Lazy import so the file adapter works in environments where
    // @vercel/kv isn't available (e.g. tests without env vars).
    const mod = await import("@vercel/kv");
    this._kv = mod.kv;
    return this._kv;
  }

  async readAll() {
    try {
      const kv = await this._getKV();
      // ZRANGE with rev: true returns newest first
      const members = await kv.zrange(KV_KEY, 0, -1, { rev: true });
      if (!members || members.length === 0) return [];
      // @vercel/kv auto-parses JSON when members were stored as objects
      return members
        .map((m) => (typeof m === "string" ? safeParse(m) : m))
        .filter(Boolean);
    } catch (err) {
      console.warn("[PAPERTRADES:KV] readAll failed:", err.message);
      return [];
    }
  }

  async append(trades) {
    if (!Array.isArray(trades) || trades.length === 0) {
      return { written: 0, skipped: 0 };
    }
    try {
      const kv = await this._getKV();
      // Fetch today's existing trades for dedup. A full ZRANGE is wasteful
      // once we have months of history — but for now it's still cheap
      // (~30 reads, ~10ms total). If the set grows past ~1000 entries, we
      // can switch to an ID-keyed SET for O(1) membership checks.
      const existing = await this.readAll();
      const existingIds = new Set(existing.map((t) => t.id));
      const newTrades = trades.filter((t) => t && !existingIds.has(t.id));
      if (newTrades.length === 0) {
        return { written: 0, skipped: trades.length };
      }
      // ZADD multiple members — timestamp as score (ms since epoch)
      const zaddArgs = newTrades.map((t) => ({
        score: new Date(t.snapshotAt).getTime(),
        member: JSON.stringify(t),
      }));
      for (const arg of zaddArgs) {
        await kv.zadd(KV_KEY, arg);
      }
      return { written: newTrades.length, skipped: trades.length - newTrades.length };
    } catch (err) {
      console.warn("[PAPERTRADES:KV] append failed:", err.message);
      return { written: 0, skipped: trades.length, error: err.message };
    }
  }

  async hasToday(type, todayKey) {
    const trades = await this.readAll();
    return trades.some((e) => e.dateKey === todayKey && e.type === type);
  }

  async getStats() {
    try {
      const kv = await this._getKV();
      const count = await kv.zcard(KV_KEY);
      if (!count || count === 0) {
        return { exists: false, lineCount: 0, sizeBytes: 0, oldest: null, newest: null };
      }
      // Get the lowest and highest score to determine date range
      const [newestBlob] = await kv.zrange(KV_KEY, 0, 0, { rev: true });
      const [oldestBlob] = await kv.zrange(KV_KEY, 0, 0, { rev: false });
      const parseAt = (b) => {
        const p = typeof b === "string" ? safeParse(b) : b;
        return p?.snapshotAt || null;
      };
      return {
        exists: true,
        lineCount: count,
        sizeBytes: null, // KV doesn't report byte count cheaply
        oldest: parseAt(oldestBlob),
        newest: parseAt(newestBlob),
      };
    } catch (err) {
      console.warn("[PAPERTRADES:KV] getStats failed:", err.message);
      return { exists: false, lineCount: 0, error: err.message };
    }
  }

  async clear() {
    try {
      const kv = await this._getKV();
      await kv.del(KV_KEY);
    } catch (err) {
      console.warn("[PAPERTRADES:KV] clear failed:", err.message);
    }
  }
}

function safeParse(str) {
  try { return JSON.parse(str); }
  catch { return null; }
}

// ─────────────────────────── Adapter selection ───────────────────────────

/**
 * Pick the right storage backend at startup:
 *   - If KV_REST_API_URL is set → Vercel KV (production path)
 *   - Otherwise                  → File storage (local dev path)
 *
 * The selection is logged once so it's clear which backend is active.
 * A single-process singleton — both adapters are stateless aside from the
 * lazy KV client, so sharing is safe.
 */

let _storage = null;

export function getStorage() {
  if (_storage) return _storage;
  const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
  if (hasKV) {
    _storage = new VercelKVStorage();
    console.log("[PAPERTRADES] Using Vercel KV storage (persistent)");
  } else {
    _storage = new FileStorage();
    console.log("[PAPERTRADES] Using local file storage (.paper-trades.json)");
  }
  return _storage;
}

/** Force a specific adapter for testing */
export function setStorage(storage) {
  _storage = storage;
}

export { FileStorage, VercelKVStorage };
