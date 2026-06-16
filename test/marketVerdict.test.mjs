import assert from "node:assert/strict";
import { buildMarketVerdict } from "../services/marketVerdict.js";

const NOW = "2026-06-17T04:00:00.000Z";
const FRESH = "2026-06-17T03:55:00.000Z";
const STALE = "2026-06-15T00:00:00.000Z";

function macro(overrides = {}) {
  return {
    regime: "CALM",
    severity: 1,
    confidence: 0.7,
    generatedAt: FRESH,
    classifierProvider: "test",
    ...overrides,
  };
}

function breadth({ advancing = 60, declining = 40, lastUpdated = FRESH } = {}) {
  return {
    advancing,
    declining,
    unchanged: 0,
    totalStocks: advancing + declining,
    lastUpdated,
    source: "test-heatmap",
  };
}

function fiiDii({ fii = 0, dii = 0, lastUpdated = FRESH, date = "2026-06-16", history = null } = {}) {
  return {
    available: true,
    date,
    fii: { netValue: fii, date },
    dii: { netValue: dii, date },
    history: history || [
      { date, fii, dii },
    ],
    lastUpdated,
  };
}

function verdict(inputs, opts = {}) {
  return buildMarketVerdict(inputs, { now: NOW, ...opts });
}

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok ${name}`);
  } catch (err) {
    fail += 1;
    console.error(`  not ok ${name}`);
    console.error(err.stack || err.message);
  }
}

console.log("marketVerdict");

check("CALM plus no corroboration is not BUY DAY", () => {
  const out = verdict({
    regime: macro({ regime: "CALM" }),
    marketBreadth: breadth({ advancing: 50, declining: 50 }),
    fiiDii: fiiDii({ fii: 0 }),
  });
  assert.equal(out.marketState, "MIXED");
  assert.notEqual(out.verdict, "BUY DAY");
  assert.notEqual(out.verdict, "STRONG BUY DAY");
  assert.equal(out.components.macro, 0);
});

check("favorable macro alone cannot bypass missing breadth or flow", () => {
  const out = verdict({
    regime: macro({ regime: "RATE_CUT" }),
  });
  assert.equal(out.marketState, "MIXED");
  assert.notEqual(out.verdict, "BUY DAY");
  assert.equal(out.sourceQuality.breadth.usable, false);
  assert.equal(out.sourceQuality.flow.usable, false);
  assert.ok(out.decisionBasis.missing.includes("Market breadth"));
});

check("stale macro produces INSUFFICIENT_EVIDENCE", () => {
  const out = verdict({
    regime: macro({ regime: "CALM", generatedAt: STALE }),
    marketBreadth: breadth({ advancing: 75, declining: 25 }),
    fiiDii: fiiDii({ fii: 1200 }),
  });
  assert.equal(out.marketState, "INSUFFICIENT_EVIDENCE");
  assert.equal(out.sourceQuality.macro.stale, true);
  assert.notEqual(out.verdict, "BUY DAY");
});

check("missing breadth caps otherwise supportive inputs at MIXED", () => {
  const out = verdict({
    regime: macro({ regime: "RATE_CUT" }),
    fiiDii: fiiDii({ fii: 1600 }),
  });
  assert.equal(out.marketState, "MIXED");
  assert.equal(out.components.hardGates.breadthMissing, true);
  assert.notEqual(out.verdict, "BUY DAY");
});

check("positive breadth plus non-red fresh inputs can become BUY DAY", () => {
  const out = verdict({
    regime: macro({ regime: "RATE_CUT" }),
    marketBreadth: breadth({ advancing: 60, declining: 40 }),
    fiiDii: fiiDii({ fii: 0 }),
  });
  assert.equal(out.marketState, "CONSTRUCTIVE");
  assert.equal(out.verdict, "BUY DAY");
  assert.equal(out.verdictColor, "green");
});

check("severe macro shock caps at RISK_OFF", () => {
  const out = verdict({
    regime: macro({ regime: "OIL_SHOCK", severity: 4 }),
    marketBreadth: breadth({ advancing: 75, declining: 25 }),
    fiiDii: fiiDii({ fii: 1200 }),
  });
  assert.equal(out.marketState, "RISK_OFF");
  assert.equal(out.components.hardGates.severeMacroShock, true);
  assert.equal(out.verdict, "STAY OUT");
});

check("unavailable FII/DII is degraded but not bullish", () => {
  const out = verdict({
    regime: macro({ regime: "RATE_CUT" }),
    marketBreadth: breadth({ advancing: 75, declining: 25 }),
    fiiDii: { available: false, lastUpdated: FRESH },
  });
  assert.equal(out.sourceQuality.flow.usable, false);
  assert.equal(out.components.flow, 0);
  assert.equal(out.marketState, "CONSTRUCTIVE");
  assert.ok(out.decisionBasis.missing.includes("FII/DII flow"));
});

check("material FII selling blocks constructive state", () => {
  const out = verdict({
    regime: macro({ regime: "RATE_CUT" }),
    marketBreadth: breadth({ advancing: 80, declining: 20 }),
    fiiDii: fiiDii({ fii: -900, dii: 1500 }),
  });
  assert.equal(out.marketState, "MIXED");
  assert.equal(out.components.hardGates.materialFiiSelling, true);
  assert.notEqual(out.verdict, "BUY DAY");
  assert.ok(out.decisionBasis.blockers.includes("FII selling pressure"));
});

check("severe sustained FII pressure caps at RISK_OFF", () => {
  const out = verdict({
    regime: macro({ regime: "CALM" }),
    marketBreadth: breadth({ advancing: 70, declining: 30 }),
    fiiDii: fiiDii({
      fii: -1600,
      history: [
        { date: "2026-06-16", fii: -1600 },
        { date: "2026-06-15", fii: -1800 },
        { date: "2026-06-14", fii: -1900 },
      ],
    }),
  });
  assert.equal(out.marketState, "RISK_OFF");
  assert.equal(out.components.hardGates.severeFiiPressure, true);
});

check("catalyst-only context cannot override macro or breadth gates", () => {
  const out = verdict({
    regime: macro({ regime: "OIL_SHOCK", severity: 4 }),
    marketBreadth: breadth({ advancing: 35, declining: 65 }),
    fiiDii: fiiDii({ fii: 2000 }),
    catalysts: { sections: { macro: [{ title: "RBI policy", tier: "A" }] } },
  });
  assert.equal(out.marketState, "RISK_OFF");
  assert.notEqual(out.verdict, "BUY DAY");
});

console.log(`\nmarketVerdict result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
