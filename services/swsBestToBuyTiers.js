// Read-side tiering for the "Best to Buy Now" Picks section.
//
// The scoring engine already stamps an `entry_band` on every pick card
// (services/swsIndiaSectionPolicy.js → buildEntryBand, attached in
// services/swsScoring.js:pickCardFields). `best_to_buy_now` is pre-filtered to
// `fresh_buy_eligible` cards only, so the "Wait for price" and "Watchlist only"
// names live in OTHER sections. This module derives all three tiers from the
// deduped union of section cards — pure function, no I/O, no import from the
// scoring engine. It cannot change what qualifies; it only re-groups by intent.
//
// Caveat surfaced in the UI subtitle: Wait/Watchlist are drawn from quality
// names that already made some curated section but miss on price or a single
// trust gate — NOT a full-universe rescan (picks-latest.json holds only the
// curated sections, not the whole universe).

// Hard-fail reason codes that mean the STOCK itself is suspect (trust gates).
// Mirrors the hard-fail set in services/swsIndiaSectionPolicy.js, minus the
// pure price-band code `above_no_buy_cap` and the construction-blockers
// (`price_missing`, `fair_value_missing`) which only mean "no entry band".
export const TRUST_GATE_CODES = new Set([
  "fv_low_confidence",
  "fv_outlier",
  "upside_not_positive",
  "upside_outlier",
  "upside_too_small",
  "surveillance_gsm",
  "surveillance_asm",
  "score_below_floor",
  "snowflake_below_floor",
  "market_cap_below_floor",
  "data_stale",
  "freshness_missing",
]);

// "Clears the engine" floor — STRONG verdict cutoff (swsScoringV4.js verdict
// thresholds). Wait/Watchlist names must be genuinely good, just blocked on
// price or one gate, so weak names don't flood the buckets.
export const QUALITY_SCORE_FLOOR = 47;

export const BUY_NOW_CAP = 25;
export const WAIT_FOR_PRICE_CAP = 15;
export const WATCHLIST_ONLY_CAP = 15;

function normTicker(t) {
  if (typeof t !== "string") return "";
  return t.trim().toUpperCase().split(".")[0];
}

function reasonCodes(card) {
  const reasons = card && card.entry_band && Array.isArray(card.entry_band.reasons)
    ? card.entry_band.reasons
    : [];
  return reasons.map((r) => r && r.code).filter(Boolean);
}

function scoreOf(card) {
  const s = Number(card && card.v4_score_100);
  return Number.isFinite(s) ? s : -Infinity;
}

const byScoreDesc = (a, b) => scoreOf(b) - scoreOf(a);

/**
 * Split picks into Buy now / Wait for price / Watchlist only tiers.
 * @param {Record<string, any[]>} sections - the `sections` object from picks-latest.json
 * @returns {{ buy_now: any[], wait_for_price: any[], watchlist_only: any[] }}
 */
export function buildBestToBuyTiers(sections) {
  const secs = sections && typeof sections === "object" ? sections : {};

  // Buy now = the canonical, already-capped best_to_buy_now list (all
  // fresh_buy_eligible). Keep it verbatim so the tier matches today's section.
  const buyNow = Array.isArray(secs.best_to_buy_now)
    ? secs.best_to_buy_now.slice(0, BUY_NOW_CAP)
    : [];

  // Pool = every other section card, deduped by ticker, excluding Buy-now names.
  const seen = new Set(buyNow.map((c) => normTicker(c && c.ticker)));
  const pool = [];
  for (const key of Object.keys(secs)) {
    if (!Array.isArray(secs[key])) continue;
    for (const card of secs[key]) {
      const t = normTicker(card && card.ticker);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      pool.push(card);
    }
  }

  const wait = [];
  const watch = [];
  for (const card of pool) {
    if (scoreOf(card) < QUALITY_SCORE_FLOOR) continue; // must clear the engine
    const eb = card.entry_band || {};
    const trust = reasonCodes(card).filter((code) => TRUST_GATE_CODES.has(code));

    if (eb.entry_state === "NO_BUY_ABOVE" && trust.length === 0) {
      // Quality name, only blocker is price above the no-buy band.
      wait.push(card);
    } else if (eb.entry_state !== "NO_BUY_ABOVE" && trust.length === 1) {
      // Good score, misses exactly one trust gate.
      watch.push(card);
    }
  }

  return {
    buy_now: buyNow,
    wait_for_price: wait.sort(byScoreDesc).slice(0, WAIT_FOR_PRICE_CAP),
    watchlist_only: watch.sort(byScoreDesc).slice(0, WATCHLIST_ONLY_CAP),
  };
}

export default buildBestToBuyTiers;
