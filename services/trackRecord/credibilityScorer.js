/**
 * credibilityScorer.js
 *
 * Powers the credibility ribbon on the SWS Picks landing tab: for each of
 * the five buy-thesis sections, compute the top-5-per-cohort forward return
 * over the last N days against both Nifty 50 and Nifty 500.
 *
 * Methodology (SEBI-RA point-in-time, no look-ahead, no survivorship):
 *   1. Group paper-trades by (snapshotAt, type) to reconstruct each refresh's
 *      cohort. Each refresh of picks-latest.json snapshots the section's
 *      stocks via paperTrades.snapshotAndCloseSwsPicks.
 *   2. Within each cohort, take the top 5 by scoreAtSnapshot.
 *   3. For each pick, forward return = (exit / priceAtSnapshot) - 1, where
 *      exit = closingPrice (if section dropped them) else live price.
 *   4. Benchmark returns per pick: Nifty 50 from niftyAtSnapshot → niftyAtClose
 *      (or live), Nifty 500 from the closest-prior ^CRSLDX close to snapshotAt
 *      → close at exit (or live).
 *   5. Section headline = equal-weighted mean across all observations in window.
 *   6. Alpha = section return − benchmark return.
 *   7. Maturity guard: < 2 cohorts OR < 10 observations → render "warming up".
 *
 * Pure module — no I/O. Caller passes in trades, live prices, and N500 history.
 */

export const CREDIBILITY_SECTIONS = [
  { slug: "top30_v3", type: "sws_top30_v3", label: "Top 30 (composite)" },
  { slug: "best_buynow", type: "sws_best_buynow", label: "Best to Buy Now" },
  { slug: "deep_value", type: "sws_deep_value", label: "Deep Value" },
  { slug: "quality_growth", type: "sws_quality_growth", label: "Quality Growth" },
  { slug: "dividend_aristocrats", type: "sws_dividend_aristocrats", label: "Dividend Aristocrats" },
];

export const TOP_N = 5;
export const MIN_COHORTS = 2;
export const MIN_OBSERVATIONS = 10;

function pctReturn(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

function isoDay(iso) {
  if (!iso) return null;
  return typeof iso === "string" ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
}

/**
 * Find the close from the index-history series at the snapshot date — using
 * the most recent bar at or before that date. Robust to timezone skew between
 * Yahoo's UTC-stamped bars and IST trading sessions.
 */
function closestPriorClose(history, isoTs) {
  if (!history || !history.dates || history.dates.length === 0) return null;
  const target = isoDay(isoTs);
  let best = null;
  for (let i = 0; i < history.dates.length; i++) {
    if (history.dates[i] <= target) best = history.closes[i];
    else break;
  }
  return best;
}

function buildCohorts(trades, sectionType, windowStartIso) {
  const byCohort = new Map();
  for (const t of trades) {
    if (t.type !== sectionType) continue;
    if (!t.snapshotAt || t.snapshotAt < windowStartIso) continue;
    const key = t.snapshotAt;
    if (!byCohort.has(key)) byCohort.set(key, []);
    byCohort.get(key).push(t);
  }
  const cohorts = [];
  for (const [snapshotAt, picks] of byCohort) {
    picks.sort((a, b) => (b.scoreAtSnapshot ?? 0) - (a.scoreAtSnapshot ?? 0));
    cohorts.push({ snapshotAt, picks: picks.slice(0, TOP_N) });
  }
  cohorts.sort((a, b) => b.snapshotAt.localeCompare(a.snapshotAt));
  return cohorts;
}

function mean(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}

/**
 * @param {object} ctx
 * @param {Array}  ctx.trades         All paper-trade entries (newest first).
 * @param {Map}    ctx.livePrices     symbol → current live price (.NS suffix).
 * @param {number} ctx.n50Latest      Live Nifty 50 quote.
 * @param {number|null} ctx.n500Latest Live Nifty 500 quote (null if unavailable).
 * @param {object|null} ctx.n500History  { dates: ['YYYY-MM-DD',…], closes: […] }.
 * @param {string} ctx.asOf           ISO timestamp of "now".
 * @param {number} [ctx.horizonDays=30]
 */
export function computeCredibility(ctx) {
  const {
    trades,
    livePrices,
    n50Latest,
    n500Latest = null,
    n500History = null,
    asOf,
    horizonDays = 30,
  } = ctx;

  const asOfMs = new Date(asOf).getTime();
  const windowStartMs = asOfMs - horizonDays * 24 * 3600 * 1000;
  const windowStartIso = new Date(windowStartMs).toISOString();

  const sections = [];
  for (const section of CREDIBILITY_SECTIONS) {
    const cohorts = buildCohorts(trades, section.type, windowStartIso);
    if (cohorts.length === 0) continue;

    const observations = [];
    for (const cohort of cohorts) {
      for (const pick of cohort.picks) {
        const entry = pick.priceAtSnapshot;
        if (!Number.isFinite(entry)) continue;
        const isOpen = pick.closingPrice == null;
        const exit = isOpen ? livePrices.get(pick.symbol) ?? null : pick.closingPrice;
        const pickRet = pctReturn(entry, exit);
        if (pickRet == null) continue;

        const n50Entry = pick.niftyAtSnapshot;
        const n50Exit = isOpen ? n50Latest : (pick.niftyAtClose ?? n50Latest);
        const n50Ret = pctReturn(n50Entry, n50Exit);

        let n500Ret = null;
        if (n500History) {
          const n500Entry = closestPriorClose(n500History, pick.snapshotAt);
          const n500Exit = isOpen
            ? (n500Latest ?? closestPriorClose(n500History, asOf))
            : closestPriorClose(n500History, pick.closedAt) ?? n500Latest;
          n500Ret = pctReturn(n500Entry, n500Exit);
        }

        observations.push({
          symbol: pick.symbol,
          snapshotAt: pick.snapshotAt,
          isOpen,
          pickRet,
          n50Ret,
          n500Ret,
        });
      }
    }

    const latestCohort = cohorts[0];
    const avgReturnPct = mean(observations.map((o) => o.pickRet));
    const niftyReturnPct = mean(observations.map((o) => o.n50Ret));
    const n500ReturnPct = mean(observations.map((o) => o.n500Ret));
    const winsVsN50 = observations.filter(
      (o) => Number.isFinite(o.pickRet) && Number.isFinite(o.n50Ret) && o.pickRet > o.n50Ret,
    ).length;

    const mature = cohorts.length >= MIN_COHORTS && observations.length >= MIN_OBSERVATIONS;

    sections.push({
      slug: section.slug,
      type: section.type,
      label: section.label,
      mature,
      cohortCount: cohorts.length,
      observationCount: observations.length,
      topPicksLatest: latestCohort.picks.map((p) => stripNs(p.symbol)),
      avgReturnPct: round2(avgReturnPct),
      niftyReturnPct: round2(niftyReturnPct),
      n500ReturnPct: round2(n500ReturnPct),
      alphaN50Pct: alpha(avgReturnPct, niftyReturnPct),
      alphaN500Pct: alpha(avgReturnPct, n500ReturnPct),
      winRatePct: observations.length ? +((winsVsN50 / observations.length) * 100).toFixed(1) : null,
    });
  }

  const chart = pickChartReference(trades, windowStartIso, asOfMs, horizonDays);

  return {
    asOf,
    horizonDays,
    windowStart: isoDay(windowStartIso),
    cohortsInWindow: sections.reduce((s, x) => s + x.cohortCount, 0),
    sections,
    chart,
    dataMaturity: {
      minCohortsRequired: MIN_COHORTS,
      minObservationsRequired: MIN_OBSERVATIONS,
    },
  };
}

/**
 * Select the reference cohort whose forward-return curve we plot. Prefer
 * Top-30 (the marquee section); take the oldest cohort within the window
 * that's at least (horizonDays-2) days old so the curve spans ~the full
 * window. Falls back to whatever section has data.
 */
function pickChartReference(trades, windowStartIso, asOfMs, horizonDays) {
  const targetAgeMs = Math.max(0, (horizonDays - 2)) * 24 * 3600 * 1000;
  for (const section of CREDIBILITY_SECTIONS) {
    const cohorts = buildCohorts(trades, section.type, windowStartIso);
    if (cohorts.length === 0) continue;
    // Oldest first
    cohorts.sort((a, b) => a.snapshotAt.localeCompare(b.snapshotAt));
    let ref = null;
    for (const c of cohorts) {
      if (asOfMs - new Date(c.snapshotAt).getTime() >= targetAgeMs) {
        ref = c;
        break;
      }
    }
    if (!ref) ref = cohorts[0];
    return {
      sectionSlug: section.slug,
      sectionLabel: section.label,
      referenceCohortAt: ref.snapshotAt,
      referenceCohortDate: isoDay(ref.snapshotAt),
      pickSymbols: ref.picks.map((p) => p.symbol),
      tickers: ref.picks.map((p) => stripNs(p.symbol)),
      entryPrices: ref.picks.map((p) => p.priceAtSnapshot),
    };
  }
  return null;
}

/**
 * Build chart series given the reference cohort and pre-fetched daily history
 * for the cohort symbols + both indices. Returns a date-aligned set of
 * cumulative-return series ready for SVG rendering.
 *
 * @param {object} chartRef     The `.chart` field from computeCredibility.
 * @param {Map<string,object>} historiesBySymbol  symbol → { dates, closes }.
 * @param {object} n50History   { dates, closes }.
 * @param {object|null} n500History
 */
export function buildChartSeries(chartRef, historiesBySymbol, n50History, n500History) {
  if (!chartRef || !n50History) return null;
  const startDay = chartRef.referenceCohortDate;

  // Union date axis: every trading day from startDay onwards, in N50's bars.
  const dates = n50History.dates.filter((d) => d >= startDay);
  if (dates.length === 0) return null;

  const closesByDate = (hist) => {
    if (!hist) return null;
    const map = new Map();
    for (let i = 0; i < hist.dates.length; i++) map.set(hist.dates[i], hist.closes[i]);
    return map;
  };

  const n50Map = closesByDate(n50History);
  const n500Map = n500History ? closesByDate(n500History) : null;
  const symbolMaps = new Map();
  for (const sym of chartRef.pickSymbols) {
    symbolMaps.set(sym, closesByDate(historiesBySymbol.get(sym)));
  }

  // Entry levels (first bar at or after startDay).
  const seriesAtDate = (map) => map ? (map.get(startDay) ?? firstBarAtOrAfter(map, startDay)) : null;
  const n50Entry = seriesAtDate(n50Map);
  const n500Entry = n500Map ? seriesAtDate(n500Map) : null;
  const symbolEntries = new Map();
  for (const sym of chartRef.pickSymbols) {
    symbolEntries.set(sym, seriesAtDate(symbolMaps.get(sym)));
  }

  const topFivePct = [];
  const nifty50Pct = [];
  const nifty500Pct = [];

  for (const d of dates) {
    const n50Close = n50Map.get(d);
    if (!Number.isFinite(n50Close) || !Number.isFinite(n50Entry)) {
      nifty50Pct.push(null);
    } else {
      nifty50Pct.push(((n50Close / n50Entry) - 1) * 100);
    }

    if (n500Map && Number.isFinite(n500Entry)) {
      const n500Close = n500Map.get(d);
      nifty500Pct.push(Number.isFinite(n500Close) ? ((n500Close / n500Entry) - 1) * 100 : null);
    } else {
      nifty500Pct.push(null);
    }

    // Equal-weight portfolio: avg of (close/entry - 1) across the 5 tickers.
    const rets = [];
    for (const sym of chartRef.pickSymbols) {
      const m = symbolMaps.get(sym);
      const entry = symbolEntries.get(sym);
      if (!m || !Number.isFinite(entry)) continue;
      const c = m.get(d);
      if (!Number.isFinite(c)) continue;
      rets.push(((c / entry) - 1) * 100);
    }
    topFivePct.push(rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : null);
  }

  return {
    sectionSlug: chartRef.sectionSlug,
    sectionLabel: chartRef.sectionLabel,
    referenceCohortDate: startDay,
    tickers: chartRef.tickers,
    dates,
    topFivePct,
    nifty50Pct,
    nifty500Pct,
  };
}

function firstBarAtOrAfter(map, isoDate) {
  const sorted = [...map.keys()].sort();
  for (const d of sorted) if (d >= isoDate) return map.get(d);
  return null;
}

function stripNs(sym) {
  return typeof sym === "string" ? sym.replace(/\.NS$/i, "") : sym;
}

function round2(v) {
  return Number.isFinite(v) ? +v.toFixed(2) : null;
}

function alpha(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return +(a - b).toFixed(2);
}
