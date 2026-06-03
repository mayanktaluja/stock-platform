import test from "node:test";
import assert from "node:assert/strict";
import {
  _buildDecisionMetadata,
  _reconcileFVUpside,
  valuationReviewBucket,
} from "../services/swsHoldingEngine.js";

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
  assert.equal(r.fv_reconcile_reason, "ok");
  assert.equal(r.upside_source, "computed_from_sws_fv_price");
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

test("valuation review buckets distinguish discounted, near FV, and above FV", () => {
  assert.equal(valuationReviewBucket(16, "HIGH"), "discounted");
  assert.equal(valuationReviewBucket(1.5, "HIGH"), "near_fv");
  assert.equal(valuationReviewBucket(-8, "HIGH"), "materially_above_fv");
  assert.equal(valuationReviewBucket(1.5, "MEDIUM_QUOTED"), "unknown");
});

test("review-only metadata keeps do-nothing as a first-class result", () => {
  const meta = _buildDecisionMetadata({
    action: "HOLD",
    valuationReview: { reviewCandidate: true },
    blockedReasons: ["near SWS fair value but no hard portfolio trigger; review only"],
    position_weight: 4.2,
    currentValue: 100_000,
  });

  assert.equal(meta.displayActionIntent, "Review only");
  assert.equal(meta.reasonFamily, "valuation_review");
  assert.equal(meta.requiresConfirmation, false);
  assert.equal(meta.postTradeWeight, 4.2);
  assert.equal(meta.notionalTradeValue, null);
});

test("reduction metadata emits notional and post-trade weight", () => {
  const meta = _buildDecisionMetadata({
    action: "Reduction-33%",
    valuationReview: { reviewCandidate: true },
    trimFrac: 0.33,
    position_weight: 9,
    currentValue: 300_000,
  });

  assert.equal(meta.displayActionIntent, "Trim excess");
  assert.equal(meta.reasonFamily, "valuation_review");
  assert.equal(meta.requiresConfirmation, true);
  assert.equal(meta.postTradeWeight, 6);
  assert.equal(meta.notionalTradeValue, 99_000);
});
