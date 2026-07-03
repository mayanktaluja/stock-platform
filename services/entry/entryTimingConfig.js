// Entry-timing overlay config — Two-Key Entry (plan: ~/.claude/plans/entry-timing-final.md).
// ALL tunables live here so a data-tune (PR-1 backtest re-run) never diffs engine logic.
// v1 seeds are provisional; data/strategy/entry-band-mae.json is the provenance for any change.
// Pure constants — no logic, no I/O.

export const ENTRY_TIMING_VERSION = "entry-timing-v1-2026-07";

// FALLING_KNIFE entry legs (any one triggers). Values are percent returns unless noted.
export const KNIFE = {
  R1M_MAX: -12, // 1M return at/below → knife
  R3M_MAX: -20, // 3M return at/below → knife
  PX_OVER_52WH_MAX: 0.7, // price/52w-high below → knife (deep drawdown leg)
  R7D_MAX: -7, // 7D return at/below → knife (fresh leg down)
  // Slow-bleeder: steady FLAIR-style slide that trips none of the sharp legs.
  // {1M,3M,6M} all negative AND 3M universe percentile below cutoff.
  // 6M is optional on served rows — engine degrades to {1M,3M} + percentile with a reason code.
  SLOW_BLEEDER_PCT3M_MAX: 0.25,
};

// Hysteresis: once in FALLING_KNIFE, exit only when 1M has recovered to at least this
// (asymmetric vs the -12 entry) AND no other knife leg still fires. Prevents badge flip-flop.
export const KNIFE_EXIT = {
  R1M_MIN: -9,
};

// ENTRY_CONFIRMED — all legs must hold (AND).
export const CONFIRMED = {
  R1M_MIN: 0, // absolute momentum floor: 1M return strictly positive
  PCT3M_MIN: 0.5, // 3M return at/above universe median
  PX_OVER_52WL_MIN: 1.05, // price at least 5% above 52w low (off-the-floor clearance)
};

// MACRO_DEFER — regime severity + sector impact join (macroRegime.sectorImpacts is an ARRAY
// of {sector, impact, reason}; caller resolves the row's normalized sector to an impact).
export const MACRO_DEFER = {
  SEVERITY_MIN: 4,
  SECTOR_IMPACT_MAX: -2,
};

// Staged-buy ladder (tranchePlanBuilder). Split is front-loaded: T1 fires on confirmation only.
export const TRANCHES = {
  SPLIT: [0.4, 0.35, 0.25], // parked decision #2 — tunable
  DEEP_SPLIT: [0.5, 0.5], // DEEP_BELOW_BAND collapse (px already < 0.75×FV)
  MAE_SEED_PCT: 8, // median post-flag MAE seed until PR-1 measures it
  T2_MAE_MULT: 1, // T2 = anchor × (1 − mae)
  T3_MAE_MULT: 2, // T3 = min(0.75×FV, anchor × (1 − 2×mae))
  DEEP_T2_MAE_MULT: 1.5, // collapsed T2 = anchor × (1 − 1.5×mae)
  T3_FV_MULT: 0.75, // buy-zone-low anchor for T3 cap
};

export const INVALIDATION = {
  ANCHOR_MULT: 0.92, // Tier-1 floor candidate: 0.92×anchor
  ATR_MULT: 2.5, // Tier-2: atrStopPrice(anchor, atr14, 2.5)
  // Tier-1 coherence cap: a stop above the final planned add is incoherent (you'd be
  // stopped out before completing the plan). Non-ATR invalidation is therefore capped
  // at lowest-rung × this. Real-data smoke 2026-07-03: without this cap, 25/25 live
  // buy-now plans refused (0.92×anchor > the 0.84×anchor deepest rung at seed MAE).
  // ATR-based stops are NOT capped — a vol-stop above the ladder is a genuine
  // "plan incoherent for this volatility" refusal signal.
  BELOW_LADDER_MULT: 0.96,
};

// Alerting
export const ALERT_DWELL_NIGHTS = 2; // state must hold 2 consecutive nights before alertable

// Reason codes (strings on rows; display copy lives client-side)
export const REASON = {
  KNIFE_1M: "knife_1m",
  KNIFE_3M: "knife_3m",
  KNIFE_52W_HIGH: "knife_52w_drawdown",
  KNIFE_7D: "knife_7d",
  KNIFE_SLOW_BLEEDER: "knife_slow_bleeder",
  KNIFE_HELD_HYSTERESIS: "knife_held_hysteresis",
  CONFIRMED_ALL: "confirmed_momentum_base",
  MACRO_DEFER: "macro_defer_sector",
  NO_RETURNS: "no_returns_data",
  DEGRADED_NO_52W: "degraded_no_52w",
  DEGRADED_NO_6M: "degraded_no_6m",
  DEGRADED_NO_PERCENTILE: "degraded_no_percentile",
  TIER2_UNCONFIRMED: "tier2_confirm_failed",
};

// Tier-2 confirmation gate (fresh technicals present): ENTRY_CONFIRMED additionally
// requires price above the 50-DMA and RSI-14 inside a healthy band — oversold has
// not proven the turn, overbought is a chase. Demote-only (never promotes) so the
// technicals layer can only make the signal MORE conservative.
export const TIER2_CONFIRM = {
  RSI_MIN: 45,
  RSI_MAX: 70,
};
