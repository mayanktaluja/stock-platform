/**
 * Risk Lab — Quality Lens / Risk Text Classifier.
 *
 * SWS deep briefs include a curated `risks[]` array of short text bullets
 * authored by SWS. Examples from the KEC case (data/sws/deep/KEC.json):
 *
 *   "Interest payments are not well covered by earnings"
 *   "Dividend of 1% is not well covered by free cash flows"
 *
 * These are textbook quality red flags for an EPC firm — interest coverage
 * and FCF cushion are exactly what you check when verifying a BEAT call.
 * Production's earningsLlmSignal.js gives -1 pt per risk bullet, but it
 * buries that inside the ±10 LLM signal where it gets averaged out by
 * the bullish narrative.
 *
 * This classifier scans risks[] against the curated quality-keyword
 * taxonomy at data/risk-lab/_quality-keywords.json, emits a flag per
 * matched category with the configured severity, and combines them
 * additively (capped at -4 total).
 *
 * Each match cites the source bullet text + category so the UI can
 * render a tooltip explaining why the flag fired.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEYWORDS_PATH = path.resolve(__dirname, "..", "..", "..", "data", "risk-lab", "_quality-keywords.json");

const PENALTY_CAP = -4;

let _keywordsCache = null;
function loadKeywords(keywordsPath) {
  // Test/override injection always wins — bypasses path matching so a
  // test that calls _setKeywordsForTest with custom keywords doesn't get
  // silently shadowed by the disk file on a subsequent default-path call.
  if (_keywordsCache && _keywordsCache._path === "__test__") {
    return _keywordsCache.data;
  }
  const p = keywordsPath || DEFAULT_KEYWORDS_PATH;
  if (_keywordsCache && _keywordsCache._path === p) return _keywordsCache.data;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    // Strip metadata fields (anything starting with "_")
    const data = Object.fromEntries(
      Object.entries(raw).filter(([key]) => !key.startsWith("_")),
    );
    _keywordsCache = { _path: p, data };
    return data;
  } catch (err) {
    console.warn(`[risk-lab/quality] failed to load keywords from ${p}: ${err.message}`);
    return {};
  }
}

/**
 * Allow tests + the orchestrator to inject a custom taxonomy without
 * touching the disk file. Pass null to clear.
 */
export function _setKeywordsForTest(data) {
  _keywordsCache = data === null ? null : { _path: "__test__", data };
}

/**
 * Classify a single risks[] array against the keyword taxonomy.
 *
 * @param {string[]} risks — SWS risks[] from overview.risks
 * @param {object} opts    — { keywordsPath?: string }
 * @returns {object} { pts, flags[], reason }
 *   flags = [{ category, severity, evidence: <bullet text>, pattern: <which pattern matched>, summary }]
 */
export function classifyRiskText(risks, opts = {}) {
  if (!Array.isArray(risks) || risks.length === 0) {
    return { pts: 0, flags: [], reason: "no_risks" };
  }
  const keywords = loadKeywords(opts.keywordsPath);
  if (!keywords || Object.keys(keywords).length === 0) {
    return { pts: 0, flags: [], reason: "no_keywords_loaded" };
  }

  const flags = [];
  // Track which categories already fired so duplicate bullets matching the
  // same category don't double-penalise.
  const firedCategories = new Set();

  for (const bullet of risks) {
    if (!bullet || typeof bullet !== "string") continue;

    for (const [category, def] of Object.entries(keywords)) {
      if (firedCategories.has(category)) continue;
      if (!def || !Array.isArray(def.patterns)) continue;

      for (const patternStr of def.patterns) {
        let pattern;
        try {
          pattern = new RegExp(patternStr, "i");
        } catch {
          continue;
        }
        if (pattern.test(bullet)) {
          flags.push({
            category,
            severity: Number(def.severity || 0),
            evidence: bullet,
            pattern: patternStr,
            summary: def.summary || category,
          });
          firedCategories.add(category);
          break;
        }
      }
    }
  }

  if (flags.length === 0) {
    return { pts: 0, flags: [], reason: "no_pattern_matched" };
  }

  const rawSum = flags.reduce((acc, f) => acc + f.severity, 0);
  const pts = Math.max(rawSum, PENALTY_CAP);

  return { pts, flags, reason: "match" };
}
