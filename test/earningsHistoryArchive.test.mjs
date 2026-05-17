// services/earnings/earningsHistoryArchive.js — unit tests.
//
// The backtest harness lives or dies by this module: a subtle bug in the
// dedup / predictor-version bucketing silently corrupts the V1 cap-lift
// gate (per CLAUDE.md: "computed over the latest version only, never a
// cross-version average"). These tests lock down:
//
//   • HISTORY_SCHEMA_VERSION — current stamp
//   • computeCalibration — dedup by (symbol, event_iso_date) across
//     daily snapshots, per-predictor-version bucketing, cap-lift gate
//     sourced from the LATEST version's rows only
//   • archivePredictions + loadAllHistory file-system roundtrip
//     (executed in child processes with cwd set to a tempdir, because
//     HISTORY_DIR is frozen at module load-time — see "Source caveat"
//     below)
//   • malformed / empty file handling
//
// Source caveat
// ─────────────
// services/earnings/earningsHistoryArchive.js:53–54 captures
//   const ROOT = process.cwd();
//   const HISTORY_DIR = path.join(ROOT, "data", "catalysts", "earnings-history");
// at TOP-LEVEL when the module is first imported. Once frozen, process.
// chdir() at runtime has no effect on where the writer/reader looks. This
// is fine for production (one cwd for the whole process) but means tests
// importing the module in-process write to the REAL repo's data/ tree —
// which I discovered the hard way. Mitigation: FS tests fork a child
// node process per case so the module-level cwd capture happens after
// process.chdir(tempdir).
//
// Run: node test/earningsHistoryArchive.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  HISTORY_SCHEMA_VERSION,
  computeCalibration,
  bootstrapHitRateCI,
  dedupePredictions,
} from "../services/earnings/earningsHistoryArchive.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MODULE_PATH = path.join(REPO_ROOT, "services", "earnings", "earningsHistoryArchive.js");

let ok = 0, fail = 0;
const tests = [];
function it(name, fn) { tests.push({ name, fn }); }

/* ─────────────────── tempdir + child-process harness ───────────────── */

function freshTempDir() {
  const dir = path.join(os.tmpdir(), `earningsHistoryArchive-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Run a small ESM script INSIDE a child node process whose cwd is `tempDir`,
// so the module's top-level `process.cwd()` capture lands on the tempdir
// rather than the real repo. The script imports the module via an absolute
// file:// URL (NOT a relative specifier — the child's cwd is the tempdir,
// not the test dir) and writes its result to `<tempDir>/__out.json`.
function runInTempCwd(tempDir, body) {
  const moduleUrl = "file://" + MODULE_PATH;
  const script = `
import { writeFileSync } from "node:fs";
import * as M from ${JSON.stringify(moduleUrl)};
const { HISTORY_SCHEMA_VERSION, archivePredictions, loadAllHistory, computeCalibration } = M;
const __result = await (async () => { ${body} })();
writeFileSync("__out.json", JSON.stringify(__result ?? null));
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: tempDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = fs.readFileSync(path.join(tempDir, "__out.json"), "utf8");
  return JSON.parse(out);
}

function cleanup(tempDir) {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

// Minimal event shape that archivePredictions consumes.
function makeEvent(o = {}) {
  return {
    symbol: o.symbol || "RELIANCE",
    fiscal_quarter: o.fiscal_quarter || "Q4 FY26",
    event_iso_date: o.event_iso_date || "2026-04-24",
    days_until: o.days_until ?? 7,
    signals: {
      data_quality: o.data_quality || "OK",
      sector: o.sector || "Energy",
      sws_upcoming_earnings: { current_price_inr: o.price ?? 1500 },
      momentum: { pre_runup_signal: o.runup || "NEUTRAL" },
      llm_signal: o.llm_signal || null,
    },
    prediction: {
      predictor_version: o.predictor_version || "v1",
      verdict: o.predicted_verdict || "BEAT",
      confidence_pct: o.confidence_pct ?? 62,
      score_100: o.score_100 ?? 70,
      score_breakdown: o.score_breakdown || null,
    },
    playbook: { version: o.playbook_version || "pb-1" },
  };
}

// Compact builder for already-archived prediction rows (used by the
// pure computeCalibration tests). Use the `in` check so callers can
// explicitly pass `null` (e.g. to test dropped-row handling) without
// the default kicking in.
function row(o = {}) {
  return {
    symbol: "symbol" in o ? o.symbol : "X",
    event_iso_date: "event_iso_date" in o ? o.event_iso_date : "2026-04-22",
    predictor_version: "predictor_version" in o ? o.predictor_version : "v1",
    predicted_verdict: o.predicted_verdict || "BEAT",
    confidence_pct: o.confidence_pct ?? 62,
    actual_verdict: o.actual_verdict ?? null,
    llm_signal: "llm_signal" in o ? o.llm_signal : null,
  };
}
// One-day snapshot wrapper.
const day = (today_iso, predictions) => ({ filename: `${today_iso}.json`, today_iso, predictions });

/* ─────────────────── HISTORY_SCHEMA_VERSION ───────────────────────── */

console.log("[1] HISTORY_SCHEMA_VERSION");
it("export is the current v4 tag", () => {
  assert.equal(HISTORY_SCHEMA_VERSION, "earnings-history-v4");
});

/* ─────────────────── archivePredictions writer (child proc) ────────── */

console.log("[2] archivePredictions — writes file, stamps schema");
it("creates today's file with schema_version + event_count", () => {
  const dir = freshTempDir();
  try {
    const eventsJson = JSON.stringify([makeEvent({ symbol: "TCS" }), makeEvent({ symbol: "INFY" })]);
    const result = runInTempCwd(dir, `
      const events = ${eventsJson};
      const res = archivePredictions(events, { todayIso: "2026-05-10" });
      return res;
    `);
    assert.equal(result.event_count, 2);
    assert.equal(result.preserved_actuals, 0);
    assert.ok(result.path.endsWith("2026-05-10.json"));

    const expectedPath = path.join(dir, "data", "catalysts", "earnings-history", "2026-05-10.json");
    assert.ok(fs.existsSync(expectedPath), "file should be under tempdir, not the repo");
    const payload = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
    assert.equal(payload.schema_version, HISTORY_SCHEMA_VERSION);
    assert.equal(payload.today_iso, "2026-05-10");
    assert.equal(payload.event_count, 2);
    assert.equal(payload.predictions.length, 2);
    assert.ok(typeof payload.refresh_iso === "string" && payload.refresh_iso.endsWith("Z"));
    const tcs = payload.predictions.find((r) => r.symbol === "TCS");
    assert.equal(tcs.predicted_verdict, "BEAT");
    assert.equal(tcs.predictor_version, "v1");
    assert.equal(tcs.actual_verdict, null);
    assert.deepEqual(tcs.actual_history, []);
    assert.equal(tcs.backfilled, false);
  } finally { cleanup(dir); }
});

it("skips events with no symbol", () => {
  const dir = freshTempDir();
  try {
    const eventsJson = JSON.stringify([makeEvent({ symbol: "TCS" }), null, { signals: {} }, makeEvent({ symbol: "INFY" })]);
    const result = runInTempCwd(dir, `
      const events = ${eventsJson};
      return archivePredictions(events, { todayIso: "2026-05-10" });
    `);
    assert.equal(result.event_count, 2);
  } finally { cleanup(dir); }
});

it("empty events array → empty file with stamp", () => {
  const dir = freshTempDir();
  try {
    const result = runInTempCwd(dir, `
      return archivePredictions([], { todayIso: "2026-05-10" });
    `);
    assert.equal(result.event_count, 0);
    const payload = JSON.parse(fs.readFileSync(path.join(dir, "data", "catalysts", "earnings-history", "2026-05-10.json"), "utf8"));
    assert.equal(payload.schema_version, HISTORY_SCHEMA_VERSION);
    assert.deepEqual(payload.predictions, []);
  } finally { cleanup(dir); }
});

console.log("[3] archivePredictions — preserves actuals across refreshes");
it("actual_* fields from prior file carry forward on re-archive", () => {
  const dir = freshTempDir();
  try {
    const eventsJson = JSON.stringify([makeEvent({ symbol: "TCS", event_iso_date: "2026-04-24" })]);
    const result = runInTempCwd(dir, `
      const events = ${eventsJson};
      // First write — vanilla.
      archivePredictions(events, { todayIso: "2026-05-10" });
      // Simulate the post-event actuals ingester mutating the file.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const fp = path.join(process.cwd(), "data", "catalysts", "earnings-history", "2026-05-10.json");
      const cur = JSON.parse(fs.readFileSync(fp, "utf8"));
      cur.predictions[0].actual_verdict = "BEAT";
      cur.predictions[0].actual_t1_close_inr = 1612;
      cur.predictions[0].actual_source = "sws_news";
      cur.predictions[0].actual_evidence = "Full year 2026 earnings: EPS exceeds ...";
      cur.predictions[0].resolved_at_iso = "2026-04-26T22:54:28.000Z";
      cur.predictions[0].actual_history = [{ verdict: "INLINE", revised_iso: "2026-04-25" }];
      cur.predictions[0].backfilled = true;
      fs.writeFileSync(fp, JSON.stringify(cur, null, 2));
      // Re-archive — actuals must carry forward.
      const res2 = archivePredictions(events, { todayIso: "2026-05-10" });
      const after = JSON.parse(fs.readFileSync(fp, "utf8"));
      return { res2, after };
    `);

    assert.equal(result.res2.preserved_actuals, 1);
    const tcs = result.after.predictions[0];
    assert.equal(tcs.actual_verdict, "BEAT");
    assert.equal(tcs.actual_t1_close_inr, 1612);
    assert.equal(tcs.actual_source, "sws_news");
    assert.match(tcs.actual_evidence, /exceeds/);
    assert.equal(tcs.resolved_at_iso, "2026-04-26T22:54:28.000Z");
    assert.equal(tcs.backfilled, true);
    assert.equal(tcs.actual_history.length, 1);
  } finally { cleanup(dir); }
});

it("malformed prior file is treated as empty (no throw, no preserved)", () => {
  const dir = freshTempDir();
  try {
    // Pre-seed the tempdir with a corrupt prior file.
    const histDir = path.join(dir, "data", "catalysts", "earnings-history");
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(path.join(histDir, "2026-05-10.json"), "not valid json {");

    const eventsJson = JSON.stringify([makeEvent({ symbol: "TCS" })]);
    const result = runInTempCwd(dir, `
      const events = ${eventsJson};
      return archivePredictions(events, { todayIso: "2026-05-10" });
    `);
    assert.equal(result.event_count, 1);
    assert.equal(result.preserved_actuals, 0);
    const payload = JSON.parse(fs.readFileSync(path.join(histDir, "2026-05-10.json"), "utf8"));
    assert.equal(payload.schema_version, HISTORY_SCHEMA_VERSION);
  } finally { cleanup(dir); }
});

/* ─────────────────── loadAllHistory reader ─────────────────────────── */

console.log("[4] loadAllHistory");
it("returns [] when HISTORY_DIR does not exist", () => {
  const dir = freshTempDir();
  try {
    const result = runInTempCwd(dir, `return loadAllHistory();`);
    assert.deepEqual(result, []);
  } finally { cleanup(dir); }
});

it("loads files sorted ascending by filename", () => {
  const dir = freshTempDir();
  try {
    const result = runInTempCwd(dir, `
      const e = (sym, day) => ({ symbol: sym, fiscal_quarter: "Q4 FY26", event_iso_date: "2026-04-24", days_until: 1,
        signals: { data_quality: "OK", sector: "X", sws_upcoming_earnings: { current_price_inr: 100 }, momentum: { pre_runup_signal: "NEUTRAL" } },
        prediction: { predictor_version: "v1", verdict: "BEAT", confidence_pct: 62, score_100: 70 }, playbook: { version: "pb-1" } });
      archivePredictions([e("A", "2026-05-12")], { todayIso: "2026-05-12" });
      archivePredictions([e("B", "2026-05-09")], { todayIso: "2026-05-09" });
      archivePredictions([e("C", "2026-05-11")], { todayIso: "2026-05-11" });
      return loadAllHistory();
    `);
    assert.equal(result.length, 3);
    assert.deepEqual(result.map((d) => d.today_iso), ["2026-05-09", "2026-05-11", "2026-05-12"]);
    assert.ok(result.every((d) => typeof d.filename === "string" && d.filename.endsWith(".json")));
  } finally { cleanup(dir); }
});

it("skips corrupt files instead of throwing", () => {
  const dir = freshTempDir();
  try {
    const result = runInTempCwd(dir, `
      const e = { symbol: "A", fiscal_quarter: "Q4 FY26", event_iso_date: "2026-04-24", days_until: 1,
        signals: { data_quality: "OK", sector: "X", sws_upcoming_earnings: { current_price_inr: 100 }, momentum: { pre_runup_signal: "NEUTRAL" } },
        prediction: { predictor_version: "v1", verdict: "BEAT", confidence_pct: 62, score_100: 70 }, playbook: { version: "pb-1" } };
      archivePredictions([e], { todayIso: "2026-05-10" });
      const fs = await import("node:fs");
      const path = await import("node:path");
      fs.writeFileSync(path.join(process.cwd(), "data", "catalysts", "earnings-history", "2026-05-11.json"), "definitely not json");
      return loadAllHistory();
    `);
    assert.equal(result.length, 1);
    assert.equal(result[0].today_iso, "2026-05-10");
  } finally { cleanup(dir); }
});

it("only .json files are read", () => {
  const dir = freshTempDir();
  try {
    const result = runInTempCwd(dir, `
      const e = { symbol: "A", fiscal_quarter: "Q4 FY26", event_iso_date: "2026-04-24", days_until: 1,
        signals: { data_quality: "OK", sector: "X", sws_upcoming_earnings: { current_price_inr: 100 }, momentum: { pre_runup_signal: "NEUTRAL" } },
        prediction: { predictor_version: "v1", verdict: "BEAT", confidence_pct: 62, score_100: 70 }, playbook: { version: "pb-1" } };
      archivePredictions([e], { todayIso: "2026-05-10" });
      const fs = await import("node:fs");
      const path = await import("node:path");
      const dir = path.join(process.cwd(), "data", "catalysts", "earnings-history");
      fs.writeFileSync(path.join(dir, "README.md"), "# notes");
      fs.writeFileSync(path.join(dir, "scratch.txt"), "tmp");
      return loadAllHistory();
    `);
    assert.equal(result.length, 1);
  } finally { cleanup(dir); }
});

/* ─────────────────── computeCalibration — dedup ────────────────────── */
//
// Per CLAUDE.md: "Predictions are deduped by (symbol, event_iso_date)
// across daily snapshots". A naive sum would triple-count an event
// archived into three consecutive refreshes — fatal for hit-rate.
// These are pure in-process tests; no FS needed.

console.log("[5] computeCalibration — dedup across daily snapshots");
it("same (symbol, event_iso_date) in 3 snapshots → 1 resolved row", () => {
  // 3 snapshots of the same event; only the last has the actual filled.
  // Dedup rule: resolved beats unresolved → count once, hit-rate 100%
  // (NOT 33% as a naive sum would yield).
  const r = (actual) => row({ symbol: "RELIANCE", event_iso_date: "2026-04-24", actual_verdict: actual });
  const cal = computeCalibration([
    day("2026-04-22", [r(null)]),
    day("2026-04-23", [r(null)]),
    day("2026-04-26", [r("BEAT")]),
  ]);
  assert.equal(cal.resolved_count, 1);
  assert.equal(cal.unresolved_count, 0);
  assert.equal(cal.hit_rate_overall_pct, 100);
});

it("resolved row beats unresolved one regardless of snapshot order", () => {
  // Resolved in EARLIER snapshot, re-nulled in LATER (e.g. archive
  // rebuild). Dedup must still pick the resolved one.
  const r = (actual) => row({ symbol: "INFY", event_iso_date: "2026-04-22", actual_verdict: actual });
  const cal = computeCalibration([
    day("2026-04-26", [r("BEAT")]),
    day("2026-04-27", [r(null)]),
  ]);
  assert.equal(cal.resolved_count, 1);
  assert.equal(cal.unresolved_count, 0);
  assert.equal(cal.hit_rate_overall_pct, 100);
});

it("distinct events count separately", () => {
  const cal = computeCalibration([day("2026-04-26", [
    row({ symbol: "A", event_iso_date: "2026-04-22", actual_verdict: "BEAT" }),
    row({ symbol: "B", event_iso_date: "2026-04-22", actual_verdict: "MISS" }),
    row({ symbol: "A", event_iso_date: "2026-07-22", predicted_verdict: "INLINE", actual_verdict: "INLINE" }),
  ])]);
  assert.equal(cal.resolved_count, 3);
  assert.equal(cal.hit_rate_overall_pct, 66.7);
});

it("rows missing symbol or event_iso_date are silently dropped by dedup", () => {
  const cal = computeCalibration([day("2026-04-26", [
    row({ symbol: null, actual_verdict: "BEAT" }),
    row({ symbol: "OK", event_iso_date: null, actual_verdict: "BEAT" }),
    row({ symbol: "OK", event_iso_date: "2026-04-22", actual_verdict: "BEAT" }),
  ])]);
  assert.equal(cal.resolved_count, 1);
});

/* ─────────────────── computeCalibration — version bucketing ────────── */

console.log("[6] computeCalibration — predictor_version bucketing");
// Helper for the version-bucketing tests: 30 distinct BEAT-hits under
// a given version, all in the 60-64 confidence bucket.
const thirtyHits = (version) =>
  Array.from({ length: 30 }, (_, i) =>
    row({ symbol: `S${i}-${version}`, predictor_version: version, actual_verdict: "BEAT" })
  );

it("v1 + v2 rows split into separate buckets", () => {
  const cal = computeCalibration([day("2026-04-26", [
    row({ symbol: "A", predictor_version: "v1", actual_verdict: "BEAT" }),
    row({ symbol: "B", predictor_version: "v1", actual_verdict: "MISS" }),
    row({ symbol: "C", predictor_version: "v2", actual_verdict: "BEAT" }),
  ])]);
  assert.equal(cal.by_predictor_version.v1.resolved_count, 2);
  assert.equal(cal.by_predictor_version.v1.hit_rate_overall_pct, 50);
  assert.equal(cal.by_predictor_version.v2.resolved_count, 1);
  assert.equal(cal.by_predictor_version.v2.hit_rate_overall_pct, 100);
  assert.equal(cal.latest_predictor_version, "v2");
});

it("cap-lift gate sourced from LATEST predictor version only", () => {
  // v1: 30 hits → clears the gate standalone. v2: 1 row → can't.
  // The top-level gate must reflect v2, NOT a v1+v2 average (which
  // would silently green-light a cap-lift for the current model on
  // stale-version data).
  const cal = computeCalibration([day("2026-04-26", [
    ...thirtyHits("v1"),
    row({ symbol: "Z", predictor_version: "v2", actual_verdict: "BEAT" }),
  ])]);
  assert.equal(cal.by_predictor_version.v1.enough_data_to_lift_cap, true);
  assert.equal(cal.enough_data_to_lift_cap, false);
  assert.equal(cal.cap_lift_gate.predictor_version, "v2");
  assert.equal(cal.cap_lift_gate.current_resolved, 1);
});

it("rows with no predictor_version go into 'unknown' and are excluded from latest", () => {
  const cal = computeCalibration([day("2026-04-26", [
    row({ symbol: "A", predictor_version: null, actual_verdict: "BEAT" }),
    row({ symbol: "B", predictor_version: "v1", actual_verdict: "BEAT" }),
  ])]);
  assert.ok(cal.by_predictor_version.unknown);
  assert.ok(cal.by_predictor_version.v1);
  assert.equal(cal.latest_predictor_version, "v1");
});

it("only 'unknown' rows → latest_predictor_version null, gate falls back to overall", () => {
  const cal = computeCalibration([day("2026-04-26", [
    row({ symbol: "A", predictor_version: null, actual_verdict: "BEAT" }),
  ])]);
  assert.equal(cal.latest_predictor_version, null);
  assert.equal(cal.cap_lift_gate.predictor_version, null);
});

/* ─────────────────── cap-lift gate triple-condition ────────────────── */

console.log("[7] computeCalibration — cap-lift gate triple-condition");
it("≥30 resolved + ≥55% in 60-64 + Brier <0.20 → cap_lift true", () => {
  const cal = computeCalibration([day("2026-04-26", thirtyHits("v1"))]);
  assert.equal(cal.enough_data_to_lift_cap, true);
  assert.equal(cal.cap_lift_gate.current_resolved, 30);
  assert.ok(cal.cap_lift_gate.current_bucket_60_64_hit_rate >= 55);
  assert.ok(cal.cap_lift_gate.current_brier < 0.20);
});

it("<30 resolved → gate fails on count", () => {
  const cal = computeCalibration([day("2026-04-26", thirtyHits("v1").slice(0, 29))]);
  assert.equal(cal.enough_data_to_lift_cap, false);
});

it("bucket 60-64 hit-rate <55% → gate fails on calibration", () => {
  // 30 rows at 62% predicted-BEAT but actual-MISS → 0% bucket hit-rate.
  const preds = Array.from({ length: 30 }, (_, i) =>
    row({ symbol: `S${i}`, actual_verdict: "MISS" })
  );
  const cal = computeCalibration([day("2026-04-26", preds)]);
  assert.equal(cal.enough_data_to_lift_cap, false);
  assert.equal(cal.cap_lift_gate.current_bucket_60_64_hit_rate, 0);
});

/* ─────────────────── archive → load → calibrate roundtrip ──────────── */

console.log("[8] file-system roundtrip");
it("archivePredictions → loadAllHistory → computeCalibration coherent", () => {
  const dir = freshTempDir();
  try {
    const eventsJson = JSON.stringify([
      makeEvent({ symbol: "TCS", event_iso_date: "2026-04-24", confidence_pct: 62 }),
      makeEvent({ symbol: "INFY", event_iso_date: "2026-04-24", confidence_pct: 62 }),
    ]);
    const result = runInTempCwd(dir, `
      const events = ${eventsJson};
      // Same calendar archived on two consecutive days — dedup must
      // collapse to 2 unresolved rows, not 4.
      archivePredictions(events, { todayIso: "2026-05-10" });
      archivePredictions(events, { todayIso: "2026-05-11" });
      const hist = loadAllHistory();
      const cal = computeCalibration(hist);
      return { count: hist.length, cal };
    `);
    assert.equal(result.count, 2);
    assert.equal(result.cal.resolved_count, 0);
    assert.equal(result.cal.unresolved_count, 2);
    assert.equal(result.cal.hit_rate_overall_pct, null);
  } finally { cleanup(dir); }
});

/* ─────────────────── bootstrap CI on hit-rate (P2.3) ──────────────── */
//
// SEBI-RA roadmap P2.3: bootstrap CIs alongside every hit-rate field
// so a 55% point-estimate over n=47 can be statistically distinguished
// from 50% random chance. These tests cover both the helper directly
// and the additive shape change inside computeCalibration().

console.log("[9] bootstrap CI on hit-rate");

it("normal n>=30 sample returns numeric CI with low<=hit<=high", () => {
  // 30 resolved rows, 18 hits and 12 misses — a realistic n with a
  // non-degenerate distribution so the bootstrap actually has spread.
  const preds = [];
  for (let i = 0; i < 18; i++) preds.push({ predicted_verdict: "BEAT", actual_verdict: "BEAT" });
  for (let i = 0; i < 12; i++) preds.push({ predicted_verdict: "BEAT", actual_verdict: "MISS" });
  const ci = bootstrapHitRateCI(preds);
  assert.equal(ci.sample_size, 30);
  assert.equal(typeof ci.hit_rate, "number");
  assert.equal(typeof ci.ci_low, "number");
  assert.equal(typeof ci.ci_high, "number");
  assert.ok(ci.ci_low <= ci.hit_rate, `ci_low ${ci.ci_low} > hit_rate ${ci.hit_rate}`);
  assert.ok(ci.hit_rate <= ci.ci_high, `hit_rate ${ci.hit_rate} > ci_high ${ci.ci_high}`);
  // Sanity-check on the bootstrap spread: with n=30 and p=0.6 the
  // 95% CI should plausibly be ≥0.10 wide and definitely not >0.5.
  const width = ci.ci_high - ci.ci_low;
  assert.ok(width > 0.05 && width < 0.5, `unrealistic CI width ${width}`);
});

it("sample_size < 5 returns null CI bounds (hit_rate still computed)", () => {
  // 4 rows — too few for a meaningful bootstrap percentile.
  const preds = [
    { predicted_verdict: "BEAT", actual_verdict: "BEAT" },
    { predicted_verdict: "BEAT", actual_verdict: "MISS" },
    { predicted_verdict: "BEAT", actual_verdict: "BEAT" },
    { predicted_verdict: "BEAT", actual_verdict: "MISS" },
  ];
  const ci = bootstrapHitRateCI(preds);
  assert.equal(ci.sample_size, 4);
  assert.equal(ci.hit_rate, 0.5);
  assert.equal(ci.ci_low, null);
  assert.equal(ci.ci_high, null);

  // n=0 is the degenerate case: no point estimate either.
  const empty = bootstrapHitRateCI([]);
  assert.equal(empty.sample_size, 0);
  assert.equal(empty.hit_rate, null);
  assert.equal(empty.ci_low, null);
  assert.equal(empty.ci_high, null);
});

it("all-hits sample → CI collapses to 1.0/1.0/1.0", () => {
  const preds = Array.from({ length: 12 }, () => ({ predicted_verdict: "BEAT", actual_verdict: "BEAT" }));
  const ci = bootstrapHitRateCI(preds);
  assert.equal(ci.hit_rate, 1.0);
  assert.equal(ci.ci_low, 1.0);
  assert.equal(ci.ci_high, 1.0);
  assert.equal(ci.sample_size, 12);
});

it("all-misses sample → CI collapses to 0.0/0.0/0.0", () => {
  const preds = Array.from({ length: 12 }, () => ({ predicted_verdict: "BEAT", actual_verdict: "MISS" }));
  const ci = bootstrapHitRateCI(preds);
  assert.equal(ci.hit_rate, 0.0);
  assert.equal(ci.ci_low, 0.0);
  assert.equal(ci.ci_high, 0.0);
  assert.equal(ci.sample_size, 12);
});

console.log("[10] computeCalibration — CI field shape");

it("computeCalibration emits CI siblings for overall hit-rate", () => {
  // 10 BEATs predicted, 6 hit / 4 miss — n=10 is enough for the
  // bootstrap to return numeric bounds.
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(row({ symbol: `H${i}`, event_iso_date: `2026-04-${10 + i}`, actual_verdict: "BEAT" }));
  for (let i = 0; i < 4; i++) rows.push(row({ symbol: `M${i}`, event_iso_date: `2026-04-${20 + i}`, actual_verdict: "MISS" }));
  const cal = computeCalibration([day("2026-04-26", rows)]);

  // Existing fields untouched.
  assert.equal(cal.resolved_count, 10);
  assert.equal(cal.hit_rate_overall_pct, 60);

  // CI siblings present with the documented shape.
  assert.equal(typeof cal.hit_rate_overall_ci_low_pct, "number");
  assert.equal(typeof cal.hit_rate_overall_ci_high_pct, "number");
  assert.equal(cal.hit_rate_overall_sample_size, 10);
  assert.ok(cal.hit_rate_overall_ci_low_pct <= cal.hit_rate_overall_pct);
  assert.ok(cal.hit_rate_overall_pct <= cal.hit_rate_overall_ci_high_pct);
  // CI bounds are on the 0–100 scale, matching the rest of the `_pct`
  // fields in this module.
  assert.ok(cal.hit_rate_overall_ci_low_pct >= 0 && cal.hit_rate_overall_ci_high_pct <= 100);
});

it("per-bucket CIs computed independently — small bucket gets null, large bucket gets numeric", () => {
  // Two buckets:
  //   • 60-64: 10 rows at confidence 62 (5 hit, 5 miss) → numeric CI
  //   • 80-84: 3 rows at confidence 82 (1 hit, 2 miss) → null CI (n<5)
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(row({ symbol: `A${i}`, event_iso_date: `2026-04-${10 + i}`, confidence_pct: 62, actual_verdict: "BEAT" }));
  for (let i = 0; i < 5; i++) rows.push(row({ symbol: `B${i}`, event_iso_date: `2026-04-${15 + i}`, confidence_pct: 62, actual_verdict: "MISS" }));
  rows.push(row({ symbol: "C1", event_iso_date: "2026-04-20", confidence_pct: 82, actual_verdict: "BEAT" }));
  rows.push(row({ symbol: "C2", event_iso_date: "2026-04-21", confidence_pct: 82, actual_verdict: "MISS" }));
  rows.push(row({ symbol: "C3", event_iso_date: "2026-04-22", confidence_pct: 82, actual_verdict: "MISS" }));

  const cal = computeCalibration([day("2026-04-26", rows)]);
  assert.ok(cal.hit_rate_by_confidence_bucket_ci, "ci map must exist");
  assert.ok(cal.hit_rate_by_confidence_bucket_ci["60-64"], "60-64 bucket CI must exist");
  assert.ok(cal.hit_rate_by_confidence_bucket_ci["80-84"], "80-84 bucket CI must exist");

  const b6064 = cal.hit_rate_by_confidence_bucket_ci["60-64"];
  assert.equal(b6064.sample_size, 10);
  assert.equal(typeof b6064.ci_low_pct, "number");
  assert.equal(typeof b6064.ci_high_pct, "number");
  assert.ok(b6064.ci_low_pct <= b6064.hit_rate_pct);
  assert.ok(b6064.hit_rate_pct <= b6064.ci_high_pct);

  const b8084 = cal.hit_rate_by_confidence_bucket_ci["80-84"];
  assert.equal(b8084.sample_size, 3);
  assert.equal(b8084.ci_low_pct, null, "n<5 bucket must return null low");
  assert.equal(b8084.ci_high_pct, null, "n<5 bucket must return null high");

  // Per-verdict CIs follow the same shape (smoke-check the BEAT verdict
  // since every row above is a predicted-BEAT).
  assert.ok(cal.hit_rate_by_verdict_ci, "verdict ci map must exist");
  assert.ok(cal.hit_rate_by_verdict_ci.BEAT, "BEAT verdict CI must exist");
  assert.equal(cal.hit_rate_by_verdict_ci.BEAT.sample_size, 13);
});

it("output shape is strictly backwards-compatible — every legacy field still present", () => {
  // Single bucket / single verdict so we can assert deep field
  // presence without listing every key combination.
  const rows = [
    row({ symbol: "A", event_iso_date: "2026-04-22", actual_verdict: "BEAT" }),
    row({ symbol: "B", event_iso_date: "2026-04-23", actual_verdict: "MISS" }),
  ];
  const cal = computeCalibration([day("2026-04-26", rows)]);

  // Top-level legacy fields all present.
  for (const k of [
    "resolved_count", "unresolved_count",
    "hit_rate_overall_pct",
    "hit_rate_by_confidence_bucket", "hit_rate_by_verdict",
    "brier_score", "enough_data_to_lift_cap", "cap_lift_gate",
    "by_predictor_version", "latest_predictor_version",
  ]) {
    assert.ok(k in cal, `legacy field ${k} missing`);
  }
  // cap_lift_gate legacy fields all present.
  for (const k of [
    "resolved_required", "bucket_60_64_hit_rate_required", "max_brier_required",
    "current_resolved", "current_bucket_60_64_hit_rate", "current_brier",
  ]) {
    assert.ok(k in cal.cap_lift_gate, `legacy cap_lift_gate.${k} missing`);
  }
  // hit_rate_by_confidence_bucket / _by_verdict still emit bare numbers
  // (not the new CI-wrapped objects) — otherwise scripts/backtest-
  // earnings-predictions.mjs's fmtBucket() breaks.
  for (const v of Object.values(cal.hit_rate_by_confidence_bucket)) {
    assert.ok(v === null || typeof v === "number", "bucket map must stay bare numbers");
  }
  for (const v of Object.values(cal.hit_rate_by_verdict)) {
    assert.ok(v === null || typeof v === "number", "verdict map must stay bare numbers");
  }

  // by_predictor_version blocks inherit the same shape — CI siblings
  // appear there too.
  const v1 = cal.by_predictor_version.v1;
  assert.ok("hit_rate_overall_pct" in v1);
  assert.ok("hit_rate_overall_ci_low_pct" in v1);
  assert.ok("hit_rate_overall_ci_high_pct" in v1);
  assert.ok("hit_rate_overall_sample_size" in v1);
  assert.ok("hit_rate_by_confidence_bucket_ci" in v1);
  assert.ok("hit_rate_by_verdict_ci" in v1);
});

/* ─────────────────── computeCalibration — by_classifier_provider ──── */
//
// 2026-05-17 — the archive's schema-v4 llm_signal block has carried
// classifier_provider for weeks, but the calibration step never split
// metrics by it. Without that split we can't answer the standing
// question "is the LLM signal beating the heuristic on resolved
// actuals?" — the whole point of paying for an LLM call at all. These
// tests lock down the bucket-by-provider output and the bootstrap CI
// shape that mirrors the existing by_confidence_bucket / by_verdict
// blocks.

console.log("[12] computeCalibration — per-classifier-provider split");

it("splits hit-rate by classifier_provider when llm_signal is archived", () => {
  // 6 rows tagged "groq" (4 hit / 2 miss → 66.7%) and 4 rows tagged
  // "heuristic" (1 hit / 3 miss → 25%). Different tags → different
  // buckets, computed independently.
  const groqRows = [];
  for (let i = 0; i < 4; i++) groqRows.push(row({ symbol: `G${i}`, event_iso_date: `2026-04-${10 + i}`, actual_verdict: "BEAT", llm_signal: { classifier_provider: "groq" } }));
  for (let i = 0; i < 2; i++) groqRows.push(row({ symbol: `GM${i}`, event_iso_date: `2026-04-${14 + i}`, actual_verdict: "MISS", llm_signal: { classifier_provider: "groq" } }));
  const heurRows = [];
  heurRows.push(row({ symbol: "H1", event_iso_date: "2026-04-16", actual_verdict: "BEAT", llm_signal: { classifier_provider: "heuristic" } }));
  for (let i = 0; i < 3; i++) heurRows.push(row({ symbol: `HM${i}`, event_iso_date: `2026-04-${17 + i}`, actual_verdict: "MISS", llm_signal: { classifier_provider: "heuristic" } }));

  const cal = computeCalibration([day("2026-04-26", [...groqRows, ...heurRows])]);
  assert.equal(cal.hit_rate_by_classifier_provider.groq, 66.7);
  assert.equal(cal.hit_rate_by_classifier_provider.heuristic, 25);
});

it("rows without llm_signal are excluded from the provider map but counted overall", () => {
  // The point of excluding null-signal rows is that they would dilute
  // the per-provider hit-rate with rows that had no provider at all.
  // Overall hit-rate still includes them.
  const cal = computeCalibration([day("2026-04-26", [
    row({ symbol: "A", event_iso_date: "2026-04-10", actual_verdict: "BEAT", llm_signal: { classifier_provider: "gemini" } }),
    row({ symbol: "B", event_iso_date: "2026-04-11", actual_verdict: "BEAT", llm_signal: null }),
  ])]);
  assert.equal(cal.resolved_count, 2);
  assert.equal(cal.hit_rate_overall_pct, 100);
  assert.equal(cal.hit_rate_by_classifier_provider.gemini, 100);
  assert.equal(cal.hit_rate_by_classifier_provider.heuristic, undefined);
});

it("emits per-provider CI siblings with correct shape — large bucket numeric, small bucket null", () => {
  // 8 groq rows (n>=5 → numeric CI) and 3 gemini rows (n<5 → null CI).
  // Mirrors the existing per-bucket / per-verdict CI behaviour.
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(row({ symbol: `G${i}`, event_iso_date: `2026-04-${10 + i}`, actual_verdict: "BEAT", llm_signal: { classifier_provider: "groq" } }));
  for (let i = 0; i < 3; i++) rows.push(row({ symbol: `GG${i}`, event_iso_date: `2026-04-${15 + i}`, actual_verdict: "MISS", llm_signal: { classifier_provider: "groq" } }));
  for (let i = 0; i < 3; i++) rows.push(row({ symbol: `M${i}`, event_iso_date: `2026-04-${20 + i}`, actual_verdict: "BEAT", llm_signal: { classifier_provider: "gemini" } }));

  const cal = computeCalibration([day("2026-04-26", rows)]);
  const groqCI = cal.hit_rate_by_classifier_provider_ci.groq;
  assert.equal(groqCI.sample_size, 8);
  assert.equal(typeof groqCI.hit_rate_pct, "number");
  assert.equal(typeof groqCI.ci_low_pct, "number");
  assert.equal(typeof groqCI.ci_high_pct, "number");
  assert.ok(groqCI.ci_low_pct <= groqCI.hit_rate_pct);
  assert.ok(groqCI.hit_rate_pct <= groqCI.ci_high_pct);

  const geminiCI = cal.hit_rate_by_classifier_provider_ci.gemini;
  assert.equal(geminiCI.sample_size, 3);
  assert.equal(geminiCI.ci_low_pct, null);
  assert.equal(geminiCI.ci_high_pct, null);
});

/* ─────────────────── dedupePredictions — public export ────────────── */
//
// dedupePredictions was made public so recentResultsBuilder can reuse
// the same (symbol, event_iso_date) reconciliation logic the calibration
// path already relies on. Lock down the contract with direct tests.

console.log("[11] dedupePredictions — direct public API");

it("collapses (symbol, event_iso_date) across snapshots, tags each row with _today_iso", () => {
  const out = dedupePredictions([
    day("2026-05-14", [row({ symbol: "TCS", event_iso_date: "2026-05-14", actual_verdict: null })]),
    day("2026-05-15", [row({ symbol: "TCS", event_iso_date: "2026-05-14", actual_verdict: "BEAT" })]),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, "TCS");
  assert.equal(out[0].actual_verdict, "BEAT");
  assert.equal(out[0]._today_iso, "2026-05-15");
});

it("freshest resolved wins among multiple resolved snapshots", () => {
  const out = dedupePredictions([
    day("2026-05-15", [row({ symbol: "TCS", event_iso_date: "2026-05-14", actual_verdict: "INLINE" })]),
    day("2026-05-16", [row({ symbol: "TCS", event_iso_date: "2026-05-14", actual_verdict: "BEAT" })]),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].actual_verdict, "BEAT");
  assert.equal(out[0]._today_iso, "2026-05-16");
});

it("rows missing symbol or event_iso_date are silently dropped", () => {
  const out = dedupePredictions([
    day("2026-05-15", [
      row({ symbol: null, event_iso_date: "2026-05-14", actual_verdict: "BEAT" }),
      row({ symbol: "OK", event_iso_date: null, actual_verdict: "BEAT" }),
      row({ symbol: "OK", event_iso_date: "2026-05-14", actual_verdict: "BEAT" }),
    ]),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, "OK");
});

/* ───────────────────────── runner ─────────────────────────────────── */

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
