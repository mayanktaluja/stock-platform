import test from "node:test";
import assert from "node:assert/strict";
import { _reconcileFVUpside } from "../services/swsHoldingEngine.js";

test("raw SWS FV/price math gets HIGH valuation confidence", () => {
  const r = _reconcileFVUpside({
    current_price_inr: 100,
    fair_value_inr: 125,
    upside_pct: 40,
  });
  assert.equal(r.upside_pct, 25);
  assert.equal(r.fair_value_inr, 125);
  assert.equal(r.confidence, "HIGH");
  assert.equal(r.source, "sws_raw_fv");
  assert.equal(r.valuation_band, "DEEP_DISCOUNT");
});

test("premium and expensive bands come from raw SWS FV math", () => {
  assert.equal(_reconcileFVUpside({ current_price_inr: 100, fair_value_inr: 90 }).valuation_band, "PREMIUM");
  assert.equal(_reconcileFVUpside({ current_price_inr: 100, fair_value_inr: 75 }).valuation_band, "EXPENSIVE");
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

test("near-price raw SWS FV is preserved instead of replaced by quoted upside", () => {
  const r = _reconcileFVUpside({
    current_price_inr: 100,
    fair_value_inr: 100.2,
    upside_pct: 22,
  });
  assert.equal(r.upside_pct, 0.2);
  assert.equal(r.fair_value_inr, 100.2);
  assert.equal(r.confidence, "HIGH");
  assert.equal(r.source, "sws_raw_fv");
  assert.equal(r.valuation_band, "FAIR");
});

test("extreme raw SWS FV is preserved with HIGH confidence", () => {
  const r = _reconcileFVUpside({
    current_price_inr: 100,
    fair_value_inr: 5000,
    upside_pct: 30,
  });
  assert.equal(r.upside_pct, 4900);
  assert.equal(r.fair_value_inr, 5000);
  assert.equal(r.confidence, "HIGH");
  assert.equal(r.source, "sws_raw_fv");
  assert.equal(r.valuation_band, "DEEP_DISCOUNT");
});
