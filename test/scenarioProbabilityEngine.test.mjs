import { strict as assert } from "node:assert";
import { enumerateScenarios, SCENARIO_KEYS } from "../services/macroThesis/scenarioProbabilityEngine.js";

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

function _sumProbs(r) {
  return r.branches.reduce((a, b) => a + b.probability, 0);
}

test("enumerateScenarios returns 4 branches", () => {
  const r = enumerateScenarios({ regime: "WAR_ESCALATION", severity: 3 });
  assert.equal(r.branches.length, 4);
  assert.deepEqual(
    r.branches.map((b) => b.key).sort(),
    SCENARIO_KEYS.slice().sort(),
  );
});

test("probabilities sum to ~1.0 across all reasonable inputs", () => {
  for (const sev of [1, 2, 3, 4, 5]) {
    for (const days of [0, 7, 14, 30, 60]) {
      for (const cat of [null, 0, 5, 14, 30]) {
        const r = enumerateScenarios({ regime: "WAR_ESCALATION", severity: sev, daysInState: days, catalystProximityDays: cat });
        const s = _sumProbs(r);
        // Allow tiny rounding tolerance (each branch rounded to 2dp).
        assert.ok(Math.abs(s - 1) < 0.05, `sev=${sev} days=${days} cat=${cat} → sum=${s}`);
      }
    }
  }
});

test("continue is the modal branch in early days", () => {
  const r = enumerateScenarios({ regime: "WAR_ESCALATION", severity: 3, daysInState: 0 });
  const cont = r.branches.find((b) => b.key === "continue");
  for (const b of r.branches) {
    if (b.key !== "continue") assert.ok(cont.probability >= b.probability);
  }
});

test("de_escalate rises with daysInState", () => {
  const early = enumerateScenarios({ regime: "WAR_ESCALATION", severity: 3, daysInState: 0 });
  const late = enumerateScenarios({ regime: "WAR_ESCALATION", severity: 3, daysInState: 45 });
  const e = early.branches.find((b) => b.key === "de_escalate").probability;
  const l = late.branches.find((b) => b.key === "de_escalate").probability;
  assert.ok(l > e, `de_escalate should rise with age (early=${e}, late=${l})`);
});

test("escalate rises with severity (in early days)", () => {
  const low = enumerateScenarios({ regime: "WAR_ESCALATION", severity: 2, daysInState: 5 });
  const high = enumerateScenarios({ regime: "WAR_ESCALATION", severity: 5, daysInState: 5 });
  const lp = low.branches.find((b) => b.key === "escalate").probability;
  const hp = high.branches.find((b) => b.key === "escalate").probability;
  assert.ok(hp > lp, `escalate should rise with severity (sev2=${lp}, sev5=${hp})`);
});

test("new_shock rises with catalyst proximity", () => {
  const far = enumerateScenarios({ regime: "CALM", severity: 1, catalystProximityDays: null });
  const near = enumerateScenarios({ regime: "CALM", severity: 1, catalystProximityDays: 3 });
  const fp = far.branches.find((b) => b.key === "new_shock").probability;
  const np = near.branches.find((b) => b.key === "new_shock").probability;
  assert.ok(np > fp, `new_shock should rise on imminent catalyst (far=${fp}, near=${np})`);
});

test("indeterminate when required inputs missing", () => {
  const r = enumerateScenarios({ severity: 3 });
  assert.equal(r.indeterminate, true);
});

test("durations are sensible (continue ~14d, escalate ~7d, etc.)", () => {
  const r = enumerateScenarios({ regime: "WAR_ESCALATION", severity: 3 });
  const cont = r.branches.find((b) => b.key === "continue");
  const esc = r.branches.find((b) => b.key === "escalate");
  assert.equal(cont.duration_days, 14);
  assert.equal(esc.duration_days, 7);
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
