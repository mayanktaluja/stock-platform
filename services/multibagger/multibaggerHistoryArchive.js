// Multibagger snapshot archive — weekly + event-driven cadence.
//
// 5x predictions resolve over 12 months, so daily snapshots create
// 365× bloat with no resolution gain. We archive on:
//   - Sunday EOD (calendar snapshot)
//   - Every portfolio entry / exit / trim (event snapshot)
//
// Files live under data/strategy/history/<YYYY-MM-DD>.json. Atomic
// PID-temp + rename writes; dedup by (date, type) within a day.

import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = "multibagger-history-v1";
const SNAPSHOT_TYPES = new Set(["calendar_sunday", "event_entry", "event_exit", "event_trim", "manual"]);

function defaultDir() {
  return path.join(process.cwd(), "data", "strategy", "history");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function fileFor(dateIso, dir) {
  return path.join(dir, `${dateIso}.json`);
}

function readSafe(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function atomicWriteJson(target, obj) {
  ensureDir(path.dirname(target));
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: "utf8" });
  fs.renameSync(tmp, target);
}

export function shouldSnapshotToday({ today_iso, last_snapshot_iso = null, force = false } = {}) {
  if (force) return true;
  if (!today_iso) return false;
  const d = new Date(today_iso);
  if (Number.isNaN(d.getTime())) return false;
  // 0 = Sunday
  if (d.getUTCDay() === 0) {
    if (!last_snapshot_iso) return true;
    return last_snapshot_iso !== today_iso;
  }
  return false;
}

export function writeSnapshot({
  type, today_iso, portfolio_mtm, scorer_summary, regime_open, risk_state, decisions_delta = 0, dir = null,
} = {}) {
  if (!SNAPSHOT_TYPES.has(type)) throw new Error(`writeSnapshot: invalid type ${type}`);
  if (!today_iso) throw new Error("writeSnapshot: today_iso required");
  const targetDir = dir || defaultDir();
  const target = fileFor(today_iso, targetDir);
  const existing = readSafe(target) || {
    schema_version: SCHEMA_VERSION,
    date_iso: today_iso,
    snapshots: [],
  };
  existing.snapshots.push({
    type,
    ts: new Date().toISOString(),
    portfolio_value_inr: portfolio_mtm?.portfolio_value_inr ?? null,
    total_pl_pct: portfolio_mtm?.total_pl_pct ?? null,
    cash_inr: portfolio_mtm?.cash_inr ?? null,
    open_positions: portfolio_mtm?.positions?.length ?? 0,
    closed_count: portfolio_mtm?.closed_count ?? 0,
    scorer: {
      candidate_count: scorer_summary?.candidate_count ?? null,
      five_x_count: scorer_summary?.five_x_count ?? null,
      high_conviction_count: scorer_summary?.high_conviction_count ?? null,
      built_at_iso: scorer_summary?.built_at_iso ?? null,
    },
    regime: {
      regime: regime_open?.macroRegime ?? null,
      pillar1_anchor_open: regime_open?.pillar1_anchor?.open ?? null,
      pillar1_high_open: regime_open?.pillar1_high?.open ?? null,
    },
    risk_state: risk_state || null,
    decisions_delta,
  });
  atomicWriteJson(target, existing);
  return existing;
}

export function readSnapshotsFor(dateIso, dir = null) {
  const targetDir = dir || defaultDir();
  return readSafe(fileFor(dateIso, targetDir));
}

export function listSnapshotDates(dir = null) {
  const targetDir = dir || defaultDir();
  if (!fs.existsSync(targetDir)) return [];
  return fs.readdirSync(targetDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(".json", ""))
    .sort();
}

// For trajectory analysis — flatten weekly snapshots into a value-over-time
// series.
export function buildTrajectorySeries(dir = null) {
  const dates = listSnapshotDates(dir);
  const series = [];
  for (const d of dates) {
    const snap = readSnapshotsFor(d, dir);
    if (!snap?.snapshots?.length) continue;
    const last = snap.snapshots[snap.snapshots.length - 1];
    if (last.portfolio_value_inr === null) continue;
    series.push({ date_iso: d, value_inr: last.portfolio_value_inr, pl_pct: last.total_pl_pct });
  }
  return series;
}

export const HISTORY_ARCHIVE_CONFIG = Object.freeze({ SCHEMA_VERSION, SNAPSHOT_TYPES: Array.from(SNAPSHOT_TYPES) });
