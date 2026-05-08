/**
 * Tests for services/recommendationMemory.js — the reconciler + suppression engine.
 *
 * Run with: node test/recommendationMemory.test.mjs
 */

import {
  factorSignature,
  computeRecId,
  contentHashFromHoldings,
  brokerFromSource,
  symbolKey,
  actionRank,
  actionDirection,
  isSellAction,
  isTopUpAction,
  isHoldAction,
  buildSnapshot,
  deriveOpenRecs,
  detectCorporateActions,
  reconcileRecommendations,
  buildIssuedEvents,
  applyReconcileToOpenRecs,
  computeFreedCapital,
  applyMemoryToReport,
} from "../services/recommendationMemory.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

// ──────────────────── Helpers ────────────────────

function holding({ symbol, isin, qty, avgPrice, sector = "Tech" }) {
  return {
    symbol,
    isin: isin || `IN-${symbol}`,
    name: symbol,
    quantity: qty,
    avgPrice,
    sector,
  };
}

function facet({ symbol, isin, action, factors, score, weight = 10, swsCovered = true, livePrice = 100 }) {
  return {
    symbol,
    isin: isin || `IN-${symbol}`,
    action,
    factors,
    combinedScore: score,
    fundamentalVerdict: null,
    positionWeight: weight,
    pnlPercent: 0,
    swsCovered,
    trimRupees: null,
    topUpRupees: null,
    livePrice,
  };
}

function buildLocalSnapshot({ asOfDateIso, holdings, facets, contentHash }) {
  return {
    asOfDateIso,
    uploadedAtIso: `${asOfDateIso}T10:00:00.000Z`,
    contentHash: contentHash || contentHashFromHoldings(holdings),
    sourceFile: null,
    sourceBroker: "groww-xlsx",
    backdated: false,
    asOfDateInferred: false,
    holdings,
    facets,
  };
}

function issuedEvent({ recId, symbol, isin, action, asOfDateIso, factors, qtyAtIssue, scoreAtIssue = 50 }) {
  return {
    type: "ISSUED",
    recId,
    at: `${asOfDateIso}T11:00:00.000Z`,
    symbol,
    isin: isin || `IN-${symbol}`,
    action,
    reductionPct: action.startsWith("Reduction") ? Number(action.match(/\d+/)?.[0]) / 100 : null,
    addPct: action.startsWith("Top-up") ? Number(action.match(/\d+/)?.[0]) / 100 : null,
    severity: 0.5,
    trimRupees: null,
    topUpRupees: null,
    factors,
    reasoning: null,
    sourceSnapshot: asOfDateIso,
    qtyAtIssue,
    weightAtIssue: 18,
    scoreAtIssue,
  };
}

// ──────────────────── Pure helpers ────────────────────

console.log("\nfactorSignature / computeRecId / contentHashFromHoldings\n");

{
  const a = factorSignature(["a", "b", "c"]);
  const b = factorSignature(["c", "a", "b"]);
  assert("factorSignature is order-independent", a === b, [a, b]);
  assert("empty factor list returns sentinel", factorSignature([]) === "no_factors", factorSignature([]));
}

{
  const id1 = computeRecId("IN-TCS", ["weight_15_to_20", "score_low"], "2026-05-08");
  const id2 = computeRecId("IN-TCS", ["score_low", "weight_15_to_20"], "2026-05-08");
  const id3 = computeRecId("IN-TCS", ["weight_15_to_20", "score_low"], "2026-05-09");
  assert("recId stable across factor order", id1 === id2, [id1, id2]);
  assert("recId distinct across asOfDate", id1 !== id3, [id1, id3]);
}

{
  const h1 = [holding({ symbol: "TCS", qty: 100, avgPrice: 1500 }), holding({ symbol: "ITC", qty: 50, avgPrice: 350 })];
  const h2 = [holding({ symbol: "ITC", qty: 50, avgPrice: 350 }), holding({ symbol: "TCS", qty: 100, avgPrice: 1500 })];
  assert("contentHash is order-independent", contentHashFromHoldings(h1) === contentHashFromHoldings(h2),
    [contentHashFromHoldings(h1), contentHashFromHoldings(h2)]);
  const h3 = [holding({ symbol: "TCS", qty: 75, avgPrice: 1500 }), holding({ symbol: "ITC", qty: 50, avgPrice: 350 })];
  assert("contentHash changes on qty diff", contentHashFromHoldings(h1) !== contentHashFromHoldings(h3),
    [contentHashFromHoldings(h1), contentHashFromHoldings(h3)]);
}

console.log("\nbrokerFromSource\n");

{
  assert("groww xlsx", brokerFromSource("groww-stocks-xlsx") === "groww-xlsx", brokerFromSource("groww-stocks-xlsx"));
  assert("zerodha csv", brokerFromSource("zerodha-csv") === "zerodha-csv", brokerFromSource("zerodha-csv"));
  assert("upstox xlsx", brokerFromSource("upstox-holdings-xlsx") === "upstox-xlsx", brokerFromSource("upstox-holdings-xlsx"));
  assert("rerun passthrough", brokerFromSource("rerun:Groww_2026.xlsx") === "rerun:Groww_2026.xlsx", brokerFromSource("rerun:Groww_2026.xlsx"));
}

console.log("\nactionRank / direction predicates\n");

{
  assert("EXIT-now > Reduction-25%", actionRank("EXIT-now") > actionRank("Reduction-25%"), [actionRank("EXIT-now"), actionRank("Reduction-25%")]);
  assert("Reduction-50% > Reduction-25%", actionRank("Reduction-50%") > actionRank("Reduction-25%"), null);
  assert("Top-up-100% strongest topup",
    Math.abs(actionRank("Top-up-100%")) > Math.abs(actionRank("Top-up-25%")), null);
  assert("HOLD has zero rank", actionRank("HOLD") === 0, actionRank("HOLD"));
  assert("isSellAction(Reduction-25%)", isSellAction("Reduction-25%") === true, false);
  assert("isTopUpAction(Top-up-50%)", isTopUpAction("Top-up-50%") === true, false);
  assert("isHoldAction(HOLD)", isHoldAction("HOLD") === true, false);
  assert("actionDirection(EXIT-now) sell", actionDirection("EXIT-now") === "sell", actionDirection("EXIT-now"));
  assert("actionDirection(Top-up-25%) topup", actionDirection("Top-up-25%") === "topup", actionDirection("Top-up-25%"));
}

// ──────────────────── buildSnapshot ────────────────────

console.log("\nbuildSnapshot\n");

{
  const parsed = {
    holdings: [holding({ symbol: "TCS", qty: 100, avgPrice: 1500 })],
    source: "groww-xlsx",
  };
  const scored = [{ symbol: "TCS", isin: "IN-TCS", action: "Reduction-25%", factors: ["weight_15_to_20"], combinedScore: 50, positionWeight: 18, pnlPercent: 5, swsCovered: true, livePrice: 1700 }];
  const snap = buildSnapshot({
    asOfDateIso: "2026-05-08",
    uploadedAtIso: "2026-05-08T11:00:00Z",
    parsed,
    scoredHoldings: scored,
    sourceFile: "Groww_Holdings.xlsx",
  });
  assert("snapshot carries asOfDateIso", snap.asOfDateIso === "2026-05-08", snap.asOfDateIso);
  assert("snapshot computes contentHash", typeof snap.contentHash === "string" && snap.contentHash.length > 0, snap.contentHash);
  assert("snapshot carries facets", snap.facets[0].action === "Reduction-25%", snap.facets[0]);
  assert("snapshot inferred broker from source", snap.sourceBroker === "groww-xlsx", snap.sourceBroker);
  assert("first-upload not backdated", snap.backdated === false, snap.backdated);
}

{
  const history = { snapshots: [{ asOfDateIso: "2026-05-08" }] };
  const snap = buildSnapshot({
    asOfDateIso: "2026-04-30",
    uploadedAtIso: "2026-05-09T08:00:00Z",
    parsed: { holdings: [holding({ symbol: "TCS", qty: 100, avgPrice: 1500 })], source: "groww" },
    scoredHoldings: [],
    history,
  });
  assert("backdated flag set when older than latest", snap.backdated === true, snap.backdated);
}

// ──────────────────── deriveOpenRecs ────────────────────

console.log("\nderiveOpenRecs\n");

{
  const events = [
    issuedEvent({ recId: "R1", symbol: "TCS", action: "Reduction-50%", asOfDateIso: "2026-04-01", factors: ["weight_15_to_20"], qtyAtIssue: 100 }),
    issuedEvent({ recId: "R2", symbol: "ITC", action: "Reduction-25%", asOfDateIso: "2026-04-01", factors: ["weight_15_to_20"], qtyAtIssue: 50 }),
    { type: "EXECUTED", recId: "R1", at: "2026-05-01T00:00:00Z", ratio: 1.0, qtyDelta: -50, sourceSnapshot: "2026-05-01" },
  ];
  const open = deriveOpenRecs(events);
  assert("R1 closed (EXECUTED) → not open", !open.has("R1"), [...open.keys()]);
  assert("R2 still open", open.has("R2"), [...open.keys()]);
  assert("open rec has issuedEvent", open.get("R2").issuedEvent.symbol === "ITC", open.get("R2"));
  assert("open rec state PENDING", open.get("R2").state === "PENDING", open.get("R2").state);
}

{
  const events = [
    issuedEvent({ recId: "R-PARTIAL", symbol: "INFY", action: "Reduction-50%", asOfDateIso: "2026-04-01", factors: ["weight_15_to_20"], qtyAtIssue: 100 }),
    { type: "EXECUTED_PARTIAL", recId: "R-PARTIAL", at: "2026-05-01T00:00:00Z", ratio: 0.4, qtyDelta: -20, remainingPct: 0.30, sourceSnapshot: "2026-05-01" },
  ];
  const open = deriveOpenRecs(events);
  assert("EXECUTED_PARTIAL still open", open.has("R-PARTIAL"), [...open.keys()]);
  assert("EXECUTED_PARTIAL state preserved", open.get("R-PARTIAL").state === "EXECUTED_PARTIAL", open.get("R-PARTIAL").state);
}

// ──────────────────── detectCorporateActions ────────────────────

console.log("\ndetectCorporateActions\n");

{
  const prev = new Map();
  const next = new Map();
  // 1:1 bonus: qty doubles, avg halves
  prev.set("IN-TCS", { quantity: 100, avgPrice: 1500 });
  next.set("IN-TCS", { quantity: 200, avgPrice: 750 });
  // Genuine top-up: qty + 20%, avg slightly up (new buys at higher price)
  prev.set("IN-ITC", { quantity: 50, avgPrice: 350 });
  next.set("IN-ITC", { quantity: 60, avgPrice: 360 });
  // Stock split 1:5: qty 5x, avg 5x cheaper
  prev.set("IN-RELIANCE", { quantity: 10, avgPrice: 2500 });
  next.set("IN-RELIANCE", { quantity: 50, avgPrice: 500 });
  const flagged = detectCorporateActions(prev, next);
  assert("1:1 bonus flagged", flagged.has("IN-TCS"), [...flagged]);
  assert("genuine top-up NOT flagged", !flagged.has("IN-ITC"), [...flagged]);
  assert("1:5 split flagged", flagged.has("IN-RELIANCE"), [...flagged]);
}

// ──────────────────── reconcileRecommendations ────────────────────

console.log("\nreconcileRecommendations — execution detection\n");

const NOW = new Date("2026-05-08T12:00:00.000Z");

function buildScenario({
  prevHoldings, prevFacets, newHoldings, newFacets, openRec,
  newAsOfDateIso = "2026-05-08", prevAsOfDateIso = "2026-04-15",
}) {
  const prevSnap = buildLocalSnapshot({ asOfDateIso: prevAsOfDateIso, holdings: prevHoldings, facets: prevFacets });
  const newSnap = buildLocalSnapshot({ asOfDateIso: newAsOfDateIso, holdings: newHoldings, facets: newFacets });
  const openRecs = new Map();
  if (openRec) openRecs.set(openRec.recId, { recId: openRec.recId, state: "PENDING", issuedEvent: openRec, lastEvent: openRec, history: [openRec] });
  return { prevSnap, newSnap, openRecs };
}

{
  // Reduction-25% recommended on qty 100; user trimmed to 75 (-25%) → ratio 1.0 → EXECUTED
  const issued = issuedEvent({ recId: "R-EXEC", symbol: "TCS", action: "Reduction-25%", asOfDateIso: "2026-04-15", factors: ["weight_15_to_20"], qtyAtIssue: 100 });
  const sc = buildScenario({
    prevHoldings: [holding({ symbol: "TCS", qty: 100, avgPrice: 1500 })],
    prevFacets: [facet({ symbol: "TCS", action: "Reduction-25%", factors: ["weight_15_to_20"], score: 50, weight: 18 })],
    newHoldings: [holding({ symbol: "TCS", qty: 75, avgPrice: 1500 })],
    newFacets: [facet({ symbol: "TCS", action: "Reduction-25%", factors: ["weight_15_to_20"], score: 52, weight: 14 })],
    openRec: issued,
  });
  const { events } = reconcileRecommendations({ ...sc, historySnapshots: [sc.prevSnap], now: NOW });
  const exec = events.find((e) => e.type === "EXECUTED");
  assert("ratio≈1.0 → EXECUTED emitted", !!exec, events);
  assert("EXECUTED carries qtyDelta", exec?.qtyDelta === -25, exec?.qtyDelta);
}

{
  // Reduction-50% recommended on qty 100; user trimmed only 20 (20% of position) → ratio 0.4 → EXECUTED_PARTIAL
  const issued = issuedEvent({ recId: "R-PART", symbol: "INFY", action: "Reduction-50%", asOfDateIso: "2026-04-15", factors: ["weight_15_to_20"], qtyAtIssue: 100 });
  const sc = buildScenario({
    prevHoldings: [holding({ symbol: "INFY", qty: 100, avgPrice: 1300 })],
    prevFacets: [facet({ symbol: "INFY", action: "Reduction-50%", factors: ["weight_15_to_20"], score: 35 })],
    newHoldings: [holding({ symbol: "INFY", qty: 80, avgPrice: 1300 })],
    newFacets: [facet({ symbol: "INFY", action: "Reduction-33%", factors: ["weight_15_to_20"], score: 36 })],
    openRec: issued,
  });
  const { events } = reconcileRecommendations({ ...sc, historySnapshots: [sc.prevSnap], now: NOW });
  const partial = events.find((e) => e.type === "EXECUTED_PARTIAL");
  assert("ratio 0.4 → EXECUTED_PARTIAL", !!partial, events);
  assert("partial carries remainingPct ≈ 0.30",
    partial && Math.abs(partial.remainingPct - 0.30) < 0.01, partial?.remainingPct);
}

{
  // Reduction-25% recommended; user trimmed only 5% of position → ratio 0.2 → EXECUTED_PARTIAL (boundary)
  const issued = issuedEvent({ recId: "R-NIL", symbol: "WIPRO", action: "Reduction-25%", asOfDateIso: "2026-04-15", factors: ["weight_15_to_20"], qtyAtIssue: 100 });
  const sc = buildScenario({
    prevHoldings: [holding({ symbol: "WIPRO", qty: 100, avgPrice: 400 })],
    prevFacets: [facet({ symbol: "WIPRO", action: "Reduction-25%", factors: ["weight_15_to_20"], score: 45 })],
    newHoldings: [holding({ symbol: "WIPRO", qty: 95, avgPrice: 400 })],
    newFacets: [facet({ symbol: "WIPRO", action: "Reduction-25%", factors: ["weight_15_to_20"], score: 45 })],
    openRec: issued,
  });
  const { events } = reconcileRecommendations({ ...sc, historySnapshots: [sc.prevSnap], now: NOW });
  // 5/100 = 5% reduced; recommended 25%; ratio = 0.2 → EXECUTED_PARTIAL
  const partial = events.find((e) => e.type === "EXECUTED_PARTIAL");
  assert("ratio 0.2 lands EXECUTED_PARTIAL", !!partial, events);
}

{
  // Reduction-25% recommended; user trimmed only 2% → ratio 0.08 → no event (still PENDING)
  const issued = issuedEvent({ recId: "R-IGN", symbol: "NTPC", action: "Reduction-25%", asOfDateIso: "2026-04-15", factors: ["weight_15_to_20"], qtyAtIssue: 100 });
  const sc = buildScenario({
    prevHoldings: [holding({ symbol: "NTPC", qty: 100, avgPrice: 250 })],
    prevFacets: [facet({ symbol: "NTPC", action: "Reduction-25%", factors: ["weight_15_to_20"], score: 45, weight: 16 })],
    newHoldings: [holding({ symbol: "NTPC", qty: 98, avgPrice: 250 })],
    newFacets: [facet({ symbol: "NTPC", action: "Reduction-25%", factors: ["weight_15_to_20"], score: 45, weight: 15 })],
    openRec: issued,
  });
  const { events } = reconcileRecommendations({ ...sc, historySnapshots: [sc.prevSnap], now: NOW });
  const noExec = !events.some((e) => e.type === "EXECUTED" || e.type === "EXECUTED_PARTIAL" || e.type === "EXECUTED_OVER");
  assert("ratio < 0.2 → no execution event (rec stays PENDING)", noExec, events.map((e) => e.type));
}

{
  // Reduction-25% recommended; user nuked 80% of position → ratio 3.2 → EXECUTED_OVER
  const issued = issuedEvent({ recId: "R-OVER", symbol: "BPCL", action: "Reduction-25%", asOfDateIso: "2026-04-15", factors: ["weight_15_to_20"], qtyAtIssue: 100 });
  const sc = buildScenario({
    prevHoldings: [holding({ symbol: "BPCL", qty: 100, avgPrice: 350 })],
    prevFacets: [facet({ symbol: "BPCL", action: "Reduction-25%", factors: ["weight_15_to_20"], score: 45 })],
    newHoldings: [holding({ symbol: "BPCL", qty: 20, avgPrice: 350 })],
    newFacets: [facet({ symbol: "BPCL", action: "HOLD", factors: ["no_triggers"], score: 60, weight: 4 })],
    openRec: issued,
  });
  const { events } = reconcileRecommendations({ ...sc, historySnapshots: [sc.prevSnap], now: NOW });
  const over = events.find((e) => e.type === "EXECUTED_OVER");
  assert("ratio > 1.5 → EXECUTED_OVER", !!over, events);
}

{
  // Position fully exited
  const issued = issuedEvent({ recId: "R-EXIT", symbol: "ZEEL", action: "EXIT-now", asOfDateIso: "2026-04-15", factors: ["v3_below_8"], qtyAtIssue: 50 });
  const sc = buildScenario({
    prevHoldings: [holding({ symbol: "ZEEL", qty: 50, avgPrice: 200 })],
    prevFacets: [facet({ symbol: "ZEEL", action: "EXIT-now", factors: ["v3_below_8"], score: 5 })],
    newHoldings: [],
    newFacets: [],
    openRec: issued,
  });
  const { events } = reconcileRecommendations({ ...sc, historySnapshots: [sc.prevSnap], now: NOW });
  const exec = events.find((e) => e.type === "EXECUTED");
  assert("full exit → EXECUTED on EXIT-now rec", !!exec, events);
}

console.log("\nreconcileRecommendations — natural resolves\n");

{
  // Condition cleared: was "weight_15_to_20" trim; new facet has no such factor
  const issued = issuedEvent({ recId: "R-NAT", symbol: "ICICI", action: "Reduction-25%", asOfDateIso: "2026-04-15", factors: ["weight_15_to_20"], qtyAtIssue: 100, scoreAtIssue: 50 });
  const sc = buildScenario({
    prevHoldings: [holding({ symbol: "ICICI", qty: 100, avgPrice: 1100 })],
    prevFacets: [facet({ symbol: "ICICI", action: "Reduction-25%", factors: ["weight_15_to_20"], score: 50 })],
    newHoldings: [holding({ symbol: "ICICI", qty: 100, avgPrice: 1100 })],
    newFacets: [facet({ symbol: "ICICI", action: "HOLD", factors: ["no_triggers"], score: 52, weight: 8 })],
    openRec: issued,
  });
  const { events } = reconcileRecommendations({ ...sc, historySnapshots: [sc.prevSnap], now: NOW });
  const natural = events.find((e) => e.type === "RESOLVED_NATURAL");
  assert("condition cleared → RESOLVED_NATURAL", !!natural, events);
}

{
  // Thesis inversion: sell rec issued at score 35; new score 65 → +30 ≥ 25 → RESOLVED_THESIS_INVERTED
  const issued = issuedEvent({ recId: "R-INV", symbol: "HDFC", action: "Reduction-25%", asOfDateIso: "2026-04-15", factors: ["combined_score_low"], qtyAtIssue: 100, scoreAtIssue: 35 });
  const sc = buildScenario({
    prevHoldings: [holding({ symbol: "HDFC", qty: 100, avgPrice: 1500 })],
    prevFacets: [facet({ symbol: "HDFC", action: "Reduction-25%", factors: ["combined_score_low"], score: 35 })],
    newHoldings: [holding({ symbol: "HDFC", qty: 100, avgPrice: 1500 })],
    newFacets: [facet({ symbol: "HDFC", action: "HOLD", factors: ["combined_score_high"], score: 65 })],
    openRec: issued,
  });
  const { events } = reconcileRecommendations({ ...sc, historySnapshots: [sc.prevSnap], now: NOW });
  const inv = events.find((e) => e.type === "RESOLVED_THESIS_INVERTED");
  assert("score swing ≥25 → RESOLVED_THESIS_INVERTED", !!inv, events);
  assert("scoreDelta is +30", inv?.scoreDelta === 30, inv?.scoreDelta);
}

{
  // RESOLVED_NO_DATA — 3 consecutive snapshots with swsCovered=false
  const issued = issuedEvent({ recId: "R-NODATA", symbol: "OBSCURE", action: "Reduction-25%", asOfDateIso: "2026-02-15", factors: ["weight_15_to_20"], qtyAtIssue: 50, scoreAtIssue: 50 });
  const noDataFacet = facet({ symbol: "OBSCURE", action: "NO_DATA", factors: [], score: null, swsCovered: false });
  const prevSnap = buildLocalSnapshot({
    asOfDateIso: "2026-04-15",
    holdings: [holding({ symbol: "OBSCURE", qty: 50, avgPrice: 100 })],
    facets: [noDataFacet],
  });
  const olderSnap = buildLocalSnapshot({
    asOfDateIso: "2026-03-15",
    holdings: [holding({ symbol: "OBSCURE", qty: 50, avgPrice: 100 })],
    facets: [noDataFacet],
  });
  const newSnap = buildLocalSnapshot({
    asOfDateIso: "2026-05-08",
    holdings: [holding({ symbol: "OBSCURE", qty: 50, avgPrice: 100 })],
    facets: [noDataFacet],
  });
  const openRecs = new Map([[issued.recId, { recId: issued.recId, state: "PENDING", issuedEvent: issued, lastEvent: issued, history: [issued] }]]);
  const { events } = reconcileRecommendations({
    prevSnap, newSnap, openRecs,
    historySnapshots: [prevSnap, olderSnap], now: NOW,
  });
  const nd = events.find((e) => e.type === "RESOLVED_NO_DATA");
  assert("3 consecutive no-data → RESOLVED_NO_DATA", !!nd, events);
  assert("consecutiveNoDataCount ≥ 3", nd && nd.consecutiveNoDataCount >= 3, nd?.consecutiveNoDataCount);
}

{
  // Idempotency: same content, same date → no events
  const issued = issuedEvent({ recId: "R-IDEMP", symbol: "X", action: "Reduction-25%", asOfDateIso: "2026-04-15", factors: ["weight_15_to_20"], qtyAtIssue: 100 });
  const holdings = [holding({ symbol: "X", qty: 100, avgPrice: 100 })];
  const facets = [facet({ symbol: "X", action: "Reduction-25%", factors: ["weight_15_to_20"], score: 45 })];
  const a = buildLocalSnapshot({ asOfDateIso: "2026-05-08", holdings, facets });
  const b = buildLocalSnapshot({ asOfDateIso: "2026-05-08", holdings, facets, contentHash: a.contentHash });
  const openRecs = new Map([[issued.recId, { recId: issued.recId, state: "PENDING", issuedEvent: issued, lastEvent: issued, history: [issued] }]]);
  const { events } = reconcileRecommendations({ prevSnap: a, newSnap: b, openRecs, historySnapshots: [a], now: NOW });
  assert("idempotent reconcile (same hash, same date)", events.length === 0, events.map((e) => e.type));
}

console.log("\nreconcileRecommendations — corporate-action skip\n");

{
  // Bonus issue: qty 100→200, avg 1500→750. Open Reduction-25% rec must NOT
  // be flagged executed by the qty doubling.
  const issued = issuedEvent({ recId: "R-BONUS", symbol: "BONUSCO", action: "Reduction-25%", asOfDateIso: "2026-04-15", factors: ["weight_15_to_20"], qtyAtIssue: 100 });
  const sc = buildScenario({
    prevHoldings: [holding({ symbol: "BONUSCO", qty: 100, avgPrice: 1500 })],
    prevFacets: [facet({ symbol: "BONUSCO", action: "Reduction-25%", factors: ["weight_15_to_20"], score: 45 })],
    newHoldings: [holding({ symbol: "BONUSCO", qty: 200, avgPrice: 750 })],
    newFacets: [facet({ symbol: "BONUSCO", action: "Reduction-25%", factors: ["weight_15_to_20"], score: 45 })],
    openRec: issued,
  });
  const { events } = reconcileRecommendations({ ...sc, historySnapshots: [sc.prevSnap], now: NOW });
  const noExec = !events.some((e) => e.type === "EXECUTED" || e.type === "EXECUTED_PARTIAL");
  assert("bonus issue not classified as execution", noExec, events.map((e) => e.type));
}

// ──────────────────── buildIssuedEvents — suppression ────────────────────

console.log("\nbuildIssuedEvents — suppression rules\n");

{
  // Same factor signature, same direction → suppressed
  const openIssued = issuedEvent({ recId: "R-OLD", symbol: "TCS", action: "Reduction-25%", asOfDateIso: "2026-04-15", factors: ["weight_15_to_20"], qtyAtIssue: 100 });
  const openRecs = new Map([["R-OLD", { recId: "R-OLD", state: "PENDING", issuedEvent: openIssued, lastEvent: openIssued, history: [openIssued] }]]);
  const candidate = {
    symbol: "TCS",
    isin: "IN-TCS",
    action: "Reduction-25%",
    factors: ["weight_15_to_20"],
    quantity: 100,
    positionWeight: 18,
    combinedScore: 50,
  };
  const { events, suppressedCandidateRecIds } = buildIssuedEvents({
    scoredHoldings: [candidate],
    newSnap: { asOfDateIso: "2026-05-08" },
    openRecsAfterReconcile: openRecs,
    now: NOW,
  });
  assert("identical signature → no ISSUED emitted", !events.some((e) => e.type === "ISSUED"), events.map((e) => e.type));
  assert("suppressedCandidateRecIds populated", suppressedCandidateRecIds.size === 1, [...suppressedCandidateRecIds]);
}

{
  // Stronger candidate → SUPERSEDED on old + ISSUED for new
  const openIssued = issuedEvent({ recId: "R-OLD2", symbol: "TCS", action: "Reduction-25%", asOfDateIso: "2026-04-15", factors: ["weight_15_to_20"], qtyAtIssue: 100 });
  const openRecs = new Map([["R-OLD2", { recId: "R-OLD2", state: "PENDING", issuedEvent: openIssued, lastEvent: openIssued, history: [openIssued] }]]);
  const candidate = {
    symbol: "TCS",
    isin: "IN-TCS",
    action: "EXIT-now",
    factors: ["v3_below_8"],
    quantity: 100,
    positionWeight: 18,
    combinedScore: 5,
  };
  const { events, supersedeMap } = buildIssuedEvents({
    scoredHoldings: [candidate],
    newSnap: { asOfDateIso: "2026-05-08" },
    openRecsAfterReconcile: openRecs,
    now: NOW,
  });
  assert("stronger candidate emits ISSUED", events.some((e) => e.type === "ISSUED" && e.action === "EXIT-now"),
    events.map((e) => `${e.type}/${e.action || ""}`));
  assert("old rec SUPERSEDED",
    events.some((e) => e.type === "SUPERSEDED" && e.recId === "R-OLD2"),
    events.map((e) => `${e.type}/${e.recId || ""}`));
  assert("supersedeMap captures swap", supersedeMap.has("R-OLD2"), [...supersedeMap.entries()]);
}

{
  // Weaker candidate → suppressed (don't downgrade)
  const openIssued = issuedEvent({ recId: "R-STRONG", symbol: "TCS", action: "EXIT-now", asOfDateIso: "2026-04-15", factors: ["v3_below_8"], qtyAtIssue: 100 });
  const openRecs = new Map([["R-STRONG", { recId: "R-STRONG", state: "PENDING", issuedEvent: openIssued, lastEvent: openIssued, history: [openIssued] }]]);
  const candidate = {
    symbol: "TCS",
    isin: "IN-TCS",
    action: "Reduction-25%",
    factors: ["weight_15_to_20"],
    quantity: 100,
    positionWeight: 18,
    combinedScore: 50,
  };
  const { events } = buildIssuedEvents({
    scoredHoldings: [candidate],
    newSnap: { asOfDateIso: "2026-05-08" },
    openRecsAfterReconcile: openRecs,
    now: NOW,
  });
  assert("weaker candidate does NOT supersede stronger open rec",
    !events.some((e) => e.type === "ISSUED"), events.map((e) => `${e.type}/${e.action || ""}`));
}

{
  // Direction flip (sell → topup, on the same symbol — implausible but must not crash)
  const openIssued = issuedEvent({ recId: "R-FLIP", symbol: "TCS", action: "Reduction-25%", asOfDateIso: "2026-04-15", factors: ["weight_15_to_20"], qtyAtIssue: 100 });
  const openRecs = new Map([["R-FLIP", { recId: "R-FLIP", state: "PENDING", issuedEvent: openIssued, lastEvent: openIssued, history: [openIssued] }]]);
  const candidate = {
    symbol: "TCS",
    isin: "IN-TCS",
    action: "Top-up-25%",
    factors: ["verdict_deep_value"],
    quantity: 100,
    positionWeight: 4,
    combinedScore: 75,
  };
  const { events } = buildIssuedEvents({
    scoredHoldings: [candidate],
    newSnap: { asOfDateIso: "2026-05-08" },
    openRecsAfterReconcile: openRecs,
    now: NOW,
  });
  const sup = events.find((e) => e.type === "SUPERSEDED" && e.recId === "R-FLIP");
  assert("direction flip → SUPERSEDED with thesis_flip reason", sup && sup.reason === "thesis_flip", sup);
  assert("new ISSUED emitted for flipped action", events.some((e) => e.type === "ISSUED" && e.action === "Top-up-25%"),
    events.map((e) => `${e.type}/${e.action || ""}`));
}

// ──────────────────── computeFreedCapital ────────────────────

console.log("\ncomputeFreedCapital\n");

{
  const acks = [
    { type: "EXECUTED", action: "Reduction-25%", rupeesFreed: 60000 },
    { type: "EXECUTED_PARTIAL", action: "Reduction-50%", rupeesFreed: 5000 },
    { type: "EXECUTED", action: "Top-up-25%", rupeesFreed: 0 },
  ];
  const fc = computeFreedCapital(acks);
  assert("totalRupeesFreed sums sells only", fc.totalRupeesFreed === 65000, fc.totalRupeesFreed);
  assert("largestSingle reflects max sell", fc.largestSingle === 60000, fc.largestSingle);
  assert("count reflects sell-side acks", fc.count === 2, fc.count);
  assert("significant=true (≥10k or single≥50k)", fc.significant === true, fc.significant);
}

{
  const acks = [{ type: "EXECUTED", action: "Reduction-25%", rupeesFreed: 5000 }];
  const fc = computeFreedCapital(acks);
  assert("below thresholds → significant=false", fc.significant === false, fc);
}

// ──────────────────── applyMemoryToReport ────────────────────

console.log("\napplyMemoryToReport\n");

{
  const report = { holdings: [] };
  applyMemoryToReport(report, {
    newSnap: { asOfDateIso: "2026-04-22" },
    prevSnap: null,
    openRecsBeforeReconcile: new Map(),
    reconcileEvents: [],
    issuedEvents: [],
    suppressedCandidateRecIds: new Set(),
    supersedeMap: new Map(),
    isBackdated: true,
    historySnapshots: [{ asOfDateIso: "2026-05-08" }],
  });
  assert("backdated branch flags report", report.backdated === true, report);
  assert("backdated carries asOf labels",
    report.backdatedAsOf === "2026-04-22" && report.latestKnownAsOf === "2026-05-08", report);
}

{
  const issued = issuedEvent({ recId: "R-PENDING", symbol: "TCS", action: "Reduction-25%", asOfDateIso: "2026-04-01", factors: ["weight_15_to_20"], qtyAtIssue: 100 });
  const openRecs = new Map([["R-PENDING", { recId: "R-PENDING", state: "PENDING", issuedEvent: issued, lastEvent: issued, history: [issued] }]]);
  const report = { holdings: [] };
  applyMemoryToReport(report, {
    newSnap: { asOfDateIso: "2026-05-08", facets: [] },
    prevSnap: { asOfDateIso: "2026-04-15", facets: [] },
    openRecsBeforeReconcile: openRecs,
    reconcileEvents: [],
    issuedEvents: [],
    suppressedCandidateRecIds: new Set(),
    supersedeMap: new Map(),
    isBackdated: false,
    historySnapshots: [{ asOfDateIso: "2026-04-15" }],
  });
  assert("recRegistry populated for open rec", !!report.recRegistry["IN-TCS"], report.recRegistry);
  assert("recRegistry entry isPending=true", report.recRegistry["IN-TCS"].isPending === true, report.recRegistry);
  assert("memoryStatus carries open rec count", report.memoryStatus.openRecCount === 1, report.memoryStatus);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
