#!/usr/bin/env node
/**
 * Action-engine calibration diff harness.
 *
 * Runs the same synthetic 12-holding portfolio through THREE engines and
 * prints them side by side so the calibration shift is visible:
 *
 *   • V3-OLD : pre-aggressive-trim weights/thresholds (emulated inline)
 *   • V3-NEW : current aggressive-trim calibration (live engine output)
 *   • V4     : V4 opt-in path with the same aggressive-trim calibration
 *              (V4 inherits the V3 severityToTrimRung table, plus pillar/
 *              52W/settle/floor gates)
 *
 * The V3-OLD numbers are emulated — we don't run the live engine with old
 * weights, we recompute severity locally using the pre-recalibration
 * constants. Same severity formula, different numeric inputs. This keeps
 * the harness a single script with no git stash dance.
 *
 * Usage:
 *   node scripts/backtest-action-engine.mjs
 *   node scripts/backtest-action-engine.mjs path/to/portfolio.json
 *
 * Portfolio JSON shape (minimal):
 *   { "holdings": [ { symbol, quantity, avgPrice, currentPrice, ... }, ... ] }
 */

import { scoreHolding } from "../services/swsHoldingEngine.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Synthetic portfolio (same as before, exercises every gate) ─────
function buildSyntheticPortfolio() {
  const today = new Date("2026-05-07");
  const dayMs = 24 * 3600 * 1000;
  const daysAgo = (n) => new Date(today.getTime() - n * dayMs).toISOString().slice(0, 10);

  return {
    asOf: today.toISOString().slice(0, 10),
    holdings: [
      { symbol: "HDFCBANK", quantity: 100, avgPrice: 700, currentPrice: 796.55, currentValue: 79655,
        positionWeight: 8.0, sectorWeight: 22.0, sector: "Banking",
        fiftyTwoWeekHigh: 850, fiftyTwoWeekLow: 650, pnlPercent: 13.8,
        purchaseDate: daysAgo(420),
        _scenario: "Deep-value compounder near 52W high — should HOLD/Top-up regardless" },
      { symbol: "VEDL", quantity: 200, avgPrice: 300, currentPrice: 316.4, currentValue: 63280,
        positionWeight: 6.4, sectorWeight: 12.0, sector: "Metals",
        fiftyTwoWeekHigh: 380, fiftyTwoWeekLow: 240, pnlPercent: 5.5,
        purchaseDate: daysAgo(180),
        _scenario: "Mid-tier v3 with mixed pillars — V3-NEW expected to enter trim band" },
      { symbol: "RELIANCE", quantity: 50, avgPrice: 2400, currentPrice: 1437.9, currentValue: 71895,
        positionWeight: 7.2, sectorWeight: 14.0, sector: "Oil & Gas",
        fiftyTwoWeekHigh: 2750, fiftyTwoWeekLow: 1150, pnlPercent: -40.1,
        purchaseDate: daysAgo(380),
        _scenario: "−40% from cost but bounced 25% off lows" },
      { symbol: "IRFC", quantity: 600, avgPrice: 178, currentPrice: 106.74, currentValue: 64044,
        positionWeight: 6.5, sectorWeight: 9.0, sector: "Infrastructure",
        fiftyTwoWeekHigh: 220, fiftyTwoWeekLow: 105, pnlPercent: -40.0,
        purchaseDate: daysAgo(450),
        _scenario: "−40% AND at 52W low — legitimate trim candidate" },
      { symbol: "JPPOWER", quantity: 1000, avgPrice: 18, currentPrice: 16, currentValue: 16000,
        positionWeight: 1.6, sectorWeight: 3.0, sector: "Power",
        fiftyTwoWeekHigh: 24, fiftyTwoWeekLow: 13, pnlPercent: -11.1,
        purchaseDate: daysAgo(300),
        _scenario: "1.6% position — V4 floor gate collapses to HOLD/EXIT" },
      { symbol: "YESBANK", quantity: 2000, avgPrice: 23, currentPrice: 19, currentValue: 38000,
        positionWeight: 3.8, sectorWeight: 22.0, sector: "Banking",
        fiftyTwoWeekHigh: 26, fiftyTwoWeekLow: 17, pnlPercent: -17.4,
        purchaseDate: daysAgo(28),
        _scenario: "Held 28d — V4 settle gate caps trim if it lands in trim band" },
      { symbol: "SUZLON", quantity: 500, avgPrice: 60, currentPrice: 54.32, currentValue: 27160,
        positionWeight: 2.7, sectorWeight: 3.0, sector: "Power",
        fiftyTwoWeekHigh: 75, fiftyTwoWeekLow: 38, pnlPercent: -9.5,
        purchaseDate: daysAgo(200),
        _scenario: "Modest position, small drawdown" },
      { symbol: "TCS", quantity: 60, avgPrice: 2200, currentPrice: 2435.4, currentValue: 146124,
        positionWeight: 14.7, sectorWeight: 18.0, sector: "IT Services",
        fiftyTwoWeekHigh: 2700, fiftyTwoWeekLow: 2150, pnlPercent: 10.7,
        purchaseDate: daysAgo(360),
        _scenario: "14.7% position — concentration escalator may pull into trim band" },
      { symbol: "ITC", quantity: 200, avgPrice: 280, currentPrice: 310.7, currentValue: 62140,
        positionWeight: 6.2, sectorWeight: 9.0, sector: "FMCG",
        fiftyTwoWeekHigh: 330, fiftyTwoWeekLow: 240, pnlPercent: 11.0,
        purchaseDate: daysAgo(280),
        _scenario: "Mid-conviction top-up candidate" },
      { symbol: "ICICIBANK", quantity: 80, avgPrice: 950, currentPrice: 1100, currentValue: 88000,
        positionWeight: 8.8, sectorWeight: 22.0, sector: "Banking",
        fiftyTwoWeekHigh: 1180, fiftyTwoWeekLow: 880, pnlPercent: 15.8,
        purchaseDate: daysAgo(520),
        _scenario: "Banking top pick" },
      { symbol: "MARUTI", quantity: 12, avgPrice: 9500, currentPrice: 10800, currentValue: 129600,
        positionWeight: 13.0, sectorWeight: 13.0, sector: "Automobile",
        fiftyTwoWeekHigh: 12500, fiftyTwoWeekLow: 9300, pnlPercent: 13.7,
        purchaseDate: daysAgo(600),
        _scenario: "Steady-state HOLD" },
      { symbol: "INFY", quantity: 15, avgPrice: 1300, currentPrice: 1450, currentValue: 21750,
        positionWeight: 2.2, sectorWeight: 18.0, sector: "IT Services",
        fiftyTwoWeekHigh: 1600, fiftyTwoWeekLow: 1280, pnlPercent: 11.5,
        purchaseDate: daysAgo(150),
        _scenario: "₹21k base — V4 top-up floor may skip" },
    ],
  };
}

// ─── V3-OLD calibration emulator (pre-aggressive-trim) ──────────────
// Same severity formula, OLD weight values + OLD severityToTrimRung
// thresholds + OLD concentration escalators + OLD scoreBandAction v3
// thresholds. We replicate the math here so we can compare OLD to NEW
// without git-stashing the calibration.
const OLD_TRIM_WEIGHTS = {
  weakness: 0.30, concentration: 0.20, sectorOverweight: 0.10,
  conviction: 0.15, drawdown: 0.10, surveillance: 0.10, risks: 0.05,
};
const OLD_CONVICTION_PENALTY = {
  LOW: 1.00, "MEDIUM-LOW": 0.75, MEDIUM: 0.50, "MEDIUM-HIGH": 0.25, HIGH: 0.00,
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function surveillanceStageNumber(surveillance) {
  const direct = Number(surveillance?.stage_num);
  if (Number.isFinite(direct)) return direct;
  return Number(surveillance?.stage) || 0;
}

function oldSeverityToTrimRung(severity, gsmStage3Plus = false) {
  if (gsmStage3Plus) return "EXIT-now";
  if (!Number.isFinite(severity) || severity < 0.15) return null;
  if (severity >= 0.90) return "EXIT-now";
  if (severity >= 0.75) return "EXIT-staged";
  if (severity >= 0.60) return "Reduction-66%";
  if (severity >= 0.45) return "Reduction-50%";
  if (severity >= 0.30) return "Reduction-33%";
  return "Reduction-25%";
}

function oldComputeTrimSeverity(input) {
  const v3 = Number.isFinite(input.v3) ? input.v3 : 50;
  const pw = Number.isFinite(input.position_weight) ? input.position_weight : 0;
  const sw = Number.isFinite(input.sector_weight) ? input.sector_weight : 0;
  const pnl = Number.isFinite(input.pnlPercent) ? input.pnlPercent : 0;
  const rc = Number.isFinite(input.risks_count) ? input.risks_count : 0;
  const survList = input.surveillance?.list || null;
  const survStage = surveillanceStageNumber(input.surveillance);
  const weaknessRaw = clamp01((50 - v3) / 50);
  const concentrationRaw = clamp01(pw / 20);
  const sectorOverweightRaw = clamp01(sw / 35);
  const convictionRaw = OLD_CONVICTION_PENALTY[input.conviction] ?? 0.5;
  const drawdownRaw = clamp01(-pnl / 50);
  let surveillanceRaw = 0;
  if (survList === "GSM") surveillanceRaw = clamp01(0.30 + 0.05 * (survStage || 1));
  else if (survList === "ASM") surveillanceRaw = clamp01(0.10 + 0.05 * (survStage || 1));
  const risksRaw = clamp01(rc / 5);
  let severity = clamp01(
    weaknessRaw * OLD_TRIM_WEIGHTS.weakness +
    concentrationRaw * OLD_TRIM_WEIGHTS.concentration +
    sectorOverweightRaw * OLD_TRIM_WEIGHTS.sectorOverweight +
    convictionRaw * OLD_TRIM_WEIGHTS.conviction +
    drawdownRaw * OLD_TRIM_WEIGHTS.drawdown +
    surveillanceRaw * OLD_TRIM_WEIGHTS.surveillance +
    risksRaw * OLD_TRIM_WEIGHTS.risks
  );
  if (v3 < 8) severity = Math.max(severity, 0.90);
  else if (v3 < 14) severity = Math.max(severity, 0.75);
  if (pw > 30) severity = Math.max(severity, 0.60);
  else if (pw > 25) severity = Math.max(severity, 0.55);
  else if (pw > 20) severity = Math.max(severity, 0.45);
  else if (pw > 15) severity = Math.max(severity, 0.30);
  return severity;
}

function oldDeriveConvictionProxy({ v3, snow_total, surveillance, risks_count }) {
  const v3num = Number.isFinite(v3) ? v3 : 0;
  const snowNorm = Number.isFinite(snow_total) ? (snow_total / 30) * 100 : 0;
  let score = v3num * 0.6 + snowNorm * 0.4;
  if (surveillance) {
    if (surveillance.list === "GSM") {
      const stage = surveillanceStageNumber(surveillance) || 1;
      score -= 15 + stage * 3;
    } else if (surveillance.list === "ASM") score -= 8;
  }
  score -= (Number(risks_count) || 0) * 4;
  if (score >= 70) return "HIGH";
  if (score >= 55) return "MEDIUM-HIGH";
  if (score >= 40) return "MEDIUM";
  if (score >= 25) return "MEDIUM-LOW";
  return "LOW";
}

// V3-OLD scoreBandAction (the legacy label generator before widening). Used
// for holdings the live engine landed in HOLD-via-band — old engine MAY
// have routed them differently because of the narrower-band split.
function oldScoreBandAction(v3, pw) {
  if (v3 < 14) return "EXIT";
  if (v3 < 22) return pw > 10 ? "Reduction-50%" : "Reduction-25-33%";
  if (v3 < 40) return "HOLD";
  if (v3 < 50) return "HOLD";
  return "HOLD";
}

// Emulate V3-OLD by re-running the OLD severity math against the SAME legacy
// label the live engine emitted. The legacy label comes from either
// evaluateHardOverrides (governance/fragile-balance/earnings-decline patterns
// — unchanged by this PR) or scoreBandAction (which DID widen). For HOLDs
// emitted by the new wider band that the old narrower band would not have
// reached, fall back to running the OLD scoreBandAction explicitly.
function oldEmulateAction(holding, sectorWeight, v3, snow_total, risks_count, surveillance, liveLegacyAction) {
  const conviction = oldDeriveConvictionProxy({ v3, snow_total, surveillance, risks_count });
  // Determine the legacy label OLD engine would have emitted:
  //   1. If live legacy label is from a hard override (EXIT or Reduction-50%
  //      via evaluateHardOverrides), the OLD engine emits the same — same
  //      override code path, unchanged.
  //   2. If live legacy is HOLD or Top-up* (engine took a non-override
  //      path), recompute via OLD scoreBandAction.
  //   3. If live legacy is the new "Reduction-25-33%" from the widened
  //      v3<30 band, OLD engine would have said HOLD (v3 22-30 was HOLD pre-PR).
  let oldLegacy = liveLegacyAction;
  if (liveLegacyAction === "Reduction-25-33%" || liveLegacyAction === "Reduction-50%") {
    // For Reduction-50% legacy: could be from override or from scoreBandAction.
    // For Reduction-25-33% legacy: only from scoreBandAction (no override emits this).
    // Run OLD scoreBandAction; if it says HOLD or different, that's the OLD behaviour.
    const oldFromBand = oldScoreBandAction(v3, holding.positionWeight ?? 0);
    // If OLD scoreBandAction agrees with live legacy → same label.
    // If it disagrees → live label is from override (preserve) OR live label
    // is from new wider band (override with OLD band output).
    if (liveLegacyAction === "Reduction-25-33%") {
      // Only scoreBandAction emits this — pure band signal, use OLD band.
      oldLegacy = oldFromBand;
    } else {
      // liveLegacyAction === "Reduction-50%" — could be override (v3≥22 hard
      // override fires Reduction-50%; OLD engine same behaviour) OR widened
      // band (NEW path: v3 < 22 always Reduction-50%, OLD path: v3 < 22 + pw>10).
      if (v3 < 22 && (holding.positionWeight ?? 0) <= 10) {
        // OLD path: v3<22 + pw≤10 → Reduction-25-33% (was split out)
        oldLegacy = "Reduction-25-33%";
      }
      // else: hard override or v3<22 + pw>10 — same legacy in old engine
    }
  }
  // Same V3 promotion logic, OLD constants:
  if (oldLegacy === "EXIT") return { action: "EXIT-now", severity: 1.0, legacy: oldLegacy };
  if (oldLegacy === "HOLD") return { action: "HOLD", severity: null, legacy: oldLegacy };
  if (oldLegacy === "Reduction-50%" || oldLegacy === "Reduction-25-33%") {
    const severity = oldComputeTrimSeverity({
      v3,
      position_weight: holding.positionWeight,
      sector_weight: sectorWeight,
      conviction,
      surveillance,
      pnlPercent: holding.pnlPercent,
      risks_count,
    });
    const survList = surveillance?.list || null;
    const survStage = surveillanceStageNumber(surveillance);
    const gsmStage3Plus = survList === "GSM" && survStage >= 3;
    const rung = oldSeverityToTrimRung(severity, gsmStage3Plus) || "Reduction-25%";
    return { action: rung, severity, legacy: oldLegacy };
  }
  // Top-up legacy → same rung in old engine (top-up calibration unchanged)
  return { action: "HOLD", severity: null, legacy: oldLegacy };
}

// ─── Run live engine with given V4 flag ──────────────────────────────
function runWithV4Flag(holdings, v4Enabled) {
  const saved = process.env.SWS_LADDER_V4;
  process.env.SWS_LADDER_V4 = v4Enabled ? "1" : "0";
  const sectorWeights = {};
  for (const h of holdings) sectorWeights[h.sector] = (sectorWeights[h.sector] || 0) + (h.positionWeight || 0);
  const out = [];
  for (const h of holdings) {
    const result = scoreHolding(h, { sectorWeights });
    out.push({
      symbol: h.symbol,
      action: result.action,
      severity: result.ladderSeverity,
      severityModel: result.severityModel,
      legacyAction: result.legacyAction,
      ladderRationale: result.ladderRationale,
      _scoredV3: result.sws?.v4_score ?? null,
      _scoredSnowTotal: result.sws?.snowflake_total ?? null,
      _scoredRisks: result.sws?.v2_breakdown?.risks_count ?? 0,
      _scoredSurv: result.sws?.surveillance ?? null,
      _scenario: h._scenario,
    });
  }
  process.env.SWS_LADDER_V4 = saved;
  return out;
}

function emulateOldAcrossPortfolio(holdings, scoredV3New) {
  // Build sector-weight map from positionWeight (same as live engine).
  const sectorWeights = {};
  for (const h of holdings) sectorWeights[h.sector] = (sectorWeights[h.sector] || 0) + (h.positionWeight || 0);
  const TOPUP_LEGACY = new Set(["Top-up-modest", "Top-up", "STRONG Top-up"]);
  return holdings.map((h, i) => {
    const sw = sectorWeights[h.sector] ?? 0;
    const v3 = scoredV3New[i]._scoredV3 ?? 50;
    const snow_total = scoredV3New[i]._scoredSnowTotal ?? 15;
    const risks_count = scoredV3New[i]._scoredRisks ?? 0;
    const surveillance = scoredV3New[i]._scoredSurv ?? null;
    const liveLegacy = scoredV3New[i].legacyAction;
    // Top-up calibration is UNCHANGED in this PR — old engine produces the
    // same top-up rung as the new engine for any top-up legacy. Same goes
    // for direct HOLD legacy (no rung mapping happens). Only the trim path
    // diverges, so we only re-emulate that.
    if (TOPUP_LEGACY.has(liveLegacy) || liveLegacy === "HOLD") {
      return {
        symbol: h.symbol,
        action: scoredV3New[i].action,
        severity: scoredV3New[i].severity,
        legacy: liveLegacy,
      };
    }
    const r = oldEmulateAction(h, sw, v3, snow_total, risks_count, surveillance, liveLegacy);
    return { symbol: h.symbol, ...r };
  });
}

function diffAndReport(oldOut, newOut, v4Out, holdings) {
  const wpad = (s, n) => String(s ?? "").padEnd(n);
  const lines = [];
  lines.push("");
  lines.push("══════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  lines.push("  ACTION-LADDER CALIBRATION DIFF — V3-OLD vs V3-NEW (aggressive trim) vs V4");
  lines.push("══════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push(wpad("Symbol", 10) + wpad("V3-OLD", 17) + wpad("V3-NEW", 17) + wpad("V4", 17) +
             wpad("v3", 5) + wpad("OLD-sev", 9) + wpad("NEW-sev", 9) + " Scenario");
  lines.push("─".repeat(126));

  const rungScale = {
    "EXIT-now": 7, "EXIT-staged": 6,
    "Reduction-66%": 5, "Reduction-50%": 4, "Reduction-33%": 3, "Reduction-25%": 2,
    "HOLD": 0,
    "Top-up-25%": -2, "Top-up-33%": -3, "Top-up-50%": -4, "Top-up-100%": -5,
  };

  let trimsOld = 0, trimsNew = 0, trimsV4 = 0;
  let red50OrHarderOld = 0, red50OrHarderNew = 0;

  for (let i = 0; i < holdings.length; i++) {
    const o = oldOut[i], n = newOut[i], v = v4Out[i], h = holdings[i];
    const isTrim = (a) => a && (a.startsWith("Reduction") || a === "EXIT" || a.startsWith("EXIT-"));
    const isRed50OrHarder = (a) => a && (a === "Reduction-50%" || a === "Reduction-66%" || a === "EXIT-staged" || a === "EXIT-now");
    if (isTrim(o.action)) trimsOld++;
    if (isTrim(n.action)) trimsNew++;
    if (isTrim(v.action)) trimsV4++;
    if (isRed50OrHarder(o.action)) red50OrHarderOld++;
    if (isRed50OrHarder(n.action)) red50OrHarderNew++;

    const v3 = n._scoredV3 != null ? n._scoredV3.toFixed(0) : "—";
    const oldSev = Number.isFinite(o.severity) ? o.severity.toFixed(2) : "—";
    const newSev = Number.isFinite(n.severity) ? n.severity.toFixed(2) : "—";

    let arrow = "  ";
    if (o.action !== n.action) {
      const da = (rungScale[n.action] ?? 0) - (rungScale[o.action] ?? 0);
      arrow = da > 0 ? "↑ " : (da < 0 ? "↓ " : "→ ");
    }
    lines.push(
      wpad(h.symbol, 10) + wpad(o.action, 17) + wpad(n.action, 17) + wpad(v.action, 17) +
      wpad(v3, 5) + wpad(oldSev, 9) + wpad(newSev, 9) + arrow + " " + (h._scenario || "")
    );
  }

  lines.push("─".repeat(126));
  lines.push(`  Trim signals: V3-OLD ${trimsOld}/${holdings.length} · V3-NEW ${trimsNew}/${holdings.length} · V4 ${trimsV4}/${holdings.length}`);
  lines.push(`  Red-50%-or-harder: V3-OLD ${red50OrHarderOld} · V3-NEW ${red50OrHarderNew}  ← the user-reported gap`);
  lines.push("");

  // Verification checklist from the plan
  lines.push("VERIFICATION (per plan §Verification):");
  const oldHolds = oldOut.filter((o) => o.action === "HOLD").map((o, i) => ({ o, i }));
  const newPromotedFromHold = oldOut.map((o, i) => ({ o, n: newOut[i], i }))
    .filter(({ o, n }) => o.action === "HOLD" && (n.action.startsWith("Reduction") || n.action === "EXIT-now" || n.action === "EXIT-staged"));
  lines.push(`  ☐ At least 1 HOLD → trim:                    ${newPromotedFromHold.length >= 1 ? "✓ " + newPromotedFromHold.length + " (" + newPromotedFromHold.map(x => holdings[x.i].symbol).join(", ") + ")" : "✗ none"}`);

  const promotedToRed50OrHarder = oldOut.map((o, i) => ({ o, n: newOut[i], i }))
    .filter(({ o, n }) => {
      const oldDepth = rungScale[o.action] ?? 0;
      const newDepth = rungScale[n.action] ?? 0;
      const newIsRed50OrHarder = ["Reduction-50%", "Reduction-66%", "EXIT-staged", "EXIT-now"].includes(n.action);
      return newDepth > oldDepth && newIsRed50OrHarder;
    });
  lines.push(`  ☐ At least 1 Red-25/33 → Red-50% (or harder): ${promotedToRed50OrHarder.length >= 1 ? "✓ " + promotedToRed50OrHarder.length + " (" + promotedToRed50OrHarder.map(x => holdings[x.i].symbol + ": " + x.o.action + "→" + x.n.action).join(", ") + ")" : "✗ none"}`);

  // Compounders not over-trimmed: HDFCBANK, ICICIBANK, MARUTI, ITC should not be trimmed
  const compounderSymbols = ["HDFCBANK", "ICICIBANK", "MARUTI", "ITC"];
  const overTrimmedCompounders = newOut.filter((n) => compounderSymbols.includes(n.symbol) && (n.action.startsWith("Reduction") || n.action === "EXIT-now" || n.action === "EXIT-staged"));
  lines.push(`  ☐ No HOLD-worthy compounder over-trimmed:    ${overTrimmedCompounders.length === 0 ? "✓ all clean" : "✗ " + overTrimmedCompounders.map(x => x.symbol + ": " + x.action).join(", ")}`);

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const portfolioArg = process.argv[2];
  const portfolio = portfolioArg
    ? JSON.parse(fs.readFileSync(portfolioArg, "utf-8"))
    : buildSyntheticPortfolio();
  const holdings = portfolio.holdings || portfolio;
  console.log(`\nDiff harness — ${holdings.length} holdings, asOf ${portfolio.asOf || "today"}\n`);

  const v3New = runWithV4Flag(holdings, false);
  const v4Out = runWithV4Flag(holdings, true);
  const v3Old = emulateOldAcrossPortfolio(holdings, v3New);

  console.log(diffAndReport(v3Old, v3New, v4Out, holdings));
}

main().catch((err) => {
  console.error("Diff harness failed:", err);
  process.exit(1);
});
