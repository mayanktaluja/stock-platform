// services/macroRegimeStorage.js — defensive write-regression log test.
//
// Phase 3 of the 2026-05-17 macro permanent fix. The original Phase 3
// plan was based on a misdiagnosis (the agent thought server.js was
// rewriting fallback regimes — it isn't). But we added a defensive log
// in the storage adapter that warns when an incoming regime would
// regress generatedAt vs the existing file. This test verifies that
// warning fires when (and only when) the regression actually happens.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let ok = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

// We can't easily inject FILE_PATH (the module hard-codes data/macroRegime.json
// relative to its own location). Instead, we drive the test through the real
// file path: snapshot the file before, write a regression, capture the
// warning, restore the file after.

const REAL_FILE = path.join(__dirname, "..", "data", "macroRegime.json");
const HAVE_FILE = fs.existsSync(REAL_FILE);

if (!HAVE_FILE) {
  console.log("  ↷ skip — data/macroRegime.json missing (test needs an existing file)");
  console.log(`\n=== 0 passed, 0 failed (skipped) ===`);
  process.exit(0);
}

const { getMacroRegimeStorage } = await import("../services/macroRegimeStorage.js");

// Capture console.warn output for the duration of one call.
function captureWarn(fn) {
  const original = console.warn;
  const captured = [];
  console.warn = (...args) => { captured.push(args.join(" ")); };
  try { return fn().then ? fn().then((v) => { console.warn = original; return { v, captured }; }) : { v: fn(), captured }; }
  finally { /* console.warn restored above for sync path; async path restores in .then */ }
}

// Snapshot + helpers.
const originalContent = fs.readFileSync(REAL_FILE, "utf-8");
let originalRegime;
try {
  originalRegime = JSON.parse(originalContent);
} catch (e) {
  // A malformed macro file (e.g. unresolved git conflict markers from a
  // cron-vs-nightly stash collision) must not crash the whole && test chain.
  // The commit being pushed excludes data/macroRegime.json, so a working-tree
  // conflict in it is irrelevant to the push — skip cleanly, like missing-file.
  console.log("  ↷ skip — data/macroRegime.json is not valid JSON (" + e.message + ")");
  console.log(`\n=== 0 passed, 0 failed (skipped) ===`);
  process.exit(0);
}

function restore() { fs.writeFileSync(REAL_FILE, originalContent, "utf-8"); }

const storage = getMacroRegimeStorage();

// Disable NODE_ENV=test guard so write() actually runs.
const SAVED_NODE_ENV = process.env.NODE_ENV;
delete process.env.NODE_ENV;

async function main() {
  console.log("[1] write-regression log");

  await it("write with FUTURE generatedAt → no warning (forward progress)", async () => {
    const oneHourAhead = new Date(new Date(originalRegime.generatedAt).getTime() + 3600 * 1000).toISOString();
    const captured = [];
    const origWarn = console.warn;
    console.warn = (...args) => { captured.push(args.join(" ")); };
    try {
      await storage.write({ ...originalRegime, generatedAt: oneHourAhead });
    } finally { console.warn = origWarn; }
    const regressionWarns = captured.filter((s) => /would regress generatedAt/i.test(s));
    assert.equal(regressionWarns.length, 0, `unexpected warning: ${captured.join(" | ")}`);
    restore();
  });

  await it("write with SAME generatedAt → no warning (same-second restate)", async () => {
    const captured = [];
    const origWarn = console.warn;
    console.warn = (...args) => { captured.push(args.join(" ")); };
    try {
      await storage.write({ ...originalRegime });  // same generatedAt
    } finally { console.warn = origWarn; }
    const regressionWarns = captured.filter((s) => /would regress generatedAt/i.test(s));
    assert.equal(regressionWarns.length, 0);
    restore();
  });

  await it("write with OLDER generatedAt → warns once with age delta", async () => {
    const tenMinAgo = new Date(new Date(originalRegime.generatedAt).getTime() - 600 * 1000).toISOString();
    const captured = [];
    const origWarn = console.warn;
    console.warn = (...args) => { captured.push(args.join(" ")); };
    try {
      await storage.write({ ...originalRegime, generatedAt: tenMinAgo });
    } finally { console.warn = origWarn; }
    const regressionWarns = captured.filter((s) => /would regress generatedAt/i.test(s));
    assert.equal(regressionWarns.length, 1, `expected exactly one warning, got: ${captured.join(" | ")}`);
    assert.match(regressionWarns[0], /600s/, `warning should mention the 600s delta: ${regressionWarns[0]}`);
    restore();
  });

  await it("write proceeds despite regression (we don't refuse — per adversarial Attack 5)", async () => {
    const fiveMinAgo = new Date(new Date(originalRegime.generatedAt).getTime() - 300 * 1000).toISOString();
    await storage.write({ ...originalRegime, generatedAt: fiveMinAgo });
    const onDisk = JSON.parse(fs.readFileSync(REAL_FILE, "utf-8"));
    assert.equal(onDisk.generatedAt, fiveMinAgo,
      "write should still land — defensive log is informational, not blocking");
    restore();
  });
}

try {
  await main();
} finally {
  // Restore env + file before exit no matter what.
  if (SAVED_NODE_ENV !== undefined) process.env.NODE_ENV = SAVED_NODE_ENV;
  restore();
}

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
if (fail) process.exit(1);
