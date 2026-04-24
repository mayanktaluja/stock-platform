/**
 * Tax Engine — Indian capital-gains rules for the XIRR Optimizer
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Pure, deterministic functions that compute the ₹ tax cost of a candidate
 * exit. Used by xirrOptimizer.js to convert a "gross uplift in basis points"
 * estimate into a "net-of-tax uplift" — without that conversion every
 * recommendation in a high-gain book would over-state the actual benefit.
 *
 * Coverage (Phase 1):
 *   - Listed equity / equity MF: Budget 2024 rates (STCG 20%, LTCG 12.5%
 *     over ₹1.25L/FY exempt, 12-month gate).
 *   - Debt MF post-2023-04-01: slab rate (Finance Act 2023 amendment).
 *     Debt MF pre-2023-04-01 cohort: kept LTCG indexation rule for now —
 *     flagged in note rather than hard-computed (would need acquisition
 *     CII data we don't ingest).
 *   - ELSS: 3-year lock-in from each individual purchase date.
 *   - FY context: Indian FY runs 1-Apr → 31-Mar. The ₹1.25L equity LTCG
 *     exemption resets at the FY boundary.
 *
 * Out of scope for Phase 1 (will land later):
 *   - Surcharge & cess (footnoted "add ~4% if applicable").
 *   - SGB / bond / G-sec specific rules.
 *   - Indexation for pre-2023 debt MF cohorts (needs CII table).
 *   - Multi-tranche acquisition cost averaging (currently treats each
 *     "holding" as a single average-cost lot, matching how Groww exports it).
 */

// ──────────────────── Constants ────────────────────

export const TAX_RULES = {
  // Budget 2024 rates effective 23-Jul-2024 onwards. Optimizer assumes "today"
  // is post-cutover — sub-cutover purchases honour pre-Budget rates only for
  // their realisation timing, not for the rate applied at exit.
  STCG_EQUITY_PCT: 20,
  LTCG_EQUITY_PCT: 12.5,
  LTCG_EQUITY_EXEMPTION_RUPEES: 125000, // ₹1.25L per FY per assessee
  EQUITY_LT_GATE_DAYS: 365,             // ≥12 months for LTCG treatment
  ELSS_LOCK_IN_DAYS: 365 * 3,           // 3-year statutory lock-in
  DEBT_MF_REGIME_CHANGE_DATE: "2023-04-01", // Finance Act 2023 cutover
};

// Default slab rate when the optimizer is called without an explicit override.
// Per-user `taxSlabPct` from the UI flows through `runXirrOptimizer({ taxSlabPct })`.
export const DEFAULT_SLAB_PCT = 30;

// FY-end is 31-Mar. Indian fiscal year: 1-Apr (year N) → 31-Mar (year N+1).
function indianFinancialYear(date) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-indexed, so March = 2
  // Pre-April → previous FY; April onwards → current FY
  const startYear = month < 3 ? year - 1 : year;
  return {
    label: `FY${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`,
    startsOn: `${startYear}-04-01`,
    endsOn: `${startYear + 1}-03-31`,
    startYear,
  };
}

function daysBetween(from, to) {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

// ──────────────────── ELSS lock-in check ────────────────────

/**
 * Does an ELSS exit on `today` violate the 3-year lock-in?
 *
 * @param {string|Date} purchaseDate
 * @param {string|Date} today
 * @returns {{ blocked: boolean, until?: string, daysRemaining?: number }}
 */
export function checkElssLockIn(purchaseDate, today = new Date()) {
  if (!purchaseDate) return { blocked: false }; // unknown purchase date → can't block; UI will note
  const days = daysBetween(purchaseDate, today);
  if (days == null) return { blocked: false };
  if (days >= TAX_RULES.ELSS_LOCK_IN_DAYS) return { blocked: false };
  const lockEnd = new Date(purchaseDate);
  lockEnd.setUTCDate(lockEnd.getUTCDate() + TAX_RULES.ELSS_LOCK_IN_DAYS);
  return {
    blocked: true,
    until: lockEnd.toISOString().slice(0, 10),
    daysRemaining: TAX_RULES.ELSS_LOCK_IN_DAYS - days,
  };
}

// ──────────────────── FY context (LTCG exemption budget) ────────────────────

/**
 * Build the FY context for the optimizer's tax-budget tracking. The
 * ₹1.25L LTCG exemption is per-assessee per-FY, so any exit moves planned
 * within the same FY share that bucket.
 *
 * @param {string|Date} today
 * @param {number} ltcgRealisedYtdRupees - LTCG already realised this FY (from
 *   user transactions; defaults to 0 if not supplied)
 * @param {number} stcgRealisedYtdRupees - same for STCG (informational only —
 *   STCG has no exemption to budget)
 */
export function buildFyContext(today = new Date(), ltcgRealisedYtdRupees = 0, stcgRealisedYtdRupees = 0) {
  const fy = indianFinancialYear(today);
  const ltcgBudgetRemainingRupees = Math.max(0, TAX_RULES.LTCG_EQUITY_EXEMPTION_RUPEES - ltcgRealisedYtdRupees);
  return {
    currentFy: fy.label,
    fyStartsOn: fy.startsOn,
    fyEndsOn: fy.endsOn,
    ltcgBudgetTotalRupees: TAX_RULES.LTCG_EQUITY_EXEMPTION_RUPEES,
    ltcgRealisedYtdRupees,
    ltcgBudgetRemainingRupees,
    stcgYtdRupees: stcgRealisedYtdRupees,
    daysToFyEnd: daysBetween(today, fy.endsOn),
  };
}

// ──────────────────── Exit tax computation ────────────────────

/**
 * Compute the ₹ tax cost of fully or partially exiting a single position.
 *
 * @param {object} input
 * @param {"equity"|"equity_mf"|"debt_mf"|"elss"|"etf"|"hybrid_eq"|"hybrid_debt"} input.assetClass
 *   How the position is taxed. equity/equity_mf/etf/hybrid_eq → equity rules.
 *   elss → equity rules + lock-in check. debt_mf/hybrid_debt → slab (post-2023).
 * @param {number} input.investedRupees
 * @param {number} input.currentValueRupees
 * @param {number} input.exitFractionPct - 0..100, what % of the position to exit.
 * @param {string} input.purchaseDate - ISO date (YYYY-MM-DD)
 * @param {string|Date} [input.today]
 * @param {object} [input.fyContext] - from buildFyContext(); for budget-aware LTCG
 * @param {number} [input.taxSlabPct] - user's slab for debt instruments (default 30)
 * @returns {{
 *   grossProceedsRupees, gainRupees, taxCostRupees, netProceedsRupees,
 *   regime, daysHeld, isLongTerm, exemptionUsedRupees, exemptionRemainingRupees,
 *   lockInBreach, lockInUntil?, notes: string[]
 * }}
 */
export function computeExitTax(input) {
  const today = input.today ? new Date(input.today) : new Date();
  const exitFraction = Math.max(0, Math.min(100, input.exitFractionPct ?? 100)) / 100;
  const taxSlabPct = Number.isFinite(input.taxSlabPct) ? input.taxSlabPct : DEFAULT_SLAB_PCT;
  const fyContext = input.fyContext || buildFyContext(today);
  const notes = [];

  const grossProceedsRupees = (input.currentValueRupees || 0) * exitFraction;
  const costBasisRupees = (input.investedRupees || 0) * exitFraction;
  const gainRupees = grossProceedsRupees - costBasisRupees;
  const isGain = gainRupees > 0;

  const daysHeld = input.purchaseDate ? daysBetween(input.purchaseDate, today) : null;
  const isLongTerm = daysHeld != null && daysHeld >= TAX_RULES.EQUITY_LT_GATE_DAYS;

  // ELSS lock-in gate — only blocks debt-allocation rules; equity-class still computed
  // for the case where caller wants to know "if not blocked, what would tax be?".
  let lockInBreach = false;
  let lockInUntil = null;
  if (input.assetClass === "elss") {
    const lockCheck = checkElssLockIn(input.purchaseDate, today);
    lockInBreach = lockCheck.blocked;
    lockInUntil = lockCheck.until || null;
    if (lockInBreach) {
      notes.push(`ELSS 3-year lock-in not yet expired — exit blocked until ${lockInUntil}.`);
    }
  }

  // ──── Compute tax by asset class ────
  let taxCostRupees = 0;
  let regime = "none";
  let exemptionUsedRupees = 0;
  let exemptionRemainingRupees = fyContext.ltcgBudgetRemainingRupees;

  // Loss path: no positive tax, but flag the carry-forward / set-off rules
  if (!isGain) {
    regime = "loss";
    if (input.assetClass === "debt_mf" || input.assetClass === "hybrid_debt") {
      notes.push("Loss on debt instrument — set off only against other debt-class capital gains; carries forward 8 years.");
    } else {
      const term = isLongTerm ? "long-term" : "short-term";
      notes.push(`${term[0].toUpperCase()}${term.slice(1)} capital loss — set off restricted to same class (${term} loss against ${term} gain). Unabsorbed loss carries forward 8 years.`);
    }
    return {
      grossProceedsRupees,
      gainRupees,
      taxCostRupees: 0,
      netProceedsRupees: grossProceedsRupees,
      regime,
      daysHeld,
      isLongTerm,
      exemptionUsedRupees: 0,
      exemptionRemainingRupees,
      lockInBreach,
      lockInUntil,
      notes,
    };
  }

  // Gain path
  if (input.assetClass === "debt_mf" || input.assetClass === "hybrid_debt") {
    // Finance Act 2023: debt MF gains taxed at slab regardless of holding period.
    // Pre-2023-04-01 cohort kept indexation, but we don't have the data to know
    // the original purchase cohort — flag this in notes.
    regime = `slab_${taxSlabPct}`;
    taxCostRupees = gainRupees * (taxSlabPct / 100);
    notes.push(`Debt instrument gain taxed at ${taxSlabPct}% slab rate (Finance Act 2023). If acquired before 1-Apr-2023, indexation may still apply — verify with your CA.`);
    notes.push("Add ~4% surcharge & cess if your taxable income crosses the relevant threshold.");
  } else if (isLongTerm) {
    // Equity LTCG: 12.5% over ₹1.25L/FY exempt
    regime = "ltcg";
    const exemptionAvailable = fyContext.ltcgBudgetRemainingRupees;
    exemptionUsedRupees = Math.min(gainRupees, exemptionAvailable);
    const taxableGain = Math.max(0, gainRupees - exemptionUsedRupees);
    taxCostRupees = taxableGain * (TAX_RULES.LTCG_EQUITY_PCT / 100);
    exemptionRemainingRupees = exemptionAvailable - exemptionUsedRupees;
    if (exemptionUsedRupees > 0) {
      notes.push(`Used ₹${Math.round(exemptionUsedRupees).toLocaleString("en-IN")} of FY ${TAX_RULES.LTCG_EQUITY_EXEMPTION_RUPEES.toLocaleString("en-IN")} LTCG exemption.`);
    }
    if (taxableGain > 0) {
      notes.push(`Taxable LTCG ₹${Math.round(taxableGain).toLocaleString("en-IN")} × 12.5% = ₹${Math.round(taxCostRupees).toLocaleString("en-IN")}.`);
    }
  } else {
    // Equity STCG: 20% on full gain (Budget 2024 rate, up from 15%)
    regime = "stcg";
    taxCostRupees = gainRupees * (TAX_RULES.STCG_EQUITY_PCT / 100);
    if (daysHeld != null) {
      const daysToLt = TAX_RULES.EQUITY_LT_GATE_DAYS - daysHeld;
      notes.push(`Short-term holding (${daysHeld}/${TAX_RULES.EQUITY_LT_GATE_DAYS} days) — ${daysToLt} days to LTCG would save ~7.5pp of tax.`);
    } else {
      notes.push("Holding period unknown — STCG assumed. Provide purchase date to enable LTCG-aware planning.");
    }
  }

  return {
    grossProceedsRupees,
    gainRupees,
    taxCostRupees,
    netProceedsRupees: grossProceedsRupees - taxCostRupees,
    regime,
    daysHeld,
    isLongTerm,
    exemptionUsedRupees,
    exemptionRemainingRupees,
    lockInBreach,
    lockInUntil,
    notes,
  };
}

// ──────────────────── FY-split helper ────────────────────

/**
 * For an LTCG-bearing equity exit that would breach the FY exemption,
 * compute a 2-tranche split: tranche A consumes the rest of this FY's
 * exemption; tranche B defers to the next FY (executes after 1-Apr).
 *
 * Returns null if the exit is not LTCG-bearing or doesn't actually breach.
 *
 * @param {object} input - same shape as computeExitTax
 * @returns {null | {
 *   recommended: "split"|"single",
 *   trancheA: { exitFractionPct, executeBy: string, taxCostRupees },
 *   trancheB: { exitFractionPct, executeAfter: string, taxCostRupees, fyLabel }
 * }}
 */
export function suggestFyAwareSplit(input) {
  const today = input.today ? new Date(input.today) : new Date();
  const baseTax = computeExitTax({ ...input, exitFractionPct: 100 });
  if (baseTax.regime !== "ltcg") return null;
  if (baseTax.gainRupees <= input.fyContext?.ltcgBudgetRemainingRupees) return null;

  // Find the fraction that exactly consumes the remaining budget
  const fyContext = input.fyContext || buildFyContext(today);
  const fullGainRupees = baseTax.gainRupees;
  const trancheAFractionPct = Math.max(
    0,
    Math.min(100, (fyContext.ltcgBudgetRemainingRupees / fullGainRupees) * 100),
  );
  const trancheBFractionPct = 100 - trancheAFractionPct;
  if (trancheBFractionPct < 1) return null; // not worth splitting

  // Tranche A taxed under current FY (consumes remaining exemption → ₹0 tax)
  const trancheA = computeExitTax({
    ...input,
    exitFractionPct: trancheAFractionPct,
    fyContext,
  });

  // Tranche B taxed under next FY (full ₹1.25L exemption available)
  const nextFyDate = new Date(fyContext.fyEndsOn);
  nextFyDate.setUTCDate(nextFyDate.getUTCDate() + 1);
  const nextFyContext = buildFyContext(nextFyDate, 0, 0);
  const trancheB = computeExitTax({
    ...input,
    exitFractionPct: trancheBFractionPct,
    today: nextFyDate,
    fyContext: nextFyContext,
  });

  const totalSplitTax = trancheA.taxCostRupees + trancheB.taxCostRupees;
  const singleShotTax = baseTax.taxCostRupees;
  if (singleShotTax - totalSplitTax < 1000) return null; // <₹1k savings → not worth the operational complexity

  return {
    recommended: "split",
    savingsRupees: Math.round(singleShotTax - totalSplitTax),
    trancheA: {
      exitFractionPct: +trancheAFractionPct.toFixed(2),
      executeBy: fyContext.fyEndsOn,
      taxCostRupees: Math.round(trancheA.taxCostRupees),
      fyLabel: fyContext.currentFy,
    },
    trancheB: {
      exitFractionPct: +trancheBFractionPct.toFixed(2),
      executeAfter: fyContext.fyEndsOn,
      taxCostRupees: Math.round(trancheB.taxCostRupees),
      fyLabel: nextFyContext.currentFy,
    },
  };
}

// ──────────────────── Asset-class inference ────────────────────

/**
 * Map a holding's instrument metadata to an assetClass label this engine
 * understands. Conservative defaults: unknown → equity (most permissive
 * tax treatment so we don't over-discount uplift estimates).
 */
export function inferAssetClass(holding) {
  if (!holding) return "equity";
  const subCat = String(holding.subCategory || "").toLowerCase();
  const cat = String(holding.category || "").toLowerCase();
  const name = String(holding.name || holding.rawName || "").toLowerCase();
  const type = String(holding.instrumentType || "").toLowerCase();

  if (type === "etf") return "etf";
  if (type === "mf" || type === "mutual_fund" || /direct|regular|growth/.test(name)) {
    if (/elss|tax\s*saver/.test(subCat) || /elss|tax\s*saver/.test(name)) return "elss";
    if (/debt|liquid|bond|gilt|short\s*duration|corporate\s*bond/.test(cat)
      || /debt|liquid|bond|gilt|short\s*duration|corporate\s*bond/.test(subCat)
      || /debt|liquid|bond|gilt/.test(name)) return "debt_mf";
    if (/hybrid|balanced/.test(cat) || /hybrid|balanced/.test(subCat)) {
      return /conservative|debt|savings/.test(subCat + " " + name) ? "hybrid_debt" : "hybrid_eq";
    }
    return "equity_mf";
  }
  return "equity";
}
