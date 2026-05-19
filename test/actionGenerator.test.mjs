// Tests for services/paperTrade/actionGenerator.js.
// Run: node test/actionGenerator.test.mjs

import assert from "node:assert/strict";
import { generateActions, ACTION_GENERATOR_CONFIG } from "../services/paperTrade/actionGenerator.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nactionGenerator");

it("max 3 actions", () => {
  assert.equal(ACTION_GENERATOR_CONFIG.MAX_ACTIONS, 3);
});

it("RED portfolio surfaces FAILSAFE as the only action", () => {
  const r = generateActions({
    portfolio_risk: { state: "RED", drawdown_pct: -42, actions: ["failsafe_pivot_to_niftybees_and_cash"] },
  });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, "FAILSAFE");
});

it("stop breach surfaces EXIT_STOP action", () => {
  const r = generateActions({
    mtm: { positions: [{ ticker: "A", tier: "anchor", current_price_inr: 60, avg_entry_price_inr: 100 }] },
    risk_verdicts: { A: { breached: true, gain_pct: -40, band_label: "initial", stop_price_inr: 65 } },
  });
  const types = r.actions.map((a) => a.type);
  assert.ok(types.includes("EXIT_STOP"));
});

it("trim recommendation surfaces TRIM action", () => {
  const r = generateActions({
    mtm: { positions: [{ ticker: "A", tier: "anchor", current_price_inr: 600, avg_entry_price_inr: 100 }] },
    risk_verdicts: { A: { breached: false, gain_pct: 500, band_label: "+500%_peak_-40%", stop_price_inr: 360, recommended_trim_pct: 0.5 } },
  });
  assert.equal(r.actions[0].type, "TRIM");
  assert.equal(r.actions[0].trim_pct, 0.5);
});

it("BUY recommendation fills empty Anchor slot with top 5X_CANDIDATE", () => {
  const r = generateActions({
    mtm: { positions: [] },
    candidates: [
      { ticker: "INOX", score_0_100: 80, verdict: "5X_CANDIDATE", breakdown: { mcap: 10, v3_future: 12 } },
      { ticker: "WIN2", score_0_100: 72, verdict: "5X_CANDIDATE", breakdown: { mcap: 8, v3_future: 10 } },
    ],
    regime_open: { pillar1_anchor: { open: true }, pillar1_high: { open: true } },
  });
  assert.equal(r.actions[0].type, "BUY");
  assert.equal(r.actions[0].ticker, "INOX");
  assert.equal(r.actions[0].tier, "anchor");
});

it("regime-blocked → no BUY actions, NO_ACTION with reason", () => {
  const r = generateActions({
    mtm: { positions: [] },
    candidates: [{ ticker: "X", score_0_100: 80, verdict: "5X_CANDIDATE" }],
    regime_open: { pillar1_anchor: { open: false, reasons: ["regime_risk_off_blocked"] }, pillar1_high: { open: false, reasons: ["regime_risk_off_blocked"] } },
  });
  assert.equal(r.regime_blocked, true);
  assert.equal(r.actions[0].type, "NO_ACTION");
  assert.match(r.actions[0].detail, /regime/i);
});

it("empty state with no events surfaces 'Pipeline quiet'", () => {
  const r = generateActions({ mtm: { positions: [] }, candidates: [], regime_open: { pillar1_anchor: { open: true }, pillar1_high: { open: true } } });
  assert.equal(r.actions[0].type, "NO_ACTION");
  assert.match(r.actions[0].detail, /Pipeline is quiet/i);
});

it("empty state with next_event_hint surfaces upcoming catalyst", () => {
  const r = generateActions({
    mtm: { positions: [] },
    candidates: [],
    regime_open: { pillar1_anchor: { open: true }, pillar1_high: { open: true } },
    next_event_hint: { date_iso: "2026-05-25", label: "ACE earnings BEAT" },
  });
  assert.match(r.actions[0].detail, /ACE earnings BEAT/);
});

it("does not propose BUY for already-held ticker", () => {
  const r = generateActions({
    mtm: { positions: [{ ticker: "INOX", tier: "anchor" }] },
    candidates: [
      { ticker: "INOX", score_0_100: 80, verdict: "5X_CANDIDATE" },
      { ticker: "WIN2", score_0_100: 72, verdict: "5X_CANDIDATE" },
    ],
    regime_open: { pillar1_anchor: { open: true }, pillar1_high: { open: true } },
  });
  const tickers = r.actions.map((a) => a.ticker);
  assert.ok(!tickers.includes("INOX") || r.actions.find((a) => a.ticker === "INOX")?.type !== "BUY");
  assert.ok(tickers.includes("WIN2"));
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
