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

it("PR-C1: current_resolved_note clarifies per-version vs overall when the two differ", () => {
  // HISTORY has 2 resolved; backtest reports v1_gate.current_resolved=0
  // for the latest predictor version → note must show BOTH numbers.
  const h = buildHealthSummary({
    history: HISTORY,
    backtestSnapshot: {
      enough_data_to_lift_cap: false,
      v1_gate: { current_resolved: 0, predictor_version: "earnings-predict-v2-2026-05" },
    },
    nowIso: NOW,
  });
  assert.equal(h.cap_lift_gate.current_resolved, 0);
  assert.match(h.cap_lift_gate.current_resolved_note, /0 of latest predictor version/);
  assert.match(h.cap_lift_gate.current_resolved_note, /earnings-predict-v2-2026-05/);
  assert.match(h.cap_lift_gate.current_resolved_note, /2 across all versions/);
});

it("PR-C1: current_resolved_note collapses to a short form when per-version == overall", () => {
  // Both counts agree (5 resolved, 5 in latest version) → short note.
  const matchedHistory = [
    {
      filename: "2026-05-14.json", today_iso: "2026-05-14", schema_version: "earnings-history-v4",
      predictions: [
        { symbol: "A", event_iso_date: "2026-05-08", actual_verdict: "BEAT" },
        { symbol: "B", event_iso_date: "2026-05-08", actual_verdict: "MISS" },
      ],
    },
  ];
  const h = buildHealthSummary({
    history: matchedHistory,
    backtestSnapshot: {
      enough_data_to_lift_cap: false,
      v1_gate: { current_resolved: 2, predictor_version: "earnings-predict-v2-2026-05" },
    },
    nowIso: NOW,
  });
  assert.equal(h.cap_lift_gate.current_resolved, 2);
  assert.match(h.cap_lift_gate.current_resolved_note, /^2 resolved/);
  assert.match(h.cap_lift_gate.current_resolved_note, /earnings-predict-v2-2026-05/);
  assert.doesNotMatch(h.cap_lift_gate.current_resolved_note, /across all versions/);
});

it("PR-C1: current_resolved_note works with no backtest snapshot (falls back to history count)", () => {
  // No backtest snapshot → current_resolved is the history count itself,
  // and the note should not reference a predictor version.
  const h = buildHealthSummary({ history: HISTORY, nowIso: NOW });
  assert.equal(h.cap_lift_gate.current_resolved, 2);
  assert.match(h.cap_lift_gate.current_resolved_note, /^2 resolved/);
  assert.doesNotMatch(h.cap_lift_gate.current_resolved_note, /across all versions/);
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
it("P1-9: 150 below-floor + 0 above-floor-heuristic + 20 LLM → NO heuristic-share alert", () => {
  // The V3 >= 50 floor in earningsLlmBatcher.js routes below-floor events
  // to heuristic by design (conserves free-tier quota). Those 150 events
  // MUST NOT count toward the heuristic-share alert denominator,
  // otherwise we'd alert permanently even when the LLM tier is healthy.
  // Eligible = 170 - 150 = 20; above-floor heuristic = 150 - 150 = 0;
  // share = 0 / 20 = 0% → no alert.
  const llmStats = {
    total: 170,
    classified: 170,
    cache_hits: 0,
    llm_calls: 20,
    heuristic: 150,         // ALL of these are the below-floor skips
    below_v3_floor: 150,
    composite_floor: 50,
    llm_available: true,
    skip_llm: false,
  };
  const watch = [{ signals: { llm_signal: { classifier_provider: "groq" } } }];
  const h = buildHealthSummary({ history: HISTORY, watchEvents: watch, llmStats, nowIso: NOW });
  assert.ok(
    !h.alerts.some((a) => /heuristic share \(above V3 floor\)/i.test(a)),
    `expected no heuristic-share alert; got ${JSON.stringify(h.alerts)}`,
  );
});
it("P1-9: 50 above-floor-heuristic of 100 eligible → heuristic-share alert FIRES (50% > 20%)", () => {
  // 200 total, 100 below-floor → 100 eligible. 150 heuristic total,
  // 100 of those are below-floor → 50 above-floor-heuristic. 50/100 =
  // 50%, well above the 20% threshold → alert.
  const llmStats = {
    total: 200,
    classified: 200,
    cache_hits: 0,
    llm_calls: 50,
    heuristic: 150,
    below_v3_floor: 100,
    composite_floor: 50,
    llm_available: true,
    skip_llm: false,
  };
  const watch = [{ signals: { llm_signal: { classifier_provider: "groq" } } }];
  const h = buildHealthSummary({ history: HISTORY, watchEvents: watch, llmStats, nowIso: NOW });
  const alert = h.alerts.find((a) => /heuristic share \(above V3 floor\)/i.test(a));
  assert.ok(alert, `expected heuristic-share alert; got ${JSON.stringify(h.alerts)}`);
  assert.match(alert, /50\/100 = 50%/);
  assert.match(alert, /100 below-floor skips excluded/);
});
it("P1-9: --skip-llm runs do not fire the heuristic-share alert (no LLM was attempted)", () => {
  const llmStats = { total: 100, heuristic: 100, below_v3_floor: 0, skip_llm: true };
  const h = buildHealthSummary({ history: HISTORY, watchEvents: WATCH_EVENTS, llmStats, nowIso: NOW });
  assert.ok(!h.alerts.some((a) => /heuristic share \(above V3 floor\)/i.test(a)),
    `expected no alert under --skip-llm; got ${JSON.stringify(h.alerts)}`);
});
it("P1-9: llm_heuristic_share_pct uses eligible_total when llmStats is present", () => {
  // 287 heuristic / 21 llm / 150 below-floor / 490 total — the exact
  // numbers from data/catalysts/earnings-watch-stats.json 2026-05-18T02Z
  // that motivated this fix. Eligible = 340; above-floor heuristic = 137;
  // 137/340 = 40.3% → rounds to 40 (NOT 51% as old denominator gave).
  const llmStats = {
    total: 490, classified: 481, cache_hits: 170, llm_calls: 21,
    heuristic: 287, below_v3_floor: 150, composite_floor: 50,
    llm_available: true, skip_llm: false,
  };
  // watchEvents-derived split would say 287/490 = 58.6%; the stats-based
  // path overrides it to the eligible-only figure.
  const watch = Array.from({ length: 490 }, (_, i) => ({
    signals: { llm_signal: { classifier_provider: i < 287 ? "heuristic" : (i < 308 ? "groq" : "none") } },
  }));
  const h = buildHealthSummary({ history: HISTORY, watchEvents: watch, llmStats, nowIso: NOW });
  assert.equal(h.llm_heuristic_share_pct, 40,
    `expected 40 (137/340 above-floor heuristic share); got ${h.llm_heuristic_share_pct}`);
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

console.log("[picks-fv-drift] Layer 3 telemetry surface");
it("absent both sources → picks_snapshot_fv_drift.pipeline/runtime_24h null, no alert", () => {
  const h = buildHealthSummary({ history: [], nowIso: NOW });
  assert.ok(h.picks_snapshot_fv_drift);
  assert.equal(h.picks_snapshot_fv_drift.pipeline, null);
  assert.equal(h.picks_snapshot_fv_drift.runtime_24h, null);
  assert.equal(h.picks_snapshot_fv_drift.alert, null);
  assert.ok(!h.alerts.some((a) => /picks.snapshot/i.test(a)));
});

it("pipeline drift > 0 → alert fires with top tickers", () => {
  const h = buildHealthSummary({
    history: [],
    picksFvDriftReport: {
      run_id: "r1",
      checked_at: NOW,
      drifted_count: 3,
      drifted_top: [
        { ticker: "STAR", section: "upcoming_earnings", pick_fv: 1264, snap_fv: 1078.5, delta: 185.5 },
        { ticker: "TCS", section: "top_ranked_30_v3", pick_fv: 3450, snap_fv: 3500, delta: -50 },
        { ticker: "INFY", section: "quality_growth", pick_fv: 1800, snap_fv: 1810, delta: -10 },
      ],
    },
    nowIso: NOW,
  });
  assert.equal(h.picks_snapshot_fv_drift.pipeline.drifted_count, 3);
  assert.deepEqual(h.picks_snapshot_fv_drift.pipeline.top_tickers, ["STAR", "TCS", "INFY"]);
  assert.ok(h.alerts.some((a) => /picks.snapshot Fair-Value drift/i.test(a) && /STAR/.test(a)),
    `alerts: ${JSON.stringify(h.alerts)}`);
  assert.equal(h.healthy, false);
});

it("runtime probe peak > 0 in 24h → alert fires even without pipeline drift", () => {
  const tsRecent = new Date(new Date(NOW).getTime() - 60 * 60 * 1000).toISOString();
  const tsOld = new Date(new Date(NOW).getTime() - 26 * 60 * 60 * 1000).toISOString();
  const h = buildHealthSummary({
    history: [],
    picksFvDriftJsonl: [
      { ts: tsRecent, fv_drift_count: 4, source: "probe" },
      { ts: tsRecent, fv_drift_count: 2, source: "probe" },
      { ts: tsOld, fv_drift_count: 99, source: "probe" },
    ],
    nowIso: NOW,
  });
  assert.equal(h.picks_snapshot_fv_drift.runtime_24h.samples, 2,
    "26h-old sample should be excluded from the 24h window");
  assert.equal(h.picks_snapshot_fv_drift.runtime_24h.max_drift_count, 4);
  assert.ok(h.alerts.some((a) => /runtime probe peak 4/i.test(a)),
    `alerts: ${JSON.stringify(h.alerts)}`);
});

it("runtime probe all zero in 24h → no alert (steady-state)", () => {
  const tsRecent = new Date(new Date(NOW).getTime() - 60 * 60 * 1000).toISOString();
  const h = buildHealthSummary({
    history: [],
    picksFvDriftJsonl: [
      { ts: tsRecent, fv_drift_count: 0, source: "probe" },
      { ts: tsRecent, fv_drift_count: 0, source: "probe" },
    ],
    nowIso: NOW,
  });
  assert.equal(h.picks_snapshot_fv_drift.runtime_24h.max_drift_count, 0);
  assert.equal(h.picks_snapshot_fv_drift.alert, null);
  assert.ok(!h.alerts.some((a) => /picks.snapshot/i.test(a)));
});

it("both sources drifted → alert mentions both", () => {
  const tsRecent = new Date(new Date(NOW).getTime() - 60 * 60 * 1000).toISOString();
  const h = buildHealthSummary({
    history: [],
    picksFvDriftReport: { run_id: "r1", checked_at: NOW, drifted_count: 5, drifted_top: [{ ticker: "STAR" }] },
    picksFvDriftJsonl: [{ ts: tsRecent, fv_drift_count: 7, source: "probe" }],
    nowIso: NOW,
  });
  const alert = h.alerts.find((a) => /picks.snapshot Fair-Value drift/i.test(a));
  assert.ok(alert, `expected alert; got ${JSON.stringify(h.alerts)}`);
  assert.ok(/pipeline check found 5/.test(alert), alert);
  assert.ok(/runtime probe peak 7/.test(alert), alert);
});

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
if (fail) process.exit(1);
