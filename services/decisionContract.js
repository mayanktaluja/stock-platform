export const DECISION_STATES = Object.freeze({
  ACTIONABLE_NOW: "ACTIONABLE_NOW",
  STAGGER_ONLY: "STAGGER_ONLY",
  WAIT: "WAIT",
  RESEARCH_ONLY: "RESEARCH_ONLY",
  SHADOW_ONLY: "SHADOW_ONLY",
  DEGRADED: "DEGRADED",
  HINDSIGHT: "HINDSIGHT",
});

export const PORTFOLIO_ACTIONS = Object.freeze({
  BUY: "BUY",
  STAGGER: "STAGGER",
  WAIT: "WAIT",
  NONE: "NONE",
});

const DEFAULT_LABELS = Object.freeze({
  [DECISION_STATES.ACTIONABLE_NOW]: "Actionable now",
  [DECISION_STATES.STAGGER_ONLY]: "Stagger only",
  [DECISION_STATES.WAIT]: "Wait",
  [DECISION_STATES.RESEARCH_ONLY]: "Research only",
  [DECISION_STATES.SHADOW_ONLY]: "Shadow only",
  [DECISION_STATES.DEGRADED]: "Degraded",
  [DECISION_STATES.HINDSIGHT]: "Hindsight",
});

export function buildDecisionContract({
  state,
  label = null,
  portfolio_action = PORTFOLIO_ACTIONS.NONE,
  promoted = false,
  reason = "",
} = {}) {
  const resolvedState = DECISION_STATES[state] || state || DECISION_STATES.RESEARCH_ONLY;
  return {
    state: resolvedState,
    label: label || DEFAULT_LABELS[resolvedState] || String(resolvedState).replace(/_/g, " "),
    portfolio_action,
    promoted: promoted === true,
    reason: reason || "",
  };
}

export function researchOnlyContract(reason = "Research signal only; no portfolio action is promoted.") {
  return buildDecisionContract({
    state: DECISION_STATES.RESEARCH_ONLY,
    portfolio_action: PORTFOLIO_ACTIONS.NONE,
    promoted: false,
    reason,
  });
}

export function shadowOnlyContract(reason = "Shadow signal only; production verdict remains unchanged.") {
  return buildDecisionContract({
    state: DECISION_STATES.SHADOW_ONLY,
    portfolio_action: PORTFOLIO_ACTIONS.NONE,
    promoted: false,
    reason,
  });
}

export function contextOnlyContract(reason = "Context signal only; not an entry instruction.") {
  return buildDecisionContract({
    state: DECISION_STATES.RESEARCH_ONLY,
    label: "Context only",
    portfolio_action: PORTFOLIO_ACTIONS.NONE,
    promoted: false,
    reason,
  });
}
