// Compounder Lab — per-position trim/exit signal.
//
// Evaluated against the latest SWS snapshot every quarterly review. Returns
// one of: HOLD | TRIM_50 | EXIT, with a reason. Per the SAFE sleeve spec in
// the main plan:
//   - TRIM_50 when upside_pct ≤ -10%
//   - EXIT when snowflake_health drops between snapshots
//   - EXIT when a new debt/liquidity risk appears in risks[]
//   - HOLD otherwise

export const TRIM_THRESHOLDS = Object.freeze({
  trim_upside_pct_max: -10,
  // Forbidden new-risk keywords — same hard-rejection list as the entry
  // filter, but applied as an EXIT trigger when they appear after entry.
  exit_new_risk_keywords: Object.freeze([
    "interest payments are not well covered",
    "debt is not well covered",
    "high level of debt",
    "unprofitable",
  ]),
});

function hasDebtRisk(risks, keywords) {
  const lowered = (Array.isArray(risks) ? risks : []).map((r) =>
    String(r || "").toLowerCase(),
  );
  return keywords.find((kw) => lowered.some((r) => r.includes(kw))) || null;
}

// position:  { entry_snowflake_health: number, entry_risks: string[] }
// current:   { upside_pct, snowflake_health, risks: string[] }
export function evaluateTrimSignal(position, current, opts = TRIM_THRESHOLDS) {
  if (!position || !current) {
    return { action: "HOLD", reason: "insufficient-data" };
  }

  const curHealth = Number(current.snowflake_health);
  const entryHealth = Number(position.entry_snowflake_health);
  if (
    Number.isFinite(curHealth) &&
    Number.isFinite(entryHealth) &&
    curHealth < entryHealth
  ) {
    return {
      action: "EXIT",
      reason: `snowflake_health dropped ${entryHealth} → ${curHealth}`,
    };
  }

  // EXIT on a *newly* present debt/liquidity risk that wasn't there at entry.
  const entryRiskHit = hasDebtRisk(
    position.entry_risks,
    opts.exit_new_risk_keywords,
  );
  const currentRiskHit = hasDebtRisk(current.risks, opts.exit_new_risk_keywords);
  if (currentRiskHit && !entryRiskHit) {
    return { action: "EXIT", reason: `new-risk:${currentRiskHit}` };
  }

  const upside = Number(current.upside_pct);
  if (Number.isFinite(upside) && upside <= opts.trim_upside_pct_max) {
    return { action: "TRIM_50", reason: `upside ${upside}% ≤ ${opts.trim_upside_pct_max}%` };
  }

  return { action: "HOLD", reason: "ok" };
}
