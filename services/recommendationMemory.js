/**
 * Recommendation Memory — pure logic
 *
 * Turns (previous-snapshot, new-snapshot, open-ledger) into a stream of
 * ledger events that record what the user actually did between uploads,
 * what's still pending, what got naturally resolved, and what new
 * recommendations should be emitted (with suppression rules applied so
 * we don't repeat ourselves).
 *
 * Pure functions only — no I/O, no Date.now() side effects (callers pass
 * `now` when needed). Storage adapters live in
 * portfolioHistoryStorage.js / recommendationLedgerStorage.js.
 *
 * The reconciler is run on every fresh portfolio upload (NOT on rerun —
 * rerun only applies suppression to the rendered report, no new events).
 */

import { createHash } from "crypto";
import { parseTrimPct, parseTopUpPct } from "./actionLadder.js";

// ────────────────────────── Constants ──────────────────────────

const RATIO_PARTIAL_LOWER = 0.2;
const RATIO_EXECUTED_LOWER = 0.5;
const RATIO_EXECUTED_UPPER = 1.5;

const THESIS_INVERTED_DELTA = 25;
const NO_DATA_CONSECUTIVE_THRESHOLD = 3;

const CORPORATE_ACTION_TOLERANCE = 0.01;

// Action strength ranks. Higher absolute value = stronger conviction.
// Sign encodes direction: positive = sell-side, negative = buy-side, 0 = HOLD.
// Both legacy and v4 labels covered so the reconciler stays vocabulary-agnostic.
const ACTION_RANK = {
  // v4 sell ladder
  "EXIT-now": 100,
  "EXIT-staged": 90,
  "Reduction-66%": 80,
  "Reduction-50%": 70,
  "Reduction-33%": 60,
  "Reduction-25%": 50,
  // Legacy sell labels
  CUT_LOSS: 100,
  SELL: 90,
  BOOK_PROFIT: 60,
  TRIM: 50,
  // Neutral
  HOLD: 0,
  NO_DATA: 0,
  ETF: 0,
  // v4 top-up ladder
  "Top-up-25%": -50,
  "Top-up-33%": -60,
  "Top-up-50%": -70,
  "Top-up-100%": -80,
  "STRONG Top-up": -90,
  // Legacy add labels
  ADD: -50,
  STRONG_ADD: -80,
};

const TERMINAL_TYPES = new Set([
  "EXECUTED",
  "EXECUTED_OVER",
  "SUPERSEDED",
  "RESOLVED_NATURAL",
  "RESOLVED_THESIS_INVERTED",
  "RESOLVED_NO_DATA",
  "ORPHANED",
]);

// ────────────────────── Small helpers ──────────────────────

export function actionRank(action) {
  if (action == null) return 0;
  return ACTION_RANK[action] ?? 0;
}

export function isSellAction(action) {
  return actionRank(action) > 0;
}

export function isTopUpAction(action) {
  return actionRank(action) < 0;
}

export function isHoldAction(action) {
  return !action || actionRank(action) === 0;
}

export function actionDirection(action) {
  const r = actionRank(action);
  return r > 0 ? "sell" : r < 0 ? "topup" : "neutral";
}

export function symbolKey(holding) {
  if (!holding) return null;
  if (holding.isin) return holding.isin;
  if (holding.symbol) return `SYM:${holding.symbol}`;
  return null;
}

export function factorSignature(factors) {
  if (!Array.isArray(factors) || factors.length === 0) return "no_factors";
  return [...factors].map(String).sort().join("|");
}

function shortHash(s) {
  return createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
}

export function computeRecId(symKey, factors, asOfDateIso) {
  const sig = factorSignature(factors);
  return `${symKey}|${shortHash(sig)}|${asOfDateIso}`;
}

export function contentHashFromHoldings(holdings) {
  const rows = (holdings || [])
    .map((h) => `${h.symbol || ""}|${h.isin || ""}|${Number(h.quantity) || 0}|${Number(h.avgPrice) || 0}`)
    .sort();
  return shortHash(rows.join("\n"));
}

export function brokerFromSource(parsedSource) {
  if (!parsedSource) return null;
  const s = String(parsedSource).toLowerCase();
  if (s.startsWith("rerun")) return parsedSource;
  if (s.includes("groww")) return s.includes("mf") ? "groww-mf-xlsx" : "groww-xlsx";
  if (s.includes("zerodha")) return "zerodha-csv";
  if (s.includes("upstox")) return "upstox-xlsx";
  return parsedSource;
}

// ────────────────────── Snapshot construction ──────────────────────

/**
 * Build the canonical snapshot from a parsed upload + scored holdings.
 * The caller is responsible for providing `asOfDateIso` already canonicalised
 * via portfolioParser.toIsoDate (or null + asOfDateInferred=true for fallback).
 */
export function buildSnapshot({
  asOfDateIso,
  asOfDateInferred = false,
  uploadedAtIso,
  parsed,
  scoredHoldings,
  sourceFile = null,
  sourceBroker = null,
  history = null,
}) {
  if (!asOfDateIso) throw new Error("buildSnapshot: asOfDateIso required");
  if (!uploadedAtIso) throw new Error("buildSnapshot: uploadedAtIso required");

  const holdings = (parsed?.holdings || []).map((h) => ({
    symbol: h.symbol || null,
    isin: h.isin || null,
    name: h.name || null,
    quantity: Number(h.quantity) || 0,
    avgPrice: Number(h.avgPrice) || 0,
    sector: h.sector || null,
  }));

  const facets = (scoredHoldings || []).map((h) => ({
    symbol: h.symbol || null,
    isin: h.isin || null,
    positionWeight: Number(h.positionWeight) || 0,
    pnlPercent: Number(h.pnlPercent) || 0,
    combinedScore: Number.isFinite(h.combinedScore) ? Number(h.combinedScore)
                  : Number.isFinite(h.score) ? Number(h.score)
                  : null,
    fundamentalVerdict: h.fundamentalVerdict || h.verdict || null,
    action: h.action || h.recommendation || "HOLD",
    factors: Array.isArray(h.factors) ? h.factors
            : Array.isArray(h.actionFactors) ? h.actionFactors
            : [],
    swsCovered: h.swsCovered !== false,
    trimRupees: Number.isFinite(h.trimRupees) ? Number(h.trimRupees) : null,
    topUpRupees: Number.isFinite(h.topUpRupees) ? Number(h.topUpRupees) : null,
    livePrice: Number.isFinite(h.livePrice) ? Number(h.livePrice) : null,
  }));

  const contentHash = contentHashFromHoldings(holdings);

  let backdated = false;
  if (history?.snapshots?.length > 0) {
    backdated = asOfDateIso < history.snapshots[0].asOfDateIso;
  }

  return {
    asOfDateIso,
    uploadedAtIso,
    contentHash,
    sourceFile,
    sourceBroker: sourceBroker || brokerFromSource(parsed?.source),
    backdated,
    asOfDateInferred,
    holdings,
    facets,
  };
}

// ────────────────────── Open-rec derivation ──────────────────────

/**
 * Reduce an event log into a Map<recId, OpenRecState>. A rec is "open"
 * if its latest event is ISSUED or EXECUTED_PARTIAL — those are the only
 * states still subject to live reconciliation.
 */
export function deriveOpenRecs(events) {
  const byRec = new Map();
  for (const e of events || []) {
    if (!e || !e.recId) continue;
    if (!byRec.has(e.recId)) {
      byRec.set(e.recId, { recId: e.recId, history: [], issuedEvent: null, lastEvent: null });
    }
    const slot = byRec.get(e.recId);
    slot.history.push(e);
    if (e.type === "ISSUED" && !slot.issuedEvent) slot.issuedEvent = e;
    slot.lastEvent = e;
  }
  const open = new Map();
  for (const [recId, slot] of byRec) {
    const last = slot.lastEvent;
    if (!last) continue;
    if (TERMINAL_TYPES.has(last.type)) continue;
    if (last.type === "ISSUED" || last.type === "EXECUTED_PARTIAL") {
      open.set(recId, {
        recId,
        state: last.type === "ISSUED" ? "PENDING" : "EXECUTED_PARTIAL",
        issuedEvent: slot.issuedEvent,
        lastEvent: last,
        history: slot.history,
      });
    }
  }
  return open;
}

// ────────────────────── Corporate-action filter ──────────────────────

/**
 * Detect bonus issues / stock splits between adjacent snapshots.
 * Returns Set<symbolKey> for pairs that look like a corporate action.
 *
 * Filter: qty went up, avgPrice came down, and the ratios match within
 * CORPORATE_ACTION_TOLERANCE. A 1:1 bonus doubles qty and halves avg cost
 * (in some broker statements); a 1:2 split similarly.
 */
export function detectCorporateActions(prevByKey, newByKey) {
  const flagged = new Set();
  for (const [key, p] of prevByKey) {
    const n = newByKey.get(key);
    if (!n) continue;
    const qBefore = Number(p.quantity) || 0;
    const qAfter = Number(n.quantity) || 0;
    const aBefore = Number(p.avgPrice) || 0;
    const aAfter = Number(n.avgPrice) || 0;
    if (qBefore <= 0 || qAfter <= 0 || aBefore <= 0 || aAfter <= 0) continue;
    if (qAfter <= qBefore) continue;
    if (aAfter >= aBefore) continue;
    const qRatio = qAfter / qBefore;
    const aRatio = aBefore / aAfter;
    if (Math.abs(qRatio - aRatio) / aRatio <= CORPORATE_ACTION_TOLERANCE) {
      flagged.add(key);
    }
  }
  return flagged;
}

// ────────────────────── Ratio classifier ──────────────────────

function classifyByRatio({ recId, ratio, qtyDelta, sourceSnapshot, recommendedPct, at }) {
  if (ratio < RATIO_PARTIAL_LOWER) return null;
  if (ratio < RATIO_EXECUTED_LOWER) {
    const remainingPct = Math.max(0, recommendedPct - recommendedPct * ratio);
    return { type: "EXECUTED_PARTIAL", recId, at, ratio, qtyDelta, remainingPct, sourceSnapshot };
  }
  if (ratio <= RATIO_EXECUTED_UPPER) {
    return { type: "EXECUTED", recId, at, ratio, qtyDelta, sourceSnapshot };
  }
  return { type: "EXECUTED_OVER", recId, at, ratio, qtyDelta, sourceSnapshot };
}

// ────────────────────── Condition-still-fires check ──────────────────────

/**
 * Did the original triggering condition still fire on the new snapshot?
 * Compare the rec's factor signature to the new snapshot's factor signature
 * for the same symbol. If the symbol's facet still emits any of the original
 * factors, condition still fires; otherwise the rec is RESOLVED_NATURAL.
 *
 * We don't require the *exact* signature — that would over-fire SUPERSEDED.
 * We require *intersection*: at least one of the issuing factors still trips.
 */
function conditionStillFires(rec, newFacet) {
  if (!newFacet || !Array.isArray(newFacet.factors)) return false;
  const issued = new Set(rec.issuedEvent?.factors || []);
  if (issued.size === 0) return false;
  for (const f of newFacet.factors) {
    if (issued.has(f)) return true;
  }
  return false;
}

function thesisInversion(rec, newFacet) {
  if (!newFacet || newFacet.combinedScore == null) return null;
  const baseline = rec.issuedEvent?.scoreAtIssue;
  if (baseline == null) return null;
  const delta = newFacet.combinedScore - baseline;
  const dir = actionDirection(rec.issuedEvent?.action);
  if (dir === "sell" && delta >= THESIS_INVERTED_DELTA) return delta;
  if (dir === "topup" && delta <= -THESIS_INVERTED_DELTA) return delta;
  return null;
}

function consecutiveNoData({ symKey, newFacet, historySnapshots }) {
  let count = 0;
  if (newFacet && newFacet.swsCovered === false) count += 1;
  else return 0;
  const snaps = historySnapshots || [];
  for (let i = 0; i < snaps.length && count < NO_DATA_CONSECUTIVE_THRESHOLD; i++) {
    const facet = snaps[i].facets?.find((f) => symbolKey(f) === symKey);
    if (!facet) break;
    if (facet.swsCovered === false) count += 1;
    else break;
  }
  return count;
}

// ────────────────────── Reconciler ──────────────────────

/**
 * Main reconciliation pass. Compares prev → new and emits events for every
 * open rec whose state should change. Idempotent on identical (asOfDateIso,
 * contentHash) inputs.
 *
 * Inputs:
 *   prevSnap: Snapshot | null         — most recent snapshot before this upload
 *   newSnap: Snapshot                  — the snapshot being added
 *   openRecs: Map<recId, OpenRecState> — derived from current ledger
 *   historySnapshots: Snapshot[]       — full history (for no-data lookback)
 *   now: Date                          — for `at` timestamps (defaults to new Date())
 *
 * Returns: { events: LedgerEvent[] }
 */
export function reconcileRecommendations({
  prevSnap,
  newSnap,
  openRecs,
  historySnapshots = [],
  now = new Date(),
}) {
  const events = [];
  if (!newSnap) return { events };

  // Idempotency: same content + same date as last snapshot ⇒ no events.
  if (prevSnap &&
      prevSnap.contentHash === newSnap.contentHash &&
      prevSnap.asOfDateIso === newSnap.asOfDateIso) {
    return { events };
  }

  const at = now.toISOString();
  const sourceSnapshot = newSnap.asOfDateIso;

  const prevByKey = new Map();
  for (const h of (prevSnap?.holdings || [])) {
    const k = symbolKey(h);
    if (k) prevByKey.set(k, h);
  }
  const newByKey = new Map();
  for (const h of (newSnap.holdings || [])) {
    const k = symbolKey(h);
    if (k) newByKey.set(k, h);
  }

  const corporateActionKeys = detectCorporateActions(prevByKey, newByKey);

  const newFacetsByKey = new Map();
  for (const f of (newSnap.facets || [])) {
    const k = symbolKey(f);
    if (k) newFacetsByKey.set(k, f);
  }

  for (const rec of openRecs.values()) {
    const issued = rec.issuedEvent;
    if (!issued) continue;
    const recSymKey = issued.isin ? issued.isin : `SYM:${issued.symbol}`;

    if (corporateActionKeys.has(recSymKey)) continue;

    const newH = newByKey.get(recSymKey);
    const newFacet = newFacetsByKey.get(recSymKey);
    const direction = actionDirection(issued.action);

    const noDataCount = consecutiveNoData({
      symKey: recSymKey,
      newFacet,
      historySnapshots,
    });
    if (noDataCount >= NO_DATA_CONSECUTIVE_THRESHOLD) {
      events.push({
        type: "RESOLVED_NO_DATA",
        recId: rec.recId,
        at,
        consecutiveNoDataCount: noDataCount,
        sourceSnapshot,
      });
      continue;
    }

    if (direction === "sell" || direction === "topup") {
      const qtyAtIssue = Number(issued.qtyAtIssue) || 0;
      const qtyNew = Number(newH?.quantity) || 0;
      const recommendedPct = direction === "sell"
        ? parseTrimPct(issued.action)
        : parseTopUpPct(issued.action);

      if (qtyAtIssue > 0 && recommendedPct > 0) {
        if (direction === "sell") {
          const reduced = Math.max(0, qtyAtIssue - qtyNew);
          const pctReduced = reduced / qtyAtIssue;
          const ratio = pctReduced / recommendedPct;
          const ev = classifyByRatio({
            recId: rec.recId, ratio, qtyDelta: -reduced,
            sourceSnapshot, recommendedPct, at,
          });
          if (ev) {
            events.push(ev);
            if (ev.type !== "EXECUTED_PARTIAL") continue;
          }
        } else {
          const added = Math.max(0, qtyNew - qtyAtIssue);
          const pctAdded = qtyAtIssue > 0 ? added / qtyAtIssue : 0;
          const ratio = pctAdded / recommendedPct;
          const ev = classifyByRatio({
            recId: rec.recId, ratio, qtyDelta: added,
            sourceSnapshot, recommendedPct, at,
          });
          if (ev) {
            events.push(ev);
            if (ev.type !== "EXECUTED_PARTIAL") continue;
          }
        }
      }

      if (!newH) {
        if (direction === "sell") {
          events.push({
            type: "EXECUTED",
            recId: rec.recId,
            at,
            ratio: 1 / Math.max(0.01, recommendedPct),
            qtyDelta: -(Number(issued.qtyAtIssue) || 0),
            sourceSnapshot,
          });
          continue;
        }
        events.push({
          type: "ORPHANED",
          recId: rec.recId,
          at,
          reason: "symbol_disappeared",
          sourceSnapshot,
        });
        continue;
      }
    }

    if (newFacet) {
      const inverted = thesisInversion(rec, newFacet);
      if (inverted != null) {
        events.push({
          type: "RESOLVED_THESIS_INVERTED",
          recId: rec.recId,
          at,
          scoreDelta: inverted,
          sourceSnapshot,
        });
        continue;
      }
      if (!conditionStillFires(rec, newFacet)) {
        events.push({
          type: "RESOLVED_NATURAL",
          recId: rec.recId,
          at,
          reason: "condition_cleared",
          sourceSnapshot,
        });
        continue;
      }
    }
  }

  return { events };
}

// ────────────────────── Issued-events builder + suppression ──────────────────────

/**
 * Apply suppression rules and build the ISSUED events for the current
 * snapshot. Re-derives `openRecs` after the reconciler emits its events,
 * so an open rec that was just closed by EXECUTED won't suppress a fresh
 * candidate on the same symbol.
 *
 * Returns { events, suppressedCandidateRecIds, supersedeMap }.
 *   events                   — the actual ISSUED + SUPERSEDED events
 *   suppressedCandidateRecIds — Set of candidate recIds NOT emitted (UI shows
 *                              the original "still flagged" badge instead)
 *   supersedeMap             — Map<oldRecId, newRecId>
 */
export function buildIssuedEvents({
  scoredHoldings,
  newSnap,
  openRecsAfterReconcile,
  now = new Date(),
}) {
  const events = [];
  const suppressedCandidateRecIds = new Set();
  const supersedeMap = new Map();
  const at = now.toISOString();
  const sourceSnapshot = newSnap.asOfDateIso;

  const openBySymKey = new Map();
  for (const rec of openRecsAfterReconcile.values()) {
    const issued = rec.issuedEvent;
    if (!issued) continue;
    const k = issued.isin ? issued.isin : `SYM:${issued.symbol}`;
    if (!openBySymKey.has(k)) openBySymKey.set(k, []);
    openBySymKey.get(k).push(rec);
  }

  for (const h of (scoredHoldings || [])) {
    const action = h.action || h.recommendation || "HOLD";
    if (isHoldAction(action)) continue;
    const symKey = symbolKey(h);
    if (!symKey) continue;

    const factors = Array.isArray(h.factors) ? h.factors
                  : Array.isArray(h.actionFactors) ? h.actionFactors
                  : [];
    const candidateRecId = computeRecId(symKey, factors, sourceSnapshot);
    const candidateSig = factorSignature(factors);
    const candidateRank = actionRank(action);
    const candidateDir = actionDirection(action);

    const openOnSymbol = openBySymKey.get(symKey) || [];
    let suppressed = false;
    let supersededOpenIds = [];

    for (const open of openOnSymbol) {
      const openIssued = open.issuedEvent;
      if (!openIssued) continue;
      const openSig = factorSignature(openIssued.factors || []);
      const openRank = actionRank(openIssued.action);
      const openDir = actionDirection(openIssued.action);

      if (candidateSig === openSig && openDir === candidateDir) {
        suppressed = true;
        suppressedCandidateRecIds.add(candidateRecId);
        break;
      }

      if (openDir !== candidateDir) {
        supersededOpenIds.push({ id: open.recId, reason: "thesis_flip" });
        continue;
      }

      const candidateStrength = Math.abs(candidateRank);
      const openStrength = Math.abs(openRank);
      if (candidateStrength > openStrength) {
        supersededOpenIds.push({ id: open.recId, reason: "stronger_action" });
      } else if (candidateStrength < openStrength) {
        suppressed = true;
        suppressedCandidateRecIds.add(candidateRecId);
        break;
      } else {
        supersededOpenIds.push({ id: open.recId, reason: "factor_change" });
      }
    }

    if (suppressed) continue;

    for (const { id, reason } of supersededOpenIds) {
      events.push({
        type: "SUPERSEDED",
        recId: id,
        at,
        bySupersedingRecId: candidateRecId,
        reason,
        sourceSnapshot,
      });
      supersedeMap.set(id, candidateRecId);
    }

    const direction = candidateDir;
    const reductionPct = direction === "sell" ? parseTrimPct(action) : null;
    const addPct = direction === "topup" ? parseTopUpPct(action) : null;

    events.push({
      type: "ISSUED",
      recId: candidateRecId,
      at,
      symbol: h.symbol || null,
      isin: h.isin || null,
      action,
      reductionPct,
      addPct,
      severity: Number.isFinite(h.severity) ? Number(h.severity) : null,
      trimRupees: Number.isFinite(h.trimRupees) ? Number(h.trimRupees) : null,
      topUpRupees: Number.isFinite(h.topUpRupees) ? Number(h.topUpRupees) : null,
      factors,
      reasoning: h.actionReasoning || h.reasoning || null,
      sourceSnapshot,
      qtyAtIssue: Number(h.quantity) || 0,
      weightAtIssue: Number(h.positionWeight) || 0,
      scoreAtIssue: Number.isFinite(h.combinedScore) ? Number(h.combinedScore)
                   : Number.isFinite(h.score) ? Number(h.score)
                   : null,
    });
  }

  return { events, suppressedCandidateRecIds, supersedeMap };
}

// ────────────────────── Memory → report decoration ──────────────────────

/**
 * Build the executionAcks the UI renders above the action mix.
 * One card per EXECUTED / EXECUTED_PARTIAL / EXECUTED_OVER event.
 */
export function buildExecutionAcks(reconcileEvents, openRecsBeforeReconcile, latestPrevSnap) {
  const out = [];
  const facetByKey = new Map();
  for (const f of (latestPrevSnap?.facets || [])) {
    const k = symbolKey(f);
    if (k) facetByKey.set(k, f);
  }
  for (const e of reconcileEvents || []) {
    if (e.type !== "EXECUTED" && e.type !== "EXECUTED_PARTIAL" && e.type !== "EXECUTED_OVER") continue;
    const open = openRecsBeforeReconcile.get(e.recId);
    const issued = open?.issuedEvent;
    if (!issued) continue;
    const symKey = issued.isin ? issued.isin : `SYM:${issued.symbol}`;
    const facet = facetByKey.get(symKey);
    const livePrice = Number.isFinite(facet?.livePrice) ? Number(facet.livePrice) : 0;
    const rupeesFreed = livePrice > 0 ? Math.round(Math.abs(e.qtyDelta || 0) * livePrice)
                                       : Number.isFinite(issued.trimRupees) ? Math.round(Math.abs(issued.trimRupees) * (Math.abs(e.ratio) || 1))
                                       : 0;
    out.push({
      type: e.type,
      symbol: issued.symbol,
      isin: issued.isin,
      action: issued.action,
      issuedAt: issued.at,
      issuedAsOf: issued.sourceSnapshot,
      ratio: e.ratio,
      qtyDelta: e.qtyDelta,
      remainingPct: e.remainingPct ?? null,
      rupeesFreed,
      reasoning: issued.reasoning,
    });
  }
  return out;
}

/**
 * Compute total freed capital from execution events. Used to gate the
 * deployment banner on a meaningful threshold (₹10K aggregate or ₹50K single).
 */
export function computeFreedCapital(executionAcks) {
  let total = 0;
  let largestSingle = 0;
  let count = 0;
  for (const ack of executionAcks) {
    if (ack.type !== "EXECUTED" && ack.type !== "EXECUTED_OVER" && ack.type !== "EXECUTED_PARTIAL") continue;
    if (!isSellAction(ack.action)) continue;
    const r = Math.max(0, ack.rupeesFreed || 0);
    total += r;
    if (r > largestSingle) largestSingle = r;
    count += 1;
  }
  const significant = total >= 10000 || largestSingle >= 50000;
  return { totalRupeesFreed: total, largestSingle, count, significant };
}

/**
 * Decorate the live report with memory artefacts. Mutates and returns the
 * report so the existing JSON pipeline doesn't change shape.
 *
 *   report.executionAcks    — array of cards rendered above the action mix
 *   report.freedCapital     — { totalRupeesFreed, largestSingle, count, significant }
 *   report.backdated        — true iff snapshot was backdated (skip memory section)
 *   report.memoryStatus     — { hasHistory, openRecCount, asOfDateIso, prevAsOfDateIso }
 *   report.recRegistry      — Map<symKey, { isPending, recId, originalAsOf, escalationCount, isSuperseded, supersededBy }>
 *
 * recRegistry is consumed by gated/app.js to render suppression badges.
 */
export function applyMemoryToReport(report, {
  newSnap,
  prevSnap,
  openRecsBeforeReconcile,
  reconcileEvents,
  issuedEvents,
  suppressedCandidateRecIds,
  supersedeMap,
  isBackdated,
  historySnapshots = [],
}) {
  if (!report) return report;
  if (isBackdated) {
    report.backdated = true;
    report.backdatedAsOf = newSnap?.asOfDateIso || null;
    report.latestKnownAsOf = historySnapshots[0]?.asOfDateIso || null;
    return report;
  }

  const acks = buildExecutionAcks(reconcileEvents, openRecsBeforeReconcile, prevSnap);
  const freed = computeFreedCapital(acks);

  const closedByReconcile = new Set();
  for (const e of reconcileEvents || []) {
    if (TERMINAL_TYPES.has(e.type)) closedByReconcile.add(e.recId);
  }

  const recRegistry = {};
  for (const [recId, open] of openRecsBeforeReconcile) {
    if (closedByReconcile.has(recId)) continue;
    const issued = open.issuedEvent;
    if (!issued) continue;
    const symKey = issued.isin ? issued.isin : `SYM:${issued.symbol}`;
    const isSuperseded = supersedeMap.has(recId);
    const escalationCount = countSnapshotsSinceIssue(historySnapshots, issued.sourceSnapshot, newSnap.asOfDateIso);
    recRegistry[symKey] = {
      recId,
      symbol: issued.symbol || null,
      isin: issued.isin || null,
      isPending: !isSuperseded,
      isSuperseded,
      supersededBy: isSuperseded ? supersedeMap.get(recId) : null,
      originalAsOf: issued.sourceSnapshot,
      originalAction: issued.action,
      escalationCount,
    };
  }

  report.executionAcks = acks;
  report.freedCapital = freed;
  report.backdated = false;
  report.memoryStatus = {
    hasHistory: historySnapshots.length > 0,
    openRecCount: openRecsBeforeReconcile.size,
    asOfDateIso: newSnap.asOfDateIso,
    prevAsOfDateIso: prevSnap?.asOfDateIso || null,
  };
  report.recRegistry = recRegistry;
  return report;
}

function countSnapshotsSinceIssue(historySnapshots, issuedAsOfDateIso, currentAsOfDateIso) {
  if (!issuedAsOfDateIso || !currentAsOfDateIso) return 0;
  let count = 1;
  for (const snap of historySnapshots) {
    if (snap.asOfDateIso > issuedAsOfDateIso && snap.asOfDateIso < currentAsOfDateIso) count += 1;
  }
  return count;
}

// ────────────────────── Combined event-stream builder ──────────────────────

/**
 * Convenience: re-derive open recs after applying reconcile events, then
 * build issued+supersede events. Server.js calls this once per analyze
 * request and persists the union.
 */
export function applyReconcileToOpenRecs(openRecs, reconcileEvents) {
  const next = new Map(openRecs);
  for (const e of reconcileEvents || []) {
    if (e.type === "EXECUTED_PARTIAL") {
      const slot = next.get(e.recId);
      if (slot) {
        next.set(e.recId, { ...slot, state: "EXECUTED_PARTIAL", lastEvent: e });
      }
      continue;
    }
    if (TERMINAL_TYPES.has(e.type)) {
      next.delete(e.recId);
    }
  }
  return next;
}
