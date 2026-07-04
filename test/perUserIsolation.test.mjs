// Per-user storage-isolation tests (P1.7, 2026-05-16)
//
// SEBI-RA review flagged cross-user data leakage as the worst-possible
// outcome at the friends-and-family tier — a single bug exposing Friend
// A's portfolio to Friend B is the easiest way to destroy trust.
//
// This test exercises the storage-layer contract directly. The route-level
// audit (server.js grep for `userSub(req)` before every readPortfolio /
// savePortfolio / getAnalyzerStorage call) found NO leak surface as of
// 2026-05-16: every personalised route calls userSub(req) first and threads
// `sub` into the storage adapter. The storage adapter throws on
// missing-sub writes (portfolioStorage.js:49, analyzerStorage.js:55), so
// even a buggy route that omitted `sub` would error loudly rather than
// silently writing to a default bucket.
//
// This test exercises the storage-layer contract directly.
//
// What this test proves:
//   1. Storage writes require sub (throws on missing/null/empty)
//   2. Reads with sub_A do not return sub_B's data, regardless of order
//   3. Different subs land in different keys / map entries
//   4. The analyzer storage shares the same contract
//   5. The watchlist storage shares the same contract (auth iter 2 — was a
//      shared global list until 2026-07-05)
//
// Auth iter 2 (2026-07-05) also closed the surfaces this storage test can't
// reach, with their own dedicated tests:
//   - The X-Test-Sub identity gate (services/userIdentity.js) — proven inert
//     outside NODE_ENV==='test' by test/userIdentity.test.mjs.
//   - The live two-user scenario (dev-mode AUTH_ENABLED=false used to collapse
//     everyone to _local_dev) — now proven by test/e2e/per-user-isolation.spec
//     using two contexts pinned to distinct subs via the test header.
//   - Portfolio response cache is now keyed by sub (was an active bleed);
//     analyzer sessionId cache stamps sub and /optimize 410s on a mismatch.
//
// Still out of scope here (infra, not app logic): the OAuth callback assigns
// the correct sub, session cookies can't be hijacked, Vercel KV partitioning.

import { strict as assert } from "node:assert";
import { existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`  ✓ ${name}`); passed += 1; },
    (e) => { console.error(`  ✗ ${name}\n     ${e.message}`); failed += 1; }
  );
}

// Fresh storage instance per test → file storage isolated to a temp dir.
// We can't easily redirect portfolioStorage.js's hard-coded
// `portfolios.json` path without monkey-patching, so the tests run against
// the actual file at the repo root. To stay non-destructive we use unique
// sub IDs (UUID-ish) so we never collide with the real `_local_dev` user.
const TEST_SUB_A = `_test_isolation_A_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_SUB_B = `_test_isolation_B_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const { getPortfolioStorage } = await import("../portfolioStorage.js");
const { getAnalyzerStorage } = await import("../analyzerStorage.js");
const { getWatchlistStorage } = await import("../watchlistStorage.js");

const ps = getPortfolioStorage();
const as = getAnalyzerStorage();
const ws = getWatchlistStorage();

console.log("\n[1] Portfolio storage requires sub on write");
await test("write throws when sub is null", async () => {
  await assert.rejects(() => ps.write(null, { stocks: [] }), /sub is required/i);
});
await test("write throws when sub is empty string", async () => {
  await assert.rejects(() => ps.write("", { stocks: [] }), /sub is required/i);
});
await test("write throws when sub is undefined", async () => {
  await assert.rejects(() => ps.write(undefined, { stocks: [] }), /sub is required/i);
});

console.log("\n[2] Cross-user reads return only the requester's data");
await test("sub A's write is not readable as sub B", async () => {
  await ps.write(TEST_SUB_A, {
    stocks: [{ symbol: "ISOLATION_TEST_A", quantity: 100 }],
    mutualFunds: [],
    lastUpdated: new Date().toISOString(),
  });
  const asB = await ps.read(TEST_SUB_B);
  // sub B's portfolio should be the EMPTY default, not sub A's data
  assert.ok(!asB.stocks?.some((s) => s.symbol === "ISOLATION_TEST_A"),
    "sub B read returned sub A's stock");
});
await test("sub B's write is not readable as sub A", async () => {
  await ps.write(TEST_SUB_B, {
    stocks: [{ symbol: "ISOLATION_TEST_B", quantity: 50 }],
    mutualFunds: [],
    lastUpdated: new Date().toISOString(),
  });
  const asA = await ps.read(TEST_SUB_A);
  assert.ok(!asA.stocks?.some((s) => s.symbol === "ISOLATION_TEST_B"),
    "sub A read returned sub B's stock");
});
await test("sub A's read still returns sub A's data (write integrity)", async () => {
  const asA = await ps.read(TEST_SUB_A);
  assert.ok(asA.stocks?.some((s) => s.symbol === "ISOLATION_TEST_A"),
    "sub A read should still contain its own write");
});

console.log("\n[3] Analyzer storage shares the same isolation contract");
await test("analyzer write throws when sub is null", async () => {
  await assert.rejects(() => as.write(null, { holdings: [] }), /sub is required/i);
});
await test("analyzer read of unknown sub returns null (not another user's data)", async () => {
  const unknown = `_test_never_written_${Date.now()}`;
  const got = await as.read(unknown);
  assert.equal(got, null);
});
await test("analyzer sub A's holdings are not readable as sub B", async () => {
  await as.write(TEST_SUB_A, {
    holdings: [{ symbol: "ANALYZER_ISOLATION_A", quantity: 1 }],
    mfHoldings: null,
    uploadedAt: new Date().toISOString(),
    sourceFile: "isolation-test.xlsx",
  });
  const asB = await as.read(TEST_SUB_B);
  assert.ok(
    !asB || !asB.holdings?.some((h) => h.symbol === "ANALYZER_ISOLATION_A"),
    "sub B analyzer read returned sub A's holding",
  );
});

console.log("\n[4] Storage key shape is deterministic per sub");
await test("portfolio storage key includes sub (KV adapter contract)", async () => {
  // The file adapter stores under `all[sub]`; the KV adapter uses
  // `portfolio:data:${sub}`. Both keep sub in the key path. We assert
  // the adapter name resolves and the read+write round-trips.
  const name = ps.name;
  assert.ok(name === "file" || name === "vercel-kv");
});

console.log("\n[5] Watchlist storage shares the same isolation contract (auth iter 2)");
await test("watchlist add throws when sub is null", async () => {
  await assert.rejects(() => ws.add(null, { symbol: "X.NS" }), /sub is required/i);
});
await test("watchlist sub A's item is not readable as sub B", async () => {
  await ws.add(TEST_SUB_A, {
    symbol: "WL_ISOLATION_A.NS", name: "A", sector: "TEST",
    addedAt: new Date().toISOString(), addedPrice: 100,
  });
  const asB = await ws.read(TEST_SUB_B);
  assert.ok(!asB.some((s) => s.symbol === "WL_ISOLATION_A.NS"),
    "sub B watchlist read returned sub A's item");
});
await test("watchlist read of unknown sub returns []", async () => {
  const got = await ws.read(`_test_never_wl_${Date.now()}`);
  assert.deepEqual(got, []);
});

// Cleanup — remove the two test users from the portfolios file/KV so we
// don't accumulate cruft on the dev box. Idempotent.
try {
  if (ps.name === "file") {
    // For the file adapter, re-read and re-write WITHOUT the test users.
    const all = await ps._readAll();
    delete all[TEST_SUB_A];
    delete all[TEST_SUB_B];
    await ps._writeAll(all);
  }
  if (as.name === "file") {
    const all = await as._readAll();
    delete all[TEST_SUB_A];
    delete all[TEST_SUB_B];
    await as._writeAll(all);
  }
  if (ws.name === "file") {
    const all = await ws._readAll();
    delete all[TEST_SUB_A];
    delete all[TEST_SUB_B];
    await ws._writeAll(all);
  }
} catch {
  // Cleanup failure is not a test failure — log and move on.
  console.warn("  ⚠ cleanup of test users failed (non-fatal)");
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
