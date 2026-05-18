// Stock exposure mapper (PR B3).
//
// Given a ranked beneficiary sector, return the top N stocks tagged
// in that sector from picks-latest.json, filtered by:
//   - v3_score_100 >= 50 (fundamentals threshold)
//   - NOT in DEEP_OVERPRICE valuation band (don't chase fully-priced)
//   - Conglomerate filter: exclude stocks tagged as diversified UNLESS
//     they appear in the manual override file (data/macro-thesis-
//     conglomerate-overrides.json) for that specific sector
//
// Output is intentionally SHORT (max 5 per sector) — the UI is a
// decision tool, not a screener. SEBI Reg 16 framing: every stock
// returned must pass the fundamentals filter so we're not recommending
// a stock just because the macro thesis is bullish on its sector.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const DEFAULT_PICKS_PATH = path.join(REPO_ROOT, "data", "sws", "picks-latest.json");
export const DEFAULT_OVERRIDES_PATH = path.join(REPO_ROOT, "data", "macro-thesis-conglomerate-overrides.json");
export const MIN_V3_SCORE = 50;
export const MAX_STOCKS_PER_SECTOR = 5;

// Known diversified conglomerates that should NOT show up as "pure plays"
// on a sector thesis unless explicitly whitelisted in overrides.json.
// Conservative initial list; the overrides file is the escape hatch.
export const KNOWN_CONGLOMERATES = new Set([
  "RELIANCE",
  "ITC",
  "LT",
  "ADANIENT",
  "M_M",   // Mahindra & Mahindra (auto + financial services + IT services)
  "BAJAJHLDNG",
  "GRASIM", // Aditya Birla diversified
  "MAFANG",
]);

function _loadJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

// Extract stock rows from picks-latest.json across all sections.
// picks-latest is structured by category; we flatten into a single list
// keyed by ticker (latest section wins).
function _flattenPicks(picksDoc) {
  if (!picksDoc?.sections) return [];
  const out = new Map();
  for (const section of Object.values(picksDoc.sections)) {
    if (!Array.isArray(section)) continue;
    for (const row of section) {
      if (!row?.ticker) continue;
      out.set(row.ticker, row);
    }
  }
  return [...out.values()];
}

function _sectorMatch(row, targetBucket) {
  const rs = String(row.sector || row.industry || "").toLowerCase().trim();
  const tb = String(targetBucket || "").toLowerCase().trim();
  if (!rs || !tb) return false;
  return rs === tb || rs.includes(tb) || tb.includes(rs);
}

export function mapStocksToSector({
  sectorBucket,
  picksPath = DEFAULT_PICKS_PATH,
  overridesPath = DEFAULT_OVERRIDES_PATH,
  maxStocks = MAX_STOCKS_PER_SECTOR,
  minV3Score = MIN_V3_SCORE,
} = {}) {
  const picksDoc = _loadJson(picksPath);
  if (!picksDoc) return { sector: sectorBucket, stocks: [], _picks_missing: true };
  const overrides = _loadJson(overridesPath) || {};
  const whitelistForSector = new Set(
    Array.isArray(overrides[sectorBucket]) ? overrides[sectorBucket] : [],
  );
  const allRows = _flattenPicks(picksDoc);
  const matched = allRows.filter((r) => _sectorMatch(r, sectorBucket));
  const filtered = matched.filter((r) => {
    const v3 = r.v3_score_100 ?? r.v3_score ?? null;
    if (typeof v3 === "number" && v3 < minV3Score) return false;
    if (r.valuation_band === "DEEP_OVERPRICE") return false;
    if (KNOWN_CONGLOMERATES.has(r.ticker) && !whitelistForSector.has(r.ticker)) return false;
    return true;
  });
  // Sort by composite score descending (TOP_PICKs first).
  filtered.sort((a, b) => (b.combined_score ?? b.score ?? 0) - (a.combined_score ?? a.score ?? 0));
  const top = filtered.slice(0, maxStocks).map((r) => ({
    ticker: r.ticker,
    name: r.name,
    sector: r.sector,
    v3_score_100: r.v3_score_100 ?? r.v3_score ?? null,
    composite_score: r.combined_score ?? r.score ?? null,
    valuation_band: r.valuation_band || null,
    upside_pct: r.upside_pct ?? r.upside_to_fv_pct ?? null,
    verdict: r.composite_verdict || r.verdict || null,
  }));
  return {
    sector: sectorBucket,
    candidates_total: matched.length,
    passed_filters: filtered.length,
    excluded_conglomerates: matched.filter((r) => KNOWN_CONGLOMERATES.has(r.ticker) && !whitelistForSector.has(r.ticker)).map((r) => r.ticker),
    stocks: top,
  };
}

export default { mapStocksToSector, KNOWN_CONGLOMERATES, MIN_V3_SCORE, MAX_STOCKS_PER_SECTOR };
