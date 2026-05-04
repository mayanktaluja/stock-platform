/**
 * scannerAuditTrail.js — SEBI RA Reg 2014 §16(1) + 2025 amendment §6
 * audit trail for Market Scanner picks. Captures the full input snapshot
 * + decision metadata so a SEBI auditor (or the user, for self-audit)
 * can reconstruct any pick's reasoning from raw stored data, 5 years out.
 *
 * The existing paperTrades pipeline only stores priceAtSnapshot / regime
 * / niftyAtSnapshot — useful for forward-return tracking but missing the
 * decision inputs. This module adds a parallel persisted log keyed by
 * (date × scannerType × symbol) with:
 *
 *   - modelVersion (combined-v1-2026-04 etc)
 *   - weightsUsed (tech/fund/sws/news effective ratios)
 *   - All component scores (techScore, fundamentalScore, swsScore)
 *   - Verdict labels (fundamentalVerdict, swsVerdict, recommendation)
 *   - Indicator snapshot (RSI, ATR, sector momentum)
 *   - Risk parameters (stopLoss, target, riskReward)
 *   - Filter outcomes (earningsBlackout, advRupees, surveillanceFlag,
 *     fnoBan, promoterPledge)
 *   - Conviction band + realized hit-rate
 *   - dataConfidence + divergence
 *
 * Storage: one JSON file per (date, scannerType) under
 * data/audit/scanner/{YYYY-MM-DD}/{type}.json. Re-running the same scan
 * on the same day overwrites the file (idempotent — the latest scan of
 * that day is the canonical record).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_ROOT = path.resolve(__dirname, "..", "data", "audit", "scanner");

const SCHEMA_VERSION = "scanner-audit-v1-2026-05";

/**
 * Reduce a scanner pick to a flat audit entry. Pure function — no I/O.
 *
 * @param {object} pick   the post-filter scanner pick
 * @param {string} type   "buynow" | "midterm" | "sell"
 * @param {object} ctx    { regime, niftyPrice, methodologyVersion, scannedAt }
 * @returns {object|null}
 */
export function buildAuditEntry(pick, type, ctx = {}) {
  if (!pick || !pick.symbol) return null;
  const score = type === "midterm" ? pick.midTerm?.score : (pick.adjustedScore ?? pick.score);
  return {
    symbol: pick.symbol,
    name: pick.name || null,
    sector: pick.sector || null,
    type,
    scannedAt: ctx.scannedAt || new Date().toISOString(),
    methodologyVersion: pick.combinedScoreVersion || ctx.methodologyVersion || null,
    combinedScoreMode: pick.combinedScoreMode || null,

    // Score & verdict
    score: score != null ? Math.round(score) : null,
    recommendation: pick.recommendation || null,
    fundamentalVerdict: pick.fundamentalVerdict || null,
    swsVerdict: pick.swsVerdict || null,

    // Component scores
    technicalScore: pick.technicalScore ?? pick.score ?? null,
    fundamentalScore: pick.fundamentalScore ?? null,
    swsScore: pick.swsScore ?? null,
    snowflakeTotal: pick.snowflakeTotal ?? null,
    swsSource: pick.swsSource || null,

    // Effective weights (post pro-rata reweighting)
    weightsUsed: pick.combinedWeights || null,
    contributingDims: pick.combinedDims || null,
    dataConfidence: pick.combinedDataConfidence || pick.dataConfidence || null,
    divergence: pick.combinedDivergence || false,
    divergenceSpread: pick.combinedDivergenceSpread ?? null,

    // Indicators at snapshot time
    indicators: {
      rsi: pick.rsi ?? null,
      trend: pick.trend ?? null,
      atr: pick.atr ?? null,
      sectorMomentumBonus: pick.sectorMomentum ?? null,
    },

    // Risk parameters
    risk: {
      price: pick.price ?? null,
      stopLoss: type === "midterm" ? pick.midTerm?.stopLoss : pick.stopLoss ?? null,
      target: type === "midterm" ? pick.midTerm?.target : pick.target ?? null,
      riskReward: type === "midterm" ? pick.midTerm?.riskReward : pick.riskReward ?? null,
    },

    // Filter outcomes — a SEBI auditor checking "why did this pass"
    // can read these instead of replaying the filter chain
    filters: {
      adv20Rupees: pick.adv20 ?? null,
      earningsNearbyDate: pick.earningsNearby?.date || null,
      // The below are inferred — if the pick passed, neither veto fired
      sectorExcluded: false,
      surveillanceVeto: false,
      fnoBanVeto: false,
    },

    // Conviction at snapshot
    conviction: {
      band: pick.convictionBand || null,
      realizedHitRate: Number.isFinite(pick.convictionPct) ? pick.convictionPct : null,
    },

    // Macro + regime context
    macro: {
      regime: ctx.regime?.regime || null,
      severity: ctx.regime?.severity ?? null,
      delta: pick.macroBoost ?? null,
      reason: pick.macroReason || null,
    },

    // Portfolio overlay context
    portfolio: pick.inPortfolio ? {
      inPortfolio: true,
      currentWeightPct: pick.currentWeight ?? null,
      concentrationAfterTopUpPct: pick.concentrationAfterTopUp ?? null,
    } : { inPortfolio: false },

    niftyAtSnapshot: ctx.niftyPrice ?? null,
  };
}

/**
 * Persist a per-scan audit log to data/audit/scanner/{YYYY-MM-DD}/{type}.json.
 * Best-effort: failures are logged but do not throw.
 *
 * @param {Array} picks       full scanner pick list (post-overlay)
 * @param {string} type       scan type
 * @param {object} ctx        { dateKey, regime, niftyPrice, methodologyVersion, scannedAt }
 * @returns {Promise<{written: number, path: string|null, error?: string}>}
 */
export async function persistScannerAudit(picks, type, ctx = {}) {
  if (!Array.isArray(picks) || picks.length === 0) {
    return { written: 0, path: null };
  }
  try {
    const dateKey = ctx.dateKey || new Date().toISOString().slice(0, 10);
    const dir = path.join(AUDIT_ROOT, dateKey);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${type}.json`);
    const entries = picks.map((p) => buildAuditEntry(p, type, ctx)).filter(Boolean);
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      type,
      dateKey,
      scannedAt: ctx.scannedAt || new Date().toISOString(),
      universe: ctx.universe || null,
      methodologyVersion: ctx.methodologyVersion || null,
      regime: ctx.regime?.regime || null,
      niftyAtSnapshot: ctx.niftyPrice ?? null,
      n: entries.length,
      picks: entries,
    };
    await fs.promises.writeFile(file, JSON.stringify(payload, null, 2));
    return { written: entries.length, path: file };
  } catch (err) {
    console.warn("[scannerAuditTrail] persist failed:", err.message);
    return { written: 0, path: null, error: err.message };
  }
}

export { SCHEMA_VERSION };
