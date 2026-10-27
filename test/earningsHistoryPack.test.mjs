// services/earnings/earningsHistoryPack.js + the earningsHistoryStore.js read
// path — unit tests.
//
// The brotli archive replaced a 21.1 MB gzip tarball in the Vercel bundle
// (2026-10-27). These tests lock down what that switch must not lose:
//
//   • round trip — all three unpack paths (streaming, child-process sync,
//     in-process fallback) return the snapshots byte-for-byte, and only them
//   • determinism — same snapshots → same archive bytes, whatever the mtimes
//   • cross-day compression — a near-duplicate next day costs ~nothing; this is
//     the whole point, and what a per-file codec like gzip cannot do
//   • member filter — traversal, foreign dirs, non-snapshot names and
//     non-regular entries are never written
//   • truncated / corrupt archives throw instead of serving a partial history
//   • earningsHistoryReadDir() serves the archive when the loose dir is absent
//
// Run: node test/earningsHistoryPack.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DECODE_OPTIONS,
  MEMBER_DIR,
  listSnapshots,
  packArchive,
  tarHeader,
  unpackArchive,
  unpackArchiveInProcess,
  unpackArchiveSync,
} from "../services/earnings/earningsHistoryPack.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const STORE_PATH = path.join(REPO_ROOT, "services", "earnings", "earningsHistoryStore.js");

let ok = 0, fail = 0;
const tests = [];
function it(name, fn) { tests.push({ name, fn }); }

const tempDirs = [];
function freshTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earningsHistoryPack-"));
  tempDirs.push(dir);
  return dir;
}

// A snapshot-shaped JSON body that does not compress on its own (random hex),
// so any size win across two of them can only come from cross-file matching.
function snapshotBody(seed, events = 300) {
  const predictions = [];
  for (let i = 0; i < events; i++) {
    const h = crypto.createHash("sha256").update(`${seed}:${i}`).digest("hex");
    predictions.push({ symbol: `SYM${i}`, event_iso_date: "2026-11-01", note: h + h });
  }
  return JSON.stringify({ schema_version: "earnings-history-v5", predictions }, null, 2);
}

function writeSnapshots(dir, byName) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(byName)) fs.writeFileSync(path.join(dir, name), body);
}

function readTree(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir).sort()) out[f] = fs.readFileSync(path.join(dir, f), "utf8");
  return out;
}

function brotliTar(entries) {
  // entries: [{ name, body, type? }] → a hand-crafted archive.
  const parts = [];
  for (const { name, body, type } of entries) {
    const buf = Buffer.from(body);
    const h = tarHeader(name, buf.length);
    if (type) {
      h[156] = type.charCodeAt(0);
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
      h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    }
    parts.push(h, buf, Buffer.alloc((512 - (buf.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.brotliCompressSync(Buffer.concat(parts));
}

const SNAPSHOTS = {
  "2026-10-01.json": snapshotBody("a"),
  "2026-10-02.json": snapshotBody("a").replace("SYM7", "SYM7X"),
  "2026-10-03.json": "{}",
};

/* ─────────────────────────────── round trip ────────────────────────────── */

it("packs only <YYYY-MM-DD>.json and every unpack path returns them byte-for-byte", async () => {
  const src = path.join(freshTempDir(), MEMBER_DIR);
  writeSnapshots(src, { ...SNAPSHOTS, "notes.txt": "not a snapshot", "2026-10-04.json.tmp.1": "{" });
  const archive = path.join(freshTempDir(), "eh.tar.br");

  const { files } = await packArchive({ srcDir: src, outPath: archive });
  assert.equal(files, 3);
  assert.deepEqual(fs.readdirSync(path.dirname(archive)), ["eh.tar.br"], "the temp file must be renamed away");

  for (const [label, unpack] of [
    ["streaming", (o) => unpackArchive(o)],
    ["child-process sync", (o) => unpackArchiveSync(o)],
    ["in-process", (o) => unpackArchiveInProcess(o)],
  ]) {
    const base = freshTempDir();
    assert.equal(await unpack({ archivePath: archive, extractBase: base }), 3, label);
    assert.deepEqual(readTree(path.join(base, MEMBER_DIR)), SNAPSHOTS, label);
  }
});

it("the archive is a plain ustar (under large-window brotli) the system tar can list", async () => {
  const src = path.join(freshTempDir(), MEMBER_DIR);
  writeSnapshots(src, SNAPSHOTS);
  const archive = path.join(freshTempDir(), "eh.tar.br");
  await packArchive({ srcDir: src, outPath: archive });
  const raw = path.join(freshTempDir(), "eh.tar");
  fs.writeFileSync(raw, zlib.brotliDecompressSync(fs.readFileSync(archive), DECODE_OPTIONS));
  const listed = execFileSync("tar", ["-tf", raw], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(listed, Object.keys(SNAPSHOTS).sort().map((f) => `${MEMBER_DIR}/${f}`), "date order");
});

/* ────────────────────────────── determinism ────────────────────────────── */

it("same snapshots pack to the same bytes regardless of file mtimes", async () => {
  const src = path.join(freshTempDir(), MEMBER_DIR);
  writeSnapshots(src, SNAPSHOTS);
  const a = path.join(freshTempDir(), "a.tar.br");
  const b = path.join(freshTempDir(), "b.tar.br");
  await packArchive({ srcDir: src, outPath: a });
  const later = new Date(Date.now() + 86_400_000);
  for (const f of listSnapshots(src)) fs.utimesSync(path.join(src, f), later, later);
  await packArchive({ srcDir: src, outPath: b });
  assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)), "a night that changes nothing must commit nothing");
});

/* ────────────────────────── cross-day compression ──────────────────────── */

it("a near-duplicate next day adds almost nothing to the archive", async () => {
  const day1 = snapshotBody("cross");
  const day2 = day1.replace("SYM42", "SYM42X");
  const oneDir = path.join(freshTempDir(), MEMBER_DIR);
  const twoDir = path.join(freshTempDir(), MEMBER_DIR);
  writeSnapshots(oneDir, { "2026-10-01.json": day1 });
  writeSnapshots(twoDir, { "2026-10-01.json": day1, "2026-10-02.json": day2 });
  const one = path.join(freshTempDir(), "one.tar.br");
  const two = path.join(freshTempDir(), "two.tar.br");
  await packArchive({ srcDir: oneDir, outPath: one });
  await packArchive({ srcDir: twoDir, outPath: two });
  const s1 = fs.statSync(one).size;
  const s2 = fs.statSync(two).size;
  // Per-file compression (what gzip's 32 KB window amounts to on 3-13 MB
  // snapshots) would roughly double; the 16 MB window must make day 2 ~free.
  assert.ok(day1.length > 64 * 1024, "fixture must exceed gzip's window to mean anything");
  assert.ok(s2 < s1 * 1.1, `second day cost ${s2 - s1} bytes on a ${s1}-byte archive`);
});

it("…even when one day's snapshot outgrows the standard 16 MB brotli window", async () => {
  // Results-season snapshots already reach 13.1 MB (2026-08-10). Past 16 MB a
  // standard window can't hold the previous day and growth returns.
  const day1 = crypto.randomBytes(8_500_000).toString("hex"); // 17 MB; ~8.5 MB on its own
  const day2 = `${day1.slice(0, 1000)}x${day1.slice(1000)}`;
  const twoDir = path.join(freshTempDir(), MEMBER_DIR);
  writeSnapshots(twoDir, { "2026-10-01.json": day1, "2026-10-02.json": day2 });
  const two = path.join(freshTempDir(), "two.tar.br");
  await packArchive({ srcDir: twoDir, outPath: two });
  const size = fs.statSync(two).size;
  assert.ok(size < day1.length * 0.6, `two 17 MB days packed to ${size} bytes — day 2 was not matched against day 1`);
  assert.equal(await unpackArchive({ archivePath: two, extractBase: freshTempDir() }), 2);
});

/* ───────────────────────────── member filter ───────────────────────────── */

it("writes only regular <YYYY-MM-DD>.json members directly under earnings-history/", () => {
  const base = freshTempDir();
  const archive = path.join(freshTempDir(), "crafted.tar.br");
  fs.writeFileSync(
    archive,
    brotliTar([
      { name: `${MEMBER_DIR}/2026-01-01.json`, body: "{\"ok\":1}" },
      { name: `${MEMBER_DIR}/../2026-01-02.json`, body: "escape" },
      { name: "other/2026-01-03.json", body: "foreign dir" },
      { name: `${MEMBER_DIR}/sub/2026-01-04.json`, body: "nested" },
      { name: `${MEMBER_DIR}/notes.txt`, body: "not a snapshot" },
      { name: `${MEMBER_DIR}/2026-01-05.json`, body: "/etc/passwd", type: "2" },
    ]),
  );
  assert.equal(unpackArchiveInProcess({ archivePath: archive, extractBase: base }), 1);
  assert.deepEqual(fs.readdirSync(base), [MEMBER_DIR]);
  assert.deepEqual(readTree(path.join(base, MEMBER_DIR)), { "2026-01-01.json": "{\"ok\":1}" });
});

/* ─────────────────────── truncated / corrupt archives ───────────────────── */

it("a truncated archive throws on every unpack path", async () => {
  const src = path.join(freshTempDir(), MEMBER_DIR);
  writeSnapshots(src, SNAPSHOTS);
  const good = path.join(freshTempDir(), "good.tar.br");
  await packArchive({ srcDir: src, outPath: good });
  const bytes = fs.readFileSync(good);
  const cut = path.join(freshTempDir(), "cut.tar.br");
  fs.writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
  // An intact brotli stream whose tar lacks the end-of-archive blocks.
  const noEnd = path.join(freshTempDir(), "noend.tar.br");
  fs.writeFileSync(noEnd, zlib.brotliCompressSync(zlib.brotliDecompressSync(bytes, DECODE_OPTIONS).subarray(0, 512 * 3)));

  for (const archivePath of [cut, noEnd]) {
    await assert.rejects(unpackArchive({ archivePath, extractBase: freshTempDir() }));
    assert.throws(() => unpackArchiveSync({ archivePath, extractBase: freshTempDir() }));
    assert.throws(() => unpackArchiveInProcess({ archivePath, extractBase: freshTempDir() }));
  }
});

it("a header with a bad checksum throws", () => {
  const archive = path.join(freshTempDir(), "bad.tar.br");
  const raw = zlib.brotliDecompressSync(brotliTar([{ name: `${MEMBER_DIR}/2026-01-01.json`, body: "{}" }]));
  raw[0] ^= 0x01; // flip a bit in the member name
  fs.writeFileSync(archive, zlib.brotliCompressSync(raw));
  assert.throws(() => unpackArchiveInProcess({ archivePath: archive, extractBase: freshTempDir() }), /checksum/);
});

it("packing an empty directory refuses instead of shipping an empty archive", async () => {
  const src = freshTempDir();
  await assert.rejects(packArchive({ srcDir: src, outPath: path.join(src, "x.tar.br") }), /no <YYYY-MM-DD>\.json/);
});

/* ──────────────────────── earningsHistoryReadDir() ─────────────────────── */

// The store captures process.cwd() at import, so each case runs in a child
// node process whose cwd is a tempdir (same harness as earningsHistoryArchive).
// EARNINGS_HISTORY_EXTRACT_BASE keeps the extract out of the real
// /tmp/earnings-history, which a concurrent suite in another worktree may use.
// The store is called twice to observe the per-container memo.
function readDirInChild(cwd) {
  const extractBase = path.join(freshTempDir(), "extract");
  const src = `
    import fs from "node:fs";
    import path from "node:path";
    const { earningsHistoryReadDir } = await import(${JSON.stringify(STORE_PATH)});
    const dir = earningsHistoryReadDir();
    const again = earningsHistoryReadDir();
    let files = null;
    if (fs.existsSync(dir)) {
      files = {};
      for (const f of fs.readdirSync(dir).sort()) files[f] = fs.readFileSync(path.join(dir, f), "utf8");
    }
    console.log(JSON.stringify({ dir, again, files, extractLeft: fs.existsSync(${JSON.stringify(extractBase)}) }));
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, EARNINGS_HISTORY_EXTRACT_BASE: extractBase },
  });
  assert.equal(res.status, 0, res.stderr);
  return { ...JSON.parse(res.stdout.trim().split("\n").pop()), extractBase, stderr: res.stderr };
}

it("Vercel shape (archive only, no loose dir) → serves the extracted archive", async () => {
  const cwd = freshTempDir();
  const staging = path.join(freshTempDir(), MEMBER_DIR);
  writeSnapshots(staging, SNAPSHOTS);
  fs.mkdirSync(path.join(cwd, "data", "catalysts"), { recursive: true });
  await packArchive({ srcDir: staging, outPath: path.join(cwd, "data", "catalysts", "earnings-history.tar.br") });

  const { dir, again, files, extractBase, stderr } = readDirInChild(cwd);
  assert.equal(dir, path.join(extractBase, MEMBER_DIR));
  assert.equal(again, dir);
  assert.deepEqual(files, SNAPSHOTS);
  assert.doesNotMatch(stderr, /failed/);
});

it("a corrupt archive degrades to 'no history' and leaves no partial extract", async () => {
  const cwd = freshTempDir();
  const staging = path.join(freshTempDir(), MEMBER_DIR);
  writeSnapshots(staging, SNAPSHOTS);
  const archive = path.join(cwd, "data", "catalysts", "earnings-history.tar.br");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  await packArchive({ srcDir: staging, outPath: archive });
  const bytes = fs.readFileSync(archive);
  fs.writeFileSync(archive, bytes.subarray(0, Math.floor(bytes.length / 2)));

  const { dir, again, files, extractLeft, stderr } = readDirInChild(cwd);
  // HISTORY_DIR, which every caller existsSync-guards into "no history".
  assert.equal(fs.realpathSync(path.dirname(dir)), fs.realpathSync(path.dirname(archive)));
  assert.equal(again, dir);
  assert.equal(files, null);
  assert.equal(extractLeft, false, "a failed extract must not keep holding /tmp space");
  // The child ran and failed, so the in-process inflate (which would fail the
  // same way holding the whole tar in memory) is skipped, and the second call
  // reuses the memoised failure instead of re-inflating.
  assert.equal(stderr.match(/archive extract failed/g)?.length, 1, stderr);
  assert.doesNotMatch(stderr, /in-process/);
});

it("local shape (loose dir present) → the loose dir wins over the archive", async () => {
  const cwd = freshTempDir();
  const loose = path.join(cwd, "data", "catalysts", MEMBER_DIR);
  writeSnapshots(loose, { "2026-10-09.json": "{\"fresh\":true}" });
  const staging = path.join(freshTempDir(), MEMBER_DIR);
  writeSnapshots(staging, SNAPSHOTS);
  await packArchive({ srcDir: staging, outPath: path.join(cwd, "data", "catalysts", "earnings-history.tar.br") });

  const { dir, files } = readDirInChild(cwd);
  assert.equal(fs.realpathSync(dir), fs.realpathSync(loose));
  assert.deepEqual(files, { "2026-10-09.json": "{\"fresh\":true}" });
});

/* ─────────────────────────────────── run ────────────────────────────────── */

console.log("\nearningsHistoryPack — brotli archive pack/unpack + store read path\n");
for (const { name, fn } of tests) {
  try {
    await fn();
    ok++;
    console.log("  ✓", name);
  } catch (e) {
    fail++;
    console.log("  ✗", name, "→", e.message);
  }
}
for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${ok} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
