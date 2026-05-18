// Headline archive writer (PR B1.2).
//
// Appends every macroHeadlineFetcher.fetchMacroHeadlines() result to
// data/macro-headlines/<YYYY-MM-DD>.jsonl. The store is the foundation
// for B1.3's manual event seeds + B1.4's historical analog backtester —
// once enough days accumulate, the analog finder can classify past
// regimes from real headlines rather than narrative anchors only.
//
// Dedup strategy: keyed by SHA-256 of (source + title + publishedAt).
// A fetch that returns the same headline twice (e.g. two refreshes in
// the same hour) writes one line, not two.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
export const DEFAULT_ARCHIVE_DIR = path.join(REPO_ROOT, "data", "macro-headlines");

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _dateKey(asOf = null) {
  // YYYY-MM-DD in UTC. UTC chosen because the archive is consumed by
  // backtesters that match against macro regime entries (also UTC ISO);
  // mixing UTC + IST midnight crossings would create dedup misses.
  const d = asOf ? new Date(asOf) : new Date();
  return d.toISOString().slice(0, 10);
}

function _hashHeadline(h) {
  const key = `${h.source || ""}|${h.title || ""}|${h.publishedAt || ""}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function _readExistingHashes(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const out = new Set();
  for (const line of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?._hash) out.add(obj._hash);
    } catch {
      // ignore malformed
    }
  }
  return out;
}

export function archiveHeadlines(
  headlines,
  { archiveDir = DEFAULT_ARCHIVE_DIR, asOf = null, meta = null } = {},
) {
  if (!Array.isArray(headlines) || headlines.length === 0) {
    return { written: 0, skipped: 0, path: null };
  }
  _ensureDir(archiveDir);
  const dateKey = _dateKey(asOf);
  const filePath = path.join(archiveDir, `${dateKey}.jsonl`);
  const existing = _readExistingHashes(filePath);
  const fresh = [];
  for (const h of headlines) {
    if (!h?.title) continue;
    const hash = _hashHeadline(h);
    if (existing.has(hash)) continue;
    fresh.push({
      _hash: hash,
      _archived_at: new Date().toISOString(),
      source: h.source || null,
      title: h.title,
      link: h.link || null,
      publishedAt: h.publishedAt || null,
      tier: h.tier || null,
    });
    existing.add(hash);
  }
  if (fresh.length === 0) {
    return { written: 0, skipped: headlines.length, path: filePath };
  }
  const lines = fresh.map((h) => JSON.stringify(h)).join("\n") + "\n";
  fs.appendFileSync(filePath, lines);
  // Optional sidecar with the source-health / coverage metadata so an
  // analog backtester can later judge "how complete was this day".
  if (meta) {
    try {
      const sidecar = path.join(archiveDir, `${dateKey}._meta.json`);
      const prior = fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, "utf-8")) : { entries: [] };
      prior.entries.push({ ts: new Date().toISOString(), meta });
      fs.writeFileSync(sidecar, JSON.stringify(prior, null, 2));
    } catch {
      // sidecar is best-effort, don't fault the main archive
    }
  }
  return { written: fresh.length, skipped: headlines.length - fresh.length, path: filePath };
}

// Load all archived headlines for a given date (or date range).
export function loadArchivedHeadlines(
  date,
  { archiveDir = DEFAULT_ARCHIVE_DIR, throughDate = null } = {},
) {
  if (!fs.existsSync(archiveDir)) return [];
  const filesWanted = [];
  if (throughDate) {
    for (const f of fs.readdirSync(archiveDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const d = f.replace(/\.jsonl$/, "");
      if (d >= date && d <= throughDate) filesWanted.push(f);
    }
    filesWanted.sort();
  } else {
    filesWanted.push(`${date}.jsonl`);
  }
  const out = [];
  for (const f of filesWanted) {
    const p = path.join(archiveDir, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
  }
  return out;
}

export default { archiveHeadlines, loadArchivedHeadlines, DEFAULT_ARCHIVE_DIR };
