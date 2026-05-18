/**
 * Unit tests for fundamentalsV2.js — the shadow 6-pillar Snowflake-style
 * scorer (Apr 2026).
 *
 * Why this file exists:
 *   - fundamentalsV2.js is 990 LOC and was iterated repeatedly through the
 *     Phase 2 SWS-style scorer rollout, but had NO unit coverage before this
 *     PR (audit gap surfaced by the e2e-audit-2026-05-16 plan).
 *   - The module's output feeds the SWS picks-layer crosscheck (the
 *     scripts/shadow-compare.mjs diff loop) and the Snowflake hexagon UI.
 *     A silent contract regression here would corrupt the Phase 3 backtest
 *     replay AND the hexagon fills users see — both invisible until the
 *     next manual review.
 *
 * Surface covered (public exports only — pillar scorers are intentionally
 * internal):
 *   1. classifySector(snap)          — sector kind classifier (bfsi/it/utility/other)
 *   2. scoreFundamentalsV2(snap)     — main composite + verdict + pillars
 *   3. pillarScoresForRadar(result)  — flat radar-ready accessor for the UI
 *   4. SCORER_VERSION_V2             — audit-trail version constant
 *
 * Determinism:
 *   - `governance.js:getGovernance()` returns null when KV is unprimed
 *     (the default in this test environment), so the Governance pillar
 *     scores N/A. That's the intended path for these tests.
 *   - `fundamentals.js:getSectorMedianPe()` reads from disk-cached
 *     benchmarks and returns null for sectors with insufficient samples.
 *     The fixtures avoid sector strings that would trip non-deterministic
 *     median lookups by passing sectorPe via the snapshot directly.
 *
 * Run with: node test/fundamentalsV2.test.mjs
 */

import {
  SCORER_VERSION_V2,
  classifySector,
  scoreFundamentalsV2,
  pillarScoresForRadar,
} from "../fundamentalsV2.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { pass++; console.log("  ✓", name); }
  else      { fail++; console.log("  ✗", name, "→ got", JSON.stringify(got)); }
}

// ─────────────────────────────────────────────────────────────────────────
// [1] SCORER_VERSION_V2 — version string contract
// ─────────────────────────────────────────────────────────────────────────
console.log("\n[1] SCORER_VERSION_V2");
assert(
  "exported as the documented shadow-version string",
  SCORER_VERSION_V2 === "v2-shadow-apr2026",
  SCORER_VERSION_V2,
);
assert(
  "version string explicitly flags 'shadow' so log greps catch it",
  /shadow/i.test(SCORER_VERSION_V2),
  SCORER_VERSION_V2,
);

// ─────────────────────────────────────────────────────────────────────────
// [2] classifySector — sector-kind classification
// ─────────────────────────────────────────────────────────────────────────
console.log("\n[2] classifySector");

assert(
  "private bank → bfsi (sector keyword match)",
  classifySector({ sector: "Private Sector Bank" }) === "bfsi",
);
assert(
  "NBFC → bfsi",
  classifySector({ sector: "NBFC - Non Banking Financial Company" }) === "bfsi",
);
assert(
  "insurance → bfsi",
  classifySector({ sector: "Life Insurance" }) === "bfsi",
);
assert(
  "macro=Financial Services → bfsi (macro hint overrides specific sector)",
  classifySector({ macro: "Financial Services", sector: "Capital Markets" }) === "bfsi",
);
assert(
  "IT services → it",
  classifySector({ sector: "Information Technology - Software" }) === "it",
);
assert(
  "industry-level software match → it",
  classifySector({ sector: "Technology", industry: "Software" }) === "it",
);
assert(
  "power → utility",
  classifySector({ sector: "Power Generation & Distribution" }) === "utility",
);
assert(
  "gas distribution → utility",
  classifySector({ sector: "Gas Distribution" }) === "utility",
);
assert(
  "pharma → other (default tier)",
  classifySector({ sector: "Pharmaceuticals" }) === "other",
);
assert(
  "empty snap → other",
  classifySector({}) === "other",
);
assert(
  "null snap → other (no throw)",
  classifySector(null) === "other",
);

// ─────────────────────────────────────────────────────────────────────────
// [3] scoreFundamentalsV2 — composite + verdict + pillars
// ─────────────────────────────────────────────────────────────────────────
console.log("\n[3] scoreFundamentalsV2 — contract + composite + verdict");

assert(
  "null snap → null (no throw)",
  scoreFundamentalsV2(null) === null,
);
assert(
  "undefined snap → null (no throw)",
  scoreFundamentalsV2(undefined) === null,
);

// A high-quality IT snapshot: low P/E, low debt, strong ROE+margin,
// reasonable yield. Should land in the upper bands (QUALITY_GROWTH or above).
const STRONG_IT = {
  symbol: "QUALITYCO.NS",
  name: "QualityCo Ltd",
  sector: "Information Technology - Software",
  industry: "IT Services",
  macro: "Technology",
  price: 1234,
  marketCap: 5e11,
  pe: 18,                  // below absolute-PE 20 threshold
  sectorPe: 35,            // gives pe/sectorPe = 0.51 → high VALUE score
  priceToBook: 3.5,        // non-bfsi 2-4 band → ~3.0
  pegRatio: 0.9,           // gated on analystCoverage >= 5
  analystCoverage: 12,
  enterpriseToEbitda: 9,   // <=10 → ~4.0
  revenueGrowthYoY: 0.22,  // >=0.20 → 4.3
  earningsGrowthYoY: 0.25, // >=0.20 → 4.3
  forwardEpsGrowth: 0.20,  // >=0.15 → 4.0
  roe: 0.28,               // IT tier: 0.22-0.30 → 4.3
  profitMargin: 0.20,      // IT tier: >=0.15 → 4.0
  debtToEquity: 0.05,      // <=0.1 → 5.0
  currentRatio: 2.5,       // >=2.0 → 5.0
  interestCoverage: 30,    // >=15 → 5.0
  ocfToNetIncome: 1.5,     // >=1.3 → 4.0
  grossMargins: 0.40,      // >=0.35 → 4.0
  dividendYield: 0.025,    // 0.015-0.03 band → 3.0
  payoutRatio: 0.45,       // 0.30-0.60 → 5.0
  fiveYearAvgDivYield: 2.0, // 2.0% → 0.02; current 0.025/0.02 = 1.25 → 4.0
};

const strong = scoreFundamentalsV2(STRONG_IT);

assert("strong-IT snap returns an object", strong && typeof strong === "object", strong);
assert(
  "strong-IT classified as 'it' tier",
  strong.sectorKind === "it",
  strong.sectorKind,
);
assert(
  "scorerVersion stamped on output (audit-trail contract with V1)",
  strong.scorerVersion === SCORER_VERSION_V2,
  strong.scorerVersion,
);
assert(
  "scoredAt is an ISO-8601 timestamp",
  typeof strong.scoredAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(strong.scoredAt),
  strong.scoredAt,
);
assert(
  "score is an integer 0-100",
  Number.isInteger(strong.score) && strong.score >= 0 && strong.score <= 100,
  strong.score,
);
assert(
  "strong fundamentals land in upper verdict bands (>=65 → QUALITY_GROWTH or DEEP_VALUE)",
  strong.score >= 65 && (strong.verdict === "QUALITY_GROWTH" || strong.verdict === "DEEP_VALUE"),
  { score: strong.score, verdict: strong.verdict },
);
assert(
  "pillars block exposes all 6 pillar names",
  ["value", "future", "past", "health", "dividend", "governance"]
    .every(k => k in strong.pillars),
  Object.keys(strong.pillars || {}),
);
assert(
  "Governance pillar is N/A when getGovernance returns null (unprimed KV)",
  strong.pillars.governance.score === null && strong.pillars.governance.grade === "N/A",
  strong.pillars.governance,
);
assert(
  "Value pillar is populated and 'Strong' or 'Excellent' for this fixture",
  Number.isFinite(strong.pillars.value.score) &&
    (strong.pillars.value.grade === "Strong" || strong.pillars.value.grade === "Excellent"),
  { score: strong.pillars.value.score, grade: strong.pillars.value.grade },
);
assert(
  "composition.appliedWeights renormalises to sum ≈ 1.0 over active pillars",
  Math.abs(Object.values(strong.composition.appliedWeights).reduce((a, w) => a + w, 0) - 1.0) < 0.01,
  strong.composition.appliedWeights,
);
assert(
  "composition.naPillars includes 'governance' (unprimed) but not 'value'",
  strong.composition.naPillars.includes("governance") &&
    !strong.composition.naPillars.includes("value"),
  strong.composition.naPillars,
);
assert(
  "warnings array includes the N/A pillar redistribution note",
  Array.isArray(strong.warnings) &&
    strong.warnings.some(w => /Pillars N\/A.*governance/.test(w)),
  strong.warnings,
);
assert(
  "snapshot block carries the audit-trail fields",
  strong.snapshot.symbol === "QUALITYCO.NS" &&
    strong.snapshot.sectorKind === "it" &&
    strong.snapshot.pe === 18,
  strong.snapshot,
);

// ─────────────────────────────────────────────────────────────────────────
// [4] Verdict-band monotonicity — a weak snapshot should land below a strong one
// ─────────────────────────────────────────────────────────────────────────
console.log("\n[4] scoreFundamentalsV2 — verdict ordering vs weak snapshot");

const WEAK_PHARMA = {
  symbol: "WEAKCO.NS",
  name: "WeakCo Ltd",
  sector: "Pharmaceuticals",
  pe: 95,                 // >80 → 0.2 absolute-PE
  sectorPe: 30,           // pe/sectorPe ~3.2 → 0.2
  priceToBook: 12,        // >8 → 0.5
  revenueGrowthYoY: -0.15,
  earningsGrowthYoY: -0.20,
  roe: -0.05,             // negative ROE → 0.0
  profitMargin: -0.08,    // negative margin → 0.0
  debtToEquity: 3.5,      // >2 → 0.3
  currentRatio: 0.6,      // <0.8 → 0.3
  interestCoverage: 0.5,  // <1 → 0.0
  ocfToNetIncome: 0.4,    // <0.7 → 0.5
  grossMargins: 0.05,     // <0.10 → 1.0
  // Non-payer → Dividend pillar N/A
  dividendYield: 0,
};

const weak = scoreFundamentalsV2(WEAK_PHARMA);

assert(
  "weak-pharma snap returns an object",
  weak && typeof weak === "object",
  weak,
);
assert(
  "weak-pharma classified as 'other' tier",
  weak.sectorKind === "other",
  weak.sectorKind,
);
assert(
  "weak fundamentals score strictly less than strong fundamentals",
  weak.score < strong.score,
  { weak: weak.score, strong: strong.score },
);
assert(
  "weak fundamentals land at or below FAIR_VALUE band",
  ["FAIR_VALUE", "FULLY_VALUED", "OVERVALUED"].includes(weak.verdict),
  { score: weak.score, verdict: weak.verdict },
);
assert(
  "non-payer triggers Dividend pillar N/A (NOT 0)",
  weak.pillars.dividend.score === null && weak.pillars.dividend.grade === "N/A",
  weak.pillars.dividend,
);
assert(
  "Dividend N/A signal explains the redistribution",
  weak.pillars.dividend.signals.some(s => /Non-dividend-payer/.test(s)),
  weak.pillars.dividend.signals,
);
assert(
  "warnings surface negative-ROE 'destroying shareholder value' signal",
  weak.warnings.some(w => /destroying|negative/i.test(w)),
  weak.warnings,
);
assert(
  "naPillars list contains dividend AND governance (both weight-redistributed)",
  weak.composition.naPillars.includes("dividend") &&
    weak.composition.naPillars.includes("governance"),
  weak.composition.naPillars,
);

// ─────────────────────────────────────────────────────────────────────────
// [5] BFSI tier — verifies tier-adaptive pillar input gating
// ─────────────────────────────────────────────────────────────────────────
console.log("\n[5] scoreFundamentalsV2 — BFSI tier-adaptive inputs");

const BANK = {
  symbol: "BIGBANK.NS",
  name: "BigBank Ltd",
  sector: "Private Sector Bank",
  pe: 14,
  sectorPe: 18,
  priceToBook: 1.4,        // bfsi 1.2-2.0 → 3.0
  roe: 0.15,               // bfsi >=0.14 → 4.3
  profitMargin: 0.20,
  revenueGrowthYoY: 0.14,
  earningsGrowthYoY: 0.16,
  debtToEquity: 6.0,       // bfsi: D/E NOT scored (regulator-driven leverage)
  currentRatio: 0.8,       // bfsi: not scored
  interestCoverage: 1.2,   // bfsi: not scored
  ocfToNetIncome: 1.0,     // bfsi threshold lower; should still score
  grossMargins: 0.30,      // bfsi: not scored
  dividendYield: 0.018,
  payoutRatio: 0.25,
};

const bank = scoreFundamentalsV2(BANK);

assert(
  "BFSI snap classified as 'bfsi'",
  bank.sectorKind === "bfsi",
  bank.sectorKind,
);
// NOTE on debtToEquity audit-vs-score split: the BFSI branch in scoreHealth
// still captures `inputs.debtToEquity` for audit-trail completeness, it just
// does NOT push a sub-score (D/E is regulator-mandated for banks and not
// signal). So we assert the score-side contract: the Health composite must
// NOT have been influenced by D/E. The easiest portable check is that the
// bank's Health score is identical when we drop a 6.0 D/E from the fixture.
const bankNoDe = scoreFundamentalsV2({ ...BANK, debtToEquity: null });
assert(
  "BFSI Health score unaffected by D/E (D/E captured for audit but not scored)",
  bank.pillars.health.score === bankNoDe.pillars.health.score,
  { withDe: bank.pillars.health.score, withoutDe: bankNoDe.pillars.health.score },
);
assert(
  "BFSI Health pillar input does NOT include currentRatio (not meaningful for banks)",
  !("currentRatio" in (bank.pillars.health.inputs || {})),
  bank.pillars.health.inputs,
);
assert(
  "BFSI Health pillar input does NOT include interestCoverage (not meaningful for banks)",
  !("interestCoverage" in (bank.pillars.health.inputs || {})),
  bank.pillars.health.inputs,
);
assert(
  "BFSI Health pillar DOES include ocfToNetIncome (earnings-quality canary applies)",
  "ocfToNetIncome" in (bank.pillars.health.inputs || {}),
  bank.pillars.health.inputs,
);
assert(
  "BFSI Value pillar does NOT include evEbitda (banks don't report EBITDA)",
  !("evEbitda" in (bank.pillars.value.inputs || {})),
  bank.pillars.value.inputs,
);
assert(
  "BFSI tier picks the bfsi PILLAR_WEIGHTS row (past=0.25 vs 0.20 elsewhere; verify via applied weight on past)",
  // past weight in bfsi row is 0.25; in 'other'/'it' it's 0.20-0.20. After
  // renorming over 5 active pillars (governance N/A drops 0.10), bfsi past →
  // 0.25 / 0.90 ≈ 0.278 vs other → 0.20 / 0.90 ≈ 0.222.
  bank.composition.appliedWeights.past > 0.25,
  bank.composition.appliedWeights,
);

// ─────────────────────────────────────────────────────────────────────────
// [6] pillarScoresForRadar — flat accessor for the Snowflake UI
// ─────────────────────────────────────────────────────────────────────────
console.log("\n[6] pillarScoresForRadar");

assert(
  "null input → null (no throw)",
  pillarScoresForRadar(null) === null,
);
assert(
  "undefined input → null",
  pillarScoresForRadar(undefined) === null,
);
assert(
  "input without .pillars → null",
  pillarScoresForRadar({ score: 70, verdict: "QUALITY_GROWTH" }) === null,
);

const radar = pillarScoresForRadar(strong);
assert(
  "radar shape has all 6 keys",
  ["value", "future", "past", "health", "dividend", "governance"]
    .every(k => k in radar),
  Object.keys(radar || {}),
);
assert(
  "radar.governance reflects the N/A pillar as null (not 0)",
  radar.governance === null,
  radar.governance,
);
assert(
  "radar.value is numeric for a fixture that populates VALUE inputs",
  Number.isFinite(radar.value),
  radar.value,
);
assert(
  "radar.value equals strong.pillars.value.score (pass-through, no mutation)",
  radar.value === strong.pillars.value.score,
  { radar: radar.value, pillar: strong.pillars.value.score },
);

const radarWeak = pillarScoresForRadar(weak);
assert(
  "non-payer fixture surfaces dividend as null in radar (consistent with pillar N/A)",
  radarWeak.dividend === null,
  radarWeak.dividend,
);

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
