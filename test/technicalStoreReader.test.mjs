// technicalStoreReader — fail-open per-ticker Tier-2 lookup (Two-Key Entry PR-4).
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTechnicals, getTechnicals, normalizeTicker } from "../services/entry/technicalStoreReader.js";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (e) {
    failed++;
    console.error(`  not ok ${name}\n    ${e.message}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tech-reader-"));
const NOW = Date.parse("2026-07-03T12:00:00Z");
const fresh = new Date(NOW - 2 * 3600 * 1000).toISOString(); // 2h old
const stale = new Date(NOW - 200 * 3600 * 1000).toISOString(); // 200h old

const goodPath = path.join(dir, "indicators-latest.json");
fs.writeFileSync(
  goodPath,
  JSON.stringify({
    generatedAt: fresh,
    indicators: {
      RELIANCE: { rsi14: 48.2, dma50: 1301.5, atr14: 22.1, rs_vs_nifty_pct: 1.4, as_of: fresh },
      OLDCO: { rsi14: 61, dma50: 100, atr14: 3, as_of: stale },
      NOASOF: { rsi14: 50 },
    },
  }),
);

check("happy read returns the fresh entry", () => {
  loadTechnicals.reset();
  const t = getTechnicals("RELIANCE", { filePath: goodPath, now: NOW });
  assert.equal(t.rsi14, 48.2);
  assert.equal(t.atr14, 22.1);
});

check("ticker normalization: RELIANCE.NS / reliance.bo hit the same entry", () => {
  assert.equal(normalizeTicker("RELIANCE.NS"), "RELIANCE");
  assert.equal(normalizeTicker("reliance.BO"), "RELIANCE");
  loadTechnicals.reset();
  assert.ok(getTechnicals("RELIANCE.NS", { filePath: goodPath, now: NOW }));
});

check("stale entry (>96h) → null, per-ticker fail-open", () => {
  loadTechnicals.reset();
  assert.equal(getTechnicals("OLDCO", { filePath: goodPath, now: NOW }), null);
});

check("missing as_of → null (cannot prove freshness)", () => {
  loadTechnicals.reset();
  assert.equal(getTechnicals("NOASOF", { filePath: goodPath, now: NOW }), null);
});

check("unknown ticker → null", () => {
  loadTechnicals.reset();
  assert.equal(getTechnicals("NOPE", { filePath: goodPath, now: NOW }), null);
});

check("missing file → null, no throw", () => {
  loadTechnicals.reset();
  assert.equal(getTechnicals("RELIANCE", { filePath: path.join(dir, "absent.json"), now: NOW }), null);
});

check("malformed JSON → null, no throw", () => {
  const badPath = path.join(dir, "bad.json");
  fs.writeFileSync(badPath, "{not json");
  loadTechnicals.reset();
  assert.equal(getTechnicals("RELIANCE", { filePath: badPath, now: NOW }), null);
});

check("module cache + reset(): reload picks up a rewritten file", () => {
  const p = path.join(dir, "reload.json");
  fs.writeFileSync(p, JSON.stringify({ indicators: { A: { rsi14: 1, as_of: fresh } } }));
  loadTechnicals.reset();
  assert.ok(getTechnicals("A", { filePath: p, now: NOW }));
  fs.writeFileSync(p, JSON.stringify({ indicators: { B: { rsi14: 2, as_of: fresh } } }));
  // cached: still the old view
  assert.ok(getTechnicals("A", { filePath: p, now: NOW }));
  loadTechnicals.reset();
  assert.equal(getTechnicals("A", { filePath: p, now: NOW }), null);
  assert.ok(getTechnicals("B", { filePath: p, now: NOW }));
});

console.log(`\ntechnicalStoreReader result: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
