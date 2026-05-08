// One-shot backfill: replay every historic picks-latest.json revision into
// the paper-trade store so the Track Record tab has real history on day one
// instead of starting empty.
//
// For each commit that touched data/sws/picks-latest.json, we read that
// commit's version of the file and call snapshotAndCloseSwsPicks with the
// file's own scanned_at as the snapshot timestamp. Idempotent thanks to
// the existing (dateKey × type × symbol) dedup — re-running the script is
// a no-op for already-recorded snapshots.
//
// Walks oldest → newest so the close-then-snapshot ordering correctly
// closes prior positions when their section drops them in the next revision.
//
// Usage:
//   node scripts/sws-backfill-trade-log.mjs
//   node scripts/sws-backfill-trade-log.mjs --dry-run   # show plan, no writes
//   node scripts/sws-backfill-trade-log.mjs --limit 5   # only most recent N

import { execSync } from "node:child_process";
import YahooFinance from "yahoo-finance2";
import { snapshotAndCloseSwsPicks, readAllTrades, getStorageStats } from "../paperTrades.js";
import { getStorage } from "../paperTradesStorage.js";

const yf = new YahooFinance();

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipNifty = args.includes("--skip-nifty");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : null;

const FILE = "data/sws/picks-latest.json";

/**
 * Fetch ^NSEI daily close history covering all snapshot/close timestamps in
 * the trade log, return { "YYYY-MM-DD": closePrice }.
 */
async function fetchNiftyHistory(fromIso, toIso) {
  const result = await yf.chart("^NSEI", {
    period1: new Date(fromIso),
    period2: new Date(toIso),
    interval: "1d",
  });
  if (!result?.quotes) return {};
  const map = {};
  for (const q of result.quotes) {
    if (!q.date || q.close == null) continue;
    const key = new Date(q.date).toISOString().slice(0, 10);
    map[key] = q.close;
  }
  return map;
}

/** Find the close price for `dateIso`, falling back to the nearest prior trading day. */
function niftyOnOrBefore(map, dateIso) {
  if (!dateIso) return null;
  const key = new Date(dateIso).toISOString().slice(0, 10);
  if (map[key] != null) return map[key];
  // Walk back up to 7 days to find the most recent prior trading day
  const d = new Date(key);
  for (let i = 1; i <= 7; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const k = d.toISOString().slice(0, 10);
    if (map[k] != null) return map[k];
  }
  return null;
}

/**
 * Enrich every backfilled trade with `niftyAtSnapshot` and (if closed)
 * `niftyAtClose` so the alpha column actually renders for historical data.
 */
async function enrichNiftyForTrades() {
  const trades = await readAllTrades();
  const candidates = trades.filter((t) =>
    (t.niftyAtSnapshot == null && t.snapshotAt) ||
    (t.closedAt && t.niftyAtClose == null)
  );
  if (candidates.length === 0) {
    console.log("Nifty enrichment: nothing to do — every trade already has Nifty stamps.");
    return;
  }
  // Find the date range we need to cover
  const allDates = candidates.flatMap((t) => [t.snapshotAt, t.closedAt].filter(Boolean));
  const min = allDates.reduce((a, b) => (a < b ? a : b));
  const max = allDates.reduce((a, b) => (a > b ? a : b));
  // Pad each end by a week so on-or-before lookups always have a fallback
  const fromMs = new Date(min).getTime() - 14 * 86400000;
  const toMs = Math.min(Date.now(), new Date(max).getTime() + 14 * 86400000);
  console.log(`Fetching ^NSEI daily history ${new Date(fromMs).toISOString().slice(0,10)} → ${new Date(toMs).toISOString().slice(0,10)} (${candidates.length} trades to enrich)`);
  const niftyMap = await fetchNiftyHistory(new Date(fromMs).toISOString(), new Date(toMs).toISOString());
  const niftyDates = Object.keys(niftyMap).length;
  if (niftyDates === 0) {
    console.warn("  ⚠ Nifty history empty — Yahoo refused or rate-limited. Skipping enrichment.");
    return;
  }
  console.log(`  got ${niftyDates} trading days`);

  const patches = [];
  for (const t of candidates) {
    const patch = { id: t.id };
    if (t.niftyAtSnapshot == null) {
      const v = niftyOnOrBefore(niftyMap, t.snapshotAt);
      if (v != null) patch.niftyAtSnapshot = v;
    }
    if (t.closedAt && t.niftyAtClose == null) {
      const v = niftyOnOrBefore(niftyMap, t.closedAt);
      if (v != null) patch.niftyAtClose = v;
    }
    if (Object.keys(patch).length > 1) patches.push(patch);
  }
  if (patches.length === 0) {
    console.log("  no patches needed.");
    return;
  }
  const storage = getStorage();
  const result = await storage.updateById(patches);
  console.log(`  patched ${result.updated} trades  (missing=${result.missing || 0})`);
}

function listRevisions() {
  // Oldest-first so we replay in chronological order
  const out = execSync(`git log --reverse --format=%H -- ${FILE}`, { encoding: "utf-8" });
  const shas = out.split("\n").map((s) => s.trim()).filter(Boolean);
  return limit ? shas.slice(-limit) : shas;
}

function readAtRevision(sha) {
  try {
    const blob = execSync(`git show ${sha}:${FILE}`, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
    return JSON.parse(blob);
  } catch (e) {
    console.warn(`  ⚠ could not parse ${FILE} at ${sha.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

async function main() {
  const shas = listRevisions();
  console.log(`Backfilling ${shas.length} historic picks-latest.json revision${shas.length === 1 ? "" : "s"}${dryRun ? " (dry run)" : ""}`);

  const totals = { written: 0, skipped: 0, closed: 0, revisions: 0, empty: 0 };

  for (let i = 0; i < shas.length; i++) {
    const sha = shas[i];
    const picks = readAtRevision(sha);
    if (!picks) continue;
    if (!picks.sections) {
      // Old schema — pre-sections format, skip
      totals.empty++;
      continue;
    }
    const scannedAt = picks.scanned_at || null;
    const sectionCount = Object.values(picks.sections).filter((v) => Array.isArray(v) && v.length).length;
    const tickerCount = Object.values(picks.sections)
      .filter((v) => Array.isArray(v))
      .reduce((s, arr) => s + arr.length, 0);
    console.log(`[${i + 1}/${shas.length}] ${sha.slice(0, 8)}  scanned_at=${scannedAt || "—"}  sections=${sectionCount}  tickers=${tickerCount}`);

    if (dryRun) continue;

    try {
      const result = await snapshotAndCloseSwsPicks(picks, {
        snapshotAt: scannedAt,
        rationale: `Backfill from git ${sha.slice(0, 8)}`,
      });
      const ws = result.snapshot || {};
      const wc = result.close || {};
      totals.written += ws.written || 0;
      totals.skipped += ws.skipped || 0;
      totals.closed += wc.closed || 0;
      totals.revisions++;
      console.log(`     wrote=${ws.written || 0}  skipped=${ws.skipped || 0}  closed=${wc.closed || 0}`);
    } catch (e) {
      console.warn(`     ✗ ${e.message}`);
    }
  }

  console.log(`\nDone. ${totals.revisions} revisions processed, ${totals.empty} skipped (old schema).`);
  console.log(`Total: written=${totals.written}  skipped(dedup)=${totals.skipped}  closed=${totals.closed}`);

  if (!dryRun && !skipNifty) {
    console.log("");
    await enrichNiftyForTrades();
    const stats = await getStorageStats();
    console.log(`Final store: ${stats.lineCount || 0} entries  oldest=${stats.oldest || "—"}  newest=${stats.newest || "—"}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
