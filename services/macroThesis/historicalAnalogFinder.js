// Historical analog finder (PR B1.4).
//
// Joins three data products:
//   1. Live macro regime history (data/macroRegime-history/*.jsonl,
//      written by macroRegimeStorage.appendRegimeIfTransition)
//   2. Hand-seeded historical regimes (data/macroRegime-history/
//      backfill-seeds.jsonl, written by scripts/seed-historical-regimes.mjs)
//   3. Sector index daily closes (data/sector-indices/*.jsonl, written
//      by scripts/refresh-sector-indices.mjs)
//
// Given a CURRENT regime+severity, returns the past regimes that match,
// plus per-sector forward-return distributions (median, IQR) computed
// from the sector-index store at +7/+14/+30/+60 days from each analog.
//
// Output shape (returned by findAnalogs):
//   {
//     regime: "WAR_ESCALATION",
//     severity: 3,
//     n_analogs: 3,
//     analogs: [{date, label, severity, source}, ...],
//     sectors: {
//       NIFTY_REALTY: {
//         label: "Nifty Realty",
//         sector: "Real Estate",
//         horizons: {
//           7:  { samples: [-3, -5, -2], median: -3, p25: -5, p25_label: "...", n: 3 },
//           14: { ... },
//           30: { ... },
//           60: { ... },
//         }
//       },
//       ...
//     },
//     warnings: ["only 2 sector-data-available analogs", ...]
//   }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeAllSectorReturns, STANDARD_HORIZONS_DAYS } from "./sectorReturnLoader.js";
import { SECTOR_INDEX_CATALOG } from "./sectorIndexCatalog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const DEFAULT_REGIME_HISTORY_DIR = path.join(REPO_ROOT, "data", "macroRegime-history");
export const DEFAULT_SECTOR_DATA_DIR = path.join(REPO_ROOT, "data", "sector-indices");
export const MIN_SAFE_N = 3; // below this we surface "INDETERMINATE" warnings

function _readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export function loadAllRegimeHistory({ regimeHistoryDir = DEFAULT_REGIME_HISTORY_DIR } = {}) {
  if (!fs.existsSync(regimeHistoryDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(regimeHistoryDir)) {
    if (!f.endsWith(".jsonl")) continue;
    out.push(..._readJsonl(path.join(regimeHistoryDir, f)));
  }
  // Sort by generatedAt ascending so callers iterate chronologically.
  out.sort((a, b) => (a.generatedAt || "").localeCompare(b.generatedAt || ""));
  return out;
}

// Deduplicate consecutive identical regimes — the live classifier
// writes one line per transition, but if seeds + live overlap we can
// get duplicates at the same (regime, severity, date).
function _dedupeRegimes(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = `${r.regime}|${r.severity}|${(r.generatedAt || "").slice(0, 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// Find regimes that match (regime, severity ± tolerance). Excludes the
// CURRENT regime occurrence if its generatedAt falls within
// `excludeWindowDays` of `currentDate`.
export function matchRegimes({
  regime,
  severity,
  toleranceSeverity = 1,
  currentDate = null,
  excludeWindowDays = 30,
  regimeHistoryDir = DEFAULT_REGIME_HISTORY_DIR,
} = {}) {
  const rows = _dedupeRegimes(loadAllRegimeHistory({ regimeHistoryDir }));
  const sevLo = severity - toleranceSeverity;
  const sevHi = severity + toleranceSeverity;
  const cutoffMs = currentDate
    ? Date.parse(currentDate) - excludeWindowDays * 24 * 3600 * 1000
    : null;
  const matched = [];
  for (const r of rows) {
    if (r.regime !== regime) continue;
    const sev = typeof r.severity === "number" ? r.severity : Infinity;
    if (sev < sevLo || sev > sevHi) continue;
    if (cutoffMs !== null && r.generatedAt && Date.parse(r.generatedAt) > cutoffMs) continue;
    matched.push({
      date: (r.generatedAt || "").slice(0, 10),
      label: r.regimeLabel || r.label || r.regime,
      severity: sev,
      source: r.source || r.classifierProvider || "live",
      sourceMeta: r,
    });
  }
  return matched;
}

function _percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(sorted[lo] * 100) / 100;
  const f = idx - lo;
  return Math.round((sorted[lo] * (1 - f) + sorted[hi] * f) * 100) / 100;
}

// Build the per-sector forward-return distribution across the matched
// analogs.
export function buildSectorDistribution({
  matched,
  horizonsDays = STANDARD_HORIZONS_DAYS,
  sectorDataDir = DEFAULT_SECTOR_DATA_DIR,
}) {
  const samples = {}; // sectorKey -> { horizonDays -> [pct, pct, ...] }
  for (const m of matched) {
    if (!m.date) continue;
    const all = computeAllSectorReturns(m.date, { horizonsDays, dataDir: sectorDataDir });
    for (const [key, block] of Object.entries(all)) {
      if (block._empty) continue;
      for (const h of horizonsDays) {
        const bar = block.horizons[h];
        if (!bar || typeof bar.return_pct !== "number") continue;
        if (!samples[key]) samples[key] = { label: block.label, sector: block.sector, horizons: {} };
        if (!samples[key].horizons[h]) samples[key].horizons[h] = [];
        samples[key].horizons[h].push(bar.return_pct);
      }
    }
  }
  const out = {};
  for (const [key, blob] of Object.entries(samples)) {
    const horizons = {};
    for (const [h, arr] of Object.entries(blob.horizons)) {
      const sorted = arr.slice().sort((a, b) => a - b);
      horizons[h] = {
        samples: sorted,
        n: sorted.length,
        median: _percentile(sorted, 50),
        p25: _percentile(sorted, 25),
        p75: _percentile(sorted, 75),
        min: sorted[0],
        max: sorted[sorted.length - 1],
      };
    }
    out[key] = { label: blob.label, sector: blob.sector, horizons };
  }
  return out;
}

// Top-level: full analog report for a current regime.
export function findAnalogs({
  regime,
  severity,
  toleranceSeverity = 1,
  currentDate = null,
  excludeWindowDays = 30,
  horizonsDays = STANDARD_HORIZONS_DAYS,
  regimeHistoryDir = DEFAULT_REGIME_HISTORY_DIR,
  sectorDataDir = DEFAULT_SECTOR_DATA_DIR,
} = {}) {
  const matched = matchRegimes({
    regime,
    severity,
    toleranceSeverity,
    currentDate,
    excludeWindowDays,
    regimeHistoryDir,
  });
  const sectors = buildSectorDistribution({ matched, horizonsDays, sectorDataDir });
  const warnings = [];
  if (matched.length < MIN_SAFE_N) {
    warnings.push(
      `n_analogs=${matched.length} < ${MIN_SAFE_N} — INDETERMINATE; do not act on these sector ranges`,
    );
  }
  const sectorsWithData = Object.keys(sectors).length;
  if (sectorsWithData === 0 && matched.length > 0) {
    warnings.push(
      "no sector-index data found for any analog date — run scripts/refresh-sector-indices.mjs --backfill-months=24",
    );
  } else if (sectorsWithData < SECTOR_INDEX_CATALOG.length / 2) {
    warnings.push(
      `only ${sectorsWithData}/${SECTOR_INDEX_CATALOG.length} sectors had data — partial analog`,
    );
  }
  return {
    regime,
    severity,
    n_analogs: matched.length,
    analogs: matched.map(({ sourceMeta, ...m }) => m),
    sectors,
    warnings,
    indeterminate: matched.length < MIN_SAFE_N,
  };
}

export default { findAnalogs, matchRegimes, buildSectorDistribution, loadAllRegimeHistory, MIN_SAFE_N };
