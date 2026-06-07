#!/usr/bin/env node
/**
 * Refresh the experimental Chronos forecast overlay for India SWS modals.
 *
 * Offline-only: Yahoo OHLCV and Python/Chronos run here, never in server.js.
 * The production route only reads data/sws/chronos-forecast-latest.json.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YahooFinance from "yahoo-finance2";
import {
  EXPERIMENTAL_FORECAST_FILE,
  EXPERIMENTAL_FORECAST_HEALTH_FILE,
  EXPERIMENTAL_FORECAST_SCHEMA_VERSION,
  FORECAST_SCOPE_BEST_FUNDAMENTALS,
  FORECAST_SCOPE_ALL_SECTIONS,
  FORECAST_SECTION_LIMIT,
  HORIZON_TRADING_SESSIONS,
  buildCurrentForecastSource,
  getForecastUniverse,
} from "../services/experimentalForecastOverlay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SWS_REPO_ROOT_OVERRIDE
  ? path.resolve(process.cwd(), process.env.SWS_REPO_ROOT_OVERRIDE)
  : path.resolve(__dirname, "..");

const DATA_DIR = path.join(REPO_ROOT, "data", "sws");
const PICKS_PATH = path.join(DATA_DIR, "picks-latest.json");
const OUT_PATH = path.join(DATA_DIR, EXPERIMENTAL_FORECAST_FILE);
const HEALTH_PATH = path.join(DATA_DIR, EXPERIMENTAL_FORECAST_HEALTH_FILE);
const OHLCV_CACHE_DIR = path.join(DATA_DIR, "chronos-ohlcv-cache");
const DEBUG_DIR = path.join(DATA_DIR, "chronos-debug");
const WORKER_PATH = path.join(REPO_ROOT, "scripts", "forecasting", "chronos_worker.py");

const DEFAULTS = {
  limit: FORECAST_SECTION_LIMIT,
  scope: process.env.SWS_CHRONOS_SCOPE || FORECAST_SCOPE_BEST_FUNDAMENTALS,
  horizons: HORIZON_TRADING_SESSIONS,
  concurrency: 4,
  minRows: 90,
  preferredRows: 128,
  historyDays: 1200,
  cacheTtlHours: 18,
  maxFetches: 100,
  timeoutSeconds: Number(process.env.SWS_CHRONOS_TIMEOUT_SECONDS || 3600),
  primaryModel: process.env.SWS_CHRONOS_MODEL || "amazon/chronos-2",
  fallbackModel: process.env.SWS_CHRONOS_FALLBACK_MODEL || "amazon/chronos-bolt-tiny",
};

function parseHorizonList(value) {
  const raw = String(value || "").trim();
  if (!raw) return HORIZON_TRADING_SESSIONS;
  const out = {};
  for (const part of raw.split(",")) {
    const label = part.trim().toUpperCase();
    if (!label) continue;
    if (!Object.prototype.hasOwnProperty.call(HORIZON_TRADING_SESSIONS, label)) {
      throw new Error(`Unknown Chronos horizon: ${label}`);
    }
    out[label] = HORIZON_TRADING_SESSIONS[label];
  }
  if (!Object.keys(out).length) throw new Error("At least one Chronos horizon is required");
  return out;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--limit") {
      const raw = String(argv[++i] || "").trim().toLowerCase();
      opts.limit = raw === "0" || raw === "all" || raw === "none" ? null : Math.max(1, Number(raw) || DEFAULTS.limit);
    }
    else if (a === "--scope") {
      const raw = String(argv[++i] || opts.scope).trim().toLowerCase().replace(/-/g, "_");
      opts.scope = raw === "all" ? FORECAST_SCOPE_ALL_SECTIONS : raw;
    }
    else if (a === "--horizons") opts.horizons = parseHorizonList(argv[++i]);
    else if (a === "--concurrency") opts.concurrency = Math.max(1, Number(argv[++i]) || DEFAULTS.concurrency);
    else if (a === "--min-rows") opts.minRows = Math.max(2, Number(argv[++i]) || DEFAULTS.minRows);
    else if (a === "--cache-ttl-hours") opts.cacheTtlHours = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--max-fetches") opts.maxFetches = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--timeout-seconds") opts.timeoutSeconds = Math.max(10, Number(argv[++i]) || DEFAULTS.timeoutSeconds);
    else if (a === "--primary-model") opts.primaryModel = String(argv[++i] || opts.primaryModel);
    else if (a === "--fallback-model") opts.fallbackModel = String(argv[++i] || opts.fallbackModel);
    else if (a === "--preflight") opts.preflight = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: node scripts/refresh-chronos-forecast.mjs [--scope best_fundamentals|all_sections|<section>] [--limit 100|all] [--horizons 1D,7D,30D,3M,1Y,3Y] [--concurrency 4] [--max-fetches 100] [--timeout-seconds 3600] [--preflight]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function yahooSymbolCandidates(ticker) {
  const key = String(ticker || "").trim().toUpperCase().replace(/\.(NS|BO)$/, "");
  return key ? [`${key}.NS`, `${key}.BO`] : [];
}

function toDateString(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function cachePathForYahooSymbol(yahooSymbol) {
  const safe = String(yahooSymbol).replace(/[^A-Z0-9._-]/gi, "_");
  return path.join(OHLCV_CACHE_DIR, `${safe}.json`);
}

function isCacheFresh(snapshot, ttlHours) {
  if (!snapshot?.fetched_at || ttlHours <= 0) return false;
  const ageMs = Date.now() - Date.parse(snapshot.fetched_at);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlHours * 3600_000;
}

export function normalizeAdjustedBars(quotes = []) {
  const rows = [];
  const seenDates = new Set();
  for (const q of quotes) {
    if (!q || q.close == null || q.open == null || q.high == null || q.low == null) continue;
    const close = Number(q.close);
    const adjClose = q.adjclose != null ? Number(q.adjclose) : close;
    const ratio = close > 0 && Number.isFinite(adjClose) ? adjClose / close : 1;
    const date = toDateString(q.date);
    if (seenDates.has(date)) continue;
    const row = {
      date,
      open: Number(q.open) * ratio,
      high: Number(q.high) * ratio,
      low: Number(q.low) * ratio,
      close: adjClose,
      volume: Number(q.volume || 0),
    };
    if ([row.open, row.high, row.low, row.close].every(Number.isFinite)) {
      seenDates.add(date);
      rows.push(row);
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

function qualityGateBars(bars, opts) {
  if (!Array.isArray(bars) || bars.length < opts.minRows) {
    return { ok: false, reason: "insufficient_history" };
  }
  for (let i = 1; i < bars.length; i += 1) {
    if (bars[i].date <= bars[i - 1].date) return { ok: false, reason: "unsorted_or_duplicate_dates" };
  }
  for (const bar of bars) {
    if (![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) {
      return { ok: false, reason: "non_finite_ohlc" };
    }
  }
  return { ok: true };
}

async function fetchYahooBars(yf, yahooSymbol, opts) {
  const cachePath = cachePathForYahooSymbol(yahooSymbol);
  const cached = readJson(cachePath);
  if (cached?.bars && isCacheFresh(cached, opts.cacheTtlHours)) return cached;

  const period2 = new Date();
  const period1 = new Date(period2);
  period1.setDate(period1.getDate() - opts.historyDays);
  const result = await yf.chart(yahooSymbol, {
    period1: toDateString(period1),
    period2: toDateString(period2),
    interval: "1d",
  });
  const bars = normalizeAdjustedBars(result?.quotes || []);
  const snapshot = {
    source: "yahoo-finance2",
    yahoo_symbol: yahooSymbol,
    fetched_at: new Date().toISOString(),
    bars,
  };
  writeJsonAtomic(cachePath, snapshot);
  return snapshot;
}

async function buildInputSeries(opts) {
  const picks = readJson(PICKS_PATH);
  if (!picks) throw new Error(`missing ${PICKS_PATH}`);
  const source = buildCurrentForecastSource(picks, { scope: opts.scope, limit: opts.limit });
  const universe = getForecastUniverse(picks, { scope: opts.scope, limit: opts.limit });
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });
  const queue = universe.slice();
  const symbols = [];
  const skipped = [];
  let fetches = 0;

  async function worker() {
    while (queue.length) {
      const stock = queue.shift();
      let selected = null;
      let selectedSnapshot = null;
      let lastReason = "no_yahoo_symbol";
      for (const yahooSymbol of yahooSymbolCandidates(stock.ticker)) {
        if (fetches >= opts.maxFetches) {
          lastReason = "max_fetches_reached";
          break;
        }
        fetches += 1;
        try {
          const snapshot = await fetchYahooBars(yf, yahooSymbol, opts);
          const gate = qualityGateBars(snapshot.bars, opts);
          if (gate.ok) {
            selected = yahooSymbol;
            selectedSnapshot = snapshot;
            break;
          }
          lastReason = gate.reason;
        } catch (err) {
          lastReason = `yahoo_error:${err?.message || "unknown"}`;
        }
      }
      if (!selected || !selectedSnapshot) {
        skipped.push({ ticker: stock.ticker, reason: lastReason, stage: "ohlcv" });
        continue;
      }
      symbols.push({
        ticker: stock.ticker,
        name: stock.name,
        sector: stock.sector,
        yahoo_symbol: selected,
        bars: selectedSnapshot.bars,
        input: {
          bar_count: selectedSnapshot.bars.length,
          first_date: selectedSnapshot.bars[0]?.date || null,
          last_date: selectedSnapshot.bars.at(-1)?.date || null,
          last_close: selectedSnapshot.bars.at(-1)?.close ?? null,
          missing_bar_count: 0,
          source: "yahoo-finance2",
          frequency: "1d_trading_sessions",
          quality_flags: selectedSnapshot.bars.length < opts.preferredRows ? ["short_history"] : [],
        },
      });
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  return { picks, source, symbols, skipped };
}

function runPythonWorker(input, opts) {
  return new Promise((resolve, reject) => {
    const python = process.env.FORECAST_PYTHON || process.env.PYTHON || "python3";
    const args = [
      WORKER_PATH,
      "--primary-model", opts.primaryModel,
      "--fallback-model", opts.fallbackModel,
    ];
    const child = spawn(python, args, {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
      reject(new Error(`chronos_timeout_${opts.timeoutSeconds}s`));
    }, opts.timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `chronos_worker_exit_${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`chronos_worker_bad_json:${err.message}`));
      }
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function buildArtifact({ source, workerOutput, skipped, horizons }) {
  const rows = Array.isArray(workerOutput?.forecasts) ? workerOutput.forecasts : [];
  const forecasts = {};
  for (const row of rows) {
    if (row?.ticker) forecasts[row.ticker] = row;
  }
  return {
    schema_version: EXPERIMENTAL_FORECAST_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    source: {
      scope: source.scope,
      section: source.section,
      limit: source.limit,
      scanned_at: source.scanned_at,
      ticker_digest: source.ticker_digest,
      sections_digest: source.sections_digest,
      sections: source.sections,
      section_counts: source.section_counts,
      tickers_count: source.tickers.length,
    },
    model: {
      primary_model_id: workerOutput?.primary_model_id || DEFAULTS.primaryModel,
      fallback_model_id: workerOutput?.fallback_model_id || DEFAULTS.fallbackModel,
      selected_model_id: workerOutput?.selected_model_id || workerOutput?.primary_model_id || DEFAULTS.primaryModel,
      fallback_reason: workerOutput?.fallback_reason || null,
      runtime_package: workerOutput?.runtime_package || "chronos-forecasting",
      runtime_version: workerOutput?.runtime_version || null,
    },
    horizons,
    forecasts,
    skipped_symbols: [
      ...skipped,
      ...(Array.isArray(workerOutput?.skipped_symbols) ? workerOutput.skipped_symbols : []),
    ],
  };
}

function writeHealth(status, details = {}) {
  const payload = {
    schema_version: "chronos-forecast-health-v1",
    generated_at: new Date().toISOString(),
    status,
    ...details,
  };
  writeJsonAtomic(HEALTH_PATH, payload);
  return payload;
}

async function preflight(opts) {
  const python = process.env.FORECAST_PYTHON || process.env.PYTHON || "python3";
  const result = await new Promise((resolve) => {
    const child = spawn(python, [WORKER_PATH, "--preflight"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const ok = result.code === 0;
  let preflightPayload = null;
  if (ok) {
    try {
      preflightPayload = JSON.parse(result.stdout || "{}");
    } catch (err) {
      writeHealth("runtime_unavailable", {
        preflight: null,
        error: `preflight_bad_json:${err.message}`,
      });
      return false;
    }
  }
  writeHealth(ok ? "ok" : "runtime_unavailable", {
    preflight: preflightPayload,
    error: ok ? null : (result.stderr || result.stdout).trim(),
  });
  return ok;
}

export async function refreshChronosForecast(opts = parseArgs()) {
  if (process.env.SWS_SKIP_CHRONOS === "1") {
    writeHealth("skipped", { reason: "SWS_SKIP_CHRONOS=1" });
    return { ok: true, skipped: true };
  }
  if (opts.preflight) {
    const ok = await preflight(opts);
    return { ok };
  }
  const runtimeOk = await preflight(opts);
  if (!runtimeOk) {
    return { ok: false, reason: "runtime_unavailable" };
  }

  let input;
  try {
    input = await buildInputSeries(opts);
  } catch (err) {
    writeHealth("degraded", { reason: "input_failed", error: err.message });
    return { ok: false, reason: "input_failed" };
  }

  try {
    const workerInput = {
      schema_version: "chronos-worker-input-v1",
      generated_at: new Date().toISOString(),
      horizons: opts.horizons,
      symbols: input.symbols,
    };
    console.error(`[chronos] scope=${input.source.scope} tickers=${input.source.tickers.length} inputs=${input.symbols.length} skipped_ohlcv=${input.skipped.length} horizons=${Object.keys(opts.horizons).join(",")}`);
    const workerOutput = await runPythonWorker(workerInput, opts);
    const artifact = buildArtifact({ source: input.source, workerOutput, skipped: input.skipped, horizons: opts.horizons });
    writeJsonAtomic(OUT_PATH, artifact);
    writeHealth("ok", {
      source: artifact.source,
      forecast_count: Object.keys(artifact.forecasts).length,
      skipped_count: artifact.skipped_symbols.length,
      artifact_sha256: sha256Text(JSON.stringify(artifact)),
    });
    return { ok: true, artifact };
  } catch (err) {
    writeHealth("degraded", {
      reason: "worker_failed",
      error: err.message,
      source: {
        section: input.source.section,
        scanned_at: input.source.scanned_at,
        ticker_digest: input.source.ticker_digest,
      },
      input_count: input.symbols.length,
      skipped_count: input.skipped.length,
      preserved_latest: fs.existsSync(OUT_PATH),
    });
    return { ok: false, reason: "worker_failed", error: err.message };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  refreshChronosForecast()
    .then((result) => {
      console.log(`[chronos] ${result.ok ? "ok" : "degraded"}${result.reason ? ` reason=${result.reason}` : ""}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[chronos] fatal: ${err.stack || err.message}`);
      process.exit(1);
    });
}
