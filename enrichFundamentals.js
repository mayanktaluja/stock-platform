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

/**
 * Canonical list of field names produced by fetchMetrics().
 *
 * Exported so that scripts/refresh-fundamentals.mjs (the NSE re-scraper) can
 * preserve these fields when it rebuilds a snapshot record from fresh NSE
 * data. Without this, a routine NSE refresh would silently wipe the Yahoo
 * enrichment for every stock until the next weekly enrich cron ran.
 *
 * Add new fields here AND in the return of fetchMetrics — they must stay in
 * sync. A unit test in Phase 2 will assert that.
 */
export const ENRICHED_FIELDS = Object.freeze([
  // V1 (live in production scorer)
  "roe",
  "debtToEquity",
  "profitMargin",
  "revenueGrowthYoY",
  // Phase 1.1 — Future pillar
  "forwardEps",
  "trailingEps",
  "pegRatio",
  "earningsGrowthYoY",
  "forwardEpsGrowth",
  "analystCoverage",
  // Phase 1.1 — Value supplements
  "priceToBook",
  "enterpriseToEbitda",
  // Phase 1.1 — Dividend pillar
  "dividendYield",
  "payoutRatio",
  "fiveYearAvgDivYield",
  // Phase 1.1 — Health/Quality supplements (from quoteSummary)
  "ebitda",
  "totalDebt",
  "totalCash",
  "operatingMargins",
  "grossMargins",
  // Phase 1.2 — Health pillar core (from fundamentalsTimeSeries)
  "currentRatio",
  "interestCoverage",
  "ocfToNetIncome",
  "freeCashFlow",
  "reportingPeriodEnd",
]);

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
 *
 * ───────────────────────────────────────────────────────────────────────
 * Phase 1 (Apr 2026) extension — Simply Wall St-style pillar inputs.
 * ───────────────────────────────────────────────────────────────────────
 *
 * Added fields for the V2 "Snowflake" scorer. All optional — V1 scorer
 * ignores them and is unaffected. Fields marked (thin) have <50% coverage
 * for NSE smallcaps; consumers must tolerate null.
 *
 *   Future pillar:
 *     forwardEps              (thin)   — analyst consensus for next FY
 *     pegRatio                (thin)   — PEG as published by Yahoo
 *     earningsGrowthYoY                — latest reported earnings growth
 *     forwardEpsGrowth        (thin)   — derived: (fEPS − tEPS) / tEPS
 *     analystCoverage                  — number of analysts — an honesty flag
 *                                        for trusting the forward fields
 *
 *   Value pillar (supplementary to existing P/E):
 *     priceToBook                      — useful for banks/financials
 *     enterpriseToEbitda               — EV/EBITDA (thin in SMID)
 *
 *   Dividend pillar:
 *     dividendYield                    — ratio form (0.025 = 2.5%)
 *     payoutRatio                      — div / net income
 *     fiveYearAvgDivYield              — 5y avg, contextualises current yield
 *
 *   Health pillar supplements (from quoteSummary):
 *     ebitda                           — raw, for EV/EBITDA + coverage calc
 *     totalDebt                        — absolute debt for tier-adaptive scoring
 *     totalCash                        — net-debt computation
 *     operatingMargins                 — separates OPEX efficiency from gross
 *     grossMargins                     — pricing-power signal
 *
 *   Health pillar (from fundamentalsTimeSeries — Phase 1.2):
 *     currentRatio                     — currentAssets / currentLiabilities
 *                                        (null for banks — they don't report
 *                                        this line; Phase 2 handles sector-
 *                                        specific substitutes like CASA ratio)
 *     interestCoverage                 — EBIT / |interestExpense|. Useless
 *                                        for banks (intExp IS the business)
 *                                        so scorer must skip for sector=BFSI.
 *     ocfToNetIncome                   — OCF / net income. A value <0.7 for
 *                                        several years is the classic
 *                                        accounting-quality red flag
 *                                        (earnings up, cash not following).
 *     freeCashFlow                     — raw FCF, useful for DCF in Phase 2
 *
 *   Why two Yahoo calls instead of one:
 *     quoteSummary was gutted for balanceSheetHistory/cashflowStatementHistory
 *     in Nov 2024 — yahoo-finance2 itself warns us to use fundamentalsTimeSeries.
 *     That's a separate endpoint with its own ~500ms round-trip. Measured:
 *     112 stocks × (250ms summary + 500ms timeSeries) / concurrency 4 ≈ 21s,
 *     well inside the 60s cron budget with headroom.
 *
 *   Graceful degradation:
 *     If the timeSeries call fails for one symbol (rate limit, schema drift),
 *     we catch internally and null the health fields rather than aborting the
 *     whole metrics bundle. A partial result is strictly better than losing
 *     the already-working V1 fields for that stock.
 */
export async function fetchMetrics(symbol) {
  const yf = getYahooClient();

  // Two calls in parallel — the modules are independent and we can afford the
  // overlap inside the cron budget. Awaiting both via Promise.all halves the
  // wall-clock cost vs. serial.
  const [summary, tsRows] = await Promise.all([
    yf.quoteSummary(symbol, {
      modules: ["financialData", "defaultKeyStatistics", "summaryDetail"],
    }),
    yf.fundamentalsTimeSeries(symbol, {
      period1: new Date(Date.now() - 2 * 365 * 86400 * 1000),
      type: "annual",
      module: "all",
    }).catch((err) => {
      // Don't fail the whole metrics bundle if timeSeries is unavailable —
      // common for newly listed smallcaps. Surface nothing; let the health
      // fields fall through to null.
      return [];
    }),
  ]);

  const fd = summary?.financialData || {};
  const ks = summary?.defaultKeyStatistics || {};
  const sd = summary?.summaryDetail || {};

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

  // Derived: forward EPS growth, gated on trailing EPS being positive.
  // A negative or zero trailing EPS makes the percentage meaningless
  // (divide-by-zero or sign-flip) so we null it out in those cases —
  // the V2 scorer will fall back to earningsGrowthYoY instead.
  const trailingEps = num(ks.trailingEps);
  const forwardEps = num(ks.forwardEps);
  let forwardEpsGrowth = null;
  if (forwardEps != null && trailingEps != null && trailingEps > 0) {
    forwardEpsGrowth = (forwardEps - trailingEps) / trailingEps;
  }

  // ── Health pillar from fundamentalsTimeSeries ──
  // Pick the most recent reported annual period. Yahoo sometimes returns
  // periods out of order, so sort defensively.
  const latestTs = (tsRows || []).slice().sort((a, b) => {
    const da = new Date(a?.date || 0).getTime();
    const db = new Date(b?.date || 0).getTime();
    return db - da;
  })[0] || {};

  const currentAssets = num(latestTs.currentAssets ?? latestTs.totalCurrentAssets);
  const currentLiabilities = num(latestTs.currentLiabilities ?? latestTs.totalCurrentLiabilities);
  const ebit = num(latestTs.EBIT);
  const interestExpenseAbs = num(latestTs.interestExpense);
  const netIncomeTs = num(latestTs.netIncome);
  const operatingCashFlow = num(latestTs.operatingCashFlow);
  const freeCashFlow = num(latestTs.freeCashFlow);

  const currentRatio =
    currentAssets != null && currentLiabilities != null && currentLiabilities > 0
      ? currentAssets / currentLiabilities
      : null;

  // EBIT/|intExp|. Absolute value because Yahoo reports interest expense as
  // a negative number in some currencies and positive in others — the magnitude
  // is what matters for a coverage ratio.
  const interestCoverage =
    ebit != null && interestExpenseAbs != null && Math.abs(interestExpenseAbs) > 0
      ? ebit / Math.abs(interestExpenseAbs)
      : null;

  // OCF/NI. The classic accounting-quality sanity check. Values <0.7 for
  // multiple consecutive years flag aggressive revenue recognition. We only
  // expose the latest reading here; the scorer can decide whether a single
  // year's dip is meaningful.
  const ocfToNetIncome =
    operatingCashFlow != null && netIncomeTs != null && Math.abs(netIncomeTs) > 0
      ? operatingCashFlow / netIncomeTs
      : null;

  return {
    // ── Existing V1 fields — unchanged so the current scorer stays stable ──
    roe,
    debtToEquity: deRaw != null ? deRaw / 100 : null, // pct → ratio
    profitMargin: num(fd.profitMargins),
    revenueGrowthYoY: num(fd.revenueGrowth),

    // ── Phase 1.1 additions (quoteSummary — V2 scorer inputs, V1-ignored) ──
    // Future pillar
    forwardEps,
    trailingEps,
    pegRatio: num(ks.pegRatio),
    earningsGrowthYoY: num(fd.earningsGrowth),
    forwardEpsGrowth,
    analystCoverage: num(fd.numberOfAnalystOpinions),

    // Value supplements
    priceToBook: num(ks.priceToBook),
    enterpriseToEbitda: num(ks.enterpriseToEbitda),

    // Dividend pillar
    dividendYield: num(sd.dividendYield),
    payoutRatio: num(sd.payoutRatio),
    fiveYearAvgDivYield: num(sd.fiveYearAvgDividendYield),

    // Health / quality supplements (quoteSummary)
    ebitda: num(fd.ebitda),
    totalDebt: num(fd.totalDebt),
    totalCash: num(fd.totalCash),
    operatingMargins: num(fd.operatingMargins),
    grossMargins: num(fd.grossMargins),

    // ── Phase 1.2 additions (fundamentalsTimeSeries — Health pillar core) ──
    currentRatio,
    interestCoverage,
    ocfToNetIncome,
    freeCashFlow,
    reportingPeriodEnd: latestTs.date
      ? new Date(latestTs.date).toISOString().slice(0, 10)
      : null,
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
