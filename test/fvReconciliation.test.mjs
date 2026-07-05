// Unit tests for the display-side upside haircut helper.
//
// The haircut factor is decided at scoring time (services/swsScoringV4.js, where
// the analyst range + count are in hand) and re-applied at every display/recompute
// site via applyUpsideHaircut, because the serve path only sees a slim FV map and
// cannot re-derive suspicion. These tests pin the helper's contract: positive
// upside de-rates, negative upside is never touched (that would read less bearish),
// and out-of-range factors are no-ops.

import assert from "node:assert";
import { applyUpsideHaircut, reconcileFairValue } from "../services/fvReconciliation.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log("\napplyUpsideHaircut\n");

check("positive upside is de-rated by the factor (40 × 0.75 = 30)", () => {
  assert.equal(applyUpsideHaircut(40, 0.75), 30);
});
check("de-rate rounds to one decimal (33.3 × 0.75 = 25.0)", () => {
  assert.equal(applyUpsideHaircut(33.3, 0.75), 25.0);
});
check("negative (overvalued) upside is NEVER de-rated — would read less bearish", () => {
  assert.equal(applyUpsideHaircut(-20, 0.75), -20);
});
check("zero upside untouched", () => {
  assert.equal(applyUpsideHaircut(0, 0.75), 0);
});
check("factor 1 is a no-op", () => {
  assert.equal(applyUpsideHaircut(40, 1), 40);
});
check("missing / out-of-range factor is a no-op (defaults to 1)", () => {
  assert.equal(applyUpsideHaircut(40, undefined), 40);
  assert.equal(applyUpsideHaircut(40, null), 40);
  assert.equal(applyUpsideHaircut(40, 0), 40);
  assert.equal(applyUpsideHaircut(40, 1.5), 40);
  assert.equal(applyUpsideHaircut(40, -0.5), 40);
});
check("null / non-finite upside passes through unchanged", () => {
  assert.equal(applyUpsideHaircut(null, 0.75), null);
  assert.equal(applyUpsideHaircut(undefined, 0.75), undefined);
  assert.ok(Number.isNaN(applyUpsideHaircut(NaN, 0.75)));
});

console.log("\nreconcileFairValue stays pure (haircut is applied downstream, not here)\n");

check("reconcileFairValue computes the RAW upside — no haircut baked in", () => {
  // fv 155 vs price 100 → +55% raw. The helper does not know about analyst range,
  // so it must NOT haircut; the factor is applied by pickCardFields / enrichPickRow.
  const r = reconcileFairValue({ fair_value_inr: 155, current_price_inr: 100 });
  assert.equal(r.upside_pct, 55);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
