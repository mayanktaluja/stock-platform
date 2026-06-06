import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPERIMENTAL_FORECAST_SCHEMA_VERSION = "experimental-forecast-overlay-v1";
export const EXPERIMENTAL_FORECAST_FILE = "chronos-forecast-latest.json";
export const EXPERIMENTAL_FORECAST_HEALTH_FILE = "chronos-forecast-health.json";
export const FORECAST_SECTION_KEY = "best_fundamentals";
export const FORECAST_SECTION_LIMIT = 100;

export const HORIZON_TRADING_SESSIONS = Object.freeze({
  "1D": 1,
  "7D": 5,
  "30D": 21,
  "3M": 63,
  "1Y": 252,
  "3Y": 756,
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SWS_REPO_ROOT_OVERRIDE
  ? path.resolve(process.cwd(), process.env.SWS_REPO_ROOT_OVERRIDE)
  : path.resolve(__dirname, "..");

export const FORECAST_ARTIFACT_PATH = path.join(REPO_ROOT, "data", "sws", EXPERIMENTAL_FORECAST_FILE);
export const FORECAST_HEALTH_PATH = path.join(REPO_ROOT, "data", "sws", EXPERIMENTAL_FORECAST_HEALTH_FILE);
export const PICKS_LATEST_PATH = path.join(REPO_ROOT, "data", "sws", "picks-latest.json");

const FORBIDDEN_KEYS = new Set([
  "action",
  "buy",
  "entry",
  "hold",
  "position_size",
  "recommendation",
  "score",
  "sell",
  "sizing",
  "stop",
  "target",
  "top_up",
  "top-up",
  "trim",
  "verdict",
]);

const FORBIDDEN_TEXT = /\b(BUY|SELL|HOLD|TRIM|TOP[- ]?UP)\b/i;

let cache = {
  artifactPath: null,
  picksPath: null,
  artifactMtimeMs: -1,
  picksMtimeMs: -1,
  loaded: null,
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function statMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return -1;
  }
}

export function normalizeTicker(ticker) {
  const key = String(ticker || "").trim().toUpperCase().replace(/\.(NS|BO)$/, "");
  return key || null;
}

export function getBestFundamentalsUniverse(picks, limit = FORECAST_SECTION_LIMIT) {
  const rows = Array.isArray(picks?.sections?.[FORECAST_SECTION_KEY])
    ? picks.sections[FORECAST_SECTION_KEY]
    : [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const ticker = normalizeTicker(row?.ticker);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({
      ticker,
      name: row?.name || ticker,
      sector: row?.sector || null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function digestForecastUniverse(tickers) {
  const normalized = (Array.isArray(tickers) ? tickers : [])
    .map((item) => typeof item === "string" ? normalizeTicker(item) : normalizeTicker(item?.ticker))
    .filter(Boolean);
  return crypto.createHash("sha256").update(normalized.join("\n")).digest("hex");
}

export function buildCurrentForecastSource(picks) {
  const universe = getBestFundamentalsUniverse(picks);
  return {
    section: FORECAST_SECTION_KEY,
    limit: FORECAST_SECTION_LIMIT,
    scanned_at: picks?.scanned_at || null,
    tickers: universe.map((row) => row.ticker),
    ticker_digest: digestForecastUniverse(universe),
  };
}

function hasForbiddenContent(value, trail = []) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some((item, idx) => hasForbiddenContent(item, trail.concat(String(idx))));
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = String(key).toLowerCase();
      if (FORBIDDEN_KEYS.has(normalizedKey)) return true;
      if (hasForbiddenContent(nested, trail.concat(key))) return true;
    }
    return false;
  }
  if (typeof value === "string") {
    const joinedPath = trail.join(".").toLowerCase();
    if (joinedPath.includes("read") || joinedPath.includes("label") || joinedPath.includes("reason")) {
      return FORBIDDEN_TEXT.test(value);
    }
  }
  return false;
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sanitizeHorizon(label, row) {
  if (!row || typeof row !== "object") return null;
  const medianReturnPct = finiteNumber(row.median_return_pct);
  const q10ReturnPct = finiteNumber(row.q10_return_pct);
  const q90ReturnPct = finiteNumber(row.q90_return_pct);
  if (medianReturnPct == null || q10ReturnPct == null || q90ReturnPct == null) return null;
  return {
    label,
    trading_sessions: HORIZON_TRADING_SESSIONS[label],
    median_price: finiteNumber(row.median_price),
    q10_price: finiteNumber(row.q10_price),
    q90_price: finiteNumber(row.q90_price),
    median_return_pct: medianReturnPct,
    q10_return_pct: q10ReturnPct,
    q90_return_pct: q90ReturnPct,
  };
}

function sanitizeForecastRow(row) {
  if (!row || typeof row !== "object") return null;
  if (hasForbiddenContent(row)) return null;
  const ticker = normalizeTicker(row.ticker);
  if (!ticker || row.status !== "ok") return null;

  const horizons = {};
  for (const label of Object.keys(HORIZON_TRADING_SESSIONS)) {
    const horizon = sanitizeHorizon(label, row.horizons?.[label]);
    if (!horizon) return null;
    horizons[label] = horizon;
  }

  const input = row.input && typeof row.input === "object" ? row.input : {};
  const interpretation = row.interpretation && typeof row.interpretation === "object" ? row.interpretation : {};
  return {
    schema_version: EXPERIMENTAL_FORECAST_SCHEMA_VERSION,
    ticker,
    yahoo_symbol: row.yahoo_symbol || `${ticker}.NS`,
    generated_at: row.generated_at || null,
    selected_model_id: row.selected_model_id || null,
    runtime_package: row.runtime_package || null,
    runtime_version: row.runtime_version || null,
    fallback_reason: row.fallback_reason || null,
    input: {
      bar_count: finiteNumber(input.bar_count),
      first_date: input.first_date || null,
      last_date: input.last_date || null,
      last_close: finiteNumber(input.last_close),
      missing_bar_count: finiteNumber(input.missing_bar_count) || 0,
      source: input.source || "yahoo-finance2",
      frequency: input.frequency || "1d_trading_sessions",
    },
    horizons,
    interpretation: {
      label: interpretation.label || "Neutral / no edge",
      read: interpretation.read || "Experimental model read is neutral.",
      signal_strength: interpretation.signal_strength || "LOW",
    },
  };
}

export function validateForecastArtifact(artifact, picks) {
  if (!artifact || typeof artifact !== "object") {
    return { ok: false, reason: "artifact_missing" };
  }
  if (artifact.schema_version !== EXPERIMENTAL_FORECAST_SCHEMA_VERSION) {
    return { ok: false, reason: "schema_version" };
  }
  if (hasForbiddenContent(artifact)) {
    return { ok: false, reason: "forbidden_content" };
  }

  const currentSource = buildCurrentForecastSource(picks);
  const source = artifact.source || {};
  if (source.section !== FORECAST_SECTION_KEY) return { ok: false, reason: "source_section" };
  if (source.scanned_at !== currentSource.scanned_at) return { ok: false, reason: "source_scanned_at" };
  if (source.ticker_digest !== currentSource.ticker_digest) return { ok: false, reason: "source_ticker_digest" };

  const rows = artifact.forecasts && typeof artifact.forecasts === "object" ? artifact.forecasts : {};
  const forecasts = {};
  for (const ticker of currentSource.tickers) {
    const sanitized = sanitizeForecastRow(rows[ticker]);
    if (sanitized) forecasts[ticker] = sanitized;
  }

  return {
    ok: true,
    source: currentSource,
    forecasts,
  };
}

export function loadExperimentalForecastOverlay({
  artifactPath = FORECAST_ARTIFACT_PATH,
  picksPath = PICKS_LATEST_PATH,
  force = false,
} = {}) {
  const artifactMtimeMs = statMtime(artifactPath);
  const picksMtimeMs = statMtime(picksPath);
  if (
    !force &&
    cache.artifactPath === artifactPath &&
    cache.picksPath === picksPath &&
    cache.artifactMtimeMs === artifactMtimeMs &&
    cache.picksMtimeMs === picksMtimeMs
  ) {
    return cache.loaded;
  }

  let loaded = { ok: false, reason: "unavailable", forecasts: {} };
  try {
    const picks = readJson(picksPath);
    const artifact = readJson(artifactPath);
    loaded = validateForecastArtifact(artifact, picks);
    if (!loaded.ok) loaded.forecasts = {};
  } catch (err) {
    loaded = { ok: false, reason: err?.code || "read_failed", forecasts: {} };
  }

  cache = { artifactPath, picksPath, artifactMtimeMs, picksMtimeMs, loaded };
  return loaded;
}

export function getExperimentalForecastForTicker(ticker, opts = {}) {
  const key = normalizeTicker(ticker);
  if (!key) return null;
  const loaded = loadExperimentalForecastOverlay(opts);
  if (!loaded.ok) return null;
  return loaded.forecasts?.[key] || null;
}
