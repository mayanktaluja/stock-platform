/**
 * Rolling per-ticker history for F&O OI / volume / price.
 *
 * Stored at: data/nse-fo/history/{TICKER}.json
 *   { ticker, points: [{ date, oi, oiChange, volume, settle, prevClose }, ...] }
 *
 * Retention: HISTORY_RETENTION_DAYS (30D).  Used by foOiDelta.js to
 * compute the 20-session volume baseline (vol_ratio = today / mean(N-1)).
 */

import fs from "node:fs";
import path from "node:path";

import { FO_CONFIG } from "./foConfig.js";

const HISTORY_DIR = path.join(process.cwd(), "data", "nse-fo", "history");

function historyPath(ticker) {
  return path.join(HISTORY_DIR, `${ticker}.json`);
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Append today's snapshot for a single ticker, prune to retention.
 * Idempotent — re-running for the same date overwrites the existing point.
 */
export function appendHistoryPoint(ticker, point) {
  const p = historyPath(ticker);
  const existing = readJsonSafe(p) || { ticker, points: [] };

  // De-dupe by date — re-run with same date overwrites
  const filtered = existing.points.filter((q) => q.date !== point.date);
  filtered.push(point);
  filtered.sort((a, b) => a.date.localeCompare(b.date));

  // Prune
  const cutoff = filtered.length > FO_CONFIG.HISTORY_RETENTION_DAYS
    ? filtered.length - FO_CONFIG.HISTORY_RETENTION_DAYS
    : 0;
  existing.points = filtered.slice(cutoff);

  writeJsonAtomic(p, existing);
}

/**
 * Bulk append: write today's data point for every underlying in the
 * aggregated map. Returns the count of files written.
 */
export function appendAllHistoryPoints(tradeDate, aggregated) {
  let written = 0;
  for (const [underlying, agg] of Object.entries(aggregated)) {
    appendHistoryPoint(underlying, {
      date: tradeDate,
      oi: agg.oiTotal,
      oiChange: agg.oiChangeTotal,
      volume: agg.volumeTotal,
      settle: agg.nearMonthSettle,
      prevClose: agg.nearMonthPrevClose,
    });
    written += 1;
  }
  return written;
}

/**
 * Compute volume_ratio = today's volume / mean(prior N-1 sessions).
 *
 * Returns Map<ticker, number>. Tickers with insufficient history (<5
 * prior sessions) are omitted, so the score formula falls back to
 * "unknown volume" downweighting.
 */
export function computeVolumeRatios(tradeDate, aggregated) {
  const out = new Map();
  const minHistory = 5; // need at least 5 prior days for a stable mean
  const window = FO_CONFIG.VOLUME_AVG_DAYS;

  for (const [underlying, agg] of Object.entries(aggregated)) {
    const hist = readJsonSafe(historyPath(underlying));
    if (!hist || !Array.isArray(hist.points)) continue;

    // Take prior sessions strictly before tradeDate, last `window` of them.
    const prior = hist.points
      .filter((p) => p.date < tradeDate && p.volume != null && p.volume > 0)
      .slice(-window);

    if (prior.length < minHistory) continue;

    const mean = prior.reduce((s, p) => s + p.volume, 0) / prior.length;
    if (mean <= 0) continue;

    out.set(underlying, agg.volumeTotal / mean);
  }
  return out;
}
