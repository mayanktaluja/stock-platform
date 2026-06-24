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

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

dotenv.config({ path: path.join(REPO_ROOT, ".env"), override: false });

const { fetchMacroHeadlines } = await import("../macroHeadlineFetcher.js");
const { compileWatchlist, matchHeadline } = await import("../services/alerts/watchlistGate.js");
const { formatNewsAlert } = await import("../services/alerts/newsAlert.js");
const { hasKey, recordSent } = await import("../services/alerts/sentLedger.js");
const { dispatch } = await import("../services/alerts/alertDispatcher.js");
const { suppressNews } = await import("../services/alerts/quietHours.js");

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
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.warn(`[news-alerts] fatal (swallowed): ${err.message}`);
    process.exit(0);
  });
