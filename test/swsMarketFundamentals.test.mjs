import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MARKET_FUNDAMENTALS_SCHEMA_VERSION,
  compactFundamentalsRecord,
  createMarketFundamentalsFallbackReader,
  lookupMarketFundamentals,
  normalizeYahooFundamentals,
  yahooSymbolCandidates,
} from "../services/swsMarketFundamentals.js";

const NOW = Date.parse("2026-05-25T00:00:00.000Z");
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

test("normalizes Yahoo raw ratios into modal-ready percentages", () => {
  const record = normalizeYahooFundamentals({
    ticker: "ZVRA",
    yahooSymbol: "ZVRA",
    fetchedAt: "2026-05-25T00:00:00.000Z",
    summary: {
      financialData: {
        returnOnEquity: 0.362,
        returnOnAssets: 0.173,
        grossMargins: 0.619,
        operatingMargins: 0.581,
        profitMargins: 0.465,
        revenueGrowth: 0.112,
        earningsGrowth: -0.074,
        debtToEquity: 18.4,
        currentRatio: 2.51,
      },
      summaryDetail: {
        dividendYield: 0.0106,
        payoutRatio: 0.2785,
      },
    },
  });

  approx(record.roe_pct, 36.2);
  approx(record.roa_pct, 17.3);
  approx(record.gross_margin_pct, 61.9);
  approx(record.operating_margin_pct, 58.1);
  approx(record.net_margin_pct, 46.5);
  approx(record.revenue_growth_pct, 11.2);
  approx(record.earnings_growth_yoy_pct, -7.4);
  approx(record.dividend_yield_pct, 1.06);
  approx(record.payout_pct, 27.85);
});

test("Yahoo debtToEquity is treated as percent-like and not double-converted", () => {
  const record = normalizeYahooFundamentals({
    ticker: "2330.TW",
    yahooSymbol: "2330.TW",
    summary: { financialData: { debtToEquity: 18.4 } },
  });
  assert.equal(record.debt_to_equity_pct, 18.4);
});

test("US dotted share classes get Yahoo hyphen fallback candidates", () => {
  assert.deepEqual(yahooSymbolCandidates("BRK.B", "us"), ["BRK.B", "BRK-B"]);
  assert.deepEqual(yahooSymbolCandidates("005930.KS", "kr"), ["005930.KS"]);
  assert.deepEqual(yahooSymbolCandidates("2330.TW", "tw"), ["2330.TW"]);
  assert.deepEqual(yahooSymbolCandidates("8069.TWO", "tw"), ["8069.TWO"]);
});

test("missing Yahoo fields normalize to null, not zero", () => {
  const record = normalizeYahooFundamentals({
    ticker: "MISSING",
    yahooSymbol: "MISSING",
    summary: {
      financialData: {},
      defaultKeyStatistics: {},
      summaryDetail: {},
      price: {},
    },
    timeSeriesRows: [],
  });
  assert.equal(record.pe, null);
  assert.equal(record.roe_pct, null);
  assert.equal(record.current_ratio, null);
  assert.equal(record.net_cash, null);
});

test("compactFundamentalsRecord drops null and non-finite values", () => {
  assert.deepEqual(compactFundamentalsRecord({
    source: "yahoo-finance2",
    ticker: "AAPL",
    pe: 31.2,
    pb: NaN,
    ps: Infinity,
    roe_pct: null,
    beta: 1.26,
  }), {
    source: "yahoo-finance2",
    ticker: "AAPL",
    pe: 31.2,
    beta: 1.26,
  });
});

test("snapshot lookup respects ticker presence and freshness", () => {
  const snapshot = {
    schema_version: MARKET_FUNDAMENTALS_SCHEMA_VERSION,
    generatedAt: "2026-05-24T00:00:00.000Z",
    ttl_days: 7,
    stocks: {
      AAPL: { ticker: "AAPL", pe: 31.2 },
    },
  };
  assert.deepEqual(lookupMarketFundamentals(snapshot, "aapl", { nowMs: NOW }), { ticker: "AAPL", pe: 31.2 });
  assert.equal(lookupMarketFundamentals(snapshot, "MSFT", { nowMs: NOW }), null);
  assert.equal(lookupMarketFundamentals({ ...snapshot, generatedAt: "2026-04-01T00:00:00.000Z" }, "AAPL", { nowMs: NOW }), null);
});

test("fallback reader returns null for absent, malformed, stale, and missing-ticker files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sws-market-fundamentals-"));
  try {
    const absentPath = path.join(tmp, "absent.json");
    assert.equal(createMarketFundamentalsFallbackReader(absentPath, { nowMsProvider: () => NOW })("AAPL"), null);

    const malformedPath = path.join(tmp, "malformed.json");
    fs.writeFileSync(malformedPath, "{bad json");
    assert.equal(createMarketFundamentalsFallbackReader(malformedPath, { nowMsProvider: () => NOW })("AAPL"), null);

    const stalePath = path.join(tmp, "stale.json");
    fs.writeFileSync(stalePath, JSON.stringify({
      generatedAt: "2026-04-01T00:00:00.000Z",
      ttl_days: 7,
      stocks: { AAPL: { ticker: "AAPL", pe: 31.2 } },
    }));
    assert.equal(createMarketFundamentalsFallbackReader(stalePath, { nowMsProvider: () => NOW })("AAPL"), null);

    const freshPath = path.join(tmp, "fresh.json");
    fs.writeFileSync(freshPath, JSON.stringify({
      generatedAt: "2026-05-24T00:00:00.000Z",
      ttl_days: 7,
      stocks: { AAPL: { ticker: "AAPL", pe: 31.2 } },
    }));
    const reader = createMarketFundamentalsFallbackReader(freshPath, { nowMsProvider: () => NOW });
    assert.equal(reader("MSFT"), null);
    assert.equal(reader("AAPL").pe, 31.2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
