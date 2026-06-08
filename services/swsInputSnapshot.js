import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const INPUT_SIGNATURE_SCHEMA_VERSION = 1;
export const FUNDAMENTAL_CHANGES_SCHEMA_VERSION = 1;

const PILLAR_KEYS = [
  "value",
  "future",
  "past",
  "health",
  "dividend",
  "valuation",
  "future_growth",
  "past_performance",
  "financial_health",
  "dividends",
];

const QUALITY_FIELDS = [
  "insufficient",
  "insufficient_count",
  "checked_count",
  "affected_pillars",
  "by_pillar",
];

const FISCAL_FIELDS = [
  "financial_year_end",
  "next_report_date",
  "last_report_date",
  "current_fiscal_year",
  "fiscal_year",
  "latest_period",
  "latest_period_end",
];

function stableNormalize(value) {
  if (Array.isArray(value)) {
    return value.map(stableNormalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = stableNormalize(value[key]);
    }
    return out;
  }
  return value;
}

export function stableHash(value, length = 24) {
  return createHash("sha256")
    .update(JSON.stringify(stableNormalize(value)))
    .digest("hex")
    .slice(0, length);
}

export function canonicalSwsTicker(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/\.(NS|BO)$/i, "");
}

function readJson(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function numberOrNull(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** decimals;
  return Math.round(n * scale) / scale;
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj && obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

function upsideBand(upside) {
  const n = Number(upside);
  if (!Number.isFinite(n)) return null;
  if (n >= 50) return "DEEP_DISCOUNT";
  if (n >= 20) return "DISCOUNT";
  if (n >= -10) return "FAIR";
  if (n >= -35) return "EXPENSIVE";
  return "VERY_EXPENSIVE";
}

function normalizeStatements(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (typeof item === "string") return item.trim();
      return String(item?.title || item?.text || item?.name || item?.description || "").trim();
    })
    .filter(Boolean);
}

function buildForecastFields(deep) {
  const financials = deep?.financials || {};
  const overview = deep?.overview || {};
  return stableNormalize({
    earnings_growth_annual: financials.earnings_growth_annual ?? overview.earnings_growth_annual ?? null,
    revenue_growth_annual: financials.revenue_growth_annual ?? overview.revenue_growth_annual ?? null,
    eps_growth_annual: financials.eps_growth_annual ?? overview.eps_growth_annual ?? null,
    future_roe: financials.future_roe ?? overview.future_roe ?? null,
    analyst_count: financials.analyst_count ?? overview.analyst_count ?? null,
    forecast_period_years: financials.forecast_period_years ?? overview.forecast_period_years ?? null,
    earnings_forecast: financials.earnings_forecast ?? null,
    revenue_forecast: financials.revenue_forecast ?? null,
  });
}

function buildSignature(row, deep) {
  const ticker = canonicalSwsTicker(row?.ticker || deep?.ticker);
  const overview = deep?.overview || {};
  const snowflake = overview.snowflake || {};
  const dataQuality = overview.snowflake_data_quality || {};
  const rewards = normalizeStatements(overview.rewards);
  const risks = normalizeStatements(overview.risks);
  const forecast = buildForecastFields(deep);
  const fiscal = pick(deep?.fiscal || {}, FISCAL_FIELDS);

  const inputs = {
    ticker,
    name: row?.name || deep?.name || ticker,
    sector: row?.sector || deep?.sector || null,
    snowflake: {
      pillars: pick(snowflake, PILLAR_KEYS),
      total: numberOrNull(row?.snowflake_total ?? overview.snowflake_total, 1),
      data_quality: pick(dataQuality, QUALITY_FIELDS),
    },
    fair_value: {
      fair_value_inr: numberOrNull(row?.fair_value_inr ?? overview.fair_value_inr, 2),
      fair_value_confidence: row?.fair_value_confidence || null,
      fair_value_source: row?.fair_value_source || null,
      fv_reconcile_reason: row?.fv_reconcile_reason || null,
    },
    fiscal: stableNormalize(fiscal),
    forecast,
    statements: {
      rewards_count: rewards.length,
      rewards_hash: stableHash(rewards),
      risks_count: risks.length,
      risks_hash: stableHash(risks),
    },
  };

  return {
    ticker,
    name: inputs.name,
    sector: inputs.sector,
    signature_hash: stableHash(inputs),
    diagnostics: {
      v4_score: numberOrNull(row?.v4_score_100 ?? row?.v4_score, 1),
      v4_verdict: row?.v4_verdict || row?.composite_verdict || null,
      upside_pct: numberOrNull(row?.upside_pct ?? overview.upside_pct, 1),
      upside_band: upsideBand(row?.upside_pct ?? overview.upside_pct),
      valuation_band: row?.valuation_band || null,
    },
    inputs,
  };
}

function loadScoredRows(scoredUniversePath) {
  const data = readJson(scoredUniversePath, {});
  if (Array.isArray(data)) return data;
  return Array.isArray(data.stocks) ? data.stocks : [];
}

function loadDeepByTicker(deepDir) {
  const out = new Map();
  if (!existsSync(deepDir)) return out;
  for (const file of readdirSync(deepDir)) {
    if (!file.endsWith(".json")) continue;
    const deep = readJson(path.join(deepDir, file), null);
    const ticker = canonicalSwsTicker(deep?.ticker || file.replace(/\.json$/i, ""));
    if (ticker) out.set(ticker, deep);
  }
  return out;
}

export function buildInputSignatures({
  scoredUniversePath,
  deepDir,
  lastRefreshPath,
  generatedAt = new Date().toISOString(),
} = {}) {
  const rows = loadScoredRows(scoredUniversePath);
  const deepByTicker = loadDeepByTicker(deepDir);
  const lastRefresh = readJson(lastRefreshPath, {});
  const signatures = {};

  for (const row of rows) {
    const ticker = canonicalSwsTicker(row?.ticker);
    if (!ticker) continue;
    signatures[ticker] = buildSignature(row, deepByTicker.get(ticker));
  }

  return {
    schema_version: INPUT_SIGNATURE_SCHEMA_VERSION,
    generated_at: generatedAt,
    run_id: lastRefresh?.finished_at || lastRefresh?.started_at || generatedAt,
    source: {
      scored_universe: "data/sws/sws-scored-universe.json",
      deep_dir: "data/sws/deep",
      last_refresh: "data/sws/last-refresh.json",
    },
    signature_count: Object.keys(signatures).length,
    signatures,
  };
}

function pushChange(changes, field, previous, current, severity = "medium") {
  changes.push({ field, previous, current, severity });
}

function diffSignatures(previous, current) {
  const changes = [];
  const p = previous?.inputs || {};
  const c = current?.inputs || {};

  const pPillars = p.snowflake?.pillars || {};
  const cPillars = c.snowflake?.pillars || {};
  for (const key of new Set([...Object.keys(pPillars), ...Object.keys(cPillars)])) {
    if (pPillars[key] !== cPillars[key]) pushChange(changes, `snowflake.${key}`, pPillars[key] ?? null, cPillars[key] ?? null);
  }
  if (p.snowflake?.total !== c.snowflake?.total) {
    pushChange(changes, "snowflake.total", p.snowflake?.total ?? null, c.snowflake?.total ?? null, "high");
  }
  if (stableHash(p.snowflake?.data_quality || {}) !== stableHash(c.snowflake?.data_quality || {})) {
    const severity = Number(c.snowflake?.data_quality?.insufficient_count || 0) > Number(p.snowflake?.data_quality?.insufficient_count || 0)
      ? "high"
      : "medium";
    pushChange(changes, "snowflake.data_quality", p.snowflake?.data_quality || null, c.snowflake?.data_quality || null, severity);
  }

  const pDiag = previous?.diagnostics || {};
  const cDiag = current?.diagnostics || {};
  const scoreDelta = Math.abs(Number(cDiag.v4_score) - Number(pDiag.v4_score));
  if (Number.isFinite(scoreDelta) && scoreDelta >= 5) {
    pushChange(changes, "v4_score", pDiag.v4_score ?? null, cDiag.v4_score ?? null, scoreDelta >= 10 ? "high" : "medium");
  }
  if (pDiag.v4_verdict !== cDiag.v4_verdict) {
    pushChange(changes, "v4_verdict", pDiag.v4_verdict ?? null, cDiag.v4_verdict ?? null, "high");
  }

  for (const key of ["fair_value_confidence", "fair_value_source", "fv_reconcile_reason"]) {
    if (p.fair_value?.[key] !== c.fair_value?.[key]) {
      pushChange(changes, `fair_value.${key}`, p.fair_value?.[key] ?? null, c.fair_value?.[key] ?? null);
    }
  }
  if (p.fair_value?.fair_value_inr !== c.fair_value?.fair_value_inr) {
    pushChange(changes, "fair_value.fair_value_inr", p.fair_value?.fair_value_inr ?? null, c.fair_value?.fair_value_inr ?? null);
  }
  if (pDiag.upside_band !== cDiag.upside_band) {
    pushChange(changes, "fair_value.upside_band", pDiag.upside_band ?? null, cDiag.upside_band ?? null);
  }

  if (stableHash(p.fiscal || {}) !== stableHash(c.fiscal || {})) {
    pushChange(changes, "fiscal", p.fiscal || null, c.fiscal || null);
  }
  if (stableHash(p.forecast || {}) !== stableHash(c.forecast || {})) {
    pushChange(changes, "forecast", p.forecast || null, c.forecast || null);
  }

  for (const side of ["rewards", "risks"]) {
    const countKey = `${side}_count`;
    const hashKey = `${side}_hash`;
    if (p.statements?.[countKey] !== c.statements?.[countKey] || p.statements?.[hashKey] !== c.statements?.[hashKey]) {
      pushChange(changes, `statements.${side}`, p.statements?.[countKey] ?? 0, c.statements?.[countKey] ?? 0);
    }
  }

  return changes;
}

export function diffInputSignatures(previousSnapshot, currentSnapshot, generatedAt = new Date().toISOString()) {
  const previous = previousSnapshot?.signatures || {};
  const current = currentSnapshot?.signatures || {};
  const changes = [];

  for (const [ticker, currentSig] of Object.entries(current)) {
    const previousSig = previous[ticker];
    if (!previousSig) continue;
    if (previousSig.signature_hash === currentSig.signature_hash) continue;
    const fieldChanges = diffSignatures(previousSig, currentSig);
    if (!fieldChanges.length) continue;
    changes.push({
      ticker,
      name: currentSig.name || previousSig.name || ticker,
      sector: currentSig.sector || previousSig.sector || null,
      severity: fieldChanges.some((c) => c.severity === "high") ? "high" : "medium",
      change_hash: stableHash({ ticker, fieldChanges }),
      changes: fieldChanges,
    });
  }

  return {
    schema_version: FUNDAMENTAL_CHANGES_SCHEMA_VERSION,
    generated_at: generatedAt,
    run_id: currentSnapshot?.run_id || generatedAt,
    previous_run_id: previousSnapshot?.run_id || null,
    change_count: changes.length,
    changes,
  };
}
