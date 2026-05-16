/**
 * Portfolio Intelligence Engine
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure functions (no I/O, no side effects) that turn a portfolio + live
 * analyses into personalised decisions:
 *
 *   1. Per-holding action recommendation (7 possible actions)
 *   2. Portfolio health score (0-100)
 *   3. Urgent actions queue (prioritised list of non-HOLD items)
 *
 * The key insight vs. a pure "is this stock good?" signal is that your
 * COST BASIS and POSITION SIZE change the right answer. A WEAK_BUY signal
 * is a HOLD for someone at break-even, an AVERAGE_DOWN for someone down 20%,
 * and a TRIM for someone over-concentrated. This module bakes all of that in.
 *
 * This module is deliberately LLM-free so it can run on every portfolio load
 * without adding latency or cost. News sentiment is deliberately excluded
 * from the action logic — for structural "should I sell" questions, the
 * technical + fundamental view is enough, and news changes too fast to be
 * a stable basis for position decisions. The user can click any holding to
 * see the full LLM-backed news analysis.
 *
 * MACRO AWARENESS: As of the macro regime layer, every function in this
 * module accepts an OPTIONAL `macroInfo` object (or omits it entirely for
 * LLM-free tests). When present, macroInfo = { delta, impact, reason } comes
 * from macroRegime.computeMacroDelta() applied to the holding's sector. The
 * module never touches the classifier itself — the server fetches the regime
 * once per portfolio load and feeds the per-stock delta in here. Macro effects
 * are DELIBERATELY HALF-WEIGHT compared to the scanners (portfolio decisions
 * should be less twitchy than fresh picks) and NEVER weaken a CUT_LOSS
 * (a broken thesis stays broken even with macro tailwind).
 */

// ──────────────────── Constants: thresholds ────────────────────

// Position size thresholds (as % of total invested value)
const POSITION_OVERWEIGHT_HIGH = 15; // > 15% → TRIM
const POSITION_OVERWEIGHT_LOW = 10;  // 10-15% → warning only
const POSITION_ADD_CEILING = 10;     // don't suggest adding if already >10%

// P&L thresholds (as %)
//
// CUT_LOSS tiers — when P&L gets deep enough the market is telling you the
// thesis is broken regardless of current technical signals. A 53/100 tech
// score on a stock already down 50% doesn't mean "neutral" — it means
// "oversold bounce in a broken name". Audit caught this: INOXWIND at −53%
// was landing in HOLD because its tech score was 53.
const LOSS_UNCONDITIONAL_CUT = -40;  // down >40% → CUT_LOSS no matter what
const LOSS_DEEP_CUT = -30;           // down >30% + combined < 65 → CUT_LOSS
const LOSS_CUT_THRESHOLD = -25;      // down >25% + combined < 55 OR expensive → CUT_LOSS
const LOSS_REVIEW_THRESHOLD = -15;   // down >15% → show the warning icon in HOLD view

const LOSS_ADD_TRIGGER = -5;         // down >5% is the floor for "average down" suggestions
const LOSS_STRONG_ADD_TRIGGER = -10; // down >10% qualifies for STRONG_ADD
const PROFIT_BOOK_THRESHOLD = 50;    // up >50% triggers BOOK_PROFIT consideration
const PROFIT_STRONG_BOOK = 70;       // up >70% qualifies for BOOK_PROFIT even with decent signals

// Combined score thresholds (0-100)
const SCORE_BEARISH_HARD = 30;       // ≤30 = unconditional sell
const SCORE_BEARISH = 40;            // ≤40 = bearish, contributes to SELL/CUT_LOSS
const SCORE_NEUTRAL_HIGH = 55;       // <55 on a big loser = no recovery signal
const SCORE_MODERATELY_POSITIVE = 65;// <65 on a 30%+ loser = not strong enough to hold
const SCORE_BULLISH = 60;            // ≥60 = bullish, enables ADD
const SCORE_BULLISH_HARD = 70;       // ≥70 = strongly bullish, enables STRONG_ADD

// ──────────────────── Combined score ────────────────────

/**
 * Portfolio intelligence uses a technical + fundamental weighted score.
 * News sentiment is deliberately excluded — it's too noisy for position
 * decisions and we want this to run fast on every portfolio load.
 *
 * When fundamentals are available: 60% tech + 40% fundamentals
 * When fundamentals are missing:   100% tech
 *
 * If `macroDelta` is supplied (from the shared regime), it's applied at
 * HALF WEIGHT so portfolio scores move less than scanner scores. Clamped to
 * 0-100.
 */
export function computePortfolioCombinedScore(technicalScore, fundamentalScore, macroDelta = 0) {
  if (technicalScore == null) return null;
  const base = fundamentalScore == null
    ? technicalScore
    : technicalScore * 0.6 + fundamentalScore * 0.4;
  const blended = base + (Number.isFinite(macroDelta) ? macroDelta * 0.5 : 0);
  return Math.max(0, Math.min(100, Math.round(blended)));
}

// ──────────────────── Per-holding action logic ────────────────────

/**
 * Compute the recommended action for a single holding.
 *
 * @param {object} holding - { symbol, name, pnlPercent, investedValue, currentValue, sector }
 * @param {object} scores - { combinedScore, technicalScore, fundamentalScore, fundamentalVerdict }
 * @param {object} context - { positionWeight, sectorWeight, hasLiveData, macroInfo? }
 *   macroInfo (optional) = { delta, impact, reason, regimeId, regimeLabel, severity }
 *     impact:  -3..+3 (canonical sector impact from the regime)
 *     delta:   the raw delta from computeMacroDelta (already scaled by severity × confidence)
 *     severity: 1..5
 *   Macro adjustments kick in only when severity >= 3 AND |impact| >= 2, so
 *   low-confidence / calm regimes never change the underlying action.
 * @returns {{ action, urgency, reasoning, factors, displayAction, color, macroWarning?, macroTailwind? }}
 */
export function computeAction(holding, scores, context) {
  const factors = [];

  // Data-missing case: no scorecard possible without prices/scores.
  // Language note across this function:
  //   - displayAction strings are labels, NOT commands ("Review — …", not "Sell")
  //   - reasoning text is observational/evidentiary, NOT prescriptive
  //   - we report what the scorecard + price data shows; the investor decides
  // This keeps the module's output firmly in the "educational research" lane
  // that IA Regulations 2013 permits for non-registered entities.
  if (!context.hasLiveData) {
    return {
      action: "NO_DATA",
      urgency: "none",
      reasoning: "Live price data unavailable for this stock — scorecard cannot be computed.",
      factors: ["no_live_data"],
      displayAction: "No data",
      color: "gray",
    };
  }

  const pnlPct = holding.pnlPercent ?? 0;
  const weight = context.positionWeight ?? 0;
  const score = scores.combinedScore ?? null;
  const tech = scores.technicalScore ?? null;
  const fund = scores.fundamentalScore ?? null;
  const verdict = scores.fundamentalVerdict ?? null;

  // ── Priority 0: hard governance gate ──
  //
  // Promoter-pledge spike OR pledge ≥ 25% trumps P&L-only logic. Without
  // this, computeAction returns HOLD/TOP_UP on a stock with 60% promoter
  // pledge whenever the technicals look fine — exactly the structural
  // blind spot that caught Vedanta (2021), Zee (2022), and Yes Bank
  // (2020) holders. The −4/−8 soft-score penalty in swsIndianRiskLayer
  // cannot override a 70-score pick on its own.
  //
  // Source: services/swsIndianRiskLayer.js::deriveGovernanceGate, plumbed
  // into context.governanceGate by the caller (portfolioAnalyzer.js and
  // buildPortfolioIntelligence). The gate is null whenever governance
  // data is missing or thresholds aren't breached, so this path is
  // strictly additive — no existing call site changes behaviour without
  // a populated gate.
  const govGate = context.governanceGate;
  if (govGate?.severity === "REVIEW") {
    return {
      action: "REVIEW_GOVERNANCE",
      urgency: "high",
      reasoning: `${govGate.reason}. ` +
                 `Historical precedent on Indian equities: this pattern ` +
                 `(${govGate.pattern}) has preceded cascading forced-sale ` +
                 `events. Worth a hard look at the thesis irrespective of ` +
                 `current technicals / P&L — pledged promoter equity is a ` +
                 `leverage vector that doesn't show up on the chart.`,
      factors: ["governance_gate"],
      displayAction: "Review — governance red flag",
      color: "dark-red",
      governanceGate: govGate,
    };
  }

  // Collect factor tags for transparency / debugging
  if (pnlPct <= LOSS_CUT_THRESHOLD) factors.push("loss_25_plus");
  else if (pnlPct <= -10) factors.push("loss_10_plus");
  if (pnlPct >= PROFIT_STRONG_BOOK) factors.push("profit_70_plus");
  else if (pnlPct >= PROFIT_BOOK_THRESHOLD) factors.push("profit_50_plus");
  if (score != null && score <= SCORE_BEARISH) factors.push("combined_score_low");
  if (score != null && score >= SCORE_BULLISH_HARD) factors.push("combined_score_high");
  if (verdict === "OVERVALUED" || verdict === "FULLY_VALUED") factors.push("verdict_expensive");
  if (verdict === "DEEP_VALUE") factors.push("verdict_deep_value");
  if (verdict === "QUALITY_GROWTH") factors.push("verdict_quality");
  if (weight >= POSITION_OVERWEIGHT_HIGH) factors.push("weight_over_15pct");
  else if (weight >= POSITION_OVERWEIGHT_LOW) factors.push("weight_10_to_15");

  // ── Priority 1: CUT_LOSS ──
  //
  // Three tiers, in descending severity:
  //
  //   TIER 1 — pnl <= -40%: unconditional. If you're down 40%, the thesis is
  //   broken. A current technical score does not matter; oversold bounces in
  //   crashed names don't get you back to break-even. Cut the position.
  //
  //   TIER 2 — pnl <= -30%: CUT_LOSS unless the signals are strongly bullish
  //   (combined >= 65). A 30% loss is recoverable only if there's a compelling
  //   "why it's going up from here" signal.
  //
  //   TIER 3 — pnl <= -25%: CUT_LOSS if signals are flat-to-weak (combined
  //   < 55) or fundamentals are expensive. Moderate loss + no positive
  //   signals = dead money.
  if (pnlPct <= LOSS_UNCONDITIONAL_CUT) {
    return {
      action: "CUT_LOSS",
      urgency: "high",
      reasoning: `Drawdown of ${Math.abs(pnlPct).toFixed(1)}%. Historical data on Indian equities shows ` +
                 `recoveries from 40%+ drawdowns are uncommon without a fresh fundamental catalyst. ` +
                 `Worth reviewing the original thesis and whether the catalyst that drove the entry still holds.`,
      factors: [...factors, "loss_40_plus"],
      displayAction: "Review — deep drawdown",
      color: "dark-red",
    };
  }

  if (pnlPct <= LOSS_DEEP_CUT && score != null && score < SCORE_MODERATELY_POSITIVE) {
    return {
      action: "CUT_LOSS",
      urgency: "high",
      reasoning: `Drawdown ${Math.abs(pnlPct).toFixed(1)}% with scorecard at ${score}/100 — recovery signals are weak. ` +
                 `${verdict === "OVERVALUED" || verdict === "FULLY_VALUED"
                    ? `Fundamentals also flagged ${verdict.replace("_", " ")} — no valuation support. `
                    : ""}` +
                 `Historical recovery rates from this drawdown depth without bullish signals are low.`,
      factors: [...factors, "loss_30_plus"],
      displayAction: "Review — deep drawdown",
      color: "dark-red",
    };
  }

  if (pnlPct <= LOSS_CUT_THRESHOLD && score != null &&
      (score < SCORE_NEUTRAL_HIGH || verdict === "OVERVALUED" || verdict === "FULLY_VALUED")) {
    return {
      action: "CUT_LOSS",
      urgency: "high",
      reasoning: `Drawdown ${Math.abs(pnlPct).toFixed(1)}% with scorecard at ${score}/100 — no clear recovery catalyst in the data. ` +
                 `${verdict === "OVERVALUED" || verdict === "FULLY_VALUED"
                    ? `Fundamentals rated ${verdict.replace("_", " ")}. `
                    : ""}` +
                 `Worth a fresh look at the thesis.`,
      factors,
      displayAction: "Review — drawdown",
      color: "dark-red",
    };
  }

  // ── Priority 2: bearish scorecard signal ──
  // Strong bearish score OR overvalued with weak signals, regardless of P&L.
  if (score != null && (score <= SCORE_BEARISH_HARD ||
      (score <= SCORE_BEARISH && verdict === "OVERVALUED"))) {
    return {
      action: "SELL",
      urgency: "high",
      reasoning: `Scorecard at ${score}/100 — multiple bearish technical/fundamental signals converging. ` +
                 `${verdict === "OVERVALUED" ? `Stock is flagged OVERVALUED on the valuation screen. ` : ""}` +
                 `Worth reviewing whether the entry thesis still holds.`,
      factors,
      displayAction: "Review — bearish signals",
      color: "red",
    };
  }

  // ── Priority 3: gains with cooling momentum ──
  if (pnlPct >= PROFIT_STRONG_BOOK && score != null && score < SCORE_BULLISH_HARD) {
    return {
      action: "BOOK_PROFIT",
      urgency: "medium",
      reasoning: `Gain of ${pnlPct.toFixed(1)}% with scorecard cooling to ${score}/100. ` +
                 `Historical patterns on Indian midcaps show positions up 70%+ with declining momentum ` +
                 `often give back half the gain within 6 months. Partial profit locking has historically ` +
                 `preserved realised returns better than riding the full position.`,
      factors,
      displayAction: "Profit watch",
      color: "orange",
    };
  }
  if (pnlPct >= PROFIT_BOOK_THRESHOLD && score != null && score < 55) {
    return {
      action: "BOOK_PROFIT",
      urgency: "medium",
      reasoning: `Gain of ${pnlPct.toFixed(1)}% with scorecard softening to ${score}/100 — momentum fading.`,
      factors,
      displayAction: "Profit watch",
      color: "orange",
    };
  }

  // ── Priority 4: concentration risk ──
  if (weight >= POSITION_OVERWEIGHT_HIGH) {
    return {
      action: "TRIM",
      urgency: "medium",
      reasoning: `Position is ${weight.toFixed(1)}% of invested capital — above the 15% single-stock ` +
                 `threshold where historical drawdowns on Indian equities produce disproportionate ` +
                 `portfolio-level losses. ` +
                 `${pnlPct > 0 ? `Gain of ${pnlPct.toFixed(1)}% available to reduce exposure without realising a loss. ` : ""}` +
                 `Position sizing is a personal decision; this is flagged for review only.`,
      factors,
      displayAction: "Concentration watch",
      color: "yellow",
    };
  }

  // ── Priority 5: deep-value accumulation signal ──
  if (pnlPct <= LOSS_STRONG_ADD_TRIGGER && score != null && score >= SCORE_BULLISH_HARD &&
      verdict === "DEEP_VALUE" && weight < POSITION_ADD_CEILING) {
    return {
      action: "STRONG_ADD",
      urgency: "medium",
      reasoning: `Drawdown ${Math.abs(pnlPct).toFixed(1)}% with scorecard at ${score}/100 and fundamentals ` +
                 `flagged DEEP_VALUE. Historical accumulation setups with this combination have produced ` +
                 `positive returns in 1-year lookbacks; not financial advice — for review.`,
      factors,
      displayAction: "Accumulation signal (strong)",
      color: "dark-green",
    };
  }

  // ── Priority 6: mild accumulation signal ──
  if (pnlPct <= LOSS_ADD_TRIGGER && score != null && score >= SCORE_BULLISH &&
      (verdict === "DEEP_VALUE" || verdict === "QUALITY_GROWTH") &&
      weight < POSITION_ADD_CEILING) {
    return {
      action: "ADD",
      urgency: "low",
      reasoning: `Drawdown ${Math.abs(pnlPct).toFixed(1)}% with fundamentals ${verdict.replace("_", " ")} ` +
                 `and technicals at ${score}/100. Scorecard supports accumulation; sizing is personal.`,
      factors,
      displayAction: "Accumulation signal",
      color: "green",
    };
  }

  // ── Default: neutral scorecard ──
  let holdReason;
  if (score == null) {
    holdReason = "Scorecard data limited. Monitor for changes.";
  } else if (score >= SCORE_BULLISH) {
    holdReason = `Scorecard ${score}/100 — positive. Position size within normal band. No scorecard action triggered.`;
  } else if (score >= 45) {
    holdReason = `Scorecard ${score}/100 — neutral. No directional signal currently.`;
  } else {
    holdReason = `Scorecard ${score}/100 — soft but not triggering a review. Monitor for deterioration.`;
  }

  return {
    action: "HOLD",
    urgency: "low",
    reasoning: holdReason,
    factors: factors.length > 0 ? factors : ["no_triggers"],
    displayAction: "Scorecard: neutral",
    color: "blue",
  };
}

// ──────────────────── Macro adjustment layer ────────────────────

/**
 * Apply macro regime adjustments to a computed action. Runs AFTER computeAction
 * to keep the core logic macro-free (and testable without a regime).
 *
 * Rules:
 *   • Severity 1-2: macro is informational only, no action changes.
 *   • Negative macro (impact ≤ -2, severity ≥ 3):
 *     - HOLD with weight > 8% → TRIM (concentration risk under headwind)
 *     - TRIM → strengthen messaging
 *     - CUT_LOSS / SELL / BOOK_PROFIT → never weaken (thesis already broken)
 *     - ADD / STRONG_ADD → downgrade one step (don't average down into a headwind)
 *     - Adds macroWarning text visible in the holding card
 *   • Positive macro (impact ≥ +2, severity ≥ 3):
 *     - HOLD with bullish tech (score ≥ 55) → ADD
 *     - ADD → STRONG_ADD
 *     - CUT_LOSS / SELL → never weaken (macro tailwind doesn't save a broken thesis)
 *     - Adds macroTailwind text
 */
export function applyMacroToAction(action, holding, scores, context) {
  const macro = context.macroInfo;
  if (!macro || !Number.isFinite(macro.impact) || !Number.isFinite(macro.severity)) {
    return action;
  }
  if (macro.severity < 3 || Math.abs(macro.impact) < 2) {
    return action; // informational only
  }

  const weight = context.positionWeight ?? 0;
  const score = scores.combinedScore ?? null;
  const tech = scores.technicalScore ?? null;
  const regimeLabel = macro.regimeLabel || macro.regimeId || "macro regime";
  const reasonText = macro.reason || `${regimeLabel} affects this sector`;

  // Defensive copies so we never mutate the caller's action object
  const next = { ...action, factors: [...(action.factors || [])] };

  // Governance-gate verdicts are independent of macro entirely — promoter
  // pledge cascades aren't softened by sector tailwind nor strengthened by
  // sector headwind. Annotate macro context but never mutate the action.
  if (action.action === "REVIEW_GOVERNANCE") {
    if (macro.impact <= -2) next.macroWarning = `⚠ ${reasonText}`;
    if (macro.impact >= 2) next.macroTailwind = `🌱 ${reasonText}`;
    return next;
  }

  // ─── Negative macro ───
  if (macro.impact <= -2) {
    next.macroWarning = `⚠ ${reasonText}`;
    next.factors.push(`macro_headwind_${macro.impact}`);

    // Never weaken a bearish scorecard
    if (["CUT_LOSS", "SELL", "BOOK_PROFIT"].includes(action.action)) {
      next.reasoning += ` Macro: ${reasonText} — headwind reinforces the review signal.`;
      return next;
    }
    // Downgrade accumulation signals under macro headwind
    if (action.action === "STRONG_ADD") {
      return {
        ...next,
        action: "ADD",
        displayAction: "Accumulation signal (cautious)",
        urgency: "low",
        reasoning: `Technicals + fundamentals still support accumulation, but ${reasonText}. Signal softened.`,
        color: "green",
      };
    }
    if (action.action === "ADD") {
      return {
        ...next,
        action: "HOLD",
        displayAction: "Scorecard: neutral (macro headwind)",
        urgency: "low",
        reasoning: `Accumulation signal was active but ${reasonText}. Historical data suggests waiting for regime shift before averaging down.`,
        color: "blue",
      };
    }
    // Promote HOLD → concentration review if macro headwind + overweight
    if (action.action === "HOLD" && weight > 8) {
      return {
        ...next,
        action: "TRIM",
        displayAction: "Concentration watch (macro)",
        urgency: "medium",
        reasoning: `Position is ${weight.toFixed(1)}% of portfolio with ${reasonText}. Historical sector headwinds of this magnitude have amplified drawdowns on overweight positions.`,
        color: "yellow",
      };
    }
    // Strengthen existing concentration flag
    if (action.action === "TRIM") {
      next.reasoning += ` Macro: ${reasonText} — sector headwind active.`;
      next.urgency = "medium";
      return next;
    }
    // Default: annotate only
    next.reasoning += ` Macro: ${reasonText}.`;
    return next;
  }

  // ─── Positive macro ───
  if (macro.impact >= 2) {
    next.macroTailwind = `🌱 ${reasonText}`;
    next.factors.push(`macro_tailwind_+${macro.impact}`);

    // Never weaken a bearish scorecard
    if (["CUT_LOSS", "SELL", "BOOK_PROFIT"].includes(action.action)) {
      next.reasoning += ` Macro: ${reasonText} — but scorecard-level review signal remains.`;
      return next;
    }
    // Neutral + bullish tech → accumulation signal under tailwind
    if (action.action === "HOLD" && score != null && score >= 55 && weight < POSITION_ADD_CEILING) {
      return {
        ...next,
        action: "ADD",
        displayAction: "Accumulation signal (tailwind)",
        urgency: "low",
        reasoning: `Scorecard ${score}/100 with ${reasonText}. Sector tailwind active.`,
        color: "green",
      };
    }
    // Soft accumulation → strong accumulation under tailwind
    if (action.action === "ADD" && weight < POSITION_ADD_CEILING) {
      return {
        ...next,
        action: "STRONG_ADD",
        displayAction: "Accumulation signal (strong)",
        urgency: "medium",
        reasoning: `Already favoured averaging down and now ${reasonText}. High-conviction add opportunity.`,
        color: "dark-green",
      };
    }
    // Concentration flag under tailwind → soften to neutral if just marginally overweight
    if (action.action === "TRIM" && weight < 18) {
      return {
        ...next,
        action: "HOLD",
        displayAction: "Scorecard: neutral (tailwind active)",
        urgency: "low",
        reasoning: `Concentration flag at ${weight.toFixed(1)}% softened by ${reasonText}. Historical sector tailwinds have supported overweight positions in the short term.`,
        color: "blue",
      };
    }
    next.reasoning += ` Macro: ${reasonText}.`;
    return next;
  }

  return action;
}

// ──────────────────── Portfolio health score ────────────────────

/**
 * Compute the overall portfolio health score (0-100) with a breakdown.
 *
 * Components:
 *  • Quality         — avg combined score, weighted by position size (0 to +40)
 *  • Diversification — bonus for spreading across sectors (0 to +20)
 *  • Concentration   — penalty for any single stock > 15% (up to -15)
 *  • Loss ratio      — penalty if many holdings are in the red (up to -10)
 *  • Valuation       — penalty per OVERVALUED / FULLY_VALUED holding (up to -15)
 *  • Profit ratio    — small bonus if most holdings are in profit (up to +5)
 *  • Macro exposure  — weight-averaged macro delta across holdings (-10 to +10)
 *                       reflects whether the portfolio's sector mix aligns with
 *                       or fights the current macro regime
 *
 * Starting from a 40 base so even a mixed portfolio lands in the 40-80 range,
 * not always 0 or 100.
 */
export function computeHealthScore(holdingIntel) {
  // holdingIntel = array of { holding, scores, action, weight }
  const valid = holdingIntel.filter((h) => h.scores?.combinedScore != null);
  if (valid.length === 0) {
    return {
      score: 50,
      verdict: "INSUFFICIENT_DATA",
      breakdown: { quality: 0, diversification: 0, concentration: 0, lossRatio: 0, valuation: 0, profitRatio: 0 },
      note: "Not enough live data to compute health score.",
    };
  }

  // ─── Quality (weight-adjusted average combined score) ───
  // Score each holding 0-40 based on how good its signals are, weighted by
  // its size in the portfolio. A big bad holding hurts more than a small one.
  let totalWeight = 0;
  let weightedQuality = 0;
  for (const h of valid) {
    const w = h.weight || 0;
    totalWeight += w;
    weightedQuality += ((h.scores.combinedScore / 100) * 40) * w;
  }
  const quality = totalWeight > 0 ? weightedQuality / totalWeight : 20;

  // ─── Diversification (Herfindahl-Hirschman Index across sectors) ───
  // HHI = sum of squared sector weights (as fractions). Lower HHI = more
  // diversified. Max diversification (evenly split across 10 sectors) gives
  // HHI = 0.1, all-in-one-sector gives HHI = 1.
  const sectorTotals = {};
  for (const h of holdingIntel) {
    const sector = h.holding.sector || "Unknown";
    sectorTotals[sector] = (sectorTotals[sector] || 0) + (h.weight || 0);
  }
  // Convert to fractions of total invested
  const totalInvested = Object.values(sectorTotals).reduce((a, b) => a + b, 0);
  const hhi = totalInvested > 0
    ? Object.values(sectorTotals).reduce((sum, w) => sum + Math.pow(w / totalInvested, 2), 0)
    : 1;
  // Scale HHI to diversification points: hhi 0.1 → 20, hhi 1.0 → 0
  const diversification = Math.max(0, Math.min(20, Math.round((1 - hhi) * 22)));

  // ─── Concentration penalty ───
  // Single-stock concentration risk. -5 per holding >15%, -10 if any >25%.
  let concentrationPenalty = 0;
  for (const h of holdingIntel) {
    const w = h.weight || 0;
    if (w >= 25) concentrationPenalty -= 10;
    else if (w >= 15) concentrationPenalty -= 5;
  }
  concentrationPenalty = Math.max(-20, concentrationPenalty);

  // ─── Loss ratio penalty ───
  // If most of your portfolio is in the red, something is wrong.
  const inLoss = valid.filter((h) => (h.holding.pnlPercent ?? 0) < 0).length;
  const lossRatio = inLoss / valid.length;
  let lossRatioPenalty = 0;
  if (lossRatio > 0.75) lossRatioPenalty = -12;
  else if (lossRatio > 0.6) lossRatioPenalty = -8;
  else if (lossRatio > 0.5) lossRatioPenalty = -4;

  // ─── Valuation penalty ───
  // Holding OVERVALUED stocks is a re-rating risk.
  const overvaluedCount = valid.filter((h) =>
    h.scores?.fundamentalVerdict === "OVERVALUED").length;
  const fullyValuedCount = valid.filter((h) =>
    h.scores?.fundamentalVerdict === "FULLY_VALUED").length;
  const valuationPenalty = Math.max(-15, -(overvaluedCount * 3 + fullyValuedCount * 1));

  // ─── Profit ratio bonus ───
  // If most of your holdings are in profit, that's meaningful.
  const inProfit = valid.filter((h) => (h.holding.pnlPercent ?? 0) > 0).length;
  const profitRatio = inProfit / valid.length;
  let profitBonus = 0;
  if (profitRatio >= 0.7) profitBonus = 5;
  else if (profitRatio >= 0.55) profitBonus = 3;

  // ─── Macro exposure ───
  // Weight-averaged macro delta across holdings (holdings with no macroInfo
  // contribute 0). Range is roughly ±15 per holding; we scale the overall
  // weighted average to ±10 for the health score. A portfolio stacked in
  // tailwind sectors gets a bonus; one stacked against the regime gets penalty.
  let macroExposure = 0;
  let macroActiveCount = 0;
  if (holdingIntel.some((h) => h.macroInfo)) {
    let weightedMacro = 0;
    let macroWeight = 0;
    for (const h of holdingIntel) {
      if (!h.macroInfo || !Number.isFinite(h.macroInfo.delta)) continue;
      const w = h.weight || 0;
      weightedMacro += h.macroInfo.delta * w;
      macroWeight += w;
      if (Math.abs(h.macroInfo.delta) >= 2) macroActiveCount += 1;
    }
    if (macroWeight > 0) {
      const avgDelta = weightedMacro / macroWeight; // ∈ roughly [-15, 15]
      macroExposure = Math.max(-10, Math.min(10, Math.round(avgDelta * 0.7)));
    }
  }

  // ─── Combine ───
  const raw = 40 + quality + diversification + concentrationPenalty + lossRatioPenalty + valuationPenalty + profitBonus + macroExposure;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  // ─── Verdict band ───
  let verdict;
  if (score >= 80)      verdict = "HEALTHY";
  else if (score >= 65) verdict = "GOOD";
  else if (score >= 50) verdict = "NEEDS_ATTENTION";
  else                  verdict = "AT_RISK";

  return {
    score,
    verdict,
    breakdown: {
      quality: Math.round(quality),
      diversification: Math.round(diversification),
      concentration: Math.round(concentrationPenalty),
      lossRatio: Math.round(lossRatioPenalty),
      valuation: Math.round(valuationPenalty),
      profitRatio: Math.round(profitBonus),
      macroExposure,
    },
    stats: {
      totalHoldings: valid.length,
      inLoss,
      inProfit,
      overvaluedCount,
      fullyValuedCount,
      sectorCount: Object.keys(sectorTotals).length,
      herfindahl: parseFloat(hhi.toFixed(3)),
      largestPosition: Math.max(...holdingIntel.map((h) => h.weight || 0)),
      macroActiveCount,
    },
  };
}

// ──────────────────── Sector concentration ────────────────────

/**
 * Compute sector allocation as a sorted list with flags for over-concentration.
 * A sector > 30% of the portfolio is flagged as a concentration risk.
 * If any holding carries macroInfo, the first non-zero impact per sector is
 * attached so the UI can show a per-sector macro chip.
 *
 * @param {Array<{holding, weight, macroInfo?}>} holdingIntel
 * @returns {Array<{ sector, weight, value, count, flag, macroImpact?, macroReason? }>}
 */
export function computeSectorAllocation(holdingIntel) {
  const bySector = new Map(); // sector → { weight, value, count, holdings[], macroImpact, macroReason }

  for (const h of holdingIntel) {
    const sector = h.holding.sector || "Unknown";
    const existing = bySector.get(sector) || { sector, weight: 0, value: 0, count: 0, holdings: [], macroImpact: 0, macroReason: null };
    existing.weight += h.weight || 0;
    existing.value += h.holding.investedValue || 0;
    existing.count += 1;
    existing.holdings.push(h.holding.symbol);
    // Capture macro impact for this sector. Each holding in the same sector
    // should have the same impact (regime is sector-keyed), but we take the
    // first non-zero one for robustness.
    if (existing.macroImpact === 0 && h.macroInfo && Number.isFinite(h.macroInfo.impact)) {
      existing.macroImpact = h.macroInfo.impact;
      existing.macroReason = h.macroInfo.reason || null;
    }
    bySector.set(sector, existing);
  }

  const rows = Array.from(bySector.values()).sort((a, b) => b.weight - a.weight);

  // Fix #4: Round using largest-remainder method so the displayed weights sum
  // to exactly 100. The old approach (rounding each sector independently)
  // accumulated 26 individual rounding errors into a +0.03% drift, which
  // broke the "weights must sum to 100" invariant in the accuracy audit.
  //
  // Hamilton's method:
  //   1. Compute each weight × 10 (we want 1 decimal place of precision)
  //   2. Floor each to get an integer part; track the fractional remainder
  //   3. Target = 1000 (since we multiplied by 10 and want total = 100.0)
  //   4. Distribute the remaining units to the rows with the largest remainders
  //   5. Divide back by 10
  const targetUnits = 1000; // 100.0% expressed in tenths
  const scaled = rows.map((r) => ({ row: r, scaled: r.weight * 10 }));
  const floors = scaled.map((s) => ({ row: s.row, integer: Math.floor(s.scaled), remainder: s.scaled - Math.floor(s.scaled) }));
  let sumIntegers = floors.reduce((s, f) => s + f.integer, 0);
  let remaining = targetUnits - sumIntegers;
  // Hand out one unit at a time to the rows with the biggest fractional remainder
  const byRemainder = [...floors].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < remaining && i < byRemainder.length; i++) {
    byRemainder[i].integer += 1;
  }
  // Write back rounded weight (1 decimal place precision)
  for (const f of floors) {
    f.row.weight = f.integer / 10;
    if (f.row.weight >= 30)       f.row.flag = "overconcentrated";
    else if (f.row.weight >= 20)  f.row.flag = "moderate";
    else                          f.row.flag = "diversified";
  }

  return rows;
}

// ──────────────────── Top contributors / detractors ────────────────────

/**
 * Return the top N winners and losers by ABSOLUTE ₹ P&L impact, not by %.
 * A 73% gain on a ₹1L position matters more than a 40% gain on a ₹10K one.
 *
 * @param {Array<{holding}>} holdingIntel
 * @param {number} limit
 * @returns {{ topWinners: [...], topLosers: [...] }}
 */
export function computeTopMovers(holdingIntel, limit = 3) {
  const withPnl = holdingIntel
    .filter((h) => h.holding.pnl != null)
    .map((h) => ({
      symbol: h.holding.symbol,
      name: h.holding.name,
      sector: h.holding.sector,
      pnl: h.holding.pnl,
      pnlPercent: h.holding.pnlPercent,
      currentValue: h.holding.currentValue,
      weight: h.weight,
    }));

  const topWinners = withPnl
    .filter((h) => h.pnl > 0)
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, limit);

  const topLosers = withPnl
    .filter((h) => h.pnl < 0)
    .sort((a, b) => a.pnl - b.pnl)
    .slice(0, limit);

  return { topWinners, topLosers };
}

// ──────────────────── Break-even & recovery probability ────────────────────

/**
 * For each holding in loss, compute:
 *   • break-even price (your avg price)
 *   • % upside needed to recover
 *   • rough recovery probability (based on 52-week range position and drawdown magnitude)
 *
 * Recovery probability is a crude heuristic, not a real forecast:
 *   • If you need > 100% gain, probability is capped at "very low"
 *   • If the stock is near its 52-week low AND you're down < 20%, probability is "moderate"
 *   • If the stock is near its 52-week high AND you're down, it's a falling knife → "low"
 *
 * @param {object} holding - { avgPrice, currentPrice, pnlPercent }
 * @param {object} quote - optional { fiftyTwoWeekHigh, fiftyTwoWeekLow }
 * @returns {{ breakEvenPrice, upsideNeededPct, recoveryProbability, note } | null}
 */
export function computeRecoveryMath(holding, quote) {
  if (holding.pnlPercent == null || holding.pnlPercent >= 0) return null;
  if (!holding.avgPrice || !holding.currentPrice) return null;

  const breakEvenPrice = holding.avgPrice;
  const upsideNeededPct = ((breakEvenPrice - holding.currentPrice) / holding.currentPrice) * 100;

  // Recovery heuristic. This is directional, not predictive.
  let probability = "moderate";
  let note = "";

  // Rule 1: massive upside required → very low probability
  if (upsideNeededPct > 100) {
    probability = "very_low";
    note = `Needs +${upsideNeededPct.toFixed(0)}% to break even. Historically, stocks with this kind of drawdown rarely recover within 12-24 months. Consider cutting and redeploying.`;
  }
  // Rule 2: moderate upside, stock near 52-week low → potential bounce zone
  else if (upsideNeededPct > 30) {
    probability = "low";
    note = `Needs +${upsideNeededPct.toFixed(0)}% to break even. Significant drawdown; recovery unlikely without a major catalyst.`;
  }
  else if (upsideNeededPct > 15) {
    probability = "moderate";
    note = `Needs +${upsideNeededPct.toFixed(0)}% to break even. Achievable over 6-12 months if the thesis holds.`;
  }
  else {
    probability = "high";
    note = `Needs just +${upsideNeededPct.toFixed(0)}% to break even. Small drawdown, likely recoverable.`;
  }

  // Refine with 52W position if available
  if (quote?.fiftyTwoWeekHigh && quote?.fiftyTwoWeekLow) {
    const pos52 = (holding.currentPrice - quote.fiftyTwoWeekLow) /
                  (quote.fiftyTwoWeekHigh - quote.fiftyTwoWeekLow);
    if (pos52 < 0.2 && upsideNeededPct <= 50) {
      // Near 52-week low, moderate upside → more likely to bounce
      if (probability === "low") probability = "moderate";
      else if (probability === "moderate") probability = "high";
      note += " Currently in the bottom 20% of its 52-week range — typical bounce territory.";
    } else if (pos52 > 0.6 && holding.pnlPercent < -15) {
      // High in range but you're down → falling knife, worse than it looks
      probability = "low";
      note += " Stock is still near its 52-week high despite your loss — this means YOU entered at an even higher level. Be cautious.";
    }
  }

  return {
    breakEvenPrice: parseFloat(breakEvenPrice.toFixed(2)),
    upsideNeededPct: parseFloat(upsideNeededPct.toFixed(2)),
    recoveryProbability: probability,
    note,
  };
}

// ──────────────────── Sell trigger / stop loss ────────────────────
//
// Pre-2026-05-16 the analyser told users when to BUY/TOP-UP but never when
// to SELL. The closest thing was the "Review — deep drawdown" advisory
// firing at −40%, which is advisory text, not a price-action stop. The
// SEBI-RA review flagged this as P0 because friends on a 50% drawdown
// will hold a "HOLD" label all the way to zero waiting for the platform
// to say something concrete.
//
// computeSellTrigger() returns a concrete rupee-priced stop based on the
// stronger of three floors:
//
//   1. AVG_COST_FLOOR  — 15% below the user's average cost. Caps total
//      drawdown on this position. This is the SEBI-defensible "no more
//      than X% loss on any single line" rule.
//   2. TRAILING_8PCT  — 8% below current price. Locks in gains as the
//      stock runs up; the stop moves with current price.
//   3. NEAR_52W_LOW    — 1% above the trailing 52-week low. Don't sell
//      AT the bottom; if the stock has held the low through prior
//      shocks, that level has technical support.
//
// The output picks the HIGHEST of these (the most conservative stop —
// closest to current price, smallest loss tolerated). A holding without
// avgPrice or currentPrice returns null (the UI hides the chip).
//
// This is intentionally a simple price floor, NOT regime-aware. A real
// ATR-based trailing stop would need volatility data per stock; that's
// a P2 improvement. For friends-and-family, "stop at this rupee price"
// is concrete enough to act on.
export function computeSellTrigger(holding, quote) {
  if (!holding || holding.avgPrice == null || holding.currentPrice == null) return null;
  if (!isFinite(holding.avgPrice) || !isFinite(holding.currentPrice)) return null;
  if (holding.avgPrice <= 0 || holding.currentPrice <= 0) return null;

  const avgCostFloor = holding.avgPrice * 0.85;
  const trailing8 = holding.currentPrice * 0.92;
  const candidates = [
    { type: "AVG_COST_FLOOR", price: avgCostFloor, note: "15% below your average cost" },
    { type: "TRAILING_8PCT", price: trailing8, note: "8% below current price" },
  ];

  const lowKey = quote?.fiftyTwoWeekLow ?? holding.fiftyTwoWeekLow ?? null;
  if (lowKey != null && isFinite(lowKey) && lowKey > 0) {
    candidates.push({
      type: "NEAR_52W_LOW",
      price: lowKey * 1.01,
      note: "1% above the trailing 52-week low",
    });
  }

  // Pick the highest stop (the most conservative — smallest loss).
  candidates.sort((a, b) => b.price - a.price);
  const winner = candidates[0];

  // Distance from current price — readable percent for the UI chip.
  const pctFromCurrent = ((winner.price - holding.currentPrice) / holding.currentPrice) * 100;

  return {
    stopPriceInr: parseFloat(winner.price.toFixed(2)),
    triggerType: winner.type,
    rationale: winner.note,
    pctFromCurrent: parseFloat(pctFromCurrent.toFixed(2)),
    // Severity is a UI hint only — "tight" means the stop is within 5%
    // of current; "wide" means there's runway. Doesn't change the action.
    severity: Math.abs(pctFromCurrent) < 5 ? "tight" : "wide",
  };
}

// ──────────────────── Position size recommendations ────────────────────

/**
 * Given a holding's conviction (combined score), compute the "earned" target
 * weight and flag whether the current position is appropriately sized.
 *
 * Conviction tiers:
 *   • High    (score >= 70)  → can hold 7-10% of portfolio
 *   • Medium  (score 55-69)  → can hold 4-6%
 *   • Low     (score 40-54)  → can hold 2-4%
 *   • None    (score < 40)   → exit or minimal (< 2%)
 */
export function computeTargetPositionSize(combinedScore, currentWeight) {
  if (combinedScore == null) {
    return { targetRange: null, status: "no_data", note: "Can't size without analysis." };
  }

  let targetMin, targetMax, tier;
  if (combinedScore >= 70)      { targetMin = 7; targetMax = 10; tier = "high"; }
  else if (combinedScore >= 55) { targetMin = 4; targetMax = 6;  tier = "medium"; }
  else if (combinedScore >= 40) { targetMin = 2; targetMax = 4;  tier = "low"; }
  else                          { targetMin = 0; targetMax = 2;  tier = "none"; }

  let status, note;
  if (currentWeight > targetMax * 1.5) {
    status = "overweight";
    note = `Current weight ${currentWeight.toFixed(1)}% is well above the ${targetMin}-${targetMax}% range for a ${tier}-conviction position. Consider trimming.`;
  } else if (currentWeight > targetMax) {
    status = "slightly_overweight";
    note = `Current weight ${currentWeight.toFixed(1)}% is slightly above the ${targetMin}-${targetMax}% target. No urgency, but don't add more.`;
  } else if (currentWeight < targetMin) {
    status = "underweight";
    note = `Current weight ${currentWeight.toFixed(1)}% is below the ${targetMin}-${targetMax}% range this conviction level deserves. Room to add.`;
  } else {
    status = "appropriate";
    note = `Weight ${currentWeight.toFixed(1)}% is within the ${targetMin}-${targetMax}% range for a ${tier}-conviction position.`;
  }

  return {
    targetRange: `${targetMin}-${targetMax}%`,
    targetMin,
    targetMax,
    tier,
    status,
    note,
  };
}

// ──────────────────── Orchestrator ────────────────────

/**
 * Build the complete portfolio intelligence block given enriched holdings,
 * their per-stock analyses, and fundamentals lookups.
 *
 * @param {Array} enrichedHoldings - holdings with currentPrice, pnl, pnlPercent, sector
 * @param {Map<string, object>} analysesBySymbol - { combinedScore, technicalScore, fundamentalScore, fundamentalVerdict }
 * @param {object} [options]
 * @param {object} [options.regime] - current macro regime (from macroRegime.js)
 * @param {function} [options.computeMacroDelta] - macroRegime.computeMacroDelta (avoids a circular import)
 * @returns {{
 *   healthScore, healthVerdict, healthBreakdown, healthStats,
 *   urgentActions: [...],
 *   perStock: { symbol: { action, urgency, reasoning, ... } }
 * }}
 */
export function buildPortfolioIntelligence(enrichedHoldings, analysesBySymbol, options = {}) {
  const regime = options.regime || null;
  const computeMacroDelta = options.computeMacroDelta || null;
  // Injected governance-gate lookup (server passes a closure over
  // governance.js::getGovernance + swsIndianRiskLayer::deriveGovernanceGate).
  // Defaults to a no-op so the unit-test path stays I/O-free and the gate
  // simply never fires when the dependency isn't wired.
  const getGovernanceGate = typeof options.getGovernanceGate === "function"
    ? options.getGovernanceGate
    : () => null;

  // Compute total invested value for weight calculations (use investedValue,
  // not currentValue — we care about capital allocation, not market moves).
  const totalInvested = enrichedHoldings.reduce(
    (sum, h) => sum + (h.investedValue || 0),
    0
  );

  // Per-holding intelligence
  const holdingIntel = enrichedHoldings.map((holding) => {
    const scores = analysesBySymbol.get(holding.symbol) || {};
    const weight = totalInvested > 0 ? (holding.investedValue / totalInvested) * 100 : 0;

    // Resolve per-holding macro info from the regime + sector (if provided)
    let macroInfo = null;
    if (regime && computeMacroDelta && holding.sector) {
      const { delta, reason, sector: canonicalSector } = computeMacroDelta(regime, holding.sector);
      if (delta !== 0) {
        // Recover the underlying sector impact (-3..+3) from the regime so
        // applyMacroToAction can threshold on it correctly.
        const sectorHit = regime.sectorImpacts?.find((s) => s.sector === canonicalSector);
        macroInfo = {
          delta,
          impact: sectorHit?.impact ?? 0,
          reason,
          canonicalSector,
          regimeId: regime.regime,
          regimeLabel: regime.regimeLabel || regime.regime,
          severity: regime.severity || 0,
          confidence: regime.confidence || 0,
        };
      }
    }

    // Recompute the combined score with macro blended in (half-weight)
    if (macroInfo && scores.technicalScore != null) {
      scores.baseCombinedScore = scores.combinedScore;
      scores.combinedScore = computePortfolioCombinedScore(
        scores.technicalScore,
        scores.fundamentalScore,
        macroInfo.delta
      );
    }

    const context = {
      positionWeight: weight,
      hasLiveData: holding.currentPrice != null,
      macroInfo,
      // Governance gate is null in the no-injection path (unit tests, any
      // legacy caller that doesn't pass options.getGovernanceGate). When
      // present, this triggers the REVIEW_GOVERNANCE pre-check in
      // computeAction — see Priority 0 in that function.
      governanceGate: getGovernanceGate(holding.symbol),
    };

    // Core action (LLM-free, macro-free)
    const baseAction = computeAction(holding, scores, context);
    // Apply macro adjustment layer
    const action = applyMacroToAction(baseAction, holding, scores, context);

    // Phase 2: personal recovery math + target position sizing per holding
    const recoveryMath = computeRecoveryMath(holding, {
      fiftyTwoWeekHigh: holding.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: holding.fiftyTwoWeekLow,
    });
    const positionSizing = computeTargetPositionSize(scores.combinedScore, weight);
    // P0.4 (2026-05-16) — concrete sell trigger so friends don't hold to zero.
    const sellTrigger = computeSellTrigger(holding, {
      fiftyTwoWeekLow: holding.fiftyTwoWeekLow,
    });

    return { holding, scores, weight, action, recoveryMath, positionSizing, sellTrigger, macroInfo };
  });

  // Portfolio health score
  const health = computeHealthScore(holdingIntel);

  // Phase 2: portfolio-level analytics
  const sectorAllocation = computeSectorAllocation(holdingIntel);
  const { topWinners, topLosers } = computeTopMovers(holdingIntel, 3);

  // Build per-stock map (now includes recovery + sizing + macro context)
  const perStock = {};
  for (const intel of holdingIntel) {
    perStock[intel.holding.symbol] = {
      action: intel.action.action,
      urgency: intel.action.urgency,
      reasoning: intel.action.reasoning,
      factors: intel.action.factors,
      displayAction: intel.action.displayAction,
      color: intel.action.color,
      positionWeight: parseFloat(intel.weight.toFixed(2)),
      combinedScore: intel.scores.combinedScore ?? null,
      baseCombinedScore: intel.scores.baseCombinedScore ?? null,
      technicalScore: intel.scores.technicalScore ?? null,
      fundamentalScore: intel.scores.fundamentalScore ?? null,
      fundamentalVerdict: intel.scores.fundamentalVerdict ?? null,
      recoveryMath: intel.recoveryMath,
      positionSizing: intel.positionSizing,
      sellTrigger: intel.sellTrigger,
      // Macro context (null when regime is calm/missing or the sector has no impact)
      macroInfo: intel.macroInfo || null,
      macroWarning: intel.action.macroWarning || null,
      macroTailwind: intel.action.macroTailwind || null,
    };
  }

  // Urgent actions queue: everything that isn't HOLD or NO_DATA, sorted by
  // urgency then by absolute P&L impact (biggest problems first).
  const urgencyRank = { high: 0, medium: 1, low: 2, none: 3 };
  const urgentActions = holdingIntel
    .filter((h) => h.action.action !== "HOLD" && h.action.action !== "NO_DATA")
    .sort((a, b) => {
      const ur = urgencyRank[a.action.urgency] - urgencyRank[b.action.urgency];
      if (ur !== 0) return ur;
      // Same urgency: sort by absolute P&L in ₹ (bigger problems first)
      const aPnl = Math.abs(a.holding.pnl || 0);
      const bPnl = Math.abs(b.holding.pnl || 0);
      return bPnl - aPnl;
    })
    .map((h) => ({
      symbol: h.holding.symbol,
      name: h.holding.name,
      action: h.action.action,
      displayAction: h.action.displayAction,
      urgency: h.action.urgency,
      color: h.action.color,
      reasoning: h.action.reasoning,
      pnl: h.holding.pnl,
      pnlPercent: h.holding.pnlPercent,
      weight: parseFloat(h.weight.toFixed(2)),
    }));

  return {
    healthScore: health.score,
    healthVerdict: health.verdict,
    healthBreakdown: health.breakdown,
    healthStats: health.stats,
    urgentActions,
    perStock,
    // Phase 2 additions — portfolio-level analytics
    sectorAllocation,
    topWinners,
    topLosers,
  };
}
