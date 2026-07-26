/**
 * predictionFreeze.js
 *
 * Freezes Earnings Watch predictions once an event reaches its result date.
 * The user-visible call must be the last pre-event archived prediction, not
 * a same-day recomputation after new information has entered the data set.
 */

import fs from "node:fs";
import path from "node:path";

import { loadAllHistory } from "./earningsHistoryArchive.js";
import { earningsHistoryReadDir } from "./earningsHistoryStore.js";

function eventKey(row) {
  return row && row.symbol && row.event_iso_date ? `${row.symbol}|${row.event_iso_date}` : null;
}

function archiveIsoForDay(day) {
  if (day?.today_iso && /^\d{4}-\d{2}-\d{2}$/.test(day.today_iso)) return day.today_iso;
  const m = String(day?.filename || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function historySignature() {
  try {
    const historyDir = earningsHistoryReadDir();
    const files = fs.readdirSync(historyDir).filter((f) => f.endsWith(".json"));
    let maxMtime = 0;
    for (const f of files) {
      const st = fs.statSync(path.join(historyDir, f));
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
    }
    return `${files.length}:${Math.round(maxMtime)}`;
  } catch {
    return "missing";
  }
}

let cachedSignature = null;
let cachedRecords = null;

function legacyPredictionFromRow(row) {
  if (!row) return null;
  return {
    verdict: row.predicted_verdict || "INSUFFICIENT_DATA",
    confidence_pct: typeof row.confidence_pct === "number" ? row.confidence_pct : null,
    score_100: typeof row.score_100 === "number" ? row.score_100 : null,
    score_breakdown: row.score_breakdown || null,
    reasons_top: [],
    reasons_against: [],
    components_by_impact: [],
    predictor_version: row.predictor_version || null,
  };
}

function displayPredictionFromRow(row) {
  return row?.display_snapshot?.prediction || legacyPredictionFromRow(row);
}

function freezeRecordFromRow(row, archiveTodayIso) {
  const key = eventKey(row);
  if (!key) return null;
  const displaySnapshot = row.display_snapshot && typeof row.display_snapshot === "object"
    ? row.display_snapshot
    : null;
  const prediction = displayPredictionFromRow(row);
  if (!prediction) return null;
  return {
    key,
    symbol: row.symbol,
    event_iso_date: row.event_iso_date,
    archive_today_iso: archiveTodayIso,
    source: displaySnapshot ? "display_snapshot" : "legacy_archive",
    prediction,
    display_snapshot: displaySnapshot,
  };
}

export function buildFrozenPredictionRecords(history = []) {
  const byKey = new Map();
  for (const day of history || []) {
    const archiveTodayIso = archiveIsoForDay(day);
    if (!archiveTodayIso) continue;
    for (const row of day.predictions || []) {
      const key = eventKey(row);
      if (!key || !row.event_iso_date) continue;

      const isPreEvent = archiveTodayIso < row.event_iso_date;
      const isSameDay = archiveTodayIso === row.event_iso_date;
      if (!isPreEvent && !isSameDay) continue;

      const candidate = freezeRecordFromRow(row, archiveTodayIso);
      if (!candidate) continue;
      candidate._tier = isPreEvent ? "pre" : "same";

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, candidate);
      } else if (candidate._tier === "pre" && existing._tier !== "pre") {
        byKey.set(key, candidate);
      } else if (candidate._tier === "pre" && existing._tier === "pre" && candidate.archive_today_iso > existing.archive_today_iso) {
        byKey.set(key, candidate);
      } else if (candidate._tier === "same" && existing._tier === "same" && candidate.archive_today_iso < existing.archive_today_iso) {
        byKey.set(key, candidate);
      }
    }
  }

  for (const rec of byKey.values()) delete rec._tier;
  return byKey;
}

export function loadFrozenPredictionRecords() {
  const sig = historySignature();
  if (cachedRecords && sig === cachedSignature) return cachedRecords;
  cachedSignature = sig;
  cachedRecords = buildFrozenPredictionRecords(loadAllHistory());
  return cachedRecords;
}

function freezeMeta(record) {
  return {
    frozen: true,
    source: record.source,
    archive_today_iso: record.archive_today_iso,
  };
}

function freezeEventPrediction(event, record) {
  const prediction = {
    ...(event.prediction || {}),
    ...(record.prediction || {}),
    freeze: freezeMeta(record),
  };
  return {
    ...event,
    prediction,
    prediction_freeze: freezeMeta(record),
  };
}

function applyDisplaySnapshot(event, record) {
  const snap = record?.display_snapshot;
  if (!snap) return event;
  return {
    ...event,
    signals: snap.signals ? { ...(event.signals || {}), ...snap.signals } : event.signals,
    prediction: snap.prediction ? { ...snap.prediction, freeze: freezeMeta(record) } : event.prediction,
    price_band: snap.price_band || event.price_band,
    rationale: snap.rationale || event.rationale,
    playbook: snap.playbook || event.playbook,
    prediction_freeze: freezeMeta(record),
  };
}

export function applyPredictionFreezes(events, opts = {}) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const todayIso = opts.todayIso;
  if (!todayIso) return events.slice();
  const records = opts.records || loadFrozenPredictionRecords();
  const includeDisplay = opts.includeDisplay === true;

  return events.map((event) => {
    if (!event || !event.symbol || !event.event_iso_date || event.event_iso_date > todayIso) return event;
    const record = records.get(`${event.symbol}|${event.event_iso_date}`);
    if (!record) return event;
    const frozen = freezeEventPrediction(event, record);
    return includeDisplay ? applyDisplaySnapshot(frozen, record) : frozen;
  });
}

export function filterPastRecentResults(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => typeof r?.days_until === "number" ? r.days_until < 0 : r?.event_iso_date != null);
}
