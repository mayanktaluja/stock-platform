/**
 * Sector Outlook — Theme Taxonomy.
 *
 * Single source of truth for the 8 news themes the bottom-up sector
 * signal aggregates. Bumping any value in this file (theme labels, sign,
 * intensity, or time weights) is a CLASSIFIER_VERSION change — every
 * downstream cache key MUST include the version so a bump cold-invalidates.
 *
 * The 8 themes are intentionally coarse. The adversarial review of the
 * 16-class first draft argued that single-shot LLM-flash macro-F1 on
 * 10+ classes is ~0.55-0.70, and that mis-classifications compound at
 * the sector level rather than averaging out — same theme lands in the
 * same sector tally regardless of which specific stock. Collapsing to
 * 8 themes + a separate sign axis dramatically reduces the class-cardinality
 * the LLM has to discriminate.
 *
 * Sign is a separate axis (NEGATIVE / NEUTRAL / POSITIVE). The classifier
 * emits theme + sign + intensity (1..3) + confidence. The aggregator
 * combines sign × intensity to compute the sector tailwind index.
 */

export const THEME_LABELS = Object.freeze([
  "CAPACITY_CAPEX",        // capacity expansion, plant commissioning, capex commitment
  "M_AND_A",               // acquisition, divestiture, demerger, JV restructure
  "ORDER_WINS",            // large contract/order wins, backlog ramp
  "REGULATORY_EVENT",      // policy, tariff, license, ban, subsidy (signed)
  "MARGIN_MOVE",           // gross/operating margin expansion or compression (signed)
  "EARNINGS_MOVE",         // quarterly beat or miss (signed)
  "STRATEGIC_GEOPOLITICAL",// geopolitical, trade-relations, sanctions, currency (signed)
  "NEUTRAL",               // no clear theme; default
]);

export const VALID_THEMES = new Set(THEME_LABELS);

export const CLASSIFIER_VERSION = "sector-theme-v1";

/**
 * Per-theme weight at each time horizon. Used by the aggregator to blend
 * the 30d / 90d / 365d rolling windows into the 3-12m and 12-24m horizon
 * signals.
 *
 * The intuition: ORDER_WINS and EARNINGS_MOVE are short-horizon signals
 * (months); CAPACITY_CAPEX, STRATEGIC_GEOPOLITICAL, and REGULATORY_EVENT
 * are structural (years).
 *
 * Values are NOT probabilities — they're multipliers applied to the
 * (sign × intensity) signal when projecting onto a horizon. Sum across
 * the row need not equal 1.
 */
export const THEME_TIME_WEIGHT = Object.freeze({
  CAPACITY_CAPEX:          { short: 0.1, medium: 0.5, long: 0.8 },
  M_AND_A:                 { short: 0.3, medium: 0.7, long: 0.6 },
  ORDER_WINS:              { short: 0.5, medium: 0.8, long: 0.5 },
  REGULATORY_EVENT:        { short: 0.4, medium: 0.8, long: 0.7 },
  MARGIN_MOVE:             { short: 0.7, medium: 0.5, long: 0.2 },
  EARNINGS_MOVE:           { short: 0.9, medium: 0.3, long: 0.1 },
  STRATEGIC_GEOPOLITICAL:  { short: 0.3, medium: 0.7, long: 0.9 },
  NEUTRAL:                 { short: 0.0, medium: 0.0, long: 0.0 },
});

/**
 * Alias map for defensive normalization of LLM output. The LLM may emit
 * synonyms or variant casings; this collapses them to canonical labels.
 * If the input doesn't match any canonical or alias, returns "NEUTRAL".
 */
const THEME_ALIASES = Object.freeze({
  // CAPACITY_CAPEX
  "capacity": "CAPACITY_CAPEX",
  "capacity_expansion": "CAPACITY_CAPEX",
  "capex": "CAPACITY_CAPEX",
  "capacity expansion": "CAPACITY_CAPEX",
  "expansion": "CAPACITY_CAPEX",
  "plant": "CAPACITY_CAPEX",
  "facility": "CAPACITY_CAPEX",
  // M_AND_A
  "ma": "M_AND_A",
  "m&a": "M_AND_A",
  "m and a": "M_AND_A",
  "acquisition": "M_AND_A",
  "merger": "M_AND_A",
  "divestiture": "M_AND_A",
  "demerger": "M_AND_A",
  "jv": "M_AND_A",
  // ORDER_WINS
  "orders": "ORDER_WINS",
  "order_win": "ORDER_WINS",
  "contract": "ORDER_WINS",
  "contract_win": "ORDER_WINS",
  "backlog": "ORDER_WINS",
  "order book": "ORDER_WINS",
  // REGULATORY_EVENT
  "regulatory": "REGULATORY_EVENT",
  "regulation": "REGULATORY_EVENT",
  "policy": "REGULATORY_EVENT",
  "tariff": "REGULATORY_EVENT",
  "subsidy": "REGULATORY_EVENT",
  "license": "REGULATORY_EVENT",
  "ban": "REGULATORY_EVENT",
  // MARGIN_MOVE
  "margin": "MARGIN_MOVE",
  "margins": "MARGIN_MOVE",
  "margin_expansion": "MARGIN_MOVE",
  "margin_pressure": "MARGIN_MOVE",
  // EARNINGS_MOVE
  "earnings": "EARNINGS_MOVE",
  "earnings_beat": "EARNINGS_MOVE",
  "earnings_miss": "EARNINGS_MOVE",
  "beat": "EARNINGS_MOVE",
  "miss": "EARNINGS_MOVE",
  "results": "EARNINGS_MOVE",
  // STRATEGIC_GEOPOLITICAL
  "geopolitical": "STRATEGIC_GEOPOLITICAL",
  "geopolitics": "STRATEGIC_GEOPOLITICAL",
  "strategic": "STRATEGIC_GEOPOLITICAL",
  "trade": "STRATEGIC_GEOPOLITICAL",
  "sanctions": "STRATEGIC_GEOPOLITICAL",
  "currency": "STRATEGIC_GEOPOLITICAL",
  // NEUTRAL
  "none": "NEUTRAL",
  "n/a": "NEUTRAL",
  "unknown": "NEUTRAL",
  "other": "NEUTRAL",
  "": "NEUTRAL",
});

/**
 * Normalize an LLM-emitted or external theme string to a canonical label.
 * Defaults to NEUTRAL on miss — never throws. Case-insensitive.
 *
 * @param {string|null|undefined} raw
 * @returns {string} one of THEME_LABELS
 */
export function canonicalizeTheme(raw) {
  if (raw == null) return "NEUTRAL";
  const s = String(raw).trim();
  if (s === "") return "NEUTRAL";
  // Already-canonical check (exact match)
  if (VALID_THEMES.has(s)) return s;
  // Try uppercase (handles "capacity_capex" → "CAPACITY_CAPEX")
  const upper = s.toUpperCase().replace(/\s+/g, "_").replace(/-+/g, "_");
  if (VALID_THEMES.has(upper)) return upper;
  // Alias map (case-insensitive)
  const lower = s.toLowerCase().replace(/_/g, " ").trim();
  if (THEME_ALIASES[lower]) return THEME_ALIASES[lower];
  // Single-word lookup
  const oneWord = lower.split(/\s+/)[0];
  if (THEME_ALIASES[oneWord]) return THEME_ALIASES[oneWord];
  return "NEUTRAL";
}

/**
 * Confidence threshold below which the classifier should emit UNCLASSIFIED.
 * The aggregator silently drops UNCLASSIFIED items (they don't contribute
 * to any tally). Used by both the heuristic and LLM classifier.
 */
export const MIN_CONFIDENCE = 0.55;

/**
 * Top-2 confidence gap below which the LLM classifier should emit
 * UNCLASSIFIED. Catches cases where the LLM is split between two themes —
 * almost-as-good-as-either is functionally a coin flip, so don't pollute
 * the sector tally.
 */
export const MIN_TOP2_GAP = 0.15;

/**
 * Valid sign axis for theme classifications. The aggregator multiplies
 * sign × intensity to get the signed signal contribution.
 */
export const VALID_SIGNS = Object.freeze([-1, 0, 1]);

/**
 * Valid intensity axis for theme classifications. 1 = minor mention,
 * 2 = clearly material, 3 = blockbuster / regime-defining.
 */
export const VALID_INTENSITIES = Object.freeze([1, 2, 3]);

export default {
  THEME_LABELS,
  VALID_THEMES,
  CLASSIFIER_VERSION,
  THEME_TIME_WEIGHT,
  canonicalizeTheme,
  MIN_CONFIDENCE,
  MIN_TOP2_GAP,
  VALID_SIGNS,
  VALID_INTENSITIES,
};
