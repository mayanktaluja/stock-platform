/**
 * Fundamentals V2 — Snowflake-style 6-pillar scorer (SHADOW MODE, Apr 2026)
 *
 * ───────────────────────────────────────────────────────────────────────
 * STATUS: shadow only. NOT USED FOR PRODUCTION VERDICTS.
 * ───────────────────────────────────────────────────────────────────────
 *
 * This module runs alongside the V1 scorer in fundamentals.js. V1 continues
 * to produce the verdict that appears in the scanner UI and buckets. V2's
 * output is attached to API responses as a parallel `shadowV2` block so:
 *
 *   1. The client can show the SWS-style Snowflake hexagon (Phase 4 UI).
 *   2. scripts/shadow-compare.mjs can diff V1 vs V2 across the universe
 *      and flag any stock where the two scorers disagree by >15 points or
 *      cross a verdict boundary. We walk that delta list before any
 *      production swap is even considered.
 *   3. Phase 3 backtest can replay both scorers over 3/5/8 year histories
 *      and measure XIRR delta before we flip the default.
 *
 * ───────────────────────────────────────────────────────────────────────
 * Design differences from V1
 * ───────────────────────────────────────────────────────────────────────
 *
 *  V1                                     | V2
 *  -------------------------------------- | ---------------------------
 *  9 dimensions, ±points from 50 base     | 6 pillars, each scored 0–5
 *  5 pillars baked into the dimension mix | 6 pillars as first-class outputs
 *  Missing input → skip with 0 points     | Missing input → pillar N/A,
 *                                         |   weight redistributed across
 *                                         |   remaining pillars
 *  Same thresholds for all sectors        | Tier-adaptive: BFSI skips EBITDA,
 *                                         |   interest-coverage, current-ratio
 *  No forward-looking inputs              | Analyst consensus gated on
 *                                         |   coverage >= 5 (honesty flag)
 *  No Governance pillar                   | Governance via governance.js stub;
 *                                         |   null today, wired for Phase 2.x
 *  No Dividend pillar                     | Dividend pillar, N/A for non-payers
 *
 * ───────────────────────────────────────────────────────────────────────
 * Pillar definitions
 * ───────────────────────────────────────────────────────────────────────
 *
 *  VALUE    — P/E vs sector, absolute P/E, priceToBook, PEG (if coverage ok)
 *             EV/EBITDA (if not BFSI). Purpose: "is it cheap?"
 *
 *  FUTURE   — earnings growth YoY, forward EPS growth (if coverage ok),
 *             revenue growth YoY. Purpose: "where are earnings heading?"
 *
 *  PAST     — multi-year ROE, profit margin, revenue growth CONSISTENCY.
 *             V1 looked at point-in-time ROE; V2 treats ROE and margin as
 *             stability signals. Purpose: "has this company delivered before?"
 *
 *  HEALTH   — currentRatio (not BFSI), interest coverage (not BFSI), D/E,
 *             OCF/NetIncome (earnings quality), gross margins.
 *             Purpose: "can it survive a downturn?"
 *
 *  DIVIDEND — yield, payout sustainability, 5-year avg vs current.
 *             N/A FOR NON-PAYERS — not 0. This is the single biggest
 *             deviation from V1's implicit behaviour. A growth company
 *             with 0% payout shouldn't be docked for it; instead we
 *             redistribute Dividend weight across other pillars.
 *             Purpose: "is the yield sustainable?"
 *
 *  GOVERNANCE — promoter pledge, FII/DII mix, RPT flags.
 *               Currently STUBBED — governance.js returns null until
 *               the BSE XBRL fetcher lands. When null, Governance pillar
 *               is N/A and its weight redistributes.
 *               Purpose: "who controls this business, and can we trust them?"
 *
 * ───────────────────────────────────────────────────────────────────────
 * SEBI compliance
 * ───────────────────────────────────────────────────────────────────────
 *
 * The `scoredAt`, `scorerVersion`, and `snapshot` audit fields match V1's
 * contract so audit-trail consumers can handle both scorers uniformly.
 * The V2 version string is "v2-shadow-apr2026" to make it obvious in logs
 * that this output is NOT production-authoritative.
 *
 * Reg 15(2) compliance note: V2 is explicitly marked SHADOW in every
 * output path. Any UI that surfaces a V2 score MUST prepend "Shadow/Beta"
 * labelling so users don't mistake it for the gated production verdict.
 */

import { getSectorMedianPe } from "./fundamentals.js";
import { getGovernance } from "./governance.js";

export const SCORER_VERSION_V2 = "v2-shadow-apr2026";

// ==================== SECTOR CLASSIFICATION ====================

/**
 * Coarse sector kind for tier-adaptive scoring. We only need the
 * distinctions that change WHICH pillar inputs are meaningful, not the
 * fine-grained NSE industry taxonomy.
 *
 *   "bfsi"          — banks, NBFCs, insurance. Skip currentRatio,
 *                     interestCoverage, EBITDA. D/E uses a different
 *                     threshold (regulators mandate higher leverage).
 *   "it"            — IT services. Historically asset-light, high ROE,
 *                     low D/E — the scoring thresholds for these are
 *                     stricter than for capex-heavy sectors.
 *   "utility"       — high-capex regulated utilities. Low ROE is normal,
 *                     high D/E is normal.
 *   "other"         — everything else uses the default thresholds.
 *
 * This is deliberately coarse. Phase 3 can refine with per-industry
 * thresholds once we have sufficient backtest data.
 */
export function classifySector(snap) {
  const macro = (snap?.macro || "").toLowerCase();
  const sector = (snap?.sector || "").toLowerCase();
  const industry = (snap?.industry || "").toLowerCase();

  if (macro.includes("financial") || /bank|nbfc|insur|finance|capital market/.test(sector)) {
    return "bfsi";
  }
  if (/information technology|software|it services|it consulting/.test(sector) ||
      /software|it services/.test(industry)) {
    return "it";
  }
  if (/power|utilit|gas distribut/.test(sector)) {
    return "utility";
  }
  return "other";
}

// ==================== PILLAR SCORERS ====================
//
// Each pillar scorer returns:
//   {
//     score:    number | null   — 0-5 (5=best), or null for "not applicable"
//     grade:    string          — human label: "Excellent"/"Strong"/"Fair"/
//                                 "Weak"/"Poor"/"N/A"
//     signals:  string[]        — reasoning snippets for the UI
//     inputs:   object          — the actual values read from snap, for audit
//     coverage: number          — 0-1 indicating how many of this pillar's
//                                 expected inputs were populated. <0.5 is
//                                 low confidence and the composer down-weights.
//   }
//
// Returning null score when every input is missing means the composer
// redistributes this pillar's weight. Returning 0 is reserved for "we have
// the data and it's terrible".

function gradeFrom05(score) {
  if (score == null) return "N/A";
  if (score >= 4.5) return "Excellent";
  if (score >= 3.5) return "Strong";
  if (score >= 2.5) return "Fair";
  if (score >= 1.5) return "Weak";
  return "Poor";
}

function clamp05(v) {
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(5, v));
}

/**
 * VALUE pillar.
 *
 * Inputs (in priority order):
 *   1. P/E vs sector median — strongest signal, uses either NSE's sectorPe
 *      or our computed median (same source hierarchy as V1)
 *   2. Absolute P/E — catches hype-priced stocks regardless of sector
 *   3. Price-to-book — essential for banks where P/E can be misleading
 *   4. PEG — future pillar overlap but specifically a "valuation-adjusted-
 *      for-growth" signal; only when analyst coverage is honest (>=5)
 *   5. EV/EBITDA — skipped for BFSI (they don't report EBITDA)
 *
 * Output 0-5 is the weighted average of these sub-signals, each rescaled
 * from their own band to 0-5.
 */
function scoreValue(snap, sectorKind) {
  const signals = [];
  const inputs = {};
  const subScores = [];

  const pe = Number.isFinite(snap?.pe) ? snap.pe : null;
  const nseSectorPe = Number.isFinite(snap?.sectorPe) ? snap.sectorPe : null;
  const priceToBook = Number.isFinite(snap?.priceToBook) ? snap.priceToBook : null;
  const pegRatio = Number.isFinite(snap?.pegRatio) ? snap.pegRatio : null;
  const evEbitda = Number.isFinite(snap?.enterpriseToEbitda) ? snap.enterpriseToEbitda : null;
  const analystCoverage = Number.isFinite(snap?.analystCoverage) ? snap.analystCoverage : 0;

  // ── P/E vs sector ──
  // Reuse V1's circular-detection logic: if NSE's sectorPe is within 1% of
  // the stock's own P/E, that's the heavyweight circular case and we fall
  // back to our own computed median.
  let sectorPe = null;
  if (pe && nseSectorPe && pe > 0 && nseSectorPe > 0) {
    const circular = Math.abs(pe - nseSectorPe) / nseSectorPe < 0.01;
    sectorPe = circular ? getSectorMedianPe(snap.sector) : nseSectorPe;
  } else if (pe && pe > 0) {
    sectorPe = getSectorMedianPe(snap.sector);
  }

  if (pe && pe > 0 && sectorPe && sectorPe > 0) {
    const ratio = pe / sectorPe;
    inputs.peVsSectorRatio = ratio;
    // Continuous rescale — extreme discount → 5, fair → 2.5, extreme premium → 0
    let s;
    if (ratio <= 0.4)      { s = 5.0; signals.push(`P/E ${pe.toFixed(1)} is a steep discount to sector`); }
    else if (ratio <= 0.6) { s = 4.2; }
    else if (ratio <= 0.8) { s = 3.5; }
    else if (ratio <= 1.0) { s = 2.8; }
    else if (ratio <= 1.2) { s = 2.2; }
    else if (ratio <= 1.5) { s = 1.5; signals.push(`P/E ${pe.toFixed(1)} notably above sector`); }
    else if (ratio <= 2.0) { s = 0.8; signals.push(`P/E stretched vs sector`); }
    else                   { s = 0.2; signals.push(`P/E extreme premium to sector`); }
    subScores.push({ name: "peVsSector", weight: 3, value: s });
  }

  // ── Absolute P/E ──
  if (pe && pe > 0) {
    inputs.pe = pe;
    let s;
    if (pe <= 10)       s = 5.0;
    else if (pe <= 15)  s = 4.2;
    else if (pe <= 20)  s = 3.5;
    else if (pe <= 30)  s = 2.5;
    else if (pe <= 50)  s = 1.5;
    else if (pe <= 80)  s = 0.8;
    else                s = 0.2;
    subScores.push({ name: "absolutePe", weight: 2, value: s });
  } else if (pe === null || pe <= 0) {
    // Loss-making — don't score this as "expensive", surface it via Past pillar
    signals.push("No positive earnings — cannot value on P/E");
  }

  // ── Price-to-book ──
  // Essential for BFSI (where P/E can be distorted by loan-loss provisioning).
  // General cap: P/B 1-3 is typical; >5 is expensive, <1 is distressed/deep value.
  if (priceToBook && priceToBook > 0) {
    inputs.priceToBook = priceToBook;
    let s;
    // BFSI threshold shifts — banks typically trade 1-2x book, not 3-4x like IT
    const isBfsi = sectorKind === "bfsi";
    if (isBfsi) {
      if (priceToBook <= 0.8)      s = 5.0;
      else if (priceToBook <= 1.2) s = 4.0;
      else if (priceToBook <= 2.0) s = 3.0;
      else if (priceToBook <= 3.0) s = 1.8;
      else                         s = 0.5;
    } else {
      if (priceToBook <= 1.0)      s = 5.0;
      else if (priceToBook <= 2.0) s = 4.0;
      else if (priceToBook <= 4.0) s = 3.0;
      else if (priceToBook <= 8.0) s = 1.8;
      else                         s = 0.5;
    }
    subScores.push({ name: "priceToBook", weight: isBfsi ? 3 : 2, value: s });
  }

  // ── PEG ── (analyst-dependent, gated on honest coverage)
  if (pegRatio && pegRatio > 0 && analystCoverage >= 5) {
    inputs.pegRatio = pegRatio;
    let s;
    if (pegRatio <= 0.8)      s = 5.0;
    else if (pegRatio <= 1.2) s = 4.0;
    else if (pegRatio <= 1.8) s = 3.0;
    else if (pegRatio <= 3.0) s = 1.8;
    else                      s = 0.8;
    subScores.push({ name: "peg", weight: 1, value: s });
    if (s >= 4) signals.push(`PEG ${pegRatio.toFixed(2)} — growth-adjusted value`);
  }

  // ── EV/EBITDA ── (non-BFSI only)
  if (sectorKind !== "bfsi" && evEbitda && evEbitda > 0) {
    inputs.evEbitda = evEbitda;
    let s;
    if (evEbitda <= 6)       s = 5.0;
    else if (evEbitda <= 10) s = 4.0;
    else if (evEbitda <= 16) s = 3.0;
    else if (evEbitda <= 25) s = 1.8;
    else                     s = 0.5;
    subScores.push({ name: "evEbitda", weight: 1, value: s });
  }

  if (subScores.length === 0) {
    return { score: null, grade: "N/A", signals, inputs, coverage: 0 };
  }

  const totalW = subScores.reduce((a, s) => a + s.weight, 0);
  const score = subScores.reduce((a, s) => a + s.value * s.weight, 0) / totalW;
  // Coverage: out of max 5 possible sub-signals (pe-vs-sector, abs-pe, pb, peg, ev-ebitda)
  const coverage = subScores.length / 5;
  return { score: clamp05(score), grade: gradeFrom05(score), signals, inputs, coverage };
}

/**
 * FUTURE pillar.
 *
 * Inputs:
 *   1. Revenue growth YoY — backward-looking but the most reliable signal
 *   2. Earnings growth YoY — forward indicator via reported earnings
 *   3. Forward EPS growth — derived, gated on analyst coverage >= 5
 *   4. Analyst coverage count — not a sub-score itself, used to gate #3
 *
 * Notable: we do NOT score "number of analysts" as a positive — it's a
 * trust filter on the forward fields.
 */
function scoreFuture(snap) {
  const signals = [];
  const inputs = {};
  const subScores = [];

  const revGrowth = Number.isFinite(snap?.revenueGrowthYoY) ? snap.revenueGrowthYoY : null;
  const earningsGrowth = Number.isFinite(snap?.earningsGrowthYoY) ? snap.earningsGrowthYoY : null;
  const forwardEpsGrowth = Number.isFinite(snap?.forwardEpsGrowth) ? snap.forwardEpsGrowth : null;
  const analystCoverage = Number.isFinite(snap?.analystCoverage) ? snap.analystCoverage : 0;

  if (revGrowth != null) {
    inputs.revenueGrowthYoY = revGrowth;
    let s;
    if (revGrowth >= 0.30)      { s = 5.0; signals.push(`Revenue growing ${(revGrowth * 100).toFixed(0)}% YoY — strong`); }
    else if (revGrowth >= 0.20) { s = 4.3; }
    else if (revGrowth >= 0.12) { s = 3.5; }
    else if (revGrowth >= 0.05) { s = 2.5; }
    else if (revGrowth >= 0)    { s = 1.8; }
    else if (revGrowth >= -0.1) { s = 0.8; signals.push("Revenue mildly declining"); }
    else                        { s = 0.2; signals.push(`Revenue declining ${(revGrowth * 100).toFixed(0)}% — deteriorating`); }
    subScores.push({ name: "revenueGrowth", weight: 2, value: s });
  }

  if (earningsGrowth != null) {
    inputs.earningsGrowthYoY = earningsGrowth;
    let s;
    if (earningsGrowth >= 0.30)      s = 5.0;
    else if (earningsGrowth >= 0.20) s = 4.3;
    else if (earningsGrowth >= 0.12) s = 3.5;
    else if (earningsGrowth >= 0.05) s = 2.5;
    else if (earningsGrowth >= 0)    s = 1.8;
    else if (earningsGrowth >= -0.1) s = 0.8;
    else                             s = 0.2;
    subScores.push({ name: "earningsGrowth", weight: 2, value: s });
  }

  if (forwardEpsGrowth != null && analystCoverage >= 5) {
    inputs.forwardEpsGrowth = forwardEpsGrowth;
    inputs.analystCoverage = analystCoverage;
    let s;
    if (forwardEpsGrowth >= 0.25)      { s = 5.0; signals.push(`Forward EPS growth ${(forwardEpsGrowth * 100).toFixed(0)}% (${analystCoverage} analysts)`); }
    else if (forwardEpsGrowth >= 0.15) s = 4.0;
    else if (forwardEpsGrowth >= 0.08) s = 3.0;
    else if (forwardEpsGrowth >= 0)    s = 2.0;
    else                               s = 0.8;
    subScores.push({ name: "forwardEpsGrowth", weight: 1.5, value: s });
  } else if (forwardEpsGrowth != null && analystCoverage < 5) {
    signals.push(`Forward EPS growth available but only ${analystCoverage} analysts — excluded`);
  }

  if (subScores.length === 0) {
    return { score: null, grade: "N/A", signals, inputs, coverage: 0 };
  }

  const totalW = subScores.reduce((a, s) => a + s.weight, 0);
  const score = subScores.reduce((a, s) => a + s.value * s.weight, 0) / totalW;
  const coverage = subScores.length / 3;
  return { score: clamp05(score), grade: gradeFrom05(score), signals, inputs, coverage };
}

/**
 * PAST pillar.
 *
 * Inputs:
 *   1. ROE — single strongest past-performance signal
 *   2. Profit margin — complements ROE; ROE can be leveraged into, margin is real
 *   3. Revenue growth history — we only have latest YoY right now, but this
 *      pillar will evolve in Phase 3 once we store multi-year snapshots
 *
 * Tier-adaptive thresholds: BFSI accepts ROE >= 12% as good (vs 15% for non-BFSI)
 * because banking ROE is structurally lower due to capital requirements.
 */
function scorePast(snap, sectorKind) {
  const signals = [];
  const inputs = {};
  const subScores = [];

  const roe = Number.isFinite(snap?.roe) ? snap.roe : null;
  const profitMargin = Number.isFinite(snap?.profitMargin) ? snap.profitMargin : null;
  const revGrowth = Number.isFinite(snap?.revenueGrowthYoY) ? snap.revenueGrowthYoY : null;

  if (roe != null) {
    inputs.roe = roe;
    let s;
    // BFSI: banks structurally lower ROE. 12% is good, 15% is excellent.
    // IT: asset-light, 20%+ is normal. High bar: 25%.
    // Others: 15% good, 20% excellent.
    if (sectorKind === "bfsi") {
      if (roe >= 0.18)      { s = 5.0; signals.push(`ROE ${(roe * 100).toFixed(1)}% — excellent for bank/NBFC`); }
      else if (roe >= 0.14) s = 4.3;
      else if (roe >= 0.10) s = 3.5;
      else if (roe >= 0.06) s = 2.0;
      else if (roe >= 0)    s = 0.8;
      else                  s = 0.0;
    } else if (sectorKind === "it") {
      if (roe >= 0.30)      { s = 5.0; signals.push(`ROE ${(roe * 100).toFixed(1)}% — IT-grade capital efficiency`); }
      else if (roe >= 0.22) s = 4.3;
      else if (roe >= 0.15) s = 3.5;
      else if (roe >= 0.08) s = 2.0;
      else if (roe >= 0)    s = 0.8;
      else                  s = 0.0;
    } else {
      if (roe >= 0.22)      { s = 5.0; signals.push(`ROE ${(roe * 100).toFixed(1)}% — excellent`); }
      else if (roe >= 0.16) s = 4.3;
      else if (roe >= 0.10) s = 3.5;
      else if (roe >= 0.05) s = 2.0;
      else if (roe >= 0)    s = 0.8;
      else                  { s = 0.0; signals.push("Negative ROE — destroying shareholder value"); }
    }
    subScores.push({ name: "roe", weight: 3, value: s });
  }

  if (profitMargin != null) {
    inputs.profitMargin = profitMargin;
    let s;
    // IT/Pharma margins: 20%+ normal. Manufacturing: 8% healthy, 15% excellent.
    if (sectorKind === "it") {
      if (profitMargin >= 0.22)      s = 5.0;
      else if (profitMargin >= 0.15) s = 4.0;
      else if (profitMargin >= 0.08) s = 3.0;
      else if (profitMargin >= 0)    s = 1.5;
      else                           s = 0.2;
    } else {
      if (profitMargin >= 0.18)      { s = 5.0; signals.push(`Net margin ${(profitMargin * 100).toFixed(1)}% — strong pricing power`); }
      else if (profitMargin >= 0.12) s = 4.0;
      else if (profitMargin >= 0.06) s = 3.0;
      else if (profitMargin >= 0.02) s = 1.8;
      else if (profitMargin >= 0)    s = 0.8;
      else                           { s = 0.0; signals.push("Negative margins — loss-making"); }
    }
    subScores.push({ name: "profitMargin", weight: 2, value: s });
  }

  if (revGrowth != null) {
    inputs.revenueGrowthYoY = revGrowth;
    let s;
    // Past pillar treats rev growth as "consistency" — less aggressive than
    // the Future pillar's growth reward, because it's the same number.
    if (revGrowth >= 0.20)      s = 5.0;
    else if (revGrowth >= 0.12) s = 4.0;
    else if (revGrowth >= 0.05) s = 3.0;
    else if (revGrowth >= 0)    s = 2.0;
    else                        s = 1.0;
    subScores.push({ name: "revenueHistory", weight: 1, value: s });
  }

  if (subScores.length === 0) {
    return { score: null, grade: "N/A", signals, inputs, coverage: 0 };
  }

  const totalW = subScores.reduce((a, s) => a + s.weight, 0);
  const score = subScores.reduce((a, s) => a + s.value * s.weight, 0) / totalW;
  const coverage = subScores.length / 3;
  return { score: clamp05(score), grade: gradeFrom05(score), signals, inputs, coverage };
}

/**
 * HEALTH pillar.
 *
 * Inputs (non-BFSI):
 *   - currentRatio, interestCoverage, D/E, OCF/NetIncome, grossMargins
 *
 * Inputs (BFSI):
 *   - D/E scored on bank-specific thresholds, OCF/NI, provision coverage
 *     (not currently available — comes with governance pillar)
 *
 * The OCF/NI ratio is the earnings-quality canary: values persistently <0.7
 * signal aggressive revenue recognition (Satyam, Zee, ICICI Securities).
 * We surface this as a warning signal even when the composite score is OK.
 */
function scoreHealth(snap, sectorKind) {
  const signals = [];
  const inputs = {};
  const subScores = [];

  const debtToEquity = Number.isFinite(snap?.debtToEquity) ? snap.debtToEquity : null;
  const currentRatio = Number.isFinite(snap?.currentRatio) ? snap.currentRatio : null;
  const interestCoverage = Number.isFinite(snap?.interestCoverage) ? snap.interestCoverage : null;
  const ocfToNetIncome = Number.isFinite(snap?.ocfToNetIncome) ? snap.ocfToNetIncome : null;
  const grossMargins = Number.isFinite(snap?.grossMargins) ? snap.grossMargins : null;

  const isBfsi = sectorKind === "bfsi";

  // D/E — tier-adaptive
  if (debtToEquity != null) {
    inputs.debtToEquity = debtToEquity;
    let s;
    if (isBfsi) {
      // Banks operate with very high leverage by regulation. Don't score.
      // We still capture the value for audit but skip the sub-score.
    } else if (sectorKind === "utility") {
      // Utilities carry more debt structurally. 1.5 is normal, 3+ flags.
      if (debtToEquity <= 0.5)      s = 5.0;
      else if (debtToEquity <= 1.0) s = 4.0;
      else if (debtToEquity <= 2.0) s = 3.0;
      else if (debtToEquity <= 3.5) s = 1.8;
      else                          { s = 0.5; signals.push(`D/E ${debtToEquity.toFixed(1)} — high even for utility`); }
      subScores.push({ name: "debtToEquity", weight: 2, value: s });
    } else {
      if (debtToEquity <= 0.1)      { s = 5.0; signals.push("Nearly debt-free"); }
      else if (debtToEquity <= 0.5) s = 4.2;
      else if (debtToEquity <= 1.0) s = 3.0;
      else if (debtToEquity <= 2.0) { s = 1.5; signals.push(`D/E ${debtToEquity.toFixed(1)} — moderately leveraged`); }
      else                          { s = 0.3; signals.push(`D/E ${debtToEquity.toFixed(1)} — highly leveraged`); }
      subScores.push({ name: "debtToEquity", weight: 2, value: s });
    }
  }

  // Current ratio — skip for BFSI
  if (!isBfsi && currentRatio != null) {
    inputs.currentRatio = currentRatio;
    let s;
    if (currentRatio >= 2.0)      s = 5.0;
    else if (currentRatio >= 1.5) s = 4.0;
    else if (currentRatio >= 1.2) s = 3.2;
    else if (currentRatio >= 1.0) s = 2.5;
    else if (currentRatio >= 0.8) { s = 1.3; signals.push(`Current ratio ${currentRatio.toFixed(2)} — short-term liquidity tight`); }
    else                          { s = 0.3; signals.push(`Current ratio ${currentRatio.toFixed(2)} — insolvency risk`); }
    subScores.push({ name: "currentRatio", weight: 1.5, value: s });
  }

  // Interest coverage — skip for BFSI
  if (!isBfsi && interestCoverage != null) {
    inputs.interestCoverage = interestCoverage;
    let s;
    if (interestCoverage >= 15)      s = 5.0;
    else if (interestCoverage >= 8)  s = 4.2;
    else if (interestCoverage >= 4)  s = 3.2;
    else if (interestCoverage >= 2)  s = 2.0;
    else if (interestCoverage >= 1)  { s = 0.8; signals.push(`Interest coverage ${interestCoverage.toFixed(1)}x — thin`); }
    else                             { s = 0.0; signals.push(`EBIT below interest expense — distress risk`); }
    subScores.push({ name: "interestCoverage", weight: 1.5, value: s });
  }

  // OCF / Net Income — earnings quality (applies to everyone)
  if (ocfToNetIncome != null) {
    inputs.ocfToNetIncome = ocfToNetIncome;
    let s;
    // Banks have a separate accrual pattern (loan-loss provisions are non-cash)
    // so the threshold shifts lower for BFSI.
    const threshold = isBfsi ? [0.5, 0.8, 1.1, 1.4] : [0.7, 1.0, 1.3, 1.6];
    if (ocfToNetIncome >= threshold[3])      s = 5.0;
    else if (ocfToNetIncome >= threshold[2]) s = 4.0;
    else if (ocfToNetIncome >= threshold[1]) s = 3.0;
    else if (ocfToNetIncome >= threshold[0]) { s = 1.8; signals.push(`OCF/NetIncome ${ocfToNetIncome.toFixed(2)} — earnings quality mid`); }
    else                                     { s = 0.5; signals.push(`OCF/NetIncome ${ocfToNetIncome.toFixed(2)} — earnings not converting to cash`); }
    subScores.push({ name: "ocfToNetIncome", weight: 1.5, value: s });
  }

  // Gross margins — pricing power; informative even as BFSI N/A (banks
  // don't report gross margin, so Yahoo returns 0 which we already filter)
  if (!isBfsi && grossMargins != null && grossMargins > 0) {
    inputs.grossMargins = grossMargins;
    let s;
    if (grossMargins >= 0.50)      s = 5.0;
    else if (grossMargins >= 0.35) s = 4.0;
    else if (grossMargins >= 0.20) s = 3.0;
    else if (grossMargins >= 0.10) s = 2.0;
    else                           s = 1.0;
    subScores.push({ name: "grossMargins", weight: 1, value: s });
  }

  if (subScores.length === 0) {
    return { score: null, grade: "N/A", signals, inputs, coverage: 0 };
  }

  const totalW = subScores.reduce((a, s) => a + s.weight, 0);
  const score = subScores.reduce((a, s) => a + s.value * s.weight, 0) / totalW;
  // Max inputs: non-BFSI=5, BFSI=2 (D/E skipped, no currentRatio, no interestCoverage, no grossMargins)
  const maxInputs = isBfsi ? 2 : 5;
  const coverage = Math.min(1, subScores.length / maxInputs);
  return { score: clamp05(score), grade: gradeFrom05(score), signals, inputs, coverage };
}

/**
 * DIVIDEND pillar.
 *
 * N/A for non-payers (yield = 0 or null), NOT scored as 0. This is the
 * key deviation from V1: a growth company with 0 yield shouldn't be
 * penalised; instead the Dividend pillar weight is redistributed across
 * the other pillars.
 *
 * Inputs:
 *   1. Yield — raw yield, but evaluated in context of sector norms
 *   2. Payout ratio — sustainability; 30-60% is healthy, >80% is fragile
 *   3. 5-year avg yield — compared to current, flags yield traps
 *
 * Yield trap detection: if current yield is >2x the 5-year average, the
 * stock is likely cheap for a reason (falling price, yield looks high).
 * This warning is surfaced in signals.
 */
function scoreDividend(snap) {
  const signals = [];
  const inputs = {};

  const dividendYield = Number.isFinite(snap?.dividendYield) ? snap.dividendYield : null;
  const payoutRatio = Number.isFinite(snap?.payoutRatio) ? snap.payoutRatio : null;
  // fiveYearAvgDivYield is in PERCENT (Yahoo schema quirk — documented in
  // FUNDAMENTALS_SCHEMA.md). Normalise to ratio for comparison.
  const fiveYearAvgDivYieldPct = Number.isFinite(snap?.fiveYearAvgDivYield)
    ? snap.fiveYearAvgDivYield
    : null;
  const fiveYearAvgDivYield = fiveYearAvgDivYieldPct != null
    ? fiveYearAvgDivYieldPct / 100
    : null;

  // Non-payer: N/A, not 0. Weight redistributes.
  if (dividendYield == null || dividendYield === 0) {
    return {
      score: null,
      grade: "N/A",
      signals: ["Non-dividend-payer — pillar excluded from composite"],
      inputs: { dividendYield },
      coverage: 0,
    };
  }

  const subScores = [];
  inputs.dividendYield = dividendYield;

  // Yield quality bands (ratio form: 0.03 = 3%)
  let yieldScore;
  if (dividendYield >= 0.05)       { yieldScore = 5.0; signals.push(`Yield ${(dividendYield * 100).toFixed(1)}% — high`); }
  else if (dividendYield >= 0.03)  yieldScore = 4.0;
  else if (dividendYield >= 0.015) yieldScore = 3.0;
  else if (dividendYield >= 0.005) yieldScore = 2.0;
  else                             yieldScore = 1.0;
  subScores.push({ name: "yield", weight: 2, value: yieldScore });

  // Payout sustainability — the healthiest range is 30-60%.
  // Below 30% is stingy but sustainable; above 80% is fragile (can't absorb
  // a bad year). Negative payout means losses, which we score bottom.
  if (payoutRatio != null) {
    inputs.payoutRatio = payoutRatio;
    let s;
    if (payoutRatio < 0)               { s = 0.0; signals.push("Negative payout — dividend from losses (unsustainable)"); }
    else if (payoutRatio <= 0.30)      s = 4.0;
    else if (payoutRatio <= 0.60)      s = 5.0;
    else if (payoutRatio <= 0.80)      s = 3.5;
    else if (payoutRatio <= 1.00)      { s = 2.0; signals.push(`Payout ${(payoutRatio * 100).toFixed(0)}% — stretched`); }
    else                               { s = 0.5; signals.push(`Payout ${(payoutRatio * 100).toFixed(0)}% above earnings — likely cut coming`); }
    subScores.push({ name: "payoutRatio", weight: 1.5, value: s });
  }

  // 5-year comparison — yield trap detection
  if (fiveYearAvgDivYield != null && fiveYearAvgDivYield > 0) {
    inputs.fiveYearAvgDivYield = fiveYearAvgDivYield;
    const lift = dividendYield / fiveYearAvgDivYield;
    inputs.yieldVs5yAvgRatio = lift;
    let s;
    if (lift >= 2.0)       { s = 1.0; signals.push(`Current yield ${(lift).toFixed(1)}× the 5-year average — potential yield trap`); }
    else if (lift >= 1.3)  { s = 3.0; }
    else if (lift >= 0.8)  s = 4.0;
    else                   { s = 3.0; signals.push("Current yield below historical average"); }
    subScores.push({ name: "yieldVsAvg", weight: 1, value: s });
  }

  if (subScores.length === 0) {
    return { score: null, grade: "N/A", signals, inputs, coverage: 0 };
  }

  const totalW = subScores.reduce((a, s) => a + s.weight, 0);
  const score = subScores.reduce((a, s) => a + s.value * s.weight, 0) / totalW;
  const coverage = subScores.length / 3;
  return { score: clamp05(score), grade: gradeFrom05(score), signals, inputs, coverage };
}

/**
 * GOVERNANCE pillar.
 *
 * Reads governance.js which is currently a stub returning null. When the
 * BSE XBRL fetcher lands (Phase 2.x), this will score:
 *   - Promoter pledge as % of promoter holding
 *   - Promoter pledge as % of total shares (the real risk metric)
 *   - QoQ change in promoter holding (falling is a red flag)
 *   - DII holding (sticky capital)
 *
 * Until then this pillar returns { score: null } and its weight redistributes.
 */
function scoreGovernance(snap) {
  const key = snap?.symbol;
  if (!key) return { score: null, grade: "N/A", signals: [], inputs: {}, coverage: 0 };

  const gov = getGovernance(key);
  if (!gov) {
    return {
      score: null,
      grade: "N/A",
      signals: [
        "Governance data unavailable for this symbol — shareholding snapshot not in the last refresh (weekly cron). Pillar weight redistributes.",
      ],
      inputs: {},
      coverage: 0,
    };
  }

  const signals = [];
  const inputs = {};
  const subScores = [];

  // Promoter holding (absolute level). Low promoter holding = diffuse
  // ownership = weaker incentive alignment between management and minority
  // shareholders. The ZEEL case (post-Essel debt cascade, promoter holding
  // collapsed to <4%) is the canonical cautionary tale here.
  //
  // This is scored even in the absence of XBRL pledge data — making it the
  // workhorse signal when governance.js only has the NSE master endpoint
  // fields populated (which is the common case today).
  if (gov.promoterHolding != null) {
    inputs.promoterHolding = gov.promoterHolding;
    let s;
    if (gov.promoterHolding >= 0.50)       s = 4.8;
    else if (gov.promoterHolding >= 0.35)  s = 4.0;
    else if (gov.promoterHolding >= 0.25)  s = 3.2;
    else if (gov.promoterHolding >= 0.15)  { s = 2.0; signals.push(`Promoter holding only ${(gov.promoterHolding * 100).toFixed(1)}% — diffuse ownership`); }
    else if (gov.promoterHolding >= 0.05)  { s = 1.0; signals.push(`Promoter holding ${(gov.promoterHolding * 100).toFixed(1)}% — weak alignment`); }
    else                                   { s = 0.2; signals.push(`Promoter holding ${(gov.promoterHolding * 100).toFixed(1)}% — severe governance risk`); }
    subScores.push({ name: "promoterHolding", weight: 2, value: s });
  }

  // Promoter pledge as % of TOTAL shares — the actual risk metric.
  // Values from real portfolios: IndiGo 0%, Zee 15%, Vodafone-Idea 80%+
  // Currently only populated when the XBRL detail parser runs (Phase 5.x);
  // the NSE master endpoint alone doesn't carry it.
  if (gov.pledgeOfTotal != null) {
    inputs.pledgeOfTotal = gov.pledgeOfTotal;
    let s;
    if (gov.pledgeOfTotal <= 0.005)      s = 5.0;
    else if (gov.pledgeOfTotal <= 0.02)  s = 4.0;
    else if (gov.pledgeOfTotal <= 0.05)  { s = 3.0; signals.push(`${(gov.pledgeOfTotal * 100).toFixed(1)}% of total shares pledged`); }
    else if (gov.pledgeOfTotal <= 0.15)  { s = 1.5; signals.push(`${(gov.pledgeOfTotal * 100).toFixed(1)}% pledge — elevated risk`); }
    else                                 { s = 0.2; signals.push(`${(gov.pledgeOfTotal * 100).toFixed(1)}% pledged — severe risk`); }
    subScores.push({ name: "pledgeOfTotal", weight: 3, value: s });
  }

  // QoQ change in promoter holding — falling promoter holding is the single
  // best leading indicator of future earnings disappointment (per SEBI cohort
  // studies 2018-2024).
  if (gov.promoterHoldingQoQDelta != null) {
    inputs.promoterHoldingQoQDelta = gov.promoterHoldingQoQDelta;
    let s;
    if (gov.promoterHoldingQoQDelta >= 0.01)       s = 5.0;
    else if (gov.promoterHoldingQoQDelta >= 0)     s = 4.0;
    else if (gov.promoterHoldingQoQDelta >= -0.01) s = 3.0;
    else if (gov.promoterHoldingQoQDelta >= -0.03) { s = 1.5; signals.push("Promoter trimming stake"); }
    else                                           { s = 0.3; signals.push("Significant promoter selling QoQ"); }
    subScores.push({ name: "promoterHoldingQoQDelta", weight: 2, value: s });
  }

  // DII as % of public holding — sticky institutional capital
  if (gov.diiHolding != null) {
    inputs.diiHolding = gov.diiHolding;
    let s;
    if (gov.diiHolding >= 0.20)      s = 5.0;
    else if (gov.diiHolding >= 0.10) s = 4.0;
    else if (gov.diiHolding >= 0.05) s = 3.0;
    else                             s = 2.0;
    subScores.push({ name: "diiHolding", weight: 1, value: s });
  }

  if (subScores.length === 0) {
    return {
      score: null,
      grade: "N/A",
      signals: ["Governance record exists but none of the scored fields are populated"],
      inputs,
      coverage: 0,
    };
  }

  const totalW = subScores.reduce((a, s) => a + s.weight, 0);
  const score = subScores.reduce((a, s) => a + s.value * s.weight, 0) / totalW;
  // Max 4 sub-scores: promoterHolding + pledgeOfTotal + promoterHoldingQoQDelta + diiHolding.
  // Today the NSE master endpoint populates 2 (promoterHolding + QoQ), so typical
  // coverage is ~0.5 until the XBRL parser lands for pledge/FII/DII.
  const coverage = subScores.length / 4;
  return { score: clamp05(score), grade: gradeFrom05(score), signals, inputs, coverage };
}

// ==================== COMPOSITE ====================

/**
 * Tier-adaptive pillar weights. Keys sum to 1.0 within each tier.
 *
 * Rationale:
 *   - BFSI: Health is partly N/A (currentRatio, interestCoverage don't apply),
 *     so when it's scored it carries less signal. Redistribute to Value/Past
 *     which are the robust signals for banks.
 *   - Others: balanced across pillars, slight tilt to Past (track record) and
 *     Health because these are the most reliable differentiators for SMID.
 *
 * Governance weight is modest (10%) — it's meant to DOCK stocks with red
 * flags, not award points. Most well-governed stocks should come out
 * neutral here; the tail punishes aggressively.
 */
const PILLAR_WEIGHTS = {
  bfsi: {
    value:      0.25,
    future:     0.20,
    past:       0.25,
    health:     0.10,
    dividend:   0.10,
    governance: 0.10,
  },
  it: {
    value:      0.25,
    future:     0.20,
    past:       0.20,
    health:     0.15,
    dividend:   0.10,
    governance: 0.10,
  },
  utility: {
    value:      0.25,
    future:     0.15,
    past:       0.20,
    health:     0.20,
    dividend:   0.10,
    governance: 0.10,
  },
  other: {
    value:      0.25,
    future:     0.20,
    past:       0.20,
    health:     0.15,
    dividend:   0.10,
    governance: 0.10,
  },
};

/**
 * Compose six pillar results into a 0-100 composite.
 *
 * Handling of N/A pillars: drop the pillar's weight and renormalise the
 * remaining weights. If Dividend is N/A (non-payer), its 10% is spread
 * across the other five. If Governance is also N/A (no data yet), another
 * 10% redistributes. This mirrors how Simply Wall St handles missing data
 * rather than docking the composite for signal absence.
 *
 * We also return the raw pillar scores and the weights actually applied,
 * so the UI can visualise the Snowflake hexagon with accurate fills.
 */
function composite(pillars, sectorKind) {
  const weights = PILLAR_WEIGHTS[sectorKind] || PILLAR_WEIGHTS.other;
  const active = [];
  let totalActiveWeight = 0;

  for (const [name, pillar] of Object.entries(pillars)) {
    if (pillar.score != null) {
      active.push({ name, score: pillar.score, weight: weights[name] });
      totalActiveWeight += weights[name];
    }
  }

  if (active.length === 0 || totalActiveWeight === 0) {
    return { compositeRaw: 0, composite100: 0, appliedWeights: {}, naPillars: Object.keys(pillars) };
  }

  // Renormalise over active pillars. Resulting compositeRaw is 0-5.
  const compositeRaw = active.reduce(
    (a, p) => a + p.score * (p.weight / totalActiveWeight),
    0
  );

  // Map 0-5 to 0-100
  const composite100 = Math.round(compositeRaw * 20);

  const appliedWeights = {};
  for (const p of active) {
    appliedWeights[p.name] = +(p.weight / totalActiveWeight).toFixed(3);
  }

  const naPillars = Object.entries(pillars)
    .filter(([, p]) => p.score == null)
    .map(([name]) => name);

  return { compositeRaw, composite100, appliedWeights, naPillars };
}

/**
 * Verdict mapping for V2.
 *
 * Note: V2 uses tighter bands than V1 because the 6-pillar composite
 * uses more information — we can afford to be stricter about what
 * qualifies as "quality growth". The exact bands will be tuned in
 * Phase 3 via backtest; these are defensible starting values.
 */
function verdictFromScore(score) {
  if (score >= 75) return "DEEP_VALUE";
  if (score >= 65) return "QUALITY_GROWTH";
  if (score >= 50) return "FAIR_VALUE";
  if (score >= 38) return "FULLY_VALUED";
  return "OVERVALUED";
}

/**
 * Main entry — score a snapshot and return the full 6-pillar result.
 *
 * Shape matches the V1 contract (score/verdict/reasoning/warnings/
 * scoredAt/scorerVersion/snapshot) so downstream code can handle both
 * scorers uniformly. Additionally exposes `pillars` and `composition`
 * for the Snowflake UI.
 */
export function scoreFundamentalsV2(snap) {
  if (!snap) return null;

  const sectorKind = classifySector(snap);

  const pillars = {
    value:      scoreValue(snap, sectorKind),
    future:     scoreFuture(snap),
    past:       scorePast(snap, sectorKind),
    health:     scoreHealth(snap, sectorKind),
    dividend:   scoreDividend(snap),
    governance: scoreGovernance(snap),
  };

  const comp = composite(pillars, sectorKind);
  const verdict = verdictFromScore(comp.composite100);

  // Collect all signals across pillars for the UI reasoning block
  const allSignals = [];
  const warnings = [];
  for (const [name, pillar] of Object.entries(pillars)) {
    for (const sig of pillar.signals || []) {
      allSignals.push(`[${name}] ${sig}`);
      // Heuristic: signals containing "trap", "distress", "risk", "negative",
      // "unsustainable", "stretched", "severe" are warnings not positives
      if (/trap|distress|risk|destroying|unsustainable|severe|cut coming|insolvency/i.test(sig)) {
        warnings.push(sig);
      }
    }
  }
  if (comp.naPillars.length > 0) {
    warnings.push(`Pillars N/A (weight redistributed): ${comp.naPillars.join(", ")}`);
  }

  return {
    score: comp.composite100,
    verdict,
    scorerVersion: SCORER_VERSION_V2,
    scoredAt: new Date().toISOString(),
    sectorKind,
    pillars: {
      value:      { score: pillars.value.score,      grade: pillars.value.grade,      signals: pillars.value.signals,      inputs: pillars.value.inputs,      coverage: pillars.value.coverage },
      future:     { score: pillars.future.score,     grade: pillars.future.grade,     signals: pillars.future.signals,     inputs: pillars.future.inputs,     coverage: pillars.future.coverage },
      past:       { score: pillars.past.score,       grade: pillars.past.grade,       signals: pillars.past.signals,       inputs: pillars.past.inputs,       coverage: pillars.past.coverage },
      health:     { score: pillars.health.score,     grade: pillars.health.grade,     signals: pillars.health.signals,     inputs: pillars.health.inputs,     coverage: pillars.health.coverage },
      dividend:   { score: pillars.dividend.score,   grade: pillars.dividend.grade,   signals: pillars.dividend.signals,   inputs: pillars.dividend.inputs,   coverage: pillars.dividend.coverage },
      governance: { score: pillars.governance.score, grade: pillars.governance.grade, signals: pillars.governance.signals, inputs: pillars.governance.inputs, coverage: pillars.governance.coverage },
    },
    composition: {
      rawComposite: +comp.compositeRaw.toFixed(3),
      composite100: comp.composite100,
      appliedWeights: comp.appliedWeights,
      naPillars: comp.naPillars,
    },
    reasoning: allSignals.join(". "),
    warnings,
    snapshot: {
      symbol: snap.symbol,
      name: snap.name,
      sector: snap.sector,
      sectorKind,
      price: snap.price,
      pe: snap.pe,
      marketCap: snap.marketCap,
    },
  };
}

/**
 * Weighted-radar-ready export for the Snowflake UI. Shape is intentionally
 * flat and stable so the front-end can destructure { value, future, past,
 * health, dividend, governance } into a radar component.
 */
export function pillarScoresForRadar(v2Result) {
  if (!v2Result?.pillars) return null;
  const p = v2Result.pillars;
  return {
    value:      p.value.score ?? null,
    future:     p.future.score ?? null,
    past:       p.past.score ?? null,
    health:     p.health.score ?? null,
    dividend:   p.dividend.score ?? null,
    governance: p.governance.score ?? null,
  };
}
