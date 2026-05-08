/**
 * Pure diff utility — computes per-stock-per-section "newly added" / "trending"
 * status by comparing today's picks-latest sections to the prior nightly run.
 *
 * Returns the same `currentSections` shape with `section_status` stamped on
 * every per-section stock object. No fs, no side effects.
 *
 * SEBI honesty constraints baked in:
 *   • "Trending" threshold scales with section size — a +10 jump in a 13-stock
 *     list is statistical noise, not momentum. Sections under 15 suppress the
 *     Trending badge entirely; Newly Added still applies.
 *   • The AVOID section suppresses Trending — climbing the avoid list is not
 *     a buy signal. Newly Added stays (informational that a stock just got
 *     newly flagged for avoidance); the UI relabels it as "Newly Flagged".
 */

export const AVOID_SECTION_KEY = "avoid";
const TRENDING_MIN_SECTION_SIZE = 15;
const TRENDING_LARGE_SECTION_SIZE = 30;
const TRENDING_LARGE_DELTA = 10;

// Returns null when Trending should be suppressed for this section's size.
export function trendingThresholdForSize(currentSize) {
  if (currentSize < TRENDING_MIN_SECTION_SIZE) return null;
  if (currentSize >= TRENDING_LARGE_SECTION_SIZE) return TRENDING_LARGE_DELTA;
  return Math.ceil(currentSize * 0.33);
}

function buildPriorRankIndex(priorSections) {
  const index = new Map();
  if (!priorSections || typeof priorSections !== "object") return index;
  for (const [sectionKey, items] of Object.entries(priorSections)) {
    if (!Array.isArray(items)) continue;
    const tickerMap = new Map();
    items.forEach((s, i) => {
      if (s && typeof s.ticker === "string" && !tickerMap.has(s.ticker)) {
        tickerMap.set(s.ticker, i + 1);
      }
    });
    index.set(sectionKey, tickerMap);
  }
  return index;
}

function neutralStatus(currentRank) {
  return {
    newly_added: false,
    trending: false,
    prior_rank: null,
    current_rank: currentRank,
    rank_delta: null,
    prior_scanned_at: null,
  };
}

export function computeSectionStatus(currentSections, priorSections, priorScannedAt) {
  if (!currentSections || typeof currentSections !== "object") return currentSections;
  const baseline = !priorSections || typeof priorSections !== "object";
  const priorIndex = baseline ? new Map() : buildPriorRankIndex(priorSections);

  for (const [sectionKey, items] of Object.entries(currentSections)) {
    if (!Array.isArray(items)) continue;
    const sectionPriorRanks = priorIndex.get(sectionKey);
    const threshold = trendingThresholdForSize(items.length);
    const isAvoid = sectionKey === AVOID_SECTION_KEY;

    items.forEach((stock, i) => {
      if (!stock || typeof stock !== "object") return;
      const currentRank = i + 1;

      if (baseline) {
        stock.section_status = neutralStatus(currentRank);
        return;
      }

      const priorRank = sectionPriorRanks?.get(stock.ticker) ?? null;
      const newlyAdded = priorRank === null;
      const rankDelta = priorRank === null ? null : priorRank - currentRank;

      const trending =
        !newlyAdded &&
        !isAvoid &&
        threshold !== null &&
        rankDelta !== null &&
        rankDelta >= threshold;

      stock.section_status = {
        newly_added: newlyAdded,
        trending,
        prior_rank: priorRank,
        current_rank: currentRank,
        rank_delta: rankDelta,
        prior_scanned_at: priorScannedAt || null,
      };
    });
  }

  return currentSections;
}
