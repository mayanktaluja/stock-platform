#!/usr/bin/env node
/**
 * India API-scrape progress, read the way the scraper itself reads it.
 *
 * A shard's cursor (`next_local_index` in data/sws/progress-api-<n>.json) is an
 * integer offset into a slice that is NOT stored anywhere: sws-api-scrape.mjs
 * derives it at runtime from data/sws/universe.json via shardSliceContiguous.
 * So "how far did shard 2 get" needs the universe too, and this module is the
 * one place that joins them, for the nightly's mails.
 *
 * CLI (all accept --data-dir <dir>, default <repo>/data/sws):
 *   summary   one line per shard: cursor / slice, last ticker, last write age
 *
 * Only node: builtins plus sws-shard-partition.mjs (→ sws-config.mjs, builtins
 * only) are imported, so bash tests can copy these three files into a fixture.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHARD_COUNT, shardSliceContiguous } from "./sws-shard-partition.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
export const DEFAULT_DATA_DIR = path.join(REPO_ROOT, "data", "sws");

const HOUR_MS = 3_600_000;

// "2026-09-30 17:09:00 IST" — same rendering as sws-panic-policy.mjs.
export function formatIst(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  try {
    const s = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Kolkata",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms));
    return `${s} IST`;
  } catch {
    // small-icu Node builds lack Asia/Kolkata; IST has no DST, so shift by hand.
    return `${new Date(ms + 5.5 * HOUR_MS).toISOString().slice(0, 19).replace("T", " ")} IST`;
  }
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "?";
  const mins = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Same shape handling as sws-api-scrape.mjs loadUniverse(). Missing → []. */
export function loadUniverse(dataDir = DEFAULT_DATA_DIR) {
  const raw = readJson(path.join(dataDir, "universe.json"));
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : raw.stocks || raw.universe || [];
  return Array.isArray(arr) ? arr : [];
}

/** Per-shard cursor vs slice. `slice_size` is null when universe.json is unreadable. */
export function shardProgress({ dataDir = DEFAULT_DATA_DIR, universe = loadUniverse(dataDir), totalShards = SHARD_COUNT } = {}) {
  const rows = [];
  for (let sid = 1; sid <= totalShards; sid++) {
    const p = readJson(path.join(dataDir, `progress-api-${sid}.json`));
    const sliceSize = universe.length ? shardSliceContiguous(universe, sid, totalShards).length : null;
    const cursor = Number.isFinite(Number(p?.next_local_index)) ? Number(p.next_local_index) : null;
    const lastRunMs = Date.parse(p?.last_run_at || "");
    rows.push({
      shard: sid,
      present: Boolean(p),
      next_local_index: cursor,
      slice_size: sliceSize,
      // Cursor vs slice ONLY. The file's `complete` field is written by the
      // legacy DOM driver and the universe-rebuild scripts, never by
      // sws-api-scrape.mjs, and the step-3 rewind leaves it alone — so it can
      // read true at cursor 0.
      finished: cursor !== null && sliceSize !== null && sliceSize > 0 && cursor >= sliceSize,
      done_count: Number.isFinite(Number(p?.done_count)) ? Number(p.done_count) : null,
      today_count: Number.isFinite(Number(p?.today_count)) ? Number(p.today_count) : null,
      today_date: p?.today_date || null,
      last_ticker: p?.last_ticker || null,
      last_run_ms: Number.isFinite(lastRunMs) ? lastRunMs : null,
    });
  }
  return rows;
}

export function formatProgressLine(row, now = Date.now()) {
  if (!row.present) return `shard ${row.shard}: no progress-api-${row.shard}.json`;
  const pos = row.next_local_index ?? "?";
  const of = row.slice_size ?? "?";
  const pct = row.next_local_index !== null && row.slice_size ? ` (${Math.min(100, Math.round((row.next_local_index / row.slice_size) * 100))}%)` : "";
  const last = row.last_run_ms !== null
    ? ` · last ${row.last_ticker || "?"} at ${formatIst(row.last_run_ms)} (${formatDuration(now - row.last_run_ms)} ago)`
    : "";
  return `shard ${row.shard}: next_local_index ${pos}/${of}${pct}${row.finished ? " · slice finished" : ""}${last}`;
}

export function formatSummary(rows, now = Date.now()) {
  return rows.map((r) => formatProgressLine(r, now)).join("\n");
}

// ────────── CLI ──────────

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") opts.dataDir = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : DEFAULT_DATA_DIR;
  const now = Date.now();

  switch (cmd) {
    case "summary":
      console.log(formatSummary(shardProgress({ dataDir }), now));
      return 0;
    default:
      console.error("usage: node scripts/sws-scrape-progress.mjs <summary> [--data-dir DIR]");
      return 2;
  }
}

// realpath on both sides: the nightly runs this through a symlinked worktree
// path, and a plain href comparison would silently skip the CLI there.
const isEntrypoint = () => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
};

if (isEntrypoint()) {
  let code;
  try {
    code = cli(process.argv.slice(2));
  } catch (e) {
    console.error(`[scrape-progress] internal error: ${e?.stack || e}`);
    code = 2;
  }
  process.exit(code);
}
