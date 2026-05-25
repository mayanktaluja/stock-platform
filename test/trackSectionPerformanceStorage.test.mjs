/**
 * Section-performance storage adapter regression.
 *
 * Run with: node test/trackSectionPerformanceStorage.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FileSectionPerformanceStorage,
  createSectionPerformanceStorage,
} from "../services/trackRecord/sectionPerformanceStorage.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "-> got", JSON.stringify(got));
  }
}

function row(id, dateKey, extra = {}) {
  return {
    id,
    dateKey,
    snapshotAt: `${dateKey}T10:00:00.000Z`,
    type: id.split("|")[1] || "sws_best_buynow",
    constituents: [],
    ...extra,
  };
}

console.log("trackRecord/sectionPerformanceStorage.js regression\n");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "track-section-performance-"));
const storagePath = path.join(tmpDir, ".section-performance.jsonl");
const storage = new FileSectionPerformanceStorage({ path: storagePath });

// ──── 1. Empty file adapter reads cleanly ────
{
  const rows = await storage.readAll();
  assert("missing JSONL file reads as []", Array.isArray(rows) && rows.length === 0, rows);
  const stats = await storage.getStats();
  assert("missing JSONL stats exists=false", stats.exists === false && stats.lineCount === 0, stats);
}

// ──── 2. append writes new rows and dedupes by id ────
{
  const first = await storage.append([
    row("2026-05-24|sws_best_buynow", "2026-05-24"),
    row("2026-05-25|sws_best_buynow", "2026-05-25"),
  ]);
  assert("append writes two rows", first.written === 2 && first.skipped === 0, first);

  const second = await storage.append([
    row("2026-05-25|sws_best_buynow", "2026-05-25"),
    row("2026-05-25|sws_quality_growth", "2026-05-25"),
  ]);
  assert("append skips duplicate id and writes fresh id", second.written === 1 && second.skipped === 1, second);

  const all = await storage.readAll();
  assert("readAll returns newest first", all[0].dateKey === "2026-05-25", all.map((r) => r.dateKey));
  assert("three unique rows persisted", all.length === 3, all.length);
}

// ──── 3. upsert replaces matching rows and preserves unique ids ────
{
  const result = await storage.upsert([
    row("2026-05-25|sws_quality_growth", "2026-05-25", { marker: "updated" }),
    row("2026-05-26|sws_best_buynow", "2026-05-26", { marker: "new" }),
  ]);
  assert("upsert reports one write and one update", result.written === 1 && result.updated === 1 && result.skipped === 0, result);
  const all = await storage.readAll();
  const updated = all.find((r) => r.id === "2026-05-25|sws_quality_growth");
  assert("upsert replaced existing row content", updated.marker === "updated", updated);
  assert("upsert leaves four unique rows total", all.length === 4, all.length);
}

// ──── 4. date and latest helpers filter on the persisted rows ────
{
  const dateRows = await storage.readByDateKey("2026-05-25");
  assert("readByDateKey returns both rows for 2026-05-25", dateRows.length === 2, dateRows.map((r) => r.id));
  const latest = await storage.latest(1);
  assert("latest(1) returns newest date", latest.length === 1 && latest[0].dateKey === "2026-05-26", latest);
  const stats = await storage.getStats();
  assert("stats reflect file state", stats.exists === true && stats.lineCount === 4 && stats.newest.startsWith("2026-05-26"), stats);
}

// ──── 5. factory can force the file backend for tests/dev ────
{
  const forced = createSectionPerformanceStorage({ backend: "file", path: path.join(tmpDir, "forced.jsonl") });
  assert("factory backend=file returns FileSectionPerformanceStorage", forced instanceof FileSectionPerformanceStorage, forced?.name);
}

await storage.clear();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
