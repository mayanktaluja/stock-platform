import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateProfitProtection,
  attachProfitProtection,
} from "../services/portfolio/profitProtectionSignal.js";

// The owner's canonical case: Jeena Sikho-shaped — SME winner, ₹740 peak,
// now ~₹590, holder well in profit on cost, wide 52W range, no SWS beta.
function jeenaShaped(overrides = {}) {
  return {
    symbol: "JEENASIKHO",
    action: "HOLD",
    pnlPercent: 45,
    currentValue: 200000,
    livePrice: 590,
    sws: {
      ticker: "JEENASIKHO",
      fifty_two_week_high_inr: 740,
      fifty_two_week_low_inr: 320,
      current_price_inr: 590,
    },
    ...overrides,
  };
}

test("fires on the Jeena-shaped case: 20% retrace, wide SME range, +45% on cost", () => {
  const s = evaluateProfitProtection(jeenaShaped());
  assert.ok(s, "signal should fire");
  assert.equal(s.retracePctFromHigh, 20.3);
  assert.equal(s.suggestedTrimPct, 20);
  assert.equal(s.notionalFreedInr, 40000);
  assert.equal(s.source, "sws");
  assert.match(s.volatilityQualifier, /52W range \d+% wide/);
  assert.match(s.rationale, /Optional discipline rule, not a thesis change/);
});

test("deeper retrace (>=25%) suggests the 33% rung", () => {
  const s = evaluateProfitProtection(jeenaShaped({ livePrice: 540 })); // 27% off 740
  assert.equal(s.suggestedTrimPct, 33);
});

test("loss on cost → null (loss-side drawdown path owns it)", () => {
  assert.equal(evaluateProfitProtection(jeenaShaped({ pnlPercent: -12 })), null);
});

test("gain below +25% on cost → null", () => {
  assert.equal(evaluateProfitProtection(jeenaShaped({ pnlPercent: 18 })), null);
});

test("retrace below 15% → null", () => {
  assert.equal(evaluateProfitProtection(jeenaShaped({ livePrice: 660 })), null); // 10.8%
});

test("no volatility qualifier (low beta, narrow range) → null", () => {
  const h = jeenaShaped();
  h.sws.fifty_two_week_low_inr = 700; // narrow range
  h.sws.beta = 0.8;
  h.sws.fifty_two_week_high_inr = 740;
  h.livePrice = 590;
  assert.equal(evaluateProfitProtection(h), null);
});

test("beta qualifier works for covered names without a wide range", () => {
  const h = jeenaShaped();
  h.sws.fifty_two_week_low_inr = 560; // narrow range (~32%)
  h.sws.beta = 1.4;
  const s = evaluateProfitProtection(h);
  assert.ok(s);
  assert.equal(s.volatilityQualifier, "beta 1.40");
});

test("existing reduction action suppresses the signal (Tier A owns it)", () => {
  assert.equal(evaluateProfitProtection(jeenaShaped({ action: "Reduction-50%" })), null);
  assert.equal(evaluateProfitProtection(jeenaShaped({ action: "EXIT-now" })), null);
});

test("missing 52W data from both sources → null", () => {
  const h = jeenaShaped();
  delete h.sws.fifty_two_week_high_inr;
  assert.equal(evaluateProfitProtection(h), null);
});

test("quote fallback for SWS-uncovered names, tagged source:quote", () => {
  const h = {
    symbol: "JEENASIKHO",
    action: "HOLD",
    pnlPercent: 45,
    currentValue: 200000,
    livePrice: 590,
    fiftyTwoWeekHigh: 740,
    fiftyTwoWeekLow: 320,
    sws: { ticker: "JEENASIKHO" },
  };
  const s = evaluateProfitProtection(h);
  assert.ok(s);
  assert.equal(s.source, "quote");
});

test("strong-fundamentals softener changes the suggested wording, not the trigger", () => {
  const h = jeenaShaped();
  h.sws.v4_verdict = "TOP_PICK";
  const s = evaluateProfitProtection(h);
  assert.equal(s.strongFundamentals, true);
  assert.match(s.rationale, /trimming only the position excess/);
});

test("attachProfitProtection mutates qualifying rows and sorts by retrace desc", () => {
  const shallow = jeenaShaped({ symbol: "SHALLOW", livePrice: 620 }); // 16.2%
  shallow.sws = { ...shallow.sws, ticker: "SHALLOW" };
  const deep = jeenaShaped({ symbol: "DEEP", livePrice: 540 }); // 27%
  deep.sws = { ...deep.sws, ticker: "DEEP" };
  const hold = { symbol: "NOPE", action: "HOLD", pnlPercent: 2, sws: {} };
  const rows = attachProfitProtection([shallow, deep, hold]);
  assert.deepEqual(rows.map((r) => r.ticker), ["DEEP", "SHALLOW"]);
  assert.ok(deep.profitProtection.eligible);
  assert.equal(hold.profitProtection, undefined);
});
