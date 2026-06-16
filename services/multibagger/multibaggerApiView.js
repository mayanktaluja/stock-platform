import { VALIDATION_GATE } from "./multibaggerBacktest.js";

const DEFAULT_LIMIT = 30;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const STALE_SNAPSHOT_HOURS = 36;

const VALID_VERDICTS = new Set([
  "5X_CANDIDATE",
  "HIGH_CONVICTION",
  "WATCH",
  "PASS",
  "HARD_REJECT",
]);

export const DEFAULT_SURVIVORSHIP_WARNING =
  "picks-latest excludes delisted tickers; hit rate is upward-biased. Treat as indicative only until delisted source ingested.";

export const DEFAULT_VALIDATION_GATE = Object.freeze({
  gate_met: false,
  blocking_reasons: [
    `forward_archive_0mo_<_${VALIDATION_GATE.MIN_FORWARD_MONTHS}mo`,
    `windows_0_<_${VALIDATION_GATE.MIN_WINDOWS}`,
    `resolved_0_<_${VALIDATION_GATE.MIN_RESOLVED_PER_WINDOW}`,
  ],
  gate_spec: VALIDATION_GATE,
});

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function round2(v) {
  return Number(v.toFixed(2));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hoursBetween(aIso, nowIso) {
  const a = new Date(aIso);
  const n = new Date(nowIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(n.getTime())) return null;
  return (n - a) / 3_600_000;
}

function cloneObject(v) {
  return isPlainObject(v) ? { ...v } : {};
}

function cloneArray(v) {
  return Array.isArray(v) ? [...v] : [];
}

function validationGateOrDefault(validation_gate) {
  if (!isPlainObject(validation_gate)) return { ...DEFAULT_VALIDATION_GATE, gate_spec: { ...VALIDATION_GATE } };
  return {
    gate_met: validation_gate.gate_met === true,
    blocking_reasons: cloneArray(validation_gate.blocking_reasons),
    gate_spec: isPlainObject(validation_gate.gate_spec) ? { ...validation_gate.gate_spec } : { ...VALIDATION_GATE },
  };
}

export function clampCandidateLimit(rawLimit, defaultLimit = DEFAULT_LIMIT) {
  const parsed = Number(rawLimit);
  const base = Number.isFinite(parsed) ? Math.trunc(parsed) : defaultLimit;
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, base));
}

export function normalizeVerdictFilter(rawVerdict) {
  const requested = rawVerdict == null ? "" : String(rawVerdict);
  const normalized = requested.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!normalized || normalized === "ALL") {
    return { requested, normalized: null, valid: true, applied: false };
  }
  if (!VALID_VERDICTS.has(normalized)) {
    return { requested, normalized, valid: false, applied: true };
  }
  return { requested, normalized, valid: true, applied: true };
}

export function computeSnapshotStatus({ scores = null, health = null, now_iso = null, stale_hours = STALE_SNAPSHOT_HOURS } = {}) {
  const now = now_iso || new Date().toISOString();
  const builtAt = scores?.built_at || null;

  if (!scores) {
    return { state: "missing", built_at: null, age_h: null, stale_hours, reason: "scores_missing" };
  }

  const age = builtAt ? hoursBetween(builtAt, now) : null;
  if (age === null) {
    return { state: "degraded", built_at: builtAt, age_h: null, stale_hours, reason: "invalid_built_at" };
  }

  const age_h = round2(age);
  if (age_h > stale_hours) {
    return { state: "stale", built_at: builtAt, age_h, stale_hours, reason: "scores_stale" };
  }

  if (!Array.isArray(scores.top_50)) {
    return { state: "degraded", built_at: builtAt, age_h, stale_hours, reason: "top_50_missing" };
  }

  if (!health) {
    return { state: "degraded", built_at: builtAt, age_h, stale_hours, reason: "health_missing" };
  }

  if (Array.isArray(health.alerts) && health.alerts.length > 0) {
    return { state: "degraded", built_at: builtAt, age_h, stale_hours, reason: "health_alerts" };
  }

  return { state: "ok", built_at: builtAt, age_h, stale_hours, reason: null };
}

function candidateScore(candidate) {
  return isFiniteNumber(candidate?.score_0_100) ? Number(candidate.score_0_100.toFixed(1)) : null;
}

function candidateVerdict(candidate) {
  const verdict = String(candidate?.verdict || "UNKNOWN").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return verdict || "UNKNOWN";
}

function deriveTradability(candidate) {
  const diagnostics = isPlainObject(candidate?.diagnostics) ? candidate.diagnostics : {};
  const gateReasons = cloneArray(candidate?.gate_reasons);
  const verdict = candidateVerdict(candidate);
  const adv = diagnostics.adv_inr_30d;

  if (candidate?.gate_blocked === true || gateReasons.length > 0) {
    return {
      tradability_state: "AVOID_ENTRY",
      entry_status: "do_not_enter",
      tradability_reasons: gateReasons.length ? gateReasons : ["gate_blocked"],
    };
  }

  if (diagnostics.pledge?.pass === false) {
    return {
      tradability_state: "AVOID_ENTRY",
      entry_status: "do_not_enter",
      tradability_reasons: cloneArray(diagnostics.pledge.reasons).map((r) => `pledge_${r}`),
    };
  }

  if (isFiniteNumber(adv) && adv < 50_000) {
    return {
      tradability_state: "AVOID_ENTRY",
      entry_status: "do_not_enter",
      tradability_reasons: ["adv_below_floor"],
    };
  }

  if (!isFiniteNumber(adv)) {
    return {
      tradability_state: "WAIT_FOR_VOLUME",
      entry_status: "needs_liquidity_check",
      tradability_reasons: ["adv_unknown"],
    };
  }

  if (diagnostics.tailwind?.cohort_exhausted === true) {
    return {
      tradability_state: "WAIT_FOR_VOLUME",
      entry_status: "wait_for_pullback",
      tradability_reasons: ["cohort_exhausted"],
    };
  }

  if (diagnostics.health_cap_applied === true) {
    return {
      tradability_state: "SIZE_DOWN",
      entry_status: "watch_only",
      tradability_reasons: ["health_cap_applied"],
    };
  }

  if (["5X_CANDIDATE", "HIGH_CONVICTION"].includes(verdict)) {
    return { tradability_state: "TRADABLE_NOW", entry_status: "entry_candidate", tradability_reasons: [] };
  }

  if (verdict === "WATCH") {
    return { tradability_state: "SIZE_DOWN", entry_status: "watch_only", tradability_reasons: [] };
  }

  return { tradability_state: "AVOID_ENTRY", entry_status: "no_entry", tradability_reasons: [] };
}

function entryQuality(candidate, tradability) {
  const diagnostics = isPlainObject(candidate?.diagnostics) ? candidate.diagnostics : {};
  const breakdown = isPlainObject(candidate?.breakdown) ? candidate.breakdown : {};
  return {
    price_freshness: isFiniteNumber(diagnostics.adv_inr_30d) ? "volume_seen" : "volume_unknown",
    fair_value_support: isFiniteNumber(breakdown.fv_upside) && breakdown.fv_upside >= 8 ? "strong" : "unproven",
    volume_confirmation: tradability.tradability_state === "TRADABLE_NOW" ? "confirmed" : "not_confirmed",
    circuit_or_gap_risk: cloneArray(tradability.tradability_reasons).includes("cohort_exhausted") ? "elevated" : "unknown",
  };
}

export function shapeMultibaggerCandidate(candidate, { validation_gate = null } = {}) {
  const gate = validationGateOrDefault(validation_gate);
  const validated = gate.gate_met === true;
  const verdict = candidateVerdict(candidate);
  const tradability = deriveTradability(candidate);
  const score = candidateScore(candidate);

  return {
    ticker: candidate?.ticker ? String(candidate.ticker) : null,
    sector: candidate?.sector ? String(candidate.sector) : null,
    score_0_100: score,
    rank_score_0_100: score,
    verdict,
    verdict_label: verdict === "UNKNOWN" ? "Unknown" : verdict.replace(/_/g, " "),
    gate_blocked: candidate?.gate_blocked === true,
    gate_reasons: cloneArray(candidate?.gate_reasons),
    breakdown: cloneObject(candidate?.breakdown),
    diagnostics: cloneObject(candidate?.diagnostics),
    validation_label: validated ? "validated" : "unvalidated",
    probability_label: validated ? "validated" : "model-implied",
    evidence_status: validated ? "VALIDATED" : "UNVALIDATED",
    model_label: validated ? "validated" : "model-implied/unvalidated",
    ...tradability,
    entry_quality: entryQuality(candidate, tradability),
  };
}

function candidatesFromScores(scores) {
  return Array.isArray(scores?.top_50) ? scores.top_50 : [];
}

export function buildMultibaggerCandidatesView({
  scores = null,
  health = null,
  validation_gate = null,
  survivorship_warning = null,
  verdict = "",
  limit = DEFAULT_LIMIT,
  now_iso = null,
} = {}) {
  const gate = validationGateOrDefault(validation_gate);
  const filter = normalizeVerdictFilter(verdict);
  const resolvedLimit = clampCandidateLimit(limit);
  const snapshot_status = computeSnapshotStatus({ scores, health, now_iso });

  let candidates = candidatesFromScores(scores);
  if (filter.applied) {
    candidates = filter.valid ? candidates.filter((c) => candidateVerdict(c) === filter.normalized) : [];
  }

  return {
    schema_version: scores?.schema_version || "multibagger-scores-v1",
    built_at: scores?.built_at || null,
    age_h: snapshot_status.age_h,
    universe_size: scores?.universe_size || null,
    snapshot_status,
    validation_gate: gate,
    survivorship_warning: survivorship_warning || DEFAULT_SURVIVORSHIP_WARNING,
    validation_label: gate.gate_met ? "validated" : "unvalidated",
    probability_label: gate.gate_met ? "validated" : "model-implied",
    verdict_filter: filter,
    limit: resolvedLimit,
    candidates: candidates.slice(0, resolvedLimit).map((c) => shapeMultibaggerCandidate(c, { validation_gate: gate })),
  };
}

export function buildMultibaggerOverviewView({
  scores = null,
  slate = null,
  health = null,
  portfolio = null,
  validation_gate = null,
  survivorship_warning = null,
  now_iso = null,
} = {}) {
  const gate = validationGateOrDefault(validation_gate);
  const topCandidates = buildMultibaggerCandidatesView({
    scores,
    health,
    validation_gate: gate,
    survivorship_warning,
    limit: 30,
    now_iso,
  });

  return {
    schema_version: "multibagger-overview-v1",
    built_at: scores?.built_at || null,
    age_h: topCandidates.snapshot_status.age_h,
    universe_size: scores?.universe_size || null,
    snapshot_status: topCandidates.snapshot_status,
    validation_gate: gate,
    survivorship_warning: survivorship_warning || DEFAULT_SURVIVORSHIP_WARNING,
    validation_label: gate.gate_met ? "validated" : "unvalidated",
    probability_label: gate.gate_met ? "validated" : "model-implied",
    verdicts: {
      five_x_count: scores?.five_x_count || 0,
      high_conviction_count: scores?.high_conviction_count || 0,
      watch_count: scores?.watch_count || 0,
      hard_reject_count: scores?.hard_reject_count || 0,
    },
    macro_regime: scores?.macro_regime || null,
    top_candidates: topCandidates.candidates,
    catalyst_slate: Array.isArray(slate?.slate) ? slate.slate : [],
    health: {
      alerts: Array.isArray(health?.alerts) ? health.alerts : [],
      metrics: health?.metrics || null,
    },
    portfolio_summary: portfolio ? {
      starting_capital_inr: portfolio.starting_capital_inr,
      cash_inr: portfolio.cash_inr,
      open_positions: Array.isArray(portfolio.positions) ? portfolio.positions.length : 0,
      closed_positions: Array.isArray(portfolio.closed_positions) ? portfolio.closed_positions.length : 0,
      snapshot_at: portfolio.snapshot_at,
    } : null,
  };
}

export const MULTIBAGGER_API_VIEW_CONFIG = Object.freeze({
  DEFAULT_LIMIT,
  MIN_LIMIT,
  MAX_LIMIT,
  STALE_SNAPSHOT_HOURS,
  VALID_VERDICTS: [...VALID_VERDICTS],
});
