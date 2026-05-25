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
 *   node scripts/refresh-earnings.mjs --window 60   (override 60d window)
 *
 * Exit codes:
 *   0   success
 *   1   unexpected failure
 *   75  EX_TEMPFAIL — upstream events-latest.json missing or empty
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the repo root BEFORE importing modules that read
// process.env at import-time. Launchd invokes this script via
// scripts/sws-nightly.sh with a minimal environment (PATH/HOME only),
// so without this load GROQ_API_KEY / GEMINI_API_KEY would be undefined
// and earningsLlmSignal.js would skip straight to the keyword heuristic
// (cf. data/catalysts/earnings-health.json showing 0 groq / 0 gemini /
// 474 heuristic until this load was added). Derived from __dirname so
// the load is robust against the script being invoked from anywhere.
// `override: false` lets a real shell-set env var win over the .env file.
dotenv.config({ path: path.join(__dirname, "..", ".env"), override: false });

import { buildEarningsCalendarFromPayload } from "../services/earnings/earningsCalendarBuilder.js";
import {
  buildAggregatorContext,
  aggregateSignalsForCalendar,
  summariseSignals,
} from "../services/earnings/signalAggregator.js";
import { predictCalendar, summarisePredictions } from "../services/earnings/earningsPredictor.js";
import {
  classifyBatchForCalendar,
  loadCache,
  writeCacheAtomic,
  CACHE_PATH as LLM_CACHE_PATH,
} from "../services/earnings/earningsLlmBatcher.js";
import { buildBandsForCalendar } from "../services/earnings/priceBandBuilder.js";
import { narrateCalendar } from "../services/earnings/earningsRationaleNarrator.js";
import {
  attachPlaybooksToCalendar,
  summarisePlaybooks,
} from "../services/earnings/reactionPlaybook.js";
import { archivePredictions } from "../services/earnings/earningsHistoryArchive.js";
import { buildRecentResults } from "../services/earnings/recentResultsBuilder.js";

const ROOT = process.cwd();
const IN_PATH = path.join(ROOT, "data", "catalysts", "events-latest.json");
const OUT_PATH = path.join(ROOT, "data", "catalysts", "earnings-watch-latest.json");
const STATS_PATH = path.join(ROOT, "data", "catalysts", "earnings-watch-stats.json");
const FUNDAMENTALS_PATH = path.join(ROOT, "fundamentalsHistory.json");
// Concurrency lock — sws-nightly launchd fires twice daily (02:00 + 16:30
// IST per com.starbhai.sws-nightly.plist). Without a lock, an ad-hoc
// manual refresh that overlaps a launchd run races on the cache write and
// silently discards ~hundreds of LLM calls. `data/.locks/` is gitignored.
const LOCK_PATH = path.join(ROOT, "data", ".locks", "earnings-refresh.lock");
const CACHE_BACKUP_DIR = path.join(ROOT, "data", ".backups");

// fundamentalsHistory.json feeds the predictor's YoY-EPS trajectory
// component. It's refreshed by its own nightly job (scripts/refresh-
// fundamentals-history.mjs) — NOT chained here. Surface staleness in
// the log so a stalled nightly job is visible in CI output.
function warnIfFundamentalsStale() {
  try {
    const ageDays = (Date.now() - fs.statSync(FUNDAMENTALS_PATH).mtimeMs) / 86400000;
    if (ageDays > 7) {
      console.warn(
        `[earnings-watch] ⚠ fundamentalsHistory.json is ${ageDays.toFixed(1)}d old — ` +
          `run scripts/refresh-fundamentals-history.mjs (YoY-EPS trajectory will be stale)`,
      );
    }
  } catch {
    console.warn(`[earnings-watch] ⚠ fundamentalsHistory.json missing — YoY-EPS trajectory disabled`);
  }
}

function parseArgs(argv) {
  const out = {
    windowDays: 60,
    skipLlm: false,
    pastWindowDays: 14,
    purgeHeuristicCache: false,
    yes: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--window") {
      const next = Number(argv[++i]);
      if (Number.isFinite(next) && next > 0) out.windowDays = next;
    } else if (a === "--past-window-days") {
      const next = Number(argv[++i]);
      if (Number.isFinite(next) && next >= 0) out.pastWindowDays = next;
    } else if (a === "--skip-llm") {
      // Force the deterministic heuristic for the LLM component — used
      // in CI and any offline run where network LLM calls aren't wanted.
      out.skipLlm = true;
    } else if (a === "--purge-heuristic-cache") {
      // One-shot maintenance: drop heuristic cache entries whose
      // _last_provider_attempt indicates the LLM never actually ran
      // (so the next refresh re-classifies them). Cache is backed up
      // to data/.backups/ first. Dry-run by default; --yes applies.
      out.purgeHeuristicCache = true;
    } else if (a === "--yes" || a === "-y") {
      out.yes = true;
    }
  }
  return out;
}

// ─── Lockfile + purge helpers (Layers B + D) ───

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  let lockFd;
  try {
    lockFd = fs.openSync(LOCK_PATH, "wx");
    fs.writeSync(lockFd, `pid=${process.pid} started=${new Date().toISOString()}\n`);
  } catch (err) {
    if (err.code === "EEXIST") {
      console.error(
        `[earnings-watch] another refresh is in progress — exiting cleanly. ` +
          `Lock at ${path.relative(ROOT, LOCK_PATH)} — delete if stale.`,
      );
      process.exit(0);
    }
    throw err;
  }
  const release = () => {
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(LOCK_PATH); } catch {}
  };
  process.on("exit", release);
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGINT", () => process.exit(130));
  return release;
}

// Drop heuristic-from-no-keys entries. Failed-LLM heuristics
// (_last_provider_attempt === "failed") are preserved so we don't
// hammer the events most likely to keep timing out. Always backs up
// the cache to data/.backups/ before writing.
function runPurgeHeuristicCache({ apply }) {
  if (!fs.existsSync(LLM_CACHE_PATH)) {
    console.log(`[purge] no cache at ${path.relative(ROOT, LLM_CACHE_PATH)} — nothing to do.`);
    return;
  }
  const cache = loadCache();
  const allEntries = Object.entries(cache.entries || {});
  const toPurge = allEntries.filter(([, v]) => {
    if (!v || v.classifier_provider !== "heuristic") return false;
    // _last_provider_attempt missing (pre-v2 entry) is treated as "none"
    // — eligible for re-classify. Only entries explicitly marked "failed"
    // are preserved.
    return v._last_provider_attempt !== "failed";
  });
  console.log(
    `[purge] heuristic-no-keys entries to remove: ${toPurge.length} (preserving ` +
      `${allEntries.length - toPurge.length} entries: real LLM results + failed-LLM heuristics)`,
  );
  if (!apply) {
    console.log(`[purge] dry-run only — re-run with --yes to apply.`);
    return;
  }
  fs.mkdirSync(CACHE_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const bakPath = path.join(CACHE_BACKUP_DIR, `llm-signal-cache.${stamp}.bak`);
  fs.copyFileSync(LLM_CACHE_PATH, bakPath);
  for (const [k] of toPurge) delete cache.entries[k];
  writeCacheAtomic(cache);
  console.log(
    `[purge] removed ${toPurge.length} entries; backup at ${path.relative(ROOT, bakPath)}`,
  );
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
export function buildStats(snapshot, llmStats) {
  const events = snapshot.events || [];
  const byDays = { d0: 0, d1to3: 0, d4to7: 0, d8to14: 0, d15to30: 0, d31to60: 0 };
  for (const e of events) {
    const d = e.days_until;
    if (d === 0) byDays.d0 += 1;
    else if (d >= 1 && d <= 3) byDays.d1to3 += 1;
    else if (d >= 4 && d <= 7) byDays.d4to7 += 1;
    else if (d >= 8 && d <= 14) byDays.d8to14 += 1;
    else if (d >= 15 && d <= 30) byDays.d15to30 += 1;
    else if (d >= 31 && d <= 60) byDays.d31to60 += 1;
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
    recent_results_count: Array.isArray(snapshot.recent_results) ? snapshot.recent_results.length : 0,
    past_window_days: snapshot.past_window_days ?? null,
    bucket_by_days: byDays,
    signals: signalSummary,
    predictions: predictionSummary,
    playbooks: playbookSummary,
    // LLM batcher stats — picked up by earnings-health-summary.mjs to alert
    // on heuristic_cache_invalidations spikes. Null when --skip-llm or no
    // events were classified.
    llm_stats: llmStats || null,
  };
}

async function main() {
  const args = parseArgs(process.argv);

  // ── Layer D: --purge-heuristic-cache short-circuit ──
  // Acquires the lock first so a concurrent refresh can't be racing on
  // the cache write. Backs up the cache before deleting any entries.
  if (args.purgeHeuristicCache) {
    acquireLock();
    runPurgeHeuristicCache({ apply: args.yes });
    return;
  }

  // ── Layer C: hard-exit-9 self-check (matches refresh-macro-regime.mjs) ──
  // PR #247 added dotenv loading + sws-nightly.sh env sourcing to fix the
  // long-standing "0 LLM calls" silent degradation. This is the regression
  // guard so a future env-pipeline break fails LOUDLY within hours instead
  // of silently shipping a heuristic-only snapshot over a known-good one
  // for weeks (the failure mode PR #247 spent weeks invisibly producing).
  // --skip-llm is the legitimate offline / CI escape hatch.
  const hasLlmKeys = !!(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY);
  const cacheExists = fs.existsSync(LLM_CACHE_PATH);
  if (!hasLlmKeys && cacheExists && !args.skipLlm) {
    console.error(`[earnings-watch] FATAL: no LLM keys loaded AND a non-empty cache exists.`);
    console.error(`                  refusing to overwrite a known-good snapshot with heuristic-only output.`);
    console.error(`                  - confirm .env contains GROQ_API_KEY and/or GEMINI_API_KEY`);
    console.error(`                  - confirm the invoker exports them (sws-nightly.sh does;`);
    console.error(`                    ad-hoc \`node scripts/refresh-earnings.mjs\` relies on dotenv.config above)`);
    console.error(`                  - for genuine offline / CI runs, pass --skip-llm explicitly`);
    process.exit(9);
  }

  // ── Layer B: acquire concurrency lock for the normal refresh path ──
  acquireLock();

  console.log(`[earnings-watch] reading ${path.relative(ROOT, IN_PATH)} ...`);
  warnIfFundamentalsStale();

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

  // ── LLM qualitative signal (predictor component 9) ──
  // Runs between aggregation and prediction so the predictor sees
  // signals.llm_signal. Groq → Gemini → heuristic fallback, hash-cached
  // on disk. --skip-llm forces the deterministic heuristic (CI/offline).
  // Mutates enrichedEvents in place.
  console.log(
    `[earnings-watch] classifying LLM qualitative signal` +
      `${args.skipLlm ? " (--skip-llm: heuristic only)" : ""}...`,
  );
  const tLlm = Date.now();
  const { stats: llmStats } = await classifyBatchForCalendar(enrichedEvents, {
    skipLlm: args.skipLlm,
  });
  console.log(
    `[earnings-watch] LLM signal done in ${((Date.now() - tLlm) / 1000).toFixed(1)}s ` +
      `(cache hits ${llmStats.cache_hits ?? 0}, llm calls ${llmStats.llm_calls ?? 0}, ` +
      `heuristic ${llmStats.heuristic ?? 0}, ` +
      `below V3 floor ${llmStats.below_v3_floor ?? 0}/${llmStats.composite_floor ?? "?"})`,
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

  // Recent/status tracker rows. Built from the history archive — the
  // current calendar's `events` array is upcoming-only by construction,
  // so the recent_results field is the only way the UI sees due rows that
  // are pending or resolved.
  // companyByEventKey lets the slim recent records carry the company
  // name (history rows only know the symbol). Two-source fallback:
  //   1) current calendar events — exact (symbol, event_iso_date) match
  //   2) SWS universe.json — symbol-only fallback for past events whose
  //      ticker rolled off the NSE calendar.
  const companyByEventKey = new Map();
  const companyBySymbol = new Map();
  for (const e of fullEvents) {
    if (e && e.symbol && e.event_iso_date && e.company) {
      companyByEventKey.set(`${e.symbol}|${e.event_iso_date}`, e.company);
      companyBySymbol.set(e.symbol, e.company);
    }
  }
  try {
    const universePath = path.join(ROOT, "data", "sws", "universe.json");
    if (fs.existsSync(universePath)) {
      const universe = JSON.parse(fs.readFileSync(universePath, "utf8"));
      for (const u of Array.isArray(universe) ? universe : []) {
        if (u && u.ticker && u.name && !companyBySymbol.has(u.ticker)) {
          companyBySymbol.set(u.ticker, u.name);
        }
      }
    }
  } catch (err) {
    console.warn(`[earnings-watch] companyBySymbol fallback failed: ${err.message}`);
  }
  const recentResults = buildRecentResults({
    todayIso: calendar.today_iso,
    pastWindowDays: args.pastWindowDays,
    companyByEventKey,
    companyBySymbol,
  });
  console.log(
    `[earnings-watch] recent_results: ${recentResults.length} status rows ` +
      `(window ${args.pastWindowDays}d back from ${calendar.today_iso})`,
  );

  const snapshot = {
    ...calendar,
    schema_version: "earnings-watch-v4",
    events: fullEvents,
    recent_results: recentResults,
    past_window_days: args.pastWindowDays,
  };

  writeJsonAtomic(OUT_PATH, snapshot);
  writeJsonAtomic(STATS_PATH, buildStats(snapshot, llmStats));

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

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(`[earnings-watch] FAILED:`, err.stack || err.message);
    process.exitCode = 1;
  });
}
