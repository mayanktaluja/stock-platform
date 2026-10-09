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

console.log("--- CLI ---");
{
  const dir = fixture({ tickers: TEN, progress: { 2: { next_local_index: 2 } } });
  const r = spawnSync(process.execPath, [CLI, "summary", "--data-dir", dir], { encoding: "utf8" });
  assert("summary exits 0", r.status === 0, r.stderr);
  assert("summary prints shard 2's line", /shard 2: next_local_index 2\/3 \(67%\)/.test(r.stdout), r.stdout);
  const bad = spawnSync(process.execPath, [CLI, "nope"], { encoding: "utf8" });
  assert("unknown command exits 2 with usage", bad.status === 2 && /usage/.test(bad.stderr), bad.status);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
