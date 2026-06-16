// Run: node test/multibaggerPitSnapshot.test.mjs

import assert from "node:assert/strict";

import {
  PIT_SNAPSHOT_SCHEMA_VERSION,
  buildPitSnapshot,
  buildPitSnapshotRows,
  sha256Json,
} from "../services/multibagger/multibaggerPitSnapshot.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nmultibaggerPitSnapshot");

function candidate(i, overrides = {}) {
  return {
    ticker: `STOCK${String(i).padStart(3, "0")}`,
    sector: "Industrials",
    score_0_100: 500 - i,
    verdict: "WATCH",
    current_price_inr: 100 + i,
    breakdown: { inflection: i % 17, mcap: i % 5 },
    ...overrides,
  };
}

it("hashes JSON stably regardless of object key order", () => {
  assert.equal(sha256Json({ b: 2, a: 1 }), sha256Json({ a: 1, b: 2 }));
});

it("selects top 200 plus all high-conviction-plus rows outside top 200", () => {
  const rows = Array.from({ length: 205 }, (_, idx) => candidate(idx + 1));
  rows[204] = candidate(205, { ticker: "LATEHC", score_0_100: 1, verdict: "HIGH_CONVICTION" });
  const pitRows = buildPitSnapshotRows(rows, { snapshot_iso: "2026-06-17T00:00:00.000Z" });

  assert.equal(pitRows.length, 201);
  assert.ok(pitRows.some((r) => r.ticker === "LATEHC"));
  assert.ok(!pitRows.some((r) => r.ticker === "STOCK201"));
  assert.deepEqual(pitRows.find((r) => r.ticker === "LATEHC").selection_reasons, ["high_conviction_plus"]);
});

it("builds immutable rows with source hashes and candidate hashes", () => {
  const snapshot = buildPitSnapshot(
    [candidate(1, { ticker: "ALPHA", verdict: "5X_CANDIDATE" })],
    {
      snapshot_iso: "2026-06-17T05:00:00.000Z",
      generated_by: "test",
      sources: {
        scores: { built_at: "2026-06-17T04:59:00.000Z", count: 1 },
        macro: { regime: "CALM" },
      },
    }
  );

  assert.equal(snapshot.schema_version, PIT_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.snapshot_date_iso, "2026-06-17");
  assert.equal(snapshot.row_count, 1);
  assert.match(snapshot.source_hashes.scores, /^[a-f0-9]{64}$/);
  assert.match(snapshot.rows[0].candidate_hash, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.rows[0]), true);
});

it("dedupes duplicate tickers by highest score before selection", () => {
  const snapshot = buildPitSnapshot([
    candidate(1, { ticker: "DUP", score_0_100: 10, verdict: "WATCH" }),
    candidate(2, { ticker: "DUP", score_0_100: 90, verdict: "5X_CANDIDATE" }),
  ], { snapshot_iso: "2026-06-17T00:00:00.000Z" });

  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].score_0_100, 90);
  assert.equal(snapshot.rows[0].verdict, "5X_CANDIDATE");
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
