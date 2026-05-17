// services/earnings/loadV3UniverseStats.js — unit tests.
//
// The loader is small (70 LOC) but load-bearing: it feeds the SWS V3
// scorer's momentum percentile imputation via `opts.universe`. Per the
// module docstring, a missing/unparseable file must degrade GRACEFULLY
// (return null → predictor imputes momentum at the 50th percentile)
// rather than throw — a throw here would cascade into the Earnings
// Watch inline-compute path and silently zero out the V3 score for any
// stock not in picks-latest.
//
// Coverage:
//   • happy path — opts.filePath override loads a valid file and returns
//     {r1m, r3m, r1y} unchanged
//   • missing file → null + warn
//   • unparseable JSON → null + warn
//   • valid JSON but missing/malformed arrays → null + warn
//   • staleness warning fires when generated_at > 7d old, suppressed when fresh
//   • staleness path doesn't trigger when generated_at is absent or non-numeric
//
// All cases use tmp-fixture files via the public `opts.filePath` override
// — no child-process harness needed because the loader doesn't capture
// process.cwd() at module load (the override is the documented test seam).
//
// Run: node test/loadV3UniverseStats.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { loadV3UniverseStats } from "../services/earnings/loadV3UniverseStats.js";

let ok = 0, fail = 0;
const tests = [];
function it(name, fn) { tests.push({ name, fn }); }

/* ─────────────────── tmp-fixture + warn-capture harness ───────────────── */

function freshTempDir() {
  const dir = path.join(os.tmpdir(), `loadV3UniverseStats-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(tempDir) {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

// Patch console.warn so we can assert the loader emits the right warnings
// (the docstring explicitly says "warn loudly if it's gone stale rather
// than silently impute" — that contract is worth pinning).
function captureWarn(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    const result = fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

function writeFixture(tempDir, payload) {
  const fp = path.join(tempDir, "v3-universe-stats.json");
  fs.writeFileSync(fp, typeof payload === "string" ? payload : JSON.stringify(payload));
  return fp;
}

// Helper for a well-formed payload — sorted ascending so the file shape
// matches what scripts/sws-build-v3-universe-stats.mjs actually emits.
function goodPayload(over = {}) {
  return {
    generated_at: new Date().toISOString(),
    r1m: [-30, -10, 0, 5, 12, 25, 60],
    r3m: [-50, -20, 0, 15, 30, 70, 120],
    r1y: [-80, -40, 0, 35, 80, 200, 400],
    ...over,
  };
}

/* ─────────────────────────────── tests ────────────────────────────────── */

console.log("[1] happy path");

it("loads a well-formed file and returns the three arrays unchanged", () => {
  const dir = freshTempDir();
  try {
    const payload = goodPayload();
    const fp = writeFixture(dir, payload);
    const { result, warnings } = captureWarn(() => loadV3UniverseStats({ filePath: fp }));
    assert.deepEqual(result, { r1m: payload.r1m, r3m: payload.r3m, r1y: payload.r1y });
    // Fresh file → no staleness warning.
    assert.equal(warnings.length, 0, `unexpected warnings: ${JSON.stringify(warnings)}`);
  } finally { cleanup(dir); }
});

it("returns ONLY r1m/r3m/r1y — strips any extra payload keys like generated_at", () => {
  // The predictor's V3 scorer only consumes the three arrays; the loader
  // is the right place to enforce that minimal contract so a payload
  // shape regression doesn't leak through to computeV3Score().
  const dir = freshTempDir();
  try {
    const fp = writeFixture(dir, goodPayload({ generated_at: new Date().toISOString(), extra_key: "ignored" }));
    const { result } = captureWarn(() => loadV3UniverseStats({ filePath: fp }));
    assert.deepEqual(Object.keys(result).sort(), ["r1m", "r1y", "r3m"]);
  } finally { cleanup(dir); }
});

console.log("[2] missing file → null + warn");

it("non-existent filePath returns null with a [v3-universe-stats] missing warning", () => {
  const dir = freshTempDir();
  try {
    const fp = path.join(dir, "does-not-exist.json");
    const { result, warnings } = captureWarn(() => loadV3UniverseStats({ filePath: fp }));
    assert.equal(result, null);
    assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
    assert.match(warnings[0], /\[v3-universe-stats\]/);
    assert.match(warnings[0], /missing/);
    assert.match(warnings[0], /imputed/);
  } finally { cleanup(dir); }
});

it("default path (no opts) — when data/sws/v3-universe-stats.json absent the loader still returns null instead of throwing", () => {
  // We can't easily delete the real file from the worktree, so this
  // case only fires when the file genuinely isn't there. Either it
  // returns the parsed payload (file exists, no throw) or null
  // (file absent, warned). Both shapes satisfy the never-throw contract.
  const { result } = captureWarn(() => loadV3UniverseStats());
  if (result !== null) {
    assert.ok(Array.isArray(result.r1m) && Array.isArray(result.r3m) && Array.isArray(result.r1y),
      "real fixture present must still return the three arrays");
  }
});

console.log("[3] unparseable JSON → null + warn");

it("garbage bytes return null with an 'unparseable' warning", () => {
  const dir = freshTempDir();
  try {
    const fp = writeFixture(dir, "not valid json {");
    const { result, warnings } = captureWarn(() => loadV3UniverseStats({ filePath: fp }));
    assert.equal(result, null);
    assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
    assert.match(warnings[0], /unparseable/);
    assert.match(warnings[0], /imputing momentum/);
  } finally { cleanup(dir); }
});

it("empty file returns null without throwing", () => {
  const dir = freshTempDir();
  try {
    const fp = writeFixture(dir, "");
    const { result } = captureWarn(() => loadV3UniverseStats({ filePath: fp }));
    assert.equal(result, null);
  } finally { cleanup(dir); }
});

console.log("[4] malformed array shape → null + warn");

it("valid JSON but missing r1m array → null + 'missing arrays' warning", () => {
  const dir = freshTempDir();
  try {
    const fp = writeFixture(dir, { r3m: [], r1y: [] }); // r1m absent
    const { result, warnings } = captureWarn(() => loadV3UniverseStats({ filePath: fp }));
    assert.equal(result, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /missing r1m\/r3m\/r1y arrays/);
  } finally { cleanup(dir); }
});

it("valid JSON but r3m is an object (not array) → null", () => {
  const dir = freshTempDir();
  try {
    const fp = writeFixture(dir, { r1m: [], r3m: { junk: true }, r1y: [] });
    const { result, warnings } = captureWarn(() => loadV3UniverseStats({ filePath: fp }));
    assert.equal(result, null);
    assert.match(warnings[0], /missing r1m\/r3m\/r1y arrays/);
  } finally { cleanup(dir); }
});

it("all three keys present but r1y is null → null", () => {
  const dir = freshTempDir();
  try {
    const fp = writeFixture(dir, { r1m: [], r3m: [], r1y: null });
    const { result } = captureWarn(() => loadV3UniverseStats({ filePath: fp }));
    assert.equal(result, null);
  } finally { cleanup(dir); }
});

it("empty arrays are valid — loader returns them as-is (downstream decides)", () => {
  // An empty universe is technically a degenerate momentum percentile
  // bucket (every percentile collapses to 50), but it's not the
  // loader's job to second-guess. Returning [] preserves the explicit
  // null-vs-empty distinction that computeV3Score relies on.
  const dir = freshTempDir();
  try {
    const fp = writeFixture(dir, { r1m: [], r3m: [], r1y: [], generated_at: new Date().toISOString() });
    const { result } = captureWarn(() => loadV3UniverseStats({ filePath: fp }));
    assert.deepEqual(result, { r1m: [], r3m: [], r1y: [] });
  } finally { cleanup(dir); }
});

console.log("[5] staleness warning");

it("generated_at > 7d old emits a staleness warning but still returns the payload", () => {
  // The whole point of warning rather than failing: stale percentile
  // bands still beat a flat 50th-percentile impute. So a staleness
  // case must STILL return the three arrays.
  const dir = freshTempDir();
  try {
    const stale = new Date(Date.now() - 10 * 86400000).toISOString(); // 10d old
    const payload = goodPayload({ generated_at: stale });
    const fp = writeFixture(dir, payload);
    const { result, warnings } = captureWarn(() => loadV3UniverseStats({ filePath: fp }));
    assert.deepEqual(result, { r1m: payload.r1m, r3m: payload.r3m, r1y: payload.r1y });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[v3-universe-stats\]/);
    assert.match(warnings[0], /\d+\.\dd old/);
    assert.match(warnings[0], /SWS refresh pipeline/);
  } finally { cleanup(dir); }
});

it("generated_at exactly 5d old → no staleness warning (threshold is 7d)", () => {
  const dir = freshTempDir();
  try {
    const fresh = new Date(Date.now() - 5 * 86400000).toISOString();
    const fp = writeFixture(dir, goodPayload({ generated_at: fresh }));
    const { result, warnings } = captureWarn(() => loadV3UniverseStats({ filePath: fp }));
    assert.ok(result, "must still return the payload");
    assert.equal(warnings.length, 0);
  } finally { cleanup(dir); }
});

it("generated_at absent → no staleness warning fires (Date.parse(null) check skipped)", () => {
  const dir = freshTempDir();
  try {
    const payload = goodPayload();
    delete payload.generated_at;
    const fp = writeFixture(dir, payload);
    const { result, warnings } = captureWarn(() => loadV3UniverseStats({ filePath: fp }));
    assert.ok(result);
    assert.equal(warnings.length, 0);
  } finally { cleanup(dir); }
});

it("generated_at is gibberish → Number.isFinite guard suppresses the warning", () => {
  // new Date("not a date").getTime() → NaN, ageDays → NaN, Number.isFinite(NaN) → false.
  // The guard is the bug-defence; this test pins it.
  const dir = freshTempDir();
  try {
    const fp = writeFixture(dir, goodPayload({ generated_at: "totally not a date" }));
    const { result, warnings } = captureWarn(() => loadV3UniverseStats({ filePath: fp }));
    assert.ok(result);
    assert.equal(warnings.length, 0, `unexpected warnings: ${JSON.stringify(warnings)}`);
  } finally { cleanup(dir); }
});

/* ───────────────────────── runner ─────────────────────────────────────── */

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      console.log("  ✓", t.name);
      ok += 1;
    } catch (e) {
      console.log("  ✗", t.name, "\n   ", e && e.message);
      fail += 1;
    }
  }
  console.log(`\n=== ${ok} passed, ${fail} failed ===`);
  if (fail) process.exit(1);
})();
