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
      window_days: 14,
      today_iso: null,
      event_count: 0,
      events: [],
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
      window_days: 14,
      event_count: 0,
      bucket_by_days: { d0: 0, d1to3: 0, d4to7: 0, d8to14: 0 },
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
