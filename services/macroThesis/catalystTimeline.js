// Catalyst timeline (PR B4).
//
// Reads data/macro-events-calendar-2026.json and reports scheduled
// events that could shift the regime in the next N days. Used by
// thesisOrchestrator to pass `catalystProximityDays` into the scenario
// probability engine, and rendered as a timeline strip in the UI.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const DEFAULT_CALENDAR_PATH = path.join(REPO_ROOT, "data", "macro-events-calendar-2026.json");

export const DEFAULT_WINDOW_DAYS = 30;

function _loadCalendar(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function _daysBetween(fromIso, toIso) {
  const a = new Date(fromIso + (fromIso.includes("T") ? "" : "T00:00:00Z")).getTime();
  const b = new Date(toIso + (toIso.includes("T") ? "" : "T00:00:00Z")).getTime();
  return Math.floor((b - a) / (24 * 3600 * 1000));
}

export function getUpcomingCatalysts({
  asOf = null,
  windowDays = DEFAULT_WINDOW_DAYS,
  calendarPath = DEFAULT_CALENDAR_PATH,
} = {}) {
  const cal = _loadCalendar(calendarPath);
  if (!cal || !Array.isArray(cal.events)) return [];
  const today = asOf || new Date().toISOString().slice(0, 10);
  const out = [];
  for (const e of cal.events) {
    if (!e.date) continue;
    const days = _daysBetween(today, e.date);
    if (days < 0 || days > windowDays) continue;
    out.push({
      date: e.date,
      kind: e.kind || "OTHER",
      label: e.label || e.kind || "Event",
      severity_potential: e.severity_potential ?? 2,
      days_until: days,
    });
  }
  out.sort((a, b) => a.days_until - b.days_until);
  return out;
}

// Returns the days_until of the closest catalyst (or null if none in
// window). Used by the scenario probability engine to weight new_shock
// probability up when a catalyst is imminent.
export function getCatalystProximity({
  asOf = null,
  windowDays = DEFAULT_WINDOW_DAYS,
  calendarPath = DEFAULT_CALENDAR_PATH,
} = {}) {
  const upcoming = getUpcomingCatalysts({ asOf, windowDays, calendarPath });
  return upcoming.length > 0 ? upcoming[0].days_until : null;
}

export default {
  DEFAULT_CALENDAR_PATH,
  DEFAULT_WINDOW_DAYS,
  getUpcomingCatalysts,
  getCatalystProximity,
};
