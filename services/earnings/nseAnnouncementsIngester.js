/**
 * nseAnnouncementsIngester.js
 *
 * Fetches NSE corporate announcements and classifies each row by type
 * so the earnings predictor can score "material catalyst since last
 * result" per stock.
 *
 * NSE endpoints used:
 *   /api/corporate-announcements?index=equities                — latest ~20
 *   /api/corporate-announcements?index=equities&from_date=&to_date=  — date window
 *
 * The default no-date endpoint returns the 20 most recent announcements
 * filed on the exchange. Empirically the date-window variant has been
 * unreliable (empty data even for known-active windows), so V1 uses the
 * no-date endpoint and iterates by polling — committing the rolling
 * window to disk so accumulation builds over multiple refreshes.
 *
 * MUST run from a local machine, not Vercel cron — NSE rejects
 * Vercel datacenter IPs from the cookie-source endpoint
 * (see nse.js:76-83).
 *
 * Output:
 *   data/catalysts/nse-announcements-rolling.json  — last 30 days, deduped
 *
 * Schema per announcement (cleaned + classified):
 *   {
 *     symbol, name, isin, industry,
 *     subject (desc + attchmntText combined),
 *     announced_at_iso,
 *     pdf_url,
 *     classification: ORDER_WIN | CAPACITY_EXPANSION | LITIGATION |
 *                     FUND_RAISING | RATING_ACTION | RESULT |
 *                     SHAREHOLDER_MEET | MGMT_CHANGE | DIVIDEND |
 *                     BUYBACK | OTHER,
 *     materiality_score: 0–10  (heuristic: how earnings-relevant)
 *     fetched_at_iso,
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import { nseGet } from "../../nse.js";

const ROOT = process.cwd();
const ROLLING_PATH = path.join(ROOT, "data", "catalysts", "nse-announcements-rolling.json");

const ROLLING_WINDOW_DAYS = 30;

// ────────── Classification keyword table ──────────
// Order matters — first match wins. Patterns are intentionally
// permissive (regex) so a moderately-worded NSE announcement still
// gets classified. Material score is the V1 heuristic for how much
// the predictor should weight this announcement type.

const CLASSIFICATION_RULES = [
  // Top-tier earnings-relevant catalysts.
  { tag: "ORDER_WIN",          score: 8, re: /(received|secured|won|awarded|bagged|order|contract|loa|lo[ai]|letter\s*of\s*intent|tender)/i },
  { tag: "CAPACITY_EXPANSION", score: 7, re: /(capacity\s*expansion|new\s*plant|commissioning|production\s*line|capex|brownfield|greenfield)/i },
  { tag: "MA_DEAL",            score: 7, re: /(acquisition|takeover|amalgamation|merger|scheme\s*of\s*arrangement|de[\s-]*merger|spin[\s-]*off|joint\s*venture|jv\s*formation)/i },
  { tag: "RATING_ACTION",      score: 6, re: /(credit\s*rating|rating\s*upgrade|rating\s*downgrade|rating\s*affirmed|crisil|icra|care\s*ratings|ind[\s-]*ra|moody|s&p|fitch)/i },
  { tag: "FUND_RAISING",       score: 6, re: /(fund\s*rais|qip|qualified\s*institutional|preferential\s*allot|rights\s*issue|ncd|ncds|debentures|fcc[bn]|ecb)/i },

  // Negative catalysts — same magnitude, opposite directional bias.
  { tag: "LITIGATION",         score: 7, re: /(litigation|lawsuit|sebi\s*order|regulatory\s*order|investigation|raid|search\s*and\s*seizure|show\s*cause|penalty\s*imposed|adjudication|enforcement)/i },
  { tag: "MGMT_CHANGE",        score: 5, re: /(resignation|stepped\s*down|appointment.*ceo|appointment.*md|appointment.*cfo|change\s*in\s*directorate|appointment.*director|appointment.*chairman)/i },

  // Routine — low predictor weight but still tracked.
  { tag: "RESULT_INTIMATION",  score: 2, re: /(financial\s*results?|board\s*meeting|intimation.*board|outcome\s*of\s*board)/i },
  { tag: "SHAREHOLDER_MEET",   score: 1, re: /(postal\s*ballot|annual\s*general\s*meeting|extraordinary\s*general|egm|agm|shareholders\s*meeting)/i },
  { tag: "DIVIDEND",           score: 2, re: /(dividend|interim\s*dividend|final\s*dividend|record\s*date)/i },
  { tag: "BUYBACK",            score: 6, re: /(buy[\s-]*back|share\s*buyback)/i },
  { tag: "BONUS",              score: 4, re: /(bonus\s*issue|bonus\s*share)/i },
  { tag: "SPLIT",              score: 3, re: /(stock\s*split|sub[\s-]*division|share\s*split)/i },
];

function classifyAnnouncement(subject) {
  if (!subject) return { tag: "OTHER", score: 0 };
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.re.test(subject)) return { tag: rule.tag, score: rule.score };
  }
  return { tag: "OTHER", score: 0 };
}

// ────────── Date helpers ──────────

function parseNseTimestamp(s) {
  // NSE serves dates as either ISO ("2026-05-09 00:21:55") or
  // human format ("09-May-2026 01:20:29"). Normalise to ISO date.
  if (!s || typeof s !== "string") return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (dmy) {
    const months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    const m = months[dmy[2]];
    if (!m) return null;
    return `${dmy[3]}-${String(m).padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  return null;
}

function isoToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function daysAgo(isoDate, asOfIso) {
  const a = new Date((asOfIso || isoToday()) + "T00:00:00Z").getTime();
  const b = new Date(isoDate + "T00:00:00Z").getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}

// ────────── Cleaning ──────────

function cleanAnnouncement(raw, fetchedAtIso) {
  if (!raw || typeof raw !== "object") return null;
  const symbol = raw.symbol ? String(raw.symbol).trim().toUpperCase() : null;
  if (!symbol) return null;
  const subjectParts = [raw.desc, raw.attchmntText].filter((s) => typeof s === "string" && s.trim());
  const subject = subjectParts.join(" — ").trim();
  const announced = parseNseTimestamp(raw.sort_date) || parseNseTimestamp(raw.an_dt) || null;
  const cls = classifyAnnouncement(subject);
  return {
    symbol,
    name: raw.sm_name || raw.name || null,
    isin: raw.sm_isin || null,
    industry: raw.smIndustry || null,
    subject,
    announced_at_iso: announced,
    pdf_url: raw.attchmntFile || null,
    classification: cls.tag,
    materiality_score: cls.score,
    fetched_at_iso: fetchedAtIso,
    seq_id: raw.seq_id ? String(raw.seq_id) : null,
  };
}

// ────────── Public API ──────────

/**
 * Fetch the latest batch from NSE. Returns an array of cleaned items
 * (possibly empty). Returns null on hard failure so the script can
 * exit-75 without overwriting good prior data.
 */
export async function fetchLatestAnnouncements() {
  const fetchedAtIso = new Date().toISOString();
  let raw;
  try {
    raw = await nseGet("/api/corporate-announcements?index=equities");
  } catch (err) {
    console.error("[nse-announcements] fetch threw:", err.message);
    return null;
  }
  if (!raw) return null;

  // The endpoint returns either an array or an object with numeric keys.
  // Normalise to an array.
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (Array.isArray(raw.data)) arr = raw.data;
  else if (typeof raw === "object") arr = Object.values(raw);
  else arr = [];

  const cleaned = [];
  for (const r of arr) {
    const c = cleanAnnouncement(r, fetchedAtIso);
    if (c) cleaned.push(c);
  }
  return cleaned;
}

/**
 * Read the rolling-window cache from disk. Returns the empty-shape
 * default when the file is missing.
 */
export function loadAnnouncementsRolling() {
  if (!fs.existsSync(ROLLING_PATH)) {
    return {
      schema_version: "nse-announcements-rolling-v1",
      built_at: null,
      window_days: ROLLING_WINDOW_DAYS,
      announcement_count: 0,
      announcements: [],
    };
  }
  try {
    return JSON.parse(fs.readFileSync(ROLLING_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Merge a fresh batch into the rolling cache. Dedupes by `seq_id` (or
 * symbol+announced_at fallback), keeps only items within window_days,
 * sorts newest-first.
 */
export function mergeIntoRolling(rolling, freshBatch) {
  const today = isoToday();
  const seen = new Set();
  const merged = [];

  // Existing first — preserves older entries that the fresh fetch
  // doesn't include because the no-date endpoint only returns 20.
  for (const e of [...(rolling?.announcements || []), ...(freshBatch || [])]) {
    if (!e || !e.symbol || !e.announced_at_iso) continue;
    const da = daysAgo(e.announced_at_iso, today);
    if (da == null || da < 0 || da > ROLLING_WINDOW_DAYS) continue;
    const key = e.seq_id ? `seq:${e.seq_id}` : `${e.symbol}|${e.announced_at_iso}|${(e.subject || "").slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  merged.sort((a, b) => (a.announced_at_iso < b.announced_at_iso ? 1 : -1));

  return {
    schema_version: "nse-announcements-rolling-v1",
    built_at: new Date().toISOString(),
    window_days: ROLLING_WINDOW_DAYS,
    announcement_count: merged.length,
    announcements: merged,
  };
}

/**
 * Write atomically.
 */
export function writeAnnouncementsRolling(payload) {
  fs.mkdirSync(path.dirname(ROLLING_PATH), { recursive: true });
  const tmp = ROLLING_PATH + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, ROLLING_PATH);
}

/**
 * For each upcoming-result symbol, return the most-material recent
 * announcements. Used by signalAggregator.
 *
 * Returns: Map<symbol, Array<announcement>>
 */
export function buildPerSymbolAnnouncementIndex(rolling) {
  const map = new Map();
  for (const a of rolling?.announcements || []) {
    if (!a.symbol) continue;
    const arr = map.get(a.symbol) || [];
    arr.push(a);
    map.set(a.symbol, arr);
  }
  // Sort each symbol's list by materiality (desc), then date.
  for (const [, arr] of map) {
    arr.sort((a, b) => {
      if (a.materiality_score !== b.materiality_score) return b.materiality_score - a.materiality_score;
      return a.announced_at_iso < b.announced_at_iso ? 1 : -1;
    });
  }
  return map;
}
