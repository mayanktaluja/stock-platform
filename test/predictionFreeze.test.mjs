// services/earnings/predictionFreeze.js — unit tests.
//
// Locks down the due-event freeze invariant: once event_iso_date <= today,
// the user-visible prediction comes from the last pre-event archive row,
// not a same-day recomputation.

import assert from "node:assert/strict";

import {
  applyPredictionFreezes,
  buildFrozenPredictionRecords,
} from "../services/earnings/predictionFreeze.js";

let ok = 0, fail = 0;
const tests = [];
function it(name, fn) { tests.push({ name, fn }); }

const day = (today_iso, predictions) => ({ filename: `${today_iso}.json`, today_iso, predictions });
const row = (o = {}) => ({
  symbol: o.symbol || "MARKSANS",
  event_iso_date: o.event_iso_date || "2026-05-26",
  predicted_verdict: o.predicted_verdict || "BEAT",
  confidence_pct: o.confidence_pct ?? 54,
  score_100: o.score_100 ?? 59.5,
  predictor_version: o.predictor_version || "earnings-predict-v3-2026-05",
  score_breakdown: o.score_breakdown || { raw_sum: 9.5 },
  display_snapshot: o.display_snapshot || null,
});

console.log("[1] freeze record selection");
it("prefers latest pre-event archive over same-day recomputation", () => {
  const records = buildFrozenPredictionRecords([
    day("2026-05-24", [row({ predicted_verdict: "INLINE", confidence_pct: 52 })]),
    day("2026-05-25", [row({ predicted_verdict: "BEAT", confidence_pct: 54 })]),
    day("2026-05-26", [row({ predicted_verdict: "MISS", confidence_pct: 55 })]),
  ]);
  const rec = records.get("MARKSANS|2026-05-26");
  assert.equal(rec.archive_today_iso, "2026-05-25");
  assert.equal(rec.prediction.verdict, "BEAT");
  assert.equal(rec.prediction.confidence_pct, 54);
});

it("falls back to same-day archive when no pre-event row exists", () => {
  const records = buildFrozenPredictionRecords([
    day("2026-05-26", [row({ predicted_verdict: "INLINE", confidence_pct: 55 })]),
  ]);
  const rec = records.get("MARKSANS|2026-05-26");
  assert.equal(rec.archive_today_iso, "2026-05-26");
  assert.equal(rec.prediction.verdict, "INLINE");
});

console.log("[2] event overlay");
it("freezes only due events, leaving future rows untouched", () => {
  const records = buildFrozenPredictionRecords([
    day("2026-05-25", [row({ predicted_verdict: "BEAT", confidence_pct: 54 })]),
  ]);
  const out = applyPredictionFreezes([
    {
      symbol: "MARKSANS",
      event_iso_date: "2026-05-26",
      prediction: { verdict: "INLINE", confidence_pct: 55, score_100: 47.3 },
    },
    {
      symbol: "FUTURE",
      event_iso_date: "2026-05-27",
      prediction: { verdict: "MISS", confidence_pct: 60 },
    },
  ], { todayIso: "2026-05-26", records });

  assert.equal(out[0].prediction.verdict, "BEAT");
  assert.equal(out[0].prediction.confidence_pct, 54);
  assert.equal(out[0].prediction.freeze.source, "legacy_archive");
  assert.equal(out[1].prediction.verdict, "MISS");
});

it("can restore archived display snapshot fields after derived rebuilds", () => {
  const records = buildFrozenPredictionRecords([
    day("2026-05-25", [
      row({
        display_snapshot: {
          prediction: { verdict: "BEAT", confidence_pct: 54, score_100: 59.5 },
          price_band: { basis: "archived" },
          rationale: { headline: "Archived headline" },
          playbook: { mode: "preview", headline: "Archived playbook" },
          signals: { data_quality: "HIGH", sector: "Pharma" },
        },
      }),
    ]),
  ]);
  const out = applyPredictionFreezes([
    {
      symbol: "MARKSANS",
      event_iso_date: "2026-05-26",
      signals: { data_quality: "MEDIUM" },
      prediction: { verdict: "INLINE", confidence_pct: 55 },
      price_band: { basis: "rebuilt" },
      rationale: { headline: "Rebuilt" },
      playbook: { mode: "preview", headline: "Rebuilt" },
    },
  ], { todayIso: "2026-05-26", records, includeDisplay: true });

  assert.equal(out[0].prediction.verdict, "BEAT");
  assert.equal(out[0].price_band.basis, "archived");
  assert.equal(out[0].rationale.headline, "Archived headline");
  assert.equal(out[0].playbook.headline, "Archived playbook");
  assert.equal(out[0].signals.sector, "Pharma");
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
