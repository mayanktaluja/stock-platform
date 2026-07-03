#!/usr/bin/env node
/**
 * Watchlist news poller — fast-news-alerts Phase 2 (NEWS class).
 *
 * Reads fresh macro headlines, keeps the ones that mention a watchlist ticker,
 * dedups against the sent-ledger, and pushes each new one to Telegram.
 *
 * Runs from the CANONICAL repo, read-only, NO git worktree (adversarial H1 —
 * copying the macro cron's `git worktree add`+`prune` would race the macro
 * cron's live worktree). Its wrapper (scripts/news-alerts-poll.sh) holds a
 * PID-lock distinct from the macro cron's.
 *
 * Latency/staleness (L3): fetch a small recent window and drop anything older
 * than --window-min so a wake-from-sleep can't replay yesterday's headlines as
 * fresh. The ledger is the second line of defence against re-sends.
 *
 * Always exits 0 — a poller failure must never escalate.
 *
 * Usage:
 *   node scripts/refresh-news-alerts.mjs                  # poll + send
 *   node scripts/refresh-news-alerts.mjs --dry-run        # match + log, no send
 *   node scripts/refresh-news-alerts.mjs --window-min 90  # freshness window
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

dotenv.config({ path: path.join(REPO_ROOT, ".env"), override: false });

const { fetchMacroHeadlines } = await import("../macroHeadlineFetcher.js");
const { compileWatchlist, matchHeadline } = await import("../services/alerts/watchlistGate.js");
const { formatNewsAlert } = await import("../services/alerts/newsAlert.js");
const { hasKey, recordSent, ledgerDir } = await import("../services/alerts/sentLedger.js");
const { dispatch } = await import("../services/alerts/alertDispatcher.js");
const { suppressNews } = await import("../services/alerts/quietHours.js");
const { formatEntryTransition } = await import("../services/alerts/entryAlert.js");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const windowIdx = argv.indexOf("--window-min");
const WINDOW_MIN = windowIdx >= 0 ? Number(argv[windowIdx + 1]) || 90 : 90;
const WATCHLIST_PATH = path.join(REPO_ROOT, "data", "alerts", "watchlist.json");

function loadWatchlist() {
  try { return JSON.parse(readFileSync(WATCHLIST_PATH, "utf-8")); }
  catch (err) { console.warn(`[news-alerts] watchlist unreadable (${err.message}) — nothing to match`); return null; }
}

function isFresh(headline, now) {
  if (!headline.publishedAt) return false; // undated → can't prove fresh, skip (L3)
  const ts = new Date(headline.publishedAt).getTime();
  return Number.isFinite(ts) && now - ts <= WINDOW_MIN * 60 * 1000;
}

// ─── Entry-transition queue drain (Two-Key Entry PR-3, ENTRY class) ───────
//
// The nightly scoring writes alertable entry_timing state TRANSITIONS to a
// pending-queue file at `${ALERTS_LEDGER_DIR}/entry-transitions-pending.json`
// (same canonical-dir resolution as the sent-ledger — the nightly runs in a
// throwaway worktree, so the queue must live at the canonical repo path).
// This poller drains it every tick: format → dedup-check → dispatch →
// record-AFTER-confirmed-send → drop from the queue. A failed send stays
// queued and retries next tick; non-alertable / already-sent rows drop
// immediately. Cheap no-op when the queue is absent or empty.

export const ENTRY_QUEUE_FILENAME = "entry-transitions-pending.json";

export function entryQueuePath(env = process.env) {
  return path.join(ledgerDir(env), ENTRY_QUEUE_FILENAME);
}

/**
 * Drain the pending entry-transition queue. Pure-ish: all effects flow through
 * `deps` ({hasKey, recordSent, dispatch, log}) so tests inject fakes; the
 * poller passes the real modules. Never throws — resolves a summary object.
 *
 * Queue rewrite is ATOMIC (tmp + rename) with survivors only; the file is
 * deleted when everything drained. --dry-run logs would-sends and leaves the
 * queue byte-identical.
 */
export async function drainEntryQueue({
  queuePath = entryQueuePath(),
  dryRun = false,
  deps = {},
} = {}) {
  const {
    hasKey: hasKeyDep = hasKey,
    recordSent: recordSentDep = recordSent,
    dispatch: dispatchDep = dispatch,
    log = console,
  } = deps;

  let raw;
  try {
    raw = readFileSync(queuePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return { absent: true, sent: 0, dup: 0, dropped: 0, kept: 0 };
    log.warn?.(`[entry-drain] queue unreadable (${err.message}) — skipping this tick`);
    return { error: "unreadable", sent: 0, dup: 0, dropped: 0, kept: 0 };
  }

  let queue;
  try {
    queue = JSON.parse(raw);
  } catch (err) {
    // Corrupt queue: leave it on disk for inspection — the nightly writer
    // overwrites it wholesale, so this self-heals within a day and the warn
    // line makes the corruption visible in the poll log meanwhile.
    log.warn?.(`[entry-drain] queue corrupt (${err.message}) — leaving file untouched`);
    return { error: "corrupt", sent: 0, dup: 0, dropped: 0, kept: 0 };
  }

  const transitions = Array.isArray(queue?.transitions) ? queue.transitions : [];
  const survivors = [];
  let sent = 0;
  let dup = 0;
  let dropped = 0;

  for (const tr of transitions) {
    let alert = null;
    try { alert = formatEntryTransition(tr); } catch { alert = null; }
    if (!alert) { dropped += 1; continue; } // non-alertable — drop, no retry

    // Dedup CHECK (read-only) before sending — e.g. the 08:30 pre-open tick
    // and a later market-hours tick both seeing the same overnight queue.
    if (hasKeyDep(alert.key)) { dup += 1; continue; }

    if (dryRun) {
      sent += 1; // "would send"
      log.log?.(`[entry-drain] would send${alert.breaking ? " (breaking)" : ""}: ${alert.text.replace(/\n/g, " ⏎ ")}`);
      continue; // queue untouched in dry-run — no rewrite below
    }

    const res = await dispatchDep(alert);
    const delivered = !!(res && res.ok && !res.skipped);
    if (delivered) {
      // Record ONLY after a confirmed delivery (record-after-send is a hard
      // rule) — a skipped (unconfigured) or failed send leaves the row queued
      // so it retries next tick, never silently lost.
      recordSentDep(alert.key);
      sent += 1;
      continue; // delivered — drop from queue
    }
    survivors.push(tr); // send failed/skipped — keep for retry
  }

  if (!dryRun) {
    if (survivors.length === 0) {
      try { unlinkSync(queuePath); } catch { /* already gone — fine */ }
    } else if (survivors.length !== transitions.length) {
      // Atomic rewrite with survivors only (tmp + rename — a crash mid-write
      // can never leave a truncated queue behind).
      try {
        const next = { ...queue, transitions: survivors, drained_at: new Date().toISOString() };
        const tmp = `${queuePath}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
        renameSync(tmp, queuePath);
      } catch (err) {
        log.warn?.(`[entry-drain] queue rewrite failed (${err.message}) — rows may re-check next tick (ledger dedups)`);
      }
    }
  }

  log.log?.(`[entry-drain] queued=${transitions.length} sent=${sent}${dryRun ? " (dry-run)" : ""} dup=${dup} dropped=${dropped} kept=${survivors.length}`);
  return { sent, dup, dropped, kept: survivors.length };
}

async function main() {
  const now = Date.now();
  const watchlist = loadWatchlist();
  if (!watchlist) return 0;

  const compiled = compileWatchlist(watchlist);
  if (!compiled.perSymbol.length) {
    console.warn("[news-alerts] watchlist has no usable tickers — nothing to match");
    return 0;
  }

  // Fetch a 2h window (overlap > poll cadence so nothing slips), then trim to
  // the freshness window so stale items can't replay.
  const headlines = await fetchMacroHeadlines({ hours: 2 });
  const fresh = (Array.isArray(headlines) ? headlines : []).filter((h) => isFresh(h, now));
  console.log(`[news-alerts] fetched=${headlines.length ?? 0} fresh<=${WINDOW_MIN}m=${fresh.length}`);

  let matched = 0;
  let sent = 0;
  let quiet = 0;
  let dup = 0;

  for (const h of fresh) {
    const m = matchHeadline(h.title, compiled);
    if (!m.matched) continue;
    matched += 1;

    const alert = formatNewsAlert(h, m);
    if (!alert) continue;

    if (suppressNews({ breaking: alert.breaking, date: new Date(now) })) {
      quiet += 1;
      continue;
    }

    // Dedup CHECK before sending (read-only). The wrapper's PID lock makes the
    // NEWS class single-instance, so check→send→record can't race.
    if (!DRY_RUN && hasKey(alert.key)) { dup += 1; continue; }

    const res = await dispatch(alert, { dryRun: DRY_RUN });
    const delivered = res.ok && !res.skipped;
    if (delivered || (DRY_RUN && res.skipped)) sent += 1;

    // Record the key ONLY after a confirmed delivery. A skipped (unconfigured)
    // or failed send leaves the key unclaimed so it retries next poll — never
    // silently lost (the claim-before-send bug that ate the first 11:30 run).
    if (delivered) recordSent(alert.key);

    if (DRY_RUN) console.log(`[news-alerts] would send: ${alert.text.replace(/\n/g, " ⏎ ")}`);
  }

  console.log(`[news-alerts] matched=${matched} sent=${sent} quiet-suppressed=${quiet} dedup-skipped=${dup}`);

  // Entry-transition queue drain (Two-Key Entry PR-3) — runs every tick after
  // the news flow. A drain failure must never kill the news poll (and
  // drainEntryQueue itself never throws — this is belt-and-braces).
  try {
    await drainEntryQueue({ queuePath: entryQueuePath(), dryRun: DRY_RUN });
  } catch (err) {
    console.warn(`[news-alerts] entry-queue drain failed (swallowed): ${err.message}`);
  }

  return 0;
}

// Only run the poller when executed directly (`node scripts/refresh-news-alerts.mjs`)
// — tests import { drainEntryQueue } from this module and must not trigger a poll.
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.warn(`[news-alerts] fatal (swallowed): ${err.message}`);
      process.exit(0);
    });
}
