/**
 * Risk Lab — Quality Lens / Counter-Thesis Parser.
 *
 * picks-latest.json[*].counter_thesis is a structured object SWS emits for
 * most stocks:
 *   {
 *     verdict_bias: "bullish" | "bearish",
 *     text: "<narrative>",
 *     falsification_trigger: [
 *       "next quarterly result misses estimates",
 *       "a new India-risk overlay materialises (ASM/GSM, promoter pledge spike)",
 *       "upside vs SWS FV compresses below 5% (currently 87.8%)"
 *     ]
 *   }
 *
 * The bullish bias is the dominant case (current picks-latest: 2339 stocks
 * with counter_thesis, 388 bearish = 17%). For bullish-bias stocks, the
 * falsification_trigger array describes what would PROVE THE BULL CASE
 * WRONG — which means SWS itself is pre-flagging the quality / risk
 * concerns the LLM signal might not weight properly.
 *
 * Parser logic:
 *   - For verdict_bias === "bullish":
 *     * Match each falsification_trigger entry against quality keywords
 *       (same taxonomy as riskTextClassifier — interest_coverage, margin_
 *       pressure, etc., plus a "earnings_miss_trigger" category for the
 *       templated "next quarterly result misses estimates" pattern)
 *     * Each unique category fires once, -1 pt per match (lighter than
 *       riskTextClassifier's -2 because counter-thesis triggers are
 *       templated and less specific)
 *     * Cap at -3
 *   - For verdict_bias === "bearish":
 *     * Triggers are bullishness-validating events — skip (don't penalise
 *       a bearish thesis's "what would falsify me" list)
 *   - For verdict_bias missing or "neutral":
 *     * Skip
 *
 * The counter_thesis.text is also parsed for quality keywords when bullish,
 * with the same -1 pt-per-category convention.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEYWORDS_PATH = path.resolve(__dirname, "..", "..", "..", "data", "risk-lab", "_quality-keywords.json");

const PENALTY_PER_MATCH = -1;
const PENALTY_CAP = -3;

// Additional patterns specific to counter-thesis templates. These don't
// appear in standalone risks[] text — they're SWS's stylised "what would
// falsify my bullish call" boilerplate. Worth flagging separately because
// they're explicit acknowledgments that the bullish thesis has known
// failure modes.
const COUNTER_THESIS_PATTERNS = {
  earnings_miss_trigger: {
    patterns: [
      /next\s+quarterly\s+result\s+miss(?:es)?\s+(?:consensus|estimates)/i,
      /quarterly\s+result\s+miss(?:es)?\s+(?:by|consensus)/i,
    ],
    severity: -1,
    summary: "SWS flagged 'next quarter misses estimates' as a bull-thesis killer — quality risk explicit in counter-thesis",
  },
  india_risk_trigger: {
    patterns: [
      /india(?:n)?[-\s]+risk\s+(?:overlay|signal|flag)/i,
      /asm\s*\/\s*gsm/i,
      /promoter\s+pledge\s+(?:spike|rises?|increases?)/i,
    ],
    severity: -1,
    summary: "SWS flagged India-specific regulatory / governance risk in falsification triggers",
  },
  valuation_compression: {
    patterns: [
      /upside\s+(?:vs|to)\s+(?:sws\s+)?fv\s+compress(?:es)?/i,
      /(?:fair\s+value\s+)?upside\s+(?:compress|narrows)/i,
    ],
    severity: -1,
    summary: "SWS flagged valuation compression risk — upside cushion may evaporate",
  },
};

let _keywordsCache = null;
function loadGenericKeywords(keywordsPath) {
  if (_keywordsCache && _keywordsCache._path === "__test__") return _keywordsCache.data;
  const p = keywordsPath || DEFAULT_KEYWORDS_PATH;
  if (_keywordsCache && _keywordsCache._path === p) return _keywordsCache.data;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    const data = Object.fromEntries(
      Object.entries(raw).filter(([key]) => !key.startsWith("_")),
    );
    _keywordsCache = { _path: p, data };
    return data;
  } catch (err) {
    console.warn(`[risk-lab/quality] counter-thesis loadKeywords failed: ${err.message}`);
    return {};
  }
}

export function _setKeywordsForTest(data) {
  _keywordsCache = data === null ? null : { _path: "__test__", data };
}

/**
 * Parse a single text/trigger string for quality concerns. Returns array
 * of flag objects (possibly empty).
 */
function matchAllPatterns(text, generic, contextLabel) {
  if (!text || typeof text !== "string") return [];
  const flags = [];

  // First check the counter-thesis-specific templates
  for (const [category, def] of Object.entries(COUNTER_THESIS_PATTERNS)) {
    for (const pattern of def.patterns) {
      if (pattern.test(text)) {
        flags.push({
          category,
          severity: def.severity,
          evidence: text,
          context: contextLabel,
          summary: def.summary,
        });
        break;
      }
    }
  }

  // Then check the generic quality taxonomy (interest_coverage, margin_
  // pressure, etc.) but at half severity since counter-thesis snippets are
  // templated and less specific than full risks[] bullets.
  for (const [category, def] of Object.entries(generic)) {
    if (!def || !Array.isArray(def.patterns)) continue;
    for (const patternStr of def.patterns) {
      let pattern;
      try {
        pattern = new RegExp(patternStr, "i");
      } catch {
        continue;
      }
      if (pattern.test(text)) {
        flags.push({
          category,
          severity: PENALTY_PER_MATCH,
          evidence: text,
          context: contextLabel,
          summary: def.summary || category,
        });
        break;
      }
    }
  }

  return flags;
}

/**
 * Parse a counter_thesis object for quality concerns.
 *
 * @param {object} counterThesis — picks-latest row's counter_thesis field
 * @param {object} opts — { keywordsPath?: string }
 * @returns {object} { pts, flags[], reason }
 */
export function parseCounterThesis(counterThesis, opts = {}) {
  if (!counterThesis || typeof counterThesis !== "object") {
    return { pts: 0, flags: [], reason: "no_counter_thesis" };
  }
  if (counterThesis.verdict_bias !== "bullish") {
    // Bearish or neutral — don't penalise
    return { pts: 0, flags: [], reason: `bias_${counterThesis.verdict_bias || "missing"}` };
  }

  const generic = loadGenericKeywords(opts.keywordsPath);

  const allFlags = [];
  const firedCategories = new Set();

  function pushUnique(flagList) {
    for (const f of flagList) {
      if (firedCategories.has(f.category)) continue;
      firedCategories.add(f.category);
      allFlags.push(f);
    }
  }

  // Parse counter_thesis.text
  if (counterThesis.text) {
    pushUnique(matchAllPatterns(counterThesis.text, generic, "counter_thesis.text"));
  }

  // Parse falsification_trigger (singular, current SWS schema) and
  // falsification_triggers (plural, fallback for future schema changes)
  const triggers = counterThesis.falsification_trigger ||
    counterThesis.falsification_triggers ||
    [];
  if (Array.isArray(triggers)) {
    for (const trigger of triggers) {
      pushUnique(matchAllPatterns(trigger, generic, "falsification_trigger"));
    }
  }

  if (allFlags.length === 0) {
    return { pts: 0, flags: [], reason: "no_pattern_matched" };
  }

  const rawSum = allFlags.reduce((acc, f) => acc + f.severity, 0);
  const pts = Math.max(rawSum, PENALTY_CAP);

  return { pts, flags: allFlags, reason: "match" };
}
