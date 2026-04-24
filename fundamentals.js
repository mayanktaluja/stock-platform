/**
 * Fundamental Value Engine
 *
 * Pure functions that:
 *   1. Load the daily NSE snapshot from either Vercel KV (production) or
 *      fundamentals.json on disk (local dev), auto-selected based on
 *      KV_REST_API_URL presence — same pattern as watchlistStorage.js
 *   2. Score each snapshot 0–100 across 9 dimensions in 5 pillars
 *      (Valuation, Quality, Health, Growth, Trend context)
 *   3. Categorise scored stocks into DEEP_VALUE / QUALITY_GROWTH / FAIR_VALUE /
 *      FULLY_VALUED / OVERVALUED buckets for the scanner UI
 *
 * Refresh pipeline:
 *   • Local dev:  run `node scripts/enrich-fundamentals.mjs` manually.
 *                 Writes to fundamentals.json on disk.
 *   • Production: Vercel cron at `/api/cron/enrich-fundamentals` (Sundays
 *                 pre-market, see vercel.json) calls enrichFundamentals.js
 *                 and writes the result to Vercel KV under key
 *                 `fundamentals:snapshot`. The in-memory cache is primed at
 *                 server startup via primeFundamentalsFromKV().
 */

import { readFileSync, existsSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FUNDAMENTALS_PATH = path.join(__dirname, "fundamentals.json");

// Vercel KV key for the persisted snapshot in production
export const KV_FUNDAMENTALS_KEY = "fundamentals:snapshot";

// SEBI RA Reg 25 (record-keeping) Phase 0: every score is stamped with a
// scorer version. When we ship the Snowflake V2 scorer alongside V1 (see
// the Transformation Plan), V2 will use "v2-*" here. Keeping the field
// present on V1 now means audit-trail consumers can rely on its existence
// without a forwards-compat fork later. Bump the last segment when scoring
// weights or guardrails change materially (e.g. a pillar weight rebalance).
// Current: V1 scorer, calibrated Apr 2026 with value-trap and growth
// guardrails. See scoreFundamentals() below for the full change history.
export const SCORER_VERSION = "v1.2-apr2026";

// ==================== SNAPSHOT LOADER ====================

// The in-memory cache is the single source of truth for all sync callers
// (getFundamentals / getAllFundamentals / scoreFundamentals). It can be
// populated by three paths:
//   1. Sync disk read in loadFundamentalsFromDisk() — local dev fallback
//   2. Async KV fetch in primeFundamentalsFromKV() — called at server boot
//   3. Async save in saveFundamentalsToKV() — called after cron enrichment
let _cachedSnapshot = null;
let _cachedMtime = 0;    // only meaningful for disk-sourced snapshots
let _cachedSource = null; // "disk" | "kv" — for diagnostics

/**
 * Lazy-import @vercel/kv. Returns the client or null if KV isn't configured.
 * We use this pattern (instead of a top-level import) so local dev doesn't
 * pull in the KV module when it isn't needed.
 */
async function getKVClient() {
  const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
  if (!hasKV) return null;
  const mod = await import("@vercel/kv");
  return mod.kv;
}

/**
 * Prime the in-memory cache from Vercel KV. Called once at server startup
 * from server.js; no-op in local dev (where KV env vars aren't set).
 *
 * Returns the snapshot on success, null on miss/error. Silent on failure
 * because disk fallback will kick in for any subsequent getFundamentals call.
 */
export async function primeFundamentalsFromKV() {
  try {
    const kv = await getKVClient();
    if (!kv) return null;
    const data = await kv.get(KV_FUNDAMENTALS_KEY);
    if (!data || !data.snapshots) return null;
    _cachedSnapshot = data;
    _cachedMtime = 0;
    _cachedSource = "kv";
    console.log(
      `[FUNDAMENTALS] primed from KV: ${Object.keys(data.snapshots).length} stocks, ` +
      `enrichedAt=${data.enrichedAt || "unknown"}`
    );
    return data;
  } catch (err) {
    console.warn("[FUNDAMENTALS] KV prime failed, will fall back to disk:", err.message);
    return null;
  }
}

/**
 * Persist an enriched snapshot back to Vercel KV and refresh the in-memory
 * cache. Called by the /api/cron/enrich-fundamentals endpoint after each
 * weekly refresh. No-op (returns false) if KV isn't configured.
 *
 * The cache update is CRITICAL — without it, the cron endpoint would write
 * to KV but the running function's own in-memory cache would still hold the
 * stale disk copy until the next cold start.
 */
export async function saveFundamentalsToKV(data) {
  try {
    const kv = await getKVClient();
    if (!kv) return false;
    await kv.set(KV_FUNDAMENTALS_KEY, data);
    _cachedSnapshot = data;
    _cachedMtime = 0;
    _cachedSource = "kv";
    console.log(
      `[FUNDAMENTALS] saved to KV: ${Object.keys(data.snapshots || {}).length} stocks, ` +
      `enrichedAt=${data.enrichedAt}`
    );
    return true;
  } catch (err) {
    console.error("[FUNDAMENTALS] KV save failed:", err.message);
    return false;
  }
}

/**
 * Load the fundamentals snapshot. Cache hierarchy:
 *   1. In-memory cache (populated by KV prime or a previous disk read)
 *   2. Disk (fundamentals.json) — local dev and Vercel fallback if KV empty
 *
 * Returns { snapshots, generatedAt, enrichedAt, ... } or null.
 *
 * This function is SYNC on purpose — it's called from inside the hot scoring
 * loop that iterates 112 stocks per scan, and we don't want to await inside
 * that loop. Async work (KV fetch) happens once at startup via
 * primeFundamentalsFromKV(), and then every call lands in the cache.
 */
export function loadFundamentalsFromDisk() {
  // If the cache was populated by KV (source = "kv"), trust it — the KV
  // snapshot is always newer than disk in production.
  if (_cachedSource === "kv" && _cachedSnapshot) return _cachedSnapshot;

  // Otherwise fall back to disk with the mtime-based refresh semantics.
  if (!existsSync(FUNDAMENTALS_PATH)) return _cachedSnapshot; // may be null

  const mtime = statSync(FUNDAMENTALS_PATH).mtimeMs;
  if (_cachedSnapshot && _cachedSource === "disk" && mtime === _cachedMtime) {
    return _cachedSnapshot;
  }

  try {
    const raw = readFileSync(FUNDAMENTALS_PATH, "utf-8");
    _cachedSnapshot = JSON.parse(raw);
    _cachedMtime = mtime;
    _cachedSource = "disk";
    return _cachedSnapshot;
  } catch (err) {
    console.error("Failed to load fundamentals.json:", err.message);
    return _cachedSnapshot; // return whatever we had, don't flash to null
  }
}

/**
 * Get fundamental snapshot for a single symbol.
 * Symbol should be in "SYMBOL.NS" format (matches stockList.js).
 */
export function getFundamentals(symbol) {
  const data = loadFundamentalsFromDisk();
  if (!data || !data.snapshots) return null;
  return data.snapshots[symbol] || null;
}

/**
 * Get ALL snapshots as a flat array. Used by the scanner endpoint.
 */
export function getAllFundamentals() {
  const data = loadFundamentalsFromDisk();
  if (!data || !data.snapshots) return [];
  return Object.values(data.snapshots);
}

export function getSnapshotGeneratedAt() {
  const data = loadFundamentalsFromDisk();
  return data?.generatedAt || null;
}

/**
 * Timestamp of the last successful quality-metric enrichment run (ROE, D/E,
 * profit margin, revenue growth). Distinct from `generatedAt` which tracks
 * the NSE price snapshot refresh.
 */
export function getSnapshotEnrichedAt() {
  const data = loadFundamentalsFromDisk();
  return data?.enrichedAt || null;
}

/**
 * Where the currently-cached snapshot came from. Useful for debug endpoints
 * and the status banner — returns "kv", "disk", or null if no snapshot.
 */
export function getSnapshotSource() {
  return _cachedSnapshot ? _cachedSource : null;
}

// ==================== TRUE SECTOR P/E BENCHMARK ====================

/**
 * NSE's `pdSectorPe` field is circular for heavyweight stocks — when one or
 * two giants dominate a sector index, NSE reports the same number as both the
 * stock P/E and the "sector P/E". We found this in 43/112 stocks during the
 * audit: RELIANCE, ICICIBANK, NTPC, KOTAKBANK, etc. all get pe == sectorPe.
 *
 * The fix: compute a TRUE sector median P/E from our own snapshot file. Group
 * all stocks by sector, take the median of positive P/E values, and cache the
 * result. Use median (not mean) so a single outlier (NYKAA P/E 504) doesn't
 * destroy the benchmark for the whole sector.
 *
 * Requires ≥4 stocks in the sector for the median to be meaningful. Sectors
 * with fewer stocks return null and the caller should skip the P/E dimension
 * entirely (rather than using an unreliable 1-stock "average").
 */
const MIN_SECTOR_SIZE = 4;
let _cachedSectorBenchmarks = null;
let _sectorBenchmarksMtime = 0;

export function getSectorPeBenchmarks() {
  const data = loadFundamentalsFromDisk();
  if (!data || !data.snapshots) return {};

  // Reuse cached result if the underlying file hasn't changed since last compute
  if (_cachedSectorBenchmarks && _sectorBenchmarksMtime === _cachedMtime) {
    return _cachedSectorBenchmarks;
  }

  // Group positive P/Es by sector
  const bySector = new Map();
  for (const snap of Object.values(data.snapshots)) {
    const sector = snap.sector;
    const pe = Number(snap.pe);
    if (!sector || !Number.isFinite(pe) || pe <= 0) continue;
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector).push(pe);
  }

  // Compute median + count + min/max per sector
  const benchmarks = {};
  for (const [sector, pes] of bySector) {
    if (pes.length < MIN_SECTOR_SIZE) continue;
    const sorted = [...pes].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
    benchmarks[sector] = {
      median: parseFloat(median.toFixed(2)),
      count: sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  }

  _cachedSectorBenchmarks = benchmarks;
  _sectorBenchmarksMtime = _cachedMtime;
  return benchmarks;
}

/**
 * Get the true sector P/E benchmark for a given sector, or null if the sector
 * has too few samples. Used by scoreFundamentals when NSE's sectorPe is
 * circular or missing.
 */
export function getSectorMedianPe(sector) {
  if (!sector) return null;
  const benchmarks = getSectorPeBenchmarks();
  return benchmarks[sector]?.median ?? null;
}

// ==================== SCORING ====================

/**
 * Score a snapshot 0–100. Higher = more attractive value play.
 *
 * @param {object} snap       - snapshot from loadFundamentalsFromDisk
 * @param {number} [dma200]   - 200-day moving average from historical data (optional)
 * @returns {{
 *   score: number,
 *   verdict: string,
 *   breakdown: object,
 *   reasoning: string
 * }}
 */
export function scoreFundamentals(snap, dma200 = null) {
  if (!snap) return null;

  const pe = snap.pe;
  const nseSectorPe = snap.sectorPe;
  const price = snap.price;
  const week52High = snap.week52High;
  const week52Low = snap.week52Low;
  const marketCap = snap.marketCap;

  let score = 50; // neutral base
  const breakdown = {};
  const reasons = [];
  const warnings = [];

  // ─── Dimension 1: P/E vs Sector P/E (weight +10 / -12) ───
  // REBALANCED (Apr 2026): was ±22. The old weight made valuation the single
  // biggest driver of the score — 58% of the positive delta budget came from
  // the three valuation dimensions alone, with Quality/Health/Growth combined
  // at only 32%. That's a classic value-trap generator: the scorer was blind
  // to ROE, leverage, and growth on stocks where those fields are now always
  // populated (post Yahoo enrichment).
  //
  // The pillar rebalance targets: Valuation 35%, Quality 27%, Health 14%,
  // Growth 15%, Trend-context 8%. P/E vs Sector is the heaviest valuation
  // signal within the new 35% budget, so it gets the largest share (±12), but
  // it no longer dwarfs the quality side.
  //
  // NSE's `pdSectorPe` is broken for heavyweight stocks: when one or two
  // giants dominate a sector, NSE computes the sector P/E from those same
  // giants, so we get `pe == sectorPe` for stocks like HDFCBANK, DMART, ABB,
  // SIEMENS, etc. (we found this in 43/112 stocks during the accuracy audit).
  //
  // When NSE's value is circular, we fall back to a TRUE sector median P/E
  // computed from our own snapshot file (see getSectorPeBenchmarks above).
  // This unblocks fundamental scoring on 38% of the Nifty 100 — the largest
  // stocks in the market.
  const nseSectorPeIsCircular =
    pe != null && nseSectorPe != null && pe > 0 && nseSectorPe > 0 &&
    Math.abs(pe - nseSectorPe) / nseSectorPe < 0.01;

  // Decide which sector P/E to use. Priority:
  //   1. NSE's sectorPe if it's present, positive, and NOT circular
  //   2. Our computed median from the snapshot file (for heavyweights or missing)
  let sectorPe = null;
  let sectorPeSource = null;
  if (nseSectorPe && nseSectorPe > 0 && !nseSectorPeIsCircular) {
    sectorPe = nseSectorPe;
    sectorPeSource = "nse";
  } else {
    const computedMedian = getSectorMedianPe(snap.sector);
    if (computedMedian && computedMedian > 0) {
      sectorPe = computedMedian;
      sectorPeSource = "computed_median";
    }
  }

  if (pe && sectorPe && pe > 0 && sectorPe > 0) {
    const ratio = pe / sectorPe;
    let peVsSector = 0;
    // Widened bands (was ±17, now ±22) so strong signals move the score
    // meaningfully. Also added stricter thresholds at the extremes.
    // Bands widened from the original 0.95-1.10 neutral zone to 0.85-1.15
    // so "slightly expensive" stocks get mild feedback (-3) instead of
    // jumping straight from 0 to -6 at the old boundary. The gradient is now:
    //   deep discount → moderate discount → slight discount → neutral → slight premium → premium → ...
    if (ratio <= 0.4)        { peVsSector = 12; reasons.push(`P/E ${pe.toFixed(1)} is a steep discount to sector P/E ${sectorPe.toFixed(1)} (${((1-ratio)*100).toFixed(0)}% below)`); }
    else if (ratio <= 0.6)   { peVsSector = 8; reasons.push(`P/E ${pe.toFixed(1)} is well below sector P/E ${sectorPe.toFixed(1)}`); }
    else if (ratio <= 0.8)   { peVsSector = 4; reasons.push(`P/E ${pe.toFixed(1)} is below sector P/E ${sectorPe.toFixed(1)}`); }
    else if (ratio <= 0.85)  { peVsSector = 2; }
    else if (ratio <= 1.15)  { peVsSector = 0; }
    else if (ratio <= 1.3)   { peVsSector = -2; reasons.push(`P/E ${pe.toFixed(1)} is slightly above sector P/E ${sectorPe.toFixed(1)}`); }
    else if (ratio <= 1.6)   { peVsSector = -4; reasons.push(`P/E ${pe.toFixed(1)} is notably above sector P/E ${sectorPe.toFixed(1)}`); }
    else if (ratio <= 2.0)   { peVsSector = -7; reasons.push(`P/E ${pe.toFixed(1)} is significantly stretched vs sector P/E ${sectorPe.toFixed(1)}`); }
    else if (ratio <= 3.0)   { peVsSector = -10; reasons.push(`P/E ${pe.toFixed(1)} is extremely stretched vs sector P/E ${sectorPe.toFixed(1)}`); }
    else                     { peVsSector = -12; reasons.push(`P/E ${pe.toFixed(1)} is extreme hype territory vs sector P/E ${sectorPe.toFixed(1)}`); }
    score += peVsSector;
    breakdown.peVsSector = peVsSector;
    breakdown.peRatio = ratio;
    breakdown.sectorPeSource = sectorPeSource;
    breakdown.sectorPeUsed = sectorPe;
    // Footnote the source of the comparison so the UI can explain WHY a
    // heavyweight like RELIANCE now gets a meaningful P/E comparison.
    if (sectorPeSource === "computed_median") {
      reasons.push(`Sector P/E ${sectorPe.toFixed(1)} is the median of ${snap.sector || 'sector'} peers (NSE's reported sector P/E was circular for this heavyweight)`);
    }
  } else if (nseSectorPeIsCircular && !sectorPe) {
    breakdown.peVsSector = 0;
    breakdown.sectorPeAvailable = false;
    warnings.push("Sector P/E benchmark unavailable (dominant stock + too few peers in snapshot to compute a median)");
  } else if (pe === null || pe <= 0) {
    breakdown.peVsSector = 0;
    breakdown.peQuality = "earnings_unclear";
    reasons.push("Loss-making or no P/E data — cannot value on earnings");
  }

  // ─── Dimension 2: Absolute P/E (weight +5 / -12) ───
  // REBALANCED (Apr 2026): was +10/-18. The asymmetric penalty is preserved
  // (expensive stocks still get hurt more than cheap stocks get rewarded) but
  // scaled down so valuation-only signals can't dominate the pillar budget.
  // Combined with the P/E-vs-sector +10/-12, the two P/E dimensions now cap
  // at +15/-24 on the 0-100 scale — still plenty of range to identify hype.
  if (pe && pe > 0) {
    let absolutePe = 0;
    if (pe <= 8)        { absolutePe = 5; reasons.push("P/E below 8 suggests strong value"); }
    else if (pe <= 12)  { absolutePe = 3; }
    else if (pe <= 18)  { absolutePe = 2; }
    else if (pe <= 25)  { absolutePe = 1; }
    else if (pe <= 35)  { absolutePe = -2; }
    else if (pe <= 50)  { absolutePe = -5;  reasons.push("P/E above 35 is expensive"); }
    else if (pe <= 75)  { absolutePe = -8;  reasons.push("P/E above 50 is very expensive"); }
    else if (pe <= 120) { absolutePe = -10; reasons.push("P/E above 75 is extreme — high re-rating risk"); }
    else                { absolutePe = -12; reasons.push(`P/E ${pe.toFixed(0)} is pure hype territory`); }
    score += absolutePe;
    breakdown.absolutePe = absolutePe;
  }

  // ─── Dimension 3: 52-Week Position (weight +6 / -6) ───
  // REBALANCED (Apr 2026): was ±12. 52W position is price-action not fundamentals,
  // so it's the weakest contributor to the Valuation pillar. Bands preserved,
  // magnitudes halved.
  if (price && week52High && week52Low && week52High > week52Low) {
    const pos = (price - week52Low) / (week52High - week52Low);
    let position52w = 0;
    if (pos <= 0.15)      { position52w = 6; reasons.push(`Trading near 52W low (${(pos*100).toFixed(0)}% of range)`); }
    else if (pos <= 0.3)  { position52w = 4; reasons.push(`In lower quartile (${(pos*100).toFixed(0)}% of 52W range)`); }
    else if (pos <= 0.5)  { position52w = 2; }
    else if (pos <= 0.7)  { position52w = 0; }
    else if (pos <= 0.85) { position52w = -2; reasons.push(`Trading in upper range (${(pos*100).toFixed(0)}% of 52W range)`); }
    else if (pos <= 0.95) { position52w = -4; reasons.push(`Near 52W high (${(pos*100).toFixed(0)}%)`); }
    else                  { position52w = -6; reasons.push(`At 52W high — euphoria territory (${(pos*100).toFixed(0)}%)`); }
    score += position52w;
    breakdown.position52w = position52w;
    breakdown.positionPct = pos;
  }

  // ─── Dimension 4: Price vs 200-day MA (weight +5 / -6) ───
  // REBALANCED (Apr 2026): was ±8. This is trend-context, not fundamentals —
  // the 8% slice of the Trend-context pillar.
  if (price && dma200) {
    const ratio = price / dma200;
    let vs200DMA = 0;
    if (ratio < 0.85)      { vs200DMA = 5; reasons.push("Trading 15%+ below 200DMA — deep value zone"); }
    else if (ratio < 0.95) { vs200DMA = 3; reasons.push("Below 200DMA"); }
    else if (ratio < 1.05) { vs200DMA = 1; }
    else if (ratio < 1.15) { vs200DMA = 0; }
    else if (ratio < 1.3)  { vs200DMA = -2; reasons.push("Extended 15-30% above 200DMA"); }
    else if (ratio < 1.5)  { vs200DMA = -4; reasons.push("Very extended, 30-50% above 200DMA"); }
    else                   { vs200DMA = -6; reasons.push("Dangerously extended, 50%+ above 200DMA"); }
    score += vs200DMA;
    breakdown.vs200DMA = vs200DMA;
    breakdown.price200DMARatio = ratio;
  }

  // ─── Dimension 5: Market Cap Tier (risk flag, not value bonus) ───
  //
  // Audit found the old version was actively offsetting the absolute P/E
  // penalty: DMART with P/E 99.4 was getting +5 for being a large cap, which
  // cancelled most of its -12 absolute P/E penalty. A large-cap doesn't mean
  // it's cheap — it just means it's liquid. So now:
  //   • Large/Mid cap      → 0 points (neutral, no free bonus)
  //   • Small cap          → 0 points
  //   • Micro cap          → -5 points (liquidity/execution risk flag)
  if (marketCap) {
    const marketCapCr = marketCap / 10000000;
    let tier = 0;
    if (marketCapCr >= 50000)      { tier = 0; breakdown.tier = "Large Cap"; }
    else if (marketCapCr >= 10000) { tier = 0; breakdown.tier = "Mid Cap"; }
    else if (marketCapCr >= 2000)  { tier = 0; breakdown.tier = "Small Cap"; }
    else                           { tier = -5; breakdown.tier = "Micro Cap"; reasons.push("Micro cap — higher liquidity and execution risk"); }
    score += tier;
    breakdown.marketCapTier = tier;
    breakdown.marketCapCr = marketCapCr;
  }

  // ─── Dimension 6: Return on Equity (weight +10 / -12) ───
  //
  // REBALANCED (Apr 2026): was ±8. ROE is now FULLY POPULATED across all 112
  // stocks (100% coverage post Yahoo enrichment) and is the flagship metric of
  // the Quality pillar. This is what separates "cheap and broken" (low P/E +
  // low ROE = value trap) from "cheap and undervalued" (low P/E + high ROE =
  // genuine opportunity). The weight increase reflects that.
  //
  // ROE measures how efficiently the company uses shareholder equity to
  // generate profit. Sourced from Yahoo's financialData.returnOnEquity when
  // present, or derived from trailingEps / bookValue otherwise.
  const roe = snap.roe != null ? Number(snap.roe) : null;
  if (roe != null && Number.isFinite(roe)) {
    let roeScore = 0;
    if (roe >= 0.20)      { roeScore = 10; reasons.push(`ROE ${(roe * 100).toFixed(1)}% — excellent capital efficiency`); }
    else if (roe >= 0.15) { roeScore = 7; reasons.push(`ROE ${(roe * 100).toFixed(1)}% — strong`); }
    else if (roe >= 0.10) { roeScore = 4; }
    else if (roe >= 0.05) { roeScore = -2; }
    else if (roe >= 0)    { roeScore = -7; reasons.push(`ROE ${(roe * 100).toFixed(1)}% — weak capital efficiency`); }
    else                  { roeScore = -12; reasons.push(`Negative ROE — company destroying shareholder value`); }
    score += roeScore;
    breakdown.roe = roeScore;
    breakdown.roeValue = roe;
  }

  // ─── Dimension 7: Debt-to-Equity (weight +8 / -10) ───
  //
  // REBALANCED (Apr 2026): was +5/-8. Debt/Equity is the single Financial
  // Health pillar and gets the full 14% slice. High leverage amplifies both
  // gains and losses; companies with D/E > 2 are risky in rising rate
  // environments, D/E < 0.5 is typically healthy. ~86% coverage (banks/NBFCs
  // skip because D/E is meaningless for financial institutions — scorer
  // handles null gracefully).
  const debtToEquity = snap.debtToEquity != null ? Number(snap.debtToEquity) : null;
  if (debtToEquity != null && Number.isFinite(debtToEquity)) {
    let deScore = 0;
    if (debtToEquity <= 0.1)      { deScore = 8; reasons.push("Nearly debt-free"); }
    else if (debtToEquity <= 0.5) { deScore = 5; }
    else if (debtToEquity <= 1.0) { deScore = 0; }
    else if (debtToEquity <= 2.0) { deScore = -5; reasons.push(`D/E ${debtToEquity.toFixed(1)} — moderately leveraged`); }
    else                          { deScore = -10; reasons.push(`D/E ${debtToEquity.toFixed(1)} — highly leveraged`); }
    score += deScore;
    breakdown.debtToEquity = deScore;
    breakdown.debtToEquityValue = debtToEquity;
  }

  // ─── Dimension 8: Profit Margin (weight +6 / -6) ───
  //
  // REBALANCED (Apr 2026): was ±5. Profit margin complements ROE as the second
  // dimension of the Quality pillar. Net margins reveal pricing power and
  // operational efficiency independent of capital structure — two companies
  // with identical ROE can have very different margin profiles, and margin
  // compression is an early warning of competitive erosion. 100% coverage.
  const profitMargin = snap.profitMargin != null ? Number(snap.profitMargin) : null;
  if (profitMargin != null && Number.isFinite(profitMargin)) {
    let pmScore = 0;
    if (profitMargin >= 0.20)      { pmScore = 6; reasons.push(`Net margin ${(profitMargin * 100).toFixed(1)}% — strong pricing power`); }
    else if (profitMargin >= 0.10) { pmScore = 4; }
    else if (profitMargin >= 0.05) { pmScore = 1; }
    else if (profitMargin >= 0)    { pmScore = -3; reasons.push("Thin margins — vulnerable to cost inflation"); }
    else                           { pmScore = -6; reasons.push("Negative margins — loss-making operations"); }
    score += pmScore;
    breakdown.profitMargin = pmScore;
    breakdown.profitMarginValue = profitMargin;
  }

  // ─── Dimension 9: Revenue Growth YoY (weight +9 / -6) ───
  //
  // REBALANCED (Apr 2026): was +6/-4. Revenue growth is the single Growth
  // pillar and gets the full 15% slice. Asymmetric — reward top-line expansion
  // more than we punish mild decline (cyclical businesses contract, then
  // recover). 99% coverage.
  const revGrowth = snap.revenueGrowthYoY != null ? Number(snap.revenueGrowthYoY) : null;
  if (revGrowth != null && Number.isFinite(revGrowth)) {
    let rgScore = 0;
    if (revGrowth >= 0.25)      { rgScore = 9; reasons.push(`Revenue growing ${(revGrowth * 100).toFixed(0)}% YoY — strong growth`); }
    else if (revGrowth >= 0.15) { rgScore = 6; reasons.push(`Revenue growing ${(revGrowth * 100).toFixed(0)}% YoY`); }
    else if (revGrowth >= 0.05) { rgScore = 2; }
    else if (revGrowth >= 0)    { rgScore = 0; }
    else if (revGrowth >= -0.1) { rgScore = -3; }
    else                        { rgScore = -6; reasons.push(`Revenue declining ${(revGrowth * 100).toFixed(0)}% YoY — deteriorating business`); }
    score += rgScore;
    breakdown.revenueGrowth = rgScore;
    breakdown.revenueGrowthValue = revGrowth;
  }

  // Clamp
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Verdict bands — widened so the full 0-100 range gets used.
  //
  // Audit found that even after recalibrating the dimension weights, no stock
  // hit the <30 OVERVALUED threshold because the floor was 31 (Titan, ABB).
  // New thresholds push OVERVALUED up to ≤40, which captures stocks like
  // NYKAA/DMART/TITAN/SIEMENS that are genuinely priced for perfection.
  // Verdict thresholds. QG floor raised 58 → 62 in Week 2 (Apr 2026) after
  // backtests showed the 58-61 band was catching mediocre compounders that
  // systematically underperformed. The old 58 floor made QG the weakest
  // category in every horizon (QG Top 1 @ 1yr = -63% XIRR). Lifting to 62
  // tightens the universe to stocks whose quality/valuation blend genuinely
  // distinguishes them from FAIR_VALUE.
  let verdict;
  if (score >= 72)      verdict = "DEEP_VALUE";
  else if (score >= 62) verdict = "QUALITY_GROWTH";
  else if (score >= 48) verdict = "FAIR_VALUE";
  else if (score >= 40) verdict = "FULLY_VALUED";
  else                  verdict = "OVERVALUED";

  // ─── QUALITY GUARDRAIL (hardened Week 2, Apr 2026) ───
  //
  // Value trap defense. A stock cannot wear the DEEP_VALUE or QUALITY_GROWTH
  // label if its quality fundamentals are flashing red. A classic value trap
  // is "cheap P/E + deteriorating business" — the scorer loads up on cheap-
  // valuation points (up to +21 across the Valuation pillar) while the
  // Quality pillar silently gives negative contributions, and the stock still
  // crosses the QG threshold.
  //
  // Original (Phase 3) rule demanded only that ROE and D/E dimensions have
  // non-negative score contributions. That admitted stocks with ROE 6% and
  // D/E 0.9 which are muddy-middle picks, not "quality growth". Empirically
  // these were the bulk of QG's -20-60% XIRR drag.
  //
  // Week 2 rule: DEEP_VALUE and QUALITY_GROWTH now require BOTH:
  //   1. Quality: ROE >= 10% when ROE is reported (banks typically null — skip)
  //   2. Health:  D/E <= 1.0 when D/E is reported (banks null — skip)
  //   3. Growth gate (QG only): revenue growing >= 8% OR ROE >= 15%
  //      (a stock can be QG if it's shrinking a bit but ROE is excellent, or
  //       if ROE is merely decent but growth is strong)
  //
  // SEBI RA Regulation 15(2) compliance: labeling a stock "QUALITY GROWTH"
  // when the underlying growth/quality signals don't justify it is
  // misleading. The guardrail aligns the label with the signal.
  const roeValue = breakdown.roeValue;
  const deValue = breakdown.debtToEquityValue;
  const revGrowthValue = breakdown.revenueGrowthValue;

  const qualityFails = roeValue != null && roeValue < 0.10;  // ROE below 10%
  const healthFails  = deValue != null  && deValue > 1.0;    // D/E above 1.0

  // Growth gate applies to QG only — DV is a valuation play where growth can
  // legitimately be negative (turnaround story).
  const growthFails = verdict === "QUALITY_GROWTH" && (
    (revGrowthValue != null && revGrowthValue < 0.08) &&
    (roeValue == null || roeValue < 0.15)
  );

  if ((verdict === "DEEP_VALUE" || verdict === "QUALITY_GROWTH") &&
      (qualityFails || healthFails || growthFails)) {
    const originalVerdict = verdict;
    verdict = "FAIR_VALUE";
    breakdown.qualityGuardrailApplied = true;
    breakdown.qualityGuardrailReason = [
      qualityFails ? `ROE ${roeValue != null ? (roeValue * 100).toFixed(1) + '%' : 'n/a'} below 10% threshold` : null,
      healthFails  ? `D/E ${deValue != null ? deValue.toFixed(2) : 'n/a'} above 1.0x threshold` : null,
      growthFails  ? `revenue growth ${revGrowthValue != null ? (revGrowthValue * 100).toFixed(0) + '%' : 'n/a'} below 8% without ROE ≥ 15%` : null,
    ].filter(Boolean).join(" + ");
    warnings.push(
      `Downgraded from ${originalVerdict.replace("_", " ")} to FAIR VALUE — ${breakdown.qualityGuardrailReason}`
    );
  }

  // Reasoning combines positive/negative reasons with any data-quality warnings.
  // Warnings (like "sector P/E benchmark unavailable") need to be visible so the
  // user knows the comparison was skipped rather than passing.
  //
  // A stock can legitimately have no strongly-worded reasons if it lands in the
  // neutral bands for every dimension — that doesn't mean "insufficient data",
  // it means the stock is fairly valued and nothing stands out. Only show the
  // "insufficient data" message when we literally had no inputs (no P/E, no
  // price, no market cap, etc.) to score against.
  const hasAnyScoredDimension =
    Object.keys(breakdown).some((k) => k !== "peQuality" && k !== "sectorPeAvailable" && typeof breakdown[k] === "number");

  let reasonText;
  if (reasons.length > 0) reasonText = reasons.join(". ") + ".";
  else if (hasAnyScoredDimension) reasonText = "Lands in the neutral range for every fundamental dimension — fairly valued, nothing stands out.";
  else reasonText = "Insufficient fundamental data.";

  const reasoning = [
    reasonText,
    warnings.length > 0 ? "⚠ " + warnings.join(". ") + "." : null,
  ].filter(Boolean).join(" ");

  return {
    score,
    verdict,
    breakdown,
    reasoning,
    warnings,
    // SEBI RA Reg 25 audit fields. `scoredAt` is the wall-clock moment this
    // verdict was computed; `scorerVersion` identifies which scoring ruleset
    // produced it. Together with the `snapshot` block below (which captures
    // the inputs actually used) these three fields make any verdict fully
    // reproducible after the fact — the minimum bar for a defensible
    // analytical output under the Research Analyst regulations.
    scoredAt: new Date().toISOString(),
    scorerVersion: SCORER_VERSION,
    snapshot: {
      symbol: snap.symbol,
      name: snap.name,
      sector: snap.sector,
      industry: snap.industry,
      price: snap.price,
      pe: snap.pe,
      // sectorPe is the value actually USED in scoring — either NSE's value
      // when it was valid, or our computed sector median when NSE was circular.
      // This matters for the UI because the frontend's P/E-vs-sector delta
      // should reflect whichever benchmark was actually applied.
      sectorPe: breakdown.sectorPeUsed ?? snap.sectorPe,
      sectorPeSource: breakdown.sectorPeSource ?? "nse",
      nseSectorPe: snap.sectorPe, // raw NSE value for debugging
      week52High: snap.week52High,
      week52Low: snap.week52Low,
      marketCap: snap.marketCap,
      marketCapCr: snap.marketCap ? snap.marketCap / 10000000 : null,
    },
  };
}

/**
 * Categorise a batch of scored stocks into the 5 buckets for the scanner UI.
 * Each bucket is sorted by score and sliced to `limit` entries.
 */
export function categoriseBatch(scoredStocks, limit = 10) {
  const deepValue     = [];
  const qualityGrowth = [];
  const fairValue     = [];
  const fullyValued   = [];
  const overvalued    = [];

  for (const scored of scoredStocks) {
    if (!scored) continue;
    if (scored.verdict === "DEEP_VALUE")          deepValue.push(scored);
    else if (scored.verdict === "QUALITY_GROWTH") qualityGrowth.push(scored);
    else if (scored.verdict === "FAIR_VALUE")     fairValue.push(scored);
    else if (scored.verdict === "FULLY_VALUED")   fullyValued.push(scored);
    else if (scored.verdict === "OVERVALUED")     overvalued.push(scored);
  }

  return {
    deepValue:     deepValue.sort((a, b) => b.score - a.score).slice(0, limit),
    qualityGrowth: qualityGrowth.sort((a, b) => b.score - a.score).slice(0, limit),
    fairValue:     fairValue.sort((a, b) => b.score - a.score).slice(0, limit),
    fullyValued:   fullyValued.sort((a, b) => a.score - b.score).slice(0, limit),
    overvalued:    overvalued.sort((a, b) => a.score - b.score).slice(0, limit),
  };
}
