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
 *   async updateById(patches: Array<{id, ...fields}>): Promise<{updated, missing}>
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
const SEED_TRADES_PATH = path.join(__dirname, "data", "track-record", "paper-trades-seed.jsonl");

function readJsonlFile(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    console.warn(`[PAPERTRADES] read failed for ${filePath}:`, err.message);
    return [];
  }
}

function sortNewestFirst(trades) {
  return [...trades].sort((a, b) => String(b.snapshotAt || "").localeCompare(String(a.snapshotAt || "")));
}

function sortOldestFirst(trades) {
  return [...trades].sort((a, b) => String(a.snapshotAt || "").localeCompare(String(b.snapshotAt || "")));
}

function mergeById(baseTrades, overlayTrades) {
  const merged = new Map();
  for (const trade of Array.isArray(baseTrades) ? baseTrades : []) {
    if (trade?.id) merged.set(trade.id, trade);
  }
  for (const trade of Array.isArray(overlayTrades) ? overlayTrades : []) {
    if (trade?.id) merged.set(trade.id, trade);
  }
  return sortNewestFirst([...merged.values()]);
}

class FileStorage {
  constructor(filePath = TRADES_PATH) {
    this.name = "file";
    this.path = filePath;
  }

  async readAll() {
    return readJsonlFile(this.path);
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

  /**
   * Apply a list of `{ id, ...fields }` patches to existing trades. The JSONL
   * file isn't natively editable, so we rewrite the whole file with patches
   * merged in by id. O(n) write per call — fine while the file stays small.
   */
  async updateById(patches) {
    if (!Array.isArray(patches) || patches.length === 0) {
      return { updated: 0, missing: 0 };
    }
    const trades = await this.readAll();
    if (trades.length === 0) return { updated: 0, missing: patches.length };
    const patchById = new Map(patches.filter((p) => p && p.id).map((p) => [p.id, p]));
    let updated = 0;
    for (const t of trades) {
      const patch = patchById.get(t.id);
      if (!patch) continue;
      Object.assign(t, patch);
      updated++;
      patchById.delete(t.id);
    }
    if (updated === 0) return { updated: 0, missing: patches.length };
    const lines = trades.map((t) => JSON.stringify(t)).join("\n") + "\n";
    writeFileSync(this.path, lines, "utf-8");
    return { updated, missing: patchById.size };
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

class SeedStorage {
  constructor(seedPath = SEED_TRADES_PATH) {
    this.name = "seed";
    this.path = seedPath;
  }

  async readAll() {
    return readJsonlFile(this.path);
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
    const sorted = sortOldestFirst(trades);
    return {
      exists: true,
      lineCount: trades.length,
      sizeBytes: stats.size,
      oldest: sorted[0]?.snapshotAt || null,
      newest: sorted[sorted.length - 1]?.snapshotAt || null,
    };
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

  /**
   * Apply patches to existing entries by id. KV's sorted-set members are
   * the JSON blobs themselves, so we have to remove the old member and add
   * the patched one back at the same score (snapshotAt timestamp).
   */
  async updateById(patches) {
    if (!Array.isArray(patches) || patches.length === 0) {
      return { updated: 0, missing: 0 };
    }
    try {
      const kv = await this._getKV();
      const trades = await this.readAll();
      const patchById = new Map(patches.filter((p) => p && p.id).map((p) => [p.id, p]));
      let updated = 0;
      for (const t of trades) {
        const patch = patchById.get(t.id);
        if (!patch) continue;
        const oldBlob = JSON.stringify(t);
        const merged = { ...t, ...patch };
        const newBlob = JSON.stringify(merged);
        const score = new Date(merged.snapshotAt).getTime();
        await kv.zrem(KV_KEY, oldBlob);
        await kv.zadd(KV_KEY, { score, member: newBlob });
        updated++;
        patchById.delete(t.id);
      }
      return { updated, missing: patchById.size };
    } catch (err) {
      console.warn("[PAPERTRADES:KV] updateById failed:", err.message);
      return { updated: 0, missing: patches.length, error: err.message };
    }
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

class MergedPaperTradeStorage {
  constructor(overlayStorage, seedStorage = new SeedStorage()) {
    this.name = `${overlayStorage?.name || "unknown"}+seed`;
    this.overlay = overlayStorage;
    this.seed = seedStorage;
  }

  async _readParts() {
    const [seedTrades, overlayTrades] = await Promise.all([
      this.seed.readAll(),
      this.overlay.readAll(),
    ]);
    return { seedTrades, overlayTrades };
  }

  async readAll() {
    const { seedTrades, overlayTrades } = await this._readParts();
    return mergeById(seedTrades, overlayTrades);
  }

  async append(trades) {
    if (!Array.isArray(trades) || trades.length === 0) {
      return { written: 0, skipped: 0 };
    }
    const existing = await this.readAll();
    const existingIds = new Set(existing.map((t) => t.id));
    const newTrades = trades.filter((t) => t && !existingIds.has(t.id));
    if (newTrades.length === 0) {
      return { written: 0, skipped: trades.length };
    }
    const result = await this.overlay.append(newTrades);
    return {
      ...result,
      skipped: (trades.length - newTrades.length) + (result.skipped || 0),
    };
  }

  async updateById(patches) {
    if (!Array.isArray(patches) || patches.length === 0) {
      return { updated: 0, missing: 0 };
    }
    const merged = await this.readAll();
    const byId = new Map(merged.filter((t) => t?.id).map((t) => [t.id, t]));
    const fullRows = [];
    let missing = 0;
    for (const patch of patches) {
      if (!patch?.id) {
        missing++;
        continue;
      }
      const base = byId.get(patch.id);
      if (!base) {
        missing++;
        continue;
      }
      fullRows.push({ ...base, ...patch });
    }
    if (fullRows.length === 0) return { updated: 0, missing };

    // Overlay update handles rows already present in KV/file. Seed-only rows
    // are immutable, so any missed update is appended as the full merged row.
    const updateResult = await this.overlay.updateById(fullRows);
    const updated = updateResult.updated || 0;
    const updateMisses = updateResult.missing || 0;
    let appended = 0;
    if (updateMisses > 0) {
      const overlayTrades = await this.overlay.readAll();
      const overlayIds = new Set(overlayTrades.map((t) => t.id));
      const seedOnlyRows = fullRows.filter((row) => !overlayIds.has(row.id));
      if (seedOnlyRows.length > 0) {
        const appendResult = await this.overlay.append(seedOnlyRows);
        appended = appendResult.written || 0;
      }
    }
    return {
      updated: updated + appended,
      missing,
      overlayUpdated: updated,
      overlayInserted: appended,
      error: updateResult.error,
    };
  }

  async hasToday(type, todayKey) {
    const trades = await this.readAll();
    return trades.some((e) => e.dateKey === todayKey && e.type === type);
  }

  async getStats() {
    const [seedStats, overlayStats, allTrades] = await Promise.all([
      this.seed.getStats(),
      this.overlay.getStats(),
      this.readAll(),
    ]);
    const rawLineCount = (seedStats.lineCount || 0) + (overlayStats.lineCount || 0);
    if (allTrades.length === 0) {
      return {
        exists: seedStats.exists || overlayStats.exists,
        lineCount: 0,
        rawLineCount,
        seedLineCount: seedStats.lineCount || 0,
        overlayLineCount: overlayStats.lineCount || 0,
        sizeBytes: (seedStats.sizeBytes || 0) + (overlayStats.sizeBytes || 0),
        oldest: null,
        newest: null,
        seedOldest: seedStats.oldest || null,
        seedNewest: seedStats.newest || null,
        overlayOldest: overlayStats.oldest || null,
        overlayNewest: overlayStats.newest || null,
      };
    }
    const sorted = sortOldestFirst(allTrades);
    return {
      exists: true,
      lineCount: allTrades.length,
      rawLineCount,
      seedLineCount: seedStats.lineCount || 0,
      overlayLineCount: overlayStats.lineCount || 0,
      sizeBytes: (seedStats.sizeBytes || 0) + (overlayStats.sizeBytes || 0),
      oldest: sorted[0]?.snapshotAt || null,
      newest: sorted[sorted.length - 1]?.snapshotAt || null,
      seedOldest: seedStats.oldest || null,
      seedNewest: seedStats.newest || null,
      overlayOldest: overlayStats.oldest || null,
      overlayNewest: overlayStats.newest || null,
    };
  }

  async clear() {
    await this.overlay.clear();
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
    _storage = new MergedPaperTradeStorage(new VercelKVStorage());
    console.log("[PAPERTRADES] Using Vercel KV storage + deployed seed");
  } else {
    _storage = new MergedPaperTradeStorage(new FileStorage());
    console.log("[PAPERTRADES] Using local file storage + deployed seed");
  }
  return _storage;
}

/** Force a specific adapter for testing */
export function setStorage(storage) {
  _storage = storage;
}

export { FileStorage, MergedPaperTradeStorage, SeedStorage, VercelKVStorage, mergeById };
