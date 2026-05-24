/**
 * v3SignalAdapter.js
 *
 * Resolves the SWS V3 100-pt breakdown for one Earnings Watch event so
 * the predictor can score on the *decomposed* V3 pillars (future, past,
 * valuation, overlay) instead of echoing the single blunt composite
 * verdict — which is what made 73% of predictions cluster on INLINE.
 *
 * Resolution priority (richest source first):
 *   1. upcoming_earnings row  — the gold-standard SWS pick row, breakdown
 *                               already computed by the SWS pipeline
 *   2. any picks-latest row   — same breakdown, stock filed in another
 *                               section (top_ranked, deep_value, avoid…)
 *   3. inline computeV3Score  — for events in NO picks section at all;
 *                               computed straight off the SWS deep file
 *
 * Pure function — `universe` (the {r1m,r3m,r1y} percentile bands) is
 * injected so it's testable without disk. computeV3Score degrades
 * gracefully when `universe` is null (momentum imputed); none of the
 * pillars the predictor reads depend on it anyway.
 */

import { computeV4Score, verdictV4FromScore } from "../swsScoringV4.js";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// NOTE: the `signals.v3` bus key + the v3_* return keys below are retained as
// internal labels but now carry V4 data (V3 was deleted in the 2026-05
// migration). The breakdown is a v4_breakdown.
//
// A breakdown is usable by the predictor only if the pillars it scores on are
// present and numeric. Anything less and we fall through to the next source.
function hasUsableBreakdown(b) {
  return (
    b &&
    typeof b === "object" &&
    num(b.pts_future) != null &&
    num(b.pts_past) != null &&
    num(b.pts_fv_total) != null &&
    num(b.pts_overlay) != null
  );
}

function fromPickRow(row, source) {
  if (!row || !hasUsableBreakdown(row.v4_breakdown)) return null;
  return {
    v3_score_100: num(row.v4_score_100),
    v3_verdict: row.v4_verdict || null,
    v3_breakdown: row.v4_breakdown,
    source,
  };
}

/**
 * @param {object} args
 * @param {object} [args.swsDeep]     SWS deep-file object (overview.snowflake …)
 * @param {object} [args.pickRow]     flattened picks-latest row for the ticker
 * @param {object} [args.upcomingRow] picks-latest upcoming_earnings row
 * @param {object} [args.universe]    {r1m,r3m,r1y} sorted bands, or null
 * @returns {{v3_score_100, v3_verdict, v3_breakdown, source}|null}
 */
export function extractV3SignalsForEvent({ swsDeep, pickRow, upcomingRow, universe } = {}) {
  // 1 — upcoming_earnings row (richest, earnings-specific).
  const fromUpcoming = fromPickRow(upcomingRow, "upcoming");
  if (fromUpcoming) return fromUpcoming;

  // 2 — any other picks-latest section row.
  const fromPicks = fromPickRow(pickRow, "picks");
  if (fromPicks) return fromPicks;

  // 3 — inline compute off the SWS deep file.
  if (swsDeep && swsDeep.overview) {
    try {
      const computed = computeV4Score(swsDeep, { universe: universe || null });
      if (computed && hasUsableBreakdown(computed.v4_breakdown)) {
        return {
          v3_score_100: num(computed.v4_score_100),
          v3_verdict: verdictV4FromScore(computed.v4_score_100),
          v3_breakdown: computed.v4_breakdown,
          source: "computed",
        };
      }
    } catch {
      // fall through to null — predictor treats a missing V3 block as
      // 0-pts on the V3 components rather than erroring.
    }
  }

  return null;
}
