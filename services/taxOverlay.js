/**
 * taxOverlay.js — Tax-aware Sell-alert overlay.
 *
 * P2.4: For each "Sell / Exit Alert" candidate the user holds, compute
 * days-to-LTCG and surface a "DEFER N days" or "ALREADY LTCG" hint
 * alongside the technical exit signal. SEBI RA Reg 2014 §15(2) materiality
 * principle — tax cost is material to a recommendation; failing to flag a
 * 7.5pp tax-rate difference would be misleading.
 *
 * Reuses the same Indian-equity tax thresholds the portfolioAnalyzer
 * already encodes:
 *   - LTCG threshold: 365 days from purchase
 *   - STCG rate: 20% (Budget 2024)
 *   - LTCG rate: 12.5% over ₹1.25L/yr exempt
 *   - Tax savings from waiting: ~7.5pp on the gain (20% - 12.5%)
 *
 * Pure function — operates on already-loaded picks. The Sell scanner calls
 * it with the post-overlay picks (where heldAvgPrice / heldPurchaseDate
 * have been set by tagPicksWithPortfolio).
 */

const LTCG_DAYS = 365;

/**
 * Build the tax overlay for a single Sell pick. Returns null when the
 * pick is not held, when purchaseDate is unknown, or when no useful hint
 * can be made.
 *
 * @param {object} pick   the Sell scanner pick (post portfolioOverlay tagging)
 * @returns {object|null} { daysHeld, daysToLT, taxRegime, label, hint, taxSavingPct }
 */
export function buildSellTaxOverlay(pick) {
  if (!pick || !pick.inPortfolio) return null;
  if (!pick.heldPurchaseDate) return null;
  const pd = new Date(pick.heldPurchaseDate);
  if (Number.isNaN(pd.getTime())) return null;

  const ms = Date.now() - pd.getTime();
  const daysHeld = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (daysHeld < 0) return null;
  const daysToLT = daysHeld >= LTCG_DAYS ? 0 : LTCG_DAYS - daysHeld;

  // Compute pnlAmount when we have the data — drives the "is this a gain
  // or a loss" framing, which changes the recommendation.
  const currentPrice = Number(pick.price);
  const avgPrice = Number(pick.heldAvgPrice);
  const qty = Number(pick.heldQuantity);
  const haveAll = [currentPrice, avgPrice, qty].every(Number.isFinite);
  const pnlAmount = haveAll ? (currentPrice - avgPrice) * qty : null;
  const pnlPct = haveAll && avgPrice > 0 ? ((currentPrice - avgPrice) / avgPrice) * 100 : null;
  const inLoss = pnlAmount != null && pnlAmount <= 0;

  let taxRegime, label, hint;
  const taxSavingPct = 7.5; // 20% STCG → 12.5% LTCG = 7.5pp on the gain

  if (daysToLT === 0) {
    taxRegime = "LTCG";
    label = `Already LTCG · ${daysHeld} days held`;
    hint = inLoss
      ? `Loss is long-term — exit now realises an LTCG loss usable against future LTCG only.`
      : `Past the 365-day gate — exit now is taxed at 12.5% over ₹1.25L/yr exempt. No tax penalty for selling on the technical signal.`;
  } else if (daysToLT <= 30) {
    taxRegime = "STCG → LTCG soon";
    label = `${daysToLT} days to LTCG`;
    hint = inLoss
      ? `Sell now realises a short-term loss (offsets STCG gains only). Waiting ${daysToLT} days converts it to a long-term loss.`
      : `Selling now would be 20% STCG vs 12.5% LTCG in ${daysToLT} days — ~${taxSavingPct}pp tax saving on the gain. Worth weighing against the technical exit signal.`;
  } else if (daysToLT <= 90) {
    taxRegime = "STCG";
    label = `${daysToLT} days to LTCG`;
    hint = inLoss
      ? `Loss is short-term (${daysHeld}/${LTCG_DAYS} days). Loss harvesting now uses STCG offsets only.`
      : `Sell now = 20% STCG. Holding to day 365 saves ~${taxSavingPct}pp on the gain — only defer if the technical signal isn't thesis-breaking.`;
  } else {
    taxRegime = "STCG";
    label = `${daysHeld}/${LTCG_DAYS} days held`;
    hint = inLoss
      ? `Short-term loss (${daysHeld}/${LTCG_DAYS} days held). Realising it now offsets STCG gains.`
      : `Short-term gain (${daysHeld}/${LTCG_DAYS} days). Selling on the exit signal is correct unless tax efficiency dominates the thesis.`;
  }

  return {
    daysHeld,
    daysToLT,
    taxRegime,
    label,
    hint,
    pnlAmount: pnlAmount != null ? +pnlAmount.toFixed(2) : null,
    pnlPct: pnlPct != null ? +pnlPct.toFixed(2) : null,
    taxSavingPct,
  };
}

/**
 * Decorate every Sell pick in the list with .taxOverlay = {...} when
 * applicable (held + known purchase date), null otherwise.
 */
export function tagSellPicksWithTax(picks) {
  if (!Array.isArray(picks)) return picks;
  for (const p of picks) {
    p.taxOverlay = buildSellTaxOverlay(p) || null;
  }
  return picks;
}
