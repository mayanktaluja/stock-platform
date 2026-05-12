/**
 * Tests for the post-execution cooldown gate in services/recommendationMemory.js.
 *
 * Covers:
 *   • detectMaterialChange — pure function
 *   • applyCooldownGate    — pure function
 *   • indexClosedExecutedEvents — ordering / direction-keying
 *   • buildIssuedEvents end-to-end — the exact user scenario
 *     (Reduction-25% on May 11 → executed May 12 → re-evaluated May 13)
 *
 * Run with: node test/cooldownGate.test.mjs
 */

import {
  detectMaterialChange,
  applyCooldownGate,
  indexClosedExecutedEvents,
  buildIssuedEvents,
  computeRecId,
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

// The gate is enabled by default; force it on for determinism in this test file.
process.env.SWS_COOLDOWN_GATE = "1";

// ──────────────────── Helpers ────────────────────

function scoredHolding({
  symbol, isin, action, factors = ["weight_15_to_20"],
  v3 = 50, severity = 0.18, weight = 1, conviction = "MEDIUM",
  surveillance = null, pnl = 0, qty = 100,
}) {
  return {
    symbol,
    isin: isin || `IN-${symbol}`,
    action,
    factors,
    combinedScore: v3,
    score: v3,
    severity,
    positionWeight: weight,
    pnlPercent: pnl,
    conviction,
    surveillance,
    quantity: qty,
    swsCovered: true,
    livePrice: 100,
    fundamentalVerdict: null,
  };
}

function executedEvent({
  recId, action, atIso, sourceSnapshot,
  severity = 0.18, score = 50, conviction = "MEDIUM", surveillance = null,
  factors = ["weight_15_to_20"], ratio = 1.0, qtyDelta = -25,
  type = "EXECUTED",
}) {
  return {
    type,
    recId,
    at: atIso,
    ratio,
    qtyDelta,
    sourceSnapshot,
    actionAtExecution: action,
    severityAtExecution: severity,
    scoreAtExecution: score,
    factorsAtExecution: factors,
    convictionAtExecution: conviction,
    surveillanceAtExecution: surveillance,
  };
}

function snapshot(asOfDateIso, holdings = [], facets = []) {
  return {
    asOfDateIso,
    uploadedAtIso: `${asOfDateIso}T10:00:00.000Z`,
    contentHash: `hash-${asOfDateIso}`,
    sourceFile: null,
    sourceBroker: "groww-xlsx",
    backdated: false,
    asOfDateInferred: false,
    holdings,
    facets,
  };
}

// ──────────────────── detectMaterialChange ────────────────────

console.log("\ndetectMaterialChange — sell direction\n");

{
  // V3 unchanged, severity unchanged → no material change
  const cand = scoredHolding({ symbol: "TCS", v3: 50, severity: 0.18 });
  const exec = executedEvent({ recId: "R", action: "Reduction-25%", atIso: "2026-05-12T10:00:00Z", sourceSnapshot: "2026-05-12", score: 50, severity: 0.18 });
  const out = detectMaterialChange({ candidate: cand, executedEvent: exec, direction: "sell" });
  assert("baseline unchanged → null", out === null, out);
}

{
  // V3 dropped 7pts (≥5pt threshold) → bypass with v3_drop_*
  const cand = scoredHolding({ symbol: "TCS", v3: 43, severity: 0.20 });
  const exec = executedEvent({ recId: "R", action: "Reduction-25%", atIso: "2026-05-12T10:00:00Z", sourceSnapshot: "2026-05-12", score: 50, severity: 0.18 });
  const out = detectMaterialChange({ candidate: cand, executedEvent: exec, direction: "sell" });
  assert("V3 -7pt fires v3_drop_*", typeof out === "string" && out.startsWith("v3_drop_"), out);
}

{
  // V3 dropped only 3pts (below threshold) and severity unchanged → no bypass
  const cand = scoredHolding({ symbol: "TCS", v3: 47, severity: 0.18 });
  const exec = executedEvent({ recId: "R", action: "Reduction-25%", atIso: "2026-05-12T10:00:00Z", sourceSnapshot: "2026-05-12", score: 50, severity: 0.18 });
  const out = detectMaterialChange({ candidate: cand, executedEvent: exec, direction: "sell" });
  assert("V3 -3pt does NOT trigger bypass", out === null, out);
}

{
  // Severity floor: 0.55 always bypasses
  const cand = scoredHolding({ symbol: "TCS", v3: 50, severity: 0.55 });
  const exec = executedEvent({ recId: "R", action: "Reduction-25%", atIso: "2026-05-12T10:00:00Z", sourceSnapshot: "2026-05-12", score: 50, severity: 0.18 });
  const out = detectMaterialChange({ candidate: cand, executedEvent: exec, direction: "sell" });
  assert("severity ≥ 0.50 floor → bypass", typeof out === "string" && out.startsWith("severity_floor_"), out);
}

{
  // Severity rose by 12pp (≥10pp threshold) → bypass
  const cand = scoredHolding({ symbol: "TCS", v3: 50, severity: 0.32 });
  const exec = executedEvent({ recId: "R", action: "Reduction-25%", atIso: "2026-05-12T10:00:00Z", sourceSnapshot: "2026-05-12", score: 50, severity: 0.20 });
  const out = detectMaterialChange({ candidate: cand, executedEvent: exec, direction: "sell" });
  assert("severity +12pp fires severity_rise_*", typeof out === "string" && out.startsWith("severity_rise_"), out);
}

{
  // Severity rose by only 5pp (below threshold) → no bypass
  const cand = scoredHolding({ symbol: "TCS", v3: 50, severity: 0.25 });
  const exec = executedEvent({ recId: "R", action: "Reduction-25%", atIso: "2026-05-12T10:00:00Z", sourceSnapshot: "2026-05-12", score: 50, severity: 0.20 });
  const out = detectMaterialChange({ candidate: cand, executedEvent: exec, direction: "sell" });
  assert("severity +5pp below threshold → no bypass", out === null, out);
}

{
  // New surveillance flag where there was none → bypass
  const cand = scoredHolding({ symbol: "TCS", v3: 50, severity: 0.20, surveillance: { list: "GSM", stage: 2 } });
  const exec = executedEvent({ recId: "R", action: "Reduction-25%", atIso: "2026-05-12T10:00:00Z", sourceSnapshot: "2026-05-12", score: 50, severity: 0.18, surveillance: null });
  const out = detectMaterialChange({ candidate: cand, executedEvent: exec, direction: "sell" });
  assert("new surveillance fires new_surveillance_*", typeof out === "string" && out.startsWith("new_surveillance_"), out);
}

{
  // Surveillance stage escalation → bypass
  const cand = scoredHolding({ symbol: "TCS", v3: 50, severity: 0.20, surveillance: { list: "GSM", stage: 3 } });
  const exec = executedEvent({ recId: "R", action: "Reduction-25%", atIso: "2026-05-12T10:00:00Z", sourceSnapshot: "2026-05-12", score: 50, severity: 0.18, surveillance: { list: "GSM", stage: 1 } });
  const out = detectMaterialChange({ candidate: cand, executedEvent: exec, direction: "sell" });
  assert("surveillance stage escalation triggers bypass", typeof out === "string" && out.includes("surveillance_stage"), out);
}

console.log("\ndetectMaterialChange — topup direction\n");

{
  // V3 climbed 6pts → topup bypass
  const cand = scoredHolding({ symbol: "TCS", v3: 76, severity: 0.40 });
  const exec = executedEvent({ recId: "R", action: "Top-up-33%", atIso: "2026-05-12T10:00:00Z", sourceSnapshot: "2026-05-12", score: 70, severity: 0.40 });
  const out = detectMaterialChange({ candidate: cand, executedEvent: exec, direction: "topup" });
  assert("topup: V3 +6pt fires v3_rise_*", typeof out === "string" && out.startsWith("v3_rise_"), out);
}

{
  // V3 climbed 3pts → no bypass (below threshold)
  const cand = scoredHolding({ symbol: "TCS", v3: 73, severity: 0.40 });
  const exec = executedEvent({ recId: "R", action: "Top-up-33%", atIso: "2026-05-12T10:00:00Z", sourceSnapshot: "2026-05-12", score: 70, severity: 0.40 });
  const out = detectMaterialChange({ candidate: cand, executedEvent: exec, direction: "topup" });
  assert("topup: V3 +3pt below threshold → no bypass", out === null, out);
}

// ──────────────────── applyCooldownGate ────────────────────

console.log("\napplyCooldownGate — window logic\n");

const NOW = new Date("2026-05-13T12:00:00.000Z");

{
  // No prior executed event → not gated
  const cand = scoredHolding({ symbol: "TCS", v3: 50, severity: 0.18, action: "Reduction-25%" });
  const out = applyCooldownGate({ candidate: cand, mostRecentExecuted: null, direction: "sell", now: NOW });
  assert("no prior execution → not gated", out.gated === false, out);
}

{
  // EXECUTED 2 days ago, no material change → gated
  const cand = scoredHolding({ symbol: "ADANIGREEN", v3: 53, severity: 0.18, action: "Reduction-25%" });
  const exec = executedEvent({ recId: "R", action: "Reduction-25%", atIso: "2026-05-11T10:00:00Z", sourceSnapshot: "2026-05-11", score: 53, severity: 0.18 });
  const out = applyCooldownGate({ candidate: cand, mostRecentExecuted: exec, direction: "sell", now: NOW });
  assert("EXECUTED 2d ago, unchanged → gated", out.gated === true, out);
  assert("cooldownEntry carries executedAction",
    out.gated && out.cooldownEntry.executedAction === "Reduction-25%",
    out.cooldownEntry);
  assert("cooldownEntry carries cooldownUntil ISO",
    out.gated && typeof out.cooldownEntry.cooldownUntil === "string" && out.cooldownEntry.cooldownUntil > "2026-05-11",
    out.cooldownEntry?.cooldownUntil);
}

{
  // EXECUTED 8 days ago → past 7-day window → not gated
  const cand = scoredHolding({ symbol: "TCS", v3: 50, severity: 0.18, action: "Reduction-25%" });
  const exec = executedEvent({ recId: "R", action: "Reduction-25%", atIso: "2026-05-05T10:00:00Z", sourceSnapshot: "2026-05-05", score: 50, severity: 0.18 });
  const out = applyCooldownGate({ candidate: cand, mostRecentExecuted: exec, direction: "sell", now: NOW });
  assert("EXECUTED 8d ago → past window → not gated", out.gated === false, out);
}

{
  // EXECUTED 3 days ago, V3 dropped 7pts → bypass
  const cand = scoredHolding({ symbol: "TCS", v3: 43, severity: 0.20, action: "Reduction-25%" });
  const exec = executedEvent({ recId: "R", action: "Reduction-25%", atIso: "2026-05-10T10:00:00Z", sourceSnapshot: "2026-05-10", score: 50, severity: 0.18 });
  const out = applyCooldownGate({ candidate: cand, mostRecentExecuted: exec, direction: "sell", now: NOW });
  assert("EXECUTED 3d ago, V3 -7pt → bypass (not gated)", out.gated === false, out);
  assert("bypass carries reason", typeof out.bypassReason === "string" && out.bypassReason.startsWith("v3_drop_"), out);
}

{
  // Reduction-50% triggers 14-day window
  const cand = scoredHolding({ symbol: "TCS", v3: 35, severity: 0.40, action: "Reduction-25%" });
  const execAt = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const exec = executedEvent({ recId: "R", action: "Reduction-50%", atIso: execAt, sourceSnapshot: execAt.slice(0,10), score: 35, severity: 0.40 });
  const out = applyCooldownGate({ candidate: cand, mostRecentExecuted: exec, direction: "sell", now: NOW });
  assert("Reduction-50% has 14d window: 10d ago still gated", out.gated === true, out);
  assert("Reduction-50% cooldownWindowDays=14",
    out.gated && out.cooldownEntry.cooldownWindowDays === 14,
    out.cooldownEntry?.cooldownWindowDays);
}

{
  // EXIT-now has window=0 → never gates
  const cand = scoredHolding({ symbol: "TCS", v3: 30, severity: 0.10, action: "Reduction-25%" });
  const exec = executedEvent({ recId: "R", action: "EXIT-now", atIso: "2026-05-12T10:00:00Z", sourceSnapshot: "2026-05-12", score: 30, severity: 0.10 });
  const out = applyCooldownGate({ candidate: cand, mostRecentExecuted: exec, direction: "sell", now: NOW });
  assert("EXIT-now never gates", out.gated === false, out);
}

{
  // Legacy event without actionAtExecution → no window → never gates
  const cand = scoredHolding({ symbol: "TCS", v3: 50, severity: 0.18, action: "Reduction-25%" });
  const exec = { type: "EXECUTED", recId: "R", at: "2026-05-12T10:00:00Z", sourceSnapshot: "2026-05-12", ratio: 1, qtyDelta: -25 };
  const out = applyCooldownGate({ candidate: cand, mostRecentExecuted: exec, direction: "sell", now: NOW });
  assert("legacy event (no actionAtExecution) → not gated", out.gated === false, out);
}

{
  // EXECUTED_PARTIAL counts as recent execution → gated
  const cand = scoredHolding({ symbol: "TCS", v3: 50, severity: 0.18, action: "Reduction-25%" });
  const exec = executedEvent({ recId: "R", type: "EXECUTED_PARTIAL", action: "Reduction-25%", atIso: "2026-05-11T10:00:00Z", sourceSnapshot: "2026-05-11", score: 50, severity: 0.18, ratio: 0.4, qtyDelta: -10 });
  const out = applyCooldownGate({ candidate: cand, mostRecentExecuted: exec, direction: "sell", now: NOW });
  assert("EXECUTED_PARTIAL triggers cooldown", out.gated === true, out);
}

// ──────────────────── indexClosedExecutedEvents ────────────────────

console.log("\nindexClosedExecutedEvents — ordering and direction-keying\n");

{
  const events = [
    executedEvent({ recId: "IN-TCS|abc|2026-04-01", action: "Reduction-25%", atIso: "2026-04-12T10:00:00Z", sourceSnapshot: "2026-04-12" }),
    executedEvent({ recId: "IN-TCS|abc|2026-05-01", action: "Reduction-33%", atIso: "2026-05-12T10:00:00Z", sourceSnapshot: "2026-05-12" }),
    executedEvent({ recId: "IN-ITC|xyz|2026-05-01", action: "Top-up-50%", atIso: "2026-05-10T10:00:00Z", sourceSnapshot: "2026-05-10" }),
  ];
  const idx = indexClosedExecutedEvents(events);
  assert("indexes by symKey|direction", idx.has("IN-TCS|sell") && idx.has("IN-ITC|topup"), [...idx.keys()]);
  const tcsBucket = idx.get("IN-TCS|sell");
  assert("most-recent TCS sell first", tcsBucket[0].actionAtExecution === "Reduction-33%", tcsBucket.map(e=>e.actionAtExecution));
  assert("ITC topup separate bucket", idx.get("IN-ITC|topup").length === 1, idx.get("IN-ITC|topup"));
}

{
  // ISSUED events are skipped — not closed-executed.
  const events = [
    { type: "ISSUED", recId: "IN-TCS|abc|2026-05-01", at: "2026-05-01T10:00:00Z" },
    { type: "RESOLVED_NATURAL", recId: "IN-TCS|abc|2026-05-01", at: "2026-05-02T10:00:00Z" },
  ];
  const idx = indexClosedExecutedEvents(events);
  assert("ISSUED + RESOLVED_NATURAL not indexed", idx.size === 0, [...idx.keys()]);
}

// ──────────────────── buildIssuedEvents integration ────────────────────

console.log("\nbuildIssuedEvents — the exact user-reported scenario\n");

{
  // Day 1 (May 11): ADANIGREEN Reduction-25% issued at qty=20, V3=53.
  // Day 2 (May 12): user sells 5 → qty=15.
  // Day 3 (May 13, NOW): rerun. Without the gate the issuer would mint a
  // brand-new Reduction-25%. With the gate, the candidate is suppressed
  // and lands in cooldownEntries instead.
  const symKey = "IN-ADANIGREEN";
  const reductionRecId = computeRecId(symKey, ["weight_15_to_20"], "2026-05-11");
  const ledgerEvents = [
    {
      type: "ISSUED",
      recId: reductionRecId,
      at: "2026-05-11T11:00:00Z",
      symbol: "ADANIGREEN",
      isin: "IN-ADANIGREEN",
      action: "Reduction-25%",
      reductionPct: 0.25,
      addPct: null,
      severity: 0.18,
      factors: ["weight_15_to_20"],
      reasoning: null,
      sourceSnapshot: "2026-05-11",
      qtyAtIssue: 20,
      weightAtIssue: 0.93,
      scoreAtIssue: 53,
      convictionAtIssue: "MEDIUM",
      surveillanceAtIssue: null,
    },
  ];
  // The current reconcile pass would emit this EXECUTED (qty dropped 20→15).
  const reconcileEvents = [
    executedEvent({
      recId: reductionRecId, action: "Reduction-25%", atIso: "2026-05-13T12:00:00.000Z",
      sourceSnapshot: "2026-05-13", score: 53, severity: 0.18, ratio: 1.0, qtyDelta: -5,
    }),
  ];
  const cand = scoredHolding({ symbol: "ADANIGREEN", isin: "IN-ADANIGREEN", action: "Reduction-25%", v3: 53, severity: 0.18, weight: 0.7, qty: 15 });
  const newSnap = snapshot("2026-05-13", [], []);
  const { events: issuedEvents, cooldownEntries } = buildIssuedEvents({
    scoredHoldings: [cand],
    newSnap,
    openRecsAfterReconcile: new Map(), // the May-11 rec just got closed by the reconciler
    ledgerEvents,
    reconcileEvents,
    now: NOW,
  });
  assert("no fresh ISSUED minted (cooldown gated)", issuedEvents.length === 0, issuedEvents);
  assert("cooldownEntries has the ADANIGREEN row",
    cooldownEntries.length === 1 && cooldownEntries[0].symbol === "ADANIGREEN",
    cooldownEntries);
  assert("cooldownEntry references the executed Reduction-25%",
    cooldownEntries[0].executedAction === "Reduction-25%",
    cooldownEntries[0]);
  assert("cooldownEntry has cooldownUntil in the future",
    cooldownEntries[0].cooldownUntil > NOW.toISOString(),
    cooldownEntries[0]?.cooldownUntil);
}

{
  // Same setup but V3 dropped from 53 → 45 (≥5pt threshold). Cooldown is
  // bypassed; the ISSUED event fires with bypassReason annotated.
  const symKey = "IN-ADANIGREEN";
  const reductionRecId = computeRecId(symKey, ["weight_15_to_20"], "2026-05-11");
  const ledgerEvents = [];
  const reconcileEvents = [
    executedEvent({
      recId: reductionRecId, action: "Reduction-25%", atIso: "2026-05-12T12:00:00Z",
      sourceSnapshot: "2026-05-12", score: 53, severity: 0.18, ratio: 1.0, qtyDelta: -5,
    }),
  ];
  const cand = scoredHolding({ symbol: "ADANIGREEN", isin: "IN-ADANIGREEN", action: "Reduction-25%", v3: 45, severity: 0.22, weight: 0.7, qty: 15 });
  const newSnap = snapshot("2026-05-13", [], []);
  const { events: issuedEvents, cooldownEntries } = buildIssuedEvents({
    scoredHoldings: [cand],
    newSnap,
    openRecsAfterReconcile: new Map(),
    ledgerEvents,
    reconcileEvents,
    now: NOW,
  });
  const fresh = issuedEvents.find((e) => e.type === "ISSUED");
  assert("V3 dropped → fresh ISSUED minted (bypass)", !!fresh, issuedEvents);
  assert("ISSUED carries bypassReason v3_drop_*",
    fresh && typeof fresh.bypassReason === "string" && fresh.bypassReason.startsWith("v3_drop_"),
    fresh?.bypassReason);
  assert("no cooldown entry recorded when bypassed",
    cooldownEntries.length === 0, cooldownEntries);
}

{
  // SWS_COOLDOWN_GATE=0 → gate disabled → behaves like the old code
  process.env.SWS_COOLDOWN_GATE = "0";
  const symKey = "IN-ADANIGREEN";
  const reductionRecId = computeRecId(symKey, ["weight_15_to_20"], "2026-05-11");
  const reconcileEvents = [
    executedEvent({
      recId: reductionRecId, action: "Reduction-25%", atIso: "2026-05-12T12:00:00Z",
      sourceSnapshot: "2026-05-12", score: 53, severity: 0.18, ratio: 1.0, qtyDelta: -5,
    }),
  ];
  const cand = scoredHolding({ symbol: "ADANIGREEN", isin: "IN-ADANIGREEN", action: "Reduction-25%", v3: 53, severity: 0.18, weight: 0.7, qty: 15 });
  const newSnap = snapshot("2026-05-13", [], []);
  const { events: issuedEvents, cooldownEntries } = buildIssuedEvents({
    scoredHoldings: [cand],
    newSnap,
    openRecsAfterReconcile: new Map(),
    ledgerEvents: [],
    reconcileEvents,
    now: NOW,
  });
  assert("gate disabled → fresh ISSUED minted as before", issuedEvents.length === 1 && issuedEvents[0].type === "ISSUED", issuedEvents);
  assert("gate disabled → no cooldown entries", cooldownEntries.length === 0, cooldownEntries);
  process.env.SWS_COOLDOWN_GATE = "1";
}

{
  // Cross-direction: a recent EXECUTED Reduction does NOT cooldown a Top-up
  const symKey = "IN-TCS";
  const trimRecId = computeRecId(symKey, ["weight_15_to_20"], "2026-05-11");
  const reconcileEvents = [
    executedEvent({
      recId: trimRecId, action: "Reduction-25%", atIso: "2026-05-12T12:00:00Z",
      sourceSnapshot: "2026-05-12", score: 53, severity: 0.18,
    }),
  ];
  const cand = scoredHolding({ symbol: "TCS", isin: "IN-TCS", action: "Top-up-50%", v3: 75, severity: 0.40 });
  const newSnap = snapshot("2026-05-13", [], []);
  const { events: issuedEvents, cooldownEntries } = buildIssuedEvents({
    scoredHoldings: [cand],
    newSnap,
    openRecsAfterReconcile: new Map(),
    ledgerEvents: [],
    reconcileEvents,
    now: NOW,
  });
  assert("cross-direction → Top-up fires despite recent Reduction", issuedEvents.length === 1, issuedEvents);
  assert("no cooldown across directions", cooldownEntries.length === 0, cooldownEntries);
}

// ──────────────────── applyMemoryToReport — cooldownPanel surface ────────────────────

console.log("\napplyMemoryToReport — cooldownPanel surface\n");

{
  const report = { holdings: [] };
  applyMemoryToReport(report, {
    newSnap: { asOfDateIso: "2026-05-13", facets: [] },
    prevSnap: { asOfDateIso: "2026-05-11", facets: [] },
    openRecsBeforeReconcile: new Map(),
    reconcileEvents: [],
    issuedEvents: [],
    suppressedCandidateRecIds: new Set(),
    supersedeMap: new Map(),
    cooldownEntries: [
      {
        symbol: "ADANIGREEN", isin: "IN-ADANIGREEN", symKey: "IN-ADANIGREEN",
        executedOn: "2026-05-12", executedAt: "2026-05-12T12:00:00Z",
        executedAction: "Reduction-25%", cooldownUntil: "2026-05-19T12:00:00Z",
        cooldownWindowDays: 7, candidateAction: "Reduction-25%",
        candidateDirection: "sell",
        severityAtExecution: 0.18, scoreAtExecution: 53,
        severityNow: 0.18, scoreNow: 53,
      },
    ],
    isBackdated: false,
    historySnapshots: [],
  });
  assert("report.cooldownPanel populated", report.cooldownPanel?.rows?.length === 1, report.cooldownPanel);
  assert("recRegistry has isCooldown flag",
    report.recRegistry["IN-ADANIGREEN"]?.isCooldown === true,
    report.recRegistry);
  assert("memoryStatus.cooldownActiveCount = 1",
    report.memoryStatus?.cooldownActiveCount === 1,
    report.memoryStatus);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
