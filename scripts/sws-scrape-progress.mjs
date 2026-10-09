#!/usr/bin/env node
/**
 * India API-scrape progress, read the way the scraper itself reads it.
 *
 * A shard's cursor (`next_local_index` in data/sws/progress-api-<n>.json) is an
 * integer offset into a slice that is NOT stored anywhere: sws-api-scrape.mjs
 * derives it at runtime from data/sws/universe.json via shardSliceContiguous.
 * So "how far did shard 2 get" needs the universe too, and this module is the
 * one place that joins them, for the nightly's mails.
 *
 * It also owns resume-after-abort (see the section below for why it skips
 * per STOCK rather than carrying cursors).
 *
 * CLI (all accept --data-dir <dir>, default <repo>/data/sws):
 *   summary          one line per shard: cursor / slice, last ticker, last write age
 *   mark-abort       --run-started-epoch S — write _resume-scrape.json after a
 *                    deadline abort (sws-nightly-isolated.sh, exit 10)
 *   consume-resume   evaluate + archive the marker (sws-refresh-api.sh step 3).
 *                    key=value lines, `---`, human summary. Exit 0; 2 = error.
 *   topup-list       --log FILE... — after a resumed pass: skipped stocks that are
 *                    no longer fresh enough (step 4b). key=value lines.
 *
 * Only node: builtins plus sws-shard-partition.mjs (→ sws-config.mjs, builtins
 * only) are imported, so bash tests can copy these three files into a fixture.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHARD_COUNT, shardSliceContiguous } from "./sws-shard-partition.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
export const DEFAULT_DATA_DIR = path.join(REPO_ROOT, "data", "sws");

const HOUR_MS = 3_600_000;

// "2026-09-30 17:09:00 IST" — same rendering as sws-panic-policy.mjs.
export function formatIst(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  try {
    const s = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Kolkata",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms));
    return `${s} IST`;
  } catch {
    // small-icu Node builds lack Asia/Kolkata; IST has no DST, so shift by hand.
    return `${new Date(ms + 5.5 * HOUR_MS).toISOString().slice(0, 19).replace("T", " ")} IST`;
  }
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "?";
  const mins = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Same shape handling as sws-api-scrape.mjs loadUniverse(). Missing → []. */
export function loadUniverse(dataDir = DEFAULT_DATA_DIR) {
  const raw = readJson(path.join(dataDir, "universe.json"));
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : raw.stocks || raw.universe || [];
  return Array.isArray(arr) ? arr : [];
}

/** Per-shard cursor vs slice. `slice_size` is null when universe.json is unreadable. */
export function shardProgress({ dataDir = DEFAULT_DATA_DIR, universe = loadUniverse(dataDir), totalShards = SHARD_COUNT } = {}) {
  const rows = [];
  for (let sid = 1; sid <= totalShards; sid++) {
    const p = readJson(path.join(dataDir, `progress-api-${sid}.json`));
    const sliceSize = universe.length ? shardSliceContiguous(universe, sid, totalShards).length : null;
    const cursor = Number.isFinite(Number(p?.next_local_index)) ? Number(p.next_local_index) : null;
    const lastRunMs = Date.parse(p?.last_run_at || "");
    rows.push({
      shard: sid,
      present: Boolean(p),
      next_local_index: cursor,
      slice_size: sliceSize,
      // Cursor vs slice ONLY. The file's `complete` field is written by the
      // legacy DOM driver and the universe-rebuild scripts, never by
      // sws-api-scrape.mjs, and the step-3 rewind leaves it alone — so it can
      // read true at cursor 0.
      finished: cursor !== null && sliceSize !== null && sliceSize > 0 && cursor >= sliceSize,
      done_count: Number.isFinite(Number(p?.done_count)) ? Number(p.done_count) : null,
      today_count: Number.isFinite(Number(p?.today_count)) ? Number(p.today_count) : null,
      today_date: p?.today_date || null,
      last_ticker: p?.last_ticker || null,
      last_run_ms: Number.isFinite(lastRunMs) ? lastRunMs : null,
    });
  }
  return rows;
}

export function formatProgressLine(row, now = Date.now()) {
  if (!row.present) return `shard ${row.shard}: no progress-api-${row.shard}.json`;
  const pos = row.next_local_index ?? "?";
  const of = row.slice_size ?? "?";
  const pct = row.next_local_index !== null && row.slice_size ? ` (${Math.min(100, Math.round((row.next_local_index / row.slice_size) * 100))}%)` : "";
  const last = row.last_run_ms !== null
    ? ` · last ${row.last_ticker || "?"} at ${formatIst(row.last_run_ms)} (${formatDuration(now - row.last_run_ms)} ago)`
    : "";
  return `shard ${row.shard}: next_local_index ${pos}/${of}${pct}${row.finished ? " · slice finished" : ""}${last}`;
}

export function formatSummary(rows, now = Date.now()) {
  return rows.map((r) => formatProgressLine(r, now)).join("\n");
}

// ────────── Resume after a deadline abort ──────────
//
// WHY: on 2026-09-26 and 09-29 the run was killed by the wrapper's deadline
// with shards at 21% / 67%, and the next run's step-3 rewind sent every cursor
// back to 0 — all of that work was fetched again. The obvious fix, "skip the
// rewind and continue from the saved cursor", was replayed against the real
// sanity gate first and FAILS in every scenario (09-29 timings: fresh_pct
// 45.8 vs the 85 block floor; 67%-carried: 33.0). The gate counts a stock as
// fresh when its deep brief's parsed_at — copied from the raw payload's
// fetchedAt, so re-parsing cannot hide age — is within 24h of the run's finish.
// Payloads carried from the aborted day are 20-30h old by then. It would also
// trip the 36h view-time top-up demotion (swsHoldingEngine.js) for every
// carried stock within hours of publish, and a cursor carried from a FINISHED
// shard would scrape nothing and re-ship stale data — the very no-op the
// rewind exists to prevent. Cursors are also positional against universe.json,
// so any universe change between the runs points them at different stocks.
//
// So the unit of reuse is the STOCK, not the cursor: the rewind still happens,
// and the resumed run skips only stocks whose raw payload is younger than
// RESUME_FRESH_MAX_AGE_HOURS when the shard reaches them. Ages are per ticker,
// so a universe change between the runs cannot misattribute anything.
//
// The bound is MEASURED, not assumed. A skip decision cannot know how long the
// rest of the run will take — a resumed run follows a night the host slept
// through, and may sleep again, finishing as late as its deadline (~21h out).
// So once the shards finish, sws-refresh-api.sh step 4b re-checks every skipped
// stock and refetches (--tickers) any whose payload is now older than
// RESUME_TOPUP_MAX_AGE_HOURS. Fast night: nothing to refetch. Slow night:
// exactly the stocks that would otherwise go stale.
//
// Pinned against both real gates by test/swsScrapeProgress.test.mjs:
//   age at publish ≤ RESUME_TOPUP_MAX_AGE_HOURS (8) + RESUME_POST_SCRAPE_TAIL_HOURS (4) = 12h
//     the tail: ~2h15m parse/score + the nightly's post-barrier ship on a
//     healthy night (6.3-8.6h total, scrape ~3.5-3.9h of it). A host that
//     sleeps through parse/score ages every early-fetched stock alike.
//   sanity gate: fresh = parsed_at within 24h of finish → 12h of slack.
//   36h top-up demotion (Math.round(age) > 36, i.e. ≥ 36.5h, at VIEW time):
//     lands ≥ 24.5h after publish — after the next on-time publish.
// Both gates keep their meaning; nothing about them changes. Larger bounds buy
// more reuse at the cost of carried names showing HOLD before the next
// publish — a product call, not a tuning detail.
//
// The marker is the gate on all this: only a run that follows a deadline abort
// skips anything, so a normal night and a manual re-run behave exactly as before.

export const RESUME_MAX_MARKER_AGE_HOURS = 30;
export const RESUME_MAX_CARRY = 1;
export const RESUME_FRESH_MAX_AGE_HOURS = 7;
export const RESUME_TOPUP_MAX_AGE_HOURS = 8;
export const RESUME_POST_SCRAPE_TAIL_HOURS = 4;
// aborted_at further in the future than this is a clock/hand-edit problem.
const FUTURE_SKEW_MS = 5 * 60_000;

const iso = (ms) => new Date(ms).toISOString();

export function resumePaths(dataDir = DEFAULT_DATA_DIR) {
  return {
    marker: path.join(dataDir, "_resume-scrape.json"),
    consumed: path.join(dataDir, "_resume-scrape.consumed.json"),
    rawDir: path.join(dataDir, "deep-api"),
  };
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * After a deadline abort. carry = how many consecutive aborted runs are being
 * reused: 1, unless THIS run (started at runStartedMs) itself consumed a
 * "resume" marker — then it is that marker's carry + 1, and the next run
 * (carry > RESUME_MAX_CARRY) fetches everything again.
 */
export function markAbort({ dataDir = DEFAULT_DATA_DIR, now = Date.now(), runStartedMs = null } = {}) {
  const { marker, consumed } = resumePaths(dataDir);
  const prev = readJson(consumed);
  const prevConsumedMs = Date.parse(prev?.consumed_at || "");
  const chained = prev?.verdict === "resume"
    && Number.isFinite(prevConsumedMs) && Number.isFinite(runStartedMs) && prevConsumedMs >= runStartedMs;
  const carry = chained ? (Number(prev.carry) || 1) + 1 : 1;
  const m = {
    schema: 1,
    aborted_at: iso(now),
    carry,
    run_started_at: Number.isFinite(runStartedMs) ? iso(runStartedMs) : null,
  };
  writeJsonAtomic(marker, m);
  return m;
}

export function evaluateResume({
  dataDir = DEFAULT_DATA_DIR,
  now = Date.now(),
  maxAgeHours = RESUME_MAX_MARKER_AGE_HOURS,
  maxCarry = RESUME_MAX_CARRY,
} = {}) {
  const { marker } = resumePaths(dataDir);
  if (!fs.existsSync(marker)) return { verdict: "none" };
  const m = readJson(marker);
  const abortedMs = Date.parse(m?.aborted_at || "");
  const carry = Number(m?.carry);
  if (!m || !Number.isFinite(abortedMs) || !Number.isInteger(carry) || carry < 1) {
    return { verdict: "invalid", marker: m, reason: "unreadable, or missing aborted_at/carry" };
  }
  if (abortedMs > now + FUTURE_SKEW_MS) {
    return { verdict: "invalid", marker: m, reason: `aborted_at ${m.aborted_at} is in the future` };
  }
  const ageMs = now - abortedMs;
  if (ageMs > maxAgeHours * HOUR_MS) {
    return { verdict: "stale", marker: m, ageMs, reason: `abort was ${formatDuration(ageMs)} ago (limit ${maxAgeHours}h)` };
  }
  if (carry > maxCarry) {
    return { verdict: "carry_exceeded", marker: m, ageMs, reason: `carry ${carry} > ${maxCarry}: the run that reused the last abort was itself aborted` };
  }
  return { verdict: "resume", marker: m, ageMs, skipFreshSec: RESUME_FRESH_MAX_AGE_HOURS * 3600 };
}

/** Evaluate, then archive the marker as _resume-scrape.consumed.json (any verdict but none). */
export function consumeResume({ dataDir = DEFAULT_DATA_DIR, now = Date.now() } = {}) {
  const ev = evaluateResume({ dataDir, now });
  if (ev.verdict === "none") return ev;
  const { marker, consumed } = resumePaths(dataDir);
  const record = {
    ...(ev.marker && typeof ev.marker === "object" ? ev.marker : {}),
    verdict: ev.verdict,
    reason: ev.reason || "",
    consumed_at: iso(now),
    skip_fresh_sec: ev.verdict === "resume" ? ev.skipFreshSec : 0,
  };
  writeJsonAtomic(consumed, record);
  fs.rmSync(marker, { force: true });
  return { ...ev, record };
}

/**
 * Age of a raw payload (deep-api/<T>.json) IF it can stand in for a fresh fetch:
 * parseable, fetchedAt set and not in the future, no recorded fetch errors, and
 * the CompanySummary the parser keys on. Anything else → null → fetch it again.
 * A payload torn by the deadline KILL fails JSON.parse and is refetched.
 */
export function payloadAgeMs(file, now = Date.now()) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const fetchedMs = Date.parse(d?.fetchedAt || "");
  if (!Number.isFinite(fetchedMs) || fetchedMs > now + FUTURE_SKEW_MS) return null;
  if (!Array.isArray(d.errors) || d.errors.length > 0) return null;
  if (!d.graphql?.CompanySummary?.Company) return null;
  return Math.max(0, now - fetchedMs);
}

/**
 * How many universe stocks a resumed run would skip right now — the full
 * payloadAgeMs check (JSON.parse of ~5.6k × ~465KB, ~20s of CPU).
 */
export function freshPayloadCount({ dataDir = DEFAULT_DATA_DIR, now = Date.now(), maxAgeMs = RESUME_FRESH_MAX_AGE_HOURS * HOUR_MS, universe = loadUniverse(dataDir) } = {}) {
  const { rawDir } = resumePaths(dataDir);
  let fresh = 0;
  for (const s of universe) {
    const t = s?.ticker;
    if (!t) continue;
    const age = payloadAgeMs(path.join(rawDir, `${t}.json`), now);
    if (age !== null && age <= maxAgeMs) fresh++;
  }
  return { fresh, total: universe.length };
}

/**
 * Same question answered from file mtimes only (the scraper writes each payload
 * right after fetching it) — an estimate for the abort mail. mark-abort runs in
 * the deadline teardown on a host that may be awake ~5s per 15 min, so it must
 * not spend ~20s of CPU parsing payloads before the lock is released.
 */
export function recentPayloadEstimate({ dataDir = DEFAULT_DATA_DIR, now = Date.now(), maxAgeMs = RESUME_FRESH_MAX_AGE_HOURS * HOUR_MS, universe = loadUniverse(dataDir) } = {}) {
  const { rawDir } = resumePaths(dataDir);
  let recent = 0;
  for (const s of universe) {
    if (!s?.ticker) continue;
    try {
      if (now - fs.statSync(path.join(rawDir, `${s.ticker}.json`)).mtimeMs <= maxAgeMs) recent++;
    } catch { /* missing */ }
  }
  return { recent, total: universe.length };
}

/**
 * Step 4b: which stocks the shard skipped as fresh (its "fresh_payload" skip
 * events in refresh-api-shard-<n>.log) are no longer fresh enough to publish.
 * A payload that is now unusable (payloadAgeMs → null) is refetched too.
 */
export function topUpTickers({ dataDir = DEFAULT_DATA_DIR, logFiles = [], now = Date.now(), maxAgeMs = RESUME_TOPUP_MAX_AGE_HOURS * HOUR_MS } = {}) {
  const { rawDir } = resumePaths(dataDir);
  const skipped = new Set();
  for (const f of logFiles) {
    let raw = "";
    try { raw = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.includes('"fresh_payload"')) continue;
      try {
        const e = JSON.parse(line);
        if (e?.event === "skip" && e.reason === "fresh_payload" && e.ticker) skipped.add(String(e.ticker));
      } catch { /* not a JSON event line */ }
    }
  }
  const topup = [];
  for (const t of skipped) {
    const age = payloadAgeMs(path.join(rawDir, `${t}.json`), now);
    if (age === null || age > maxAgeMs) topup.push(t);
  }
  return { skipped: skipped.size, topup };
}

function resumeSummary(ev, now) {
  const m = ev.marker || {};
  const when = Number.isFinite(Date.parse(m.aborted_at || "")) ? formatIst(Date.parse(m.aborted_at)) : "?";
  switch (ev.verdict) {
    case "none": return "no resume marker — normal full pass";
    case "resume": return `resuming after the deadline abort at ${when} (carry ${m.carry}): shards skip stocks whose raw payload is under ${RESUME_FRESH_MAX_AGE_HOURS}h old, fetch the rest`;
    default: return `resume marker from ${when} NOT used (${ev.verdict}: ${ev.reason}) — normal full pass`;
  }
}

// ────────── CLI ──────────

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") opts.dataDir = argv[++i];
    else if (a === "--run-started-epoch") opts.runStartedEpoch = argv[++i];
    else if (a === "--log") (opts.logs ||= []).push(argv[++i]);
    else opts._.push(a);
  }
  return opts;
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : DEFAULT_DATA_DIR;
  const now = Date.now();

  switch (cmd) {
    case "summary":
      console.log(formatSummary(shardProgress({ dataDir }), now));
      return 0;
    case "mark-abort": {
      const sec = Number(opts.runStartedEpoch);
      const m = markAbort({ dataDir, now, runStartedMs: Number.isFinite(sec) && sec > 0 ? sec * 1000 : null });
      // The marker is on disk: say so before anything else can fail.
      let qualify = "";
      try {
        const { recent, total } = recentPayloadEstimate({ dataDir, now });
        qualify = ` — ~${recent}/${total} payloads were written in the last ${RESUME_FRESH_MAX_AGE_HOURS}h`;
      } catch { /* the estimate is decoration */ }
      console.log(`resume marker written (carry ${m.carry}${m.carry > RESUME_MAX_CARRY ? " — over the limit, the next run fetches everything" : ""}): the next run skips stocks whose raw payload is under ${RESUME_FRESH_MAX_AGE_HOURS}h old when its shards reach them${qualify}`);
      return 0;
    }
    case "consume-resume": {
      const ev = consumeResume({ dataDir, now });
      console.log(`verdict=${ev.verdict}`);
      console.log(`skip_fresh_sec=${ev.verdict === "resume" ? ev.skipFreshSec : 0}`);
      console.log(`carry=${ev.marker?.carry ?? ""}`);
      console.log("---");
      console.log(resumeSummary(ev, now));
      return 0;
    }
    case "topup-list": {
      const r = topUpTickers({ dataDir, logFiles: (opts.logs || []).map((f) => path.resolve(f)), now });
      console.log(`skipped=${r.skipped}`);
      console.log(`topup_count=${r.topup.length}`);
      console.log(`topup=${r.topup.join(",")}`);
      return 0;
    }
    default:
      console.error("usage: node scripts/sws-scrape-progress.mjs <summary|mark-abort|consume-resume|topup-list> [--data-dir DIR] [--run-started-epoch S] [--log FILE]...");
      return 2;
  }
}

// realpath on both sides: the nightly runs this through a symlinked worktree
// path, and a plain href comparison would silently skip the CLI there.
const isEntrypoint = () => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return false;
  }
};

if (isEntrypoint()) {
  let code;
  try {
    code = cli(process.argv.slice(2));
  } catch (e) {
    console.error(`[scrape-progress] internal error: ${e?.stack || e}`);
    code = 2;
  }
  process.exit(code);
}
