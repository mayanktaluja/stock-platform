/**
 * Paper-Trade Tracker
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The thing that turns this platform from "looks like a great prediction tool"
 * into "is a great prediction tool". Records every Buy Now / Small-Cap /
 * Fundamental pick with the price + regime context at the time, then computes
 * forward returns vs the Nifty benchmark whenever the user opens the
 * Track Record tab.
 *
 * Storage is delegated to paperTradesStorage.js which picks between:
 *   • JSONL append file (local dev, synchronous, zero network)
 *   • Vercel KV sorted set (production, persistent across cold starts)
 *
 * All public functions in this module are async because KV reads/writes are
 * network calls. The file backend wraps its sync operations in promises for
 * interface compatibility.
 *
 * The forward-return computation is lazy: when the user opens the Track Record
 * tab, we fetch current Yahoo prices for all unique open symbols + the Nifty,
 * then compute (currentPrice / snapshotPrice - 1) for each pick. Cached 5 min.
 */

import crypto from "crypto";
import { getStorage } from "./paperTradesStorage.js";

// ──────────────────── Storage wrappers ────────────────────
// Thin async wrappers so callers don't need to know about the adapter layer.

/** Read all paper-trade entries, newest-first. */
export async function readAllTrades() {
  const storage = getStorage();
  const trades = await storage.readAll();
  // Normalize sort order — both backends should return newest-first but
  // we enforce it here so downstream code can rely on it.
  return trades.sort((a, b) => b.snapshotAt.localeCompare(a.snapshotAt));
}

/** Append entries (dedup is handled inside each adapter). */
export async function appendTrades(entries) {
  const storage = getStorage();
  return storage.append(Array.isArray(entries) ? entries : [entries]);
}

// ──────────────────── Date helpers ────────────────────

/**
 * Returns the current date in YYYY-MM-DD format using IST. Used as the
 * "snapshot day" key so that calls at 11:59 PM and 12:01 AM IST produce
 * different snapshots.
 */
export function getISTDateKey(date = new Date()) {
  const istStr = date.toLocaleString("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return istStr; // en-CA format is YYYY-MM-DD
}

// ──────────────────── Snapshot creation ────────────────────

/**
 * Build a paper-trade entry from a scanner pick. Pure function — does not
 * write anything. Caller decides whether to persist.
 *
 * @param {object} pick - the scanner stock object
 * @param {string} type - "buynow_nifty100" | "smallcap_buynow" | "fundamental_deep_value" | etc
 * @param {object} context - { regime, niftyPrice, snapshotAt, rationale }
 */
export function buildTradeEntry(pick, type, context) {
  const symbol = pick.symbol || pick.snapshot?.symbol;
  if (!symbol) return null;

  const snapshotAt = context.snapshotAt || new Date().toISOString();
  const dateKey = getISTDateKey(new Date(snapshotAt));

  // Stable ID per (date × type × symbol) so we can dedup on re-snapshot
  const id = crypto
    .createHash("sha256")
    .update(`${dateKey}|${type}|${symbol}`)
    .digest("hex")
    .slice(0, 16);

  return {
    id,
    dateKey,
    type,
    symbol,
    name: pick.name || pick.snapshot?.name || symbol.replace(".NS", ""),
    sector: pick.sector || pick.snapshot?.sector || null,
    snapshotAt,
    // Price at the moment we recommended it — the most important field
    priceAtSnapshot: Number(
      pick.price ?? pick.lastPrice ?? pick.snapshot?.price ?? 0
    ),
    // Nifty benchmark at the same moment for "beats-Nifty" calculation
    niftyAtSnapshot: context.niftyPrice ?? null,
    // Score the platform gave it
    scoreAtSnapshot: Number(pick.score ?? pick.adjustedMidtermScore ?? pick.midtermScore ?? 0),
    // Macro tilt at the time so we can later answer "did the regime
    // adjustments actually predict sector outperformance?"
    macroBoostAtSnapshot: Number(pick.macroBoost ?? 0),
    macroReasonAtSnapshot: pick.macroReason || null,
    regimeAtSnapshot: context.regime?.regime || "CALM",
    regimeSeverityAtSnapshot: context.regime?.severity ?? 1,
    // Verdict / recommendation labels for context
    recommendationAtSnapshot: pick.recommendation || pick.verdict || null,
    rationale: context.rationale || null,
  };
}

/**
 * Snapshot the current scanner picks for one type. Dedup is handled by the
 * storage adapter — running this twice on the same day for the same type
 * is a no-op.
 *
 * @param {Array} picks - array of stocks from the scanner
 * @param {string} type - snapshot type
 * @param {object} context - { regime, niftyPrice, snapshotAt, rationale }
 * @returns {Promise<{ written: number, skipped: number }>}
 */
export async function snapshotPicks(picks, type, context = {}) {
  if (!Array.isArray(picks) || picks.length === 0) {
    return { written: 0, skipped: 0 };
  }
  const entries = picks
    .map((p) => buildTradeEntry(p, type, context))
    .filter(Boolean);
  if (entries.length === 0) return { written: 0, skipped: picks.length };
  return appendTrades(entries);
}

/**
 * Returns true if any snapshot for the given type already exists for today.
 * Used by the snapshot scheduler to avoid duplicate work.
 */
export async function hasSnapshotToday(type) {
  const storage = getStorage();
  return storage.hasToday(type, getISTDateKey());
}

// ──────────────────── Forward return computation ────────────────────

/**
 * Compute forward return metrics for a single trade given its current price.
 * Pure function — no I/O.
 */
export function computeReturns(trade, currentPrice, currentNifty = null) {
  if (!trade.priceAtSnapshot || !currentPrice) {
    return { error: "missing_price" };
  }
  const returnPct = ((currentPrice - trade.priceAtSnapshot) / trade.priceAtSnapshot) * 100;
  const daysHeld = Math.max(
    0,
    Math.floor((Date.now() - new Date(trade.snapshotAt).getTime()) / 86400000)
  );

  let niftyReturnPct = null;
  let alpha = null;
  let beatsNifty = null;
  if (trade.niftyAtSnapshot && currentNifty) {
    niftyReturnPct = ((currentNifty - trade.niftyAtSnapshot) / trade.niftyAtSnapshot) * 100;
    alpha = returnPct - niftyReturnPct;
    beatsNifty = alpha > 0;
  }

  return {
    currentPrice,
    returnPct: parseFloat(returnPct.toFixed(2)),
    daysHeld,
    niftyReturnPct: niftyReturnPct != null ? parseFloat(niftyReturnPct.toFixed(2)) : null,
    alpha: alpha != null ? parseFloat(alpha.toFixed(2)) : null,
    beatsNifty,
  };
}

/**
 * Aggregate performance across a set of trades-with-returns.
 * Returns win rate, average return, beats-Nifty rate, etc.
 */
export function aggregatePerformance(tradesWithReturns) {
  const valid = tradesWithReturns.filter((t) => t.returns && t.returns.returnPct != null);
  if (valid.length === 0) {
    return {
      total: 0,
      winRate: null,
      avgReturn: null,
      medianReturn: null,
      avgAlpha: null,
      beatsNiftyRate: null,
      bestPick: null,
      worstPick: null,
    };
  }

  const returns = valid.map((t) => t.returns.returnPct);
  const wins = returns.filter((r) => r > 0).length;
  const sorted = [...returns].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  const withAlpha = valid.filter((t) => t.returns.alpha != null);
  const alphaSum = withAlpha.reduce((s, t) => s + t.returns.alpha, 0);
  const beatsCount = withAlpha.filter((t) => t.returns.beatsNifty).length;

  const best = valid.reduce((a, b) => (a.returns.returnPct > b.returns.returnPct ? a : b));
  const worst = valid.reduce((a, b) => (a.returns.returnPct < b.returns.returnPct ? a : b));

  return {
    total: valid.length,
    winRate: parseFloat(((wins / valid.length) * 100).toFixed(1)),
    avgReturn: parseFloat((returns.reduce((s, r) => s + r, 0) / returns.length).toFixed(2)),
    medianReturn: parseFloat(median.toFixed(2)),
    avgAlpha: withAlpha.length > 0 ? parseFloat((alphaSum / withAlpha.length).toFixed(2)) : null,
    beatsNiftyRate: withAlpha.length > 0
      ? parseFloat(((beatsCount / withAlpha.length) * 100).toFixed(1))
      : null,
    benchmarkSampleSize: withAlpha.length,
    bestPick: { symbol: best.symbol, name: best.name, returnPct: best.returns.returnPct },
    worstPick: { symbol: worst.symbol, name: worst.name, returnPct: worst.returns.returnPct },
  };
}

/**
 * Group trades by an attribute and aggregate within each group.
 */
export function groupAndAggregate(tradesWithReturns, attribute) {
  const groups = new Map();
  for (const t of tradesWithReturns) {
    const key = t[attribute] || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const result = {};
  for (const [key, trades] of groups) {
    result[key] = aggregatePerformance(trades);
  }
  return result;
}

// ──────────────────── File stats ────────────────────

export async function getStorageStats() {
  const storage = getStorage();
  const stats = await storage.getStats();
  return {
    backend: storage.name,
    ...stats,
    // Backward-compat fields used by the frontend empty-state
    oldestSnapshot: stats.oldest ?? null,
    newestSnapshot: stats.newest ?? null,
  };
}
