// Regime gate — refuses Pillar 1 multibagger entries when the macro
// regime is unfavourable. Solves the 2022/2025 problem of "the strategy
// didn't know it was a bad year."
//
// Block rules:
//   - macroRegime.regime === "RISK_OFF" → block all new entries
//   - macroRegime.severity ≥ HIGH_SEVERITY → block Anchor / High tiers
//   - Nifty Smallcap 250 trailing 90d return < -10% → block Pillar 1
//     (optional; pass null to skip this check)
//
// Catalyst trades (Pillar 2) and Sector tilt (Pillar 3) are still
// allowed under most regimes — they have shorter horizons and built-in
// stops. Caller decides whether to apply this gate per pillar.

const BLOCKED_REGIMES = new Set(["RISK_OFF"]);
const HIGH_SEVERITY = 4;
const SMALLCAP_DRAWDOWN_FLOOR_PCT = -10;

const TIERS_BLOCKED_AT_HIGH_SEVERITY = new Set(["anchor", "high"]);

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function normaliseRegime(r) {
  return String(r || "").toUpperCase();
}

// Verdict shape: { pass, reasons, regime, severity, smallcap_90d_return_pct, applied_tier }.
export function evaluateRegime({ macroRegime, smallcap_90d_return_pct = null, tier = "high" } = {}) {
  const regime = normaliseRegime(macroRegime?.regime);
  const severity = isFiniteNumber(macroRegime?.severity) ? macroRegime.severity : null;
  const tierKey = String(tier || "").toLowerCase();
  const reasons = [];

  if (!macroRegime || !regime) {
    reasons.push("regime_unknown");
  }
  if (BLOCKED_REGIMES.has(regime)) {
    reasons.push(`regime_${regime.toLowerCase()}_blocked`);
  }
  if (severity !== null && severity >= HIGH_SEVERITY && TIERS_BLOCKED_AT_HIGH_SEVERITY.has(tierKey)) {
    reasons.push(`severity_${severity}_blocks_${tierKey}_tier`);
  }
  if (isFiniteNumber(smallcap_90d_return_pct) && smallcap_90d_return_pct < SMALLCAP_DRAWDOWN_FLOOR_PCT) {
    reasons.push(`smallcap_90d_return_${Math.round(smallcap_90d_return_pct)}pct_below_floor`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
    regime: regime || null,
    severity,
    smallcap_90d_return_pct: isFiniteNumber(smallcap_90d_return_pct) ? smallcap_90d_return_pct : null,
    applied_tier: tierKey,
  };
}

// Convenience: which pillars are open for new entries given a regime.
// Returns a record of pillar → { open, reasons }.
export function pillarsOpen({ macroRegime, smallcap_90d_return_pct = null } = {}) {
  const p1Anchor = evaluateRegime({ macroRegime, smallcap_90d_return_pct, tier: "anchor" });
  const p1High = evaluateRegime({ macroRegime, smallcap_90d_return_pct, tier: "high" });
  const p1Conv = evaluateRegime({ macroRegime, smallcap_90d_return_pct, tier: "conviction" });
  const p2 = evaluateRegime({ macroRegime, smallcap_90d_return_pct, tier: "catalyst" });
  const p3 = evaluateRegime({ macroRegime, smallcap_90d_return_pct, tier: "sector" });
  return {
    pillar1_anchor: { open: p1Anchor.pass, reasons: p1Anchor.reasons },
    pillar1_high: { open: p1High.pass, reasons: p1High.reasons },
    pillar1_conviction: { open: p1Conv.pass, reasons: p1Conv.reasons },
    pillar2_catalyst: { open: p2.pass, reasons: p2.reasons },
    pillar3_sector: { open: p3.pass, reasons: p3.reasons },
  };
}

export const REGIME_GATE_CONFIG = Object.freeze({
  BLOCKED_REGIMES: Array.from(BLOCKED_REGIMES),
  HIGH_SEVERITY,
  SMALLCAP_DRAWDOWN_FLOOR_PCT,
});
