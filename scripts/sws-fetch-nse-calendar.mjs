#!/usr/bin/env node
/**
 * Fetch the NSE corporate-actions / board-meeting calendar and persist a
 * normalised slice (Financial Results events only) to
 *   data/sws/nse-event-calendar.json
 *
 * The SWS API capture pipeline does not surface next-earnings dates per
 * stock — earnings calendars live behind a different SWS GraphQL operation
 * we don't currently call (and would require auth + Cloudflare to capture).
 * NSE publishes the same data on a free public endpoint (/api/event-calendar),
 * so we use that as the canonical Indian-market source instead.
 *
 * Output shape:
 *   {
 *     fetched_at: "2026-04-29T18:30:00.000Z",
 *     event_count: 325,
 *     // Map keyed by NSE bare symbol (HDFCBANK, RELIANCE, …) — matches the
 *     // file naming convention under data/sws/deep/{TICKER}.json.
 *     by_symbol: {
 *       "HDFCBANK": { date: "2026-05-15", purpose: "Financial Results" }
 *     }
 *   }
 *
 * Notes:
 *  - When NSE lists multiple Financial Results events for a single symbol
 *    (rare — typically only one within 30 days), we keep the earliest future
 *    date.
 *  - Dates are normalised to ISO YYYY-MM-DD so categoriseStock's
 *    `new Date(date + "T00:00:00Z")` math just works.
 *  - Only events tagged "Financial Results" qualify — pure dividend or fund-
 *    raising board meetings are filtered out (their date alone doesn't carry
 *    the same investment-decision signal).
 *
 * Usage:
 *   node scripts/sws-fetch-nse-calendar.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchNseEventCalendar } from "../nse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, "..", "data", "sws", "nse-event-calendar.json");
const WINDOW_DAYS = 60;

const MONTHS = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

// NSE returns dates as DD-Mon-YYYY (e.g. "21-May-2026"). Convert to
// ISO YYYY-MM-DD; return null when input doesn't parse cleanly so we don't
// silently ship malformed dates downstream.
function toIsoDate(nseDate) {
  if (!nseDate || typeof nseDate !== "string") return null;
  const m = nseDate.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2]];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1]}`;
}

function istTodayIso(nowMs = Date.now()) {
  return new Date(nowMs + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const fromDate = istTodayIso();
  const toDate = addDays(fromDate, WINDOW_DAYS);
  console.log(`[nse-cal] fetching event calendar (${fromDate} → ${toDate}) …`);
  const events = await fetchNseEventCalendar({ fromDate, toDate, index: "equities" });
  console.log(`[nse-cal]   fetched ${events.length} raw events`);

  const today = new Date().toISOString().slice(0, 10);
  const bySymbol = {};
  let kept = 0;
  for (const e of events) {
    if (!/financial.results/i.test(e.purpose || "")) continue;
    const iso = toIsoDate(e.date);
    if (!iso || iso < today) continue;
    const sym = (e.symbol || "").toUpperCase();
    if (!sym) continue;
    const existing = bySymbol[sym];
    // Earliest future date wins.
    if (!existing || iso < existing.date) {
      bySymbol[sym] = { date: iso, purpose: e.purpose, description: e.description || null };
      kept++;
    }
  }

  const out = {
    fetched_at: new Date().toISOString(),
    source: "https://www.nseindia.com/api/event-calendar",
    source_window: {
      from_date: fromDate,
      to_date: toDate,
      window_days: WINDOW_DAYS,
    },
    raw_event_count: events.length,
    event_count: kept,
    by_symbol: bySymbol,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`[nse-cal] ✅ wrote ${OUT_PATH} — ${kept} Financial Results events covering ${Object.keys(bySymbol).length} symbols`);
}

main().catch((e) => {
  console.error(`[nse-cal] FAILED: ${e.message}`);
  process.exit(1);
});
