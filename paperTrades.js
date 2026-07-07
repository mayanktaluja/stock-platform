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
import { classifyCapBand } from "./services/trackRecord/capBandClassifier.js";

// ──────────────────── Section registry (multi-source) ────────────────────
//
// Every section the Track Record covers, side-tagged. The first block is
// SWS picks (already auto-snapshotted by snapshotAndCloseSwsPicks); the rest
// are scanner + earnings sections owned by services/trackRecord/sectionSnapshotter.js.
// `side` decides return-sign convention used in computeReturns.

export const ALL_SECTION_TYPES = {
  // SWS — LONG
  sws_top30_v3: "LONG",
  sws_best_buynow: "LONG",
  sws_deep_value: "LONG",
  sws_growing_sector_value: "LONG",
  sws_quality_growth: "LONG",
  sws_best_fundamentals: "LONG",
  sws_dividend_aristocrats: "LONG",
  sws_smallcap_gems: "LONG",
  sws_insider_buying: "LONG",
  sws_midterm: "LONG",
  sws_upcoming_earnings: "LONG",
  // SWS — SHORT (avoid list)
  sws_avoid: "SHORT",
  // Scanners
  scanner_buynow_top10: "LONG",
  scanner_midterm_top10: "LONG",
  scanner_sell_top10: "SHORT",
  // Earnings (T+1 horizon only)
  earnings_beat_top10: "LONG",
  earnings_miss_top10: "SHORT",
};

// SWS buckets that are useful context/filter surfaces, but are not public
// buy-recommendation track-record sections.
export const PUBLIC_TRACK_EXCLUDED_TYPES = new Set([
  "sws_upcoming_earnings",
  "sws_avoid",
]);

export const PUBLIC_TRACK_TYPES = new Set(
  Object.keys(ALL_SECTION_TYPES).filter((type) => !PUBLIC_TRACK_EXCLUDED_TYPES.has(type))
);

export function isPublicTrackType(type) {
  return PUBLIC_TRACK_TYPES.has(type);
}

export function filterPublicTrackTrades(trades) {
  return Array.isArray(trades) ? trades.filter((t) => isPublicTrackType(t?.type)) : [];
}

/**
 * Side ('LONG' | 'SHORT') for a given trade type. Falls back to LONG for
 * legacy types not in the registry — matches the historical default.
 */
export function inferSideFromType(type) {
  return ALL_SECTION_TYPES[type] || "LONG";
}

// Top-N to capture per section. Locked at 10 by product spec.
export const SECTION_TOP_N = 10;

// SEBI-RA convention: forward returns reported at 1m / 3m / 6m / 12m.
// Earnings sections measure T+1 instead — handled by the resolver.
export const STANDARD_HORIZONS = ["1m", "3m", "6m", "12m"];
export const EARNINGS_HORIZONS = ["t1"];

const HORIZON_DAYS = { "1m": 30, "3m": 91, "6m": 183, "12m": 365 };
export function horizonDays(h) { return HORIZON_DAYS[h] || null; }

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
 * @param {string} type - "sws_top30_v3" | "sws_best_buynow" | "sws_deep_value" | etc (see PUBLIC_TRACK_TYPES)
 * @param {object} context - { regime, niftyPrice, snapshotAt, rationale,
 *   section_rank, market_cap_inr, target_horizons }
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

  // V2 fields: side, cap-band, benchmark proxy, multi-horizon scaffold.
  // Earnings sections only measure T+1; everything else uses 1m/3m/6m/12m.
  const side = inferSideFromType(type);
  const marketCapInr = Number(
    pick.market_cap_inr ?? pick.marketCap ?? context.market_cap_inr ?? 0
  ) || null;
  const capBand = classifyCapBand(marketCapInr);
  const horizons = Array.isArray(context.target_horizons)
    ? context.target_horizons
    : (type.startsWith("earnings_") ? EARNINGS_HORIZONS : STANDARD_HORIZONS);
  const returnsByHorizon = {};
  for (const h of horizons) {
    returnsByHorizon[h] = {
      exit_date: null,
      exit_price: null,
      return_pct: null,
      benchmark_return_pct: null,
      alpha_pct: null,
      status: "open",
    };
  }

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
    // V2 — SEBI-RA-grade per-section track record
    side,
    section_rank: Number.isFinite(context.section_rank) ? context.section_rank : null,
    cap_band: capBand,
    benchmark_proxy: capBand
      ? (capBand === "large" ? "nifty50_tri"
        : capBand === "mid" ? "midcap150_tri"
        : "smallcap250_tri")
      : "nifty50_tri",
    market_cap_inr_at_snapshot: marketCapInr,
    // Scoring-model stamp so the section backtest can split populations across a
    // deliberate score change (e.g. the v4.1 H↔F pillar reweight, 2026-07). Old
    // rows lack this field → treated as the pre-v4.1 era by snapshotAt date.
    scoring_version: context.scoring_version || null,
    target_horizons: horizons,
    returns_by_horizon: returnsByHorizon,
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
 *
 * If `trade.closedAt` is set the trade is closed (the section dropped it on
 * that date) — we use `trade.closingPrice` and `trade.niftyAtClose` instead
 * of the live price, and `daysHeld` measures the realised holding window.
 *
 * For "short" types (e.g. `sws_avoid` — picks we told the user to avoid) the
 * win condition is inverted: alpha = niftyReturn − pickReturn, so beatsNifty
 * means "the avoided pick under-performed Nifty as predicted."
 */
export function computeReturns(trade, currentPrice, currentNifty = null) {
  if (!trade.priceAtSnapshot) return { error: "missing_price" };

  const isClosed = !!trade.closedAt && trade.closingPrice != null;
  const exitPrice = isClosed ? trade.closingPrice : currentPrice;
  const exitNifty = isClosed ? trade.niftyAtClose : currentNifty;
  if (!exitPrice) return { error: "missing_price" };

  const returnPct = ((exitPrice - trade.priceAtSnapshot) / trade.priceAtSnapshot) * 100;
  const endTimestamp = isClosed ? new Date(trade.closedAt).getTime() : Date.now();
  const daysHeld = Math.max(
    0,
    Math.floor((endTimestamp - new Date(trade.snapshotAt).getTime()) / 86400000)
  );

  let niftyReturnPct = null;
  let alpha = null;
  let beatsNifty = null;
  if (trade.niftyAtSnapshot && exitNifty) {
    niftyReturnPct = ((exitNifty - trade.niftyAtSnapshot) / trade.niftyAtSnapshot) * 100;
    // Side semantics: a SHORT pick "wins" when it under-performs the
    // benchmark — alpha is signed in the opposite direction.
    const side = trade.side || inferSideFromType(trade.type);
    const isShort = side === "SHORT";
    alpha = isShort ? (niftyReturnPct - returnPct) : (returnPct - niftyReturnPct);
    beatsNifty = alpha > 0;
  }

  return {
    currentPrice: exitPrice,
    returnPct: parseFloat(returnPct.toFixed(2)),
    daysHeld,
    closed: isClosed,
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
      primary_success_metric: "signed_alpha",
      primary_success_rate_pct: null,
      primary_sample_size: 0,
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

  const beatsNiftyRate = withAlpha.length > 0
    ? parseFloat(((beatsCount / withAlpha.length) * 100).toFixed(1))
    : null;
  return {
    total: valid.length,
    winRate: parseFloat(((wins / valid.length) * 100).toFixed(1)),
    avgReturn: parseFloat((returns.reduce((s, r) => s + r, 0) / returns.length).toFixed(2)),
    medianReturn: parseFloat(median.toFixed(2)),
    avgAlpha: withAlpha.length > 0 ? parseFloat((alphaSum / withAlpha.length).toFixed(2)) : null,
    beatsNiftyRate,
    primary_success_metric: "signed_alpha",
    primary_success_rate_pct: beatsNiftyRate,
    primary_sample_size: withAlpha.length,
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

// ──────────────────── SWS multi-section snapshot ────────────────────

/**
 * Map a picks-latest.json section key to the trade-log type used by the
 * public Track Record tab. Context-only buckets such as Upcoming Earnings and
 * Avoid are intentionally omitted so future SWS runs do not append them.
 */
export const SWS_SECTION_TO_TYPE = {
  top_ranked_30_v4: "sws_top30_v3",
  top_ranked_30_v3: "sws_top30_v3",
  best_to_buy_now: "sws_best_buynow",
  deep_value: "sws_deep_value",
  growing_sector_value: "sws_growing_sector_value",
  quality_growth: "sws_quality_growth",
  best_fundamentals: "sws_best_fundamentals",
  midterm: "sws_midterm",
  dividend_aristocrats: "sws_dividend_aristocrats",
  smallcap_gems: "sws_smallcap_gems",
  insider_buying: "sws_insider_buying",
};

/**
 * Convert a picks-latest.json entry into the shape `buildTradeEntry` expects.
 * SWS uses `ticker` (no exchange suffix) + INR-suffixed price/cap fields; we
 * append `.NS` so live-price lookups via Yahoo work the same way they do for
 * the legacy scanner picks.
 */
export function swsPickToTradeShape(swsPick) {
  if (!swsPick || !swsPick.ticker) return null;
  return {
    symbol: `${swsPick.ticker}.NS`,
    name: swsPick.name || swsPick.ticker,
    sector: swsPick.sector || null,
    price: swsPick.current_price_inr ?? null,
    score: swsPick.v4_score_100 ?? swsPick.v4_score ?? 0,
    recommendation: swsPick.composite_verdict || swsPick.v4_verdict || null,
    // Pass m-cap through so buildTradeEntry can route to the right TRI proxy.
    market_cap_inr: swsPick.market_cap_inr ?? null,
  };
}

export function shouldSkipSwsSectionSnapshot(sectionKey, picksData) {
  if (sectionKey !== "growing_sector_value") return false;
  const audit = picksData?.section_audit?.growing_sector_value || {};
  return audit.display_mode === "macro_value_fallback" ||
    audit.future_growth_gate_relaxed === true;
}

/**
 * Snapshot every section of a picks-latest.json document into the trade log.
 * One pass over `picksData.sections`, applying the SWS→scanner-shape adapter
 * and calling `snapshotPicks` per type. Empty sections are no-ops.
 *
 * `context.snapshotAt` should be the picks file's own `scanned_at` so the
 * recommendation timestamp matches the file the user actually saw — that's
 * the SEBI-defensible "moment of recommendation."
 *
 * Returns { written, skipped, perSection } for logging.
 */
export async function snapshotSwsAllSections(picksData, context = {}) {
  if (!picksData || !picksData.sections) {
    return { written: 0, skipped: 0, perSection: {} };
  }
  const snapshotAt = context.snapshotAt || picksData.scanned_at || new Date().toISOString();
  const totals = { written: 0, skipped: 0, perSection: {} };

  for (const [sectionKey, type] of Object.entries(SWS_SECTION_TO_TYPE)) {
    if (sectionKey === "top_ranked_30_v3" && Array.isArray(picksData.sections.top_ranked_30_v4)) continue;
    const items = picksData.sections[sectionKey];
    if (!Array.isArray(items) || items.length === 0) continue;
    if (shouldSkipSwsSectionSnapshot(sectionKey, picksData)) {
      totals.perSection[type] = { written: 0, skipped: items.length, reason: "macro_value_fallback_not_canonical_track_record" };
      totals.skipped += items.length;
      continue;
    }
    // Cap each section to the top SECTION_TOP_N picks. Sections like
    // top_ranked_30_v4 carry 30 entries; the SEBI-RA scorecard only tracks
    // the headline top 10 to match what users see on the picks tab.
    const sliced = items.slice(0, SECTION_TOP_N);
    const picks = sliced.map(swsPickToTradeShape).filter(Boolean);
    if (picks.length === 0) continue;
    const scoringVersion = context.scoring_version || picksData.scoring_version || null;
    const entries = picks
      .map((p, idx) => buildTradeEntry(p, type, { ...context, snapshotAt, scoring_version: scoringVersion, section_rank: idx + 1 }))
      .filter(Boolean);
    if (entries.length === 0) continue;
    const result = await appendTrades(entries);
    totals.written += result.written || 0;
    totals.skipped += result.skipped || 0;
    totals.perSection[type] = result;
  }
  return totals;
}

/**
 * Build a `{ type → Set<symbol> }` map from a picks-latest.json document.
 * Used by `closeExitedSwsTrades` to figure out which prior trades dropped
 * out of their section since the last snapshot.
 */
export function buildSwsTickerIndex(picksData) {
  const index = {};
  if (!picksData || !picksData.sections) return index;
  for (const [sectionKey, type] of Object.entries(SWS_SECTION_TO_TYPE)) {
    const items = picksData.sections[sectionKey];
    if (!Array.isArray(items)) continue;
    index[type] = new Set(
      items
        .filter((it) => it && it.ticker)
        .map((it) => `${it.ticker}.NS`)
    );
  }
  return index;
}

/**
 * Close any open SWS trades whose section no longer carries them in
 * `picksData`. Reads all trades, computes closures, persists patches via
 * the storage adapter's updateById.
 *
 * `priceBySymbol` is the snapshot of section prices to use as the close
 * price (typically the prior section's last `current_price_inr`). When a
 * symbol isn't in the map we skip closing it — better to leave it open
 * than fabricate a price.
 *
 * Returns { closed, missingPrice } for logging.
 */
export async function closeExitedSwsTrades(picksData, context = {}) {
  if (!picksData) return { closed: 0, missingPrice: 0 };
  const allTrades = await readAllTrades();
  if (allTrades.length === 0) return { closed: 0, missingPrice: 0 };

  // Only consider SWS types — legacy buynow/smallcap/fundamental have their
  // own snapshot lifecycle and shouldn't be closed by an SWS pipeline run.
  const swsTypes = new Set(Object.values(SWS_SECTION_TO_TYPE));
  const swsTrades = allTrades.filter((t) => swsTypes.has(t.type));
  if (swsTrades.length === 0) return { closed: 0, missingPrice: 0 };

  const tickerIndex = buildSwsTickerIndex(picksData);
  const closures = computeTradeClosures(swsTrades, tickerIndex, {
    closedAt: context.snapshotAt || picksData.scanned_at || new Date().toISOString(),
    niftyAtClose: context.niftyPrice ?? null,
    priceBySymbol: context.priceBySymbol || {},
  });
  if (closures.length === 0) return { closed: 0, missingPrice: 0 };
  const storage = getStorage();
  const result = await storage.updateById(closures);
  return { closed: result.updated || 0, missingPrice: 0, ...result };
}

/**
 * Build a price map `{ "TICKER.NS": price }` from the entries we just
 * snapshotted — these prices are the most recent observation for each
 * ticker and so the natural close price for any (type, symbol) that
 * dropped out of its section in this same pipeline run.
 */
export function priceMapFromPicksData(picksData) {
  const out = {};
  if (!picksData || !picksData.sections) return out;
  for (const items of Object.values(picksData.sections)) {
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it || !it.ticker) continue;
      const key = `${it.ticker}.NS`;
      if (out[key] == null && it.current_price_inr != null) {
        out[key] = Number(it.current_price_inr);
      }
    }
  }
  return out;
}

/**
 * High-level convenience: snapshot all sections + close any prior trades
 * that dropped out. The pipeline hook and the live endpoint both call this.
 */
export async function snapshotAndCloseSwsPicks(picksData, context = {}) {
  const priceBySymbol = priceMapFromPicksData(picksData);
  // Close exited trades FIRST so today's re-entries don't get closed by
  // accident (a ticker that left and re-joined a section in the same run
  // would otherwise be closed at the new snapshot's own price, alpha=0).
  // Walking close-then-snapshot, the new entry is appended after closing.
  const closeResult = await closeExitedSwsTrades(picksData, { ...context, priceBySymbol });
  const snapshotResult = await snapshotSwsAllSections(picksData, context);
  return { snapshot: snapshotResult, close: closeResult };
}

// ──────────────────── Trade closing (exit model) ────────────────────

/**
 * Close any trades whose section no longer contains them. After each new
 * SWS snapshot, the picks that *dropped out* of a section since the prior
 * snapshot represent realised exits — the recommendation surface stopped
 * carrying them, so the track record should freeze their return at that
 * moment instead of pretending we still hold them forever.
 *
 * For each (type, symbol) in `previousOpenTrades` that's not in
 * `currentTickersByType`, mark the most recent open entry as closed at
 * `closeContext.snapshotAt` using the current section's price (or the live
 * Nifty price passed in).
 *
 * Returns the array of closing patches: `[{ id, closedAt, closingPrice, niftyAtClose }, ...]`.
 * Persistence is the caller's responsibility — the storage adapters don't
 * yet support partial updates, so we attach a special `__close__: true`
 * envelope and the storage layer treats it as an update on `id` match.
 */
export function computeTradeClosures(allTrades, currentTickersByType, closeContext) {
  if (!Array.isArray(allTrades) || !currentTickersByType) return [];
  const closeAt = closeContext.closedAt || new Date().toISOString();
  const closeAtMs = new Date(closeAt).getTime();
  const niftyAtClose = closeContext.niftyAtClose ?? null;
  // Group open trades by (type, symbol). Only consider trades that were
  // *already open* at closeAt — a snapshot can never retroactively close a
  // trade that was created by a later snapshot (matters for the git-history
  // backfill, which replays revisions out of wall-clock order vs storage).
  const openByKey = new Map();
  for (const t of allTrades) {
    if (t.closedAt) continue;
    if (t.snapshotAt && new Date(t.snapshotAt).getTime() > closeAtMs) continue;
    const key = `${t.type}|${t.symbol}`;
    const arr = openByKey.get(key) || [];
    arr.push(t);
    openByKey.set(key, arr);
  }
  const closures = [];
  for (const [key, trades] of openByKey) {
    const [type, symbol] = key.split("|");
    // Only close trades for types we just snapshotted
    const stillIn = currentTickersByType[type];
    if (!stillIn) continue;
    if (stillIn.has(symbol)) continue; // still in section → still open
    // Use the close price from the context map if available, else fall back
    // to the trade's snapshot price (the entry was never re-priced — better
    // than no exit at all).
    const closingPrice = (closeContext.priceBySymbol || {})[symbol] ?? null;
    if (closingPrice == null) continue; // cannot close without a price
    // Close every still-open entry for this (type, symbol) — usually one
    for (const t of trades) {
      closures.push({
        id: t.id,
        closedAt: closeAt,
        closingPrice,
        niftyAtClose,
      });
    }
  }
  return closures;
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
