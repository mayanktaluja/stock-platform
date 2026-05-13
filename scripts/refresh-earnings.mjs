#!/usr/bin/env node
/**
 * Earnings Watch — refresh script.
 *
 * Mirrors scripts/refresh-catalysts.mjs in shape: read upstream JSON,
 * normalise, write atomic snapshot, never overwrite on failure.
 *
 * Milestone A scope: calendar only. Reads the already-persisted NSE
 * event-calendar (data/catalysts/events-latest.json) and emits a
 * normalised, deduped, dated list of upcoming result events plus a
 * stats sidecar that the UI's tab-header chips consume.
 *
 * Later milestones will fold in news, peer reactions, predictions,
 * price bands, and the T+1 reaction playbook by importing additional
 * services/earnings/* modules into this single script. The output
 * filename does NOT change as scope grows — downstream consumers only
 * ever read data/catalysts/earnings-watch-latest.json.
 *
 * Cadence:
 *   - Run locally before market open (target 07:30 IST) and post-market
 *     (17:00 IST). Commit the resulting JSON.
 *   - NSE's homepage rejects Vercel datacenter IPs (see nse.js:76-83),
 *     so this script must NOT be invoked from a Vercel cron.
 *
 * Usage:
 *   node scripts/refresh-earnings.mjs
 *   node scripts/refresh-earnings.mjs --window 60   (override 30d window)
 *
 * Exit codes:
 *   0   success
 *   1   unexpected failure
 *   75  EX_TEMPFAIL — upstream events-latest.json missing or empty
 */

import fs from "node:fs";
import path from "node:path";

import { buildEarningsCalendarFromPayload } from "../services/earnings/earningsCalendarBuilder.js";
import {
  buildAggregatorContext,
  aggregateSignalsForCalendar,
  summariseSignals,
} from "../services/earnings/signalAggregator.js";
import { predictCalendar, summarisePredictions } from "../services/earnings/earningsPredictor.js";
import { buildBandsForCalendar } from "../services/earnings/priceBandBuilder.js";
import { narrateCalendar } from "../services/earnings/earningsRationaleNarrator.js";
import {
  attachPlaybooksToCalendar,
  summarisePlaybooks,
} from "../services/earnings/reactionPlaybook.js";
import { archivePredictions } from "../services/earnings/earningsHistoryArchive.js";

const ROOT = process.cwd();
const IN_PATH = path.join(ROOT, "data", "catalysts", "events-latest.json");
const OUT_PATH = path.join(ROOT, "data", "catalysts", "earnings-watch-latest.json");
const STATS_PATH = path.join(ROOT, "data", "catalysts", "earnings-watch-stats.json");

function parseArgs(argv) {
  const out = { windowDays: 30 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--window") {
      const next = Number(argv[++i]);
      if (Number.isFinite(next) && next > 0) out.windowDays = next;
    }
  }
  return out;
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function loadEventsPayload() {
  if (!fs.existsSync(IN_PATH)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(IN_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.events)) return null;
    return parsed;
  } catch (err) {
    console.error(`[earnings-watch] failed to parse ${IN_PATH}:`, err.message);
    return null;
  }
}

/**
 * Build a small stats sidecar consumed by the UI tab header. Keeping it
 * separate from the main snapshot lets the tab show a 1-line summary
 * without parsing the full events array client-side.
 *
 * Milestone-A stats are simple counts; later milestones will add
 * data_quality breakdown (HIGH/MED/LOW) and predicted-verdict counts.
 */
function buildStats(snapshot) {
  const events = snapshot.events || [];
  const byDays = { d0: 0, d1to3: 0, d4to7: 0, d8to14: 0, d15to30: 0 };
  for (const e of events) {
    const d = e.days_until;
    if (d === 0) byDays.d0 += 1;
    else if (d >= 1 && d <= 3) byDays.d1to3 += 1;
    else if (d >= 4 && d <= 7) byDays.d4to7 += 1;
    else if (d >= 8 && d <= 14) byDays.d8to14 += 1;
    else if (d >= 15 && d <= 30) byDays.d15to30 += 1;
  }
  // Milestone B adds the signal rollup. The earningsCalendar (M-A
  // events have no `signals`) still produces a valid stats blob —
  // summariseSignals just reports zeros across the board. Milestone C
  // tacks on the predicted-verdict counts. Milestone E adds the
  // playbook highlighted-branch counts ("RAISE-watch" vs "CUT-watch").
  const signalSummary = summariseSignals(events);
  const predictionSummary = summarisePredictions(events);
  const playbookSummary = summarisePlaybooks(events);
  return {
    schema_version: "earnings-watch-stats-v4",
    built_at: snapshot.built_at,
    today_iso: snapshot.today_iso,
    window_days: snapshot.window_days,
    upstream_event_count: snapshot.upstream_event_count,
    upstream_fetched_at: snapshot.upstream_fetched_at,
    event_count: snapshot.event_count,
    bucket_by_days: byDays,
    signals: signalSummary,
    predictions: predictionSummary,
    playbooks: playbookSummary,
  };
}

function main() {
  const args = parseArgs(process.argv);
  console.log(`[earnings-watch] reading ${path.relative(ROOT, IN_PATH)} ...`);

  const payload = loadEventsPayload();
  if (!payload) {
    console.error(
      `[earnings-watch] upstream events JSON missing or unreadable — refusing to overwrite (run scripts/refresh-catalysts.mjs first)`,
    );
    process.exitCode = 75;
    return;
  }

  console.log(
    `[earnings-watch] upstream has ${payload.event_count ?? payload.events.length} events, ` +
      `fetched_at=${payload.fetched_at || "?"}`,
  );

  const calendar = buildEarningsCalendarFromPayload(payload, {
    windowDays: args.windowDays,
  });

  // Hard guard — if the calendar collapses to 0 we still write the
  // snapshot (it's a valid state), but stamp a warning so the UI can
  // surface a "no upcoming results in the next N days" empty state
  // rather than a broken-data error.
  if (calendar.event_count === 0) {
    console.warn(
      `[earnings-watch] 0 upcoming result events in next ${calendar.window_days}d — writing empty snapshot`,
    );
  }

  // ── Milestone B: aggregate signals per event ──
  // Sector momentum scan walks the full SWS deep dir (~5,400 files);
  // it's the heaviest step but only runs once per refresh.
  console.log(`[earnings-watch] aggregating signals for ${calendar.event_count} events...`);
  const tBefore = Date.now();
  const ctx = buildAggregatorContext();
  const enrichedEvents = aggregateSignalsForCalendar(calendar.events, ctx);
  const tAfter = Date.now();
  console.log(
    `[earnings-watch] aggregation done in ${((tAfter - tBefore) / 1000).toFixed(1)}s ` +
      `(scanned ${ctx._sectorMomentumScannedFiles ?? 0} sws-deep files for sector momentum)`,
  );

  // ── Milestone C: predict + price bands + 3-paragraph rationale ──
  // Each step is a pure transform that stacks one field on the event:
  //   .signals  →  .prediction  →  .price_band  →  .rationale
  // Order matters: rationale narrator reads price_band, which reads
  // prediction, which reads signals.
  console.log(`[earnings-watch] scoring predictions + price bands + rationale...`);
  const tPredStart = Date.now();
  const predictedEvents = predictCalendar(enrichedEvents);
  const bandedEvents = buildBandsForCalendar(predictedEvents);
  const narratedEvents = narrateCalendar(bandedEvents);
  console.log(
    `[earnings-watch] prediction layer done in ${((Date.now() - tPredStart) / 1000).toFixed(1)}s`,
  );

  // ── Milestone E: attach the 9-cell reaction playbook ──
  // Pre-result preview by default; idempotent — preserves any T+1
  // playbooks that may have been written by a future T+1 ingester
  // (Milestone F will populate them).
  console.log(`[earnings-watch] attaching reaction playbooks...`);
  const fullEvents = attachPlaybooksToCalendar(narratedEvents);

  const snapshot = {
    ...calendar,
    schema_version: "earnings-watch-v4",
    events: fullEvents,
  };

  writeJsonAtomic(OUT_PATH, snapshot);
  writeJsonAtomic(STATS_PATH, buildStats(snapshot));

  // ── Milestone F: archive today's predictions for future backtest ──
  // Idempotent across reruns within the same day. Preserves any
  // `actual_*` fields that were filled in by a future ingester.
  const archive = archivePredictions(snapshot.events);
  console.log(
    `[earnings-watch] archived ${archive.event_count} predictions to ${path.relative(ROOT, archive.path)} ` +
      `(preserved actuals: ${archive.preserved_actuals})`,
  );

  const first = snapshot.events[0]?.event_iso_date || "?";
  const last = snapshot.events[snapshot.events.length - 1]?.event_iso_date || "?";
  console.log(
    `[earnings-watch] wrote ${snapshot.event_count} events to ${path.relative(ROOT, OUT_PATH)} ` +
      `(${first} → ${last})`,
  );
  console.log(
    `[earnings-watch] stats written to ${path.relative(ROOT, STATS_PATH)}`,
  );
}

try {
  main();
} catch (err) {
  console.error(`[earnings-watch] FAILED:`, err.stack || err.message);
  process.exitCode = 1;
}
