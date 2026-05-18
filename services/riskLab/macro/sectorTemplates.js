/**
 * Risk Lab — expanded sector impact templates.
 *
 * The production REGIME_SECTOR_TEMPLATES in macroRegime.js covers only a
 * partial blast radius per regime:
 *   - OIL_SHOCK lists Oil & Gas (+3), Aviation (-3), Automobile (-2) only
 *   - WAR_ESCALATION lists Defence (+4), Oil & Gas (+2), Aviation (-3) only
 *   - GLOBAL_RISK_OFF lists IT, Banking, Pharma, FMCG only
 *
 * This caused the ANANTRAJ case (Risk Lab plan section 1): Real Estate is
 * not in OIL_SHOCK's negative-impact list, so the production overlay would
 * have scored ANANTRAJ at delta=0 under OIL_SHOCK and never flagged it.
 *
 * LAB_TEMPLATE_ADDITIONS extends each regime's impact list with sectors
 * that historically bleed during that regime but were omitted upstream.
 * The lab merges these onto the live regime's `sectorImpacts` array at
 * scoring time — production macroRegime.js is NEVER modified.
 *
 * Editing guidance: add a new sector to a regime by appending to the
 * regime's array below. The unit test will assert it's picked up by the
 * adjusted scorer. Do NOT change existing entries upstream — those drive
 * production swsSectorFit.js / swsPortfolioAggregate.js behaviour.
 */

export const LAB_TEMPLATE_ADDITIONS = {
  OIL_SHOCK: [
    { sector: "Real Estate", impact: -2, reason: "Oil-driven inflation tightens mortgage demand" },
    { sector: "Capital Goods", impact: -2, reason: "Input cost pressure squeezes capex orders" },
    { sector: "Cement", impact: -2, reason: "Energy-intensive production hit by crude spike" },
    { sector: "Banking", impact: -1, reason: "Bond yields rise, MTM hit on book" },
    { sector: "Metals", impact: 1, reason: "Petroleum-coke inflation cushioned by metal pricing power" },
  ],
  WAR_ESCALATION: [
    { sector: "Real Estate", impact: -2, reason: "Risk-off FII rotation out of cyclicals" },
    { sector: "Aviation", impact: -3, reason: "Travel disruption + sentiment shock" },
    { sector: "FMCG", impact: -1, reason: "Sentiment-driven discretionary cut-back" },
    { sector: "IT Services", impact: -1, reason: "Global risk-off bleeds to USD-revenue exporters" },
    { sector: "Metals", impact: 1, reason: "Defensive bid on commodity safe-haven" },
  ],
  WAR_DE_ESCALATION: [
    { sector: "Real Estate", impact: 2, reason: "Risk-on returns to cyclicals on peace dividend" },
    { sector: "IT Services", impact: 1, reason: "Global risk-on lifts USD-revenue exporters" },
  ],
  GLOBAL_RISK_OFF: [
    { sector: "Real Estate", impact: -2, reason: "FII outflow + small/midcap risk premium" },
    { sector: "Capital Goods", impact: -2, reason: "Capex cycle pause in risk-off" },
    { sector: "Automobile", impact: -2, reason: "Discretionary spend cut during risk-off" },
    { sector: "Cement", impact: -1, reason: "Tied to infra spend pause" },
    { sector: "Metals", impact: -1, reason: "China/global demand-weakness proxy" },
  ],
  RATE_HIKE: [
    { sector: "Capital Goods", impact: -1, reason: "Higher cost of capital delays capex orders" },
    { sector: "Cement", impact: -1, reason: "Tied to construction demand cooling on rate hike" },
    { sector: "Infrastructure", impact: -2, reason: "Leverage-sensitive sector with long project cycles" },
  ],
  RATE_CUT: [
    { sector: "Capital Goods", impact: 2, reason: "Cheaper funding accelerates capex" },
    { sector: "Cement", impact: 2, reason: "Construction demand lifts on rate cuts" },
    { sector: "Infrastructure", impact: 3, reason: "Most leverage-sensitive sector benefits most" },
  ],
  CURRENCY_WEAKNESS: [
    { sector: "Aviation", impact: -2, reason: "Lease + fuel costs in USD, revenue in INR" },
    { sector: "Capital Goods", impact: -1, reason: "Imported components inflate" },
    { sector: "Automobile", impact: -1, reason: "Imported parts + commodity proxy" },
  ],
  POLICY_STIMULUS: [
    { sector: "Real Estate", impact: 2, reason: "PMAY / infra-push lifts housing demand" },
    { sector: "Automobile", impact: 2, reason: "FAME / PLI schemes boost demand" },
    { sector: "Metals", impact: 1, reason: "Infra-push pulls metals demand" },
  ],
  REGULATORY_SHOCK: [
    { sector: "Real Estate", impact: -1, reason: "Regulatory uncertainty hits leverage-sensitive cyclicals" },
    { sector: "Pharma", impact: -2, reason: "Sector-wide pricing or USFDA action risk" },
  ],
  CALM: [],
};

/**
 * Merge live regime sectorImpacts with the lab additions, LIVE LLM call
 * winning on sector-name conflict. Returns a fresh array — never mutates
 * input.
 *
 * Why live wins: the LLM classifier reads today's actual headlines, so its
 * read of a sector under the current regime is more contextual than the
 * lab's static baseline. The lab fills in sectors the LLM omits entirely
 * (the ANANTRAJ case — LLM said OIL_SHOCK affects Oil & Gas / Aviation /
 * Automobile only; lab adds Real Estate / Capital Goods / Cement as known
 * collateral damage). When live and lab disagree, the LLM's specific
 * read takes precedence.
 *
 * Edge case: if the LLM emits an unrealistic value (e.g. +999), the lab
 * is intentionally not a guard against that — adjustedScorer.js clamps
 * the resulting delta to [-5, +5] regardless of source.
 */
export function mergeLabImpacts(regime) {
  if (!regime || typeof regime.regime !== "string") {
    return [];
  }
  const live = Array.isArray(regime.sectorImpacts) ? regime.sectorImpacts : [];
  const additions = LAB_TEMPLATE_ADDITIONS[regime.regime] || [];
  if (additions.length === 0) {
    return live.slice();
  }

  const merged = new Map();
  // Lab additions first (baseline)
  for (const entry of additions) {
    if (entry && entry.sector) merged.set(entry.sector, entry);
  }
  // Then live, which overwrites on conflict (LLM's specific read wins)
  for (const entry of live) {
    if (entry && entry.sector) merged.set(entry.sector, entry);
  }
  return Array.from(merged.values());
}
