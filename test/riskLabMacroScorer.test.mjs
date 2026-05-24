import {
  LAB_TEMPLATE_ADDITIONS,
  mergeLabImpacts,
} from "../services/riskLab/macro/sectorTemplates.js";
import {
  resolveSectorsForTicker,
  hasOverride,
  TICKER_SECTOR_OVERRIDES,
} from "../services/riskLab/macro/sectorOverrides.js";
import {
  adjustedScoreForRow,
  adjustedScoresForRows,
} from "../services/riskLab/macro/adjustedScorer.js";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

function makeRegime(overrides = {}) {
  // Realistic shape — production sectorImpacts list (no Real Estate)
  return {
    regime: "OIL_SHOCK",
    regimeLabel: "Oil Shock",
    severity: 3,
    confidence: 0.7,
    sectorImpacts: [
      { sector: "Oil & Gas", impact: 3, reason: "Crude price spike" },
      { sector: "Aviation", impact: -3, reason: "Fuel cost squeeze" },
      { sector: "Automobile", impact: -2, reason: "Input cost pressure" },
    ],
    reasoning: "OPEC+ supply cut",
    generatedAt: new Date().toISOString(), // fresh
    ...overrides,
  };
}

function makeRow(overrides = {}) {
  return {
    ticker: "ANANTRAJ",
    name: "Anant Raj Limited",
    sector: "Diversified Financials", // SWS miscategorisation
    v4_verdict: "TOP_PICK",
    v4_score_100: 64.8,
    score: 50.9,
    ...overrides,
  };
}

console.log("riskLabMacroScorer: LAB_TEMPLATE_ADDITIONS coverage");
{
  // CRITICAL: every regime that the ANANTRAJ/KEC case studies care about
  // must include Real Estate in its lab additions.
  assert(
    "OIL_SHOCK adds Real Estate",
    LAB_TEMPLATE_ADDITIONS.OIL_SHOCK.some((s) => s.sector === "Real Estate"),
  );
  assert(
    "WAR_ESCALATION adds Real Estate",
    LAB_TEMPLATE_ADDITIONS.WAR_ESCALATION.some((s) => s.sector === "Real Estate"),
  );
  assert(
    "GLOBAL_RISK_OFF adds Real Estate",
    LAB_TEMPLATE_ADDITIONS.GLOBAL_RISK_OFF.some((s) => s.sector === "Real Estate"),
  );
  assert(
    "OIL_SHOCK adds Capital Goods",
    LAB_TEMPLATE_ADDITIONS.OIL_SHOCK.some((s) => s.sector === "Capital Goods"),
  );
  assert(
    "CALM is empty",
    LAB_TEMPLATE_ADDITIONS.CALM.length === 0,
  );
}

console.log("riskLabMacroScorer: mergeLabImpacts");
{
  const regime = makeRegime();
  const merged = mergeLabImpacts(regime);
  // Should contain both live entries (Oil & Gas, Aviation, Automobile) AND
  // lab additions (Real Estate, Capital Goods, Cement, Banking, Metals).
  const sectors = merged.map((s) => s.sector);
  assert("merged contains live Oil & Gas", sectors.includes("Oil & Gas"));
  assert("merged contains lab Real Estate", sectors.includes("Real Estate"));
  assert("merged contains lab Capital Goods", sectors.includes("Capital Goods"));
  assert("merged contains lab Cement", sectors.includes("Cement"));

  // CALM regime → empty merge
  assert("CALM merged is empty", mergeLabImpacts({ regime: "CALM", sectorImpacts: [] }).length === 0);

  // Null regime → empty
  assert("null regime → empty", mergeLabImpacts(null).length === 0);

  // Live wins on conflict — the LLM's specific read takes precedence
  // because it incorporates today's actual headlines vs the lab's static
  // baseline. Adjusted scorer clamps the resulting delta either way.
  const regimeConflict = makeRegime({
    sectorImpacts: [{ sector: "Real Estate", impact: -3, reason: "LLM-specific read" }],
  });
  const mergedConflict = mergeLabImpacts(regimeConflict);
  const re = mergedConflict.find((s) => s.sector === "Real Estate");
  assert("live wins over lab for Real Estate", re && re.impact === -3);
}

console.log("riskLabMacroScorer: sectorOverrides");
{
  // ANANTRAJ canonical case — MUST be tagged Real Estate
  assert("ANANTRAJ → Real Estate", TICKER_SECTOR_OVERRIDES.ANANTRAJ === "Real Estate");
  assert("ANANTRAJ hasOverride", hasOverride("ANANTRAJ") === true);
  assert("ANANTRAJ resolveSectorsForTicker → Real Estate", resolveSectorsForTicker("ANANTRAJ", "Diversified Financials") === "Real Estate");

  // Lowercase ticker should still resolve
  assert("anantraj (lowercase) → Real Estate", resolveSectorsForTicker("anantraj", "Diversified Financials") === "Real Estate");

  // Diversified conglomerate gets array
  const ril = resolveSectorsForTicker("RELIANCE", "Energy");
  assert("RELIANCE → array", Array.isArray(ril) && ril.length >= 2);

  // Unknown ticker → falls back to source sector
  assert("unknown ticker → source sector", resolveSectorsForTicker("UNKNOWN", "Pharma") === "Pharma");

  // Unknown ticker + no source → null
  assert("unknown ticker + no source → null", resolveSectorsForTicker("UNKNOWN", null) === null);
}

console.log("riskLabMacroScorer: adjustedScoreForRow — ANANTRAJ canonical case");
{
  // THE most important test. ANANTRAJ + OIL_SHOCK sev 3 must produce a
  // non-zero macro_score_delta. If this fails, the entire Risk Lab does
  // not solve the user's stated problem.
  const result = adjustedScoreForRow(makeRow(), makeRegime());
  assert("ANANTRAJ has non-zero macro_score_delta", result.macro_score_delta < 0, result.macro_score_delta);
  assert("ANANTRAJ sector_used = Real Estate", result.sector_used === "Real Estate", result.sector_used);
  assert("ANANTRAJ sector_overridden = true", result.sector_overridden === true);
  assert("ANANTRAJ lab_template_used = true", result.lab_template_used === true);
  // OIL_SHOCK is sev 3 (not severe enough for veto threshold of 4) → no veto
  assert("ANANTRAJ no veto at sev 3", result.macro_veto.vetoed === false);
  // Original score preserved
  assert("ANANTRAJ original_score unchanged", result.original_score === 64.8);
  assert("ANANTRAJ original_verdict unchanged", result.original_verdict === "TOP_PICK");
  // Adjusted score = original + delta
  assert(
    "ANANTRAJ adjusted_score = original + delta",
    Math.abs(result.macro_adjusted_score - (result.original_score + result.macro_score_delta)) < 0.01,
  );
}

console.log("riskLabMacroScorer: adjustedScoreForRow — escalation to veto");
{
  // Same ANANTRAJ but regime escalates to WAR_ESCALATION sev 5 (Real Estate
  // impact -2 in lab additions). impact -2 is above the -3 threshold so
  // still no veto.
  const sev5 = adjustedScoreForRow(makeRow(), makeRegime({
    regime: "WAR_ESCALATION",
    severity: 5,
    sectorImpacts: [{ sector: "Defence", impact: 4, reason: "war boost" }],
  }));
  assert("WAR_ESCALATION sev5 + Real Estate (impact -2) → no veto", sev5.macro_veto.vetoed === false);

  // Now bump the impact to -3 by replacing the lab template indirectly via
  // a custom regime sectorImpacts. Sets up the exact veto condition.
  const sev5strong = adjustedScoreForRow(makeRow(), makeRegime({
    regime: "WAR_ESCALATION",
    severity: 5,
    sectorImpacts: [{ sector: "Real Estate", impact: -3, reason: "Aggressive risk-off" }],
  }));
  assert("WAR_ESCALATION sev5 + Real Estate (impact -3) → veto", sev5strong.macro_veto.vetoed === true);
  assert("vetoed → adjusted verdict MACRO_HOLD", sev5strong.macro_adjusted_verdict === "MACRO_HOLD");
  assert("vetoed → original_verdict still TOP_PICK", sev5strong.original_verdict === "TOP_PICK");
}

console.log("riskLabMacroScorer: adjustedScoreForRow — guards");
{
  // CALM → no adjustment
  const calm = adjustedScoreForRow(makeRow(), makeRegime({ regime: "CALM", severity: 1, sectorImpacts: [] }));
  assert("CALM → delta 0", calm.macro_score_delta === 0);

  // Stale regime (>12h old) → no adjustment, regime_stale flag
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const stale = adjustedScoreForRow(makeRow(), makeRegime({ generatedAt: old }));
  assert("stale regime → delta 0", stale.macro_score_delta === 0);
  assert("stale regime → regime_stale true", stale.regime_stale === true);

  // Severity 1 → no adjustment (below threshold)
  const lowSev = adjustedScoreForRow(makeRow(), makeRegime({ severity: 1 }));
  assert("sev 1 → delta 0", lowSev.macro_score_delta === 0);

  // Unknown sector AND no override → no adjustment
  const unknown = adjustedScoreForRow({ ticker: "UNKNOWN", v4_verdict: "TOP_PICK", v4_score_100: 50, sector: "Other" }, makeRegime());
  assert("unknown sector → delta 0", unknown.macro_score_delta === 0);

  // Sector not in regime impact list → delta 0
  const pharmaUnderOilShock = adjustedScoreForRow(
    { ticker: "SUNPHARMA", v4_verdict: "STRONG", v4_score_100: 60, sector: "Pharmaceuticals & Biotech" },
    makeRegime(),
  );
  // Pharma is not in OIL_SHOCK live or lab impacts → 0
  assert("Pharma under OIL_SHOCK → delta 0", pharmaUnderOilShock.macro_score_delta === 0);

  // Null row → safe defaults
  const nullRow = adjustedScoreForRow(null, makeRegime());
  assert("null row → ticker null", nullRow.ticker === null);
  assert("null row → delta 0", nullRow.macro_score_delta === 0);
}

console.log("riskLabMacroScorer: diversified worst-case picking");
{
  // RELIANCE has [Oil & Gas, Telecom, Retail] override. Under OIL_SHOCK
  // base regime: Oil & Gas impact +3 (positive!), Telecom not in list,
  // Retail not in list. Worst should be Oil & Gas at +3 delta (positive).
  const ril = adjustedScoreForRow(
    { ticker: "RELIANCE", v4_verdict: "TOP_PICK", v4_score_100: 70, sector: "Energy" },
    makeRegime(),
  );
  // Oil & Gas is +3 impact, but worstSectorImpact picks MOST NEGATIVE.
  // None of Telecom/Retail are in the regime → delta 0 for those. So worst
  // is min(positive +N from Oil & Gas, 0, 0) = 0. RELIANCE gets 0 delta —
  // which is correct behaviour: when only positive impacts apply, no veto.
  assert("RELIANCE picks worst (zero) sector", ril.macro_score_delta === 0);
}

console.log("riskLabMacroScorer: adjustedScoresForRows batch");
{
  const rows = [
    makeRow(),
    makeRow({ ticker: "DLF", sector: "Realty", v4_verdict: "STRONG", v4_score_100: 55 }),
    makeRow({ ticker: "AVIATION1", sector: "Airlines", v4_verdict: "TOP_PICK", v4_score_100: 50 }),
  ];
  const results = adjustedScoresForRows(rows, makeRegime());
  assert("batch returns 3 results", results.length === 3);
  assert("batch preserves order — ANANTRAJ first", results[0].ticker === "ANANTRAJ");
  assert("batch result 0 has macro_score_delta", typeof results[0].macro_score_delta === "number");
  // null input → empty array
  assert("null batch → []", adjustedScoresForRows(null, makeRegime()).length === 0);
}

if (_failed === 0) {
  console.log(`riskLabMacroScorer: PASS`);
  process.exit(0);
} else {
  console.error(`riskLabMacroScorer: FAIL (${_failed})`);
  process.exit(1);
}
