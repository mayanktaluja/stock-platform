#!/usr/bin/env node
/**
 * Catalysts Today — refresh script (SWS-style persistence).
 *
 * Pulls NSE's `/api/event-calendar` via the existing nse.js plumbing,
 * normalises, and writes data/catalysts/events-latest.json. No KV — the
 * file is committed and Vercel reads it at deploy time.
 *
 * Cadence: run when you want fresh data. NSE updates events daily as
 * companies file board-meeting intimations; once a day is plenty.
 *
 * Usage:
 *   node scripts/refresh-catalysts.mjs
 *
 * Exit codes:
 *   0  success
 *   1  unexpected failure
 *   75 EX_TEMPFAIL — NSE blocked / Cloudflare; retry later
 */

import fs from "node:fs";
import path from "node:path";

import { fetchNseEventCalendar } from "../nse.js";

const ROOT = process.cwd();
const OUT_PATH = path.join(ROOT, "data", "catalysts", "events-latest.json");
const WINDOW_DAYS = 60;

function istTodayIso(nowMs = Date.now()) {
  return new Date(nowMs + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

async function main() {
  const fromDate = istTodayIso();
  const toDate = addDays(fromDate, WINDOW_DAYS);
  console.log(`[catalysts] fetching NSE event calendar (${fromDate} → ${toDate})...`);
  const events = await fetchNseEventCalendar({ fromDate, toDate, index: "equities" });
  if (!events || events.length === 0) {
    console.error(`[catalysts] NSE returned 0 events — refusing to overwrite (likely blocked)`);
    process.exitCode = 75;
    return;
  }

  const payload = {
    schemaVersion: "catalysts-events-v1",
    fetched_at: new Date().toISOString(),
    source: "nseindia.com/api/event-calendar",
    source_window: {
      from_date: fromDate,
      to_date: toDate,
      window_days: WINDOW_DAYS,
    },
    event_count: events.length,
    events,
  };

  writeJsonAtomic(OUT_PATH, payload);
  console.log(
    `[catalysts] wrote ${events.length} events to ${path.relative(ROOT, OUT_PATH)} ` +
    `(date range: ${events[0]?.date || "?"} → ${events[events.length - 1]?.date || "?"})`,
  );
}

main().catch((err) => {
  console.error(`[catalysts] FAILED:`, err.message);
  process.exitCode = 1;
});
