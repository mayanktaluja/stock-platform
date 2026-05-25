// services/earnings/recentResultsBuilder.js — unit tests.
//
// The recent-results builder powers the "Recent / status tracker · today
// + past 14 days" section in the Earnings Watch tab. It reads the per-refresh
// history archive (loadAllHistory keys files by REFRESH date — the
// same event lives in every snapshot until it passes) and emits a
// slim projection per (symbol, event_iso_date).
//
// Same module-level cwd capture as earningsHistoryArchive.js, so FS
// tests fork a child node process per case to make process.cwd()
// land on a tempdir before the import freezes the path.
//
// Run: node test/recentResultsBuilder.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ARCHIVE_MODULE = path.join(REPO_ROOT, "services", "earnings", "earningsHistoryArchive.js");
const BUILDER_MODULE = path.join(REPO_ROOT, "services", "earnings", "recentResultsBuilder.js");

let ok = 0, fail = 0;
const tests = [];
function it(name, fn) { tests.push({ name, fn }); }

function freshTempDir() {
  const dir = path.join(os.tmpdir(), `recentResultsBuilder-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(tempDir) {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

// Seed a history file directly (skipping archivePredictions) so the test
// can control the exact `actual_*` fields without going through the
// archiver's preserve-on-rewrite path.
function seedHistoryFile(tempDir, todayIso, predictions) {
  const dir = path.join(tempDir, "data", "catalysts", "earnings-history");
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    schema_version: "earnings-history-v4",
    refresh_iso: new Date().toISOString(),
    today_iso: todayIso,
    event_count: predictions.length,
    predictions,
  };
  fs.writeFileSync(path.join(dir, `${todayIso}.json`), JSON.stringify(payload, null, 2));
}

function pred(o = {}) {
  return {
    symbol: o.symbol || "RELIANCE",
    fiscal_quarter: o.fiscal_quarter || "Q4 FY26",
    event_iso_date: o.event_iso_date || "2026-05-10",
    days_until: o.days_until ?? -3,
    data_quality: o.data_quality || "HIGH",
    predictor_version: o.predictor_version || "v1",
    playbook_version: o.playbook_version || "pb-1",
    predicted_verdict: o.predicted_verdict || "BEAT",
    confidence_pct: o.confidence_pct ?? 62,
    score_100: o.score_100 ?? 70,
    price_at_snapshot_inr: o.price_at_snapshot_inr ?? 1500,
    runup_signal: o.runup_signal || "neutral",
    sector: o.sector || "Energy",
    actual_verdict: o.actual_verdict ?? null,
    actual_guidance_tone: null,
    actual_t1_close_inr: o.actual_t1_close_inr ?? null,
    actual_t1_open_gap_pct: o.actual_t1_open_gap_pct ?? null,
    resolved_at_iso: o.resolved_at_iso || null,
    actual_source: o.actual_source || null,
    actual_evidence: o.actual_evidence || null,
    actual_revised_iso: null,
    actual_history: [],
    backfilled: false,
    llm_signal: null,
    score_breakdown: null,
  };
}

// Run a snippet that imports the builder inside a child process whose
// cwd is the tempdir, so loadAllHistory looks at the seeded fixtures.
// Pass companyByEventKey as `Object` (JSON-serialisable); the builder
// accepts either a Map or an Object (callers in production use Map but
// the JSON bridge can only round-trip plain objects).
function runBuilder(tempDir, opts = {}) {
  const builderUrl = "file://" + BUILDER_MODULE;
  const script = `
import { writeFileSync } from "node:fs";
import { buildRecentResults } from ${JSON.stringify(builderUrl)};
const optsRaw = ${JSON.stringify(opts)};
const companyByEventKey = optsRaw.companyByEventKey
  ? new Map(Object.entries(optsRaw.companyByEventKey))
  : undefined;
const result = buildRecentResults({
  todayIso: optsRaw.todayIso,
  pastWindowDays: optsRaw.pastWindowDays,
  companyByEventKey,
});
writeFileSync("__out.json", JSON.stringify(result));
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: tempDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(fs.readFileSync(path.join(tempDir, "__out.json"), "utf8"));
}

console.log("[1] empty archive");
it("returns [] when history dir does not exist", () => {
  const dir = freshTempDir();
  try {
    const result = runBuilder(dir, { todayIso: "2026-05-17", pastWindowDays: 7 });
    assert.deepEqual(result, []);
  } finally { cleanup(dir); }
});

it("keeps unresolved rows as pending status rows", () => {
  const dir = freshTempDir();
  try {
    seedHistoryFile(dir, "2026-05-16", [
      pred({ symbol: "TCS", event_iso_date: "2026-05-14", actual_verdict: null }),
    ]);
    const result = runBuilder(dir, { todayIso: "2026-05-17", pastWindowDays: 7 });
    assert.equal(result.length, 1);
    assert.equal(result[0].actual_status, "PENDING");
    assert.equal(result[0].prediction_accuracy, "pending");
    assert.equal(result[0].actual_verdict, null);
  } finally { cleanup(dir); }
});

console.log("[2] filtering by past-window cutoff");
it("includes events inside the past N days, excludes ones older", () => {
  const dir = freshTempDir();
  try {
    seedHistoryFile(dir, "2026-05-16", [
      // 3 days back — inside the 7-day window
      pred({ symbol: "TCS", event_iso_date: "2026-05-14", actual_verdict: "BEAT", actual_t1_close_inr: 1612 }),
      // 8 days back — outside the window
      pred({ symbol: "INFY", event_iso_date: "2026-05-09", actual_verdict: "MISS", actual_t1_close_inr: 1200 }),
      // exactly 7 days back — on the boundary, must be included
      pred({ symbol: "WIPRO", event_iso_date: "2026-05-10", actual_verdict: "INLINE", actual_t1_close_inr: 250 }),
    ]);
    const result = runBuilder(dir, { todayIso: "2026-05-17", pastWindowDays: 7 });
    const syms = result.map((r) => r.symbol).sort();
    assert.deepEqual(syms, ["TCS", "WIPRO"]);
  } finally { cleanup(dir); }
});

it("default 14-day tracker includes today and excludes older-than-14d rows", () => {
  const dir = freshTempDir();
  try {
    seedHistoryFile(dir, "2026-05-17", [
      pred({ symbol: "TODAY", event_iso_date: "2026-05-17", actual_verdict: null }),
      pred({ symbol: "BOUNDARY", event_iso_date: "2026-05-03", actual_verdict: "BEAT" }),
      pred({ symbol: "TOO_OLD", event_iso_date: "2026-05-02", actual_verdict: "BEAT" }),
    ]);
    const result = runBuilder(dir, { todayIso: "2026-05-17" });
    const bySymbol = Object.fromEntries(result.map((r) => [r.symbol, r]));
    assert.deepEqual(result.map((r) => r.symbol).sort(), ["BOUNDARY", "TODAY"]);
    assert.equal(bySymbol.TODAY.actual_status, "PENDING");
    assert.equal(bySymbol.TODAY.prediction_accuracy, "pending");
    assert.equal(bySymbol.BOUNDARY.actual_status, "RESOLVED");
  } finally { cleanup(dir); }
});

it("excludes events in the future (defensive — should not appear in history but UI safety)", () => {
  const dir = freshTempDir();
  try {
    seedHistoryFile(dir, "2026-05-16", [
      pred({ symbol: "FUTURE", event_iso_date: "2026-05-20", actual_verdict: "BEAT" }),
      pred({ symbol: "PAST", event_iso_date: "2026-05-14", actual_verdict: "BEAT" }),
    ]);
    const result = runBuilder(dir, { todayIso: "2026-05-17", pastWindowDays: 7 });
    assert.equal(result.length, 1);
    assert.equal(result[0].symbol, "PAST");
  } finally { cleanup(dir); }
});

console.log("[3] dedup across daily snapshots");
it("same (symbol, event_iso_date) across 3 snapshots → 1 row, freshest resolved wins", () => {
  const dir = freshTempDir();
  try {
    seedHistoryFile(dir, "2026-05-14", [pred({ symbol: "TCS", event_iso_date: "2026-05-14", actual_verdict: null })]);
    seedHistoryFile(dir, "2026-05-15", [pred({ symbol: "TCS", event_iso_date: "2026-05-14", actual_verdict: "INLINE" })]);
    seedHistoryFile(dir, "2026-05-16", [pred({ symbol: "TCS", event_iso_date: "2026-05-14", actual_verdict: "BEAT", actual_t1_close_inr: 1612 })]);
    const result = runBuilder(dir, { todayIso: "2026-05-17", pastWindowDays: 7 });
    assert.equal(result.length, 1);
    assert.equal(result[0].actual_verdict, "BEAT");
    assert.equal(result[0].actual_t1_close_inr, 1612);
  } finally { cleanup(dir); }
});

console.log("[4] prediction_accuracy derivation");
it("hit when predicted == actual, miss when predicted != actual, pending before actual", () => {
  const dir = freshTempDir();
  try {
    seedHistoryFile(dir, "2026-05-16", [
      pred({ symbol: "HIT", event_iso_date: "2026-05-14", predicted_verdict: "BEAT", actual_verdict: "BEAT" }),
      pred({ symbol: "MISS_PRED", event_iso_date: "2026-05-15", predicted_verdict: "BEAT", actual_verdict: "MISS" }),
      pred({ symbol: "INLINE_HIT", event_iso_date: "2026-05-13", predicted_verdict: "INLINE", actual_verdict: "INLINE" }),
      pred({ symbol: "PENDING", event_iso_date: "2026-05-16", predicted_verdict: "BEAT", actual_verdict: null }),
    ]);
    const result = runBuilder(dir, { todayIso: "2026-05-17", pastWindowDays: 7 });
    const byKey = Object.fromEntries(result.map((r) => [r.symbol, r.prediction_accuracy]));
    assert.equal(byKey.HIT, "hit");
    assert.equal(byKey.MISS_PRED, "miss");
    assert.equal(byKey.INLINE_HIT, "hit");
    assert.equal(byKey.PENDING, "pending");
  } finally { cleanup(dir); }
});

console.log("[5] slim projection shape");
it("emits exactly the documented fields — no signals/playbook/rationale leak", () => {
  const dir = freshTempDir();
  try {
    seedHistoryFile(dir, "2026-05-16", [
      pred({
        symbol: "TCS",
        event_iso_date: "2026-05-14",
        actual_verdict: "BEAT",
        actual_t1_close_inr: 1612.45,
        actual_t1_open_gap_pct: 2.34,
        actual_source: "sws_news",
        actual_evidence: "Full year EPS exceeds expectations",
        resolved_at_iso: "2026-05-15T10:00:00.000Z",
      }),
    ]);
    const result = runBuilder(dir, {
      todayIso: "2026-05-17",
      pastWindowDays: 7,
      companyByEventKey: { "TCS|2026-05-14": "Tata Consultancy Services Limited" },
    });
    assert.equal(result.length, 1);
    const row = result[0];
    const expectedKeys = new Set([
      "symbol", "company", "fiscal_quarter", "event_iso_date", "days_until", "sector",
      "predicted_verdict", "confidence_pct", "score_100",
      "actual_verdict", "actual_t1_close_inr", "actual_t1_open_gap_pct",
      "actual_source", "actual_evidence", "actual_resolved_at",
      "actual_status", "prediction_accuracy",
    ]);
    const actualKeys = new Set(Object.keys(row));
    for (const k of expectedKeys) {
      assert.ok(actualKeys.has(k), `missing expected key: ${k}`);
    }
    for (const k of actualKeys) {
      assert.ok(expectedKeys.has(k), `unexpected key in slim projection: ${k}`);
    }
    // No signals/playbook/rationale/price_band leaked through.
    assert.equal(row.signals, undefined);
    assert.equal(row.playbook, undefined);
    assert.equal(row.rationale, undefined);
    assert.equal(row.price_band, undefined);
    // Company name flowed through from the companyByEventKey map.
    assert.equal(row.company, "Tata Consultancy Services Limited");
    // days_until is computed relative to todayIso (May 14 vs May 17 = -3)
    assert.equal(row.days_until, -3);
  } finally { cleanup(dir); }
});

console.log("[6] sort order");
it("sorts descending by event_iso_date (most recent first), then by symbol", () => {
  const dir = freshTempDir();
  try {
    seedHistoryFile(dir, "2026-05-16", [
      pred({ symbol: "A", event_iso_date: "2026-05-12", actual_verdict: "BEAT" }),
      pred({ symbol: "Z", event_iso_date: "2026-05-15", actual_verdict: "BEAT" }),
      pred({ symbol: "B", event_iso_date: "2026-05-15", actual_verdict: "BEAT" }),
      pred({ symbol: "C", event_iso_date: "2026-05-13", actual_verdict: "BEAT" }),
    ]);
    const result = runBuilder(dir, { todayIso: "2026-05-17", pastWindowDays: 7 });
    assert.deepEqual(result.map((r) => r.symbol), ["B", "Z", "C", "A"]);
  } finally { cleanup(dir); }
});

console.log("[7] companyByEventKey is optional");
it("works without companyByEventKey — sets company to null", () => {
  const dir = freshTempDir();
  try {
    seedHistoryFile(dir, "2026-05-16", [
      pred({ symbol: "TCS", event_iso_date: "2026-05-14", actual_verdict: "BEAT" }),
    ]);
    const result = runBuilder(dir, { todayIso: "2026-05-17", pastWindowDays: 7 });
    assert.equal(result.length, 1);
    assert.equal(result[0].company, null);
  } finally { cleanup(dir); }
});

console.log("[8] pastWindowDays=0 → no past rows");
it("pastWindowDays=0 returns no rows even when actuals exist", () => {
  const dir = freshTempDir();
  try {
    seedHistoryFile(dir, "2026-05-16", [
      pred({ symbol: "TCS", event_iso_date: "2026-05-14", actual_verdict: "BEAT" }),
    ]);
    const result = runBuilder(dir, { todayIso: "2026-05-17", pastWindowDays: 0 });
    assert.deepEqual(result, []);
  } finally { cleanup(dir); }
});

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
