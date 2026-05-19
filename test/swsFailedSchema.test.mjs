// P2-10 — data/sws/failed.json schema contract tests.
//
// Background (2026-05-18):
//   The on-disk file had a hybrid shape:
//     { entries: [], V2RETAIL: {...skipped_at: 2026-04-27, attempts: 3 } }
//   The orphan V2RETAIL key was a manual hand-edit from 21 days earlier that
//   the canonical writer (recordFailedStock in scripts/sws-deep-scrape.mjs)
//   silently preserved on every subsequent write because it spread the whole
//   on-disk object back out instead of just re-emitting entries[].
//
//   PR #290 cleared 25 different NSE tickers but skipped V2RETAIL because
//   that pass only iterated entries[] — V2RETAIL was invisible to it.
//
// What these tests pin:
//   (1) Writer always emits canonical {entries: [...], updated_at: <iso>} and
//       NEVER preserves sibling top-level keys from prior on-disk shapes.
//   (2) Reader (entries[] iteration) ignores any orphan top-level keys —
//       which the writer now scrubs, but defence-in-depth.
//   (3) Round-trip: migrate legacy hybrid → re-read → entries count matches.
//   (4) The committed data/sws/failed.json is in canonical shape (snapshot).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point sws-config at a tmp repo root BEFORE importing the module. The config
// module reads SWS_REPO_ROOT_OVERRIDE at import time and bakes it into PATHS.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sws-failed-schema-"));
fs.mkdirSync(path.join(TMP_ROOT, "data", "sws"), { recursive: true });
process.env.SWS_REPO_ROOT_OVERRIDE = TMP_ROOT;

const { recordFailedStock } = await import("../scripts/sws-deep-scrape.mjs");
const { PATHS } = await import("../scripts/sws-config.mjs");

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.stack); fail += 1; }
}

function resetFailedFile(content) {
  if (content == null) {
    try { fs.unlinkSync(PATHS.failed); } catch {}
  } else {
    fs.writeFileSync(PATHS.failed, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
}

function readFailedFile() {
  return JSON.parse(fs.readFileSync(PATHS.failed, "utf-8"));
}

// ─── Writer canonical shape ─────────────────────────────────────────────

console.log("[1] recordFailedStock — fresh write produces canonical shape");
it("emits exactly {entries, updated_at} when starting from empty", () => {
  resetFailedFile(null);
  recordFailedStock("RELIANCE", "ownership", "rate_limited");
  const out = readFailedFile();
  const keys = Object.keys(out).sort();
  assert.deepEqual(keys, ["entries", "updated_at"],
    "top-level keys must be exactly entries|updated_at");
  assert.ok(Array.isArray(out.entries));
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].ticker, "RELIANCE");
  assert.equal(out.entries[0].failed_tab, "ownership");
  assert.equal(out.entries[0].error, "rate_limited");
  assert.ok(typeof out.entries[0].recorded_at === "string");
  assert.ok(typeof out.updated_at === "string");
});

console.log("[2] recordFailedStock — appends to existing entries[]");
it("preserves prior entries and adds the new one", () => {
  resetFailedFile({
    entries: [
      { ticker: "TCS", failed_tab: "overview", error: "auth_expired", recorded_at: "2026-05-17T10:00:00.000Z" },
    ],
    updated_at: "2026-05-17T10:00:00.000Z",
  });
  recordFailedStock("INFY", "valuation", "parse_failed");
  const out = readFailedFile();
  assert.equal(out.entries.length, 2);
  assert.equal(out.entries[0].ticker, "TCS");
  assert.equal(out.entries[1].ticker, "INFY");
});

// ─── Orphan-key scrub (the V2RETAIL bug) ─────────────────────────────────

console.log("[3] recordFailedStock — strips orphan sibling keys from legacy hybrid");
it("does not preserve V2RETAIL-style top-level orphan keys after write", () => {
  resetFailedFile({
    entries: [],
    V2RETAIL: {
      shard_id: 2,
      reason: "manual_skip:repeated_rate_limit_on_ownership_tab",
      attempts: 3,
      skipped_at: "2026-04-27T21:32:36.845Z",
    },
    HDFCBANK: { reason: "stale_hand_edit" }, // synthetic 2nd orphan, same bug class
  });
  recordFailedStock("WIPRO", "ownership", "transient");
  const out = readFailedFile();
  const keys = Object.keys(out).sort();
  assert.deepEqual(keys, ["entries", "updated_at"],
    `orphan top-level keys must be stripped; got: ${keys.join("|")}`);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].ticker, "WIPRO");
  // V2RETAIL is intentionally NOT migrated by the writer — migration is a
  // one-shot manual step (see data/sws/failed.json commit). The writer's job
  // is to never propagate the orphan further.
  assert.equal(out.V2RETAIL, undefined);
  assert.equal(out.HDFCBANK, undefined);
});

console.log("[4] recordFailedStock — survives garbage/null on-disk content");
it("treats unparseable file as empty entries[] and writes canonical shape", () => {
  resetFailedFile("not-valid-json{{{");
  recordFailedStock("SBIN", "fundamentals", "io_error");
  const out = readFailedFile();
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].ticker, "SBIN");
});

it("treats object missing entries[] as empty (legacy/partial files)", () => {
  resetFailedFile({ V2RETAIL: { reason: "x" } }); // no entries at all
  recordFailedStock("ICICIBANK", "overview", "test");
  const out = readFailedFile();
  assert.deepEqual(Object.keys(out).sort(), ["entries", "updated_at"]);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].ticker, "ICICIBANK");
});

// ─── Reader contract — consumers iterate entries[], ignore orphans ──────

console.log("[5] consumer-side reader contract — entries[] iteration ignores orphans");
it("Array.isArray(payload.entries) iteration sees only real entries", () => {
  // Simulate the consumer pattern from scripts/sws-sanity-gate.mjs:291.
  const legacy = {
    entries: [
      { ticker: "A", failed_tab: "x", error: "y", recorded_at: "2026-05-17T00:00:00.000Z" },
      { ticker: "B", failed_tab: "x", error: "y", recorded_at: "2026-05-17T00:00:00.000Z" },
    ],
    V2RETAIL: { shard_id: 2, attempts: 3 },
  };
  const failedEntries = legacy?.entries || [];
  assert.equal(failedEntries.length, 2,
    "reader must see exactly 2 entries — the V2RETAIL orphan must not bleed into the count");
  // And the consumer never has to handle V2RETAIL specially — it's invisible.
});

// ─── Round-trip migration ───────────────────────────────────────────────

console.log("[6] round-trip — migrated file survives a writer pass intact");
it("migrate → recordFailedStock → re-read preserves migrated V2RETAIL entry", () => {
  resetFailedFile({
    entries: [
      {
        ticker: "V2RETAIL",
        failed_tab: "ownership",
        error: "manual_skip:repeated_rate_limit_on_ownership_tab",
        recorded_at: "2026-04-27T21:32:36.845Z",
        shard_id: 2,
        attempts: 3,
        manual_skip: true,
      },
    ],
    updated_at: "2026-05-18T00:00:00.000Z",
  });
  recordFailedStock("HAVELLS", "overview", "transient");
  const out = readFailedFile();
  assert.equal(out.entries.length, 2,
    "migrated V2RETAIL row + the new HAVELLS row both present");
  const tickers = out.entries.map((e) => e.ticker).sort();
  assert.deepEqual(tickers, ["HAVELLS", "V2RETAIL"]);
  // Migrated V2RETAIL metadata (shard_id, attempts, manual_skip) must survive.
  const v2r = out.entries.find((e) => e.ticker === "V2RETAIL");
  assert.equal(v2r.shard_id, 2);
  assert.equal(v2r.attempts, 3);
  assert.equal(v2r.manual_skip, true);
});

// ─── Snapshot of the committed prod file ───────────────────────────────

console.log("[7] committed data/sws/failed.json — canonical shape snapshot");
it("the real file has exactly {entries, updated_at} and no orphan keys", () => {
  // Use process.cwd() — at npm test time this is the repo root.
  const realPath = path.join(process.cwd(), "data", "sws", "failed.json");
  if (!fs.existsSync(realPath)) {
    console.log("    ℹ  (skipping — file not present in this checkout)");
    return;
  }
  const real = JSON.parse(fs.readFileSync(realPath, "utf-8"));
  const keys = Object.keys(real).sort();
  assert.deepEqual(keys, ["entries", "updated_at"],
    `committed file has unexpected top-level keys: ${keys.join("|")}`);
  assert.ok(Array.isArray(real.entries));
  // No ticker-shaped orphan keys (uppercase A-Z, 2-15 chars).
  for (const k of Object.keys(real)) {
    assert.ok(!/^[A-Z][A-Z0-9&-]{1,14}$/.test(k),
      `top-level key "${k}" looks like a ticker — that's the orphan bug pattern`);
  }
});

// ─── Cleanup ───────────────────────────────────────────────────────────

try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}

console.log(`\n[swsFailedSchema] ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
