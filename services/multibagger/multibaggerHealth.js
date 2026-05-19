// Multibagger health summary — daily alerts about pipeline state.
// Mirrors services/earnings/earningsHealth.js: pure aggregator that
// reads disk inputs and returns { generated_at, metrics, alerts[] }.
// Caller orchestrates the Slack post.
//
// Alert categories:
//   - stale: macroRegime > 36h, scores file > 36h
//   - degraded: <5 candidates score ≥ HIGH_CONVICTION (pipeline thin)
//   - risk: portfolio drawdown ≥ 25% triggers YELLOW alert
//   - regime: regime gate just CLOSED or REOPENED since yesterday
//   - audit: decisionLog hasn't gained any entries in 30d (orphaned)

const STALE_MACRO_HOURS = 36;
const STALE_SCORES_HOURS = 36;
const PIPELINE_THIN_THRESHOLD = 5;
const ORPHANED_LOG_DAYS = 30;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function hoursBetween(aIso, nowIso) {
  const a = new Date(aIso);
  const n = new Date(nowIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(n.getTime())) return null;
  return (n - a) / 3_600_000;
}

function daysBetween(aIso, nowIso) {
  const h = hoursBetween(aIso, nowIso);
  if (h === null) return null;
  return h / 24;
}

export function buildHealthSummary({
  macroRegime = null,
  scores_built_at_iso = null,
  candidates = [],
  portfolio_risk = null,
  last_decision_ts_iso = null,
  previous_regime_open = null,
  current_regime_open = null,
  now_iso = null,
} = {}) {
  const now = now_iso || new Date().toISOString();
  const alerts = [];
  const metrics = {
    macroRegime_age_h: null,
    scores_age_h: null,
    candidate_count: candidates.length,
    high_conviction_count: candidates.filter((c) => ["5X_CANDIDATE", "HIGH_CONVICTION"].includes(c.verdict)).length,
    portfolio_drawdown_pct: portfolio_risk?.drawdown_pct ?? null,
    portfolio_state: portfolio_risk?.state || "UNKNOWN",
    decision_log_age_days: null,
  };

  if (macroRegime?.generatedAt) {
    metrics.macroRegime_age_h = Number(hoursBetween(macroRegime.generatedAt, now).toFixed(2));
    if (metrics.macroRegime_age_h > STALE_MACRO_HOURS) {
      alerts.push(`Macro regime is ${Math.round(metrics.macroRegime_age_h)}h old (threshold ${STALE_MACRO_HOURS}h) — refresh com.starbhai.macro-only`);
    }
  } else {
    alerts.push("Macro regime file missing — sector tilt is blind");
  }

  if (scores_built_at_iso) {
    metrics.scores_age_h = Number(hoursBetween(scores_built_at_iso, now).toFixed(2));
    if (metrics.scores_age_h > STALE_SCORES_HOURS) {
      alerts.push(`Multibagger scores are ${Math.round(metrics.scores_age_h)}h old — refresh-5x-strategy probably did not run`);
    }
  } else {
    alerts.push("Multibagger scores file missing — pipeline broken");
  }

  if (metrics.high_conviction_count < PIPELINE_THIN_THRESHOLD) {
    alerts.push(`Pipeline thin: only ${metrics.high_conviction_count} HIGH_CONVICTION+ candidates (threshold ${PIPELINE_THIN_THRESHOLD})`);
  }

  if (portfolio_risk?.state === "YELLOW") {
    alerts.push(`Portfolio YELLOW — drawdown ${portfolio_risk.drawdown_pct}% — pause new entries 7d`);
  }
  if (portfolio_risk?.state === "AMBER") {
    alerts.push(`Portfolio AMBER — drawdown ${portfolio_risk.drawdown_pct}% — concentrate to Anchor/High only`);
  }
  if (portfolio_risk?.state === "RED") {
    alerts.push(`Portfolio RED — drawdown ${portfolio_risk.drawdown_pct}% — failsafe pivot triggered`);
  }

  if (last_decision_ts_iso) {
    metrics.decision_log_age_days = Number(daysBetween(last_decision_ts_iso, now).toFixed(2));
    if (metrics.decision_log_age_days > ORPHANED_LOG_DAYS) {
      alerts.push(`Decision log idle for ${Math.round(metrics.decision_log_age_days)} days — portfolio frozen?`);
    }
  }

  if (previous_regime_open && current_regime_open) {
    const wasOpen = previous_regime_open.pillar1_anchor?.open;
    const isOpen = current_regime_open.pillar1_anchor?.open;
    if (wasOpen && !isOpen) alerts.push("Regime gate CLOSED for Pillar 1 entries today");
    if (!wasOpen && isOpen) alerts.push("Regime gate REOPENED for Pillar 1 entries today");
  }

  return {
    schema_version: "multibagger-health-v1",
    generated_at: now,
    metrics,
    alerts,
  };
}

export function formatHealthOneLiner(summary) {
  if (!summary) return "(no health summary)";
  const a = summary.alerts.length;
  return `Multibagger health · ${summary.metrics.high_conviction_count} HC+ candidates · ${summary.metrics.portfolio_state} · drawdown ${summary.metrics.portfolio_drawdown_pct ?? "—"}% · ${a} alert${a === 1 ? "" : "s"}`;
}

export const HEALTH_CONFIG = Object.freeze({
  STALE_MACRO_HOURS,
  STALE_SCORES_HOURS,
  PIPELINE_THIN_THRESHOLD,
  ORPHANED_LOG_DAYS,
});
