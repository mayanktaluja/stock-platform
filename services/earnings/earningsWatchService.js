/**
 * earningsWatchService.js
 *
 * Read-side service for the Earnings Watch tab. Loads the snapshot
 * produced by scripts/refresh-earnings.mjs (data/catalysts/earnings-
 * watch-latest.json) and serves filtered slices to the API endpoints.
 *
 * No NSE calls happen here — that pipeline runs locally and commits
 * JSON. This service is the "warm read" half: deterministic, fast,
 * and Vercel-safe.
 *
 * Milestone-A scope: calendar only (symbol, company, days_until,
 * fiscal_quarter, tags). Later milestones add data_quality, predicted
 * verdict, confidence, price band, reaction playbook — all on the same
 * record shape, so this service does NOT need to change as the
 * upstream snapshot grows.
 */

import fs from "node:fs";
import path from "node:path";

import { buildBandsForCalendar } from "./priceBandBuilder.js";
import { narrateCalendar } from "./earningsRationaleNarrator.js";
import { summarisePredictions } from "./earningsPredictor.js";
import { summariseSignals } from "./signalAggregator.js";
import { attachPlaybooksToCalendar, summarisePlaybooks } from "./reactionPlaybook.js";
import {
  applyPredictionFreezes,
  filterPastRecentResults,
  loadFrozenPredictionRecords,
} from "./predictionFreeze.js";

const ROOT = process.cwd();
const SNAPSHOT_PATH = path.join(ROOT, "data", "catalysts", "earnings-watch-latest.json");
const STATS_PATH = path.join(ROOT, "data", "catalysts", "earnings-watch-stats.json");

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Load the full snapshot. Returns the canonical empty shape if the
 * file is missing — the UI distinguishes between "data not refreshed
 * yet" (event_count=0 + no upstream_fetched_at) and "no upcoming
 * results in window" (event_count=0 + present upstream_fetched_at).
 */
export function loadEarningsSnapshot() {
  const snap = readJsonSafe(SNAPSHOT_PATH);
  if (!snap || !Array.isArray(snap.events)) {
    return {
      schema_version: "earnings-calendar-v1",
      built_at: null,
      upstream_fetched_at: null,
      upstream_event_count: 0,
      window_days: 60,
      past_window_days: 14,
      today_iso: null,
      event_count: 0,
      events: [],
      recent_results: [],
      _missing: true,
    };
  }
  return snap;
}

export function loadEarningsStats() {
  const stats = readJsonSafe(STATS_PATH);
  if (!stats) {
    return {
      schema_version: "earnings-watch-stats-v1",
      built_at: null,
      today_iso: null,
      window_days: 60,
      past_window_days: 14,
      event_count: 0,
      bucket_by_days: { d0: 0, d1to3: 0, d4to7: 0, d8to14: 0, d15to30: 0, d31to60: 0 },
      _missing: true,
    };
  }
  return stats;
}

/**
 * Apply query-string filters to the events array. Empty / unset
 * filters are no-ops. Returns a fresh array — never mutates input.
 *
 * Supported filters (extensible for later milestones):
 *   - days:        max days_until (default 14)
 *   - symbol:      exact match (case-insensitive)
 *   - tag:         must include this tag (DIVIDEND, BUYBACK, etc.)
 *   - hasTags:     "true" / "false" — events with any/no ancillary tags
 *
 * Filter strings come from URL query params, so values are strings.
 */
export function filterEvents(events, filters = {}) {
  let out = Array.isArray(events) ? events.slice() : [];

  if (filters.days != null && filters.days !== "") {
    const max = Number(filters.days);
    if (Number.isFinite(max)) {
      out = out.filter((e) => typeof e.days_until === "number" && e.days_until <= max);
    }
  }

  if (filters.symbol) {
    const target = String(filters.symbol).trim().toUpperCase();
    out = out.filter((e) => e.symbol === target);
  }

  if (filters.tag) {
    const tag = String(filters.tag).trim().toUpperCase();
    out = out.filter((e) => Array.isArray(e.tags) && e.tags.includes(tag));
  }

  if (filters.hasTags === "true") {
    out = out.filter((e) => Array.isArray(e.tags) && e.tags.length > 0);
  } else if (filters.hasTags === "false") {
    out = out.filter((e) => !Array.isArray(e.tags) || e.tags.length === 0);
  }

  return out;
}

/**
 * Find a single event by symbol. Returns null when missing — the
 * endpoint converts that to a 404. Case-insensitive match on symbol.
 */
export function findEventBySymbol(snapshot, symbol) {
  if (!snapshot || !Array.isArray(snapshot.events) || !symbol) return null;
  const target = String(symbol).trim().toUpperCase();
  for (const e of snapshot.events) {
    if (e.symbol === target) return e;
  }
  return null;
}

/**
 * IST midnight date in YYYY-MM-DD form. Mirrors earningsCalendarBuilder.js
 * and earningsHistoryArchive.js so every layer agrees on what "today" is.
 */
export function istTodayIso(nowMs = Date.now()) {
  return new Date(nowMs + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysBetween(aIso, bIso) {
  const a = Date.UTC(+aIso.slice(0, 4), +aIso.slice(5, 7) - 1, +aIso.slice(8, 10));
  const b = Date.UTC(+bIso.slice(0, 4), +bIso.slice(5, 7) - 1, +bIso.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

/**
 * Recompute `days_until` on every event + recent_result row against
 * IST-now, and rewrite the snapshot's `today_iso` to match. Returns a
 * fresh snapshot — never mutates input.
 *
 * Why: the snapshot is built twice daily (02:00 + 16:30 IST) and the
 * server caches it for 5 minutes. Without this recompute, days_until
 * drifts up to ~12h between fires and the cache can carry yesterday's
 * "today" across the midnight IST boundary. Cost is one Date diff per
 * row (<0.5ms for 600 rows) — cheap enough to run per-request.
 *
 * Past events (days_until < 0) keep their negative value — the UI uses
 * the sign to decide which section the row belongs in.
 */
export function recomputeDaysUntil(snapshot, nowMs = Date.now()) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const today = istTodayIso(nowMs);
  const events = Array.isArray(snapshot.events)
    ? snapshot.events.map((e) =>
        e && typeof e.event_iso_date === "string"
          ? { ...e, days_until: daysBetween(today, e.event_iso_date) }
          : e,
      )
    : snapshot.events;
  const recent = Array.isArray(snapshot.recent_results)
    ? snapshot.recent_results.map((r) =>
        r && typeof r.event_iso_date === "string"
          ? { ...r, days_until: daysBetween(today, r.event_iso_date) }
          : r,
      )
    : snapshot.recent_results;
  return {
    ...snapshot,
    today_iso: today,
    events,
    recent_results: recent,
  };
}

/**
 * Enforce Earnings Watch bucket ownership and freeze due predictions.
 *
 * This runs at read-time so a code deploy can repair already-committed
 * snapshots: today/future rows stay in events[], past rows stay in
 * recent_results[], and due-event predictions are overlaid from the
 * pre-event archive before dependent display fields are rebuilt.
 */
export function normalizeEarningsSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const todayIso = snapshot.today_iso || istTodayIso();
  const records = loadFrozenPredictionRecords();
  const baseEvents = Array.isArray(snapshot.events)
    ? snapshot.events.filter((e) => typeof e?.days_until !== "number" || e.days_until >= 0)
    : [];
  const frozen = applyPredictionFreezes(baseEvents, { todayIso, records });
  const derived = attachPlaybooksToCalendar(narrateCalendar(buildBandsForCalendar(frozen)));
  const events = applyPredictionFreezes(derived, { todayIso, records, includeDisplay: true });
  const recent_results = filterPastRecentResults(snapshot.recent_results);
  return {
    ...snapshot,
    today_iso: todayIso,
    event_count: events.length,
    events,
    recent_results,
  };
}

function bucketEventsByDays(events) {
  const byDays = { d0: 0, d1to3: 0, d4to7: 0, d8to14: 0, d15to30: 0, d31to60: 0 };
  for (const e of events || []) {
    const d = e?.days_until;
    if (d === 0) byDays.d0 += 1;
    else if (d >= 1 && d <= 3) byDays.d1to3 += 1;
    else if (d >= 4 && d <= 7) byDays.d4to7 += 1;
    else if (d >= 8 && d <= 14) byDays.d8to14 += 1;
    else if (d >= 15 && d <= 30) byDays.d15to30 += 1;
    else if (d >= 31 && d <= 60) byDays.d31to60 += 1;
  }
  return byDays;
}

export function normalizeEarningsStats(stats, snapshot) {
  if (!stats || typeof stats !== "object" || !snapshot || typeof snapshot !== "object") return stats;
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  return {
    ...stats,
    today_iso: snapshot.today_iso ?? stats.today_iso ?? null,
    window_days: snapshot.window_days ?? stats.window_days ?? null,
    upstream_event_count: snapshot.upstream_event_count ?? stats.upstream_event_count ?? null,
    upstream_fetched_at: snapshot.upstream_fetched_at ?? stats.upstream_fetched_at ?? null,
    event_count: events.length,
    recent_results_count: Array.isArray(snapshot.recent_results) ? snapshot.recent_results.length : 0,
    past_window_days: snapshot.past_window_days ?? stats.past_window_days ?? null,
    bucket_by_days: bucketEventsByDays(events),
    signals: summariseSignals(events),
    predictions: summarisePredictions(events),
    playbooks: summarisePlaybooks(events),
  };
}
