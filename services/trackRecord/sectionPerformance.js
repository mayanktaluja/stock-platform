/**
 * Daily SWS section-performance cohorts.
 *
 * This module is intentionally pure: it turns a picks-latest snapshot into
 * one row per SWS section, then computes short-window section alpha with a
 * single shared Nifty 500 benchmark return per timeframe.
 */

import { fetchSchemeHistory } from "../../mfNavIngestion.js";
import { PROXY_REGISTRY } from "../../benchmarkIndices.js";
import {
  getSectionPerformanceStorage,
  readAllSectionPerformanceRows,
  upsertSectionPerformanceRows,
} from "./sectionPerformanceStorage.js";

export const SECTION_PERFORMANCE_SCHEMA_VERSION = "sws-section-performance-v1";
export const SECTION_PERFORMANCE_TOP_N = 10;
export const SECTION_PERFORMANCE_TIMEFRAMES = ["7d", "30d"];
export const DEFAULT_SECTION_BENCHMARK_PROXY = "nifty500_tri";

export const SWS_SECTION_PERFORMANCE_REGISTRY = {
  top_ranked_30_v3: {
    sectionKey: "top_ranked_30_v3",
    type: "sws_top30_v3",
    label: "SWS - Top 30",
    side: "LONG",
  },
  best_to_buy_now: {
    sectionKey: "best_to_buy_now",
    type: "sws_best_buynow",
    label: "SWS - Best to Buy Now",
    side: "LONG",
  },
  deep_value: {
    sectionKey: "deep_value",
    type: "sws_deep_value",
    label: "SWS - Deep Value",
    side: "LONG",
  },
  quality_growth: {
    sectionKey: "quality_growth",
    type: "sws_quality_growth",
    label: "SWS - Quality Growth",
    side: "LONG",
  },
  best_fundamentals: {
    sectionKey: "best_fundamentals",
    type: "sws_best_fundamentals",
    label: "SWS - Best Fundamentals",
    side: "LONG",
  },
  midterm: {
    sectionKey: "midterm",
    type: "sws_midterm",
    label: "SWS - Mid-Term",
    side: "LONG",
  },
  dividend_aristocrats: {
    sectionKey: "dividend_aristocrats",
    type: "sws_dividend_aristocrats",
    label: "SWS - Dividend Aristocrats",
    side: "LONG",
  },
  smallcap_gems: {
    sectionKey: "smallcap_gems",
    type: "sws_smallcap_gems",
    label: "SWS - Small-Cap Gems",
    side: "LONG",
  },
  insider_buying: {
    sectionKey: "insider_buying",
    type: "sws_insider_buying",
    label: "SWS - Insider Buying",
    side: "LONG",
  },
  upcoming_earnings: {
    sectionKey: "upcoming_earnings",
    type: "sws_upcoming_earnings",
    label: "SWS - Upcoming Earnings",
    side: "LONG",
  },
  avoid: {
    sectionKey: "avoid",
    type: "sws_avoid",
    label: "SWS - Avoid",
    side: "SHORT",
  },
};

const RETURN_KEY_BY_TIMEFRAME = {
  "7d": "7D",
  "30d": "1M",
};

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return Number.isFinite(value) ? +value.toFixed(2) : null;
}

function round1(value) {
  return Number.isFinite(value) ? +value.toFixed(1) : null;
}

function dateKeyFromIso(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function addDays(dateKey, n) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function navAtOrBefore(series, targetDate) {
  if (!Array.isArray(series) || !targetDate) return null;
  let chosen = null;
  for (const row of series) {
    if (!row?.date) continue;
    if (row.date <= targetDate) chosen = row;
    else break;
  }
  return chosen ? num(chosen.nav) : null;
}

function latestNav(series) {
  if (!Array.isArray(series)) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    const row = series[i];
    const nav = num(row?.nav);
    if (row?.date && nav != null) return { date: row.date, nav };
  }
  return null;
}

async function fetchBenchmarkSeries() {
  const proxy = PROXY_REGISTRY[DEFAULT_SECTION_BENCHMARK_PROXY];
  if (!proxy?.schemeCode) return null;
  return fetchSchemeHistory(proxy.schemeCode);
}

function canonicalSymbol(ticker) {
  if (!ticker) return null;
  const s = String(ticker).trim().toUpperCase();
  if (!s) return null;
  return /\.(NS|BO)$/i.test(s) ? s : `${s}.NS`;
}

function normaliseReturnsPct(raw) {
  const out = {};
  for (const tf of SECTION_PERFORMANCE_TIMEFRAMES) {
    const sourceKey = RETURN_KEY_BY_TIMEFRAME[tf];
    out[tf] = num(raw?.[sourceKey] ?? raw?.[tf]);
  }
  return out;
}

function qualityFlag(code, count = null) {
  return count == null ? code : `${code}:${count}`;
}

function uniqueFlags(flags) {
  return [...new Set(flags.filter(Boolean))];
}

export function sectionPerformanceRowId(dateKey, type) {
  return `${dateKey}|${type}`;
}

export function getSectionRegistryByType() {
  const out = {};
  for (const item of Object.values(SWS_SECTION_PERFORMANCE_REGISTRY)) {
    out[item.type] = item;
  }
  return out;
}

export function buildSectionConstituent(rawPick, rank) {
  const ticker = String(rawPick?.ticker || rawPick?.symbol || "").replace(/\.NS$/i, "").trim().toUpperCase();
  const price = num(rawPick?.current_price_inr ?? rawPick?.price_inr ?? rawPick?.price);
  const returnsPct = normaliseReturnsPct(rawPick?.returns_pct);
  const flags = [];
  if (!ticker) flags.push("missing_ticker");
  if (price == null) flags.push("missing_price");
  for (const tf of SECTION_PERFORMANCE_TIMEFRAMES) {
    if (returnsPct[tf] == null) flags.push(`missing_return_${tf}`);
  }

  return {
    ticker: ticker || null,
    symbol: canonicalSymbol(ticker),
    name: rawPick?.name || ticker || null,
    sector: rawPick?.sector || null,
    rank,
    price_inr: price,
    score: num(rawPick?.v4_score_100 ?? rawPick?.v4_score ?? rawPick?.score ?? rawPick?.v2_score),
    returns_pct: returnsPct,
    data_quality_flags: uniqueFlags(flags),
  };
}

export function buildDailySectionCohortRows(picksData, opts = {}) {
  const snapshotAt = opts.snapshotAt || picksData?.scanned_at || new Date().toISOString();
  const dateKey = opts.dateKey || dateKeyFromIso(snapshotAt);
  const topN = Number.isFinite(opts.topN) ? opts.topN : SECTION_PERFORMANCE_TOP_N;
  const benchmarkProxy = opts.benchmarkProxy || DEFAULT_SECTION_BENCHMARK_PROXY;
  const rows = [];

  for (const section of Object.values(SWS_SECTION_PERFORMANCE_REGISTRY)) {
    const rawItems = picksData?.sections?.[section.sectionKey];
    const flags = [];
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      flags.push("empty_section");
    }
    const constituents = (Array.isArray(rawItems) ? rawItems : [])
      .slice(0, topN)
      .map((item, idx) => buildSectionConstituent(item, idx + 1));

    if (constituents.length > 0 && constituents.length < topN) {
      flags.push(qualityFlag("partial_top10", constituents.length));
    }
    const missingPriceCount = constituents.filter((c) => c.price_inr == null).length;
    if (missingPriceCount > 0) flags.push(qualityFlag("missing_prices", missingPriceCount));
    for (const tf of SECTION_PERFORMANCE_TIMEFRAMES) {
      const missing = constituents.filter((c) => c.returns_pct?.[tf] == null).length;
      if (missing > 0) flags.push(qualityFlag(`missing_returns_${tf}`, missing));
    }

    rows.push({
      schema_version: SECTION_PERFORMANCE_SCHEMA_VERSION,
      id: sectionPerformanceRowId(dateKey, section.type),
      dateKey,
      snapshotAt,
      sectionKey: section.sectionKey,
      type: section.type,
      label: section.label,
      side: section.side,
      top_n: topN,
      benchmark_proxy: benchmarkProxy,
      source: {
        scanned_at: picksData?.scanned_at || null,
        scoring_version: picksData?.scoring_version || null,
        schema_version: picksData?.schema_version || null,
      },
      constituents,
      data_quality_flags: uniqueFlags(flags),
    });
  }

  return rows;
}

export function buildDailySectionCohortSnapshot(picksData, opts = {}) {
  const rows = buildDailySectionCohortRows(picksData, opts);
  return {
    schema_version: SECTION_PERFORMANCE_SCHEMA_VERSION,
    dateKey: rows[0]?.dateKey || opts.dateKey || null,
    snapshotAt: rows[0]?.snapshotAt || opts.snapshotAt || null,
    benchmark_proxy: opts.benchmarkProxy || DEFAULT_SECTION_BENCHMARK_PROXY,
    rows,
  };
}

export function getRawConstituentReturn(constituent, timeframe) {
  return num(
    constituent?.returns_pct?.[timeframe] ??
    constituent?.return_by_timeframe_pct?.[timeframe] ??
    constituent?.performance_by_timeframe?.[timeframe]?.underlying_return_pct
  );
}

export function computeEqualWeightSectionReturn(constituents, timeframe, side = "LONG") {
  const input = Array.isArray(constituents) ? constituents : [];
  const values = [];
  const missing = [];
  for (const c of input) {
    const r = getRawConstituentReturn(c, timeframe);
    if (r == null) {
      missing.push(c?.ticker || c?.symbol || null);
      continue;
    }
    values.push(r);
  }

  if (values.length === 0) {
    return {
      n_constituents: input.length,
      n_with_return: 0,
      missing_return_count: missing.length,
      missing_return_symbols: missing.filter(Boolean),
      underlying_return_pct: null,
      return_pct: null,
    };
  }

  const underlying = values.reduce((sum, value) => sum + value, 0) / values.length;
  const isShort = side === "SHORT";
  return {
    n_constituents: input.length,
    n_with_return: values.length,
    missing_return_count: missing.length,
    missing_return_symbols: missing.filter(Boolean),
    underlying_return_pct: round2(underlying),
    return_pct: round2(isShort ? -underlying : underlying),
  };
}

export function computeSectionPerformanceForTimeframe(row, timeframe, benchmarkReturnPct) {
  const benchmark = num(benchmarkReturnPct);
  const side = row?.side || "LONG";
  const sectionReturn = computeEqualWeightSectionReturn(row?.constituents, timeframe, side);
  const flags = [...(row?.data_quality_flags || [])];
  if (!SECTION_PERFORMANCE_TIMEFRAMES.includes(timeframe)) flags.push("unsupported_timeframe");
  if (sectionReturn.n_constituents === 0) flags.push("empty_section");
  if (sectionReturn.missing_return_count > 0) {
    flags.push(qualityFlag(`missing_returns_${timeframe}`, sectionReturn.missing_return_count));
  }
  if (sectionReturn.n_with_return > 0 && sectionReturn.n_with_return < Math.min(row?.top_n || SECTION_PERFORMANCE_TOP_N, sectionReturn.n_constituents || SECTION_PERFORMANCE_TOP_N)) {
    flags.push("partial_return_coverage");
  }
  if (benchmark == null) flags.push(`missing_benchmark_${timeframe}`);

  let alpha = null;
  if (benchmark != null && sectionReturn.underlying_return_pct != null) {
    alpha = side === "SHORT"
      ? benchmark - sectionReturn.underlying_return_pct
      : sectionReturn.underlying_return_pct - benchmark;
  }

  return {
    timeframe,
    type: row?.type || null,
    sectionKey: row?.sectionKey || null,
    label: row?.label || null,
    side,
    benchmark_proxy: row?.benchmark_proxy || DEFAULT_SECTION_BENCHMARK_PROXY,
    benchmark_return_pct: round2(benchmark),
    underlying_return_pct: sectionReturn.underlying_return_pct,
    return_pct: sectionReturn.return_pct,
    alpha_pct: round2(alpha),
    beat_benchmark: alpha == null ? null : alpha > 0,
    n_constituents: sectionReturn.n_constituents,
    n_with_return: sectionReturn.n_with_return,
    missing_return_count: sectionReturn.missing_return_count,
    coverage_pct: sectionReturn.n_constituents > 0
      ? round1((sectionReturn.n_with_return / sectionReturn.n_constituents) * 100)
      : null,
    data_quality_flags: uniqueFlags(flags),
  };
}

export function computeSectionPerformance(row, benchmarkReturnsByTimeframe = {}, timeframes = SECTION_PERFORMANCE_TIMEFRAMES) {
  const performance = {};
  for (const tf of timeframes) {
    performance[tf] = computeSectionPerformanceForTimeframe(row, tf, benchmarkReturnsByTimeframe?.[tf]);
  }
  return {
    ...row,
    performance_by_timeframe: performance,
  };
}

export function selectBestOverall(sections, timeframes = SECTION_PERFORMANCE_TIMEFRAMES) {
  let best = null;
  for (const section of Array.isArray(sections) ? sections : []) {
    for (const tf of timeframes) {
      const perf = section?.performance_by_timeframe?.[tf] || section?.performance?.[tf];
      if (!perf || !Number.isFinite(perf.alpha_pct)) continue;
      const candidate = {
        timeframe: tf,
        type: section.type || perf.type || null,
        sectionKey: section.sectionKey || perf.sectionKey || null,
        label: section.label || perf.label || null,
        side: section.side || perf.side || null,
        alpha_pct: perf.alpha_pct,
        return_pct: perf.return_pct,
        underlying_return_pct: perf.underlying_return_pct,
        benchmark_return_pct: perf.benchmark_return_pct,
        beat_benchmark: perf.beat_benchmark,
        n_with_return: perf.n_with_return,
        n_constituents: perf.n_constituents,
      };
      if (!best || candidate.alpha_pct > best.alpha_pct) best = candidate;
    }
  }
  return best;
}

export function buildSectionPerformancePayload(rows, opts = {}) {
  const timeframes = opts.timeframes || SECTION_PERFORMANCE_TIMEFRAMES;
  const benchmarkReturnsByTimeframe = opts.benchmarkReturnsByTimeframe || opts.benchmarkReturns || {};
  const sections = (Array.isArray(rows) ? rows : [])
    .map((row) => computeSectionPerformance(row, benchmarkReturnsByTimeframe, timeframes));
  return {
    schema_version: SECTION_PERFORMANCE_SCHEMA_VERSION,
    mode: opts.mode || "latest_cohort",
    dateKey: opts.dateKey || rows?.[0]?.dateKey || null,
    snapshotAt: opts.snapshotAt || rows?.[0]?.snapshotAt || null,
    timeframes,
    benchmark: {
      proxy: opts.benchmarkProxy || rows?.[0]?.benchmark_proxy || DEFAULT_SECTION_BENCHMARK_PROXY,
      returns_pct: Object.fromEntries(
        timeframes.map((tf) => [tf, round2(num(benchmarkReturnsByTimeframe?.[tf]))])
      ),
    },
    sections,
    bestOverall: selectBestOverall(sections, timeframes),
  };
}

export function normalizeSectionPerformanceWindows(windows) {
  const raw = Array.isArray(windows) ? windows : String(windows || "").split(",");
  const out = raw.map((w) => String(w || "").trim().toLowerCase()).filter((w) => SECTION_PERFORMANCE_TIMEFRAMES.includes(w));
  return out.length ? [...new Set(out)] : [...SECTION_PERFORMANCE_TIMEFRAMES];
}

export async function getLatestBenchmarkReturns(windows = SECTION_PERFORMANCE_TIMEFRAMES, series = null) {
  const resolvedSeries = series || await fetchBenchmarkSeries().catch(() => null);
  const latest = latestNav(resolvedSeries);
  if (!latest) return {};
  const out = {};
  for (const w of normalizeSectionPerformanceWindows(windows)) {
    const days = w === "30d" ? 30 : 7;
    const fromDate = addDays(latest.date, -days);
    const startNav = navAtOrBefore(resolvedSeries, fromDate);
    out[w] = {
      fromDate,
      toDate: latest.date,
      benchmarkReturnPct: startNav ? round2(((latest.nav - startNav) / startNav) * 100) : null,
    };
  }
  return out;
}

function toWindowSection(section, timeframe, sampleStatus, dates = {}) {
  const perf = section?.performance_by_timeframe?.[timeframe];
  if (!perf) return null;
  return {
    type: section.type,
    sectionKey: section.sectionKey,
    label: section.label,
    side: section.side,
    sampleSize: perf.n_with_return ?? section.constituents?.length ?? 0,
    weighting: "equal_top10",
    fromDate: dates.fromDate || section.dateKey || null,
    toDate: dates.toDate || null,
    sectionReturnPct: perf.return_pct,
    underlyingReturnPct: perf.underlying_return_pct,
    benchmarkReturnPct: perf.benchmark_return_pct,
    alphaPct: perf.alpha_pct,
    outperformed: perf.beat_benchmark === true,
    status: sampleStatus,
    qualityFlags: perf.data_quality_flags || [],
    constituents: (section.constituents || []).slice(0, section.top_n || SECTION_PERFORMANCE_TOP_N).map((c) => ({
      rank: c.rank,
      ticker: c.ticker,
      symbol: c.symbol,
      name: c.name,
      sector: c.sector,
      score: c.score,
      snapshotPrice: c.price_inr,
    })),
  };
}

function chooseBestWindowSection(sections) {
  const viable = sections.filter((s) => Number.isFinite(s?.alphaPct));
  if (viable.length === 0) return null;
  const positives = viable.filter((s) => s.alphaPct > 0);
  const pool = positives.length ? positives : viable;
  const best = [...pool].sort((a, b) => b.alphaPct - a.alphaPct)[0];
  return { ...best, outperformed: best.alphaPct > 0 };
}

export function buildSectionPerformanceApiPayload(rows, opts = {}) {
  const windows = normalizeSectionPerformanceWindows(opts.windows || opts.timeframes);
  const sampleStatus = opts.sampleStatus || opts.mode || "latest_available";
  const benchmarkReturnsByTimeframe = opts.benchmarkReturnsByTimeframe || {};
  const base = buildSectionPerformancePayload(rows, {
    timeframes: windows,
    benchmarkReturnsByTimeframe,
    mode: sampleStatus,
  });
  const windowPayloads = windows.map((w) => {
    const dates = opts.datesByTimeframe?.[w] || {};
    const sections = base.sections
      .map((s) => toWindowSection(s, w, sampleStatus, dates))
      .filter(Boolean)
      .sort((a, b) => (b.alphaPct ?? -Infinity) - (a.alphaPct ?? -Infinity));
    const bestSection = chooseBestWindowSection(sections);
    return {
      window: w,
      fromDate: dates.fromDate || base.dateKey || null,
      toDate: dates.toDate || base.dateKey || null,
      benchmarkReturnPct: benchmarkReturnsByTimeframe[w] == null ? null : round2(num(benchmarkReturnsByTimeframe[w])),
      sampleStatus,
      outperformed: !!bestSection?.outperformed,
      bestSection,
      sections,
    };
  });
  const overallCandidates = windowPayloads
    .filter((w) => w.bestSection)
    .map((w) => ({ ...w.bestSection, window: w.window, sampleStatus: w.sampleStatus }));
  return {
    schema_version: SECTION_PERFORMANCE_SCHEMA_VERSION,
    mode: sampleStatus,
    windows: windowPayloads,
    bestOverall: chooseBestWindowSection(overallCandidates),
    generatedAt: new Date().toISOString(),
  };
}

export async function snapshotSectionPerformanceFromPicks(picksData, opts = {}) {
  const rows = buildDailySectionCohortRows(picksData, opts);
  if (rows.length === 0) return { written: 0, updated: 0, skipped: 0, rows: 0 };
  const result = await upsertSectionPerformanceRows(rows);
  return { ...result, rows: rows.length };
}

export async function buildLatestSamplePayloadFromPicks(picksData, opts = {}) {
  const windows = normalizeSectionPerformanceWindows(opts.windows || opts.timeframes);
  const benchmarkInfo = opts.benchmarkInfo || await getLatestBenchmarkReturns(windows).catch(() => ({}));
  const benchmarkReturnsByTimeframe = Object.fromEntries(
    windows.map((w) => [w, benchmarkInfo[w]?.benchmarkReturnPct ?? null])
  );
  const datesByTimeframe = Object.fromEntries(
    windows.map((w) => [w, {
      fromDate: benchmarkInfo[w]?.fromDate || null,
      toDate: benchmarkInfo[w]?.toDate || (picksData?.scanned_at ? dateKeyFromIso(picksData.scanned_at) : null),
    }])
  );
  const rows = buildDailySectionCohortRows(picksData, opts);
  return buildSectionPerformanceApiPayload(rows, {
    windows,
    sampleStatus: "latest_available",
    benchmarkReturnsByTimeframe,
    datesByTimeframe,
  });
}

function buildPriceMapsByDate(rows) {
  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.dateKey || !Array.isArray(row.constituents)) continue;
    if (!byDate.has(row.dateKey)) byDate.set(row.dateKey, new Map());
    const prices = byDate.get(row.dateKey);
    for (const c of row.constituents) {
      const symbol = c?.symbol || canonicalSymbol(c?.ticker);
      const price = num(c?.price_inr ?? c?.snapshotPrice);
      if (symbol && price != null && !prices.has(symbol)) prices.set(symbol, price);
    }
  }
  return byDate;
}

function firstDateOnOrAfter(sortedDates, targetDate) {
  return sortedDates.find((d) => d >= targetDate) || null;
}

function benchmarkReturnBetween(series, fromDate, toDate) {
  const start = navAtOrBefore(series, fromDate);
  const end = navAtOrBefore(series, toDate);
  if (!start || !end) return null;
  return round2(((end - start) / start) * 100);
}

function buildResolvedSectionForWindow(row, timeframe, targetDate, exitPrices, benchmarkReturnPct) {
  const constituents = (row.constituents || []).map((c) => {
    const symbol = c?.symbol || canonicalSymbol(c?.ticker);
    const entry = num(c?.price_inr ?? c?.snapshotPrice);
    const exit = symbol ? num(exitPrices?.get(symbol)) : null;
    const underlyingReturn = entry && exit
      ? round2(((exit - entry) / entry) * 100)
      : null;
    return {
      ...c,
      returns_pct: { ...(c?.returns_pct || {}), [timeframe]: underlyingReturn },
      exit_price_inr: exit,
    };
  });
  const temp = { ...row, constituents };
  const perf = computeSectionPerformanceForTimeframe(temp, timeframe, benchmarkReturnPct);
  return {
    type: row.type,
    sectionKey: row.sectionKey,
    label: row.label,
    side: row.side,
    sampleSize: perf.n_with_return,
    weighting: "equal_top10",
    fromDate: row.dateKey,
    toDate: targetDate,
    sectionReturnPct: perf.return_pct,
    underlyingReturnPct: perf.underlying_return_pct,
    benchmarkReturnPct: perf.benchmark_return_pct,
    alphaPct: perf.alpha_pct,
    outperformed: perf.beat_benchmark === true,
    status: "resolved",
    qualityFlags: perf.data_quality_flags,
    constituents: constituents.slice(0, row.top_n || SECTION_PERFORMANCE_TOP_N).map((c) => ({
      rank: c.rank,
      ticker: c.ticker,
      symbol: c.symbol,
      name: c.name,
      sector: c.sector,
      score: c.score,
      snapshotPrice: c.price_inr,
      exitPrice: c.exit_price_inr,
    })),
  };
}

export async function buildStoredResolvedSectionPerformancePayload(rows, opts = {}) {
  const windows = normalizeSectionPerformanceWindows(opts.windows || opts.timeframes);
  const allRows = Array.isArray(rows) ? rows.filter((r) => r?.dateKey && Array.isArray(r.constituents)) : [];
  const dates = [...new Set(allRows.map((r) => r.dateKey))].sort();
  const priceMaps = buildPriceMapsByDate(allRows);
  const benchmarkSeries = opts.benchmarkSeries || await fetchBenchmarkSeries().catch(() => null);
  const rowsByDate = new Map();
  for (const row of allRows) {
    if (!rowsByDate.has(row.dateKey)) rowsByDate.set(row.dateKey, []);
    rowsByDate.get(row.dateKey).push(row);
  }

  const windowPayloads = windows.map((w) => {
    const days = w === "30d" ? 30 : 7;
    const candidates = dates
      .map((dateKey) => ({ dateKey, dueDate: addDays(dateKey, days) }))
      .filter((x) => x.dueDate && firstDateOnOrAfter(dates, x.dueDate));
    if (candidates.length === 0) {
      return {
        window: w,
        fromDate: null,
        toDate: null,
        benchmarkReturnPct: null,
        sampleStatus: "insufficient_history",
        outperformed: false,
        bestSection: null,
        sections: [],
      };
    }
    const latest = candidates[candidates.length - 1];
    const targetDate = firstDateOnOrAfter(dates, latest.dueDate);
    const exitPrices = priceMaps.get(targetDate);
    const benchmarkReturnPct = benchmarkReturnBetween(benchmarkSeries, latest.dateKey, targetDate);
    const sections = (rowsByDate.get(latest.dateKey) || [])
      .map((row) => buildResolvedSectionForWindow(row, w, targetDate, exitPrices, benchmarkReturnPct))
      .sort((a, b) => (b.alphaPct ?? -Infinity) - (a.alphaPct ?? -Infinity));
    const bestSection = chooseBestWindowSection(sections);
    return {
      window: w,
      fromDate: latest.dateKey,
      toDate: targetDate,
      benchmarkReturnPct,
      sampleStatus: "resolved",
      outperformed: !!bestSection?.outperformed,
      bestSection,
      sections,
    };
  });
  const overallCandidates = windowPayloads
    .filter((w) => w.bestSection)
    .map((w) => ({ ...w.bestSection, window: w.window, sampleStatus: w.sampleStatus }));
  return {
    schema_version: SECTION_PERFORMANCE_SCHEMA_VERSION,
    mode: "resolved",
    windows: windowPayloads,
    bestOverall: chooseBestWindowSection(overallCandidates),
    generatedAt: new Date().toISOString(),
  };
}

export async function getSectionPerformancePayload(opts = {}) {
  const windows = normalizeSectionPerformanceWindows(opts.windows || opts.timeframes);
  const rows = await readAllSectionPerformanceRows();
  const resolved = await buildStoredResolvedSectionPerformancePayload(rows, {
    windows,
    benchmarkSeries: opts.benchmarkSeries,
  });
  if (resolved.bestOverall) return resolved;
  if (opts.picksData) {
    return buildLatestSamplePayloadFromPicks(opts.picksData, { windows });
  }
  return buildSectionPerformanceApiPayload(rows, {
    windows,
    sampleStatus: rows.length ? "latest_available" : "insufficient_history",
    benchmarkReturnsByTimeframe: {},
  });
}

export async function resolveStoredSectionPerformance() {
  const rows = await readAllSectionPerformanceRows();
  return {
    resolved: 0,
    total: rows.length,
    note: "Daily cohort rows are stored; durable price-based maturity resolution is pending. UI uses latest_available samples until closed windows exist.",
  };
}

export { getSectionPerformanceStorage, readAllSectionPerformanceRows, upsertSectionPerformanceRows };
