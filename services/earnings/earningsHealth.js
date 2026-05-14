/**
 * earningsHealth.js
 *
 * Pure aggregator for the daily Earnings Watch pipeline health summary.
 * The pipeline now has many moving parts — the actuals resolver, the
 * fundamentals refresh, the V3 adapter, the LLM signal, the weight
 * tuner — and a silent failure in any of them degrades the predictor
 * without anyone noticing. This rolls the observable state of all of
 * them into one snapshot a human (or a Slack ping) can scan in five
 * seconds.
 *
 * Everything here is a pure function of its inputs — the runner
 * (scripts/earnings-health-summary.mjs) does the file I/O and the
 * optional Slack post. `priorHealth` is the previous run's output,
 * which lets the summary track deltas and "days in current state"
 * without a separate state store.
 */

export const HEALTH_SCHEMA_VERSION = "earnings-health-v1";

/* ──────────────────────── sub-aggregators ───────────────────────── */

// Deduped resolved-actuals count across the archive.
function countResolved(history) {
  const seen = new Set();
  let resolved = 0;
  for (const day of history || []) {
    for (const r of day.predictions || []) {
      if (!r || !r.symbol || !r.event_iso_date) continue;
      const key = `${r.symbol}|${r.event_iso_date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (r.actual_verdict) resolved += 1;
    }
  }
  return resolved;
}

// LLM provider split across the live watch snapshot.
function llmProviderSplit(watchEvents) {
  const split = { groq: 0, gemini: 0, heuristic: 0, none: 0 };
  for (const e of watchEvents || []) {
    const p = e && e.signals && e.signals.llm_signal && e.signals.llm_signal.classifier_provider;
    if (p === "groq") split.groq += 1;
    else if (p === "gemini") split.gemini += 1;
    else if (p === "heuristic") split.heuristic += 1;
    else split.none += 1;
  }
  split.total = split.groq + split.gemini + split.heuristic + split.none;
  return split;
}

// schema_version distribution across the archive files.
function archiveSchemaDistribution(history) {
  const dist = {};
  for (const day of history || []) {
    const v = day.schema_version || "unknown";
    dist[v] = (dist[v] || 0) + 1;
  }
  return dist;
}

// predictor_version distribution across the live watch snapshot.
function predictorVersionDistribution(watchEvents) {
  const dist = {};
  for (const e of watchEvents || []) {
    const v = (e && e.prediction && e.prediction.predictor_version) || "unknown";
    dist[v] = (dist[v] || 0) + 1;
  }
  return dist;
}

// Rows whose actual_verdict was revised after first resolution.
function findRestatements(history) {
  const seen = new Set();
  const symbols = [];
  for (const day of history || []) {
    for (const r of day.predictions || []) {
      if (!r || !Array.isArray(r.actual_history) || r.actual_history.length === 0) continue;
      const key = `${r.symbol}|${r.event_iso_date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push(key);
    }
  }
  return { count: symbols.length, symbols };
}

/* ───────────────────────── main builder ─────────────────────────── */

/**
 * @param {object} args
 * @param {Array}  args.history           loadAllHistory() output
 * @param {object} [args.backtestSnapshot] earnings-backtest-latest.json
 * @param {Array}  [args.watchEvents]      earnings-watch-latest.json .events
 * @param {object} [args.priorHealth]      the previous earnings-health.json
 * @param {string} [args.nowIso]           injectable clock
 * @returns {object} the health summary
 */
export function buildHealthSummary(args = {}) {
  const { history = [], backtestSnapshot = null, watchEvents = [], priorHealth = null } = args;
  const nowIso = args.nowIso || new Date().toISOString();

  const resolvedCount = countResolved(history);
  const priorResolved = priorHealth && priorHealth.resolved ? priorHealth.resolved.count : null;

  const llm = llmProviderSplit(watchEvents);
  const schema = archiveSchemaDistribution(history);
  const predictorVersions = predictorVersionDistribution(watchEvents);
  const restatements = findRestatements(history);

  // Cap-lift gate + days-in-state. The gate "state" is the boolean
  // enough_data_to_lift_cap; we tick a day counter while it holds.
  const gateMet = !!(backtestSnapshot && backtestSnapshot.enough_data_to_lift_cap);
  let daysInState = 1;
  if (priorHealth && priorHealth.cap_lift_gate && priorHealth.cap_lift_gate.state === gateMet) {
    daysInState = (priorHealth.cap_lift_gate.days_in_current_state || 1) + 1;
  }
  const capLiftGate = {
    state: gateMet,
    enough_data_to_lift_cap: gateMet,
    days_in_current_state: daysInState,
    current_resolved: backtestSnapshot && backtestSnapshot.v1_gate
      ? backtestSnapshot.v1_gate.current_resolved
      : resolvedCount,
    detail: backtestSnapshot ? backtestSnapshot.v1_gate || null : null,
  };

  // ── Alerts — anything a human should look at, surfaced for Slack ──
  const alerts = [];
  if (Object.keys(schema).length > 1) {
    alerts.push(`Archive holds mixed schema versions: ${Object.keys(schema).sort().join(", ")} — run scripts/migrate-earnings-history-schema.mjs`);
  }
  if (llm.total > 0 && llm.groq === 0 && llm.gemini === 0) {
    alerts.push(`LLM signal is 100% heuristic (${llm.heuristic}/${llm.total}) — GROQ_API_KEY / GEMINI_API_KEY likely not configured on the refresh host`);
  }
  if (restatements.count > 0) {
    alerts.push(`${restatements.count} restated actual(s): ${restatements.symbols.slice(0, 5).join(", ")}${restatements.count > 5 ? "…" : ""}`);
  }
  // A resolved count going DOWN is genuinely wrong — actuals don't
  // un-resolve. A FLAT count is not alert-worthy (quiet days are
  // normal); the delta is in the data for anyone who wants to look.
  if (priorResolved != null && resolvedCount < priorResolved) {
    alerts.push(`Resolved-actuals count dropped ${priorResolved} → ${resolvedCount} — archive may have been corrupted or reverted`);
  }
  if (gateMet && !(priorHealth && priorHealth.cap_lift_gate && priorHealth.cap_lift_gate.state)) {
    alerts.push(`Cap-lift gate just CLEARED — scripts/tune-earnings-weights.mjs and the confidence-cap lift are now actionable`);
  }
  if (Object.keys(predictorVersions).length > 1) {
    alerts.push(`Live snapshot mixes predictor versions: ${Object.keys(predictorVersions).sort().join(", ")}`);
  }

  return {
    schema_version: HEALTH_SCHEMA_VERSION,
    generated_at: nowIso,
    resolved: {
      count: resolvedCount,
      delta_vs_prior: priorResolved == null ? null : resolvedCount - priorResolved,
      prior_count: priorResolved,
    },
    llm_providers: llm,
    cap_lift_gate: capLiftGate,
    archive_schema: schema,
    predictor_versions: predictorVersions,
    restatements,
    history_files: (history || []).length,
    alerts,
    healthy: alerts.length === 0,
  };
}

/**
 * One-line Slack/console summary string built from a health object.
 */
export function formatHealthOneLiner(health) {
  if (!health) return "Earnings health: (no data)";
  const llm = health.llm_providers || {};
  const llmStr = `LLM groq:${llm.groq || 0}/gem:${llm.gemini || 0}/heur:${llm.heuristic || 0}`;
  const gate = health.cap_lift_gate || {};
  const gateStr = `cap-gate ${gate.state ? "MET" : "not-met"} (${gate.days_in_current_state || 1}d)`;
  const flag = health.healthy ? "✅" : `⚠ ${health.alerts.length} alert(s)`;
  return `Earnings health ${flag} · resolved ${health.resolved.count}` +
    `${health.resolved.delta_vs_prior != null ? ` (${health.resolved.delta_vs_prior >= 0 ? "+" : ""}${health.resolved.delta_vs_prior})` : ""}` +
    ` · ${llmStr} · ${gateStr}`;
}
