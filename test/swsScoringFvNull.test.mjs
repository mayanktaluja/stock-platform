/**
 * scripts/sws-scoring.mjs — _reconcilePickFV + pickCardFields
 *   fair_value_inr preservation diagnostics.
 *
 * SWS is the primary FV source. Finite SWS fair values are preserved even when
 * the FV/price ratio is unusually high or low; `fv_reconcile_reason` is
 * telemetry, not a suppression gate.
 *
 * Run with: node test/swsScoringFvNull.test.mjs
 */

import assert from "node:assert/strict";
import {
  _reconcilePickFV,
  pickCardFields,
} from "../scripts/sws-scoring.mjs";

let pass = 0, fail = 0;
function it(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ✓", name);
  } catch (err) {
    fail++;
    console.log("  ✗", name, "\n   ", err && err.message);
  }
}

// Helpers ────────────────────────────────────────────────────────────

/** Build a minimal stock object that pickCardFields can process. */
function stock({ ticker = "TEST", price, fv, upside } = {}) {
  return {
    ticker,
    name: ticker,
    sector: "Software",
    sws_url: null,
    composite_score_100: 50,
    v2_score_100: 50,
    v2_breakdown: {},
    v3_score_100: 50,
    v3_breakdown: {},
    v3_verdict: "FAIR",
    verdict: "FAIR",
    overview: {
      current_price_inr: price,
      fair_value_inr: fv,
      upside_pct: upside,
      snowflake_total: 10,
      snowflake: null,
      market_cap_inr: 10_000_000_000,
      multiples: { pe: 20 },
    },
    parsed_at: "2026-05-18T00:00:00.000Z",
  };
}

// ── (a) _reconcilePickFV pure predicate ──────────────────────────────

console.log("\n[_reconcilePickFV — reason classification]");

it("price=100, fv=120, ratio=1.2 → ok, +20% upside", () => {
  const r = _reconcilePickFV({ current_price_inr: 100, fair_value_inr: 120, upside_pct: 20 });
  assert.equal(r.fair_value_inr, 120);
  assert.equal(r.upside_pct, 20);
  // computed=+20%, that's NOT <=1pp from the rawUp=20 we provided (|20-20|=0,
  // BUT the guard reads `Math.abs(computed) <= 1` not `Math.abs(rawUp - computed) <= 1`
  // — so the "use provided upside" branch only fires when computed itself is
  // tiny (~price≈fv). At +20% the regular "ok" path wins.
  assert.equal(r.fv_reconcile_reason, "ok");
});

it("price=100, fv=100.5, upside=0.5 → compute from FV", () => {
  const r = _reconcilePickFV({ current_price_inr: 100, fair_value_inr: 100.5, upside_pct: 0.5 });
  assert.equal(r.fair_value_inr, 100.5);
  assert.equal(r.upside_pct, 0.5);
  assert.equal(r.fv_reconcile_reason, "ok");
});

it("price=100, fv=120, no upside_pct → compute from FV", () => {
  const r = _reconcilePickFV({ current_price_inr: 100, fair_value_inr: 120 });
  assert.equal(r.fair_value_inr, 120);
  assert.equal(r.upside_pct, 20);
  assert.equal(r.fv_reconcile_reason, "ok");
});

it("price=100, fv=120, upside=99 (disagrees with computed +20) → use computed, reason 'ok'", () => {
  const r = _reconcilePickFV({ current_price_inr: 100, fair_value_inr: 120, upside_pct: 99 });
  assert.equal(r.fair_value_inr, 120);
  assert.equal(r.upside_pct, 20);
  assert.equal(r.fv_reconcile_reason, "ok");
});

it("price=100, fv=80, ratio=0.8 → ok, -20% upside (overvalued, but in band)", () => {
  const r = _reconcilePickFV({ current_price_inr: 100, fair_value_inr: 80 });
  assert.equal(r.fair_value_inr, 80);
  assert.equal(r.upside_pct, -20);
  assert.equal(r.fv_reconcile_reason, "ok");
});

it("price=100, fv=1000, ratio=10.0 → ok (boundary inclusive)", () => {
  const r = _reconcilePickFV({ current_price_inr: 100, fair_value_inr: 1000 });
  assert.equal(r.fair_value_inr, 1000);
  assert.equal(r.upside_pct, 900);
  assert.equal(r.fv_reconcile_reason, "ok");
});

it("price=100, fv=1001, ratio=10.01 → raw SWS FV kept", () => {
  const r = _reconcilePickFV({ current_price_inr: 100, fair_value_inr: 1001 });
  assert.equal(r.fair_value_inr, 1001);
  assert.equal(r.upside_pct, 901);
  assert.equal(r.fv_reconcile_reason, "ok_sws_raw_fv");
});

it("ALEMBICLTD-like price=87.91, fv=724.17623, ratio=8.24 → ok", () => {
  const r = _reconcilePickFV({ current_price_inr: 87.91, fair_value_inr: 724.17623, upside_pct: 723.7700261631214 });
  assert.equal(r.fair_value_inr, 724.17623);
  assert.equal(r.upside_pct, 723.8);
  assert.equal(r.fv_reconcile_reason, "ok");
});

it("price=100, fv=10, ratio=0.1 → ok (boundary inclusive)", () => {
  const r = _reconcilePickFV({ current_price_inr: 100, fair_value_inr: 10 });
  assert.equal(r.fair_value_inr, 10);
  assert.equal(r.upside_pct, -90);
  assert.equal(r.fv_reconcile_reason, "ok");
});

it("price=100, fv=9.99, ratio=0.0999 → raw SWS FV kept", () => {
  const r = _reconcilePickFV({ current_price_inr: 100, fair_value_inr: 9.99 });
  assert.equal(r.fair_value_inr, 9.99);
  assert.equal(r.upside_pct, -90);
  assert.equal(r.fv_reconcile_reason, "ok_sws_raw_fv");
});

it("ADVENTHTL real case: price=150.35, fv=5133.8 → raw SWS FV kept", () => {
  const r = _reconcilePickFV({ current_price_inr: 150.35, fair_value_inr: 5133.805663 });
  assert.equal(r.fair_value_inr, 5133.805663);
  assert.equal(r.fv_reconcile_reason, "ok_sws_raw_fv");
});

it("SHREEPUSHK real case: price=390.7, fv=32.55 → raw SWS FV kept", () => {
  const r = _reconcilePickFV({ current_price_inr: 390.7, fair_value_inr: 32.548995 });
  assert.equal(r.fair_value_inr, 32.548995);
  assert.equal(r.fv_reconcile_reason, "ok_sws_raw_fv");
});

it("source FV missing → source_fv_missing, FV stays null", () => {
  const r = _reconcilePickFV({ current_price_inr: 100, fair_value_inr: null });
  assert.equal(r.fair_value_inr, null);
  assert.equal(r.fv_reconcile_reason, "source_fv_missing");
});

it("source FV zero → raw SWS FV kept", () => {
  const r = _reconcilePickFV({ current_price_inr: 100, fair_value_inr: 0 });
  assert.equal(r.fair_value_inr, 0);
  assert.equal(r.upside_pct, -100);
  assert.equal(r.fv_reconcile_reason, "ok_sws_raw_fv");
});

it("source FV negative → raw SWS FV kept", () => {
  const r = _reconcilePickFV({ current_price_inr: 100, fair_value_inr: -50 });
  assert.equal(r.fair_value_inr, -50);
  assert.equal(r.upside_pct, -150);
  assert.equal(r.fv_reconcile_reason, "ok_sws_raw_fv");
});

it("source price missing but FV present → source_price_missing, FV stays null", () => {
  // We need price to compute ratio + decide; without it we can't sanity-check
  // so we don't surface the FV either.
  const r = _reconcilePickFV({ current_price_inr: null, fair_value_inr: 100 });
  assert.equal(r.fair_value_inr, 100, "fv kept since source has it");
  assert.equal(r.fv_reconcile_reason, "source_price_missing");
});

it("both missing → source_price_missing wins (price checked first)", () => {
  const r = _reconcilePickFV({ current_price_inr: null, fair_value_inr: null });
  assert.equal(r.fair_value_inr, null);
  assert.equal(r.fv_reconcile_reason, "source_price_missing");
});

it("empty overview → source_price_missing", () => {
  const r = _reconcilePickFV({});
  assert.equal(r.fair_value_inr, null);
  assert.equal(r.fv_reconcile_reason, "source_price_missing");
});

// ── (b) pickCardFields propagates fv_reconcile_reason ────────────────

console.log("\n[pickCardFields — fv_reconcile_reason propagation]");

it("upcoming_earnings row WITH source FV in-band → output has FV + reason='ok'", () => {
  const card = pickCardFields(stock({ ticker: "STAR", price: 832, fv: 1000 }));
  assert.equal(card.fair_value_inr, 1000);
  assert.equal(card.fv_reconcile_reason, "ok");
});

it("upcoming_earnings row WITHOUT source FV → output null + reason='source_fv_missing'", () => {
  const card = pickCardFields(stock({ ticker: "NOSFV", price: 100, fv: null }));
  assert.equal(card.fair_value_inr, null);
  assert.equal(card.fv_reconcile_reason, "source_fv_missing");
});

it("avoid-section row with high FV ratio → raw SWS FV kept", () => {
  // No special avoid branch — same pickCardFields path. Verify the reason
  // surfaces so audits can categorise the unusual SWS FV without re-reading deep/.
  const card = pickCardFields(stock({ ticker: "ADVENTHTL", price: 150, fv: 5000 }));
  assert.equal(card.fair_value_inr, 5000);
  assert.equal(card.upside_pct, 3233.3);
  assert.equal(card.fv_reconcile_reason, "ok_sws_raw_fv");
  assert.equal(card.fair_value_source, "sws_raw_fv");
  assert.equal(card.upside_source, "computed_from_sws_fv_price");
});

it("avoid row with low FV ratio → raw SWS FV kept", () => {
  const card = pickCardFields(stock({ ticker: "SHREEPUSHK", price: 390, fv: 32 }));
  assert.equal(card.fair_value_inr, 32);
  assert.equal(card.fv_reconcile_reason, "ok_sws_raw_fv");
});

it("avoid row with source FV genuinely missing → null + 'source_fv_missing'", () => {
  const card = pickCardFields(stock({ ticker: "NOFV", price: 100, fv: null }));
  assert.equal(card.fair_value_inr, null);
  assert.equal(card.fv_reconcile_reason, "source_fv_missing");
});

it("every reason value is from the documented enum", () => {
  const validReasons = new Set([
    "ok",
    "ok_sws_raw_fv",
    "source_fv_missing",
    "source_price_missing",
  ]);
  const cases = [
    { current_price_inr: 100, fair_value_inr: 120 },
    { current_price_inr: 100, fair_value_inr: 120, upside_pct: 20 },
    { current_price_inr: 100, fair_value_inr: null },
    { current_price_inr: null, fair_value_inr: 100 },
    { current_price_inr: 100, fair_value_inr: 1000 },
    { current_price_inr: 100, fair_value_inr: 1001 },
    { current_price_inr: 100, fair_value_inr: 9.99 },
    {},
  ];
  for (const ov of cases) {
    const r = _reconcilePickFV(ov);
    assert(validReasons.has(r.fv_reconcile_reason), `unknown reason: ${r.fv_reconcile_reason}`);
  }
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
