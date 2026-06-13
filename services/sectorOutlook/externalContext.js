/**
 * Sector Outlook — refresh-time external context.
 *
 * This helper is deliberately read-only and network-free. It summarizes
 * existing local macro-headline artifacts and sector-index closes so the
 * synthesizer can use external corroboration without page-load fetches.
 */

import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_DATA_DIR as DEFAULT_SECTOR_INDEX_DIR,
  loadSectorSeries,
} from "../macroThesis/sectorReturnLoader.js";
import { getSectorEntry } from "../macroThesis/sectorIndexCatalog.js";

export const EXTERNAL_CONTEXT_SCHEMA = "sector-outlook-external-context-v1";

const SECTOR_INDEX_BY_CANONICAL = Object.freeze({
  "IT Services": "NIFTY_IT",
  Automobile: "NIFTY_AUTO",
  "Real Estate": "NIFTY_REALTY",
  Banking: "NIFTY_BANK",
  NBFC: "NIFTY_BANK",
  Pharma: "NIFTY_PHARMA",
  "Oil & Gas": "NIFTY_ENERGY",
  Power: "NIFTY_ENERGY",
  FMCG: "NIFTY_FMCG",
  Media: "NIFTY_MEDIA",
  Infrastructure: "NIFTY_INFRA",
  "Capital Goods": "NIFTY_INFRA",
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function countJsonlLines(file) {
  if (!file || !fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length;
}

function latestMacroHeadlineDate(root) {
  const dir = path.join(root, "data", "macro-headlines");
  if (!fs.existsSync(dir)) return null;
  const dates = fs.readdirSync(dir)
    .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1])
    .filter(Boolean)
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}

function closeAtOrBefore(series, isoDate) {
  let out = null;
  for (const bar of series) {
    if (bar.date <= isoDate) out = bar;
    else break;
  }
  return out;
}

function shiftIso(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function trailingReturn(series, asOf, lookbackDays) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const latest = closeAtOrBefore(series, asOf) || series[series.length - 1];
  const start = closeAtOrBefore(series, shiftIso(latest.date, -lookbackDays));
  if (!latest || !start || !Number.isFinite(start.close) || start.close <= 0) return null;
  return {
    start_date: start.date,
    latest_date: latest.date,
    start_close: start.close,
    latest_close: latest.close,
    return_pct: Math.round((((latest.close - start.close) / start.close) * 100) * 100) / 100,
  };
}

function buildSectorPriceContext(root, asOf) {
  const dataDir = path.join(root, "data", "sector-indices");
  const benchmark = trailingReturn(loadSectorSeries("NIFTY_50", { dataDir }), asOf, 30);
  const sectors = {};
  for (const [sector, key] of Object.entries(SECTOR_INDEX_BY_CANONICAL)) {
    const entry = getSectorEntry(key);
    const ret = trailingReturn(loadSectorSeries(key, { dataDir }), asOf, 30);
    if (!entry || !ret) continue;
    const vsNiftyPct = benchmark
      ? Math.round((ret.return_pct - benchmark.return_pct) * 100) / 100
      : null;
    const scoreBase = Number.isFinite(vsNiftyPct) ? vsNiftyPct : ret.return_pct;
    sectors[sector] = {
      status: "AVAILABLE",
      index_key: key,
      label: entry.label,
      lookback_days: 30,
      latest_date: ret.latest_date,
      return_pct: ret.return_pct,
      benchmark_return_pct: benchmark?.return_pct ?? null,
      vs_nifty_pct: vsNiftyPct,
      // +/-10 percentage points of 30d relative performance maps to +/-1.
      score: clamp(scoreBase / 10, -1, 1),
    };
  }
  return {
    data_dir: fs.existsSync(dataDir) ? dataDir : DEFAULT_SECTOR_INDEX_DIR,
    benchmark_available: Boolean(benchmark),
    sectors,
  };
}

export function loadSectorOutlookExternalContext(root = process.cwd(), opts = {}) {
  const asOf = opts.asOf || new Date().toISOString().slice(0, 10);
  const latestMacroDate = latestMacroHeadlineDate(root);
  const macroHeadlinesFile = latestMacroDate
    ? path.join(root, "data", "macro-headlines", `${latestMacroDate}.jsonl`)
    : null;
  const macroMetaFile = latestMacroDate
    ? path.join(root, "data", "macro-headlines", `${latestMacroDate}._meta.json`)
    : null;
  let macroMeta = null;
  if (macroMetaFile && fs.existsSync(macroMetaFile)) {
    try { macroMeta = JSON.parse(fs.readFileSync(macroMetaFile, "utf8")); } catch {}
  }

  return {
    schema_version: EXTERNAL_CONTEXT_SCHEMA,
    generated_at: new Date().toISOString(),
    as_of: asOf,
    macro_headlines: {
      status: latestMacroDate ? "AVAILABLE" : "MISSING",
      latest_date: latestMacroDate,
      count: countJsonlLines(macroHeadlinesFile),
      regime_hint: macroMeta?.regime || macroMeta?.classified_regime || null,
    },
    sector_price: buildSectorPriceContext(root, asOf),
  };
}

export default {
  EXTERNAL_CONTEXT_SCHEMA,
  loadSectorOutlookExternalContext,
};
