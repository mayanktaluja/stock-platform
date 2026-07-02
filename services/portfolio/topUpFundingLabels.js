import { ALL_TOPUP_ACTIONS, CAPPED_TOPUP_ACTION } from "../actionLadder.js";

// Funding-aware Top-up badge labels (lever 3, relabel-only).
//
// The construction plan already decides which adds a declared budget funds
// (max 5, ranked by the same candidateBaseRank as the badge cap) — but the
// badges never reflected it. This maps the plan's funding outcome back onto
// each Top-up holding's displayActionIntent:
//
//   funded              → "Top-up — ₹X funded"
//   kept, no budget     → label untouched (no budget declared ⇒ no funding
//                         claim either way — the honest default)
//   kept, budget ran out→ "Top-up (unfunded this budget)"
//   cap-demoted         → keeps its "Top-up (if funded)" label unless the
//                         budget actually reached it (possible when budget +
//                         slots remain after the top-k), then shows funded ₹
//
// Never invents a budget: the platform must not fabricate capital the user
// didn't declare. Idempotent — labels are recomputed from the passed plan on
// every call, so /analyze and /rerun converge on the same output.

function fmtInr(n) {
  return `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
}

function normTicker(v) {
  return String(v || "").trim().toUpperCase();
}

export function applyTopUpFundingLabels(scoredHoldings, constructionPlan) {
  const holdings = Array.isArray(scoredHoldings) ? scoredHoldings : [];
  const plan = constructionPlan || {};
  const out = { labeled: 0, funded: 0, ifFunded: 0, unfunded: 0 };

  const fundedByTicker = new Map(
    (plan.fundedTrades || [])
      .filter((t) => t?.source === "holding" && t?.side === "BUY")
      .map((t) => [normTicker(t.ticker), t]),
  );
  const eligibleByTicker = new Map(
    (plan.eligibleAddCandidates || []).map((c) => [normTicker(c.ticker), c]),
  );
  const budgetDeclared = (plan.capitalLedger?.availableBuyCapital || 0) > 0;

  for (const h of holdings) {
    if (!h || !ALL_TOPUP_ACTIONS.has(h.action)) continue;
    const ticker = normTicker(h.sws?.ticker || h.symbol);
    if (!ticker) continue;
    const fundedTrade = fundedByTicker.get(ticker);
    const isCapped = h.action === CAPPED_TOPUP_ACTION;
    out.labeled += 1;

    if (fundedTrade) {
      h.displayActionIntent = `Top-up — ${fmtInr(fundedTrade.tradeRupees)} funded`;
      h.fundedTradeRupees = fundedTrade.tradeRupees;
      h.topUpFunding = {
        status: "funded",
        tradeRupees: fundedTrade.tradeRupees,
        rank: fundedTrade.rank ?? null,
        belowCap: isCapped,
      };
      out.funded += 1;
      continue;
    }

    delete h.fundedTradeRupees;
    if (isCapped) {
      // PR2's label is already the truthful state; attach the plan's reasons.
      h.displayActionIntent = "Top-up (if funded)";
      h.topUpFunding = {
        status: "if_funded",
        reasons: eligibleByTicker.get(ticker)?.unfundedReasons
          || eligibleByTicker.get(ticker)?.rejectionReasons
          || [],
      };
      out.ifFunded += 1;
      continue;
    }

    if (budgetDeclared) {
      h.displayActionIntent = "Top-up (unfunded this budget)";
      h.topUpFunding = {
        status: "unfunded",
        reasons: eligibleByTicker.get(ticker)?.unfundedReasons
          || eligibleByTicker.get(ticker)?.rejectionReasons
          || [],
      };
      out.unfunded += 1;
    } else {
      // No declared budget: the badge stays a plain quality call.
      h.topUpFunding = { status: "no_budget" };
    }
  }

  return out;
}
