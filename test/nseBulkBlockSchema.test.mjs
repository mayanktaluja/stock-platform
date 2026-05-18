// PR-D2 — services/earnings/nseBulkBlockIngester.js schema contract tests.
//
// Audit finding #13 (2026-05-18 production audit): the file at
// data/catalysts/nse-bulk-block-rolling.json uses the key `deal_count`, but
// the audit flagged a risk that some consumers might expect older
// `bulkCount`/`blockCount` keys (which would indicate writer/reader schema
// drift).
//
// Investigation result (see commit body): NO drift exists today.
//   - JSON top-level keys:       schema_version, built_at, window_days,
//                                deal_count, deals
//   - In-memory per-symbol map:  net_buys, net_sells, net_qty,
//                                net_notional_inr, bulk_count, block_count,
//                                last_deal_date_iso, deals
//   - scripts/refresh-nse-corporate.mjs reads `deal_count` from the JSON
//   - services/earnings/signalAggregator.js reads `bulk_count` / `block_count`
//     from the IN-MEMORY rollup (NOT the JSON)
//   - db/schema.js / sws-seed-from-json.mjs / sqlBackend.js use `blockCount`
//     but for an unrelated `sanity` report table — separate schema entirely
//
// These tests pin the contract so any future writer/reader change has to
// confront the existing shape head-on instead of silently drifting.

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  loadDealsRolling,
  mergeIntoRolling,
  writeDealsRolling,
  buildPerSymbolDealIndex,
} from "../services/earnings/nseBulkBlockIngester.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

// ─── Top-level JSON shape ───────────────────────────────────────────────────

// Synthetic deals — minimal valid shape per cleanDeal() output.
const todayIso = new Date().toISOString().slice(0, 10);
const yesterdayIso = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
function makeDeal({ symbol, side, qty, kind, client = "FII", dateIso = todayIso }) {
  const avg = 100;
  return {
    symbol,
    name: symbol,
    date_iso: dateIso,
    client_name: client,
    side,
    qty,
    avg_price_inr: avg,
    notional_inr: qty * avg,
    kind,
    remarks: null,
  };
}

console.log("[1] loadDealsRolling() — default (no file) shape");
it("returns the canonical empty payload with correct keys when file absent", () => {
  // Point loadDealsRolling at a non-existent file via opts.path. The
  // production ROLLING_PATH is module-bound at import time, so the test
  // can't repoint it via cwd — opts.path is the test-only injection point.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "bulkblock-"));
  try {
    const payload = loadDealsRolling({ path: path.join(tmpdir, "does-not-exist.json") });
    assert.ok(payload, "should return a payload, not null");
    assert.equal(payload.schema_version, "nse-bulk-block-rolling-v1");
    assert.equal(payload.built_at, null);
    assert.equal(payload.window_days, 7);
    assert.equal(payload.deal_count, 0);
    assert.deepEqual(payload.deals, []);
    // Pinned key set — no extra keys, no missing keys
    const keys = Object.keys(payload).sort();
    assert.deepEqual(
      keys,
      ["built_at", "deal_count", "deals", "schema_version", "window_days"],
      "top-level keys must be exactly built_at|deal_count|deals|schema_version|window_days",
    );
    // No legacy key drift
    assert.equal(payload.bulkCount, undefined, "must not emit legacy bulkCount");
    assert.equal(payload.blockCount, undefined, "must not emit legacy blockCount");
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

console.log("[1b] loadDealsRolling() — real prod file shape (snapshot)");
it("the committed data/catalysts/nse-bulk-block-rolling.json matches the schema contract", () => {
  // This snapshot guards against an out-of-band edit to the JSON that
  // would drift it from what loadDealsRolling expects.
  const realPath = path.join(process.cwd(), "data", "catalysts", "nse-bulk-block-rolling.json");
  if (!fs.existsSync(realPath)) {
    console.log("    ℹ  (skipping — production file not present in this checkout)");
    return;
  }
  const real = JSON.parse(fs.readFileSync(realPath, "utf8"));
  assert.equal(real.schema_version, "nse-bulk-block-rolling-v1",
    "production JSON schema_version must match v1");
  assert.ok(Array.isArray(real.deals), "deals must be an array");
  assert.equal(typeof real.deal_count, "number");
  assert.equal(real.deal_count, real.deals.length,
    "deal_count must equal deals.length (writer-side invariant)");
  assert.equal(typeof real.window_days, "number");
  assert.equal(typeof real.built_at, "string");
  // No legacy key drift in the live file
  assert.equal(real.bulkCount, undefined);
  assert.equal(real.blockCount, undefined);
});

console.log("[2] mergeIntoRolling() — empty + fresh deals");
it("writes the same key set as loadDealsRolling's default", () => {
  const empty = {
    schema_version: "nse-bulk-block-rolling-v1",
    built_at: null,
    window_days: 7,
    deal_count: 0,
    deals: [],
  };
  const fresh = mergeIntoRolling(empty, [
    makeDeal({ symbol: "RELIANCE", side: "BUY", qty: 1000, kind: "BULK" }),
    makeDeal({ symbol: "TCS", side: "SELL", qty: 500, kind: "BLOCK" }),
  ], []);
  assert.equal(fresh.schema_version, "nse-bulk-block-rolling-v1");
  assert.ok(typeof fresh.built_at === "string", "built_at must be ISO string");
  assert.equal(fresh.window_days, 7);
  assert.equal(fresh.deal_count, 2);
  assert.equal(fresh.deals.length, 2);
  const keys = Object.keys(fresh).sort();
  assert.deepEqual(
    keys,
    ["built_at", "deal_count", "deals", "schema_version", "window_days"],
    "mergeIntoRolling output must have the same top-level keys as the load shape",
  );
});

console.log("[3] mergeIntoRolling() — deal_count matches deals.length");
it("deal_count tracks deals.length exactly", () => {
  const fresh = mergeIntoRolling({ deals: [] }, [
    makeDeal({ symbol: "A", side: "BUY", qty: 1, kind: "BULK" }),
    makeDeal({ symbol: "B", side: "BUY", qty: 1, kind: "BULK" }),
    makeDeal({ symbol: "C", side: "SELL", qty: 1, kind: "BLOCK" }),
  ], []);
  assert.equal(fresh.deal_count, fresh.deals.length);
});

console.log("[4] mergeIntoRolling() — out-of-window deals are dropped");
it("deals older than ROLLING_WINDOW_DAYS (7) are excluded", () => {
  const old = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const fresh = mergeIntoRolling({ deals: [] }, [
    makeDeal({ symbol: "OLD", side: "BUY", qty: 1, kind: "BULK", dateIso: old }),
    makeDeal({ symbol: "NEW", side: "BUY", qty: 1, kind: "BULK", dateIso: todayIso }),
  ], []);
  assert.equal(fresh.deal_count, 1);
  assert.equal(fresh.deals[0].symbol, "NEW");
});

console.log("[5] mergeIntoRolling() — dedupe on (symbol, date, kind, side, client, qty)");
it("identical fresh + existing deals collapse to one row", () => {
  const dup = makeDeal({ symbol: "DUP", side: "BUY", qty: 100, kind: "BULK", client: "FII X" });
  const existing = { deals: [dup] };
  const fresh = mergeIntoRolling(existing, [dup], []);
  assert.equal(fresh.deal_count, 1);
});

console.log("[6] writeDealsRolling → loadDealsRolling round-trip");
it("written file reloads with identical top-level shape", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "bulkblock-rt-"));
  const rtPath = path.join(tmpdir, "rt.json");
  try {
    const payload = mergeIntoRolling({ deals: [] }, [
      makeDeal({ symbol: "X", side: "BUY", qty: 1, kind: "BULK" }),
    ], []);
    writeDealsRolling(payload, { path: rtPath });
    const round = loadDealsRolling({ path: rtPath });
    assert.deepEqual(Object.keys(round).sort(), Object.keys(payload).sort());
    assert.equal(round.schema_version, payload.schema_version);
    assert.equal(round.deal_count, payload.deal_count);
    assert.equal(round.deals.length, payload.deals.length);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

// ─── Per-symbol rollup (in-memory, NOT the JSON) shape ────────────────────

console.log("[7] buildPerSymbolDealIndex() — per-symbol rollup uses bulk_count/block_count");
it("rollup entries expose bulk_count + block_count (consumed by signalAggregator)", () => {
  const rolling = {
    deals: [
      makeDeal({ symbol: "RELI", side: "BUY", qty: 1000, kind: "BULK" }),
      makeDeal({ symbol: "RELI", side: "SELL", qty: 200, kind: "BLOCK", client: "DII" }),
    ],
  };
  const map = buildPerSymbolDealIndex(rolling);
  const e = map.get("RELI");
  assert.ok(e, "RELI entry must exist");
  // Pinned key set on rollup entries — what signalAggregator.js reads
  const expectedKeys = [
    "net_buys", "net_sells", "net_qty", "net_notional_inr",
    "bulk_count", "block_count", "last_deal_date_iso", "deals",
  ].sort();
  assert.deepEqual(Object.keys(e).sort(), expectedKeys);
  assert.equal(e.bulk_count, 1);
  assert.equal(e.block_count, 1);
  assert.equal(e.net_buys, 1);
  assert.equal(e.net_sells, 1);
  // The audit's risk was a legacy bulkCount/blockCount key — confirm absent
  assert.equal(e.bulkCount, undefined, "no legacy camelCase bulkCount");
  assert.equal(e.blockCount, undefined, "no legacy camelCase blockCount");
});

console.log("[8] schema_version is pinned to v1 — bump must happen via test break");
it("ensures any future schema change is a deliberate, test-visible move", () => {
  const empty = mergeIntoRolling({ deals: [] }, [], []);
  assert.equal(empty.schema_version, "nse-bulk-block-rolling-v1",
    "If you are intentionally bumping the schema, update this test AND every downstream consumer in lockstep.");
});

// ─── Cross-module sanity: consumer key expectations ───────────────────────

console.log("[9] consumer contract — signalAggregator reads bulk_count/block_count from in-memory map");
it("confirms the names the signal aggregator reads are exactly what buildPerSymbolDealIndex emits", () => {
  // This is a documented contract, codified for the regression suite.
  // services/earnings/signalAggregator.js:567-568:
  //   bulk_count: dealSummary.bulk_count,
  //   block_count: dealSummary.block_count,
  const rolling = { deals: [makeDeal({ symbol: "AGG", side: "BUY", qty: 1, kind: "BULK" })] };
  const map = buildPerSymbolDealIndex(rolling);
  const dealSummary = map.get("AGG");
  assert.equal(typeof dealSummary.bulk_count, "number");
  assert.equal(typeof dealSummary.block_count, "number");
});

console.log("[10] consumer contract — refresh-nse-corporate reads deal_count from JSON");
it("confirms the JSON key the refresh script logs about is what the writer emits", () => {
  // scripts/refresh-nse-corporate.mjs:84-85:
  //   `[nse-corp] deals rolling: ${merged.deal_count} items in last ${merged.window_days}d`
  const fresh = mergeIntoRolling({ deals: [] }, [
    makeDeal({ symbol: "REF", side: "BUY", qty: 1, kind: "BULK" }),
  ], []);
  assert.equal(typeof fresh.deal_count, "number");
  assert.equal(typeof fresh.window_days, "number");
});

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
