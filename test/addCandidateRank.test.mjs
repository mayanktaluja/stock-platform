import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateBaseRank,
  holdingRankInputs,
  RANK_MAX_POSITION_WEIGHT_PCT,
} from "../services/portfolio/addCandidateRank.js";

test("formula parity: hand-computed rank for a typical holding candidate", () => {
  // v4 62 + upside 18×0.35 + fit 0 + (8−3)×1.2 + holding bonus 2 = 76.30
  const rank = candidateBaseRank({
    v4_score: 62, upside_pct: 18, sectorFitScore: 0, positionWeight: 3, source: "holding",
  });
  assert.equal(rank, 76.3);
});

test("upside clamps to [0, 40]", () => {
  const at40 = candidateBaseRank({ v4_score: 50, upside_pct: 40, positionWeight: 8, source: "fresh" });
  const above = candidateBaseRank({ v4_score: 50, upside_pct: 95, positionWeight: 8, source: "fresh" });
  assert.equal(at40, above);
  const negative = candidateBaseRank({ v4_score: 50, upside_pct: -30, positionWeight: 8, source: "fresh" });
  const zero = candidateBaseRank({ v4_score: 50, upside_pct: 0, positionWeight: 8, source: "fresh" });
  assert.equal(negative, zero);
});

test("position-room bonus: only below the 8% ceiling, 1.2/pt", () => {
  const small = candidateBaseRank({ v4_score: 50, upside_pct: 0, positionWeight: 2, source: "fresh" });
  const capped = candidateBaseRank({ v4_score: 50, upside_pct: 0, positionWeight: RANK_MAX_POSITION_WEIGHT_PCT, source: "fresh" });
  const over = candidateBaseRank({ v4_score: 50, upside_pct: 0, positionWeight: 15, source: "fresh" });
  assert.equal(+(small - capped).toFixed(2), +(6 * 1.2).toFixed(2));
  assert.equal(capped, over);
});

test("holding source bonus is +2 over fresh", () => {
  const base = { v4_score: 55, upside_pct: 10, sectorFitScore: 0, positionWeight: 4 };
  assert.equal(
    candidateBaseRank({ ...base, source: "holding" }) - candidateBaseRank({ ...base, source: "fresh" }),
    2,
  );
});

test("sectorFit weighs 0.5/pt (fresh-pick path)", () => {
  const base = { v4_score: 55, upside_pct: 10, positionWeight: 0, source: "fresh" };
  const withFit = candidateBaseRank({ ...base, sectorFitScore: 4 });
  const noFit = candidateBaseRank({ ...base, sectorFitScore: 0 });
  assert.equal(+(withFit - noFit).toFixed(2), 2);
});

test("holdingRankInputs mirrors makeHoldingCandidate: sws fields, fit 0, source holding", () => {
  const h = {
    positionWeight: 3.2,
    sws: { v4_score: 61, upside_pct: 14.5 },
  };
  const inputs = holdingRankInputs(h);
  assert.equal(inputs.v4_score, 61);
  assert.equal(inputs.upside_pct, 14.5);
  assert.equal(inputs.sectorFitScore, 0);
  assert.equal(inputs.positionWeight, 3.2);
  assert.equal(inputs.source, "holding");
});

test("holdingRankInputs tolerates missing sws payload (uncovered rows)", () => {
  const inputs = holdingRankInputs({ positionWeight: 1 });
  assert.equal(candidateBaseRank(inputs), +(0 + 0 + (8 - 1) * 1.2 + 2).toFixed(2));
});
