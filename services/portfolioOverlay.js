/**
 * portfolioOverlay.js — Market Scanner ↔ user portfolio overlap.
 *
 * Tags each scanner pick with portfolio context so the UI can warn about
 * concentration and the SEBI-RA "don't recommend the same name twice
 * without flagging" rule (IA Reg 2013 §15(4)). Uses cost-basis weights
 * (qty × avgPrice) instead of live mark-to-market: deterministic, no
 * extra quote fetches, and the only consumer is a "you already hold ~X%"
 * warning where 1–2pp drift doesn't change the message.
 *
 * Scanner pipeline:
 *   1. loadPortfolioWeightMap()  — Map<symbol, { weightPct, ... }>
 *   2. tagPicksWithPortfolio(picks, weightMap, defaultTopUpRupees)
 *      decorates each pick with inPortfolio / currentWeight /
 *      concentrationAfterTopUp.
 *   3. rerankFreshFirst(picks, conviction band)
 *      reorders so fresh names rise above held ones inside the same
 *      score band (default 5 pts) — preserves overall conviction order
 *      but breaks ties in favor of diversification.
 *
 * Best-effort: any error (no portfolio file, KV miss, parse failure) is
 * swallowed and returns an empty map. The scanner must remain functional
 * for users who haven't uploaded a portfolio yet.
 */

import { getPortfolioStorage } from "../portfolioStorage.js";

/**
 * Load a Map<symbol, weightInfo> for the user's current portfolio.
 *
 * weightInfo = {
 *   quantity, avgPrice, costBasis,
 *   weightPct,   // costBasis / totalCostBasis × 100
 *   sector,
 * }
 *
 * Symbols are normalized to the same .NS-suffixed form the scanner uses.
 * Returns an empty Map (never throws) when no portfolio is loaded.
 */
export async function loadPortfolioWeightMap() {
  try {
    const portfolio = await getPortfolioStorage().read();
    const stocks = Array.isArray(portfolio?.stocks) ? portfolio.stocks : [];
    if (stocks.length === 0) return new Map();

    const enriched = stocks
      .map((s) => {
        const qty = Number(s.quantity);
        const avg = Number(s.avgPrice);
        if (!Number.isFinite(qty) || !Number.isFinite(avg) || qty <= 0 || avg <= 0) {
          return null;
        }
        const symbol = (s.symbol || "").toUpperCase();
        return {
          symbol,
          quantity: qty,
          avgPrice: avg,
          costBasis: qty * avg,
          sector: s.sector || null,
        };
      })
      .filter(Boolean);

    if (enriched.length === 0) return new Map();

    const totalCostBasis = enriched.reduce((sum, s) => sum + s.costBasis, 0);
    if (totalCostBasis <= 0) return new Map();

    const map = new Map();
    for (const s of enriched) {
      map.set(s.symbol, {
        ...s,
        weightPct: (s.costBasis / totalCostBasis) * 100,
      });
    }
    return map;
  } catch (err) {
    console.warn("[portfolioOverlay] loadPortfolioWeightMap failed:", err.message);
    return new Map();
  }
}

/**
 * Decorate scanner picks with portfolio context.
 *
 * Mutates each pick by attaching:
 *   inPortfolio: boolean
 *   currentWeight: number | null   (cost-basis %; null when not held)
 *   concentrationAfterTopUp: number | null  (projected % after a
 *                                            ₹defaultTopUpRupees add)
 *
 * `defaultTopUpRupees` defaults to ₹50,000 — a reasonable retail top-up
 * size for a SEBI-RA "should I add to this?" framing. UI can override.
 */
export function tagPicksWithPortfolio(picks, weightMap, defaultTopUpRupees = 50000) {
  if (!Array.isArray(picks) || picks.length === 0) return picks;
  if (!weightMap || weightMap.size === 0) {
    for (const p of picks) {
      p.inPortfolio = false;
      p.currentWeight = null;
      p.concentrationAfterTopUp = null;
    }
    return picks;
  }

  const totalCostBasis = Array.from(weightMap.values()).reduce(
    (sum, h) => sum + h.costBasis,
    0
  );

  for (const p of picks) {
    const sym = (p.symbol || "").toUpperCase();
    const held = weightMap.get(sym);
    if (held) {
      p.inPortfolio = true;
      p.currentWeight = parseFloat(held.weightPct.toFixed(2));
      const newCostBasis = totalCostBasis + defaultTopUpRupees;
      const newPositionCost = held.costBasis + defaultTopUpRupees;
      p.concentrationAfterTopUp = parseFloat(
        ((newPositionCost / newCostBasis) * 100).toFixed(2)
      );
    } else {
      p.inPortfolio = false;
      p.currentWeight = null;
      p.concentrationAfterTopUp = null;
    }
  }
  return picks;
}

/**
 * Re-rank inside a conviction band so fresh (not-held) names rise above
 * held ones when scores are within `bandPoints` of each other. Preserves
 * the overall conviction ordering — a much-stronger held pick still
 * stays above a much-weaker fresh one.
 *
 * Operates on the scoreField (default "adjustedScore") which is set per
 * scanner type before the call.
 */
export function rerankFreshFirst(picks, scoreField = "adjustedScore", bandPoints = 5) {
  if (!Array.isArray(picks) || picks.length < 2) return picks;
  // Group consecutive picks where the score gap to the previous group
  // anchor is within bandPoints, then within each group push held names
  // to the bottom while preserving original score order among ties.
  const groups = [];
  let current = [picks[0]];
  let anchor = Number(picks[0]?.[scoreField]) || 0;
  for (let i = 1; i < picks.length; i++) {
    const score = Number(picks[i]?.[scoreField]) || 0;
    if (Math.abs(anchor - score) <= bandPoints) {
      current.push(picks[i]);
    } else {
      groups.push(current);
      current = [picks[i]];
      anchor = score;
    }
  }
  groups.push(current);

  const out = [];
  for (const g of groups) {
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    const fresh = g.filter((p) => !p.inPortfolio);
    const held = g.filter((p) => p.inPortfolio);
    out.push(...fresh, ...held);
  }
  return out;
}
