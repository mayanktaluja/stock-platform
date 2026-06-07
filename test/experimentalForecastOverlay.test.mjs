import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EXPERIMENTAL_FORECAST_SCHEMA_VERSION,
  FORECAST_SCOPE_ALL_SECTIONS,
  HORIZON_TRADING_SESSIONS,
  buildCurrentForecastSource,
  digestForecastUniverse,
  getAllSectionsForecastUniverse,
  getBestFundamentalsUniverse,
  getExperimentalForecastForTicker,
  normalizeTicker,
  validateForecastArtifact,
} from "../services/experimentalForecastOverlay.js";

function picksWith(count = 3) {
  return {
    scanned_at: "2026-06-06T00:51:11.114Z",
    sections: {
      top_ranked_30_v4: [
        { ticker: "JSLL", name: "Jeena Sikho", sector: "Healthcare" },
        { ticker: "TMCV.NS", name: "Tata Motors CV", sector: "Autos" },
      ],
      best_fundamentals: Array.from({ length: count }, (_, i) => ({
        ticker: i === 0 ? "JSLL" : `TEST${i}`,
        name: `Test ${i}`,
        sector: "Healthcare",
      })),
    },
  };
}

function horizon(returnPct) {
  return {
    median_price: 100 + returnPct,
    q10_price: 80,
    q90_price: 130,
    median_return_pct: returnPct,
    q10_return_pct: -20,
    q90_return_pct: 30,
  };
}

function forecastRow(ticker = "JSLL", horizonLabels = Object.keys(HORIZON_TRADING_SESSIONS)) {
  const horizons = {};
  for (const label of horizonLabels) horizons[label] = horizon(label === "1Y" ? 12 : 2);
  return {
    ticker,
    yahoo_symbol: `${ticker}.NS`,
    status: "ok",
    generated_at: "2026-06-06T01:30:00.000Z",
    selected_model_id: "amazon/chronos-2",
    runtime_package: "chronos-forecasting",
    runtime_version: "2.2.2",
    input: {
      bar_count: 600,
      first_date: "2024-01-01",
      last_date: "2026-06-05",
      last_close: 100,
      missing_bar_count: 0,
      source: "yahoo-finance2",
      frequency: "1d_trading_sessions",
    },
    horizons,
    interpretation: {
      label: "Mild positive / high volatility",
      read: "Treat this as timing and risk context only.",
      signal_strength: "LOW",
    },
  };
}

function artifactFor(picks, overrides = {}) {
  const scope = overrides.scope || undefined;
  const limit = Object.prototype.hasOwnProperty.call(overrides, "limit") ? overrides.limit : undefined;
  const source = buildCurrentForecastSource(picks, { scope, limit });
  const horizonMap = overrides.horizons || HORIZON_TRADING_SESSIONS;
  return {
    schema_version: EXPERIMENTAL_FORECAST_SCHEMA_VERSION,
    generated_at: "2026-06-06T01:30:00.000Z",
    source: {
      section: source.section,
      scope: source.scope,
      limit: source.limit,
      scanned_at: source.scanned_at,
      ticker_digest: source.ticker_digest,
      sections_digest: source.sections_digest,
      sections: source.sections,
      section_counts: source.section_counts,
      tickers_count: source.tickers.length,
    },
    model: {
      primary_model_id: "amazon/chronos-2",
      fallback_model_id: "amazon/chronos-bolt-tiny",
      runtime_package: "chronos-forecasting",
      runtime_version: "2.2.2",
    },
    horizons: horizonMap,
    forecasts: {
      JSLL: forecastRow("JSLL", Object.keys(horizonMap)),
      TMCV: forecastRow("TMCV", Object.keys(horizonMap)),
    },
    skipped_symbols: [],
    ...overrides,
  };
}

test("best fundamentals universe is capped and normalized", () => {
  const picks = picksWith(120);
  const universe = getBestFundamentalsUniverse(picks);
  assert.equal(universe.length, 100);
  assert.equal(universe[0].ticker, "JSLL");
  assert.equal(normalizeTicker("jsll.ns"), "JSLL");
  assert.equal(digestForecastUniverse(universe), buildCurrentForecastSource(picks).ticker_digest);
});

test("all-sections universe dedupes across India sections", () => {
  const picks = picksWith();
  const universe = getAllSectionsForecastUniverse(picks);
  assert.deepEqual(universe.slice(0, 2).map((row) => row.ticker), ["JSLL", "TMCV"]);
  assert.equal(universe.filter((row) => row.ticker === "JSLL").length, 1);
  const source = buildCurrentForecastSource(picks, { scope: FORECAST_SCOPE_ALL_SECTIONS, limit: null });
  assert.equal(source.scope, FORECAST_SCOPE_ALL_SECTIONS);
  assert.equal(source.section, null);
  assert.ok(source.sections_digest);
});

test("valid artifact returns sanitized forecast rows", () => {
  const picks = picksWith();
  const result = validateForecastArtifact(artifactFor(picks), picks);
  assert.equal(result.ok, true);
  assert.equal(result.forecasts.JSLL.ticker, "JSLL");
  assert.equal(result.forecasts.JSLL.horizons["3Y"].trading_sessions, 756);
});

test("valid all-sections artifact may use a shorter horizon set", () => {
  const picks = picksWith();
  const horizons = { "1D": 1, "7D": 5, "30D": 21, "1Y": 252 };
  const result = validateForecastArtifact(artifactFor(picks, { scope: FORECAST_SCOPE_ALL_SECTIONS, limit: null, horizons }), picks);
  assert.equal(result.ok, true);
  assert.equal(result.forecasts.JSLL.horizons["1Y"].trading_sessions, 252);
  assert.equal(result.forecasts.JSLL.horizons["3Y"], undefined);
  assert.equal(result.forecasts.TMCV.ticker, "TMCV");
});

test("digest mismatch rejects stale forecasts", () => {
  const picks = picksWith();
  const artifact = artifactFor(picks, {
    source: {
      ...artifactFor(picks).source,
      ticker_digest: "bad",
    },
  });
  const result = validateForecastArtifact(artifact, picks);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "source_ticker_digest");
});

test("scanned_at mismatch rejects yesterday artifact", () => {
  const picks = picksWith();
  const artifact = artifactFor(picks, {
    source: {
      ...artifactFor(picks).source,
      scanned_at: "2026-06-05T00:00:00.000Z",
    },
  });
  const result = validateForecastArtifact(artifact, picks);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "source_scanned_at");
});

test("recommendation-like fields are rejected recursively", () => {
  const picks = picksWith();
  const artifact = artifactFor(picks);
  artifact.forecasts.JSLL.target = 150;
  const result = validateForecastArtifact(artifact, picks);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "forbidden_content");
});

test("reader returns null for missing or stale forecast", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-overlay-"));
  const picks = picksWith();
  const picksPath = path.join(dir, "picks-latest.json");
  const artifactPath = path.join(dir, "chronos-forecast-latest.json");
  fs.writeFileSync(picksPath, JSON.stringify(picks));
  fs.writeFileSync(artifactPath, JSON.stringify(artifactFor(picks)));
  assert.equal(getExperimentalForecastForTicker("JSLL.NS", { artifactPath, picksPath, force: true })?.ticker, "JSLL");
  fs.writeFileSync(artifactPath, JSON.stringify(artifactFor(picks, { schema_version: "bad" })));
  assert.equal(getExperimentalForecastForTicker("JSLL", { artifactPath, picksPath, force: true }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
