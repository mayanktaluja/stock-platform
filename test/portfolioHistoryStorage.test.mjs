/**
 * Tests for portfolioHistoryStorage pure helpers.
 *
 * Run with: node test/portfolioHistoryStorage.test.mjs
 */

import {
  insertSnapshotSorted,
  isBackdated,
  findByContentHash,
  HISTORY_CAP,
} from "../portfolioHistoryStorage.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", got);
  }
}

function snap(asOfDateIso, opts = {}) {
  return {
    asOfDateIso,
    uploadedAtIso: opts.uploadedAtIso || `${asOfDateIso}T10:00:00.000Z`,
    contentHash: opts.contentHash || `hash-${asOfDateIso}`,
    sourceFile: opts.sourceFile || null,
    sourceBroker: opts.sourceBroker || "groww-xlsx",
    backdated: opts.backdated ?? false,
    asOfDateInferred: false,
    holdings: [],
    facets: [],
  };
}

console.log("\ninsertSnapshotSorted — sort + cap eviction\n");

{
  const a = snap("2026-01-01");
  const b = snap("2026-02-01");
  const c = snap("2026-03-01");
  const out = insertSnapshotSorted([a, c], b);
  assert("newest-first ordering",
    out[0].asOfDateIso === "2026-03-01" && out[1].asOfDateIso === "2026-02-01" && out[2].asOfDateIso === "2026-01-01",
    out.map((s) => s.asOfDateIso));
}

{
  const dates = [];
  for (let i = 0; i < HISTORY_CAP + 1; i++) {
    const m = String(i + 1).padStart(2, "0");
    dates.push(snap(`2026-${m}-01`));
  }
  let acc = [];
  for (const s of dates) acc = insertSnapshotSorted(acc, s);
  assert("respects HISTORY_CAP", acc.length === HISTORY_CAP, acc.length);
  assert("snapshots[0] is newest of all inserted",
    acc[0].asOfDateIso === `2026-${String(HISTORY_CAP + 1).padStart(2, "0")}-01`,
    acc[0].asOfDateIso);
}

{
  // Backdated FIFO: when cap is hit, oldest non-backdated is evicted first.
  let acc = [];
  for (let i = 0; i < HISTORY_CAP; i++) {
    acc = insertSnapshotSorted(acc, snap(`2026-${String(i + 1).padStart(2, "0")}-01`));
  }
  // Insert a backdated one (lands somewhere in the middle by date)
  const backdatedSnap = snap("2025-06-15", { backdated: true });
  acc = insertSnapshotSorted(acc, backdatedSnap);
  // We should still have HISTORY_CAP — and the backdated one survived,
  // because the eviction loop drops the oldest non-backdated.
  assert("cap maintained after backdated insertion", acc.length === HISTORY_CAP, acc.length);
  assert("backdated snapshot retained", acc.some((s) => s.asOfDateIso === "2025-06-15"), acc.map((s) => s.asOfDateIso));
}

{
  // Tiebreaker: same asOfDateIso → newer uploadedAtIso wins.
  const earlier = snap("2026-04-01", { uploadedAtIso: "2026-04-01T08:00:00Z" });
  const later = snap("2026-04-01", { uploadedAtIso: "2026-04-01T20:00:00Z" });
  const out = insertSnapshotSorted([earlier], later);
  assert("uploadedAtIso tiebreaker", out[0].uploadedAtIso === "2026-04-01T20:00:00Z", out[0].uploadedAtIso);
}

console.log("\nisBackdated\n");

{
  assert("empty history → not backdated", isBackdated(snap("2026-05-08"), []) === false, true);
  assert("first snapshot not backdated", isBackdated(snap("2026-05-08"), null) === false, true);
}

{
  const history = [snap("2026-05-08"), snap("2026-05-01"), snap("2026-04-15")];
  assert("newer-than-latest not backdated",
    isBackdated(snap("2026-05-12"), history) === false, isBackdated(snap("2026-05-12"), history));
  assert("equal-to-latest not backdated",
    isBackdated(snap("2026-05-08"), history) === false, isBackdated(snap("2026-05-08"), history));
  assert("older-than-latest backdated",
    isBackdated(snap("2026-05-05"), history) === true, isBackdated(snap("2026-05-05"), history));
}

console.log("\nfindByContentHash\n");

{
  const a = snap("2026-05-01", { contentHash: "abc" });
  const b = snap("2026-05-08", { contentHash: "def" });
  assert("finds match by (hash, date)", findByContentHash([a, b], "abc", "2026-05-01") === a, "miss");
  assert("hash match on wrong date returns undefined",
    findByContentHash([a, b], "abc", "2026-05-08") === undefined, "false hit");
  assert("date match on wrong hash returns undefined",
    findByContentHash([a, b], "xyz", "2026-05-01") === undefined, "false hit");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
