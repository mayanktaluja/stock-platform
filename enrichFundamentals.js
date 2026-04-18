/**
 * Fundamentals Enrichment Module
 *
 * Reusable core for the fundamentals enrichment pipeline. Used by both:
 *   1. scripts/enrich-fundamentals.mjs — the CLI entrypoint for local dev
 *      (reads/writes fundamentals.json on disk)
 *   2. /api/cron/enrich-fundamentals — the Vercel cron endpoint that runs
 *      every Sunday pre-market and writes the enriched snapshot to Vercel KV
 *
 * The critical constraint: Vercel cron functions have a 60-second max duration.
 * 112 stocks × 250ms serial = 28s, plus network + Yahoo auth = ~40s. This
 * module runs calls in batches of 4 parallel requests to bring the wall-clock
 * time down to ~15s, with comfortable margin inside the 60s ceiling.
 *
 * Data source: Yahoo Finance via the `yahoo-finance2` package.
 *
 * Why Yahoo and not NSE?
 *   NSE's quote-equity endpoint does NOT expose ROE, profit margin, or YoY
 *   revenue growth — only P/E, prices, market cap, 52W hi/lo. Yahoo Finance
 *   mirrors NSE prices and also publishes the full financialData block for
 *   Indian equities via the `.NS` suffix. `yahoo-finance2` handles the
 *   cookie/crumb dance, retries, and schema drift automatically.
 */

import YahooFinance from "yahoo-finance2";

// Shared Yahoo client. Constructed lazily on first use because the library's
// constructor hits the auth endpoint eagerly in some code paths.
let _yf = null;
function getYahooClient() {
  if (!_yf) {
    _yf = new YahooFinance({
      suppressNotices: ["yahooSurvey", "ripHistorical"],
    });
  }
  return _yf;
}

/**
 * Fetch financial metrics for one NSE symbol via Yahoo.
 *
 * IMPORTANT — D/E unit conversion:
 *   Yahoo reports `debtToEquity` as a PERCENT-like number, not a ratio.
 *   TCS comes back as 10.389 (≈10.4% → ratio 0.104), RELIANCE as 35.651
 *   (≈35.7% → ratio 0.357). The scorer in fundamentals.js expects RATIO form
 *   (0.5 = healthy, >2 = highly leveraged), so we divide by 100 here. If this
 *   is skipped, every stock lands in the "highly leveraged" bucket and
 *   silently poisons the quality score.
 *
 *   profitMargin, revenueGrowth, and returnOnEquity ARE already in ratio form
 *   (0.08 = 8%), so we pass those through unchanged.
 *
 * ROE fallback:
 *   Yahoo populates `financialData.returnOnEquity` for only ~25% of NSE
 *   tickers. For the other ~75% we derive ROE from
 *     ROE ≈ trailingEps / bookValuePerShare
 *   which are both in defaultKeyStatistics and almost universally populated.
 *   Matches RELIANCE ≈ 9.5%, SBIN ≈ 16% — agrees with Screener.in values.
 */
export async function fetchMetrics(symbol) {
  const yf = getYahooClient();
  const q = await yf.quoteSummary(symbol, {
    modules: ["financialData", "defaultKeyStatistics"],
  });
  const fd = q?.financialData || {};
  const ks = q?.defaultKeyStatistics || {};

  const num = (v) => (Number.isFinite(v) ? v : null);
  const deRaw = num(fd.debtToEquity);

  let roe = num(fd.returnOnEquity);
  if (roe == null) {
    const eps = num(ks.trailingEps);
    const bv = num(ks.bookValue);
    if (eps != null && bv != null && bv > 0) {
      roe = eps / bv;
    }
  }

  return {
    roe,
    debtToEquity: deRaw != null ? deRaw / 100 : null, // pct → ratio
    profitMargin: num(fd.profitMargins),
    revenueGrowthYoY: num(fd.revenueGrowth),
  };
}

/**
 * Enrich an entire snapshot object (in-place) with Yahoo financial metrics.
 *
 * @param {object} snapshot           The fundamentals.json structure
 *                                    { snapshots, generatedAt, ... }
 * @param {object} options
 * @param {number} [options.concurrency=4]
 *        Parallel request fan-out. 4 is a safe default for Yahoo (they don't
 *        rate-limit aggressively at this level). Bump to 6 if you need to
 *        squeeze more speed out of the Vercel cron window.
 * @param {function} [options.onProgress]
 *        Optional callback invoked after each symbol completes.
 *        Receives { index, total, symbol, metrics, error }.
 * @returns {Promise<{ enriched: number, skipped: number, failed: number, durationMs: number }>}
 */
export async function enrichSnapshot(snapshot, options = {}) {
  const { concurrency = 4, onProgress } = options;
  const symbols = Object.keys(snapshot.snapshots || {});
  if (symbols.length === 0) {
    return { enriched: 0, skipped: 0, failed: 0, durationMs: 0 };
  }

  const started = Date.now();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  // Worker pool: each worker picks the next symbol off a shared cursor. This
  // keeps `concurrency` requests in flight at all times without pre-batching
  // into fixed groups, which wastes time at batch boundaries when one stock
  // is slower than its peers.
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= symbols.length) return;
      const sym = symbols[i];
      try {
        const metrics = await fetchMetrics(sym);
        const hasAny = Object.values(metrics).some((v) => v != null);
        if (hasAny) {
          Object.assign(snapshot.snapshots[sym], metrics);
          enriched++;
        } else {
          skipped++;
        }
        if (onProgress) onProgress({ index: i + 1, total: symbols.length, symbol: sym, metrics });
      } catch (err) {
        failed++;
        if (onProgress) onProgress({ index: i + 1, total: symbols.length, symbol: sym, error: err });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  snapshot.enrichedAt = new Date().toISOString();
  snapshot.enrichmentSource = "yahoo-finance2";

  return {
    enriched,
    skipped,
    failed,
    durationMs: Date.now() - started,
  };
}
