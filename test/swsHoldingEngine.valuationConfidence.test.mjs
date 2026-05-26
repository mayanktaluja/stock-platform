import test from "node:test";
import assert from "node:assert/strict";
import { _reconcileFVUpside } from "../services/swsHoldingEngine.js";

test("computed FV/price math gets HIGH valuation confidence", () => {
  const r = _reconcileFVUpside({
    current_price_inr: 100,
    fair_value_inr: 125,
    upside_pct: 40,
  });
  assert.equal(r.upside_pct, 25);
  assert.equal(r.fair_value_inr, 125);
  assert.equal(r.confidence, "HIGH");
  assert.equal(r.source, "computed_fv_price");
  assert.equal(r.valuation_band, "DEEP_DISCOUNT");
});

test("premium and overvalued bands come from plausible FV math", () => {
  assert.equal(_reconcileFVUpside({ current_price_inr: 100, fair_value_inr: 90 }).valuation_band, "PREMIUM");
  assert.equal(_reconcileFVUpside({ current_price_inr: 100, fair_value_inr: 75 }).valuation_band, "OVERVALUED");
});

test("missing FV with sane quoted upside is MEDIUM_QUOTED and not HIGH", () => {
  const r = _reconcileFVUpside({
    current_price_inr: 100,
    fair_value_inr: null,
    upside_pct: 18,
  });
  assert.equal(r.upside_pct, 18);
  assert.equal(r.confidence, "MEDIUM_QUOTED");
  assert.equal(r.source, "quoted_upside_no_fv");
  assert.equal(r.valuation_band, "DISCOUNT");
});

test("placeholder FV equal to price with sane quoted upside is MEDIUM_QUOTED", () => {
  const r = _reconcileFVUpside({
    current_price_inr: 100,
    fair_value_inr: 100.2,
    upside_pct: 22,
  });
  assert.equal(r.upside_pct, 22);
  assert.equal(r.confidence, "MEDIUM_QUOTED");
  assert.equal(r.source, "quoted_upside_placeholder_fv");
  assert.equal(r.valuation_band, "DISCOUNT");
});

test("implausible FV is nulled with LOW confidence", () => {
  const r = _reconcileFVUpside({
    current_price_inr: 100,
    fair_value_inr: 5000,
    upside_pct: 30,
  });
  assert.equal(r.upside_pct, null);
  assert.equal(r.fair_value_inr, null);
  assert.equal(r.confidence, "LOW");
  assert.equal(r.valuation_band, "UNKNOWN");
});
