// Contract tests for services/swsDal. Exercises the public API with both
// the real JSON backend (against data/sws/ on disk) and the fake-backend
// test seam, asserting the shapes consumers depend on.
//
// Scope: Phase 1 (read-only over JSON). Phase 3 will add write-side tests.

import test from "node:test";
import assert from "node:assert/strict";

import * as dal from "../services/swsDal/index.js";
import { makeFakeBackend } from "../services/swsDal/test-fixtures.js";

test("DAL exports a stable surface", () => {
  const expected = [
    "DATA_DIR",
    "DEEP_DIR",
    "__getBackend",
    "__setBackend",
    "getAllShardProgressApi",
    "getLastRefresh",
    "getPicksLatest",
    "getScoredUniverse",
    "getSectorMomentum",
    "getShardProgressApi",
    "getSnapshotFvMap",
    "getStockByTicker",
    "getUniverseIndex",
    "getUniverseIndexMtime",
    "getV3UniverseStats",
    "invalidateAll",
    "listDeepTickers",
  ];
  const actual = Object.keys(dal).sort();
  for (const k of expected) {
    assert.ok(actual.includes(k), `missing export: ${k}`);
  }
});

test("getPicksLatest returns a sectioned object", () => {
  const picks = dal.getPicksLatest();
  if (picks == null) {
    // CI without data — accept null.
    return;
  }
  assert.equal(typeof picks, "object");
  assert.equal(typeof picks.sections, "object");
  assert.ok(Object.keys(picks.sections).length > 0, "no sections");
});

test("getUniverseIndex returns a Map keyed by upper-case ticker", () => {
  const idx = dal.getUniverseIndex();
  if (idx == null) return;
  assert.ok(idx instanceof Map);
  assert.ok(idx.size > 0, "empty universe index");
  for (const k of idx.keys()) {
    assert.equal(k, k.toUpperCase(), `ticker key not upper-case: ${k}`);
    break; // sample one
  }
});

test("getStockByTicker normalises Yahoo-style suffixes", () => {
  const bare = dal.getStockByTicker("RELIANCE");
  const ns = dal.getStockByTicker("RELIANCE.NS");
  const bo = dal.getStockByTicker("RELIANCE.BO");
  if (bare == null) return;
  assert.equal(bare.ticker, "RELIANCE");
  assert.equal(ns?.ticker, "RELIANCE");
  assert.equal(bo?.ticker, "RELIANCE");
});

test("getStockByTicker returns null for unknown tickers", () => {
  assert.equal(dal.getStockByTicker("NOT_A_REAL_TICKER_XYZ"), null);
  assert.equal(dal.getStockByTicker(""), null);
  assert.equal(dal.getStockByTicker(null), null);
});

test("getSectorMomentum returns shape { map, scanned }", () => {
  const sm = dal.getSectorMomentum();
  assert.equal(typeof sm, "object");
  assert.ok(sm.map instanceof Map);
  assert.equal(typeof sm.scanned, "number");
  if (sm.scanned > 0) {
    for (const [sector, entry] of sm.map.entries()) {
      assert.equal(typeof sector, "string");
      assert.equal(typeof entry.avg_1m_pct, "number");
      assert.equal(typeof entry.sample_size, "number");
      assert.ok(entry.sample_size >= 3, "sample_size below 3 minimum");
      break;
    }
  }
});

test("getV3UniverseStats returns { r1m, r3m, r1y }", () => {
  const stats = dal.getV3UniverseStats();
  if (stats == null) return;
  assert.ok(Array.isArray(stats.r1m));
  assert.ok(Array.isArray(stats.r3m));
  assert.ok(Array.isArray(stats.r1y));
});

test("getLastRefresh returns pipeline metadata when present", () => {
  const r = dal.getLastRefresh();
  if (r == null) return;
  assert.equal(typeof r.pipeline_status, "string");
  assert.equal(typeof r.scored_count, "number");
});

test("getAllShardProgressApi returns 3 entries", () => {
  const shards = dal.getAllShardProgressApi();
  assert.equal(shards.length, 3);
  for (const s of shards) {
    assert.ok([1, 2, 3].includes(s.id));
  }
});

test("listDeepTickers returns an array", () => {
  const tickers = dal.listDeepTickers();
  assert.ok(Array.isArray(tickers));
});

test("__setBackend swaps the backend and falls back to default on null", () => {
  const fake = makeFakeBackend({
    picksLatest: { sections: { test_section: [{ ticker: "FAKE" }] } },
    deepByTicker: { FAKE: { ticker: "FAKE", overview: {} } },
  });

  try {
    dal.__setBackend(fake);
    const picks = dal.getPicksLatest();
    assert.equal(picks.sections.test_section[0].ticker, "FAKE");
    assert.equal(dal.getStockByTicker("FAKE")?.ticker, "FAKE");
    assert.equal(dal.getStockByTicker("FAKE.NS")?.ticker, "FAKE");
    assert.equal(dal.getStockByTicker("MISSING"), null);
  } finally {
    dal.__setBackend(null);
  }

  // After reset, the real backend is back.
  const picks = dal.getPicksLatest();
  if (picks != null) {
    assert.notDeepEqual(Object.keys(picks.sections), ["test_section"]);
  }
});

test("makeFakeBackend builds a universe index from a scoredUniverse array", () => {
  const fake = makeFakeBackend({
    scoredUniverse: {
      stocks: [
        { ticker: "AAA", v3_score: 50 },
        { ticker: "bbb", v3_score: 30 },
      ],
    },
  });
  try {
    dal.__setBackend(fake);
    const idx = dal.getUniverseIndex();
    assert.ok(idx instanceof Map);
    assert.equal(idx.get("AAA").v3_score, 50);
    assert.equal(idx.get("BBB").v3_score, 30, "ticker key upper-cased");
  } finally {
    dal.__setBackend(null);
  }
});

test("getSnapshotFvMap returns Map<bareTicker, {fair_value_inr, current_price_inr, upside_pct}> for the requested tickers", async () => {
  // Skip when running against the real backend without data on disk.
  const realTickers = dal.listDeepTickers();
  if (realTickers.length === 0) return;

  const sample = realTickers.slice(0, 5);
  const map = await dal.getSnapshotFvMap(sample);
  assert.ok(map instanceof Map, "expected a Map");
  // Every key that maps back should match the deep-file overview values.
  for (const [ticker, fv] of map.entries()) {
    assert.equal(typeof ticker, "string");
    const deep = dal.getStockByTicker(ticker);
    if (!deep) continue;
    const ov = deep.overview || {};
    if (typeof ov.fair_value_inr === "number") {
      assert.equal(fv.fair_value_inr, ov.fair_value_inr, `FV mismatch for ${ticker}`);
    } else {
      assert.equal(fv.fair_value_inr, null);
    }
    if (typeof ov.current_price_inr === "number") {
      assert.equal(fv.current_price_inr, ov.current_price_inr, `price mismatch for ${ticker}`);
    }
  }
});

test("getSnapshotFvMap returns empty Map for empty/invalid inputs", async () => {
  assert.equal((await dal.getSnapshotFvMap([])).size, 0);
  assert.equal((await dal.getSnapshotFvMap(null)).size, 0);
  assert.equal((await dal.getSnapshotFvMap(undefined)).size, 0);
  // Non-array, non-null
  assert.equal((await dal.getSnapshotFvMap("STAR")).size, 0);
});

test("getSnapshotFvMap normalises .NS/.BO suffixes and dedupes", async () => {
  const fake = makeFakeBackend({
    deepByTicker: {
      RELIANCE: { ticker: "RELIANCE", overview: { fair_value_inr: 1500, current_price_inr: 1400, upside_pct: 7.1 } },
      INFY: { ticker: "INFY", overview: { fair_value_inr: 1900, current_price_inr: 1800, upside_pct: 5.6 } },
    },
  });
  try {
    dal.__setBackend(fake);
    // Note: dispatcher routes getSnapshotFvMap through jsonBackend, NOT through
    // _backend. So we exercise the fake backend's getSnapshotFvMap directly here
    // to verify the fixture mirrors the dispatcher's contract — the e2e spec
    // exercises the real dispatcher path.
    const map = await fake.getSnapshotFvMap([
      "RELIANCE.NS",
      "INFY",
      "INFY.BO",       // dedupe
      "MISSING",        // not in fake
      "",               // skip
      null,             // skip
    ]);
    assert.equal(map.size, 2, "expected 2 unique entries");
    assert.equal(map.get("RELIANCE").fair_value_inr, 1500);
    assert.equal(map.get("RELIANCE").current_price_inr, 1400);
    assert.equal(map.get("INFY").fair_value_inr, 1900);
    assert.equal(map.get("MISSING"), undefined);
  } finally {
    dal.__setBackend(null);
  }
});

test("invalidateAll is a no-op safety hatch", () => {
  // Should not throw, regardless of backend state.
  assert.doesNotThrow(() => dal.invalidateAll());
  const fake = makeFakeBackend({});
  try {
    dal.__setBackend(fake);
    assert.doesNotThrow(() => dal.invalidateAll());
  } finally {
    dal.__setBackend(null);
  }
});
