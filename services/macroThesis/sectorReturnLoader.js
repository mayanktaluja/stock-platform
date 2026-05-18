// Sector return loader (PR B1.1).
//
// Reads data/sector-indices/<key>.jsonl (append-only daily-close store
// populated by scripts/refresh-sector-indices.mjs) and exposes helpers
// to compute rolling returns from any reference date.
//
// Each JSONL line is shaped:
//   { "date": "2026-05-18", "close": 38240.5, "volume": 2341000 }
//
// The loader is pure: pass a `dataDir` to point at fixtures in tests,
// or omit to use the canonical data/sector-indices/ directory.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SECTOR_INDEX_CATALOG, getSectorEntry, getEntryForSectorName } from "./sectorIndexCatalog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const DEFAULT_DATA_DIR = path.join(REPO_ROOT, "data", "sector-indices");

export const STANDARD_HORIZONS_DAYS = [7, 14, 30, 60];

function _readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf-8");
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.date && typeof obj.close === "number") out.push(obj);
    } catch {
      // ignore malformed line — store is append-only and a partial write
      // mid-cron shouldn't break loading
    }
  }
  // Sort ascending by date for deterministic lookup.
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export function loadSectorSeries(sectorKey, { dataDir = DEFAULT_DATA_DIR } = {}) {
  const entry = getSectorEntry(sectorKey);
  if (!entry) return [];
  const file = path.join(dataDir, `${sectorKey}.jsonl`);
  return _readJsonl(file);
}

// Find the close at-or-just-before `refDate`. Returns null when the
// series has no eligible bar (e.g. fixtures only cover later dates).
function _closeAtOrBefore(series, refDate) {
  if (!series || !series.length) return null;
  let candidate = null;
  for (const bar of series) {
    if (bar.date <= refDate) candidate = bar;
    else break;
  }
  return candidate;
}

// Find the close at-or-just-after `refDate + windowDays`. Returns null
// when no eligible bar exists (data not yet collected).
function _closeAfterWindow(series, refDate, windowDays) {
  if (!series || !series.length) return null;
  const target = _shiftDateIso(refDate, windowDays);
  for (const bar of series) {
    if (bar.date >= target) return bar;
  }
  return null;
}

function _shiftDateIso(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Returns the rolling forward returns for a given sector from `refDate`.
// Shape: { entry: bar, horizons: { 7: { date, close, return_pct }, 14: ..., ... } }
// Any horizon with no eligible exit bar in the series gets `null` —
// the loader is honest about gaps in the data.
export function computeRollingReturns(sectorKey, refDate, {
  horizonsDays = STANDARD_HORIZONS_DAYS,
  dataDir = DEFAULT_DATA_DIR,
} = {}) {
  const series = loadSectorSeries(sectorKey, { dataDir });
  if (!series.length) return { entry: null, horizons: {}, _empty: true };
  const entry = _closeAtOrBefore(series, refDate);
  if (!entry) return { entry: null, horizons: {}, _empty: true };
  const horizons = {};
  for (const h of horizonsDays) {
    const exit = _closeAfterWindow(series, refDate, h);
    if (!exit) {
      horizons[h] = null;
      continue;
    }
    const returnPct = ((exit.close - entry.close) / entry.close) * 100;
    horizons[h] = {
      date: exit.date,
      close: exit.close,
      return_pct: Math.round(returnPct * 100) / 100,
    };
  }
  return { entry, horizons, _empty: false };
}

// Iterate the catalog and compute returns for every sector at once.
// Useful for the analog backtester which scores every sector against
// the same reference date.
export function computeAllSectorReturns(refDate, {
  horizonsDays = STANDARD_HORIZONS_DAYS,
  dataDir = DEFAULT_DATA_DIR,
} = {}) {
  const out = {};
  for (const s of SECTOR_INDEX_CATALOG) {
    out[s.key] = {
      label: s.label,
      sector: s.sector,
      ...computeRollingReturns(s.key, refDate, { horizonsDays, dataDir }),
    };
  }
  return out;
}

// Quick freshness probe — for each sector, return how many days old the
// latest bar is. Drives the per-sector "stale" warning the macro-thesis
// UI shows when index data hasn't refreshed.
export function describeSectorFreshness({ dataDir = DEFAULT_DATA_DIR, asOf = null } = {}) {
  const today = asOf || new Date().toISOString().slice(0, 10);
  const out = {};
  for (const s of SECTOR_INDEX_CATALOG) {
    const series = loadSectorSeries(s.key, { dataDir });
    const latest = series.length ? series[series.length - 1] : null;
    out[s.key] = {
      label: s.label,
      latest_date: latest?.date || null,
      bars_count: series.length,
      stale_days: latest
        ? Math.floor(
            (Date.parse(today + "T00:00:00Z") - Date.parse(latest.date + "T00:00:00Z")) /
              (24 * 3600 * 1000),
          )
        : null,
    };
  }
  return out;
}

export { getSectorEntry, getEntryForSectorName };

export default {
  DEFAULT_DATA_DIR,
  STANDARD_HORIZONS_DAYS,
  loadSectorSeries,
  computeRollingReturns,
  computeAllSectorReturns,
  describeSectorFreshness,
  getSectorEntry,
  getEntryForSectorName,
};
