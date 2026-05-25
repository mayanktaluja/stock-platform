/**
 * Storage adapter for daily SWS section-performance rows.
 *
 * Local/dev writes JSONL to .section-performance.jsonl in the repo root.
 * Production uses Vercel KV when KV_REST_API_URL is configured. Both adapters
 * expose the same async row API and dedupe by stable row id.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

export const SECTION_PERFORMANCE_LOCAL_PATH = path.join(ROOT, ".section-performance.jsonl");
export const SECTION_PERFORMANCE_KV_KEY = "track_section_performance_v1";

function safeParse(line) {
  try { return JSON.parse(line); }
  catch { return null; }
}

function normaliseRows(rows) {
  return (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
}

function sortRowsNewestFirst(rows) {
  return [...rows].sort((a, b) => {
    const aTime = a.snapshotAt || a.dateKey || "";
    const bTime = b.snapshotAt || b.dateKey || "";
    return String(bTime).localeCompare(String(aTime));
  });
}

export class FileSectionPerformanceStorage {
  constructor(opts = {}) {
    this.name = "file";
    this.path = opts.path || SECTION_PERFORMANCE_LOCAL_PATH;
  }

  async readAll() {
    if (!existsSync(this.path)) return [];
    try {
      const raw = readFileSync(this.path, "utf8");
      return sortRowsNewestFirst(
        raw
          .split("\n")
          .filter((line) => line.trim())
          .map(safeParse)
          .filter(Boolean)
      );
    } catch (err) {
      console.warn("[sectionPerformance:file] readAll failed:", err.message);
      return [];
    }
  }

  async append(rows) {
    const incoming = normaliseRows(rows);
    if (incoming.length === 0) return { written: 0, skipped: 0 };
    const existing = await this.readAll();
    const existingIds = new Set(existing.map((row) => row.id).filter(Boolean));
    const fresh = incoming.filter((row) => row.id && !existingIds.has(row.id));
    if (fresh.length === 0) return { written: 0, skipped: incoming.length };
    mkdirSync(path.dirname(this.path), { recursive: true });
    appendFileSync(this.path, fresh.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    return { written: fresh.length, skipped: incoming.length - fresh.length };
  }

  async upsert(rows) {
    const incoming = normaliseRows(rows);
    if (incoming.length === 0) return { written: 0, updated: 0, skipped: 0 };
    const existing = await this.readAll();
    const byId = new Map(existing.filter((row) => row.id).map((row) => [row.id, row]));
    let written = 0;
    let updated = 0;
    let skipped = 0;
    for (const row of incoming) {
      if (!row.id) {
        skipped++;
        continue;
      }
      if (byId.has(row.id)) updated++;
      else written++;
      byId.set(row.id, row);
    }
    const next = sortRowsNewestFirst([...byId.values()]);
    mkdirSync(path.dirname(this.path), { recursive: true });
    writeFileSync(this.path, next.map((row) => JSON.stringify(row)).join("\n") + (next.length ? "\n" : ""), "utf8");
    return { written, updated, skipped };
  }

  async latest(limit = 20) {
    const rows = await this.readAll();
    return rows.slice(0, limit);
  }

  async readByDateKey(dateKey) {
    if (!dateKey) return [];
    const rows = await this.readAll();
    return rows.filter((row) => row.dateKey === dateKey);
  }

  async getStats() {
    if (!existsSync(this.path)) {
      return { exists: false, lineCount: 0, sizeBytes: 0, oldest: null, newest: null };
    }
    const stats = statSync(this.path);
    const rows = await this.readAll();
    if (rows.length === 0) {
      return { exists: true, lineCount: 0, sizeBytes: stats.size, oldest: null, newest: null };
    }
    const oldest = [...rows].sort((a, b) => String(a.snapshotAt || a.dateKey || "").localeCompare(String(b.snapshotAt || b.dateKey || "")))[0];
    const newest = rows[0];
    return {
      exists: true,
      lineCount: rows.length,
      sizeBytes: stats.size,
      oldest: oldest?.snapshotAt || oldest?.dateKey || null,
      newest: newest?.snapshotAt || newest?.dateKey || null,
    };
  }

  async clear() {
    if (existsSync(this.path)) unlinkSync(this.path);
  }
}

export class VercelKVSectionPerformanceStorage {
  constructor(opts = {}) {
    this.name = "vercel-kv";
    this.key = opts.key || SECTION_PERFORMANCE_KV_KEY;
    this._kv = null;
  }

  async _getKV() {
    if (this._kv) return this._kv;
    const mod = await import("@vercel/kv");
    this._kv = mod.kv;
    return this._kv;
  }

  async readAll() {
    try {
      const kv = await this._getKV();
      const members = await kv.zrange(this.key, 0, -1, { rev: true });
      return sortRowsNewestFirst(
        (members || [])
          .map((member) => (typeof member === "string" ? safeParse(member) : member))
          .filter(Boolean)
      );
    } catch (err) {
      console.warn("[sectionPerformance:kv] readAll failed:", err.message);
      return [];
    }
  }

  async append(rows) {
    const incoming = normaliseRows(rows);
    if (incoming.length === 0) return { written: 0, skipped: 0 };
    const existing = await this.readAll();
    const existingIds = new Set(existing.map((row) => row.id).filter(Boolean));
    const fresh = incoming.filter((row) => row.id && !existingIds.has(row.id));
    if (fresh.length === 0) return { written: 0, skipped: incoming.length };
    const kv = await this._getKV();
    for (const row of fresh) {
      await kv.zadd(this.key, {
        score: new Date(row.snapshotAt || row.dateKey || Date.now()).getTime(),
        member: JSON.stringify(row),
      });
    }
    return { written: fresh.length, skipped: incoming.length - fresh.length };
  }

  async upsert(rows) {
    const incoming = normaliseRows(rows);
    if (incoming.length === 0) return { written: 0, updated: 0, skipped: 0 };
    const existing = await this.readAll();
    const byId = new Map(existing.filter((row) => row.id).map((row) => [row.id, row]));
    let written = 0;
    let updated = 0;
    let skipped = 0;
    for (const row of incoming) {
      if (!row.id) {
        skipped++;
        continue;
      }
      if (byId.has(row.id)) updated++;
      else written++;
      byId.set(row.id, row);
    }

    const kv = await this._getKV();
    await kv.del(this.key);
    for (const row of byId.values()) {
      await kv.zadd(this.key, {
        score: new Date(row.snapshotAt || row.dateKey || Date.now()).getTime(),
        member: JSON.stringify(row),
      });
    }
    return { written, updated, skipped };
  }

  async latest(limit = 20) {
    const rows = await this.readAll();
    return rows.slice(0, limit);
  }

  async readByDateKey(dateKey) {
    if (!dateKey) return [];
    const rows = await this.readAll();
    return rows.filter((row) => row.dateKey === dateKey);
  }

  async getStats() {
    const rows = await this.readAll();
    if (rows.length === 0) {
      return { exists: true, lineCount: 0, sizeBytes: null, oldest: null, newest: null };
    }
    const oldest = [...rows].sort((a, b) => String(a.snapshotAt || a.dateKey || "").localeCompare(String(b.snapshotAt || b.dateKey || "")))[0];
    const newest = rows[0];
    return {
      exists: true,
      lineCount: rows.length,
      sizeBytes: null,
      oldest: oldest?.snapshotAt || oldest?.dateKey || null,
      newest: newest?.snapshotAt || newest?.dateKey || null,
    };
  }

  async clear() {
    const kv = await this._getKV();
    await kv.del(this.key);
  }
}

let _storage = null;

export function createSectionPerformanceStorage(opts = {}) {
  if (opts.backend === "file") return new FileSectionPerformanceStorage(opts);
  if (opts.backend === "vercel-kv") return new VercelKVSectionPerformanceStorage(opts);
  return process.env.KV_REST_API_URL
    ? new VercelKVSectionPerformanceStorage(opts)
    : new FileSectionPerformanceStorage(opts);
}

export function getSectionPerformanceStorage() {
  if (!_storage) _storage = createSectionPerformanceStorage();
  return _storage;
}

export function resetSectionPerformanceStorageForTests(storage = null) {
  _storage = storage;
}

export async function readAllSectionPerformanceRows() {
  return getSectionPerformanceStorage().readAll();
}

export async function upsertSectionPerformanceRows(rows) {
  return getSectionPerformanceStorage().upsert(rows);
}

export async function getSectionPerformanceStats() {
  return getSectionPerformanceStorage().getStats();
}
