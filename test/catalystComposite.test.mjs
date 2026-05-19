// Tests for services/multibagger/catalystComposite.js.
// Run: node test/catalystComposite.test.mjs

import assert from "node:assert/strict";
import { buildCatalystSlate, CATALYST_COMPOSITE_CONFIG } from "../services/multibagger/catalystComposite.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\ncatalystComposite");

const TODAY = "2026-05-20";

it("config exposes thresholds", () => {
  assert.equal(CATALYST_COMPOSITE_CONFIG.EARNINGS_MIN_CONFIDENCE_PCT, 60);
  assert.equal(CATALYST_COMPOSITE_CONFIG.EARNINGS_MIN_V3_SCORE, 50);
  assert.equal(CATALYST_COMPOSITE_CONFIG.BLOCK_MIN_DEAL_INR, 50e7);
});

it("earnings BEAT filtered by confidence + V3 floor + within 7 days", () => {
  const earnings_watch = {
    events: [
      {
        symbol: "GOOD",
        event_iso_date: "2026-05-25",
        prediction: { verdict: "BEAT", confidence_pct: 68, reasons_top: ["V3 future strong"] },
        signals: { v3: { v3_score_100: 60 }, sector: "Renewables" },
      },
      {
        symbol: "LOWCONF",
        event_iso_date: "2026-05-25",
        prediction: { verdict: "BEAT", confidence_pct: 50 },
        signals: { v3: { v3_score_100: 60 } },
      },
      {
        symbol: "LOWV3",
        event_iso_date: "2026-05-25",
        prediction: { verdict: "BEAT", confidence_pct: 70 },
        signals: { v3: { v3_score_100: 40 } },
      },
      {
        symbol: "MISS",
        event_iso_date: "2026-05-25",
        prediction: { verdict: "MISS", confidence_pct: 70 },
        signals: { v3: { v3_score_100: 60 } },
      },
      {
        symbol: "TOOFAR",
        event_iso_date: "2026-06-30",
        prediction: { verdict: "BEAT", confidence_pct: 70 },
        signals: { v3: { v3_score_100: 60 } },
      },
    ],
  };
  const slate = buildCatalystSlate({ earnings_watch, today_iso: TODAY });
  const tickers = slate.earnings_beat.map((e) => e.symbol);
  assert.deepEqual(tickers, ["GOOD"]);
});

it("dividend capture needs yield ≥4% AND hold-by ≤7d", () => {
  const dividends_upcoming = {
    dividends: [
      { symbol: "HOLD1", dps: 10, ex_date: "2026-05-22" }, // yield computed from holding avg_price
      { symbol: "HOLDLATE", dps: 10, ex_date: "2026-06-15" },
      { symbol: "LOWYIELD", dps: 2, ex_date: "2026-05-22" },
    ],
  };
  const holdingsByTicker = {
    HOLD1: { avg_price_inr: 100 }, // yield = 10%
    HOLDLATE: { avg_price_inr: 100 }, // 10% but too far
    LOWYIELD: { avg_price_inr: 100 }, // 2% yield (below floor)
  };
  const slate = buildCatalystSlate({ dividends_upcoming, current_holdings: holdingsByTicker, today_iso: TODAY });
  assert.equal(slate.dividend_capture.length, 1);
  assert.equal(slate.dividend_capture[0].ticker, "HOLD1");
});

it("block deals need ≥₹50Cr buy in ≤₹3000Cr mcap with V3 ≥50", () => {
  const bulk_block = {
    deals: [
      { symbol: "FIT", side: "BUY", deal_value_inr: 80e7, market_cap_inr: 2000e7, v3_score_100: 60, deal_date_iso: "2026-05-19" },
      { symbol: "TOOBIG", side: "BUY", deal_value_inr: 60e7, market_cap_inr: 5000e7, v3_score_100: 60, deal_date_iso: "2026-05-19" },
      { symbol: "TOOSMALL", side: "BUY", deal_value_inr: 30e7, market_cap_inr: 1000e7, v3_score_100: 60, deal_date_iso: "2026-05-19" },
      { symbol: "SELL", side: "SELL", deal_value_inr: 60e7, market_cap_inr: 2000e7, v3_score_100: 60, deal_date_iso: "2026-05-19" },
      { symbol: "OLD", side: "BUY", deal_value_inr: 60e7, market_cap_inr: 2000e7, v3_score_100: 60, deal_date_iso: "2026-04-01" },
    ],
  };
  const slate = buildCatalystSlate({ bulk_block, today_iso: TODAY });
  assert.equal(slate.block_deal.length, 1);
  assert.equal(slate.block_deal[0].symbol, "FIT");
});

it("slate is round-robin across the 3 streams, capped at PILLAR2_MAX_TOTAL", () => {
  const earnings_watch = {
    events: Array.from({ length: 3 }, (_, i) => ({
      symbol: `E${i}`,
      event_iso_date: "2026-05-22",
      prediction: { verdict: "BEAT", confidence_pct: 70 + i },
      signals: { v3: { v3_score_100: 60 } },
    })),
  };
  const dividends_upcoming = {
    dividends: Array.from({ length: 3 }, (_, i) => ({
      symbol: `D${i}`, dps: 10, ex_date: "2026-05-22",
    })),
  };
  const holdings = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`D${i}`, { avg_price_inr: 100 }]));
  const bulk_block = {
    deals: Array.from({ length: 3 }, (_, i) => ({
      symbol: `B${i}`, side: "BUY", deal_value_inr: (80 - i * 5) * 1e7,
      market_cap_inr: 2000e7, v3_score_100: 60, deal_date_iso: "2026-05-19",
    })),
  };
  const slate = buildCatalystSlate({ earnings_watch, dividends_upcoming, bulk_block, current_holdings: holdings, today_iso: TODAY });
  assert.equal(slate.slate.length, 5); // capped
  const types = slate.slate.map((s) => s.type);
  // Round-robin: earnings_beat, dividend_capture, block_deal, earnings_beat, dividend_capture
  assert.equal(types[0], "earnings_beat");
  assert.equal(types[1], "dividend_capture");
  assert.equal(types[2], "block_deal");
});

it("empty inputs → empty slate", () => {
  const slate = buildCatalystSlate({ today_iso: TODAY });
  assert.equal(slate.slate.length, 0);
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
