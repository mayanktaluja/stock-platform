import {
  SECTION_PERFORMANCE_COHORT_SIZES,
  SWS_SECTION_PERFORMANCE_REGISTRY,
  buildDailySectionCohortRows,
} from "./trackRecord/sectionPerformance.js";

export const CURRENT_COHORT_TRAILING_SCHEMA_VERSION = "sws-current-cohort-trailing-v1";
export const CURRENT_COHORT_EVIDENCE_BASIS = "research_only_current_cohort_trailing";
export const CURRENT_COHORT_EVIDENCE_LABEL = "Guessing/proxy - today's SWS cohort projected backward";
export const DEFAULT_TRAILING_HORIZONS = ["3y", "5y"];
export const DEFAULT_MIN_COVERAGE_PCT = 80;
export const DEFAULT_FRICTION_BPS = 0;
export const DEFAULT_INDIAN_BUY_SECTION_KEYS = [
  "top_ranked_30_v4",
  "best_to_buy_now",
  "deep_value",
  "growing_sector_value",
  "quality_growth",
  "best_fundamentals",
  "midterm",
  "dividend_aristocrats",
  "smallcap_gems",
];
export const DEFAULT_BENCHMARK = {
  symbol: "^NSEI",
  label: "Nifty 50 price index",
  basis: "price_return_proxy",
};

const HORIZON_YEARS = {
  "3y": 3,
  "5y": 5,
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

export function normalizeTrailingHorizons(raw = DEFAULT_TRAILING_HORIZONS) {
  const values = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const out = values
    .map((v) => String(v || "").trim().toLowerCase())
    .filter(Boolean);
  const invalid = out.find((v) => !HORIZON_YEARS[v]);
  if (invalid) throw new Error(`Unsupported trailing horizon: ${invalid}`);
  return out.length ? [...new Set(out)] : [...DEFAULT_TRAILING_HORIZONS];
}

export function normalizeTrailingCohorts(raw = SECTION_PERFORMANCE_COHORT_SIZES) {
  const values = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const out = values
    .map((v) => Number.parseInt(String(v || "").trim(), 10))
    .filter((v) => Number.isFinite(v));
  const invalid = out.find((v) => !SECTION_PERFORMANCE_COHORT_SIZES.includes(v));
  if (invalid) throw new Error(`Unsupported cohort size: ${invalid}`);
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : [...SECTION_PERFORMANCE_COHORT_SIZES];
}

export function normalizeSectionKeys(raw = null) {
  if (raw == null || raw === "") return [...DEFAULT_INDIAN_BUY_SECTION_KEYS];
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  const out = values.map((v) => String(v || "").trim()).filter(Boolean);
  const invalid = out.find((v) => !SWS_SECTION_PERFORMANCE_REGISTRY[v]);
  if (invalid) throw new Error(`Unsupported SWS section: ${invalid}`);
  return [...new Set(out)];
}

export function canonicalYahooSymbol(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  if (/^[^^].*\.(NS|BO)$/i.test(s) || s.startsWith("^")) return s;
  return `${s}.NS`;
}

function toDateKey(value) {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function dateToUtcMs(dateKey) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function daysBetween(a, b) {
  const ams = dateToUtcMs(a);
  const bms = dateToUtcMs(b);
  if (ams == null || bms == null) return null;
  return Math.round((bms - ams) / 86400000);
}

function subtractYears(dateKey, years) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

export function normalizePriceBars(rawBars) {
  return (Array.isArray(rawBars) ? rawBars : [])
    .map((bar) => ({
      date: toDateKey(bar?.date),
      close: num(bar?.close ?? bar?.adjClose ?? bar?.adjclose),
    }))
    .filter((bar) => bar.date && bar.close != null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function closeAtOrBefore(rawBars, targetDateKey, maxStaleDays = 10) {
  const bars = normalizePriceBars(rawBars);
  if (!targetDateKey || bars.length === 0) return { status: "missing_history", bar: null };
  let chosen = null;
  for (const bar of bars) {
    if (bar.date <= targetDateKey) chosen = bar;
    else break;
  }
  if (!chosen) return { status: "insufficient_start_history", bar: null };
  const staleDays = daysBetween(chosen.date, targetDateKey);
  if (Number.isFinite(staleDays) && staleDays > maxStaleDays) {
    return { status: "stale_price", bar: chosen, stale_days: staleDays };
  }
  return { status: "ok", bar: chosen, stale_days: staleDays };
}

export function computeTrailingReturn(rawBars, horizon, endDateKey, opts = {}) {
  const years = HORIZON_YEARS[horizon];
  if (!years) throw new Error(`Unsupported trailing horizon: ${horizon}`);
  const startDateKey = subtractYears(endDateKey, years);
  const maxStaleDays = opts.maxStaleDays ?? 10;
  const entry = closeAtOrBefore(rawBars, startDateKey, maxStaleDays);
  const exit = closeAtOrBefore(rawBars, endDateKey, maxStaleDays);
  if (entry.status !== "ok") {
    return {
      status: entry.status,
      horizon,
      from_date: startDateKey,
      to_date: endDateKey,
      entry_date: entry.bar?.date || null,
      exit_date: exit.bar?.date || null,
      return_pct: null,
    };
  }
  if (exit.status !== "ok") {
    return {
      status: exit.status,
      horizon,
      from_date: startDateKey,
      to_date: endDateKey,
      entry_date: entry.bar?.date || null,
      exit_date: exit.bar?.date || null,
      return_pct: null,
    };
  }
  const ret = ((exit.bar.close - entry.bar.close) / entry.bar.close) * 100;
  return {
    status: "ok",
    horizon,
    from_date: startDateKey,
    to_date: endDateKey,
    entry_date: entry.bar.date,
    exit_date: exit.bar.date,
    entry_price: round2(entry.bar.close),
    exit_price: round2(exit.bar.close),
    return_pct: round2(ret),
  };
}

export function buildCurrentCohortRows(picksData, opts = {}) {
  const cohorts = normalizeTrailingCohorts(opts.cohorts);
  const sectionKeys = new Set(normalizeSectionKeys(opts.sections));
  const includeEmptySections = opts.includeEmptySections === true;
  return buildDailySectionCohortRows(picksData, { cohorts })
    .filter((row) => sectionKeys.has(row.sectionKey))
    .filter((row) => includeEmptySections || (row.actual_cohort_size || 0) > 0);
}

function average(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return null;
  return clean.reduce((sum, v) => sum + v, 0) / clean.length;
}

export function proxyScoreFromAlpha(alphaPct, coveragePct, minCoveragePct = DEFAULT_MIN_COVERAGE_PCT) {
  if (!Number.isFinite(alphaPct) || !Number.isFinite(coveragePct) || coveragePct < minCoveragePct) return null;
  if (alphaPct <= -25) return 2;
  if (alphaPct <= -10) return 4;
  if (alphaPct < 0) return 5;
  if (alphaPct < 10) return 6;
  if (alphaPct < 25) return 7;
  if (alphaPct < 50) return 8;
  return 9;
}

export function auditCohortTrailingReturn(row, historiesBySymbol, benchmarkBars, horizon, opts = {}) {
  const endDateKey = opts.endDate || toDateKey(row?.snapshotAt) || new Date().toISOString().slice(0, 10);
  const minCoveragePct = opts.minCoveragePct ?? DEFAULT_MIN_COVERAGE_PCT;
  const frictionBps = num(opts.frictionBps) ?? DEFAULT_FRICTION_BPS;
  const constituents = Array.isArray(row?.constituents) ? row.constituents : [];
  const benchmark = computeTrailingReturn(benchmarkBars, horizon, endDateKey, opts);
  const symbolResults = constituents.map((c) => {
    const symbol = c?.symbol || canonicalYahooSymbol(c?.ticker);
    const result = computeTrailingReturn(historiesBySymbol?.get?.(symbol) || historiesBySymbol?.[symbol] || [], horizon, endDateKey, opts);
    return {
      ticker: c?.ticker || null,
      symbol,
      rank: c?.rank || null,
      name: c?.name || null,
      score: c?.score ?? null,
      status: result.status,
      from_date: result.from_date,
      to_date: result.to_date,
      entry_date: result.entry_date || null,
      exit_date: result.exit_date || null,
      entry_price: result.entry_price ?? null,
      exit_price: result.exit_price ?? null,
      return_pct: result.return_pct,
    };
  });
  const covered = symbolResults.filter((r) => Number.isFinite(r.return_pct));
  const sectionReturn = average(covered.map((r) => r.return_pct));
  const netReturn = Number.isFinite(sectionReturn) ? sectionReturn - (frictionBps / 100) : null;
  const coveragePct = constituents.length > 0 ? (covered.length / constituents.length) * 100 : 0;
  const benchmarkReturn = Number.isFinite(benchmark.return_pct) ? benchmark.return_pct : null;
  const alphaPct = Number.isFinite(sectionReturn) && Number.isFinite(benchmarkReturn)
    ? sectionReturn - benchmarkReturn
    : null;
  const netAlphaPct = Number.isFinite(netReturn) && Number.isFinite(benchmarkReturn)
    ? netReturn - benchmarkReturn
    : null;
  const coveragePass = coveragePct >= minCoveragePct;
  const proxyScore = proxyScoreFromAlpha(alphaPct, coveragePct, minCoveragePct);
  const qualityFlags = [];
  if (!coveragePass) qualityFlags.push(`coverage_below_${minCoveragePct}`);
  if (benchmark.status !== "ok") qualityFlags.push(`benchmark_${benchmark.status}`);
  const missingCount = constituents.length - covered.length;
  if (missingCount > 0) qualityFlags.push(`missing_symbol_returns:${missingCount}`);

  return {
    schema_version: CURRENT_COHORT_TRAILING_SCHEMA_VERSION,
    evidence_basis: CURRENT_COHORT_EVIDENCE_BASIS,
    evidence_label: CURRENT_COHORT_EVIDENCE_LABEL,
    claim_allowed: false,
    hindsight_bias: true,
    survivorship_bias: true,
    horizon,
    sectionKey: row?.sectionKey || null,
    type: row?.type || null,
    label: row?.label || null,
    requested_cohort_size: row?.requested_cohort_size ?? null,
    actual_cohort_size: constituents.length,
    cohort_label: row?.cohort_label || null,
    from_date: benchmark.from_date || subtractYears(endDateKey, HORIZON_YEARS[horizon]),
    to_date: endDateKey,
    weighting: "equal_weight_current_cohort",
    benchmark: {
      ...DEFAULT_BENCHMARK,
      return_pct: benchmarkReturn,
      status: benchmark.status,
      entry_date: benchmark.entry_date || null,
      exit_date: benchmark.exit_date || null,
    },
    n_constituents: constituents.length,
    n_with_return: covered.length,
    coverage_pct: round1(coveragePct),
    coverage_pass: coveragePass,
    section_return_pct: round2(sectionReturn),
    estimated_friction_bps: frictionBps,
    estimated_net_return_pct: round2(netReturn),
    alpha_pct: round2(alphaPct),
    estimated_net_alpha_pct: round2(netAlphaPct),
    performance_proxy_score: proxyScore,
    evidence_quality_score: coveragePass ? 2 : 1,
    quality_flags: [...new Set(qualityFlags)],
    constituents: symbolResults,
  };
}

export function buildCurrentCohortTrailingAudit(picksData, historiesBySymbol, benchmarkBars, opts = {}) {
  const horizons = normalizeTrailingHorizons(opts.horizons);
  const cohorts = normalizeTrailingCohorts(opts.cohorts);
  const rows = buildCurrentCohortRows(picksData, { ...opts, cohorts });
  const results = [];
  for (const horizon of horizons) {
    for (const row of rows) {
      results.push(auditCohortTrailingReturn(row, historiesBySymbol, benchmarkBars, horizon, opts));
    }
  }
  const snapshotAt = picksData?.scanned_at || picksData?.generated_at || null;
  const byHorizon = {};
  for (const horizon of horizons) {
    byHorizon[horizon] = results
      .filter((r) => r.horizon === horizon)
      .sort((a, b) => {
        const aScore = Number.isFinite(a.alpha_pct) ? a.alpha_pct : -Infinity;
        const bScore = Number.isFinite(b.alpha_pct) ? b.alpha_pct : -Infinity;
        return bScore - aScore;
      });
  }
  return {
    schema_version: CURRENT_COHORT_TRAILING_SCHEMA_VERSION,
    generated_at: opts.generatedAt || new Date().toISOString(),
    mode: CURRENT_COHORT_EVIDENCE_BASIS,
    title: "India SWS current-cohort trailing return audit - not a held-cohort backtest",
    claim_allowed: false,
    evidence_basis: CURRENT_COHORT_EVIDENCE_BASIS,
    evidence_label: CURRENT_COHORT_EVIDENCE_LABEL,
    caveats: [
      "3y/5y results use today's surviving SWS cohorts projected backward.",
      "This is not a realized Track Record or point-in-time section backtest.",
      "Positive proxy alpha must not be shown as an outperformance claim.",
      "Yahoo Finance price returns exclude dividends and may differ from TRI benchmarks.",
    ],
    config: {
      horizons,
      cohorts,
      sections: normalizeSectionKeys(opts.sections),
      min_coverage_pct: opts.minCoveragePct ?? DEFAULT_MIN_COVERAGE_PCT,
      friction_bps: num(opts.frictionBps) ?? DEFAULT_FRICTION_BPS,
      benchmark: DEFAULT_BENCHMARK,
      end_date: opts.endDate || toDateKey(snapshotAt) || null,
    },
    source: {
      picks_scanned_at: picksData?.scanned_at || null,
      picks_schema_version: picksData?.schema_version || null,
      picks_scoring_version: picksData?.scoring_version || null,
      universe_size: picksData?.universe_size ?? null,
      scored_count: picksData?.scored_count ?? null,
      committed_sws_snapshot_start: opts.committedSwsSnapshotStart || null,
    },
    results,
    by_horizon: byHorizon,
    section_confidence: buildSectionConfidenceSummary(results),
  };
}

export function buildSectionConfidenceSummary(results) {
  const bySection = new Map();
  for (const row of Array.isArray(results) ? results : []) {
    const key = row.sectionKey || row.type || row.label;
    if (!key) continue;
    if (!bySection.has(key)) {
      bySection.set(key, {
        sectionKey: row.sectionKey,
        label: row.label,
        rows: [],
      });
    }
    bySection.get(key).rows.push(row);
  }
  const summaries = [];
  for (const item of bySection.values()) {
    const rows = item.rows;
    const coveragePassRows = rows.filter((r) => r.coverage_pass && Number.isFinite(r.alpha_pct));
    const byHorizon = {};
    for (const horizon of [...new Set(rows.map((r) => r.horizon).filter(Boolean))]) {
      const hRows = rows
        .filter((r) => r.horizon === horizon && r.coverage_pass && Number.isFinite(r.alpha_pct))
        .sort((a, b) => b.alpha_pct - a.alpha_pct);
      byHorizon[horizon] = hRows[0]
        ? {
          best_cohort: hRows[0].requested_cohort_size,
          alpha_pct: hRows[0].alpha_pct,
          return_pct: hRows[0].section_return_pct,
          coverage_pct: hRows[0].coverage_pct,
        }
        : null;
    }
    const avgAlpha = average(coveragePassRows.map((r) => r.alpha_pct));
    const minCoverage = coveragePassRows.length
      ? Math.min(...coveragePassRows.map((r) => r.coverage_pct).filter(Number.isFinite))
      : null;
    const coveragePassRate = rows.length ? (coveragePassRows.length / rows.length) * 100 : 0;
    const horizonsWithPass = new Set(coveragePassRows.map((r) => r.horizon)).size;
    const proxyScore = coveragePassRows.length
      ? Math.min(9, Math.max(4, Math.round(
        4 +
        Math.min(3, (avgAlpha || 0) / 75) +
        Math.min(1, coveragePassRate / 50) +
        Math.min(1, horizonsWithPass / 2)
      )))
      : null;
    summaries.push({
      sectionKey: item.sectionKey,
      label: item.label,
      claim_allowed: false,
      evidence_quality_score: coveragePassRows.length ? 2 : 1,
      confidence_proxy_score: proxyScore,
      coverage_pass_rows: coveragePassRows.length,
      total_rows: rows.length,
      coverage_pass_rate_pct: round1(coveragePassRate),
      horizons_with_coverage: horizonsWithPass,
      avg_alpha_pct: round2(avgAlpha),
      min_coverage_pct: round1(minCoverage),
      best_by_horizon: byHorizon,
    });
  }
  return summaries.sort((a, b) => {
    const scoreDiff = (b.confidence_proxy_score ?? -Infinity) - (a.confidence_proxy_score ?? -Infinity);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.avg_alpha_pct ?? -Infinity) - (a.avg_alpha_pct ?? -Infinity);
  });
}

function fmtPct(value) {
  return Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "n/a";
}

function scoreText(value) {
  return Number.isFinite(value) ? `${value}/10` : "blocked";
}

export function renderCurrentCohortTrailingMarkdown(payload) {
  const lines = [];
  lines.push(`# ${payload.title}`);
  lines.push("");
  lines.push("## Uncomfortable Answer");
  lines.push("");
  lines.push("Hard evidence: the 3y/5y numbers below are not a realized SWS Track Record. They are current-cohort trailing returns and are deliberately marked `claim_allowed: false`.");
  lines.push("");
  lines.push("## Source");
  lines.push("");
  lines.push(`- Picks scanned at: ${payload.source?.picks_scanned_at || "unknown"}`);
  lines.push(`- Scoring version: ${payload.source?.picks_scoring_version || "unknown"}`);
  lines.push(`- Committed SWS snapshot start: ${payload.source?.committed_sws_snapshot_start || "unknown"}`);
  lines.push(`- Benchmark: ${payload.config?.benchmark?.label || DEFAULT_BENCHMARK.label} (${payload.config?.benchmark?.symbol || DEFAULT_BENCHMARK.symbol})`);
  lines.push("");
  lines.push("## Result Matrix");
  lines.push("");
  lines.push("| Horizon | Section | Cohort | Coverage | Return | Benchmark | Alpha | Proxy score | Evidence score | Claim |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const row of payload.results || []) {
    lines.push([
      row.horizon,
      row.label || row.sectionKey,
      row.requested_cohort_size,
      `${row.coverage_pct ?? 0}%`,
      fmtPct(row.section_return_pct),
      fmtPct(row.benchmark?.return_pct),
      fmtPct(row.alpha_pct),
      scoreText(row.performance_proxy_score),
      scoreText(row.evidence_quality_score),
      row.claim_allowed ? "allowed" : "blocked",
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  lines.push("## Buy-Section Confidence Ranking");
  lines.push("");
  lines.push("Proxy confidence is capped because this is current-cohort trailing data, not a held-cohort backtest. Evidence quality stays low even when proxy performance is strong.");
  lines.push("");
  lines.push("| Rank | Section | Proxy confidence | Evidence quality | Coverage-pass rows | Avg alpha | Best 3y | Best 5y | Claim |");
  lines.push("| ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- |");
  (payload.section_confidence || []).forEach((row, idx) => {
    const best3 = row.best_by_horizon?.["3y"];
    const best5 = row.best_by_horizon?.["5y"];
    const best3Text = best3 ? `top ${best3.best_cohort}, ${fmtPct(best3.alpha_pct)}` : "blocked";
    const best5Text = best5 ? `top ${best5.best_cohort}, ${fmtPct(best5.alpha_pct)}` : "blocked";
    lines.push([
      idx + 1,
      row.label || row.sectionKey,
      scoreText(row.confidence_proxy_score),
      scoreText(row.evidence_quality_score),
      `${row.coverage_pass_rows}/${row.total_rows}`,
      fmtPct(row.avg_alpha_pct),
      best3Text,
      best5Text,
      row.claim_allowed ? "allowed" : "blocked",
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  });
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  for (const caveat of payload.caveats || []) lines.push(`- ${caveat}`);
  lines.push("");
  lines.push("## Reproducibility");
  lines.push("");
  lines.push("```bash");
  lines.push("git log --follow --diff-filter=A -- data/sws/picks-latest.json");
  lines.push("node scripts/sws-current-cohort-trailing-audit.mjs --horizons=3y,5y --cohorts=3,5,10,20");
  lines.push("```");
  lines.push("");
  return `${lines.join("\n")}\n`;
}
