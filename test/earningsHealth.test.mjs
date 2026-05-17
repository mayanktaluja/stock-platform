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
it("PR3: 100%-heuristic raises llm_offline=true + heuristic_share_pct=100", () => {
  const allHeur = [
    { signals: { llm_signal: { classifier_provider: "heuristic" } } },
    { signals: { llm_signal: { classifier_provider: "heuristic" } } },
  ];
  const h = buildHealthSummary({ history: HISTORY, watchEvents: allHeur, nowIso: NOW });
  assert.equal(h.llm_offline, true, JSON.stringify(h));
  assert.equal(h.llm_heuristic_share_pct, 100);
});
it("PR3: any Groq/Gemini signal flips llm_offline=false", () => {
  const mixed = [
    { signals: { llm_signal: { classifier_provider: "groq" } } },
    { signals: { llm_signal: { classifier_provider: "heuristic" } } },
  ];
  const h = buildHealthSummary({ history: HISTORY, watchEvents: mixed, nowIso: NOW });
  assert.equal(h.llm_offline, false, JSON.stringify(h));
  assert.equal(h.llm_heuristic_share_pct, 50);
});
it("PR3: empty watchEvents → llm_offline=false (no provider data ≠ offline)", () => {
  const h = buildHealthSummary({ history: HISTORY, watchEvents: [], nowIso: NOW });
  assert.equal(h.llm_offline, false);
  assert.equal(h.llm_heuristic_share_pct, 0);
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

/* ─────────────── P2.6 source-disagreement summary ───────────────── */

console.log("[6] source_conflicts block");

// Fabricate a history where 5 events resolved in the last 30d (so the
// rate denominator is non-zero) and a conflict log with rows of varied
// ages.
const RESOLVED_30D_HISTORY = [
  {
    filename: "2026-05-10.json", today_iso: "2026-05-10", schema_version: "earnings-history-v4",
    predictions: [
      { symbol: "R1", event_iso_date: "2026-05-09", actual_verdict: "BEAT", resolved_at_iso: "2026-05-10T00:00:00Z" },
      { symbol: "R2", event_iso_date: "2026-05-09", actual_verdict: "MISS", resolved_at_iso: "2026-05-10T00:00:00Z" },
      { symbol: "R3", event_iso_date: "2026-05-08", actual_verdict: "INLINE", resolved_at_iso: "2026-05-10T00:00:00Z" },
      { symbol: "R4", event_iso_date: "2026-05-07", actual_verdict: "BEAT", resolved_at_iso: "2026-05-09T00:00:00Z" },
      { symbol: "R5", event_iso_date: "2026-05-06", actual_verdict: "BEAT", resolved_at_iso: "2026-05-08T00:00:00Z" },
    ],
  },
];

it("source_conflicts counts last-30-day conflicts + computes rate_pct", () => {
  const log = [
    { symbol: "R1", event_iso_date: "2026-05-09", sws_verdict: "BEAT", yahoo_verdict: "MISS", chosen_source: "sws_news", chosen_verdict: "BEAT", logged_at: "2026-05-10T00:00:00Z" },
    { symbol: "R2", event_iso_date: "2026-05-09", sws_verdict: "MISS", yahoo_verdict: "BEAT", chosen_source: "sws_news", chosen_verdict: "MISS", logged_at: "2026-05-11T00:00:00Z" },
  ];
  const h = buildHealthSummary({ history: RESOLVED_30D_HISTORY, sourceConflictLog: log, nowIso: NOW });
  assert.ok(h.source_conflicts, "block missing");
  assert.equal(h.source_conflicts.count_total, 2);
  assert.equal(h.source_conflicts.count_30d, 2);
  // 2 / 5 resolved = 40%
  assert.equal(h.source_conflicts.rate_pct, 40);
  assert.equal(h.source_conflicts.examples.length, 2);
  // Most-recent example first.
  assert.equal(h.source_conflicts.examples[0].symbol, "R2");
});

it("source_conflicts excludes log rows older than 30d", () => {
  const log = [
    // 60d old — outside window.
    { symbol: "OLD", event_iso_date: "2026-03-10", sws_verdict: "BEAT", yahoo_verdict: "MISS", chosen_source: "sws_news", chosen_verdict: "BEAT", logged_at: "2026-03-11T00:00:00Z" },
    // Recent.
    { symbol: "NEW", event_iso_date: "2026-05-09", sws_verdict: "BEAT", yahoo_verdict: "MISS", chosen_source: "sws_news", chosen_verdict: "BEAT", logged_at: "2026-05-10T00:00:00Z" },
  ];
  const h = buildHealthSummary({ history: RESOLVED_30D_HISTORY, sourceConflictLog: log, nowIso: NOW });
  assert.equal(h.source_conflicts.count_total, 2);
  assert.equal(h.source_conflicts.count_30d, 1);
  assert.equal(h.source_conflicts.examples[0].symbol, "NEW");
});

it("source_conflicts caps examples at 5", () => {
  const log = Array.from({ length: 9 }, (_, i) => ({
    symbol: `S${i}`,
    event_iso_date: "2026-05-09",
    sws_verdict: "BEAT",
    yahoo_verdict: "MISS",
    chosen_source: "sws_news",
    chosen_verdict: "BEAT",
    logged_at: `2026-05-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
  }));
  const h = buildHealthSummary({ history: RESOLVED_30D_HISTORY, sourceConflictLog: log, nowIso: NOW });
  assert.equal(h.source_conflicts.count_30d, 9);
  assert.equal(h.source_conflicts.examples.length, 5);
});

it("source_conflicts > 5 in last 30d raises an alert", () => {
  const log = Array.from({ length: 6 }, (_, i) => ({
    symbol: `S${i}`,
    event_iso_date: "2026-05-09",
    sws_verdict: "BEAT",
    yahoo_verdict: "MISS",
    chosen_source: "sws_news",
    chosen_verdict: "BEAT",
    logged_at: `2026-05-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
  }));
  const h = buildHealthSummary({ history: RESOLVED_30D_HISTORY, sourceConflictLog: log, nowIso: NOW });
  assert.ok(h.alerts.some((a) => /source-disagreement/i.test(a)), JSON.stringify(h.alerts));
});

it("source_conflicts ≤5 → no alert", () => {
  const log = [
    { symbol: "X", event_iso_date: "2026-05-09", sws_verdict: "BEAT", yahoo_verdict: "MISS", chosen_source: "sws_news", chosen_verdict: "BEAT", logged_at: "2026-05-10T00:00:00Z" },
  ];
  const h = buildHealthSummary({ history: RESOLVED_30D_HISTORY, sourceConflictLog: log, nowIso: NOW });
  assert.ok(!h.alerts.some((a) => /source-disagreement/i.test(a)), JSON.stringify(h.alerts));
});

/* ─────────────── P4.4 INSUFFICIENT_DATA tracker ─────────────────── */

console.log("[7] insufficient_data block");

it("insufficient_data counts unique events with INSUFFICIENT_DATA verdict", () => {
  const hist = [
    {
      filename: "2026-05-14.json", today_iso: "2026-05-14", schema_version: "earnings-history-v4",
      predictions: [
        { symbol: "LO1", event_iso_date: "2026-05-15", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
        { symbol: "LO2", event_iso_date: "2026-05-16", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
        { symbol: "OK1", event_iso_date: "2026-05-17", predicted_verdict: "BEAT", data_quality: "HIGH" },
      ],
    },
    {
      filename: "2026-05-15.json", today_iso: "2026-05-15", schema_version: "earnings-history-v4",
      predictions: [
        // Duplicate of LO1 — should NOT double-count.
        { symbol: "LO1", event_iso_date: "2026-05-15", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
      ],
    },
  ];
  const h = buildHealthSummary({ history: hist, nowIso: NOW });
  assert.ok(h.insufficient_data, "block missing");
  assert.equal(h.insufficient_data.count_total, 2);
});

it("insufficient_data buckets by 7d and 30d using snapshot today_iso", () => {
  // NOW = 2026-05-15. 7d-ago = 2026-05-08. 30d-ago = 2026-04-15.
  const hist = [
    {
      filename: "2026-05-14.json", today_iso: "2026-05-14",
      predictions: [{ symbol: "LO_RECENT", event_iso_date: "2026-05-14", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" }],
    },
    {
      filename: "2026-04-25.json", today_iso: "2026-04-25",
      predictions: [{ symbol: "LO_MID", event_iso_date: "2026-04-25", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" }],
    },
    {
      filename: "2026-03-01.json", today_iso: "2026-03-01",
      predictions: [{ symbol: "LO_OLD", event_iso_date: "2026-03-01", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" }],
    },
  ];
  const h = buildHealthSummary({ history: hist, nowIso: NOW });
  assert.equal(h.insufficient_data.count_total, 3);
  // LO_RECENT is within 7d.
  assert.equal(h.insufficient_data.count_7d, 1);
  // LO_RECENT + LO_MID are within 30d. LO_OLD is outside.
  assert.equal(h.insufficient_data.count_30d, 2);
});

it("insufficient_data trend_pct_30d_vs_prior is computed from prior 30d window", () => {
  // Prior 30d window (days 30-60 ago from NOW=2026-05-15): roughly 2026-03-16 → 2026-04-15.
  // Latest 30d (days 0-30 ago): roughly 2026-04-15 → 2026-05-15.
  // 4 recent vs 2 prior → +100%.
  const hist = [
    {
      filename: "2026-05-14.json", today_iso: "2026-05-14",
      predictions: [
        { symbol: "R1", event_iso_date: "2026-05-14", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
        { symbol: "R2", event_iso_date: "2026-05-14", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
        { symbol: "R3", event_iso_date: "2026-05-14", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
        { symbol: "R4", event_iso_date: "2026-05-14", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
      ],
    },
    {
      filename: "2026-04-01.json", today_iso: "2026-04-01",
      predictions: [
        { symbol: "P1", event_iso_date: "2026-04-01", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
        { symbol: "P2", event_iso_date: "2026-04-01", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
      ],
    },
  ];
  const h = buildHealthSummary({ history: hist, nowIso: NOW });
  assert.equal(h.insufficient_data.count_30d, 4);
  assert.equal(h.insufficient_data.count_prior_30d, 2);
  assert.equal(h.insufficient_data.trend_pct_30d_vs_prior, 100);
});

it("insufficient_data positive trend raises an alert", () => {
  const hist = [
    {
      filename: "2026-05-14.json", today_iso: "2026-05-14",
      predictions: [
        { symbol: "R1", event_iso_date: "2026-05-14", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
        { symbol: "R2", event_iso_date: "2026-05-14", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
      ],
    },
    {
      filename: "2026-04-01.json", today_iso: "2026-04-01",
      predictions: [
        { symbol: "P1", event_iso_date: "2026-04-01", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
      ],
    },
  ];
  const h = buildHealthSummary({ history: hist, nowIso: NOW });
  assert.ok(h.alerts.some((a) => /INSUFFICIENT_DATA.*trending UP/i.test(a)), JSON.stringify(h.alerts));
});

it("insufficient_data flat-or-decreasing trend → no alert", () => {
  // 1 recent vs 3 prior → −66.7%. No alert.
  const hist = [
    {
      filename: "2026-05-14.json", today_iso: "2026-05-14",
      predictions: [{ symbol: "R1", event_iso_date: "2026-05-14", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" }],
    },
    {
      filename: "2026-04-01.json", today_iso: "2026-04-01",
      predictions: [
        { symbol: "P1", event_iso_date: "2026-04-01", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
        { symbol: "P2", event_iso_date: "2026-04-01", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
        { symbol: "P3", event_iso_date: "2026-04-01", predicted_verdict: "INSUFFICIENT_DATA", data_quality: "LOW" },
      ],
    },
  ];
  const h = buildHealthSummary({ history: hist, nowIso: NOW });
  assert.ok(!h.alerts.some((a) => /trending UP/i.test(a)), JSON.stringify(h.alerts));
});

it("data_quality:LOW with non-INSUFFICIENT_DATA verdict is still counted (defensive)", () => {
  // The predictor sets INSUFFICIENT_DATA when data_quality=LOW today,
  // but the tracker counts either signal so it survives upstream label drift.
  const hist = [
    {
      filename: "2026-05-14.json", today_iso: "2026-05-14",
      predictions: [
        { symbol: "L1", event_iso_date: "2026-05-14", predicted_verdict: "INLINE", data_quality: "LOW" },
      ],
    },
  ];
  const h = buildHealthSummary({ history: hist, nowIso: NOW });
  assert.equal(h.insufficient_data.count_total, 1);
});

console.log("[P4] macro regime freshness (2026-05-17 fix)");

it("macro regime missing → present:false, no alert", () => {
  const h = buildHealthSummary({ history: [], nowIso: NOW });
  assert.equal(h.macro_regime.present, false);
  assert.equal(h.macro_regime.age_hours, null);
  assert.equal(h.macro_regime.stale, false);
  assert.ok(!h.alerts.some((a) => /macro regime/i.test(a)));
});

it("macro regime missing generatedAt → present:false, no alert", () => {
  const h = buildHealthSummary({
    history: [],
    macroRegime: { regime: "CALM" },  // no generatedAt
    nowIso: NOW,
  });
  assert.equal(h.macro_regime.present, false);
  assert.ok(!h.alerts.some((a) => /macro regime/i.test(a)));
});

it("macro regime 5h old → fresh, no alert, age_hours reported", () => {
  const fiveHoursAgo = new Date(new Date(NOW).getTime() - 5 * 3600 * 1000).toISOString();
  const h = buildHealthSummary({
    history: [],
    macroRegime: { regime: "OIL_SHOCK", generatedAt: fiveHoursAgo, classifierProvider: "groq" },
    nowIso: NOW,
  });
  assert.equal(h.macro_regime.present, true);
  assert.equal(h.macro_regime.age_hours, 5);
  assert.equal(h.macro_regime.stale, false);
  assert.equal(h.macro_regime.regime, "OIL_SHOCK");
  assert.equal(h.macro_regime.classifier_provider, "groq");
  assert.ok(!h.alerts.some((a) => /macro regime/i.test(a)));
});

it("macro regime exactly 17h old → fresh, no alert (just under 18h threshold)", () => {
  const seventeenHoursAgo = new Date(new Date(NOW).getTime() - 17 * 3600 * 1000).toISOString();
  const h = buildHealthSummary({
    history: [],
    macroRegime: { regime: "CALM", generatedAt: seventeenHoursAgo, classifierProvider: "groq" },
    nowIso: NOW,
  });
  assert.equal(h.macro_regime.stale, false);
  assert.ok(!h.alerts.some((a) => /macro regime/i.test(a)));
});

it("macro regime exactly 18h old → stale, alert fires", () => {
  const eighteenHoursAgo = new Date(new Date(NOW).getTime() - 18 * 3600 * 1000).toISOString();
  const h = buildHealthSummary({
    history: [],
    macroRegime: { regime: "CALM", generatedAt: eighteenHoursAgo, classifierProvider: "groq" },
    nowIso: NOW,
  });
  assert.equal(h.macro_regime.stale, true);
  assert.equal(h.macro_regime.age_hours, 18);
  assert.ok(h.alerts.some((a) => /Macro regime is 18h old/i.test(a)),
    `alerts: ${JSON.stringify(h.alerts)}`);
  assert.ok(h.alerts.some((a) => /macro-only cron is unhealthy/i.test(a)),
    `alerts should name the cron: ${JSON.stringify(h.alerts)}`);
});

it("macro regime 24h old → alert with correct age, not healthy", () => {
  const twentyFourHoursAgo = new Date(new Date(NOW).getTime() - 24 * 3600 * 1000).toISOString();
  const h = buildHealthSummary({
    history: [],
    macroRegime: { regime: "CALM", generatedAt: twentyFourHoursAgo, classifierProvider: "groq" },
    nowIso: NOW,
  });
  assert.equal(h.macro_regime.age_hours, 24);
  assert.equal(h.healthy, false);
  assert.ok(h.alerts.some((a) => /Macro regime is 24h old/i.test(a)));
});

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
if (fail) process.exit(1);
