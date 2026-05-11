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
