/**
 * Tests for scripts/sws-scrape-progress.mjs — India API-scrape progress read the
 * way the scraper reads it (cursor in progress-api-<n>.json, slice derived from
 * universe.json at runtime).
 *
 * WHY THIS EXISTS: the nightly's deadline-abort and AC-loss mails now report
 * per-shard progress. A cursor alone is meaningless — "1129" is 61% of a 1860
 * slice and 100% of a 1129 one — and the slice is stored nowhere, so this module
 * recomputes it with the scraper's own partition. These tests pin that it agrees
 * with shardSliceContiguous, and that "finished" is judged on the cursor, never
 * on the file's `complete` field (written by the legacy DOM driver and rebuild
 * scripts, never by sws-api-scrape.mjs, and left alone by the step-3 rewind).
 *
 * It also pins resume-after-abort. 2026-09-26 / 09-29 were killed by the
 * deadline at 21% / 67%, and the next run fetched all of it again. Carrying the
 * cursor was replayed against the real sanity gate and FAILS it every time, so
 * the resumed run instead skips stocks whose raw payload is young. The bound on
 * "young" is only safe while the gates it was derived from stay where they are,
 * so the last block reads both gates' thresholds out of their source files.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  loadUniverse,
  shardProgress,
  formatProgressLine,
  formatSummary,
  RESUME_MAX_MARKER_AGE_HOURS,
  RESUME_MAX_CARRY,
  RESUME_FRESH_MAX_AGE_HOURS,
  RESUME_TAIL_HOURS,
  resumePaths,
  markAbort,
  evaluateResume,
  consumeResume,
  payloadAgeMs,
  freshPayloadCount,
} from "../scripts/sws-scrape-progress.mjs";
import { shardSliceContiguous } from "../scripts/sws-shard-partition.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../scripts/sws-scrape-progress.mjs");

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

function fixture({ tickers, progress = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sws-scrape-progress-"));
  fs.writeFileSync(path.join(dir, "universe.json"), JSON.stringify({ stocks: tickers.map((t) => ({ ticker: t })) }));
  for (const [sid, p] of Object.entries(progress)) {
    fs.writeFileSync(path.join(dir, `progress-api-${sid}.json`), typeof p === "string" ? p : JSON.stringify(p));
  }
  return dir;
}

const TEN = ["JJ", "AA", "II", "BB", "HH", "CC", "GG", "DD", "FF", "EE"]; // stored unsorted on purpose
const NOW = Date.parse("2026-09-29T16:00:00Z");

console.log("\nsws-scrape-progress.mjs\n");

console.log("--- slice sizes match the scraper's partition ---");
{
  const dir = fixture({ tickers: TEN, progress: { 1: { next_local_index: 1 }, 2: { next_local_index: 3 }, 3: { next_local_index: 4 } } });
  const universe = loadUniverse(dir);
  assert("loadUniverse reads the {stocks:[…]} shape", universe.length === 10, universe.length);
  const rows = shardProgress({ dataDir: dir });
  const sizes = rows.map((r) => r.slice_size);
  const expected = [1, 2, 3].map((sid) => shardSliceContiguous(universe, sid).length);
  assert("slice_size per shard == shardSliceContiguous length (last shard absorbs the remainder)", JSON.stringify(sizes) === JSON.stringify(expected) && expected[2] === 4, sizes);
  assert("cursor below slice end → not finished", rows[0].finished === false, rows[0]);
  assert("cursor == slice end → finished", rows[1].finished === true, rows[1]);
  assert("cursor == last shard's larger slice → finished", rows[2].finished === true, rows[2]);
}

console.log("--- `complete` in the file is ignored ---");
{
  const dir = fixture({
    tickers: TEN,
    progress: { 1: { next_local_index: 0, complete: true }, 2: { next_local_index: 3, complete: false } },
  });
  const rows = shardProgress({ dataDir: dir });
  assert("complete:true at cursor 0 (after the step-3 rewind) → NOT finished", rows[0].finished === false, rows[0]);
  assert("complete:false at slice end → finished", rows[1].finished === true, rows[1]);
}

console.log("--- missing / torn inputs degrade, never throw ---");
{
  const dir = fixture({ tickers: TEN, progress: { 1: "{\"next_local_index\": 2, ", 2: { next_local_index: 1 } } });
  const rows = shardProgress({ dataDir: dir });
  assert("torn progress file → present:false", rows[0].present === false, rows[0]);
  assert("absent progress file → present:false", rows[2].present === false, rows[2]);
  assert("…rendered as a plain 'no progress' line", /shard 3: no progress-api-3\.json/.test(formatProgressLine(rows[2], NOW)), formatProgressLine(rows[2], NOW));
  fs.rmSync(path.join(dir, "universe.json"));
  const noU = shardProgress({ dataDir: dir });
  assert("unreadable universe → slice_size null, finished false", noU[1].slice_size === null && noU[1].finished === false, noU[1]);
  assert("…rendered as ?/?", /next_local_index 1\/\?/.test(formatProgressLine(noU[1], NOW)), formatProgressLine(noU[1], NOW));
}

console.log("--- summary line ---");
{
  const dir = fixture({
    tickers: TEN,
    progress: { 1: { next_local_index: 1, last_ticker: "AA", last_run_at: new Date(NOW - 90 * 60_000).toISOString() } },
  });
  const line = formatProgressLine(shardProgress({ dataDir: dir })[0], NOW);
  assert("cursor/slice and percentage", line.startsWith("shard 1: next_local_index 1/3 (33%)"), line);
  assert("last ticker + IST time + age", /last AA at 2026-09-29 20:00:00 IST \(1h 30m ago\)/.test(line), line);
  const all = formatSummary(shardProgress({ dataDir: dir }), NOW).split("\n");
  assert("one line per shard", all.length === 3, all);
}

const H = 3_600_000;
function payload(dir, ticker, { ageH = 1, errors = [], company = true, raw = null, now = NOW } = {}) {
  const rawDir = path.join(dir, "deep-api");
  fs.mkdirSync(rawDir, { recursive: true });
  const body = raw ?? JSON.stringify({
    ticker, canonicalUrl: `/x/${ticker}`, fetchedAt: new Date(now - ageH * H).toISOString(),
    graphql: company ? { CompanySummary: { Company: { id: 1 } } } : {}, rest: {}, errors,
  }, null, 2);
  fs.writeFileSync(path.join(rawDir, `${ticker}.json`), body);
  return path.join(rawDir, `${ticker}.json`);
}

console.log("--- payloadAgeMs: only a complete, recent payload may stand in for a fetch ---");
{
  const dir = fixture({ tickers: TEN });
  assert("clean 2h-old payload → its age", payloadAgeMs(payload(dir, "AA", { ageH: 2 }), NOW) === 2 * H, payloadAgeMs(path.join(dir, "deep-api/AA.json"), NOW));
  assert("payload with fetch errors → null (refetch)", payloadAgeMs(payload(dir, "BB", { errors: [{ step: "rest:price" }] }), NOW) === null, null);
  assert("no CompanySummary.Company → null (parser would have nothing)", payloadAgeMs(payload(dir, "CC", { company: false }), NOW) === null, null);
  const full = JSON.stringify({ ticker: "DD", fetchedAt: new Date(NOW - H).toISOString(), graphql: { CompanySummary: { Company: {} } }, errors: [] }, null, 2);
  assert("payload torn mid-write by the deadline KILL → null", payloadAgeMs(payload(dir, "DD", { raw: full.slice(0, full.length - 5) }), NOW) === null, null);
  assert("fetchedAt in the future → null", payloadAgeMs(payload(dir, "EE", { ageH: -2 }), NOW) === null, null);
  assert("missing file → null", payloadAgeMs(path.join(dir, "deep-api/ZZ.json"), NOW) === null, null);
  payload(dir, "FF", { ageH: RESUME_FRESH_MAX_AGE_HOURS + 1 });
  const c = freshPayloadCount({ dataDir: dir, now: NOW });
  assert("freshPayloadCount counts only usable payloads under the bound (AA)", c.fresh === 1 && c.total === 10, c);
}

console.log("--- marker: written on abort, used once, carry ≤ 1 ---");
{
  const dir = fixture({ tickers: TEN });
  const { marker, consumed } = resumePaths(dir);
  const runStart = NOW - 21 * H;
  const m1 = markAbort({ dataDir: dir, now: NOW, runStartedMs: runStart });
  assert("first abort → carry 1", m1.carry === 1 && fs.existsSync(marker), m1);
  assert("…with aborted_at and run_started_at", m1.aborted_at === new Date(NOW).toISOString() && m1.run_started_at === new Date(runStart).toISOString(), m1);

  const next = NOW + 3 * H; // the next 00:30 after a 21:30 abort
  const ev = consumeResume({ dataDir: dir, now: next });
  assert("next run (3h later) → resume with the 7h skip", ev.verdict === "resume" && ev.skipFreshSec === RESUME_FRESH_MAX_AGE_HOURS * 3600, ev);
  assert("…marker archived, so it is used exactly once", !fs.existsSync(marker) && fs.existsSync(consumed), [fs.existsSync(marker), fs.existsSync(consumed)]);
  assert("…a second consume finds nothing", consumeResume({ dataDir: dir, now: next + 60_000 }).verdict === "none", null);

  // That resumed run (started just before it consumed) is itself aborted.
  const m2 = markAbort({ dataDir: dir, now: next + 21 * H, runStartedMs: next - 60_000 });
  assert("an abort of the run that reused the last one → carry 2", m2.carry === 2, m2);
  const ev2 = consumeResume({ dataDir: dir, now: next + 24 * H });
  assert("carry 2 → carry_exceeded, no skip (fetch everything)", ev2.verdict === "carry_exceeded" && !ev2.skipFreshSec, ev2);

  // An unrelated later abort (did not consume anything this run) restarts at 1.
  const m3 = markAbort({ dataDir: dir, now: next + 48 * H, runStartedMs: next + 27 * H });
  assert("a fresh abort after a full-pass run → carry back to 1", m3.carry === 1, m3);
}

console.log("--- marker verdicts ---");
{
  const dir = fixture({ tickers: TEN });
  const { marker } = resumePaths(dir);
  markAbort({ dataDir: dir, now: NOW });
  assert(`${RESUME_MAX_MARKER_AGE_HOURS - 1}h old → resume`, evaluateResume({ dataDir: dir, now: NOW + (RESUME_MAX_MARKER_AGE_HOURS - 1) * H }).verdict === "resume", null);
  assert(`${RESUME_MAX_MARKER_AGE_HOURS + 1}h old → stale`, evaluateResume({ dataDir: dir, now: NOW + (RESUME_MAX_MARKER_AGE_HOURS + 1) * H }).verdict === "stale", null);
  fs.writeFileSync(marker, "{ not json");
  assert("unparseable marker → invalid", evaluateResume({ dataDir: dir, now: NOW }).verdict === "invalid", null);
  fs.writeFileSync(marker, JSON.stringify({ aborted_at: new Date(NOW + H).toISOString(), carry: 1 }));
  assert("aborted_at in the future → invalid", evaluateResume({ dataDir: dir, now: NOW }).verdict === "invalid", null);
  const ev = consumeResume({ dataDir: dir, now: NOW });
  assert("a non-resume verdict still archives the marker", ev.verdict === "invalid" && !fs.existsSync(marker), ev);
  assert("max carry is 1 (spec)", RESUME_MAX_CARRY === 1, RESUME_MAX_CARRY);
}

console.log("--- the 7h bound still fits BOTH real gates ---");
{
  const root = path.resolve(__dirname, "..");
  const gateSrc = fs.readFileSync(path.join(root, "scripts/sws-sanity-gate.mjs"), "utf8");
  const holdingSrc = fs.readFileSync(path.join(root, "services/swsHoldingEngine.js"), "utf8");
  const windowH = Number(gateSrc.match(/const RUN_WINDOW_HOURS\s*=\s*(\d+)/)?.[1]);
  const demoteH = Number(holdingSrc.match(/dataAgeHoursPre\)\s*&&\s*dataAgeHoursPre\s*>\s*(\d+)/)?.[1]);
  const atPublish = RESUME_FRESH_MAX_AGE_HOURS + RESUME_TAIL_HOURS;
  assert("read RUN_WINDOW_HOURS from sws-sanity-gate.mjs", windowH === 24, windowH);
  assert("read the top-up demotion threshold from swsHoldingEngine.js", demoteH === 36, demoteH);
  assert(`a skipped stock (≤ ${atPublish}h at publish) counts as fresh in the ${windowH}h gate window`, atPublish <= windowH, { atPublish, windowH });
  // Math.round(age) > 36 ⇒ demoted from 36.5h. Must not happen before the next
  // on-time publish, ~24h later.
  assert("…and is not demoted to HOLD before the next on-time publish (≥ 24h)", demoteH + 0.5 - atPublish >= 24, demoteH + 0.5 - atPublish);
}

console.log("--- CLI ---");
{
  const dir = fixture({ tickers: TEN, progress: { 2: { next_local_index: 2 } } });
  const r = spawnSync(process.execPath, [CLI, "summary", "--data-dir", dir], { encoding: "utf8" });
  assert("summary exits 0", r.status === 0, r.stderr);
  assert("summary prints shard 2's line", /shard 2: next_local_index 2\/3 \(67%\)/.test(r.stdout), r.stdout);
  const mk = spawnSync(process.execPath, [CLI, "mark-abort", "--data-dir", dir, "--run-started-epoch", String(Math.floor(Date.now() / 1000) - 3600)], { encoding: "utf8" });
  assert("mark-abort exits 0 and reports what qualifies", mk.status === 0 && /resume marker written \(carry 1\).*0\/10 qualify/.test(mk.stdout), mk.stdout + mk.stderr);
  const cr = spawnSync(process.execPath, [CLI, "consume-resume", "--data-dir", dir], { encoding: "utf8" });
  assert("consume-resume prints verdict / skip_fresh_sec / ---", cr.status === 0 && /^verdict=resume$/m.test(cr.stdout) && new RegExp(`^skip_fresh_sec=${RESUME_FRESH_MAX_AGE_HOURS * 3600}$`, "m").test(cr.stdout) && /^---$/m.test(cr.stdout), cr.stdout);
  const none = spawnSync(process.execPath, [CLI, "consume-resume", "--data-dir", dir], { encoding: "utf8" });
  assert("…then verdict=none, skip 0", /^verdict=none$/m.test(none.stdout) && /^skip_fresh_sec=0$/m.test(none.stdout), none.stdout);
  const bad = spawnSync(process.execPath, [CLI, "nope"], { encoding: "utf8" });
  assert("unknown command exits 2 with usage", bad.status === 2 && /usage/.test(bad.stderr), bad.status);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
