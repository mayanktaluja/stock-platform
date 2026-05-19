import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isLabEnabled,
  loadRiskLabViewMap,
  buildLabViewForEvent,
} from "../services/riskLab/earningsLabView.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    pass++;
  } catch (err) {
    console.log(`  not ok - ${name}\n      ${err.message}`);
    fail++;
  }
}

// ───────── isLabEnabled ─────────
test("isLabEnabled defaults true when env empty", () => {
  assert.equal(isLabEnabled({}), true);
  assert.equal(isLabEnabled({ RISK_LAB_ENABLED: "" }), true);
});
test("isLabEnabled false when RISK_LAB_ENABLED=false/0/off/no", () => {
  for (const v of ["false", "0", "off", "no", "FALSE", "  False  "]) {
    assert.equal(isLabEnabled({ RISK_LAB_ENABLED: v }), false, `expected false for "${v}"`);
  }
});
test("isLabEnabled true when RISK_LAB_ENABLED=true/anything else", () => {
  assert.equal(isLabEnabled({ RISK_LAB_ENABLED: "true" }), true);
  assert.equal(isLabEnabled({ RISK_LAB_ENABLED: "1" }), true);
  assert.equal(isLabEnabled({ RISK_LAB_ENABLED: "yes" }), true);
});

// ───────── loadRiskLabViewMap ─────────
function withTmpFiles(picks, quality, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earningsLabView-"));
  const picksPath = path.join(dir, "picks-adjusted-latest.json");
  const qualityPath = path.join(dir, "quality-flags-latest.json");
  if (picks !== null) fs.writeFileSync(picksPath, JSON.stringify(picks));
  if (quality !== null) fs.writeFileSync(qualityPath, JSON.stringify(quality));
  try {
    fn({ picksPath, qualityPath });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("loadRiskLabViewMap returns null when kill-switch on", () => {
  withTmpFiles({ stocks: [] }, { stocks: [] }, ({ picksPath, qualityPath }) => {
    const m = loadRiskLabViewMap({ picksPath, qualityPath, env: { RISK_LAB_ENABLED: "false" } });
    assert.equal(m, null);
  });
});
test("loadRiskLabViewMap returns null when both files missing", () => {
  const m = loadRiskLabViewMap({
    picksPath: "/nonexistent/picks.json",
    qualityPath: "/nonexistent/quality.json",
    env: {},
  });
  assert.equal(m, null);
});
test("loadRiskLabViewMap merges picks + quality into per-ticker view", () => {
  const picks = {
    regime: { regime: "OIL_SHOCK", severity: 3 },
    generated_at: "2026-05-18T00:00:00Z",
    stocks: [
      {
        ticker: "KEC",
        original_verdict: "TOP_PICK",
        macro_score_delta: -2,
        macro_adjusted_verdict: "STRONG",
        macro_veto: { vetoed: false },
        regime: "OIL_SHOCK",
        regime_severity: 3,
        regime_stale: false,
      },
    ],
  };
  const quality = {
    stocks: [
      {
        ticker: "KEC",
        quality_verdict: "LOW",
        quality_score_delta: -5,
        quality_adjusted_confidence: 48,
        combined_verdict: "LOW_QUALITY_BEAT",
        quality_veto: { vetoed: false },
        flags: [
          { category: "consecutive_miss", severity: -3, summary: "Q3 missed by 41%", source: "news" },
          { category: "interest_coverage", severity: -1, summary: "Interest not well covered", source: "risks" },
        ],
      },
    ],
  };
  withTmpFiles(picks, quality, ({ picksPath, qualityPath }) => {
    const m = loadRiskLabViewMap({ picksPath, qualityPath, env: {} });
    assert.ok(m instanceof Map);
    const v = m.get("KEC");
    assert.ok(v, "KEC entry exists");
    assert.equal(v.macro_score_delta, -2);
    assert.equal(v.macro_adjusted_verdict, "STRONG");
    assert.equal(v.regime, "OIL_SHOCK");
    assert.equal(v.quality_verdict, "LOW");
    assert.equal(v.quality_score_delta, -5);
    assert.equal(v.quality_adjusted_confidence, 48);
    assert.equal(v.combined_verdict, "LOW_QUALITY_BEAT");
    assert.equal(v.quality_flags.length, 2);
    assert.equal(m._regime?.regime, "OIL_SHOCK");
  });
});
test("loadRiskLabViewMap handles quality-only ticker (not in picks)", () => {
  const picks = { stocks: [] };
  const quality = {
    stocks: [
      {
        ticker: "ABCD",
        quality_verdict: "MEDIUM",
        quality_score_delta: -2,
        flags: [{ category: "risk_text", severity: -2, summary: "test" }],
      },
    ],
  };
  withTmpFiles(picks, quality, ({ picksPath, qualityPath }) => {
    const m = loadRiskLabViewMap({ picksPath, qualityPath, env: {} });
    const v = m.get("ABCD");
    assert.ok(v);
    assert.equal(v.quality_verdict, "MEDIUM");
    assert.equal(v.quality_flags.length, 1);
  });
});

// ───────── buildLabViewForEvent ─────────
function makeMap(stocks) {
  const m = new Map();
  for (const s of stocks) m.set(s.ticker.toUpperCase(), { ...s, quality_flags: s.quality_flags || [] });
  return m;
}

test("buildLabViewForEvent returns null for unknown ticker", () => {
  const m = makeMap([{ ticker: "KEC" }]);
  const r = buildLabViewForEvent({ symbol: "UNKNOWN", prediction: {} }, m);
  assert.equal(r, null);
});
test("buildLabViewForEvent: disagrees when BEAT + hard-evidence quality flag (KEC)", () => {
  const m = makeMap([
    {
      ticker: "KEC",
      quality_flags: [{ category: "consecutive_miss", severity: -3, summary: "Q3 missed by 41%", source: "sws_news" }],
      quality_adjusted_confidence: 48,
    },
  ]);
  const r = buildLabViewForEvent(
    { symbol: "KEC", prediction: { verdict: "BEAT", confidence_pct: 65 } },
    m,
  );
  assert.equal(r.disagrees_with_prediction, true);
  assert.equal(r.has_quality_overlay, true);
  assert.equal(r.has_hard_evidence, true);
  assert.equal(r.hard_evidence_count, 1);
  assert.equal(r.confidence_delta_pct, -17);
  assert.equal(r.top_reasons.length, 1);
  assert.equal(r.top_reasons[0].is_boilerplate, false);
});

test("PR1 DISCRIMINATION: counter_thesis boilerplate ALONE no longer disagrees", () => {
  // This is the scenario from the audit: a BEAT stock with only SWS
  // counter_thesis falsification triggers (the boilerplate that fires on
  // every bullish stock). Before PR 1 this triggered "Risk Lab disagrees";
  // after PR 1 it must NOT — it stays as "Risk Lab notes" only.
  const m = makeMap([
    {
      ticker: "GENERIC",
      quality_flags: [
        { category: "earnings_miss_trigger", severity: -1, summary: "SWS flagged 'next quarter misses estimates'", source: "counter_thesis" },
        { category: "india_risk_trigger", severity: -1, summary: "SWS flagged India-specific regulatory risk", source: "counter_thesis" },
        { category: "valuation_compression", severity: -1, summary: "SWS flagged valuation compression", source: "counter_thesis" },
      ],
      quality_adjusted_confidence: null,
    },
  ]);
  const r = buildLabViewForEvent(
    { symbol: "GENERIC", prediction: { verdict: "BEAT", confidence_pct: 60 } },
    m,
  );
  assert.equal(r.disagrees_with_prediction, false, "boilerplate-only must not disagree");
  assert.equal(r.has_quality_overlay, true, "still surfaces as 'Risk Lab notes'");
  assert.equal(r.has_hard_evidence, false);
  assert.equal(r.counter_thesis_only_count, 3);
  assert.equal(r.top_reasons.length, 3);
  for (const tr of r.top_reasons) assert.equal(tr.is_boilerplate, true);
});

test("PR1 DISCRIMINATION: mixed (hard + boilerplate) → disagrees, hard reasons first", () => {
  const m = makeMap([
    {
      ticker: "MIXED",
      quality_flags: [
        { category: "earnings_miss_trigger", severity: -1, summary: "boilerplate", source: "counter_thesis" },
        { category: "interest_coverage", severity: -2, summary: "Interest not well covered", source: "sws_risks" },
        { category: "valuation_compression", severity: -1, summary: "boilerplate", source: "counter_thesis" },
      ],
    },
  ]);
  const r = buildLabViewForEvent(
    { symbol: "MIXED", prediction: { verdict: "BEAT", confidence_pct: 60 } },
    m,
  );
  assert.equal(r.disagrees_with_prediction, true);
  assert.equal(r.has_hard_evidence, true);
  assert.equal(r.hard_evidence_count, 1);
  assert.equal(r.counter_thesis_only_count, 2);
  // Hard evidence must be first in top_reasons
  assert.equal(r.top_reasons[0].category, "interest_coverage");
  assert.equal(r.top_reasons[0].is_boilerplate, false);
});

test("PR1 DISCRIMINATION: confidence-drop threshold bumped 10pp → 15pp", () => {
  // Below 15pp drop: not a material disagreement (no flags, no macro)
  const mTight = makeMap([{ ticker: "T", quality_flags: [], quality_adjusted_confidence: 52 }]);
  const rTight = buildLabViewForEvent({ symbol: "T", prediction: { verdict: "BEAT", confidence_pct: 65 } }, mTight);
  assert.equal(rTight.disagrees_with_prediction, false, "13pp drop alone should not disagree post-PR1");

  // At/above 15pp drop: material disagreement
  const mBig = makeMap([{ ticker: "B", quality_flags: [], quality_adjusted_confidence: 48 }]);
  const rBig = buildLabViewForEvent({ symbol: "B", prediction: { verdict: "BEAT", confidence_pct: 65 } }, mBig);
  assert.equal(rBig.disagrees_with_prediction, true, "17pp drop should disagree");
});

test("PR2 LLM authoritative: LLM check overrides heuristic when present", () => {
  // LLM says no — even with hard evidence, no disagreement.
  const mNo = makeMap([
    {
      ticker: "L",
      quality_flags: [{ category: "consecutive_miss", severity: -3, summary: "hard", source: "sws_news" }],
      llm_disagreement_check: { disagrees: false, confidence: 0.8, classifier_provider: "groq", top_reason: "looked specific but actually generic" },
    },
  ]);
  const rNo = buildLabViewForEvent({ symbol: "L", prediction: { verdict: "BEAT", confidence_pct: 60 } }, mNo);
  assert.equal(rNo.llm_authoritative, true);
  assert.equal(rNo.disagrees_with_prediction, false, "LLM override beats heuristic");

  // LLM says yes — disagreement even without other signals.
  const mYes = makeMap([
    {
      ticker: "Y",
      quality_flags: [],
      llm_disagreement_check: { disagrees: true, confidence: 0.9, classifier_provider: "gemini", top_reason: "real risk" },
    },
  ]);
  const rYes = buildLabViewForEvent({ symbol: "Y", prediction: { verdict: "BEAT", confidence_pct: 60 } }, mYes);
  assert.equal(rYes.disagrees_with_prediction, true);
  assert.equal(rYes.llm_authoritative, true);

  // LLM was heuristic-fallback → NOT authoritative, falls back to flag check.
  const mFallback = makeMap([
    {
      ticker: "F",
      quality_flags: [{ category: "earnings_miss_trigger", severity: -1, source: "counter_thesis", summary: "b" }],
      llm_disagreement_check: { disagrees: true, confidence: 0.5, classifier_provider: "heuristic", top_reason: "weak" },
    },
  ]);
  const rFallback = buildLabViewForEvent({ symbol: "F", prediction: { verdict: "BEAT", confidence_pct: 60 } }, mFallback);
  assert.equal(rFallback.llm_authoritative, false);
  assert.equal(rFallback.disagrees_with_prediction, false, "heuristic LLM doesn't override; boilerplate-only doesn't disagree");
});
test("buildLabViewForEvent: does NOT disagree when prediction is INLINE/MISS", () => {
  const m = makeMap([
    {
      ticker: "KEC",
      quality_flags: [{ category: "consecutive_miss", severity: -3, summary: "test" }],
      quality_adjusted_confidence: 48,
    },
  ]);
  const r = buildLabViewForEvent(
    { symbol: "KEC", prediction: { verdict: "INLINE", confidence_pct: 50 } },
    m,
  );
  assert.equal(r.disagrees_with_prediction, false, "lab does not 'disagree' with already-cautious INLINE");
});
test("buildLabViewForEvent: disagrees when BEAT + macro veto", () => {
  const m = makeMap([
    {
      ticker: "ANANTRAJ",
      quality_flags: [],
      macro_score_delta: 0,
      macro_veto: { vetoed: true, reason: "WAR_ESCALATION - Real Estate -2" },
    },
  ]);
  const r = buildLabViewForEvent(
    { symbol: "ANANTRAJ", prediction: { verdict: "BEAT", confidence_pct: 60 } },
    m,
  );
  assert.equal(r.disagrees_with_prediction, true);
  assert.equal(r.has_macro_overlay, true);
});
test("buildLabViewForEvent: top_reasons sorted by severity (most negative first)", () => {
  const m = makeMap([
    {
      ticker: "X",
      quality_flags: [
        { category: "minor", severity: -1, summary: "minor" },
        { category: "major", severity: -3, summary: "major" },
        { category: "moderate", severity: -2, summary: "moderate" },
        { category: "trivial", severity: 0, summary: "trivial" },
      ],
    },
  ]);
  const r = buildLabViewForEvent({ symbol: "X", prediction: { verdict: "BEAT" } }, m);
  assert.deepEqual(
    r.top_reasons.map((x) => x.category),
    ["major", "moderate", "minor"],
  );
});
test("buildLabViewForEvent: graceful on null prediction", () => {
  const m = makeMap([{ ticker: "X", quality_flags: [] }]);
  const r = buildLabViewForEvent({ symbol: "X", prediction: null }, m);
  assert.equal(r.disagrees_with_prediction, false);
  assert.equal(r.confidence_delta_pct, null);
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
