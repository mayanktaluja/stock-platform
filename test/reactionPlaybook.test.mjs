/**
 * Tests for services/earnings/reactionPlaybook.js
 *
 * The 9-cell matrix is the highest-stakes module — a bug here = wrong
 * intraday call. Every cell must be reachable, every cell must have a
 * full plan, and the preview-mode branch highlighting must align with
 * the runup → guidance lean we documented in the matrix.
 *
 * Run with: node test/reactionPlaybook.test.mjs
 */

import {
  resolveCellKey,
  getCell,
  buildPreviewPlaybook,
  buildT1Playbook,
  attachPlaybooksToCalendar,
} from "../services/earnings/reactionPlaybook.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}

// ──── 9-cell matrix coverage ────
const VERDICTS = ["BEAT", "INLINE", "MISS"];
const GUIDANCE = ["RAISE", "MAINTAIN", "CUT"];
const REQUIRED_FIELDS = ["label", "stance", "time_horizon", "entry", "stoploss", "target", "rationale", "confidence", "falsification", "leans"];

for (const v of VERDICTS) {
  for (const g of GUIDANCE) {
    const key = resolveCellKey(v, g);
    assert(`resolveCellKey ${v}+${g}`, key === `${v}_${g}`, key);
    const cell = getCell(key);
    assert(`getCell ${key} exists`, cell !== null, cell);
    for (const f of REQUIRED_FIELDS) {
      assert(`${key}.${f} is populated`, cell[f] != null && (Array.isArray(cell[f]) ? cell[f].length > 0 : String(cell[f]).length > 0), cell[f]);
    }
    assert(`${key}.confidence is HIGH/MEDIUM/LOW`, ["HIGH", "MEDIUM", "LOW"].includes(cell.confidence), cell.confidence);
    assert(`${key}.falsification is array length ≥ 2`, Array.isArray(cell.falsification) && cell.falsification.length >= 2, cell.falsification);
  }
}

// ──── resolveCellKey rejects malformed input ────
assert("resolveCellKey null verdict", resolveCellKey(null, "RAISE") === null);
assert("resolveCellKey unknown verdict", resolveCellKey("FOO", "RAISE") === null);
assert("resolveCellKey unknown guidance", resolveCellKey("BEAT", "FOO") === null);
assert("resolveCellKey lowercase normalises", resolveCellKey("beat", "raise") === "BEAT_RAISE");

// ──── getCell returns deep copies (mutation safety) ────
{
  const a = getCell("BEAT_RAISE");
  a.stance = "MUTATED";
  const b = getCell("BEAT_RAISE");
  assert("getCell returns fresh deep copy", b.stance !== "MUTATED", b.stance);
}

// ──── Preview playbook: predicted-verdict + runup → highlighted branch ────
{
  // BEAT + spike → CUT highlight (chase risk if guidance disappoints)
  const beatSpike = buildPreviewPlaybook({
    prediction: { verdict: "BEAT", confidence_pct: 60 },
    signals: { momentum: { pre_runup_signal: "spike" } },
  });
  assert("BEAT+spike → highlight CUT", beatSpike.highlight_branch === "CUT", beatSpike.highlight_branch);
  assert("BEAT+spike has 3 branches", beatSpike.branches.length === 3, beatSpike.branches.length);
  const beatCutBranch = beatSpike.branches.find((b) => b.guidance === "CUT");
  assert("BEAT+spike CUT branch is is_highlighted=true", beatCutBranch?.is_highlighted === true, beatCutBranch);

  // BEAT + lagging → RAISE highlight (room to surprise)
  const beatLag = buildPreviewPlaybook({
    prediction: { verdict: "BEAT", confidence_pct: 60 },
    signals: { momentum: { pre_runup_signal: "lagging" } },
  });
  assert("BEAT+lagging → highlight RAISE", beatLag.highlight_branch === "RAISE", beatLag.highlight_branch);

  // INLINE + smooth → RAISE highlight (informed flow → bump probable)
  const inlineSmooth = buildPreviewPlaybook({
    prediction: { verdict: "INLINE", confidence_pct: 55 },
    signals: { momentum: { pre_runup_signal: "smooth" } },
  });
  assert("INLINE+smooth → highlight RAISE", inlineSmooth.highlight_branch === "RAISE", inlineSmooth.highlight_branch);

  // INLINE + neutral → MAINTAIN highlight (default base case)
  const inlineNeutral = buildPreviewPlaybook({
    prediction: { verdict: "INLINE", confidence_pct: 55 },
    signals: { momentum: { pre_runup_signal: "neutral" } },
  });
  assert("INLINE+neutral → highlight MAINTAIN", inlineNeutral.highlight_branch === "MAINTAIN", inlineNeutral.highlight_branch);
}

// ──── Preview playbook: INSUFFICIENT_DATA → not tradable ────
{
  const insuf = buildPreviewPlaybook({
    prediction: { verdict: "INSUFFICIENT_DATA" },
    signals: { momentum: { pre_runup_signal: "neutral" } },
  });
  assert("INSUFFICIENT_DATA preview is not tradable", insuf.tradable === false, insuf.tradable);
  assert("INSUFFICIENT_DATA primary is null", insuf.primary === null, insuf.primary);
}

// ──── T+1 playbook: gap-aware tactical notes ────
{
  // BEAT_RAISE long lean + 6% gap-up → wait-for-30min advice
  const t1Long = buildT1Playbook({}, "BEAT", "RAISE", 6.2);
  assert("T+1 BEAT_RAISE cell key", t1Long.cell_key === "BEAT_RAISE", t1Long.cell_key);
  assert("T+1 long lean + big gap → 'do not chase'", /do not chase/i.test(t1Long.tactical_note), t1Long.tactical_note);

  // BEAT_RAISE long lean + gap-down → flagged as overhang
  const t1LongDown = buildT1Playbook({}, "BEAT", "RAISE", -3);
  assert("T+1 long lean + gap-down → downgrade size", /downgrade/i.test(t1LongDown.tactical_note) || /half/i.test(t1LongDown.tactical_note), t1LongDown.tactical_note);

  // MISS_CUT short lean + gap-down → wait-for-VWAP-bounce advice
  const t1Short = buildT1Playbook({}, "MISS", "CUT", -7);
  assert("T+1 MISS_CUT cell key", t1Short.cell_key === "MISS_CUT", t1Short.cell_key);
  assert("T+1 short lean + big gap-down → 'wait for VWAP bounce'", /vwap/i.test(t1Short.tactical_note), t1Short.tactical_note);

  // BEAT_CUT trap + gap-up → fade signal
  const t1Trap = buildT1Playbook({}, "BEAT", "CUT", 4);
  assert("T+1 BEAT_CUT trap cell", t1Trap.cell_key === "BEAT_CUT", t1Trap.cell_key);
}

// ──── T+1 playbook: invalid inputs return non-tradable ────
{
  const bad = buildT1Playbook({}, "FOO", "BAR");
  assert("T+1 invalid input is not tradable", bad.tradable === false, bad.tradable);
  assert("T+1 invalid input has cell_key=null", bad.cell_key === null, bad.cell_key);
}

// ──── attachPlaybooksToCalendar: idempotent on T+1 ────
{
  const calendar = [
    {
      symbol: "TEST1",
      prediction: { verdict: "BEAT" },
      signals: { momentum: { pre_runup_signal: "neutral" } },
      playbook: { mode: "t1", cell_key: "BEAT_RAISE", tradable: true }, // pretend already resolved
    },
    {
      symbol: "TEST2",
      prediction: { verdict: "INLINE" },
      signals: { momentum: { pre_runup_signal: "neutral" } },
    },
  ];
  const out = attachPlaybooksToCalendar(calendar);
  assert("attach preserves existing T+1 playbook", out[0].playbook.mode === "t1", out[0].playbook?.mode);
  assert("attach adds preview to events without playbook", out[1].playbook?.mode === "preview", out[1].playbook?.mode);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
