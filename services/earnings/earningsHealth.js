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

/**
 * P2.6 — summarise the source-conflict log (SWS vs Yahoo disagreements
 * on the same event's verdict). Reports last-30-days conflict count,
 * up-to-5 most-recent examples, and the conflict rate vs all resolved
 * events in the same window.
 */
function summariseSourceConflicts(conflictLog, history, nowIso) {
  const log = Array.isArray(conflictLog) ? conflictLog : [];
  const todayMs = new Date(nowIso).getTime();
  const cutoff30Ms = todayMs - 30 * 86400000;

  // Sort newest-first by logged_at so "examples" reads most-recent.
  const sorted = log.slice().sort((a, b) => {
    const ta = a && a.logged_at ? new Date(a.logged_at).getTime() : 0;
    const tb = b && b.logged_at ? new Date(b.logged_at).getTime() : 0;
    return tb - ta;
  });

  const recent = sorted.filter((r) => {
    if (!r || !r.logged_at) return false;
    const t = new Date(r.logged_at).getTime();
    return Number.isFinite(t) && t >= cutoff30Ms;
  });

  // Conflict rate is conflicts / resolved-in-the-same-30d-window. We
  // count resolved events whose resolved_at_iso falls in the 30d
  // window — that's the population the conflicts came out of.
  let resolved30d = 0;
  const seenResolved = new Set();
  for (const day of history || []) {
    for (const r of day.predictions || []) {
      if (!r || !r.symbol || !r.event_iso_date) continue;
      if (!r.actual_verdict) continue;
      const key = `${r.symbol}|${r.event_iso_date}`;
      if (seenResolved.has(key)) continue;
      seenResolved.add(key);
      if (!r.resolved_at_iso) continue;
      const t = new Date(r.resolved_at_iso).getTime();
      if (Number.isFinite(t) && t >= cutoff30Ms) resolved30d += 1;
    }
  }

  const ratePct = resolved30d > 0 ? +((recent.length / resolved30d) * 100).toFixed(1) : 0;

  return {
    count_total: log.length,
    count_30d: recent.length,
    rate_pct: ratePct,
    examples: recent.slice(0, 5),
  };
}

/**
 * P4.4 — count predictions whose data was too thin for the predictor.
 * A row is "insufficient" if predicted_verdict==="INSUFFICIENT_DATA"
 * OR data_quality==="LOW" (the predictor sets the former when the
 * latter holds, but counting both makes the metric robust to upstream
 * label drift).
 *
 * Dedupes by (symbol, event_iso_date) so the same event archived into
 * multiple daily snapshots only counts once. Buckets by 7d / 30d using
 * the snapshot's today_iso. The trend compares the most-recent 30d
 * against the prior 30d (days 30-60 ago) as a percentage delta.
 */
function summariseInsufficientData(history, nowIso) {
  const todayIso = (nowIso || new Date().toISOString()).slice(0, 10);
  const todayMs = new Date(todayIso + "T00:00:00Z").getTime();
  const MS_PER_DAY = 86400000;
  const iso7Ago = new Date(todayMs - 7 * MS_PER_DAY).toISOString().slice(0, 10);
  const iso30Ago = new Date(todayMs - 30 * MS_PER_DAY).toISOString().slice(0, 10);
  const iso60Ago = new Date(todayMs - 60 * MS_PER_DAY).toISOString().slice(0, 10);

  // Track first-seen snapshot date per event so 7d/30d buckets are
  // stable (the same event in 4 snapshots doesn't tilt the count).
  const firstSeenByKey = new Map();
  const insufficientKeys = new Set();
  for (const day of history || []) {
    const dayIso = day.today_iso || (day.filename ? String(day.filename).replace(/\.json$/, "") : null);
    if (!dayIso) continue;
    for (const r of day.predictions || []) {
      if (!r || !r.symbol || !r.event_iso_date) continue;
      const key = `${r.symbol}|${r.event_iso_date}`;
      const isLowData = r.predicted_verdict === "INSUFFICIENT_DATA" || r.data_quality === "LOW";
      if (!isLowData) continue;
      if (!firstSeenByKey.has(key)) firstSeenByKey.set(key, dayIso);
      insufficientKeys.add(key);
    }
  }

  let count7d = 0;
  let count30d = 0;
  let countPrior30d = 0;
  for (const key of insufficientKeys) {
    const firstSeenIso = firstSeenByKey.get(key);
    if (!firstSeenIso) continue;
    if (firstSeenIso >= iso7Ago) count7d += 1;
    if (firstSeenIso >= iso30Ago) count30d += 1;
    else if (firstSeenIso >= iso60Ago) countPrior30d += 1;
  }

  // Trend is the % change of the latest 30d window vs the prior 30d
  // window. With a zero baseline we report null — division-by-zero would
  // be infinite, and "n/a" is the honest reading.
  let trendPct30dVsPrior = null;
  if (countPrior30d > 0) {
    trendPct30dVsPrior = +(((count30d - countPrior30d) / countPrior30d) * 100).toFixed(1);
  } else if (count30d > 0) {
    // Crossed zero — flag the trend as +Infinity sentinel via a large
    // positive number so the alert rule fires (genuine new degradation).
    trendPct30dVsPrior = 100;
  } else {
    trendPct30dVsPrior = 0;
  }

  return {
    count_total: insufficientKeys.size,
    count_7d: count7d,
    count_30d: count30d,
    count_prior_30d: countPrior30d,
    trend_pct_30d_vs_prior: trendPct30dVsPrior,
  };
}

/* ───────────────────────── main builder ─────────────────────────── */

/**
 * @param {object} args
 * @param {Array}  args.history           loadAllHistory() output
 * @param {object} [args.backtestSnapshot] earnings-backtest-latest.json
 * @param {Array}  [args.watchEvents]      earnings-watch-latest.json .events
 * @param {object} [args.priorHealth]      the previous earnings-health.json
 * @param {string} [args.nowIso]           injectable clock
 * @param {Array}  [args.sourceConflictLog] data/catalysts/source-conflict-log.json
 *                                          contents (P2.6); empty when omitted
 * @returns {object} the health summary
 */
export function buildHealthSummary(args = {}) {
  const { history = [], backtestSnapshot = null, watchEvents = [], priorHealth = null, sourceConflictLog = [] } = args;
  const nowIso = args.nowIso || new Date().toISOString();

  const resolvedCount = countResolved(history);
  const priorResolved = priorHealth && priorHealth.resolved ? priorHealth.resolved.count : null;

  const llm = llmProviderSplit(watchEvents);
  const schema = archiveSchemaDistribution(history);
  const predictorVersions = predictorVersionDistribution(watchEvents);
  const restatements = findRestatements(history);
  // P2.6 source-disagreement summary + P4.4 insufficient-data tracker.
  const sourceConflicts = summariseSourceConflicts(sourceConflictLog, history, nowIso);
  const insufficientData = summariseInsufficientData(history, nowIso);

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
  // P2.6 — more than a handful of SWS-vs-Yahoo verdict disagreements in
  // the last 30 days suggests the classifier rules (keyword set, ratio
  // thresholds) need a look. The threshold is intentionally low (>5) —
  // these conflicts are usually rare; a sudden burst is the signal.
  if (sourceConflicts.count_30d > 5) {
    alerts.push(
      `${sourceConflicts.count_30d} source-disagreement(s) (SWS vs Yahoo) in last 30d ` +
      `(${sourceConflicts.rate_pct}% of resolved) — review classifyEarningsTitle / classifyYahooRow rules`,
    );
  }
  // P4.4 — INSUFFICIENT_DATA trending UP means the predictor is losing
  // coverage over time (V3 breakdown gaps, missing sector data). A flat
  // or improving trend is fine; a positive trend is the alert.
  if (insufficientData.trend_pct_30d_vs_prior != null && insufficientData.trend_pct_30d_vs_prior > 0) {
    alerts.push(
      `INSUFFICIENT_DATA predictions trending UP: ${insufficientData.count_30d} in last 30d ` +
      `vs ${insufficientData.count_prior_30d} prior 30d (+${insufficientData.trend_pct_30d_vs_prior}%) — ` +
      `predictor coverage may be degrading`,
    );
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
    source_conflicts: sourceConflicts,
    insufficient_data: insufficientData,
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
