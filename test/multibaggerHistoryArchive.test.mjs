// Tests for services/multibagger/multibaggerHistoryArchive.js.
// Uses a temp dir via chdir.
// Run: node test/multibaggerHistoryArchive.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multibagger-hist-test-"));
process.chdir(tmpDir);

const {
  shouldSnapshotToday,
  writeSnapshot,
  readSnapshotsFor,
  listSnapshotDates,
  buildTrajectorySeries,
  HISTORY_ARCHIVE_CONFIG,
} = await import("../services/multibagger/multibaggerHistoryArchive.js");

console.log("\nmultibaggerHistoryArchive");

it("config exposes snapshot types", () => {
  if (!HISTORY_ARCHIVE_CONFIG.SNAPSHOT_TYPES.includes("calendar_sunday")) throw new Error();
  if (!HISTORY_ARCHIVE_CONFIG.SNAPSHOT_TYPES.includes("event_entry")) throw new Error();
});

it("shouldSnapshotToday returns true on Sunday", () => {
  // 2026-05-24 was a Sunday
  if (!shouldSnapshotToday({ today_iso: "2026-05-24" })) throw new Error("expected true");
});

it("shouldSnapshotToday returns false on Monday", () => {
  // 2026-05-25 was a Monday
  if (shouldSnapshotToday({ today_iso: "2026-05-25" })) throw new Error("expected false");
});

it("shouldSnapshotToday returns false when last snapshot was today", () => {
  if (shouldSnapshotToday({ today_iso: "2026-05-24", last_snapshot_iso: "2026-05-24" })) throw new Error();
});

it("force=true overrides cadence", () => {
  if (!shouldSnapshotToday({ today_iso: "2026-05-25", force: true })) throw new Error();
});

it("writeSnapshot rejects invalid type", () => {
  try {
    writeSnapshot({ type: "bogus", today_iso: "2026-05-24" });
    throw new Error("should have thrown");
  } catch (e) {
    if (!/invalid type/.test(e.message)) throw e;
  }
});

it("writeSnapshot creates date file with one entry, appends on second call", () => {
  writeSnapshot({
    type: "calendar_sunday",
    today_iso: "2026-05-24",
    portfolio_mtm: { portfolio_value_inr: 105_000, total_pl_pct: 5, cash_inr: 10_000, positions: [{ ticker: "A" }], closed_count: 0 },
  });
  writeSnapshot({
    type: "event_entry",
    today_iso: "2026-05-24",
    portfolio_mtm: { portfolio_value_inr: 105_000, total_pl_pct: 5, cash_inr: 9_000, positions: [{ ticker: "A" }, { ticker: "B" }], closed_count: 0 },
  });
  const snap = readSnapshotsFor("2026-05-24");
  if (!snap || snap.snapshots.length !== 2) throw new Error("expected 2 snapshots");
});

it("listSnapshotDates returns sorted dates", () => {
  writeSnapshot({ type: "calendar_sunday", today_iso: "2026-05-31", portfolio_mtm: { portfolio_value_inr: 110_000, total_pl_pct: 10 } });
  writeSnapshot({ type: "calendar_sunday", today_iso: "2026-06-07", portfolio_mtm: { portfolio_value_inr: 120_000, total_pl_pct: 20 } });
  const dates = listSnapshotDates();
  if (dates.length < 3) throw new Error("expected ≥3 dates");
  // Sorted ascending
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] < dates[i - 1]) throw new Error("dates not sorted");
  }
});

it("buildTrajectorySeries returns ascending series of value + pl_pct", () => {
  const series = buildTrajectorySeries();
  if (series.length < 3) throw new Error("expected ≥3 entries");
  if (typeof series[0].value_inr !== "number") throw new Error("missing value_inr");
  if (series[0].date_iso > series[series.length - 1].date_iso) throw new Error("series not sorted");
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
