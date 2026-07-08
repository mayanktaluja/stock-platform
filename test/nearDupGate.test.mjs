import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadRecentStories, findNearDup, recordStory, pruneRecentStories, normalizeTokens,
  DEFAULT_THRESHOLD,
} from "../services/alerts/nearDupGate.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); pass++; }
  catch (err) { console.log(`  not ok - ${name}\n      ${err.message}`); fail++; }
}
function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nearDupGate-"));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const NOW = new Date("2026-07-08T12:00:00Z").getTime();

test("findNearDup: identical text is a duplicate", () => {
  const t = normalizeTokens("Fed cuts rates by 25bps, Powell signals more easing");
  const recent = [{ key: "k1", ts: NOW, tokens: t }];
  const r = findNearDup(t, recent);
  assert.equal(r.matched, true);
  assert.equal(r.similarity, 1);
  assert.equal(r.key, "k1");
});

test("findNearDup: reworded same story IS caught (what exact-hash dedup misses)", () => {
  const a = normalizeTokens("Fed cuts rates by 25bps, Powell signals more easing ahead");
  const b = normalizeTokens("Fed lowers rates by 25bps, Powell signals more easing ahead");
  const r = findNearDup(b, [{ key: "k1", ts: NOW, tokens: a }]);
  assert.ok(r.similarity >= DEFAULT_THRESHOLD, `sim ${r.similarity} should clear ${DEFAULT_THRESHOLD}`);
  assert.equal(r.matched, true);
});

test("findNearDup: a genuinely different story is NOT suppressed", () => {
  const a = normalizeTokens("Fed cuts rates by 25bps, Powell signals more easing ahead");
  const b = normalizeTokens("Reliance Industries jumps 4 percent on strong quarterly profit");
  const r = findNearDup(b, [{ key: "k1", ts: NOW, tokens: a }]);
  assert.equal(r.matched, false);
});

test("findNearDup fails OPEN on empty inputs (send rather than swallow)", () => {
  assert.equal(findNearDup(new Set(), [{ key: "k", ts: NOW, tokens: new Set(["a"]) }]).matched, false);
  assert.equal(findNearDup(new Set(["a"]), []).matched, false);
  assert.equal(findNearDup(new Set(["a"]), null).matched, false);
});

test("recordStory → loadRecentStories round-trips inside the window", () => {
  withTmp((dir) => {
    const t = normalizeTokens("Nifty slips as banking stocks drop on NPA concerns");
    assert.equal(recordStory("k1", t, { dir, now: NOW }).recorded, true);
    const recent = loadRecentStories({ dir, now: NOW + 60_000, windowMs: 45 * 60 * 1000 });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].key, "k1");
    assert.ok(recent[0].tokens instanceof Set);
    assert.equal(findNearDup(t, recent).matched, true);
  });
});

test("stories outside the window are ignored (the cycle has moved on)", () => {
  withTmp((dir) => {
    const t = normalizeTokens("Old story about crude oil prices rising sharply today");
    recordStory("old", t, { dir, now: NOW });
    const recent = loadRecentStories({ dir, now: NOW + 46 * 60 * 1000, windowMs: 45 * 60 * 1000 });
    assert.equal(recent.length, 0, "a 46-min-old story is out of a 45-min window");
  });
});

test("window straddling UTC midnight reads yesterday's file too", () => {
  withTmp((dir) => {
    const beforeMidnight = new Date("2026-07-08T23:50:00Z").getTime();
    const afterMidnight = new Date("2026-07-09T00:10:00Z").getTime();
    recordStory("y", normalizeTokens("Fed cuts rates late in the session tonight"), { dir, now: beforeMidnight });
    const recent = loadRecentStories({ dir, now: afterMidnight, windowMs: 45 * 60 * 1000 });
    assert.equal(recent.length, 1, "yesterday's UTC file must still be read");
  });
});

test("loadRecentStories fails OPEN on a missing dir", () => {
  assert.deepEqual(loadRecentStories({ dir: "/nonexistent/path/xyz", now: NOW }), []);
});

test("pruneRecentStories drops files older than keepDays", () => {
  withTmp((dir) => {
    recordStory("old", normalizeTokens("some old story text here"), { dir, now: new Date("2026-07-01T00:00:00Z").getTime() });
    recordStory("new", normalizeTokens("some fresh story text here"), { dir, now: NOW });
    const r = pruneRecentStories({ dir, now: NOW, keepDays: 2 });
    assert.deepEqual(r.pruned, ["recent-stories-2026-07-01.ndjson"]);
    assert.ok(fs.existsSync(path.join(dir, "recent-stories-2026-07-08.ndjson")));
  });
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
