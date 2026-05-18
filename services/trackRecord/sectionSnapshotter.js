/**
 * sectionSnapshotter.js
 *
 * Owns the daily snapshot of the top-10 picks from every Track-Record-
 * bearing section. SWS sections are already auto-snapshotted by
 * snapshotAndCloseSwsPicks() inside the SWS refresh flow — this module
 * only adds coverage for the surfaces that lack their own pipeline hook:
 *
 *   • SWS pipeline      — read from data/sws/picks-latest.json sections
 *                          via snapshotAndCloseSwsPicks() inside the SWS
 *                          refresh flow.
 *   • Mid-Term scanner  — fetched live (no precompute).
 *   • Sell-Now scanner  — fetched live (no precompute), tracked SHORT.
 *   • Earnings BEAT/MISS top-10 — sliced from earnings-watch-latest.json,
 *                          horizon = T+1 only (resolver handles that path).
 *
 * Dedup is the storage adapter's job: same SHA-256 id ⇒ skipped on append.
 * One snapshot per (date × type × symbol) is therefore the natural unit.
 *
 * Open V2 follow-ups (flagged in the plan):
 *   1. Refactor scanner ranking out of /api/scan/:type so this module can
 *      call the ranker directly instead of HTTP-looping into our own
 *      server.
 *   2. Pre-compute mid-term and sell scans alongside buy-now so the
 *      cron-time snapshot is a pure read.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { appendTrades, buildTradeEntry, SECTION_TOP_N, STANDARD_HORIZONS, EARNINGS_HORIZONS } from "../../paperTrades.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

const EARNINGS_PATH = path.join(ROOT, "data", "catalysts", "earnings-watch-latest.json");

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}

// ──────────────────── Scanner snapshots ────────────────────

/**
 * Pull top-10 from a scanner endpoint via internal fetch. Re-uses all
 * existing scoring + filtering logic. The endpoint is on the same Express
 * server, so latency is intra-process (~50–500 ms for cached results).
 *
 * Falls open with [] on any failure so a flaky scanner doesn't block the
 * other sections.
 */
async function fetchScannerTop10(baseUrl, scanType, universe = "nifty100") {
  try {
    const url = `${baseUrl}/api/scan/${scanType}?universe=${encodeURIComponent(universe)}`;
    const res = await fetch(url, { headers: { "x-internal-snapshot": "1" } });
    if (!res.ok) {
      console.warn(`[trackRecord:snap] /api/scan/${scanType} returned ${res.status}`);
      return [];
    }
    const body = await res.json();
    const stocks = Array.isArray(body.stocks) ? body.stocks : [];
    // Score-rank, slice top N. The endpoint already sorts by score for buynow
    // but normalise here so all three types are handled uniformly.
    const ranked = [...stocks].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return ranked.slice(0, SECTION_TOP_N);
  } catch (err) {
    console.warn(`[trackRecord:snap] scanner ${scanType} fetch failed:`, err.message);
    return [];
  }
}

async function snapshotScannerSection(baseUrl, scanType, trackType, context) {
  const picks = await fetchScannerTop10(baseUrl, scanType);
  if (picks.length === 0) return { written: 0, skipped: 0, reason: "empty" };
  const entries = picks
    .map((p, idx) => buildTradeEntry(
      // Scanner picks already carry symbol/name/sector/price/score/recommendation.
      // Pass m-cap if the scanner included it (some endpoints do via fundamentals).
      { ...p, market_cap_inr: p.market_cap_inr ?? p.marketCapInr ?? null },
      trackType,
      { ...context, section_rank: idx + 1, target_horizons: STANDARD_HORIZONS }
    ))
    .filter(Boolean);
  if (entries.length === 0) return { written: 0, skipped: picks.length, reason: "build_failed" };
  return appendTrades(entries);
}

// ──────────────────── Earnings snapshots ────────────────────

/**
 * Earnings predictions come pre-ranked by `confidence_pct`. We keep the
 * top-10 BEAT and the top-10 MISS as separate trade types so the
 * scorecard can score them with opposite expected directions.
 *
 * The horizon is T+1 (one trading day after the result), not 1m/3m/6m/12m
 * — earnings predictions resolve quickly and the multi-horizon model would
 * dilute their signal.
 */
function topEarningsPicks(events, verdict) {
  if (!Array.isArray(events)) return [];
  const matching = events
    .filter((e) => e?.prediction?.verdict === verdict)
    .filter((e) => Number.isFinite(e?.prediction?.confidence_pct))
    .sort((a, b) => b.prediction.confidence_pct - a.prediction.confidence_pct);
  return matching.slice(0, SECTION_TOP_N).map((e) => ({
    symbol: `${e.symbol}.NS`,
    name: e.company || e.symbol,
    sector: e.signals?.sector || null,
    price: e.signals?.price_at_snapshot_inr ?? null,
    score: e.prediction?.score_100 ?? e.prediction?.confidence_pct ?? 0,
    recommendation: verdict,
    market_cap_inr: e.signals?.market_cap_inr ?? null,
  }));
}

async function snapshotEarningsSection(verdict, trackType, context) {
  const snap = readJsonSafe(EARNINGS_PATH);
  if (!snap || !Array.isArray(snap.events)) {
    return { written: 0, skipped: 0, reason: "earnings_snapshot_missing" };
  }
  const picks = topEarningsPicks(snap.events, verdict);
  if (picks.length === 0) return { written: 0, skipped: 0, reason: "no_predictions" };
  const entries = picks
    .map((p, idx) => buildTradeEntry(p, trackType, {
      ...context,
      section_rank: idx + 1,
      target_horizons: EARNINGS_HORIZONS,
    }))
    .filter(Boolean);
  if (entries.length === 0) return { written: 0, skipped: picks.length, reason: "build_failed" };
  return appendTrades(entries);
}

// ──────────────────── Public API ────────────────────

/**
 * Snapshot every Track-Record section that this module owns.
 * SWS sections are NOT covered here — they have their own pipeline hook
 * (snapshotAndCloseSwsPicks in paperTrades.js).
 *
 * @param {object} context  { baseUrl, niftyPrice, regime, snapshotAt, rationale }
 * @returns {Promise<{ perSection: { [type]: result }, written: number, skipped: number }>}
 */
export async function snapshotTrackRecordSections(context = {}) {
  const baseUrl = context.baseUrl || `http://localhost:${process.env.PORT || 3000}`;
  const ctx = {
    snapshotAt: context.snapshotAt || new Date().toISOString(),
    niftyPrice: context.niftyPrice ?? null,
    regime: context.regime || null,
    rationale: context.rationale || "Daily Track Record snapshot",
  };

  const perSection = {};
  let written = 0;
  let skipped = 0;

  const tasks = [
    ["scanner_buynow_top10",  () => snapshotScannerSection(baseUrl, "buynow",  "scanner_buynow_top10",  ctx)],
    ["scanner_midterm_top10", () => snapshotScannerSection(baseUrl, "midterm", "scanner_midterm_top10", ctx)],
    ["scanner_sell_top10",    () => snapshotScannerSection(baseUrl, "sell",    "scanner_sell_top10",    ctx)],
    ["earnings_beat_top10",   () => snapshotEarningsSection("BEAT", "earnings_beat_top10", ctx)],
    ["earnings_miss_top10",   () => snapshotEarningsSection("MISS", "earnings_miss_top10", ctx)],
  ];

  // Run sequentially to avoid hammering the local scanner endpoints in parallel.
  // Total budget at cron time: ~30s for 3 scanners + ~50ms for earnings reads.
  for (const [type, fn] of tasks) {
    try {
      const result = await fn();
      perSection[type] = result;
      written += result.written || 0;
      skipped += result.skipped || 0;
    } catch (err) {
      console.warn(`[trackRecord:snap] ${type} failed:`, err.message);
      perSection[type] = { written: 0, skipped: 0, error: err.message };
    }
  }

  return { perSection, written, skipped, snapshotAt: ctx.snapshotAt };
}
