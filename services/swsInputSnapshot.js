import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const INPUT_SIGNATURE_SCHEMA_VERSION = 1;
export const FUNDAMENTAL_CHANGES_SCHEMA_VERSION = 1;
export const CONFIRMED_FUNDAMENTAL_CHANGES_SCHEMA_VERSION = 2;
export const INPUT_ALERT_STATE_SCHEMA_VERSION = 2;
export const INPUT_ALERT_CONFIRMATION_POLICY = "two_consecutive_full_runs";
export const INPUT_ALERT_REQUIRED_CONFIRMATIONS = 2;

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

const SIGNAL_PILLAR_FIELDS = [
  "value",
  "future",
  "past",
  "health",
  "dividend",
];

const SIGNAL_PILLAR_ALIASES = {
  value: "value",
  valuation: "value",
  future: "future",
  future_growth: "future",
  past: "past",
  past_performance: "past",
  health: "health",
  financial_health: "health",
  dividend: "dividend",
  dividends: "dividend",
};

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
  runId = null,
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
    run_id: runId || lastRefresh?.finished_at || lastRefresh?.started_at || generatedAt,
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

function valueHash(value) {
  return stableHash(value, 32);
}

export function canonicalSwsInputSignalField(field) {
  const raw = String(field || "");
  if (raw === "fair_value.fair_value_inr" || raw === "fair_value.upside_band") return raw;
  if (!raw.startsWith("snowflake.")) return null;
  const pillar = SIGNAL_PILLAR_ALIASES[raw.slice("snowflake.".length)];
  return pillar ? `snowflake.${pillar}` : null;
}

function canonicalSignalChange(change) {
  const field = canonicalSwsInputSignalField(change?.field);
  if (!field) return null;
  return field === change.field ? change : { ...change, field };
}

function signalValuesFromSignature(sig) {
  const values = {};
  const pillars = sig?.inputs?.snowflake?.pillars || {};
  for (const pillar of SIGNAL_PILLAR_FIELDS) {
    const value = pillars[pillar] ?? pillars[Object.keys(SIGNAL_PILLAR_ALIASES).find((k) => SIGNAL_PILLAR_ALIASES[k] === pillar && pillars[k] !== undefined)];
    values[`snowflake.${pillar}`] = value ?? null;
  }
  values["fair_value.fair_value_inr"] = sig?.inputs?.fair_value?.fair_value_inr ?? null;
  values["fair_value.upside_band"] = sig?.diagnostics?.upside_band ?? null;
  return values;
}

function signalStateKey(ticker, field) {
  return `${canonicalSwsTicker(ticker)}|${field}`;
}

function emptyConfirmedState({ generatedAt, runId } = {}) {
  return {
    schema_version: INPUT_ALERT_STATE_SCHEMA_VERSION,
    confirmation_policy: INPUT_ALERT_CONFIRMATION_POLICY,
    generated_at: generatedAt || new Date().toISOString(),
    run_id: runId || null,
    entries: {},
  };
}

export function isConfirmedInputAlertState(state) {
  return state?.schema_version === INPUT_ALERT_STATE_SCHEMA_VERSION &&
    state?.confirmation_policy === INPUT_ALERT_CONFIRMATION_POLICY &&
    state?.entries && typeof state.entries === "object";
}

export function isSwsInputArtifactEmailEligible(artifact) {
  return artifact?.schema_version === CONFIRMED_FUNDAMENTAL_CHANGES_SCHEMA_VERSION &&
    artifact?.confirmation_policy === INPUT_ALERT_CONFIRMATION_POLICY &&
    artifact?.artifact_email_eligible === true;
}

function seedStateFromCurrent(currentSnapshot, generatedAt) {
  const state = emptyConfirmedState({ generatedAt, runId: currentSnapshot?.run_id || null });
  for (const [ticker, sig] of Object.entries(currentSnapshot?.signatures || {})) {
    const canonicalTicker = canonicalSwsTicker(ticker);
    for (const [field, value] of Object.entries(signalValuesFromSignature(sig))) {
      const key = signalStateKey(canonicalTicker, field);
      state.entries[key] = {
        ticker: canonicalTicker,
        field,
        confirmed_value: value,
        confirmed_hash: valueHash(value),
        pending_value: null,
        pending_hash: null,
        pending_count: 0,
        pending_since_run_id: null,
        last_seen_run_id: currentSnapshot?.run_id || null,
        updated_at: generatedAt,
      };
    }
  }
  return state;
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

export function buildConfirmedInputDiff({
  previousSnapshot = null,
  currentSnapshot = null,
  previousState = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const seeded = !isConfirmedInputAlertState(previousState);
  const rawDiff = diffInputSignatures(previousSnapshot, currentSnapshot, generatedAt);
  if (seeded) {
    const nextState = seedStateFromCurrent(currentSnapshot, generatedAt);
    return {
      diff: {
        schema_version: CONFIRMED_FUNDAMENTAL_CHANGES_SCHEMA_VERSION,
        confirmation_policy: INPUT_ALERT_CONFIRMATION_POLICY,
        artifact_email_eligible: true,
        state_seeded: true,
        generated_at: generatedAt,
        run_id: currentSnapshot?.run_id || generatedAt,
        previous_run_id: previousSnapshot?.run_id || null,
        raw_change_count: rawDiff.change_count || 0,
        change_count: 0,
        pending_count: 0,
        suppressed_unconfirmed_count: 0,
        changes: [],
      },
      state: nextState,
      rawDiff,
    };
  }

  const nextState = {
    ...emptyConfirmedState({ generatedAt, runId: currentSnapshot?.run_id || null }),
    entries: { ...(previousState.entries || {}) },
  };
  const changes = [];
  let pendingCount = 0;
  let suppressedUnconfirmedCount = 0;
  const rawSignalChangesByKey = new Map();

  for (const alert of rawDiff.changes || []) {
    const ticker = canonicalSwsTicker(alert?.ticker);
    for (const rawChange of alert?.changes || []) {
      const change = canonicalSignalChange(rawChange);
      if (!change) continue;
      rawSignalChangesByKey.set(signalStateKey(ticker, change.field), { alert, change });
    }
  }

  for (const [ticker, sig] of Object.entries(currentSnapshot?.signatures || {})) {
    const canonicalTicker = canonicalSwsTicker(ticker);
    for (const [field, currentValue] of Object.entries(signalValuesFromSignature(sig))) {
      const key = signalStateKey(canonicalTicker, field);
      const currentHash = valueHash(currentValue);
      const existing = nextState.entries[key] || {
        ticker: canonicalTicker,
        field,
        confirmed_value: currentValue,
        confirmed_hash: currentHash,
        pending_value: null,
        pending_hash: null,
        pending_count: 0,
        pending_since_run_id: null,
      };
      const rawSignal = rawSignalChangesByKey.get(key);

      if (!existing.confirmed_hash) {
        existing.confirmed_hash = valueHash(existing.confirmed_value);
      }

      if (currentHash === existing.confirmed_hash) {
        nextState.entries[key] = {
          ...existing,
          pending_value: null,
          pending_hash: null,
          pending_count: 0,
          pending_since_run_id: null,
          last_seen_run_id: currentSnapshot?.run_id || null,
          updated_at: generatedAt,
        };
        continue;
      }

      const nextPendingCount = existing.pending_hash === currentHash
        ? Number(existing.pending_count || 0) + 1
        : 1;

      if (nextPendingCount >= INPUT_ALERT_REQUIRED_CONFIRMATIONS) {
        const previousValue = existing.confirmed_value ?? null;
        const confirmedChange = {
          field,
          previous: previousValue,
          current: currentValue,
          severity: rawSignal?.change?.severity || "medium",
        };
        changes.push({
          ticker: canonicalTicker,
          name: sig.name || rawSignal?.alert?.name || canonicalTicker,
          sector: sig.sector || rawSignal?.alert?.sector || null,
          severity: confirmedChange.severity === "high" ? "high" : "medium",
          change_hash: stableHash({ ticker: canonicalTicker, field, previous: previousValue, current: currentValue }),
          changes: [confirmedChange],
        });
        nextState.entries[key] = {
          ticker: canonicalTicker,
          field,
          confirmed_value: currentValue,
          confirmed_hash: currentHash,
          pending_value: null,
          pending_hash: null,
          pending_count: 0,
          pending_since_run_id: null,
          last_seen_run_id: currentSnapshot?.run_id || null,
          updated_at: generatedAt,
        };
      } else {
        suppressedUnconfirmedCount++;
        pendingCount++;
        nextState.entries[key] = {
          ...existing,
          ticker: canonicalTicker,
          field,
          pending_value: currentValue,
          pending_hash: currentHash,
          pending_count: nextPendingCount,
          pending_since_run_id: existing.pending_hash === currentHash
            ? existing.pending_since_run_id || currentSnapshot?.run_id || null
            : currentSnapshot?.run_id || null,
          last_seen_run_id: currentSnapshot?.run_id || null,
          updated_at: generatedAt,
        };
      }
    }
  }

  const mergedByTicker = [];
  const byTicker = new Map();
  for (const change of changes) {
    if (!byTicker.has(change.ticker)) {
      byTicker.set(change.ticker, {
        ticker: change.ticker,
        name: change.name,
        sector: change.sector,
        severity: "medium",
        changes: [],
      });
      mergedByTicker.push(byTicker.get(change.ticker));
    }
    const row = byTicker.get(change.ticker);
    row.changes.push(...change.changes);
    if (change.severity === "high") row.severity = "high";
  }
  for (const row of mergedByTicker) {
    row.change_hash = stableHash({ ticker: row.ticker, changes: row.changes });
  }

  return {
    diff: {
      schema_version: CONFIRMED_FUNDAMENTAL_CHANGES_SCHEMA_VERSION,
      confirmation_policy: INPUT_ALERT_CONFIRMATION_POLICY,
      artifact_email_eligible: true,
      state_seeded: false,
      generated_at: generatedAt,
      run_id: currentSnapshot?.run_id || generatedAt,
      previous_run_id: previousSnapshot?.run_id || null,
      raw_change_count: rawDiff.change_count || 0,
      change_count: mergedByTicker.length,
      pending_count: pendingCount,
      suppressed_unconfirmed_count: suppressedUnconfirmedCount,
      changes: mergedByTicker,
    },
    state: nextState,
    rawDiff,
  };
}
