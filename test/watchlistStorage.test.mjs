// Per-user watchlist storage-isolation tests (auth iter 2)
//
// The watchlist was a single SHARED list until auth iter 2 — every signed-in
// user saw and mutated the same set of symbols. This test locks the new
// per-sub contract so that regression can't silently return:
//   1. Writes require sub (add/remove throw on missing/null/empty)
//   2. Reads with sub_A never return sub_B's items, regardless of order
//   3. read() of an unknown sub returns [] (never another user's list)
//   4. The KV key shape includes sub (watchlist:{sub}) — contract-tested
//      without a live KV via the exported watchlistKey helper
//
// Runs against the real file adapter at the repo root (KV env unset). Uses
// unique sub ids so it never collides with the real _local_dev namespace,
// and cleans them up afterwards (mirrors perUserIsolation.test.mjs).

import { strict as assert } from "node:assert";

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`  ✓ ${name}`); passed += 1; },
    (e) => { console.error(`  ✗ ${name}\n     ${e.message}`); failed += 1; }
  );
}

const TEST_SUB_A = `_test_wl_A_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_SUB_B = `_test_wl_B_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const { getWatchlistStorage, watchlistKey } = await import("../watchlistStorage.js");
const ws = getWatchlistStorage();

const item = (symbol) => ({ symbol, name: symbol, sector: "TEST", addedAt: new Date().toISOString(), addedPrice: 100 });

console.log("\n[1] Watchlist writes require sub");
await test("add throws when sub is null", async () => {
  await assert.rejects(() => ws.add(null, item("A.NS")), /sub is required/i);
});
await test("add throws when sub is empty string", async () => {
  await assert.rejects(() => ws.add("", item("A.NS")), /sub is required/i);
});
await test("remove throws when sub is undefined", async () => {
  await assert.rejects(() => ws.remove(undefined, "A.NS"), /sub is required/i);
});

console.log("\n[2] Cross-user reads return only the requester's list");
await test("sub A's add is not readable as sub B", async () => {
  await ws.add(TEST_SUB_A, item("WL_ISOLATION_A.NS"));
  const asB = await ws.read(TEST_SUB_B);
  assert.ok(!asB.some((s) => s.symbol === "WL_ISOLATION_A.NS"), "sub B read returned sub A's item");
});
await test("sub B's add is not readable as sub A", async () => {
  await ws.add(TEST_SUB_B, item("WL_ISOLATION_B.NS"));
  const asA = await ws.read(TEST_SUB_A);
  assert.ok(!asA.some((s) => s.symbol === "WL_ISOLATION_B.NS"), "sub A read returned sub B's item");
});
await test("sub A's read still returns sub A's item (write integrity)", async () => {
  const asA = await ws.read(TEST_SUB_A);
  assert.ok(asA.some((s) => s.symbol === "WL_ISOLATION_A.NS"), "sub A read should still contain its own add");
});

console.log("\n[3] read of an unknown sub returns an empty list");
await test("unknown sub reads []", async () => {
  const got = await ws.read(`_test_wl_never_${Date.now()}`);
  assert.deepEqual(got, []);
});

console.log("\n[4] remove only touches the requester's list");
await test("sub A remove does not affect sub B", async () => {
  await ws.remove(TEST_SUB_A, "WL_ISOLATION_A.NS");
  const asA = await ws.read(TEST_SUB_A);
  const asB = await ws.read(TEST_SUB_B);
  assert.ok(!asA.some((s) => s.symbol === "WL_ISOLATION_A.NS"), "sub A item should be gone");
  assert.ok(asB.some((s) => s.symbol === "WL_ISOLATION_B.NS"), "sub B item must survive sub A's remove");
});

console.log("\n[5] KV key shape includes sub");
await test("watchlistKey(sub) === watchlist:{sub}", () => {
  assert.equal(watchlistKey("abc123"), "watchlist:abc123");
  assert.notEqual(watchlistKey("abc123"), watchlistKey("def456"));
});

// Cleanup — drop the two test users from the file adapter's map.
try {
  if (ws.name === "file") {
    const all = await ws._readAll();
    delete all[TEST_SUB_A];
    delete all[TEST_SUB_B];
    await ws._writeAll(all);
  }
} catch {
  console.warn("  ⚠ cleanup of test users failed (non-fatal)");
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
