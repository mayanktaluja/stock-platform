import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAdjustedBars,
  yahooSymbolCandidates,
} from "../scripts/refresh-chronos-forecast.mjs";

test("Yahoo symbol candidates prefer NSE and then BSE", () => {
  assert.deepEqual(yahooSymbolCandidates("jsll"), ["JSLL.NS", "JSLL.BO"]);
  assert.deepEqual(yahooSymbolCandidates("JSLL.NS"), ["JSLL.NS", "JSLL.BO"]);
});

test("adjusted OHLCV bars scale open/high/low with adjusted close", () => {
  const bars = normalizeAdjustedBars([
    { date: "2026-06-02", open: 100, high: 110, low: 90, close: 100, adjclose: 50, volume: 10 },
    { date: "2026-06-01", open: 10, high: 12, low: 9, close: 10, volume: 5 },
    { date: "2026-06-01", open: 99, high: 99, low: 99, close: 99, volume: 99 },
  ]);
  assert.deepEqual(bars.map((b) => b.date), ["2026-06-01", "2026-06-02"]);
  assert.equal(bars[1].open, 50);
  assert.equal(bars[1].high, 55);
  assert.equal(bars[1].low, 45);
  assert.equal(bars[1].close, 50);
});
