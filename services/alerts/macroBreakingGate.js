/**
 * Macro breaking-news keyword gate — the REGIME-class loud-alert pre-filter.
 *
 * Detects high-impact, market-moving / breaking headlines by keyword so the
 * news router can mark them loud (🔴 breaking). This fires on KEYWORD ALONE —
 * there is no ticker backstop the way watchlistGate.js requires — so the curated
 * list is deliberately CONSERVATIVE and favours multi-word / high-signal terms
 * to limit false positives (bare "ease"/"forex"/"budget"/"barrel" are avoided).
 *
 * Seeded-from-but-independent-of macroRegime's REGIME_KEYWORDS: regime SCORING
 * (which way is the market leaning, with weights) and breaking-alert TRIGGERING
 * (is this headline loud enough to interrupt) are different concerns with
 * different precision/recall trade-offs, so the lists are copied-and-curated
 * here rather than imported. Editing one must not silently reshape the other.
 *
 * All matching is word-boundary anchored with the SAME posture as
 * watchlistGate.js: a non-alphanumeric (or string edge) is required on both
 * sides, so "fed" never fires inside "fedex" and "rate hike" never inside
 * "ratehiked".
 */

// Curated, conservative set of broad-macro / breaking terms. Multi-word where
// possible. Keep bare noisy single words OUT (see doc comment).
const MACRO_KEYWORDS = [
  // Fed / monetary
  "fed",
  "fomc",
  "powell",
  "jerome powell",
  "rate hike",
  "rate cut",
  "interest rate",
  "rate decision",
  "basis points",
  "bps",
  "hawkish",
  "dovish",
  "quantitative",
  // India macro
  "rbi",
  "repo rate",
  "mpc",
  "reserve bank",
  // Politics / Trump
  "trump",
  "white house",
  "tariff",
  "sanction",
  "executive order",
  // Geopolitics / war
  "war",
  "missile",
  "airstrike",
  "ceasefire",
  "invasion",
  "nuclear",
  "strait of hormuz",
  "opec",
  // Energy / inflation
  "crude oil",
  "oil price",
  "inflation",
  "cpi",
  "jobs report",
  "nonfarm",
  "gdp",
  // Risk events
  "recession",
  "market crash",
  "circuit breaker",
  "selloff",
  "default",
  "downgrade",
  // India indices
  "nifty",
  "sensex",
  "nifty crash",
];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile the curated keyword list (plus any extraKeywords) into ONE
 * case-insensitive matcher. Tokens are anchored on non-word boundaries — we
 * can't lean on plain \b because some terms could otherwise mis-fire, so we
 * require a non-alphanumeric (or string edge) on both sides. Longest-first so a
 * superset term ("nifty crash") wins the alternation over its substring
 * ("nifty").
 * Returns { re: RegExp }.
 */
export function compileMacroGate(extraKeywords = []) {
  const extra = Array.isArray(extraKeywords) ? extraKeywords : [];
  const safe = [...new Set([...MACRO_KEYWORDS, ...extra].map((t) => String(t || "").trim().toLowerCase()).filter(Boolean))]
    .sort((a, b) => b.length - a.length) // longest-first so "nifty crash" wins over "nifty"
    .map(escapeRegex);
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${safe.join("|")})(?![A-Za-z0-9])`, "ig");
  return { re };
}

/**
 * Test a headline / body against the compiled macro gate.
 *   { matched:false, hits:[] }
 *   { matched:true, hits:["fed","bps"] }
 * hits = the distinct matched terms, lowercased, collected via a global regex.
 */
export function matchMacro(text, compiled) {
  const str = String(text || "");
  if (!str.trim() || !compiled || !compiled.re) return { matched: false, hits: [] };
  compiled.re.lastIndex = 0; // global regex is stateful — reset before reuse
  const hits = [...new Set((str.match(compiled.re) || []).map((m) => m.toLowerCase()))];
  return { matched: hits.length > 0, hits };
}
