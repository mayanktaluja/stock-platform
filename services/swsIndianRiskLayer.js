// Layer-3 India-specific risk extraction for the SWS holding engine.
//
// Pulls the regulatory + governance signals that materially predict
// drawdown risk on Indian equities but aren't captured in SWS:
//   • NSE ASM/GSM surveillance (already wired into v3 overlay; surfaced
//     here for transparency + conviction nudging)
//   • Promoter-pledge & promoter-stake delta (governance.js — currently
//     stub-only; real fetcher lands separately. Layer is null-safe.)
//   • FII/DII shift QoQ (also from governance.js when populated)
//   • Beta-sensitivity flag (volatility risk)
//
// Shadow attach only — never overrides the SWS verdict. The conviction
// engine (PR 3) reads `confidence_delta` and `risk_flags`.

import { num } from "./swsScoring.js";

let _getSurveillanceFlag = () => null;
let _getGovernance = () => null;
try {
  const surv = await import("../surveillance.js");
  if (typeof surv.getSurveillanceFlag === "function") _getSurveillanceFlag = surv.getSurveillanceFlag;
} catch {}
try {
  const gov = await import("../governance.js");
  if (typeof gov.getGovernance === "function") _getGovernance = gov.getGovernance;
} catch {}

// Risk-score deltas. All summed and clamped to [-25, 0]. The score is
// purely subtractive — no positive "all-clear" rewards. Direction matches
// fundamentalsV2.scoreGovernance and the v3 overlay so the three layers
// stay numerically aligned.
const SURV_GSM_PENALTY = -15;
const SURV_ASM_SHORT_PENALTY = -12;
const SURV_ASM_LONG_PENALTY = -10;
const PLEDGE_HEAVY_PENALTY = -8;     // pledge_pct > 0.30
const PLEDGE_MODERATE_PENALTY = -4;  // pledge_pct > 0.10
const PLEDGE_DELTA_UP_PENALTY = -3;  // pledge increased QoQ
const PROMOTER_TRIM_PENALTY = -3;    // promoter holding decreased QoQ
const FII_HEAVY_FLIGHT_PENALTY = -3; // FII reduced > 5pp QoQ
const HIGH_BETA_PENALTY = -2;        // beta > 1.5
const RPT_FLAG_PENALTY = -3;         // related-party transactions flag

function _toNseKey(symbol) {
  if (!symbol) return null;
  let k = String(symbol).trim().toUpperCase();
  if (!/\.(NS|BO|BSE|NSE)$/.test(k)) k = `${k}.NS`;
  return k.replace(/\.(BO|BSE|NSE)$/, ".NS");
}

function _surveillanceContribution(flag) {
  if (!flag) return { delta: 0, flag: null, label: null };
  if (flag.list === "GSM") {
    return {
      delta: SURV_GSM_PENALTY,
      flag,
      label: `NSE GSM surveillance${flag.stage ? ` Stage ${flag.stage}` : ""} — circuit filters tightened, regulatory red flag.`,
    };
  }
  if (flag.list === "ASM") {
    const tf = flag.timeframe || "longterm";
    const delta = tf === "shortterm" ? SURV_ASM_SHORT_PENALTY : SURV_ASM_LONG_PENALTY;
    return {
      delta,
      flag,
      label: `NSE ASM ${tf} surveillance — elevated regulatory scrutiny, position-sizing caution.`,
    };
  }
  return { delta: 0, flag, label: null };
}

function _pledgeContribution(gov) {
  if (!gov) return { delta: 0, contributions: [] };
  const out = [];
  let delta = 0;
  const pledge = num(gov.promoterPledge ?? gov.pledgeOfTotal ?? null, null);
  const pledgeDelta = num(gov.promoterPledgeDeltaQoQ ?? null, null);
  const promDelta = num(gov.promoterHoldingDeltaQoQ ?? null, null);
  const fiiDelta = num(gov.fiiHoldingDeltaQoQ ?? null, null);
  const rpt = num(gov.rptAsPctRevenue ?? null, null);

  if (pledge != null && pledge > 0.30) {
    delta += PLEDGE_HEAVY_PENALTY;
    out.push({ kind: "pledge_heavy", text: `Promoter pledge ${(pledge * 100).toFixed(1)}% — forced-selling cascade risk.`, delta: PLEDGE_HEAVY_PENALTY });
  } else if (pledge != null && pledge > 0.10) {
    delta += PLEDGE_MODERATE_PENALTY;
    out.push({ kind: "pledge_moderate", text: `Promoter pledge ${(pledge * 100).toFixed(1)}% — monitor quarterly filings.`, delta: PLEDGE_MODERATE_PENALTY });
  }
  if (pledgeDelta != null && pledgeDelta > 0.02) {
    delta += PLEDGE_DELTA_UP_PENALTY;
    out.push({ kind: "pledge_increasing", text: `Pledge up ${(pledgeDelta * 100).toFixed(1)}pp QoQ — leading indicator of stress.`, delta: PLEDGE_DELTA_UP_PENALTY });
  }
  if (promDelta != null && promDelta < -0.01) {
    delta += PROMOTER_TRIM_PENALTY;
    out.push({ kind: "promoter_trim", text: `Promoter trimmed ${(Math.abs(promDelta) * 100).toFixed(1)}pp QoQ — confidence signal.`, delta: PROMOTER_TRIM_PENALTY });
  }
  if (fiiDelta != null && fiiDelta < -0.05) {
    delta += FII_HEAVY_FLIGHT_PENALTY;
    out.push({ kind: "fii_flight", text: `FII reduced ${(Math.abs(fiiDelta) * 100).toFixed(1)}pp QoQ — risk-off pressure.`, delta: FII_HEAVY_FLIGHT_PENALTY });
  }
  if (rpt != null && rpt > 0.15) {
    delta += RPT_FLAG_PENALTY;
    out.push({ kind: "rpt_flag", text: `Related-party transactions ${(rpt * 100).toFixed(1)}% of revenue — earnings-quality flag.`, delta: RPT_FLAG_PENALTY });
  }
  return { delta, contributions: out };
}

function _betaContribution(deep) {
  const beta = num(deep?.overview?.beta, null);
  if (beta != null && beta > 1.5) {
    return { delta: HIGH_BETA_PENALTY, label: `High beta ${beta.toFixed(2)} — drawdown amplification.` };
  }
  return { delta: 0, label: null };
}

// Layer-3 → conviction nudge. Risk score lives in [-25, 0], so:
//   risk_score <= -10  → -1 (material risk overlay, soften the action)
//   risk_score >= -3   →  0 (negligible — no signal)
//   else               → -1 still (any non-trivial Indian-risk overlay
//                              biases toward caution; this layer never
//                              upgrades conviction)
function _confidenceDelta(riskScore) {
  if (riskScore == null) return 0;
  if (riskScore >= -3) return 0;
  return -1;
}

function _buildSummary({ riskScore, surveillanceLabel, pledgeContribs, betaLabel }) {
  const labels = [];
  if (surveillanceLabel) labels.push(surveillanceLabel);
  for (const c of pledgeContribs) labels.push(c.text);
  if (betaLabel) labels.push(betaLabel);
  if (labels.length === 0) return "No India-specific risk overlays.";
  return `Risk overlay ${riskScore}/−25: ${labels.join(" ")}`;
}

// Indian-risk layer entrypoint. Inputs:
//   ticker — string, accepted in .NS or bare form
//   deep   — the SWS deep snapshot (read for beta only)
//
// Always returns a populated object — never throws.
export function extractIndianRiskSignals({ ticker, deep }) {
  const key = _toNseKey(ticker);
  if (!key) return { available: false, reason: "ticker missing", risk_score: 0, confidence_delta: 0, risk_flags: [] };

  const survFlag = _getSurveillanceFlag(key);
  const surv = _surveillanceContribution(survFlag);

  const govSnap = _getGovernance(key);
  const pledge = _pledgeContribution(govSnap);

  const beta = _betaContribution(deep);

  const riskScore = Math.max(-25, surv.delta + pledge.delta + beta.delta);

  const flags = [];
  if (surv.label) flags.push({ kind: "surveillance", text: surv.label, delta: surv.delta });
  for (const c of pledge.contributions) flags.push(c);
  if (beta.label) flags.push({ kind: "high_beta", text: beta.label, delta: HIGH_BETA_PENALTY });

  return {
    available: true,
    risk_score: riskScore,
    confidence_delta: _confidenceDelta(riskScore),
    surveillance: survFlag,
    governance_snapshot: govSnap
      ? {
          promoter_holding: govSnap.promoterHolding ?? null,
          promoter_pledge: govSnap.promoterPledge ?? null,
          fii_holding: govSnap.fiiHolding ?? null,
          dii_holding: govSnap.diiHolding ?? null,
          as_of_quarter: govSnap.asOfQuarter ?? null,
        }
      : null,
    governance_available: !!govSnap,
    risk_flags: flags,
    summary: _buildSummary({
      riskScore,
      surveillanceLabel: surv.label,
      pledgeContribs: pledge.contributions,
      betaLabel: beta.label,
    }),
  };
}
