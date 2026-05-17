/**
 * governance.js — saveGovernance outage-preservation guard
 * (closes audit finding #1 from ~/.claude/plans/prod-fixes-2026-05-18.md).
 *
 * Background: governance.json zero-filled on 2026-05-12 because
 * scripts/refresh-governance.mjs:74 called `saveGovernance(snap)` with no
 * pre-check, and the only outage guard lived inside the Vercel-cron route
 * in server.js. When NSE cookies expired the nightly happily overwrote
 * the disk file with `counts: { ok: 0, empty: 744 }`, a 162-byte payload
 * that crippled the V2 scorer's governance pillar for 6 days.
 *
 * The fix moves the guard INTO saveGovernance() so every writer path
 * (server cron + local script + any future caller) is protected. This
 * test exercises the guard at both layers:
 *
 *   (a) `isOutageSnapshot` — pure predicate; covers normal / zero /
 *       boundary / unknown-total / malformed inputs.
 *   (b) `saveGovernance`   — side-effect; verifies the existing file is
 *       NOT overwritten when the new snapshot is an outage payload AND
 *       the existing snapshot has coverage; verifies a normal snapshot
 *       still writes; verifies an outage write IS allowed when there is
 *       no existing coverage to preserve (so the diagnostics surface
 *       tells the truth about a cold-start failure).
 *
 * Run with: node test/governance.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const REAL_FILE = path.join(REPO_ROOT, "governance.json");

// Tests run against the real disk path. To keep the suite safe we
// snapshot the file up-front and restore it on every exit (success,
// failure, or uncaught throw). KV must NOT be configured in the test
// env — assert that before we touch anything.
assert(
  !process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN,
  "test refuses to run with @vercel/kv configured — would write to remote KV"
);

const HAD_ORIGINAL = fs.existsSync(REAL_FILE);
const ORIGINAL_CONTENT = HAD_ORIGINAL ? fs.readFileSync(REAL_FILE, "utf-8") : null;

function restoreFile() {
  try {
    if (HAD_ORIGINAL) {
      fs.writeFileSync(REAL_FILE, ORIGINAL_CONTENT, "utf-8");
    } else if (fs.existsSync(REAL_FILE)) {
      fs.unlinkSync(REAL_FILE);
    }
  } catch (err) {
    console.error("[governance.test] FATAL: could not restore governance.json —", err.message);
  }
}
process.on("exit", restoreFile);
process.on("SIGINT", () => { restoreFile(); process.exit(130); });
process.on("uncaughtException", (err) => { restoreFile(); console.error(err); process.exit(1); });

const {
  isOutageSnapshot,
  saveGovernance,
  getGovernanceSnapshot,
  _resetGovernanceCacheForTests,
} = await import("../governance.js");

let pass = 0, fail = 0;
async function it(name, fn) {
  try {
    await fn();
    pass++;
    console.log("  ✓", name);
  } catch (err) {
    fail++;
    console.log("  ✗", name, "\n   ", err && err.message);
  }
}

// Helpers ────────────────────────────────────────────────────────────

/** Build a snapshot with given populated count out of `total`. */
function snap(ok, total, fetchedAt = new Date().toISOString()) {
  const bySymbol = {};
  for (let i = 0; i < ok; i++) bySymbol[`STOCK${i}.NS`] = { promoterHolding: 0.5 };
  return {
    fetchedAt,
    source: "nse-shareholding",
    bySymbol,
    counts: { ok, empty: total - ok, total },
  };
}

/** Force the disk file to a known state + clear the module cache. */
function seedDisk(snapshot) {
  fs.writeFileSync(REAL_FILE, JSON.stringify(snapshot, null, 2), "utf-8");
  _resetGovernanceCacheForTests();
}

/** Wipe the disk file (simulates first-ever run). */
function wipeDisk() {
  if (fs.existsSync(REAL_FILE)) fs.unlinkSync(REAL_FILE);
  _resetGovernanceCacheForTests();
}

// ── (a) isOutageSnapshot pure predicate ──────────────────────────────

console.log("\n[isOutageSnapshot]");

await it("null → outage", () => {
  assert.equal(isOutageSnapshot(null), true);
});

await it("undefined → outage", () => {
  assert.equal(isOutageSnapshot(undefined), true);
});

await it("non-object → outage", () => {
  assert.equal(isOutageSnapshot("not an object"), true);
});

await it("ok=0/total=744 (the pathological 2026-05-12 state) → outage", () => {
  assert.equal(isOutageSnapshot(snap(0, 744)), true);
});

await it("ok=4/total=744 → outage (below max(5, 10%))", () => {
  assert.equal(isOutageSnapshot(snap(4, 744)), true);
});

await it("ok=5/total=10 → outage (5 < max(5, 1) → 5 vs floor(0.1*10)=1 → 5 < 5? no — pass)", () => {
  // max(5, floor(10 * 0.1)) = max(5, 1) = 5. 5 < 5 is false. So NOT outage.
  assert.equal(isOutageSnapshot(snap(5, 10)), false);
});

await it("ok=4/total=10 → outage (4 < 5)", () => {
  assert.equal(isOutageSnapshot(snap(4, 10)), true);
});

await it("threshold edge: ok=ceil(0.1*total) where total=100 → ok=10 — NOT outage (10 >= max(5, 10))", () => {
  // floor(100*0.1) = 10. max(5,10) = 10. 10 < 10 is false → NOT outage.
  assert.equal(isOutageSnapshot(snap(10, 100)), false);
});

await it("just below threshold: ok=9/total=100 → outage (9 < 10)", () => {
  assert.equal(isOutageSnapshot(snap(9, 100)), true);
});

await it("ok=200/total=744 → healthy snapshot, NOT outage", () => {
  assert.equal(isOutageSnapshot(snap(200, 744)), false);
});

await it("empty bySymbol + no counts → outage", () => {
  assert.equal(isOutageSnapshot({ fetchedAt: null, source: "empty", bySymbol: {} }), true);
});

await it("counts derived from bySymbol when counts missing — ok=200, total unknown", () => {
  // No counts block → fall back to bySymbol size = 200. total unknown → falls
  // back to okCount → threshold = max(5, 20) = 20. 200 < 20 = false → healthy.
  const bySymbol = {};
  for (let i = 0; i < 200; i++) bySymbol[`X${i}.NS`] = { promoterHolding: 0.5 };
  assert.equal(isOutageSnapshot({ fetchedAt: "x", bySymbol }), false);
});

// ── (b) saveGovernance side-effect: outage payload is REJECTED when
//        existing snapshot has coverage ──────────────────────────────

console.log("\n[saveGovernance — outage preservation]");

await it("zero-ok snapshot does NOT overwrite an existing populated snapshot", async () => {
  const existing = snap(200, 744, "2026-05-01T00:00:00.000Z");
  seedDisk(existing);

  const outage = snap(0, 744, "2026-05-12T14:14:28.657Z");
  const result = await saveGovernance(outage);

  assert.equal(result.skipped, true, "result should be skipped");
  assert.equal(result.reason, "zero_or_low_yield_preserved_existing");
  assert.equal(result.fetched, 0);
  assert.equal(result.existingCount, 200);

  // Disk must be unchanged.
  const onDisk = JSON.parse(fs.readFileSync(REAL_FILE, "utf-8"));
  assert.equal(onDisk.fetchedAt, "2026-05-01T00:00:00.000Z", "fetchedAt preserved");
  assert.equal(Object.keys(onDisk.bySymbol).length, 200, "bySymbol preserved");
  assert.equal(onDisk.counts.ok, 200);
});

await it("low-yield snapshot (ok=4 of 744) does NOT overwrite populated existing", async () => {
  const existing = snap(150, 500, "2026-05-10T00:00:00.000Z");
  seedDisk(existing);

  const partial = snap(4, 744);
  const result = await saveGovernance(partial);

  assert.equal(result.skipped, true);
  assert.equal(result.existingCount, 150);

  const onDisk = JSON.parse(fs.readFileSync(REAL_FILE, "utf-8"));
  assert.equal(onDisk.fetchedAt, "2026-05-10T00:00:00.000Z");
  assert.equal(Object.keys(onDisk.bySymbol).length, 150);
});

// ── (c) saveGovernance side-effect: healthy snapshot WRITES ──────────

console.log("\n[saveGovernance — healthy write]");

await it("threshold-edge ok=10/total=100 IS written through", async () => {
  const existing = snap(150, 500, "2026-04-01T00:00:00.000Z");
  seedDisk(existing);

  const healthy = snap(10, 100, "2026-05-18T12:00:00.000Z");
  const result = await saveGovernance(healthy);

  assert.equal(result.skipped, undefined, "healthy write should not be skipped");
  assert.equal(result.target, "disk");

  const onDisk = JSON.parse(fs.readFileSync(REAL_FILE, "utf-8"));
  assert.equal(onDisk.fetchedAt, "2026-05-18T12:00:00.000Z");
  assert.equal(onDisk.counts.ok, 10);
  assert.equal(Object.keys(onDisk.bySymbol).length, 10);
});

await it("full ok=744/total=744 healthy snapshot IS written", async () => {
  const existing = snap(150, 500);
  seedDisk(existing);

  const healthy = snap(744, 744, "2026-05-18T13:00:00.000Z");
  const result = await saveGovernance(healthy);

  assert.equal(result.skipped, undefined);
  const onDisk = JSON.parse(fs.readFileSync(REAL_FILE, "utf-8"));
  assert.equal(onDisk.counts.ok, 744);
});

// ── (d) saveGovernance side-effect: outage WRITES when no existing
//        coverage to preserve (diagnostics surface honesty) ───────────

console.log("\n[saveGovernance — cold-start outage]");

await it("outage payload IS written when there is no existing snapshot", async () => {
  wipeDisk();

  const outage = snap(0, 744);
  const result = await saveGovernance(outage);

  assert.equal(result.skipped, undefined, "no existing data — outage should write through");
  assert.equal(result.target, "disk");

  const onDisk = JSON.parse(fs.readFileSync(REAL_FILE, "utf-8"));
  assert.equal(onDisk.counts.ok, 0);
});

await it("outage payload IS written when existing snapshot also has zero coverage", async () => {
  // Both old + new are outage payloads; nothing to preserve, so the new
  // one wins (keeps fetchedAt fresh for diagnostics).
  const oldOutage = snap(0, 744, "2026-05-01T00:00:00.000Z");
  seedDisk(oldOutage);

  const newOutage = snap(0, 744, "2026-05-18T14:00:00.000Z");
  const result = await saveGovernance(newOutage);

  assert.equal(result.skipped, undefined, "no useful existing data — outage should write through");
  const onDisk = JSON.parse(fs.readFileSync(REAL_FILE, "utf-8"));
  assert.equal(onDisk.fetchedAt, "2026-05-18T14:00:00.000Z");
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
