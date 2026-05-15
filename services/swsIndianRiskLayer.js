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

// Hard-gate thresholds (separate from the soft score penalties above).
// These thresholds promote a position to a REVIEW verdict in the action
// engine — they exist BECAUSE the −4/−8 score penalties never override a
// 70-score pick, which is exactly the trap that caught Vedanta (2021),
// Zee (2022), and Yes Bank (2020) holders. For Indian small/mid caps,
// promoter-pledge spikes have historically preceded forced-sale cascades
// that the technical scoreboard masks.
//
// Values are ratios (matching governance.js shape: 0.25 = 25%).
const GATE_PLEDGE_HARD = 0.25;       // pledge ≥ 25% of promoter stake
const GATE_PLEDGE_DELTA_HARD = 0.05; // pledge up >5pp QoQ
const GATE_STALENESS_DAYS = 120;     // skip gate if filing > 120d old

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

// Parse the NSE shareholding `asOfQuarter` label ("Q4FY26") into the
// calendar end-date of that fiscal quarter. Indian FYxx runs Apr (prev
// year) → Mar (yyxx); Q1 ends Jun 30, Q2 Sep 30, Q3 Dec 31, Q4 Mar 31.
// Returns null when the label is malformed (we'd rather skip the gate
// than fire on garbage data).
function _parseAsOfQuarter(asOfQuarter) {
  if (!asOfQuarter || typeof asOfQuarter !== "string") return null;
  const m = asOfQuarter.trim().toUpperCase().match(/^Q([1-4])FY(\d{2})$/);
  if (!m) return null;
  const q = parseInt(m[1], 10);
  const fyYY = parseInt(m[2], 10);
  if (!Number.isFinite(q) || !Number.isFinite(fyYY)) return null;
  const fyEndYear = 2000 + fyYY;                          // FY26 → 2026
  const month = ({ 1: 6, 2: 9, 3: 12, 4: 3 })[q];         // 1-indexed
  const calendarYear = q === 4 ? fyEndYear : fyEndYear - 1;
  // Last day of the month: new Date(y, month, 0).getDate() — month here
  // is 1-indexed because JS Date is 0-indexed for the prev month's day 0.
  const day = new Date(calendarYear, month, 0).getDate();
  return new Date(calendarYear, month - 1, day);
}

// Derive a hard governance gate from a per-symbol governance snapshot.
// Returns null when no gate fires (the common case). Returns a structured
// REVIEW object when:
//   • promoter pledge ≥ 25% of promoter stake (forced-sale risk), OR
//   • pledge increased > 5pp QoQ (leading-indicator stress signal)
// Skipped when the filing is > 120 days stale (asOfQuarter check) — don't
// raise forced-review banners off ancient SEBI Reg 31 data.
//
// The downstream consumer (portfolioIntelligence.computeAction) treats
// this as a pre-check that overrides the P&L-only path. Without it, a
// stock down 5% with 60% pledge would land in HOLD because technicals
// still look fine — exactly the structural blind spot the score-penalty
// layer cannot fix.
export function deriveGovernanceGate(govSnap) {
  if (!govSnap) return null;
  const pledge = num(govSnap.promoterPledge ?? govSnap.pledgeOfTotal ?? null, null);
  const pledgeDelta = num(govSnap.promoterPledgeDeltaQoQ ?? govSnap.pledgeQoQDelta ?? null, null);

  const pledgeBreach = pledge != null && pledge >= GATE_PLEDGE_HARD;
  const deltaBreach = pledgeDelta != null && pledgeDelta > GATE_PLEDGE_DELTA_HARD;
  if (!pledgeBreach && !deltaBreach) return null;

  // Staleness check: skip the gate if the filing is too old to trust.
  // We use the asOfQuarter label rather than file-level fetchedAt
  // because the file may be daily-refreshed while a specific symbol's
  // latest filing is still 2 quarters old (typical for thinly-traded
  // smallcaps that file quarterly with delay).
  const quarterEnd = _parseAsOfQuarter(govSnap.asOfQuarter);
  if (quarterEnd) {
    const ageDays = Math.floor((Date.now() - quarterEnd.getTime()) / 86400000);
    if (ageDays > GATE_STALENESS_DAYS) return null;
  }

  const reason = pledgeBreach
    ? `Promoter pledge ${(pledge * 100).toFixed(1)}% — forced-sale risk`
    : `Pledge spike +${(pledgeDelta * 100).toFixed(1)}pp QoQ — promoter stress signal`;

  return {
    severity: "REVIEW",
    reason,
    pattern: "Vedanta-2021 / Zee-2022 / YesBank-2020 cascade",
    as_of_quarter: govSnap.asOfQuarter ?? null,
    pledge,
    pledge_qoq_delta: pledgeDelta,
  };
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
    governance_gate: deriveGovernanceGate(govSnap),
    risk_flags: flags,
    summary: _buildSummary({
      riskScore,
      surveillanceLabel: surv.label,
      pledgeContribs: pledge.contributions,
      betaLabel: beta.label,
    }),
  };
}
