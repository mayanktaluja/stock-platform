import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  archiveWireMessages,
  loadWireWindow,
  pruneWireBuffer,
  wireDir,
  resolveReadDir,
} from "../services/newsWire/wireArchive.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    pass++;
  } catch (err) {
    console.log(`  not ok - ${name}\n      ${err.message}`);
    fail++;
  }
}

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wireArchive-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const rec = (over = {}) => ({
  channel: "FinancialJuice",
  category: "markets",
  text: "Fed holds rates steady, signals one cut in 2026",
  url: "https://t.me/financialjuice/1",
  publishedAt: "2026-07-08T09:00:00Z",
  breaking: true,
  symbols: [],
  tags: [],
  routerKey: "abc123",
  ...over,
});

test("wireDir returns null when NEWS_WIRE_DIR unset, absolute when set", () => {
  assert.equal(wireDir({}), null);
  assert.equal(wireDir({ NEWS_WIRE_DIR: "  " }), null);
  assert.equal(wireDir({ NEWS_WIRE_DIR: "/abs/buffer" }), "/abs/buffer");
});

test("resolveReadDir falls back to a module-relative default when unset", () => {
  const d = resolveReadDir({});
  assert.ok(d.endsWith(path.join("data", "news-wire", "buffer")));
  assert.equal(resolveReadDir({ NEWS_WIRE_DIR: "/pinned" }), "/pinned");
});

test("[C2] archiveWireMessages NO-OPs when archiveDir is null (env unset)", () => {
  const r = archiveWireMessages([rec()], { archiveDir: wireDir({}) });
  assert.equal(r.written, 0);
  assert.equal(r.path, null);
  assert.match(r.reason, /NEWS_WIRE_DIR/);
});

test("archiveWireMessages writes to UTC-date-keyed jsonl with raw text + metadata", () => {
  withTmpDir((dir) => {
    const r = archiveWireMessages([rec({ symbols: ["RELIANCE"], tags: ["⭐"] })], {
      archiveDir: dir,
      asOf: "2026-07-08T09:05:00Z",
    });
    assert.equal(r.written, 1);
    assert.ok(r.path.endsWith("2026-07-08.jsonl"));
    const line = JSON.parse(fs.readFileSync(r.path, "utf-8").trim());
    assert.equal(line.text, "Fed holds rates steady, signals one cut in 2026");
    assert.equal(line.breaking, true);
    assert.deepEqual(line.symbols, ["RELIANCE"]);
    assert.deepEqual(line.tags, ["⭐"]);
    assert.equal(line.routerKey, "abc123");
    assert.ok(line._hash && line._archived_at);
  });
});

test("cross-channel copies of the same story survive as SEPARATE lines", () => {
  withTmpDir((dir) => {
    const r = archiveWireMessages(
      [
        rec({ channel: "FinancialJuice", routerKey: "same-story" }),
        rec({ channel: "Walter Bloomberg", routerKey: "same-story" }),
      ],
      { archiveDir: dir, asOf: "2026-07-08T09:05:00Z" },
    );
    assert.equal(r.written, 2, "distinct channels → 2 lines (clusterer counts sources)");
  });
});

test("same message re-seen on the SAME channel dedups", () => {
  withTmpDir((dir) => {
    archiveWireMessages([rec({ routerKey: "k1" })], { archiveDir: dir, asOf: "2026-07-08T09:00:00Z" });
    const r = archiveWireMessages([rec({ routerKey: "k1" })], { archiveDir: dir, asOf: "2026-07-08T09:01:00Z" });
    assert.equal(r.written, 0);
    assert.equal(r.skipped, 1);
  });
});

test("records without text are dropped", () => {
  withTmpDir((dir) => {
    const r = archiveWireMessages([{ channel: "X", routerKey: "z" }, rec()], {
      archiveDir: dir,
      asOf: "2026-07-08T09:00:00Z",
    });
    assert.equal(r.written, 1);
  });
});

test("[M2] loadWireWindow reads the trailing TWO UTC day-files and filters by window", () => {
  withTmpDir((dir) => {
    // Yesterday's file (by ingest), fresh publishedAt.
    archiveWireMessages([rec({ routerKey: "y", publishedAt: "2026-07-07T23:50:00Z" })], {
      archiveDir: dir,
      asOf: "2026-07-07T23:50:00Z",
    });
    // Today's file, fresh.
    archiveWireMessages([rec({ routerKey: "t", publishedAt: "2026-07-08T00:10:00Z" })], {
      archiveDir: dir,
      asOf: "2026-07-08T00:10:00Z",
    });
    // Today's file, but STALE (outside a 2h window).
    archiveWireMessages([rec({ routerKey: "old", publishedAt: "2026-07-07T20:00:00Z" })], {
      archiveDir: dir,
      asOf: "2026-07-08T00:10:00Z",
    });
    const win = loadWireWindow(2, { archiveDir: dir, now: new Date("2026-07-08T00:30:00Z").getTime() });
    const keys = win.map((r) => r.routerKey).sort();
    assert.deepEqual(keys, ["t", "y"], "both fresh cross-midnight rows in, stale one out");
  });
});

test("loadWireWindow drops undated rows", () => {
  withTmpDir((dir) => {
    archiveWireMessages([rec({ routerKey: "nd", publishedAt: null })], { archiveDir: dir, asOf: "2026-07-08T00:10:00Z" });
    const win = loadWireWindow(24, { archiveDir: dir, now: new Date("2026-07-08T01:00:00Z").getTime() });
    assert.equal(win.length, 0);
  });
});

test("[M1] pruneWireBuffer drops day-files older than keepDays", () => {
  withTmpDir((dir) => {
    archiveWireMessages([rec()], { archiveDir: dir, asOf: "2026-07-01T09:00:00Z" }); // old
    archiveWireMessages([rec({ routerKey: "new" })], { archiveDir: dir, asOf: "2026-07-08T09:00:00Z" }); // fresh
    const r = pruneWireBuffer({ archiveDir: dir, keepDays: 2, now: new Date("2026-07-08T12:00:00Z").getTime() });
    assert.deepEqual(r.pruned, ["2026-07-01.jsonl"]);
    assert.ok(fs.existsSync(path.join(dir, "2026-07-08.jsonl")));
    assert.ok(!fs.existsSync(path.join(dir, "2026-07-01.jsonl")));
  });
});

test("pruneWireBuffer is a no-op when archiveDir is null", () => {
  const r = pruneWireBuffer({ archiveDir: wireDir({}) });
  assert.deepEqual(r.pruned, []);
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
