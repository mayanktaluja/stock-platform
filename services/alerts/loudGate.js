/**
 * Loudness gate for the Telegram alert path.
 *
 * THE PROBLEM. Today `breaking` (which drives the 🔴 prefix, the loud
 * notification, AND the IMPORTANT-group cross-post) is simply
 * `macroKeywordHit || watchlistHit`. Because macroBreakingGate's vocabulary
 * includes broad terms like "trump", "nifty", "sensex" and "oil price", almost
 * every routine market update pings loudly. That is the alert-fatigue bug.
 *
 * THE NAIVE FIX DOESN'T WORK. A flat "heuristic impact >= 6" gate fails badly,
 * because the deterministic heuristic scores *sentiment prose*, not event
 * severity:
 *
 *   "Missile strike on oil facility, crude surges"   → impact ≈ 4.4  (SILENCED!)
 *   "Stocks rally, gains surge, profits beat, record" → impact ≈ 6.0  (LOUD)
 *
 * So loudness is scored on TWO axes and needs both:
 *   1. KEYWORD SEVERITY  — what *kind* of event is this? (war/crash vs trump)
 *   2. PROSE INTENSITY   — how strongly is it worded? (the heuristic's impact)
 *
 * A watchlist hit bypasses both: it's the owner's own holding.
 */

import { heuristicClassifyCluster } from "../newsWire/wireHeuristic.js";

// Tunable without a code change.
export const LOUD_MED_MIN = Number(process.env.ALERTS_LOUD_MED_MIN) || 5;
export const LOUD_LOW_MIN = Number(process.env.ALERTS_LOUD_LOW_MIN) || 7;

/**
 * Severity tiers over macroBreakingGate's MACRO_KEYWORDS vocabulary.
 * Anything matched but unlisted defaults to LOW (conservative — stays quiet).
 *
 *  HIGH — the event itself is the news. Ping regardless of wording.
 *  MED  — market-moving, but needs some prose intensity to be urgent.
 *  LOW  — the noisy terms that appear in every routine update.
 */
export const MACRO_SEVERITY = {
  // ── HIGH ───────────────────────────────────────────────────────────────
  war: "HIGH", missile: "HIGH", airstrike: "HIGH", invasion: "HIGH",
  nuclear: "HIGH", "strait of hormuz": "HIGH", ceasefire: "HIGH",
  "market crash": "HIGH", "circuit breaker": "HIGH", "nifty crash": "HIGH",
  default: "HIGH",
  fomc: "HIGH", "rate decision": "HIGH", "rate hike": "HIGH", "rate cut": "HIGH",

  // ── MED ────────────────────────────────────────────────────────────────
  fed: "MED", powell: "MED", "jerome powell": "MED", "interest rate": "MED",
  "basis points": "MED", bps: "MED", hawkish: "MED", dovish: "MED",
  quantitative: "MED", rbi: "MED", "repo rate": "MED", mpc: "MED",
  "reserve bank": "MED", tariff: "MED", sanction: "MED", "executive order": "MED",
  opec: "MED", "crude oil": "MED", inflation: "MED", cpi: "MED",
  "jobs report": "MED", nonfarm: "MED", gdp: "MED", recession: "MED",
  downgrade: "MED", selloff: "MED",

  // ── LOW ────────────────────────────────────────────────────────────────
  trump: "LOW", "white house": "LOW", "oil price": "LOW",
  nifty: "LOW", sensex: "LOW",
};

const RANK = { HIGH: 3, MED: 2, LOW: 1 };

/** Highest severity tier among the matched macro keywords. null when none matched. */
export function severityOf(macroHits) {
  if (!Array.isArray(macroHits) || macroHits.length === 0) return null;
  let best = null;
  for (const h of macroHits) {
    const tier = MACRO_SEVERITY[String(h).toLowerCase()] || "LOW";
    if (!best || RANK[tier] > RANK[best]) best = tier;
  }
  return best;
}

/**
 * INTRINSIC prose intensity for one message (0-10).
 *
 * Deliberately passes breaking:false into the heuristic. The heuristic adds +2
 * for `breaking`, and `breaking` here would mean "a macro keyword matched" —
 * the very thing we're about to gate on. Feeding it back in would inflate every
 * macro hit past the threshold and defeat the gate.
 */
export function scoreIntrinsicImpact({ text, symbols = [], category = "markets" }, { now = Date.now() } = {}) {
  const pseudoCluster = {
    representative: text,
    members: [{ text }],
    source_count: 1,
    breaking: false,
    symbols,
    categories: [category],
  };
  const sig = heuristicClassifyCluster(pseudoCluster, { now });
  return { impact: sig.impact, direction: sig.direction };
}

// ─────────────────────────────────────────────────────────────────────────────
// POLICY — this is the knob that decides what wakes you at 3am.
//
// Current rule:
//   • watchlist ticker mentioned  → ALWAYS loud (it's your money)
//   • HIGH severity keyword       → ALWAYS loud (war / crash / rate decision)
//   • MED severity keyword        → loud only if prose intensity >= LOUD_MED_MIN (5)
//   • LOW severity keyword        → loud only if prose intensity >= LOUD_LOW_MIN (7)
//   • no macro keyword            → never loud (still posts silently to its topic)
//
// Coverage is untouched either way: a non-loud message still posts SILENTLY into
// its category topic. "Not loud" means no notification + no IMPORTANT cross-post.
// ─────────────────────────────────────────────────────────────────────────────
export function shouldGoLoud({ tier, watchlistHit, impact, medMin = LOUD_MED_MIN, lowMin = LOUD_LOW_MIN }) {
  if (watchlistHit) return true;
  if (tier === "HIGH") return true;
  if (tier === "MED") return Number(impact) >= medMin;
  if (tier === "LOW") return Number(impact) >= lowMin;
  return false;
}

/**
 * The injectable gate the router consumes.
 * decide({ text, macroHits, macroHit, watchlistHit, symbols, category })
 *   → { loud, impact, tier, direction }
 * Never throws — on any failure it returns the legacy behaviour (loud = macro||watchlist).
 */
export function makeLoudGate({ medMin = LOUD_MED_MIN, lowMin = LOUD_LOW_MIN, now = () => Date.now() } = {}) {
  return {
    decide({ text, macroHits = [], macroHit = false, watchlistHit = false, symbols = [], category = "markets" }) {
      try {
        const tier = severityOf(macroHits);
        const { impact, direction } = scoreIntrinsicImpact({ text, symbols, category }, { now: now() });
        return { loud: shouldGoLoud({ tier, watchlistHit, impact, medMin, lowMin }), impact, tier, direction };
      } catch {
        return { loud: Boolean(macroHit) || Boolean(watchlistHit), impact: null, tier: null, direction: "neutral" };
      }
    },
  };
}

export default { makeLoudGate, shouldGoLoud, severityOf, scoreIntrinsicImpact, MACRO_SEVERITY, LOUD_MED_MIN, LOUD_LOW_MIN };
