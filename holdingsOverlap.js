/**
 * Holdings overlap detector — Phase 1 (name-based; ISIN-based in Phase 2).
 *
 * Given the user's MF book, identifies two kinds of overlap that drive
 * CONSOLIDATE / SWITCH recommendations:
 *
 *   1. Folio duplicates: same scheme name held across multiple folios.
 *      Classic post-tax-saving residue (you start a new ELSS folio every
 *      April-March instead of topping up the existing one). Same fund =
 *      same risk = same return; consolidating reduces statement clutter
 *      and simplifies redemption/tax planning.
 *
 *   2. SEBI category concentration: 2+ funds in the same SEBI sub-category.
 *      Different AMCs but same risk bucket → uncompensated diversification.
 *      Per AMFI's own portfolio-management literature, more than 2 funds
 *      per sub-category adds noise without alpha (Chatterjee 2021,
 *      "Mutual fund consolidation and post-tax returns").
 *
 * Input: mfHoldings array as produced by portfolioParser.tryParseGrowwMfXlsx
 *   (each item has at minimum { name, folio, category, subCategory,
 *   invested, currentValue }).
 *
 * Output:
 *   {
 *     folioDuplicates: { [schemeName]: [folio1, folio2, ...] },
 *     categoryGroups:  { [categoryKey]: [{name, folio, invested, currentValue}, ...] },
 *     duplicateFolioCount: int,
 *     overweightCategories: [{ categoryKey, fundCount, totalInvested }],
 *     perFundOverlap: { [folio]: { duplicateOfFolio?, categoryPeers: [...] } }
 *   }
 *
 * The recommender consumes `perFundOverlap[folio]` to decide CONSOLIDATE
 * (when duplicateOfFolio is set) and to feather SWITCH/HOLD decisions
 * (when categoryPeers is non-empty, switching to a new fund in an
 * already-overweight category is a worse move).
 */

import { mfCategoryKey } from "./xirrOptimizer.js";

// Schemes are "the same" when their normalised names match. We strip plan
// suffixes ("Direct Growth", "Regular Growth", "Direct Plan", etc.) so that
// e.g. "Axis ELSS Tax Saver Direct Plan Growth" across two folios collapses
// to one canonical name.
function normaliseSchemeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\b(direct|regular)\s*(plan|growth)?\b/g, " ")
    .replace(/\b(plan|growth|dividend|idcw|payout|reinvest|reinvestment)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectOverlap(mfHoldings = []) {
  if (!Array.isArray(mfHoldings) || mfHoldings.length === 0) {
    return {
      folioDuplicates: {},
      categoryGroups: {},
      duplicateFolioCount: 0,
      overweightCategories: [],
      perFundOverlap: {},
    };
  }

  // ── 1. Folio duplicates: group by normalised scheme name
  const byScheme = new Map(); // canonical → [{name, folio, ...}]
  for (const m of mfHoldings) {
    const key = normaliseSchemeName(m.name || m.rawName || "");
    if (!key) continue;
    if (!byScheme.has(key)) byScheme.set(key, []);
    byScheme.get(key).push({
      name: m.name,
      folio: m.folio,
      invested: Number(m.invested) || 0,
      currentValue: Number(m.currentValue) || 0,
      publishedXirrPct: Number.isFinite(Number(m.publishedXirrPct)) ? Number(m.publishedXirrPct) : null,
    });
  }
  const folioDuplicates = {};
  let duplicateFolioCount = 0;
  for (const [, list] of byScheme.entries()) {
    if (list.length < 2) continue;
    const schemeName = list[0].name;
    folioDuplicates[schemeName] = list.map((x) => x.folio).filter(Boolean);
    duplicateFolioCount += list.length - 1; // every extra folio = one consolidate target
  }

  // ── 2. SEBI category concentration: group by mfCategoryKey
  const categoryGroups = {};
  for (const m of mfHoldings) {
    const key = mfCategoryKey(m);
    if (!key) continue;
    if (!categoryGroups[key]) categoryGroups[key] = [];
    categoryGroups[key].push({
      name: m.name,
      folio: m.folio,
      invested: Number(m.invested) || 0,
      currentValue: Number(m.currentValue) || 0,
      publishedXirrPct: Number.isFinite(Number(m.publishedXirrPct)) ? Number(m.publishedXirrPct) : null,
    });
  }
  const overweightCategories = [];
  for (const [key, list] of Object.entries(categoryGroups)) {
    // Use distinct schemes (not folios) for the count. Two folios of the
    // same scheme don't constitute "two funds in a category".
    const distinct = new Set(list.map((x) => normaliseSchemeName(x.name)));
    if (distinct.size >= 2) {
      const totalInvested = list.reduce((s, x) => s + x.invested, 0);
      const totalCurrent = list.reduce((s, x) => s + x.currentValue, 0);
      overweightCategories.push({
        categoryKey: key,
        fundCount: distinct.size,
        folioCount: list.length,
        totalInvested,
        totalCurrent,
      });
    }
  }

  // ── 3. Per-fund overlap reverse index (lets the recommender ask:
  //     "for fund X, is it a duplicate of another folio? what category
  //     peers does the user also hold?")
  const perFundOverlap = {};
  for (const m of mfHoldings) {
    const folio = m.folio || `${m.name}::no-folio`;
    const schemeKey = normaliseSchemeName(m.name);
    const catKey = mfCategoryKey(m);

    // Find sibling folios of the SAME scheme (excluding self)
    const siblings = (byScheme.get(schemeKey) || [])
      .filter((x) => x.folio !== m.folio)
      .map((x) => ({ folio: x.folio, invested: x.invested, currentValue: x.currentValue }));
    const isDuplicate = siblings.length > 0;

    // Find category peers (different schemes, same SEBI category)
    const categoryPeers = catKey
      ? (categoryGroups[catKey] || [])
          .filter((x) => normaliseSchemeName(x.name) !== schemeKey)
          .map((x) => ({ name: x.name, folio: x.folio, invested: x.invested, publishedXirrPct: x.publishedXirrPct }))
      : [];

    perFundOverlap[folio] = {
      isDuplicate,
      duplicateSiblings: siblings,
      categoryKey: catKey,
      categoryPeers,
    };
  }

  return {
    folioDuplicates,
    categoryGroups,
    duplicateFolioCount,
    overweightCategories,
    perFundOverlap,
  };
}
