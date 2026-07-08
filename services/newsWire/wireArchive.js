// Market Wire — persistence sink (Phase 1).
//
// The Telegram mirror poller (scripts/refresh-mirror-news.mjs) already parses
// every public-channel message and routes it, but then DISCARDS the content
// after dispatch — nothing reaches disk. This module is the append-only NDJSON
// sink that captures each routed message so the wire builder can later cluster,
// triage, rank, and surface them on the Market Intelligence tab.
//
// Cloned from services/macroHeadlineArchive.js with three deliberate divergences:
//
//   1. [C2] The write path NO-OPs when NEWS_WIRE_DIR is unset. The poller runs
//      inside a `mktemp` git worktree that mirror-news-poll.sh deletes with
//      `git worktree remove --force` every 60s. A __dirname-relative default
//      would write INTO that doomed dir and be nuked with no error. So the sink
//      refuses to write unless the caller pins an absolute NEWS_WIRE_DIR (exact
//      ALERTS_LEDGER_DIR discipline from sentLedger.js). The READ path (builder,
//      canonical repo) tolerates a module-relative default.
//
//   2. Dedup key is (channel | routerKey), NOT (source | title | publishedAt).
//      Cross-channel copies of the same story must SURVIVE as separate lines so
//      the clusterer can count distinct corroborating sources; only the same
//      message re-seen on the SAME channel across the ~3-min freshness window
//      (the poller sees it on ~3 consecutive 60s runs) collapses to one line.
//
//   3. Stores the RAW row.text (clean plain text from telegramMirrorParser.js),
//      never alert.text (which newsRouter.js HTML-wraps + truncates to 350 chars).

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Module lives at services/newsWire/ → repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const DEFAULT_WIRE_DIR = path.join(REPO_ROOT, "data", "news-wire", "buffer");

/**
 * Absolute buffer dir for the WRITE path, or null when NEWS_WIRE_DIR is unset.
 * null is deliberate: the poller must never fall back to a default that could
 * resolve inside its throwaway worktree (C2). The wrapper pins it.
 */
export function wireDir(env = process.env) {
  return String(env.NEWS_WIRE_DIR || "").trim() || null;
}

/**
 * Buffer dir for the READ path (builder). Tolerates the module-relative default
 * because the builder runs in the canonical repo where __dirname is canonical.
 */
export function resolveReadDir(env = process.env) {
  return wireDir(env) || DEFAULT_WIRE_DIR;
}

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _dateKey(ms) {
  // YYYY-MM-DD in UTC (matches macroHeadlineArchive.js so date arithmetic and
  // the trailing-two-file window read never straddle an IST midnight bug).
  return new Date(ms).toISOString().slice(0, 10);
}

function _hash(channel, routerKey, text) {
  // routerKey is newsRouter's channel-agnostic content hash; namespace it by
  // channel so the same wire on two channels yields two distinct lines. Fall
  // back to text if a caller omits routerKey.
  const key = `${channel || ""}|${routerKey || text || ""}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function _readExistingHashes(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const out = new Set();
  try {
    for (const line of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?._hash) out.add(obj._hash);
      } catch {
        // ignore malformed trailing line (tolerant reader — a torn append is skipped)
      }
    }
  } catch {
    // unreadable file → treat as empty (fail open, we'll just re-append)
  }
  return out;
}

/**
 * Append routed Telegram messages to data/news-wire/buffer/<UTC-date>.jsonl.
 * NO-OP (returns {written:0, path:null, reason}) when NEWS_WIRE_DIR is unset.
 *
 * records: [{ channel, category, text, url, publishedAt, breaking, symbols, tags, routerKey }]
 */
export function archiveWireMessages(records, { archiveDir = wireDir(), asOf = null } = {}) {
  if (!archiveDir) {
    return { written: 0, skipped: Array.isArray(records) ? records.length : 0, path: null, reason: "NEWS_WIRE_DIR unset — sink disabled" };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { written: 0, skipped: 0, path: null };
  }
  _ensureDir(archiveDir);
  const dateKey = _dateKey(asOf ? new Date(asOf).getTime() : Date.now());
  const filePath = path.join(archiveDir, `${dateKey}.jsonl`);
  const existing = _readExistingHashes(filePath);
  const fresh = [];
  for (const r of records) {
    if (!r?.text) continue;
    const hash = _hash(r.channel, r.routerKey, r.text);
    if (existing.has(hash)) continue;
    fresh.push({
      _hash: hash,
      _archived_at: new Date().toISOString(),
      channel: r.channel || null,
      category: r.category || null,
      text: r.text,
      url: r.url || null,
      publishedAt: r.publishedAt || null,
      breaking: !!r.breaking,
      symbols: Array.isArray(r.symbols) ? r.symbols : [],
      tags: Array.isArray(r.tags) ? r.tags : [],
      routerKey: r.routerKey || null,
    });
    existing.add(hash);
  }
  if (fresh.length === 0) {
    return { written: 0, skipped: records.length, path: filePath };
  }
  fs.appendFileSync(filePath, fresh.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return { written: fresh.length, skipped: records.length - fresh.length, path: filePath };
}

/**
 * Load the last `hours` of buffered messages. Reads the trailing TWO UTC
 * day-files (today + yesterday) so a window that straddles UTC midnight isn't
 * truncated (M2), then filters to publishedAt >= now - hours. Undated rows are
 * dropped (can't place them in the window).
 */
export function loadWireWindow(hours, { archiveDir = resolveReadDir(), now = Date.now() } = {}) {
  if (!archiveDir || !fs.existsSync(archiveDir)) return [];
  const cutoff = now - hours * 3600 * 1000;
  const files = [_dateKey(now), _dateKey(now - 86400 * 1000)].map((d) => path.join(archiveDir, `${d}.jsonl`));
  const out = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    let raw;
    try { raw = fs.readFileSync(f, "utf-8"); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const ts = obj?.publishedAt ? new Date(obj.publishedAt).getTime() : NaN;
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      out.push(obj);
    }
  }
  return out;
}

/**
 * Delete buffer day-files older than keepDays. The buffer is per-machine
 * runtime state (gitignored), safe to drop. NO-OP when NEWS_WIRE_DIR is unset.
 */
export function pruneWireBuffer({ archiveDir = wireDir(), keepDays = 2, now = Date.now() } = {}) {
  if (!archiveDir || !fs.existsSync(archiveDir)) return { pruned: [] };
  const cutoffKey = _dateKey(now - keepDays * 86400 * 1000);
  const pruned = [];
  let entries;
  try { entries = fs.readdirSync(archiveDir); } catch { return { pruned: [] }; }
  for (const f of entries) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    if (m[1] < cutoffKey) {
      try { fs.unlinkSync(path.join(archiveDir, f)); pruned.push(f); } catch { /* best effort */ }
    }
  }
  return { pruned };
}

export default { archiveWireMessages, loadWireWindow, pruneWireBuffer, wireDir, resolveReadDir, DEFAULT_WIRE_DIR };
