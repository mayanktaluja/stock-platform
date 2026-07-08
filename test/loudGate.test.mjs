import { strict as assert } from "node:assert";
import {
  severityOf, scoreIntrinsicImpact, shouldGoLoud, makeLoudGate, MACRO_SEVERITY,
} from "../services/alerts/loudGate.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); pass++; }
  catch (err) { console.log(`  not ok - ${name}\n      ${err.message}`); fail++; }
}

test("severityOf takes the HIGHEST tier among matched keywords", () => {
  assert.equal(severityOf(["trump", "missile"]), "HIGH");
  assert.equal(severityOf(["trump", "tariff"]), "MED");
  assert.equal(severityOf(["trump", "nifty"]), "LOW");
  assert.equal(severityOf([]), null);
  assert.equal(severityOf(null), null);
});

test("unlisted matched keyword defaults to LOW (conservative — stays quiet)", () => {
  assert.equal(severityOf(["some_unmapped_term"]), "LOW");
});

test("the noisy terms really are LOW and the scary ones really are HIGH", () => {
  for (const k of ["trump", "nifty", "sensex", "white house", "oil price"]) {
    assert.equal(MACRO_SEVERITY[k], "LOW", `${k} must be LOW`);
  }
  for (const k of ["war", "missile", "nuclear", "market crash", "circuit breaker", "rate cut", "fomc"]) {
    assert.equal(MACRO_SEVERITY[k], "HIGH", `${k} must be HIGH`);
  }
});

test("scoreIntrinsicImpact does NOT get the +2 breaking bonus (would defeat the gate)", () => {
  const { impact } = scoreIntrinsicImpact({ text: "Trump comments on tariffs" });
  // 1.5 base + ~0.9 per sentiment word; a lone 'tariffs' must land well under the MED floor.
  assert.ok(impact < 5, `expected intrinsic impact < 5, got ${impact}`);
});

test("shouldGoLoud: watchlist ticker always wins", () => {
  assert.equal(shouldGoLoud({ tier: null, watchlistHit: true, impact: 0 }), true);
  assert.equal(shouldGoLoud({ tier: "LOW", watchlistHit: true, impact: 0 }), true);
});

test("shouldGoLoud: HIGH severity always loud regardless of prose", () => {
  assert.equal(shouldGoLoud({ tier: "HIGH", watchlistHit: false, impact: 0 }), true);
});

test("shouldGoLoud: MED needs >=5, LOW needs >=7, none never", () => {
  assert.equal(shouldGoLoud({ tier: "MED", watchlistHit: false, impact: 4.9 }), false);
  assert.equal(shouldGoLoud({ tier: "MED", watchlistHit: false, impact: 5 }), true);
  assert.equal(shouldGoLoud({ tier: "LOW", watchlistHit: false, impact: 6.9 }), false);
  assert.equal(shouldGoLoud({ tier: "LOW", watchlistHit: false, impact: 7 }), true);
  assert.equal(shouldGoLoud({ tier: null, watchlistHit: false, impact: 10 }), false);
});

test("[regression] a missile strike is LOUD even though it has almost no sentiment words", () => {
  const gate = makeLoudGate();
  const d = gate.decide({
    text: "Missile strike on oil facility, crude surges",
    macroHits: ["missile", "crude oil"],
    macroHit: true,
  });
  assert.equal(d.tier, "HIGH");
  assert.equal(d.loud, true, "a flat impact>=6 gate would have silenced this");
});

test("[the fatigue bug] a bare Trump remark is NOT loud", () => {
  const gate = makeLoudGate();
  const d = gate.decide({ text: "Trump speaks at the White House later today", macroHits: ["trump", "white house"], macroHit: true });
  assert.equal(d.tier, "LOW");
  assert.equal(d.loud, false);
});

test("a Fed rate decision is loud", () => {
  const gate = makeLoudGate();
  const d = gate.decide({ text: "Fed cuts rates by 25bps", macroHits: ["fed", "rate cut", "bps"], macroHit: true });
  assert.equal(d.tier, "HIGH");
  assert.equal(d.loud, true);
});

test("a watchlist mention is loud even with a quiet headline", () => {
  const gate = makeLoudGate();
  const d = gate.decide({ text: "Reliance to hold board meeting", macroHits: [], macroHit: false, watchlistHit: true, symbols: ["RELIANCE"] });
  assert.equal(d.loud, true);
});

test("decide never throws — falls back to legacy loudness", () => {
  const gate = makeLoudGate();
  const d = gate.decide({ text: null, macroHits: null, macroHit: true, watchlistHit: false });
  assert.equal(typeof d.loud, "boolean");
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
