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
test("buildLabViewForEvent: disagrees when BEAT + quality flags present", () => {
  const m = makeMap([
    {
      ticker: "KEC",
      quality_flags: [{ category: "consecutive_miss", severity: -3, summary: "test" }],
      quality_adjusted_confidence: 48,
    },
  ]);
  const r = buildLabViewForEvent(
    { symbol: "KEC", prediction: { verdict: "BEAT", confidence_pct: 65 } },
    m,
  );
  assert.equal(r.disagrees_with_prediction, true);
  assert.equal(r.has_quality_overlay, true);
  assert.equal(r.confidence_delta_pct, -17);
  assert.equal(r.top_reasons.length, 1);
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
