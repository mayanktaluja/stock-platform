import { num } from "../swsScoring.js";
import { ALL_TOPUP_ACTIONS, CAPPED_TOPUP_ACTION } from "../actionLadder.js";
import { candidateBaseRank, holdingRankInputs } from "./addCandidateRank.js";

// Within-book Top-up badge cap (lever 1 of the over-firing fix).
//
// scoreBandAction is absolute per-stock, so on a book drawn from the SWS
// discount sections most rows can legitimately carry a Top-up badge at once
// — a decision surface, not a shortlist. This post-pass ranks every Top-up
// candidate with the SAME formula the construction plan uses to fund adds
// (candidateBaseRank) and keeps only the top k as full Top-up badges; the
// rest demote to "Top-up (if funded)" — still eligible, visually secondary,
// never minted as ledger recommendations.
//
// Runs over scoredHoldings BEFORE buildSWSReport (server.js runSWSAnalysis)
// so tiers, baskets, actionMix, holdingsByAction, ISSUED events, and the
// construction plan all see capped actions. Mirrors the mutate-in-place
// pattern of applyCooldownDemotion (services/recommendationMemory.js).
//
// Hard-override reductions carry reduction actions and can never enter the
// candidate set — the cap is structurally unable to touch sell-side risk
// signals.

export const TOPUP_CAP_VERSION = "topup-cap-v1";
export const TOPUP_CAP_MAX = 5;
export const TOPUP_CAP_PCT_OF_BOOK = 0.10;

export function isTopUpCapEnabled(env = process.env) {
  return env.SWS_TOPUP_CAP !== "0"; // default ON
}

// Strict k = min(5, ceil(10% of covered book)), k >= 1 for any non-empty book.
export function computeTopUpCapK(bookCount, { maxCap = TOPUP_CAP_MAX, pctOfBook = TOPUP_CAP_PCT_OF_BOOK } = {}) {
  const n = Math.max(0, Math.floor(num(bookCount, 0)));
  if (n === 0) return 0;
  return Math.min(maxCap, Math.max(1, Math.ceil(pctOfBook * n)));
}

function isFullTopUp(action) {
  return ALL_TOPUP_ACTIONS.has(action) && action !== CAPPED_TOPUP_ACTION;
}

function tickerOf(h) {
  return String(h?.sws?.ticker || h?.symbol || "").toUpperCase();
}

// Deterministic total order — rankScore is toFixed(2), so ties are real.
// Same inputs must produce the same kept set on /analyze and /rerun.
function compareCandidates(a, b) {
  return (b.rankScore - a.rankScore)
    || (num(b.h.sws?.upside_pct, -Infinity) - num(a.h.sws?.upside_pct, -Infinity))
    || (num(b.h.sws?.v4_score, -Infinity) - num(a.h.sws?.v4_score, -Infinity))
    || tickerOf(a.h).localeCompare(tickerOf(b.h));
}

export function applyTopUpBadgeCap(scoredHoldings, opts = {}) {
  const holdings = Array.isArray(scoredHoldings) ? scoredHoldings : [];
  const enabled = opts.enabled ?? isTopUpCapEnabled(opts.env);
  const covered = holdings.filter((h) => h?.swsCovered);
  const bookCount = covered.length;
  const k = opts.k ?? computeTopUpCapK(bookCount, opts);

  const summary = {
    enabled,
    version: TOPUP_CAP_VERSION,
    k,
    bookCount,
    candidateCount: 0,
    kept: [],
    demotedByRank: [],
    demotedByBar: [], // reserved for the absolute-bar stage (lever 2 attribution)
  };
  if (!enabled) return summary;

  const candidates = covered
    .filter((h) => isFullTopUp(h.action))
    .map((h) => ({ h, rankScore: candidateBaseRank(holdingRankInputs(h)) }))
    .sort(compareCandidates);
  summary.candidateCount = candidates.length;
  if (candidates.length === 0) return summary;

  candidates.forEach(({ h, rankScore }, i) => {
    const rank = i + 1;
    if (rank <= k) {
      h.topUpCap = { capped: false, rank, k, candidateCount: candidates.length, rankScore };
      summary.kept.push({ ticker: tickerOf(h), rank, rankScore });
      return;
    }
    const preCapAction = h.action;
    h.preCapAction = preCapAction;
    h.action = CAPPED_TOPUP_ACTION;
    h.displayActionIntent = "Top-up (if funded)";
    h.topUpCap = {
      capped: true,
      stage: "rank",
      rank,
      k,
      candidateCount: candidates.length,
      rankScore,
      preCapAction,
    };
    const keptTickers = summary.kept.map((x) => x.ticker).join(", ");
    h.reasons = [
      `Top-up capped: ranked #${rank} of ${candidates.length} add candidates by within-book conviction rank — outside today's top ${k}${keptTickers ? ` (${keptTickers})` : ""}. Quality unchanged; this is a relative capital-priority call, not a thesis downgrade.`,
      ...(Array.isArray(h.reasons) ? h.reasons : []),
    ];
    summary.demotedByRank.push({ ticker: tickerOf(h), rank, rankScore, preCapAction });
  });

  return summary;
}
