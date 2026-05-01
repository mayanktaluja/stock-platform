// SEBI audit-trail builder for the v2 SWS recommender.
//
// SEBI Investment Adviser Regulations 2013 Reg 15(2) and Research Analyst
// Regulations 2014 Reg 16(1) require recommendation traceability to source
// data and time-stamped reasoning. This module builds a per-holding audit
// blob the engine attaches to every verdict so an SEBI auditor (or the
// user themselves, for self-audit) can reconstruct the decision from raw
// inputs.
//
// Pure metadata — never affects the verdict. Adds ~1KB per holding to
// the API response.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { num } from "./swsScoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEEP_DIR = path.resolve(__dirname, "..", "data", "sws", "deep");
const FUNDAMENTALS_PATH = path.resolve(__dirname, "..", "fundamentals.json");
const PICKS_LATEST = path.resolve(__dirname, "..", "data", "sws", "picks-latest.json");

// Engine + layer model versions. Bump these when the math changes so
// audit consumers can detect a model migration in their snapshot diff.
const VERSIONS = {
  engine: "sws-v2.0",
  sws_scoring: "v3-100pt-2026-04",
  layer2_crosscheck: "v2-shadow-apr2026",
  layer3_indianrisk: "indian-risk-v1",
  layer4_catalyst: "catalyst-v1",
  layer5_peer: "peer-v1",
  conviction: "v2-conviction-2026-04",
  fallback: "v2-fallback-2026-04",
  combined_score: "combined-v1-2026-04",
};

function _statSafe(p) {
  try {
    const s = fs.statSync(p);
    return { mtime: s.mtimeMs ? new Date(s.mtimeMs).toISOString() : null, size: s.size };
  } catch { return { mtime: null, size: null }; }
}

function _swsKey(t) {
  if (!t) return null;
  return String(t).trim().replace(/\.(NS|BO|BSE|NSE)$/i, "");
}
function _nseKey(t) {
  if (!t) return null;
  let k = String(t).trim();
  if (!/\.(NS|BO|BSE|NSE)$/i.test(k)) k = `${k}.NS`;
  return k.replace(/\.(BO|BSE|NSE)$/i, ".NS");
}

function _layerSources(ticker) {
  const swsKey = _swsKey(ticker);
  const nseKey = _nseKey(ticker);
  return {
    sws_deep: {
      file: swsKey ? `data/sws/deep/${swsKey}.json` : null,
      ..._statSafe(swsKey ? path.join(DEEP_DIR, `${swsKey}.json`) : ""),
    },
    fundamentals_snapshot: {
      file: "fundamentals.json",
      key: nseKey,
      ..._statSafe(FUNDAMENTALS_PATH),
    },
    picks_universe: {
      file: "data/sws/picks-latest.json",
      ..._statSafe(PICKS_LATEST),
    },
    surveillance_list: {
      file: "surveillance.json",
      ..._statSafe(path.resolve(__dirname, "..", "surveillance.json")),
    },
  };
}

// Build the per-holding decision-path array — a step-by-step trace of how
// the engine arrived at the action. Each step is a short string the user
// can read to understand the reasoning chain.
function _decisionPath({ holding, scored }) {
  const sws = holding.sws || {};
  const rec = sws.v2_recommendation || null;
  const path = [];

  path.push(`SWS v3 score: ${num(sws.v3_score, null)?.toFixed?.(1) ?? "—"} (verdict: ${sws.v3_verdict || "—"})`);
  path.push(`v1 SWS-only action: ${rec?.action_source === "guardrail" ? "(skipped — guardrail)" : holding.action || "—"}`);

  if (sws.crosscheck?.available) {
    path.push(`Layer 2 (cross-check): ${sws.crosscheck.pillar_agreement_pct}% agreement, Δconf ${sws.crosscheck.confidence_delta > 0 ? "+" : ""}${sws.crosscheck.confidence_delta}`);
  } else {
    path.push(`Layer 2 (cross-check): unavailable`);
  }
  if (sws.catalyst?.available) {
    path.push(`Layer 4 (catalyst): score ${sws.catalyst.catalystScore >= 0 ? "+" : ""}${sws.catalyst.catalystScore}/10, Δconf ${sws.catalyst.confidence_delta > 0 ? "+" : ""}${sws.catalyst.confidence_delta}`);
  }
  if (sws.indianRisk?.available) {
    path.push(`Layer 3 (India-risk): score ${sws.indianRisk.risk_score}/-25, Δconf ${sws.indianRisk.confidence_delta > 0 ? "+" : ""}${sws.indianRisk.confidence_delta}`);
  }
  if (rec) {
    path.push(`Net layer delta: ${rec.net_delta > 0 ? "+" : ""}${rec.net_delta} → conviction ${rec.conviction}`);
    if (rec.action_source === "guardrail") {
      path.push(`Position guardrail triggered: ${rec.guardrail_reason}`);
    } else if (rec.action !== holding.action) {
      path.push(`Layer-adjusted action: ${holding.action}`);
    }
  }
  if (holding.fallback) {
    path.push(`Fallback path used: source = ${holding.fallback_source}`);
  }
  return path;
}

// Build the citation list — the specific source data points the verdict
// rests on. Each citation is { claim, source_file, json_path, value }.
function _citations({ holding, scored }) {
  const sws = holding.sws || {};
  const ticker = sws.ticker || _swsKey(holding.symbol);
  const swsFile = ticker ? `data/sws/deep/${ticker}.json` : null;
  const cites = [];

  if (swsFile && sws.snowflake) {
    cites.push({
      claim: `SWS Snowflake total ${sws.snowflake.total}/30`,
      source_file: swsFile, json_path: "overview.snowflake_total", value: sws.snowflake.total,
    });
  }
  if (swsFile && sws.fair_value_inr != null) {
    cites.push({
      claim: `AnalystConsensus FV ₹${sws.fair_value_inr.toFixed(0)}`,
      source_file: swsFile, json_path: "overview.fair_value_inr", value: sws.fair_value_inr,
    });
  }
  if (sws.crosscheck?.available && sws.crosscheck.independent_score != null) {
    cites.push({
      claim: `Independent V2 composite ${sws.crosscheck.independent_score}/100`,
      source_file: "fundamentals.json", json_path: `snapshots[${_nseKey(ticker)}]`, value: sws.crosscheck.independent_score,
    });
  }
  if (sws.indianRisk?.surveillance) {
    cites.push({
      claim: `NSE ${sws.indianRisk.surveillance.list} surveillance${sws.indianRisk.surveillance.timeframe ? ` (${sws.indianRisk.surveillance.timeframe})` : ""}`,
      source_file: "surveillance.json", json_path: `flagged[${_nseKey(ticker)}]`, value: sws.indianRisk.surveillance,
    });
  }
  if (sws.peer_substitute?.top_peer) {
    cites.push({
      claim: `Peer substitute: ${sws.peer_substitute.top_peer.ticker} (v3 ${sws.peer_substitute.top_peer.v3_score})`,
      source_file: "data/sws/picks-latest.json", json_path: `sections[*]`, value: sws.peer_substitute.top_peer.ticker,
    });
  }
  return cites;
}

const SEBI_DISCLAIMER = "Automated analytical extraction + classification of publicly-available data. Not personalised investment advice under SEBI IA Regulations 2013 / RA Regulations 2014. User retains responsibility for final transaction decisions; verify with own RIA/RA/CA before acting.";

export function buildAuditTrail({ holding, scored, recommenderMode, combinedScoreAudit = null }) {
  const ticker = holding?.sws?.ticker || _swsKey(holding?.symbol);
  return {
    schema_version: "audit-v1",
    generated_at: new Date().toISOString(),
    recommender_mode: recommenderMode,
    versions: VERSIONS,
    layer_sources: _layerSources(ticker),
    decision_path: _decisionPath({ holding, scored }),
    citations: _citations({ holding, scored }),
    // Combined Score audit — populated by callers that have computed a
    // Tech+Fund+SWS combined score (currently only the scanner endpoints,
    // which build one per pick via services/combinedScore.js::buildCombinedAudit).
    // Holding-level audit (called from swsHoldingEngine) leaves this null
    // because portfolio actions don't currently consume the combined score.
    // Additive — doesn't break existing readers. SEBI RA Reg 2014 Reg 16(1).
    combined_score_audit: combinedScoreAudit,
    sebi_disclaimer: SEBI_DISCLAIMER,
  };
}

export function buildReportAuditTrail({ snapshot, recommenderMode }) {
  return {
    schema_version: "report-audit-v1",
    generated_at: new Date().toISOString(),
    recommender_mode: recommenderMode,
    versions: VERSIONS,
    holdings_count: snapshot?.holdingsCount ?? null,
    sws_covered_count: snapshot?.coveredCount ?? null,
    sebi_disclaimer: SEBI_DISCLAIMER,
  };
}

export const SWS_VERSIONS = VERSIONS;
