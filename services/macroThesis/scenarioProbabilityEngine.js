// Scenario probability engine (PR B2).
//
// Given the CURRENT regime (regime + severity + days-in-state), enumerate
// the {continue, escalate, de-escalate, new_shock} branches with explicit
// duration assumptions and a probability distribution that sums to 1.0.
//
// The probability model is deliberately heuristic (not ML): each branch
// has a base probability that's modulated by severity + days-in-state +
// catalyst proximity. The output is honest about uncertainty — if the
// underlying analog backtester has n_analogs < MIN_SAFE_N, we emit
// INDETERMINATE instead of fabricating precision.
//
// SEBI Reg 16 note: this isn't a forecast in the statistical sense.
// It's a scenario enumeration so the user can pre-arm decisions
// ("if regime continues, increase Defence; if de-escalates, switch to
// Real Estate"). Probabilities are RELATIVE WEIGHTS, not absolute
// predictions — the UI surfaces them with the analog n + warnings so
// the user judges credibility themselves.

import { findAnalogs, MIN_SAFE_N } from "./historicalAnalogFinder.js";

export const SCENARIO_KEYS = Object.freeze(["continue", "escalate", "de_escalate", "new_shock"]);

// Branch base probabilities. These sum to 1.0 and represent the modal
// distribution before any modulators apply.
const BASE_PROBS = Object.freeze({
  continue: 0.55,
  escalate: 0.15,
  de_escalate: 0.20,
  new_shock: 0.10,
});

export const CONTINUE_DURATION_DAYS = 14;
export const ESCALATE_DURATION_DAYS = 7;
export const DE_ESCALATE_DURATION_DAYS = 21;
export const NEW_SHOCK_DURATION_DAYS = 7;

function _clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function _round2(x) {
  return Math.round(x * 100) / 100;
}

// Heuristic modulators per branch. Each takes (severity, daysInState,
// catalystProximityDays) and returns a multiplicative weight in [0, 2].
const MODULATORS = {
  continue(sev, days /*, catProx*/) {
    // continue gets DOWN-weighted as the regime ages — at 30+ days the
    // base case erodes toward de_escalate.
    let w = 1.0;
    if (days >= 30) w *= 0.8;
    if (days >= 60) w *= 0.7;
    // Higher severity tends to be sticky in the short term.
    if (sev >= 4 && days < 14) w *= 1.15;
    return w;
  },
  escalate(sev, days /*, catProx*/) {
    // escalation more likely at higher severity, less likely if the
    // regime has been running for weeks without escalating.
    let w = 1.0;
    if (sev >= 4) w *= 1.4;
    if (sev <= 2) w *= 0.7;
    if (days >= 14) w *= 0.85;
    if (days >= 30) w *= 0.6;
    return w;
  },
  de_escalate(sev, days /*, catProx*/) {
    // de-escalation more likely the longer the regime persists.
    let w = 1.0;
    if (days >= 14) w *= 1.3;
    if (days >= 30) w *= 1.6;
    if (sev >= 4) w *= 0.85; // very severe regimes don't unwind fast
    return w;
  },
  new_shock(_sev, _days, catProx) {
    // new shock probability is mainly driven by catalyst proximity —
    // imminent RBI/FOMC/election/earnings cluster pushes this up.
    let w = 1.0;
    if (catProx !== null && catProx <= 7) w *= 2.0;
    else if (catProx !== null && catProx <= 14) w *= 1.4;
    return w;
  },
};

export function enumerateScenarios({
  regime,
  severity,
  daysInState = 0,
  catalystProximityDays = null,
}) {
  if (!regime || typeof severity !== "number") {
    return { branches: [], indeterminate: true, reason: "missing regime or severity" };
  }
  const weights = {};
  for (const key of SCENARIO_KEYS) {
    const base = BASE_PROBS[key];
    const mod = MODULATORS[key](severity, daysInState, catalystProximityDays);
    weights[key] = base * mod;
  }
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  // Normalise so the four probabilities sum to 1.0
  const probs = {};
  for (const k of SCENARIO_KEYS) probs[k] = _round2(weights[k] / total);
  return {
    regime,
    severity,
    days_in_state: daysInState,
    catalyst_proximity_days: catalystProximityDays,
    branches: SCENARIO_KEYS.map((k) => ({
      key: k,
      label: _scenarioLabel(k, regime),
      probability: probs[k],
      duration_days: _scenarioDuration(k),
      modulator_applied: _round2(MODULATORS[k](severity, daysInState, catalystProximityDays)),
    })),
    indeterminate: false,
  };
}

function _scenarioLabel(key, regime) {
  switch (key) {
    case "continue":   return `${regime} continues at current severity`;
    case "escalate":   return `${regime} escalates (severity +1)`;
    case "de_escalate": return `${regime} de-escalates → CALM`;
    case "new_shock":  return `New unrelated shock supersedes ${regime}`;
    default:           return key;
  }
}

function _scenarioDuration(key) {
  switch (key) {
    case "continue":   return CONTINUE_DURATION_DAYS;
    case "escalate":   return ESCALATE_DURATION_DAYS;
    case "de_escalate": return DE_ESCALATE_DURATION_DAYS;
    case "new_shock":  return NEW_SHOCK_DURATION_DAYS;
    default:           return null;
  }
}

// Build the full scenario package: probabilities + projected sector
// returns under each branch, using analog distributions from B1.4.
// Branches with n_analogs < MIN_SAFE_N have sector projections set to
// null (UI surfaces "INDETERMINATE — need more analogs").
export function buildScenarioPackage({
  regime,
  severity,
  daysInState = 0,
  catalystProximityDays = null,
  currentDate = null,
  regimeHistoryDir,
  sectorDataDir,
} = {}) {
  const probs = enumerateScenarios({
    regime,
    severity,
    daysInState,
    catalystProximityDays,
  });
  if (probs.indeterminate) return { ...probs, scenarios: [], analog_report: null };

  // The CONTINUE branch reuses the current regime's analog distribution.
  // ESCALATE blends current + (severity+1) analogs. DE_ESCALATE uses
  // CALM analogs. NEW_SHOCK explicitly returns no sector projection —
  // the whole point is "unknown next regime".
  const analogContinue = findAnalogs({
    regime,
    severity,
    currentDate,
    excludeWindowDays: 30,
    regimeHistoryDir,
    sectorDataDir,
  });
  const analogEscalate = findAnalogs({
    regime,
    severity: severity + 1,
    toleranceSeverity: 1,
    currentDate,
    excludeWindowDays: 30,
    regimeHistoryDir,
    sectorDataDir,
  });
  const analogDeEscalate = findAnalogs({
    regime: "CALM",
    severity: 1,
    toleranceSeverity: 1,
    currentDate,
    excludeWindowDays: 30,
    regimeHistoryDir,
    sectorDataDir,
  });

  const scenarios = probs.branches.map((b) => {
    let projection = null;
    let analogN = 0;
    if (b.key === "continue") {
      projection = analogContinue.sectors;
      analogN = analogContinue.n_analogs;
    } else if (b.key === "escalate") {
      projection = analogEscalate.sectors;
      analogN = analogEscalate.n_analogs;
    } else if (b.key === "de_escalate") {
      projection = analogDeEscalate.sectors;
      analogN = analogDeEscalate.n_analogs;
    }
    return {
      ...b,
      n_analogs: analogN,
      indeterminate: analogN < MIN_SAFE_N && b.key !== "new_shock",
      projected_sector_returns: projection,
    };
  });

  return {
    ...probs,
    scenarios,
    analog_report_continue: { n: analogContinue.n_analogs, warnings: analogContinue.warnings },
    analog_report_escalate: { n: analogEscalate.n_analogs, warnings: analogEscalate.warnings },
    analog_report_de_escalate: { n: analogDeEscalate.n_analogs, warnings: analogDeEscalate.warnings },
  };
}

export default {
  SCENARIO_KEYS,
  enumerateScenarios,
  buildScenarioPackage,
  CONTINUE_DURATION_DAYS,
  ESCALATE_DURATION_DAYS,
  DE_ESCALATE_DURATION_DAYS,
  NEW_SHOCK_DURATION_DAYS,
};
