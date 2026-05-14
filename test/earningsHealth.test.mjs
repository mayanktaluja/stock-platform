// PR 8 — services/earnings/earningsHealth.js unit tests.
//
// Covers the pure health aggregator: deduped resolved count, LLM
// provider split, archive-schema distribution, restatement detection,
// the cap-lift-gate days-in-state counter, and the alert rules.

import assert from "node:assert/strict";
import { buildHealthSummary, formatHealthOneLiner } from "../services/earnings/earningsHealth.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

const NOW = "2026-05-15T00:00:00Z";

// A history fixture: two files, one resolved event duplicated across both.
const HISTORY = [
  {
    filename: "2026-05-09.json", today_iso: "2026-05-09", schema_version: "earnings-history-v4",
    predictions: [
      { symbol: "A", event_iso_date: "2026-05-08", actual_verdict: "BEAT" },
      { symbol: "B", event_iso_date: "2026-05-08", actual_verdict: null },
    ],
  },
  {
    filename: "2026-05-14.json", today_iso: "2026-05-14", schema_version: "earnings-history-v4",
    predictions: [
      { symbol: "A", event_iso_date: "2026-05-08", actual_verdict: "BEAT" }, // dup of above
      { symbol: "C", event_iso_date: "2026-05-13", actual_verdict: "MISS", actual_history: [{ prev_verdict: "BEAT" }] },
    ],
  },
];

const WATCH_EVENTS = [
  { prediction: { predictor_version: "earnings-predict-v2-2026-05" }, signals: { llm_signal: { classifier_provider: "heuristic" } } },
  { prediction: { predictor_version: "earnings-predict-v2-2026-05" }, signals: { llm_signal: { classifier_provider: "groq" } } },
  { prediction: { predictor_version: "earnings-predict-v2-2026-05" }, signals: {} }, // no llm_signal
];

console.log("[1] core aggregation");
it("resolved count is deduped across snapshots", () => {
  const h = buildHealthSummary({ history: HISTORY, watchEvents: WATCH_EVENTS, nowIso: NOW });
  // A (resolved, appears twice → counted once) + C (resolved) = 2; B unresolved.
  assert.equal(h.resolved.count, 2);
});
it("LLM provider split tallies classifier_provider", () => {
  const h = buildHealthSummary({ history: HISTORY, watchEvents: WATCH_EVENTS, nowIso: NOW });
  assert.equal(h.llm_providers.heuristic, 1);
  assert.equal(h.llm_providers.groq, 1);
  assert.equal(h.llm_providers.none, 1);
  assert.equal(h.llm_providers.total, 3);
});
it("archive-schema distribution counts files per version", () => {
  const h = buildHealthSummary({ history: HISTORY, watchEvents: WATCH_EVENTS, nowIso: NOW });
  assert.equal(h.archive_schema["earnings-history-v4"], 2);
});
it("restatements detected from actual_history", () => {
  const h = buildHealthSummary({ history: HISTORY, watchEvents: WATCH_EVENTS, nowIso: NOW });
  assert.equal(h.restatements.count, 1);
  assert.deepEqual(h.restatements.symbols, ["C|2026-05-13"]);
});

console.log("[2] cap-lift gate days-in-state");
it("days_in_current_state starts at 1 with no prior", () => {
  const h = buildHealthSummary({ history: HISTORY, backtestSnapshot: { enough_data_to_lift_cap: false }, nowIso: NOW });
  assert.equal(h.cap_lift_gate.state, false);
  assert.equal(h.cap_lift_gate.days_in_current_state, 1);
});
it("days_in_current_state increments when the gate state holds", () => {
  const prior = { cap_lift_gate: { state: false, days_in_current_state: 4 } };
  const h = buildHealthSummary({ history: HISTORY, backtestSnapshot: { enough_data_to_lift_cap: false }, priorHealth: prior, nowIso: NOW });
  assert.equal(h.cap_lift_gate.days_in_current_state, 5);
});
it("days_in_current_state resets when the gate state flips", () => {
  const prior = { cap_lift_gate: { state: false, days_in_current_state: 9 } };
  const h = buildHealthSummary({ history: HISTORY, backtestSnapshot: { enough_data_to_lift_cap: true }, priorHealth: prior, nowIso: NOW });
  assert.equal(h.cap_lift_gate.state, true);
  assert.equal(h.cap_lift_gate.days_in_current_state, 1);
});

console.log("[3] resolved delta vs prior");
it("delta_vs_prior is the change since the last run", () => {
  const prior = { resolved: { count: 1 } };
  const h = buildHealthSummary({ history: HISTORY, priorHealth: prior, nowIso: NOW });
  assert.equal(h.resolved.delta_vs_prior, 1); // 2 now − 1 prior
});
it("delta_vs_prior is null on the first ever run", () => {
  const h = buildHealthSummary({ history: HISTORY, nowIso: NOW });
  assert.equal(h.resolved.delta_vs_prior, null);
});

console.log("[4] alerts");
it("mixed archive schema raises an alert", () => {
  const mixed = [
    { schema_version: "earnings-history-v2", predictions: [] },
    { schema_version: "earnings-history-v4", predictions: [] },
  ];
  const h = buildHealthSummary({ history: mixed, watchEvents: WATCH_EVENTS, nowIso: NOW });
  assert.ok(h.alerts.some((a) => /mixed schema/i.test(a)), JSON.stringify(h.alerts));
  assert.equal(h.healthy, false);
});
it("100%-heuristic LLM raises an alert", () => {
  const allHeur = [
    { signals: { llm_signal: { classifier_provider: "heuristic" } } },
    { signals: { llm_signal: { classifier_provider: "heuristic" } } },
  ];
  const h = buildHealthSummary({ history: HISTORY, watchEvents: allHeur, nowIso: NOW });
  assert.ok(h.alerts.some((a) => /100% heuristic/i.test(a)), JSON.stringify(h.alerts));
});
it("a restatement raises an alert", () => {
  const h = buildHealthSummary({ history: HISTORY, watchEvents: WATCH_EVENTS, nowIso: NOW });
  assert.ok(h.alerts.some((a) => /restated actual/i.test(a)), JSON.stringify(h.alerts));
});
it("a FLAT resolved count is NOT an alert (quiet days are normal)", () => {
  const prior = { resolved: { count: 2 } }; // HISTORY resolves to 2
  const h = buildHealthSummary({ history: HISTORY, watchEvents: WATCH_EVENTS, priorHealth: prior, nowIso: NOW });
  assert.ok(!h.alerts.some((a) => /flat|unchanged/i.test(a)), JSON.stringify(h.alerts));
});
it("a resolved count going DOWN raises an alert", () => {
  const prior = { resolved: { count: 9 } }; // more than HISTORY's 2 → dropped
  const h = buildHealthSummary({ history: HISTORY, watchEvents: WATCH_EVENTS, priorHealth: prior, nowIso: NOW });
  assert.ok(h.alerts.some((a) => /dropped/i.test(a)), JSON.stringify(h.alerts));
});
it("gate-just-cleared raises an alert", () => {
  const prior = { cap_lift_gate: { state: false, days_in_current_state: 3 } };
  const h = buildHealthSummary({ history: HISTORY, backtestSnapshot: { enough_data_to_lift_cap: true }, priorHealth: prior, watchEvents: WATCH_EVENTS, nowIso: NOW });
  assert.ok(h.alerts.some((a) => /just CLEARED/i.test(a)), JSON.stringify(h.alerts));
});
it("a clean pipeline has no alerts and healthy:true", () => {
  // Single schema, a real LLM provider present, no restatements, no prior.
  const clean = [
    { schema_version: "earnings-history-v4", predictions: [{ symbol: "A", event_iso_date: "2026-05-08", actual_verdict: "BEAT" }] },
  ];
  const cleanWatch = [
    { prediction: { predictor_version: "earnings-predict-v2-2026-05" }, signals: { llm_signal: { classifier_provider: "groq" } } },
  ];
  const h = buildHealthSummary({ history: clean, watchEvents: cleanWatch, backtestSnapshot: { enough_data_to_lift_cap: false }, nowIso: NOW });
  assert.deepEqual(h.alerts, []);
  assert.equal(h.healthy, true);
});

console.log("[5] formatHealthOneLiner");
it("produces a scannable one-line summary", () => {
  const h = buildHealthSummary({ history: HISTORY, watchEvents: WATCH_EVENTS, backtestSnapshot: { enough_data_to_lift_cap: false }, nowIso: NOW });
  const line = formatHealthOneLiner(h);
  assert.match(line, /Earnings health/);
  assert.match(line, /resolved 2/);
  assert.match(line, /cap-gate not-met/);
});

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
if (fail) process.exit(1);
