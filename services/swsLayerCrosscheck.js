// Layer-2 independent-fundamentals cross-check for the SWS holding engine.
//
// SWS gives one opinion (Snowflake + AnalystConsensus FV). This module asks
// our own 6-pillar scorer (fundamentalsV2.js, snapshot in fundamentals.json)
// for a second opinion and reports where the two layers agree, where they
// diverge, and a single signed confidence_delta the v2 conviction engine
// (shipping in PR 3) will use to bias the action band up/down.
//
// Shadow attach only — this module never overrides an SWS verdict on its own.
// It exposes data the conviction engine consumes. Today we just bolt the
// `crosscheck` block onto each holding's `sws.crosscheck` field so the UI
// and the divergence-monitoring smoke test (scripts/smoke-sws-crosscheck.mjs)
// can read it.
//
// Pillar mapping — SWS Snowflake (0..6) is normalised to 0..100 and compared
// to fundamentalsV2's pillar scores (already 0..100). The 5 SWS pillars line
// up 1:1 with V2's first 5 pillars; V2's Governance pillar is surfaced raw
// (no SWS equivalent — wired into the Indian-risk layer in PR 2).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreFundamentalsV2 } from "../fundamentalsV2.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNDAMENTALS_PATH = path.resolve(__dirname, "..", "fundamentals.json");

let _fundCache = null; // { mtimeMs, snapshots: { [symbol]: snap } }

// Load fundamentals.json once and cache against its mtime so a cron refresh
// (scripts/refresh-fundamentals.mjs) propagates without a server restart.
// Returns null if the file is missing — every consumer must handle that.
function loadFundamentals() {
  let stat;
  try { stat = fs.statSync(FUNDAMENTALS_PATH); } catch { return null; }
  if (_fundCache && _fundCache.mtimeMs === stat.mtimeMs) return _fundCache.snapshots;
  try {
    const raw = JSON.parse(fs.readFileSync(FUNDAMENTALS_PATH, "utf-8"));
    const snapshots = raw?.snapshots || {};
    _fundCache = { mtimeMs: stat.mtimeMs, snapshots };
    return snapshots;
  } catch {
    return null;
  }
}

// Normalise a ticker to the form fundamentals.json uses (always `.NS`).
// Portfolio rows surface as `HDFCBANK.NS`; the SWS deep file is keyed bare
// (`HDFCBANK`). We accept either.
function _fundamentalsKey(ticker) {
  if (!ticker) return null;
  let k = String(ticker).trim();
  if (!/\.(NS|BO|BSE|NSE)$/i.test(k)) k = `${k}.NS`;
  return k.replace(/\.(BO|BSE|NSE)$/i, ".NS");
}

// SWS Snowflake pillars are 0..6; fundamentalsV2 pillars are 0..5 (Snowflake-
// equivalent — scoreValue/scoreFuture/etc. all produce values in [0, 5] then
// composite() scales to 0..100 separately). Normalise both to 0..100 so the
// per-pillar deltas are commensurate.
function _swsPillarTo100(v0to6) {
  const n = Number(v0to6);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / 6) * 100);
}

function _v2PillarTo100(v0to5) {
  const n = Number(v0to5);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / 5) * 100);
}

// Per-pillar comparison: agreement when the absolute delta is within 25pts
// on the 0..100 scale (≈1.5 SWS-Snowflake pillar steps). Divergence carries
// a direction so the conviction engine can tell whether Layer 2 is more
// bullish or more bearish than SWS on that pillar.
function _comparePillar(pillarName, swsScore0to100, indepScore0to100) {
  if (swsScore0to100 == null || indepScore0to100 == null) {
    return {
      pillar: pillarName,
      sws_0_100: swsScore0to100,
      indep_0_100: indepScore0to100,
      agreement: null,
      delta: null,
      direction: "n/a",
    };
  }
  const delta = indepScore0to100 - swsScore0to100;
  const agreement = Math.abs(delta) <= 25;
  let direction = "aligned";
  if (!agreement) direction = delta > 0 ? "indep_more_bullish" : "indep_more_bearish";
  return {
    pillar: pillarName,
    sws_0_100: swsScore0to100,
    indep_0_100: indepScore0to100,
    agreement,
    delta,
    direction,
  };
}

// Translate the per-pillar agreement matrix into a single signed signal the
// conviction engine consumes. Logic mirrors the spec agreed in the v2 plan:
//   agreement_pct >= 80 → +1 (Layer 2 strongly confirms SWS, raise conviction)
//   agreement_pct <= 40 → -1 (Layer 2 disagrees materially, soften the action)
//   else                → 0  (mixed — leave conviction band unchanged)
//
// Tie-break with the composite-score gap as a guard: even at 60% pillar
// agreement, if the two composites diverge by >25 points we still emit -1.
// That catches cases where SWS and V2 happen to land on similar pillar
// distributions but very different overall verdicts (e.g. SWS missing a
// hard-override that V2 caught via Governance pillar).
function _confidenceDelta(agreementPct, swsCompositeV3, indepComposite100) {
  if (agreementPct == null) return 0;
  if (agreementPct >= 80) return +1;
  if (agreementPct <= 40) return -1;
  if (
    swsCompositeV3 != null &&
    indepComposite100 != null &&
    Math.abs(indepComposite100 - swsCompositeV3) > 25
  ) {
    return -1;
  }
  return 0;
}

// Human-readable single-line summary the UI surfaces under the conviction
// badge. Designed to make sense even if the user never expands the layer
// detail — i.e. it must answer "did the second layer agree?".
function _buildReasonText({
  agreementCount,
  comparableCount,
  divergentPillars,
  governance,
  swsCompositeV3,
  indepComposite100,
}) {
  if (comparableCount === 0) {
    return "Independent layer unavailable — no comparable pillars.";
  }
  const head = `Independent fundamentals agree on ${agreementCount}/${comparableCount} pillars`;
  const compTail =
    swsCompositeV3 != null && indepComposite100 != null
      ? ` (composite: SWS v3 ${swsCompositeV3.toFixed(0)} vs Indep ${indepComposite100.toFixed(0)})`
      : "";
  if (divergentPillars.length === 0) return `${head}${compTail}.`;
  const list = divergentPillars
    .map((p) => `${p.pillar} (${p.direction === "indep_more_bullish" ? "+" : ""}${p.delta})`)
    .join(", ");
  const govTail =
    governance && governance.score != null && governance.score < 30
      ? ` Governance pillar weak (${governance.score}/100).`
      : "";
  return `${head}${compTail}. Divergent: ${list}.${govTail}`;
}

// Cross-check entrypoint. Inputs:
//   ticker          — string, accepted in .NS or bare form
//   swsSnowflake    — { valuation, future_growth, past_performance,
//                       financial_health, dividends } per pickSnowflake()
//   swsV3Score      — number 0..100 (the v3 score the action engine drives off)
//
// Output: see file header. Always returns an object, never throws.
export function crosscheckHolding({ ticker, swsSnowflake, swsV3Score }) {
  const key = _fundamentalsKey(ticker);
  if (!key) {
    return { available: false, reason: "ticker missing", confidence_delta: 0 };
  }
  const snapshots = loadFundamentals();
  if (!snapshots) {
    return { available: false, reason: "fundamentals.json missing", confidence_delta: 0 };
  }
  const snap = snapshots[key];
  if (!snap) {
    return { available: false, reason: `no snapshot for ${key}`, confidence_delta: 0 };
  }

  let v2;
  try {
    v2 = scoreFundamentalsV2(snap);
  } catch (err) {
    return {
      available: false,
      reason: `v2 scorer error: ${err.message}`,
      confidence_delta: 0,
    };
  }
  if (!v2) {
    return { available: false, reason: "v2 returned null", confidence_delta: 0 };
  }

  const indepComposite100 = v2.score ?? null;
  const indepVerdict = v2.verdict ?? null;
  const pillars = v2.pillars || {};

  const sws = swsSnowflake || {};
  const comparison = [
    _comparePillar("valuation", _swsPillarTo100(sws.valuation), _v2PillarTo100(pillars.value?.score)),
    _comparePillar("future", _swsPillarTo100(sws.future_growth), _v2PillarTo100(pillars.future?.score)),
    _comparePillar("past", _swsPillarTo100(sws.past_performance), _v2PillarTo100(pillars.past?.score)),
    _comparePillar("health", _swsPillarTo100(sws.financial_health), _v2PillarTo100(pillars.health?.score)),
    _comparePillar("dividends", _swsPillarTo100(sws.dividends), _v2PillarTo100(pillars.dividend?.score)),
  ];

  const comparable = comparison.filter((c) => c.agreement !== null);
  const agreementCount = comparable.filter((c) => c.agreement === true).length;
  const comparableCount = comparable.length;
  const agreementPct = comparableCount === 0 ? null : Math.round((agreementCount / comparableCount) * 100);
  const divergentPillars = comparable.filter((c) => c.agreement === false);

  const governance = pillars.governance
    ? {
        score: _v2PillarTo100(pillars.governance.score),
        grade: pillars.governance.grade ?? null,
        signals: pillars.governance.signals || [],
        coverage: pillars.governance.coverage ?? null,
      }
    : null;

  const confidenceDelta = _confidenceDelta(agreementPct, swsV3Score, indepComposite100);

  return {
    available: true,
    independent_score: indepComposite100,
    independent_verdict: indepVerdict,
    scorer_version: v2.scorerVersion,
    sector_kind: v2.sectorKind ?? null,
    pillar_comparison: comparison,
    pillar_agreement_count: agreementCount,
    pillar_comparable_count: comparableCount,
    pillar_agreement_pct: agreementPct,
    divergent_pillars: divergentPillars.map((d) => ({
      pillar: d.pillar,
      delta: d.delta,
      direction: d.direction,
    })),
    governance,
    confidence_delta: confidenceDelta,
    reason: _buildReasonText({
      agreementCount,
      comparableCount,
      divergentPillars,
      governance,
      swsCompositeV3: swsV3Score,
      indepComposite100,
    }),
  };
}
