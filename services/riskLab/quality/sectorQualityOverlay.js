/**
 * Risk Lab — Quality Lens / Sector-Specific Quality Overlay.
 *
 * Some quality concerns are sector-specific and the generic
 * riskTextClassifier under-weights them. EPC firms (KEC, KALPATPOWR,
 * LARSEN) live or die by working-capital cycle. Pharma exporters live
 * or die by USFDA inspections. Banks live or die by NPA / asset quality.
 *
 * Each overlay defined in data/risk-lab/_sector-overlays.json fires
 * when:
 *   1. Stock's sector matches the overlay's sector_match regex
 *   2. Any of the stock's risk bullets matches the overlay's
 *      risk_patterns regex list
 *
 * Hits add the overlay's severity (typically -2 or -3) to the quality
 * score. Combined cap at -4 across all overlays so a stock in two
 * sectors with risks in both doesn't get stacked into oblivion.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OVERLAYS_PATH = path.resolve(__dirname, "..", "..", "..", "data", "risk-lab", "_sector-overlays.json");

const PENALTY_CAP = -4;

let _overlaysCache = null;
function loadOverlays(overlaysPath) {
  if (_overlaysCache && _overlaysCache._path === "__test__") return _overlaysCache.data;
  const p = overlaysPath || DEFAULT_OVERLAYS_PATH;
  if (_overlaysCache && _overlaysCache._path === p) return _overlaysCache.data;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    const data = Object.fromEntries(
      Object.entries(raw).filter(([key]) => !key.startsWith("_")),
    );
    _overlaysCache = { _path: p, data };
    return data;
  } catch (err) {
    console.warn(`[risk-lab/quality] sectorQualityOverlay loadOverlays failed: ${err.message}`);
    return {};
  }
}

export function _setOverlaysForTest(data) {
  _overlaysCache = data === null ? null : { _path: "__test__", data };
}

/**
 * Apply sector-specific overlays to a stock.
 *
 * @param {string} sector  — stock's sector from picks-latest
 * @param {string[]} risks — stock's risks[] array
 * @param {object} opts    — { overlaysPath?: string }
 * @returns {object} { pts, flags[], reason }
 */
export function applySectorQualityOverlay(sector, risks, opts = {}) {
  if (!sector || typeof sector !== "string") {
    return { pts: 0, flags: [], reason: "no_sector" };
  }
  if (!Array.isArray(risks) || risks.length === 0) {
    return { pts: 0, flags: [], reason: "no_risks" };
  }

  const overlays = loadOverlays(opts.overlaysPath);
  if (Object.keys(overlays).length === 0) {
    return { pts: 0, flags: [], reason: "no_overlays_loaded" };
  }

  const sectorLower = sector.toLowerCase();
  const flags = [];

  for (const [overlayKey, def] of Object.entries(overlays)) {
    if (!def || !def.sector_match || !Array.isArray(def.risk_patterns)) continue;

    // Sector match
    let sectorPattern;
    try {
      sectorPattern = new RegExp(def.sector_match, "i");
    } catch {
      continue;
    }
    if (!sectorPattern.test(sectorLower)) continue;

    // Find a matching risk bullet
    for (const bullet of risks) {
      if (!bullet || typeof bullet !== "string") continue;
      for (const riskPatternStr of def.risk_patterns) {
        let riskPattern;
        try {
          riskPattern = new RegExp(riskPatternStr, "i");
        } catch {
          continue;
        }
        if (riskPattern.test(bullet)) {
          flags.push({
            overlay: overlayKey,
            severity: Number(def.severity || 0),
            sector,
            evidence: bullet,
            pattern: riskPatternStr,
            summary: def.summary || overlayKey,
          });
          break; // one match per overlay per stock
        }
      }
      if (flags.some((f) => f.overlay === overlayKey)) break;
    }
  }

  if (flags.length === 0) {
    return { pts: 0, flags: [], reason: "no_overlay_fired" };
  }

  const rawSum = flags.reduce((acc, f) => acc + f.severity, 0);
  const pts = Math.max(rawSum, PENALTY_CAP);

  return { pts, flags, reason: "match" };
}
