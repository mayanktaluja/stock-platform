import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { archiveHeadlines, loadArchivedHeadlines } from "../services/macroHeadlineArchive.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "macroHeadlineArchive-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SAMPLE_HEADLINES = [
  { source: "Reuters India", title: "RBI holds rates at 6.5%", publishedAt: "2026-05-18T07:00:00Z", tier: "A" },
  { source: "Bloomberg Quint", title: "OPEC+ extends production cuts", publishedAt: "2026-05-18T05:30:00Z", tier: "A" },
  { source: "Moneycontrol", title: "Nifty closes at lifetime high", publishedAt: "2026-05-18T10:30:00Z", tier: "B" },
];

test("archiveHeadlines writes fresh headlines to date-keyed JSONL", () => {
  withTmpDir((dir) => {
    const r = archiveHeadlines(SAMPLE_HEADLINES, { archiveDir: dir, asOf: "2026-05-18T12:00:00Z" });
    assert.equal(r.written, 3);
    assert.equal(r.skipped, 0);
    assert.ok(r.path.endsWith("2026-05-18.jsonl"));
    const lines = fs.readFileSync(r.path, "utf-8").trim().split("\n");
    assert.equal(lines.length, 3);
    const first = JSON.parse(lines[0]);
    assert.equal(first.title, "RBI holds rates at 6.5%");
    assert.ok(first._hash);
    assert.ok(first._archived_at);
  });
});

test("archiveHeadlines is idempotent on second call (dedup by hash)", () => {
  withTmpDir((dir) => {
    archiveHeadlines(SAMPLE_HEADLINES, { archiveDir: dir, asOf: "2026-05-18T12:00:00Z" });
    const r = archiveHeadlines(SAMPLE_HEADLINES, { archiveDir: dir, asOf: "2026-05-18T13:00:00Z" });
    assert.equal(r.written, 0);
    assert.equal(r.skipped, 3);
  });
});

test("archiveHeadlines adds NEW headline alongside duplicates", () => {
  withTmpDir((dir) => {
    archiveHeadlines(SAMPLE_HEADLINES, { archiveDir: dir, asOf: "2026-05-18T12:00:00Z" });
    const r = archiveHeadlines(
      [
        ...SAMPLE_HEADLINES,
        { source: "ET", title: "FII outflow tops $2bn", publishedAt: "2026-05-18T14:00:00Z", tier: "B" },
      ],
      { archiveDir: dir, asOf: "2026-05-18T15:00:00Z" },
    );
    assert.equal(r.written, 1);
    assert.equal(r.skipped, 3);
  });
});

test("archiveHeadlines empty input → no-op", () => {
  withTmpDir((dir) => {
    const r = archiveHeadlines([], { archiveDir: dir });
    assert.equal(r.written, 0);
    assert.equal(r.path, null);
  });
});

test("archiveHeadlines drops headlines missing title", () => {
  withTmpDir((dir) => {
    const r = archiveHeadlines(
      [{ source: "X" }, { source: "Y", title: "real headline" }],
      { archiveDir: dir, asOf: "2026-05-18T12:00:00Z" },
    );
    assert.equal(r.written, 1);
  });
});

test("loadArchivedHeadlines single-date", () => {
  withTmpDir((dir) => {
    archiveHeadlines(SAMPLE_HEADLINES, { archiveDir: dir, asOf: "2026-05-18T12:00:00Z" });
    const loaded = loadArchivedHeadlines("2026-05-18", { archiveDir: dir });
    assert.equal(loaded.length, 3);
  });
});

test("loadArchivedHeadlines date range", () => {
  withTmpDir((dir) => {
    archiveHeadlines(SAMPLE_HEADLINES, { archiveDir: dir, asOf: "2026-05-17T12:00:00Z" });
    archiveHeadlines(
      [{ source: "X", title: "another day", publishedAt: "2026-05-18T01:00:00Z" }],
      { archiveDir: dir, asOf: "2026-05-18T12:00:00Z" },
    );
    const loaded = loadArchivedHeadlines("2026-05-17", {
      archiveDir: dir,
      throughDate: "2026-05-18",
    });
    assert.equal(loaded.length, 4);
  });
});

test("sidecar meta file written when meta provided", () => {
  withTmpDir((dir) => {
    archiveHeadlines(SAMPLE_HEADLINES, {
      archiveDir: dir,
      asOf: "2026-05-18T12:00:00Z",
      meta: { tierCoverage: { "A+": 1, "A": 2, "B": 1 } },
    });
    const sidecar = path.join(dir, "2026-05-18._meta.json");
    assert.ok(fs.existsSync(sidecar));
    const m = JSON.parse(fs.readFileSync(sidecar, "utf-8"));
    assert.equal(m.entries.length, 1);
    assert.deepEqual(m.entries[0].meta.tierCoverage, { "A+": 1, "A": 2, "B": 1 });
  });
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
