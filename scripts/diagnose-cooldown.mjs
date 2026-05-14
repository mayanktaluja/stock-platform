#!/usr/bin/env node
// Diagnose why the cooldown gate did/didn't suppress a recommendation.
// Read-only — hits the same KV (or local-file) backends the API uses.
//
// Usage:
//   node scripts/diagnose-cooldown.mjs --sub <userSub> --symbol JWL
//   node scripts/diagnose-cooldown.mjs --sub <userSub> --symbol JWL --json
//
// Prints:
//   • Last two portfolio-history snapshots: asOfDateIso, contentHash,
//     and the holding row for the symbol (qty / isin / avgPrice).
//   • All ledger events for the symbol — ISSUED with qtyAtIssue, EXECUTED
//     with ratio and at-execution context.
//   • Re-runs applyCooldownGate against the latest holding-as-candidate
//     and reports verdict (`gated` / `no_prior_execution` / `outside_window` /
//     `bypass_<reason>`).
//
// When the JWL/TATATECH bug recurs, run this against the live KV: if the
// EXECUTED event is missing, the reconciler didn't see the trim — Layer 2
// (symbol/ISIN fallback) needs another pass.

import "dotenv/config";
import { getPortfolioHistoryStorage } from "../portfolioHistoryStorage.js";
import { getRecommendationLedgerStorage } from "../recommendationLedgerStorage.js";
import {
  applyCooldownGate,
  indexClosedExecutedEvents,
  actionDirection,
  symbolKey,
  normalizeSymbol,
} from "../services/recommendationMemory.js";

function parseArgs(argv) {
  const out = { sub: null, symbol: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sub") out.sub = argv[++i];
    else if (a === "--symbol") out.symbol = argv[++i];
    else if (a === "--json") out.json = true;
  }
  return out;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
if (!args.sub) fail("missing --sub <userSub>");
if (!args.symbol) fail("missing --symbol <ticker>");

const targetSym = args.symbol;
const targetNorm = normalizeSymbol(targetSym);

function matchesHolding(h) {
  if (!h) return false;
  if (h.symbol === targetSym) return true;
  if (normalizeSymbol(h.symbol) === targetNorm) return true;
  return false;
}

function matchesEvent(e) {
  if (!e) return false;
  if (e.symbol && (e.symbol === targetSym || normalizeSymbol(e.symbol) === targetNorm)) return true;
  if (typeof e.recId === "string") {
    const [symPart] = e.recId.split("|");
    if (symPart && (symPart === targetSym || symPart === `SYM:${targetSym}` || symPart === `SYM:${targetNorm}`)) return true;
  }
  return false;
}

const history = await getPortfolioHistoryStorage().read(args.sub);
const ledger = await getRecommendationLedgerStorage().read(args.sub);

const snaps = Array.isArray(history?.snapshots) ? history.snapshots : [];
const events = Array.isArray(ledger?.events) ? ledger.events : [];

const recentSnaps = snaps.slice(0, 2).map((s) => {
  const h = (s.holdings || []).find(matchesHolding) || null;
  return {
    asOfDateIso: s.asOfDateIso,
    uploadedAtIso: s.uploadedAtIso,
    contentHash: s.contentHash,
    sourceBroker: s.sourceBroker,
    holding: h ? { symbol: h.symbol, isin: h.isin, quantity: h.quantity, avgPrice: h.avgPrice } : null,
  };
});

const matchedEvents = events.filter(matchesEvent).map((e) => ({
  type: e.type,
  recId: e.recId,
  at: e.at,
  action: e.action || e.actionAtExecution || null,
  qtyAtIssue: e.qtyAtIssue ?? null,
  ratio: e.ratio ?? null,
  qtyDelta: e.qtyDelta ?? null,
  sourceSnapshot: e.sourceSnapshot ?? null,
  scoreAtIssue: e.scoreAtIssue ?? null,
  scoreAtExecution: e.scoreAtExecution ?? null,
  severityAtIssue: e.severity ?? null,
  severityAtExecution: e.severityAtExecution ?? null,
  bypassReason: e.bypassReason ?? null,
}));

const latestSnap = snaps[0] || null;
const candidate = latestSnap ? (latestSnap.holdings || []).find(matchesHolding) : null;
const candidateFacet = latestSnap ? (latestSnap.facets || []).find(matchesHolding) : null;

const closedByKeyDir = indexClosedExecutedEvents(events);
const candidateSymKey = candidate ? symbolKey(candidate) : (candidateFacet ? symbolKey(candidateFacet) : null);

const gateVerdicts = [];
if (candidateSymKey && candidateFacet) {
  for (const dir of ["sell", "topup"]) {
    const bucket = closedByKeyDir.get(`${candidateSymKey}|${dir}`);
    const mostRecentExecuted = bucket && bucket.length > 0 ? bucket[0] : null;
    const cand = { ...candidate, ...candidateFacet, action: dir === "sell" ? "Reduction-25%" : "Top-up-25%" };
    const verdict = applyCooldownGate({ candidate: cand, mostRecentExecuted, direction: dir, now: new Date() });
    gateVerdicts.push({
      direction: dir,
      mostRecentExecutedAt: mostRecentExecuted?.at || null,
      mostRecentExecutedAction: mostRecentExecuted?.actionAtExecution || null,
      gated: verdict.gated,
      bypassReason: verdict.bypassReason || null,
      cooldownUntil: verdict.cooldownEntry?.cooldownUntil || null,
    });
  }
}

const report = {
  sub: args.sub,
  symbol: targetSym,
  normalizedSymbol: targetNorm,
  candidateSymKey,
  recentSnapshots: recentSnaps,
  ledgerEvents: matchedEvents,
  gateVerdicts,
  notes: matchedEvents.length === 0
    ? "No ledger events found. Either the symbol was never recommended for this sub, or the recId encodes a different key (ISIN drift)."
    : (matchedEvents.some((e) => e.type === "EXECUTED" || e.type === "EXECUTED_PARTIAL" || e.type === "EXECUTED_OVER")
        ? "EXECUTED event present — cooldown gate has a target to gate against."
        : "No EXECUTED event yet. Reconciler did not detect the trim. Layer 2 (symbol/ISIN fallback) is the next thing to verify."),
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Cooldown diagnosis · sub=${args.sub} · symbol=${targetSym}\n`);
  console.log(`symKey resolved: ${candidateSymKey || "(missing)"}`);
  console.log(`normalized symbol: ${targetNorm}\n`);

  console.log("Recent snapshots:");
  for (const s of recentSnaps) {
    console.log(`  ${s.asOfDateIso}  hash=${s.contentHash}  broker=${s.sourceBroker || "?"}`);
    if (s.holding) console.log(`    ${targetSym}: qty=${s.holding.quantity}  avgPrice=₹${s.holding.avgPrice}  isin=${s.holding.isin || "(none)"}`);
    else console.log(`    ${targetSym}: not in this snapshot`);
  }
  if (recentSnaps.length === 2 && recentSnaps[0].holding && recentSnaps[1].holding) {
    const dQty = recentSnaps[0].holding.quantity - recentSnaps[1].holding.quantity;
    console.log(`  Δ qty (newest − previous): ${dQty}`);
  }

  console.log(`\nLedger events for ${targetSym} (${matchedEvents.length}):`);
  for (const e of matchedEvents) {
    console.log(`  ${e.at}  ${e.type.padEnd(18)}  action=${e.action || "?"}  ratio=${e.ratio ?? "—"}  qtyDelta=${e.qtyDelta ?? "—"}  qtyAtIssue=${e.qtyAtIssue ?? "—"}`);
  }

  console.log(`\nCooldown gate re-evaluation:`);
  for (const v of gateVerdicts) {
    const tag = v.gated ? "GATED" : (v.bypassReason ? `BYPASS (${v.bypassReason})` : "PASS-THROUGH");
    console.log(`  ${v.direction.padEnd(5)} → ${tag}   mostRecent=${v.mostRecentExecutedAction || "(none)"} @ ${v.mostRecentExecutedAt || "(none)"}   until=${v.cooldownUntil || "—"}`);
  }

  console.log(`\n${report.notes}`);
}
