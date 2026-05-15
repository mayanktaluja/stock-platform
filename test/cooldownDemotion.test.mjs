/**
 * Tests for the cooldown-gate demotion pipeline:
 *   • applyCooldownDemotion        — mutates scoredHoldings in place
 *   • rebuildTierAggregates        — Tier A loses demoted symbol, gains it in C
 *   • Reconciler symbol fallback   — ISIN/symbol/normalized-symbol drift
 *
 * Run with: node test/cooldownDemotion.test.mjs
 */

import {
  applyCooldownDemotion,
  reconcileRecommendations,
  buildIssuedEvents,
  computeRecId,
  normalizeSymbol,
} from "../services/recommendationMemory.js";
import {
  buildTiers,
  rebuildTierAggregates,
} from "../services/swsPortfolioAggregate.js";

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, "→ got", JSON.stringify(got)); }
}

process.env.SWS_COOLDOWN_GATE = "1";

const NOW = new Date("2026-05-14T08:00:00.000Z");

function scored({ symbol, isin, action, qty = 100, weight = 0.5, v3 = 50, severity = 0.18 }) {
  return {
    symbol, isin, action,
    quantity: qty,
    positionWeight: weight,
    combinedScore: v3,
    score: v3,
    severity,
    swsCovered: true,
    currentValue: qty * 100,
    invested: qty * 80,
    sws: {
      ticker: symbol,
      snowflake_total: 12,
      snowflake: { total: 12, valuation: 3, future_growth: 2, past_performance: 3, financial_health: 2, dividends: 2 },
      multiples: { pe: 20, ps: 3, pb: 4, ev_ebitda: 12 },
      v3_score: v3,
      verdict: "FAIR",
      upside_pct: -5,
      next_earnings_date: null,
      net_margin_pct: 10,
      revenue_growth_pct: 5,
      earnings_growth_pct: 3,
      last_quarter_result: "neutral",
    },
  };
}

// ──────────────────── applyCooldownDemotion ────────────────────

console.log("\napplyCooldownDemotion\n");

{
  const holdings = [
    scored({ symbol: "JWL", isin: "INE363M01019", action: "Reduction-25%" }),
    scored({ symbol: "TATATECH", isin: "INE142M01025", action: "Reduction-25%" }),
    scored({ symbol: "TCS", isin: "INE467B01029", action: "HOLD" }),
  ];
  const entries = [
    { symbol: "JWL", isin: "INE363M01019", symKey: "INE363M01019", candidateDirection: "sell",
      executedOn: "2026-05-13", executedAt: "2026-05-13T08:00:00Z", executedAction: "Reduction-25%",
      cooldownUntil: "2026-05-20T08:00:00Z", cooldownWindowDays: 7 },
    { symbol: "TATATECH", isin: "INE142M01025", symKey: "INE142M01025", candidateDirection: "sell",
      executedOn: "2026-05-13", executedAt: "2026-05-13T08:00:00Z", executedAction: "Reduction-25%",
      cooldownUntil: "2026-05-20T08:00:00Z", cooldownWindowDays: 7 },
  ];
  const demoted = applyCooldownDemotion(holdings, entries);
  assert("demoted set has both ISINs", demoted.size === 2 && demoted.has("INE363M01019") && demoted.has("INE142M01025"), [...demoted]);
  assert("JWL action rewritten to HOLD", holdings[0].action === "HOLD", holdings[0].action);
  assert("JWL preCooldownAction preserved", holdings[0].preCooldownAction === "Reduction-25%", holdings[0].preCooldownAction);
  assert("JWL stamped with gatedByCooldown", holdings[0].gatedByCooldown?.executedAction === "Reduction-25%", holdings[0].gatedByCooldown);
  assert("TATATECH action rewritten to HOLD", holdings[1].action === "HOLD", holdings[1].action);
  assert("TCS untouched (no cooldown entry)", holdings[2].action === "HOLD" && !holdings[2].gatedByCooldown, holdings[2]);
}

{
  // No entries → no demotion, returns empty set
  const holdings = [scored({ symbol: "JWL", isin: "X", action: "Reduction-25%" })];
  const demoted = applyCooldownDemotion(holdings, []);
  assert("empty entries → empty demoted", demoted.size === 0 && holdings[0].action === "Reduction-25%", { action: holdings[0].action });
}

{
  // Direction mismatch: cooldown was for sell, candidate is topup → no demotion
  const holdings = [scored({ symbol: "X", isin: "INX", action: "Top-up-50%" })];
  const entries = [{ symbol: "X", isin: "INX", symKey: "INX", candidateDirection: "sell",
                     executedAction: "Reduction-25%", cooldownUntil: "2026-05-20T08:00:00Z" }];
  const demoted = applyCooldownDemotion(holdings, entries);
  assert("direction mismatch → no demotion", demoted.size === 0 && holdings[0].action === "Top-up-50%", holdings[0].action);
}

// ──────────────────── rebuildTierAggregates ────────────────────

console.log("\nrebuildTierAggregates\n");

{
  const holdings = [
    scored({ symbol: "JWL", isin: "INE363M01019", action: "Reduction-25%" }),
    scored({ symbol: "TATATECH", isin: "INE142M01025", action: "Reduction-25%" }),
    scored({ symbol: "TCS", isin: "INE467B01029", action: "HOLD", v3: 60 }),
  ];
  // Initial build — Tier A has both reductions.
  const initialTiers = buildTiers(holdings);
  assert("initial: Tier A has JWL+TATATECH",
    initialTiers.tierA.length === 2,
    initialTiers.tierA.map((h) => h.symbol));

  const report = {
    tiers: {
      A: { rows: initialTiers.tierA, freedRupees: initialTiers.freedRupees },
      C: { rows: initialTiers.tierC },
      D: { rows: initialTiers.tierD },
    },
    snapshot: { actionMix: { "Reduction-25%": 2, HOLD: 1 } },
    holdingsByAction: {},
  };

  // Demote JWL.
  applyCooldownDemotion(holdings, [
    { symbol: "JWL", isin: "INE363M01019", symKey: "INE363M01019", candidateDirection: "sell",
      executedOn: "2026-05-13", executedAction: "Reduction-25%", cooldownUntil: "2026-05-20T08:00:00Z" },
  ]);
  rebuildTierAggregates(report, holdings);

  assert("after demotion: Tier A loses JWL", !report.tiers.A.rows.some((h) => h.symbol === "JWL"), report.tiers.A.rows.map((h) => h.symbol));
  assert("after demotion: Tier A still has TATATECH", report.tiers.A.rows.some((h) => h.symbol === "TATATECH"), report.tiers.A.rows.map((h) => h.symbol));
  assert("after demotion: Tier C contains JWL", report.tiers.C.rows.some((h) => h.symbol === "JWL"), report.tiers.C.rows.map((h) => h.symbol));
  assert("after demotion: actionMix reflects new counts",
    report.snapshot.actionMix["Reduction-25%"] === 1 && report.snapshot.actionMix["HOLD"] === 2,
    report.snapshot.actionMix);
  assert("after demotion: holdingsByAction[Reduction-25%] excludes JWL",
    !(report.holdingsByAction["Reduction-25%"] || []).some((h) => h.symbol === "JWL"),
    report.holdingsByAction["Reduction-25%"]);
}

// ──────────────────── Reconciler symbol fallback ────────────────────

console.log("\nReconciler — ISIN / symbol drift fallback\n");

{
  // ISSUED yesterday with isin set; today's holding has no isin but matching symbol.
  const symKey = "INE363M01019";
  const recId = computeRecId(symKey, ["weight_15_to_20"], "2026-05-13");
  const issued = {
    type: "ISSUED",
    recId,
    at: "2026-05-13T08:00:00Z",
    symbol: "JWL",
    isin: "INE363M01019",
    action: "Reduction-25%",
    reductionPct: 0.25,
    factors: ["weight_15_to_20"],
    sourceSnapshot: "2026-05-13",
    qtyAtIssue: 100,
    weightAtIssue: 0.93,
    scoreAtIssue: 53,
  };
  const openRecs = new Map([[recId, { recId, state: "PENDING", issuedEvent: issued, lastEvent: issued }]]);
  const prevSnap = {
    asOfDateIso: "2026-05-13",
    contentHash: "h1",
    holdings: [{ symbol: "JWL", isin: "INE363M01019", quantity: 100, avgPrice: 100 }],
    facets: [],
  };
  // Today's holding lost its ISIN (parser quirk) — only the symbol survives.
  const newSnap = {
    asOfDateIso: "2026-05-14",
    contentHash: "h2",
    holdings: [{ symbol: "JWL", isin: null, quantity: 75, avgPrice: 100 }],
    facets: [],
  };
  const { events } = reconcileRecommendations({ prevSnap, newSnap, openRecs, now: NOW });
  const exec = events.find((e) => e.type === "EXECUTED");
  assert("EXECUTED emitted even with ISIN drift", !!exec, events);
  assert("EXECUTED ratio ≈ 1.0", exec && Math.abs(exec.ratio - 1) < 0.001, exec?.ratio);
}

{
  // Today's holding carries `.NS` suffix; yesterday's was bare.
  const symKey = "SYM:JWL";
  const recId = computeRecId(symKey, ["weight_15_to_20"], "2026-05-13");
  const issued = {
    type: "ISSUED",
    recId,
    at: "2026-05-13T08:00:00Z",
    symbol: "JWL",
    isin: null,
    action: "Reduction-25%",
    reductionPct: 0.25,
    factors: ["weight_15_to_20"],
    sourceSnapshot: "2026-05-13",
    qtyAtIssue: 100,
    weightAtIssue: 0.93,
    scoreAtIssue: 53,
  };
  const openRecs = new Map([[recId, { recId, state: "PENDING", issuedEvent: issued, lastEvent: issued }]]);
  const prevSnap = {
    asOfDateIso: "2026-05-13",
    contentHash: "h1",
    holdings: [{ symbol: "JWL", isin: null, quantity: 100, avgPrice: 100 }],
    facets: [],
  };
  const newSnap = {
    asOfDateIso: "2026-05-14",
    contentHash: "h2",
    holdings: [{ symbol: "JWL.NS", isin: null, quantity: 75, avgPrice: 100 }],
    facets: [],
  };
  const { events } = reconcileRecommendations({ prevSnap, newSnap, openRecs, now: NOW });
  const exec = events.find((e) => e.type === "EXECUTED");
  assert("EXECUTED emitted across .NS suffix drift", !!exec, events);
}

console.log("\nnormalizeSymbol\n");
{
  assert("strips .NS",      normalizeSymbol("JWL.NS") === "JWL", normalizeSymbol("JWL.NS"));
  assert("strips .BO",      normalizeSymbol("JWL.BO") === "JWL", normalizeSymbol("JWL.BO"));
  assert("strips -EQ",      normalizeSymbol("JWL-EQ") === "JWL", normalizeSymbol("JWL-EQ"));
  assert("preserves base",  normalizeSymbol("JWL") === "JWL", normalizeSymbol("JWL"));
  assert("null → null",     normalizeSymbol(null) === null, normalizeSymbol(null));
}

// ──────────────────── End-to-end: demotion across the gate ────────────────────

console.log("\nEnd-to-end · gate + demotion · Tier A no longer shows the symbol\n");

{
  // Day 1 issued ledger event + reconcile event closing it → cooldown should
  // gate today's candidate AND demote the scored holding so Tier A loses it.
  const symKey = "INE363M01019";
  const recId = computeRecId(symKey, ["weight_15_to_20"], "2026-05-13");
  const ledgerEvents = [{
    type: "ISSUED", recId, at: "2026-05-13T08:00:00Z",
    symbol: "JWL", isin: "INE363M01019", action: "Reduction-25%",
    reductionPct: 0.25, factors: ["weight_15_to_20"], sourceSnapshot: "2026-05-13",
    qtyAtIssue: 100, weightAtIssue: 0.93, scoreAtIssue: 53, severity: 0.18,
  }];
  const reconcileEvents = [{
    type: "EXECUTED", recId, at: "2026-05-14T08:00:00.000Z",
    ratio: 1.0, qtyDelta: -25, sourceSnapshot: "2026-05-14",
    actionAtExecution: "Reduction-25%",
    severityAtExecution: 0.18, scoreAtExecution: 53,
  }];
  const cand = scored({ symbol: "JWL", isin: "INE363M01019", action: "Reduction-25%", qty: 75 });
  cand.factors = ["weight_15_to_20"];
  const scoredHoldings = [cand];
  const newSnap = { asOfDateIso: "2026-05-14", facets: [], contentHash: "x" };
  const { events: issuedEvents, cooldownEntries } = buildIssuedEvents({
    scoredHoldings,
    newSnap,
    openRecsAfterReconcile: new Map(),
    ledgerEvents,
    reconcileEvents,
    now: NOW,
  });
  assert("no fresh ISSUED minted", issuedEvents.length === 0, issuedEvents);
  assert("cooldownEntries has JWL", cooldownEntries.length === 1 && cooldownEntries[0].symbol === "JWL", cooldownEntries);

  applyCooldownDemotion(scoredHoldings, cooldownEntries);
  assert("JWL action demoted to HOLD via gate", scoredHoldings[0].action === "HOLD", scoredHoldings[0].action);

  const tiers = buildTiers(scoredHoldings);
  assert("Tier A no longer lists JWL", tiers.tierA.length === 0, tiers.tierA.map((h) => h.symbol));
  assert("Tier C now contains JWL", tiers.tierC.some((h) => h.symbol === "JWL"), tiers.tierC.map((h) => h.symbol));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
