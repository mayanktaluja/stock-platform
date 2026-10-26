// Packs the per-day earnings-prediction archive (data/catalysts/earnings-history/
// <YYYY-MM-DD>.json) into ONE brotli-compressed tar for the Vercel function, and
// unpacks it there. earningsHistoryStore.js is the only runtime caller.
//
// Why brotli, not `tar -czf`: the snapshots are near-duplicates of each other —
// every upcoming event is re-archived each day until it passes — but gzip's
// 32 KB window cannot reach back into the previous 3-13 MB snapshot, so gzip
// compressed every day on its own. On 2026-10-27 that tarball was 21.1 MB, grew
// 0.2-0.6 MB a night, and was the reason the function bundle reached the 200 MB
// budget. A brotli window that holds a whole snapshot does see the previous
// day: the same 118
// snapshots pack to ~3.3 MB and a new night adds ~0.02-0.12 MB. Nothing is
// dropped — the hit-rate summary and the audit route still read every snapshot.
// Brotli is built into Node's zlib, so Vercel needs no extra binary.
//
// The tar is written here rather than by the system `tar` so the member order
// (date order: adjacent days are what the window exploits) and the headers (no
// owners, wall-clock mtimes or macOS xattrs) are fixed. The same snapshots always
// pack to the same bytes, and a night that changes nothing commits nothing.
//
// CLI (spawned by scripts/pack-earnings-history.sh and by unpackArchiveSync):
//   node services/earnings/earningsHistoryPack.js pack   <srcDir> <outPath>
//   node services/earnings/earningsHistoryPack.js unpack <archivePath> <extractBase>

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);

// Every member lives under this directory, so an extract lands at
// <extractBase>/earnings-history/<date>.json — the layout the gzip tarball had.
export const MEMBER_DIR = "earnings-history";
const SNAPSHOT_RE = /^\d{4}-\d{2}-\d{2}\.json$/;
const BLOCK = 512;

// Quality 9 packs the 263 MB archive in ~3 s (the nightly allows the pack step
// 120 s); qualities 10-11 take minutes.
//
// The window must hold a whole snapshot for the next day to compress against
// it. Standard brotli stops at 16 MB and the largest snapshot so far is 13.1 MB
// (2026-08-10, results season), so the archive uses brotli's large-window mode
// (64 MB) instead: past 16 MB the standard window would fall back to roughly
// per-day compression and the nightly growth would return. A large-window
// stream needs a decoder that opts in — DECODE_OPTIONS — which every read here
// passes; nothing else decodes this file.
const BROTLI_PARAMS = {
  [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
  [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
  [zlib.constants.BROTLI_PARAM_LARGE_WINDOW]: 1,
  [zlib.constants.BROTLI_PARAM_LGWIN]: 26,
};
export const DECODE_OPTIONS = { params: { [zlib.constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 } };

export function listSnapshots(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => SNAPSHOT_RE.test(f)).sort();
  } catch {
    return [];
  }
}

function writeOctal(buf, offset, width, value) {
  buf.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width, "ascii");
}

function readField(buf, offset, width) {
  const raw = buf.subarray(offset, offset + width);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul >= 0 ? nul : raw.length).toString("utf8").trim();
}

function headerChecksum(header) {
  // The checksum is computed with its own 8-byte field read as spaces.
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum;
}

/** One ustar header for a regular file. Exported for tests that hand-craft archives. */
export function tarHeader(name, size, mtimeSec = 0) {
  if (Buffer.byteLength(name) > 99) throw new Error(`tar member name too long: ${name}`);
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtimeSec);
  h.write("0", 156, 1, "ascii");
  h.write("ustar\u000000", 257, 8, "ascii");
  h.write(headerChecksum(h).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

function* tarChunks(srcDir, names) {
  for (const name of names) {
    const body = fs.readFileSync(path.join(srcDir, name));
    // mtime = the snapshot's own date, so a header depends on nothing but the file.
    const mtime = Math.floor(Date.parse(`${name.slice(0, 10)}T00:00:00Z`) / 1000);
    yield tarHeader(`${MEMBER_DIR}/${name}`, body.length, mtime);
    yield body;
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(BLOCK * 2); // end-of-archive marker
}

/** Packs every <YYYY-MM-DD>.json in srcDir into outPath (atomic replace). */
export async function packArchive({ srcDir, outPath }) {
  const names = listSnapshots(srcDir);
  if (names.length === 0) throw new Error(`no <YYYY-MM-DD>.json snapshots in ${srcDir}`);
  // Sibling temp file + rename: a deploy or a concurrent reader never captures a
  // half-written archive.
  const tmp = `${outPath}.tmp.${process.pid}`;
  try {
    await pipeline(
      Readable.from(tarChunks(srcDir, names)),
      zlib.createBrotliCompress({ params: BROTLI_PARAMS }),
      fs.createWriteStream(tmp),
    );
    fs.renameSync(tmp, outPath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { files: names.length, bytes: fs.statSync(outPath).size };
}

// Incremental ustar reader. Fed decompressed bytes in chunks of any size, it
// writes each snapshot member to <extractBase>/earnings-history/. The streaming
// and in-process unpack paths share it so both apply the same member filter:
// only regular files named <YYYY-MM-DD>.json directly under earnings-history/ —
// which also means no member name can carry a "/" or ".." out of the extract dir.
function createExtractor(extractBase) {
  const outDir = path.join(extractBase, MEMBER_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  let buf = Buffer.alloc(0);
  let member = null; // { fd, remaining, padding } while inside a member's data
  let ended = false;
  let files = 0;

  function openMember(header) {
    const stored = parseInt(readField(header, 148, 8), 8);
    if (stored !== headerChecksum(header)) throw new Error("corrupt tar header (checksum mismatch)");
    const name = readField(header, 0, 100);
    const prefix = readField(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(readField(header, 124, 12) || "0", 8) || 0;
    const type = header[156];
    const base = fullName.startsWith(`${MEMBER_DIR}/`) ? fullName.slice(MEMBER_DIR.length + 1) : "";
    const wanted = (type === 0x30 || type === 0) && SNAPSHOT_RE.test(base);
    return {
      fd: wanted ? fs.openSync(path.join(outDir, base), "w") : null,
      remaining: size,
      padding: (BLOCK - (size % BLOCK)) % BLOCK,
    };
  }

  function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (!ended) {
      if (member && member.remaining > 0) {
        if (buf.length === 0) return;
        const n = Math.min(member.remaining, buf.length);
        if (member.fd !== null) fs.writeSync(member.fd, buf, 0, n);
        member.remaining -= n;
        buf = buf.subarray(n);
      } else if (member) {
        if (buf.length < member.padding) return;
        buf = buf.subarray(member.padding);
        if (member.fd !== null) {
          fs.closeSync(member.fd);
          files++;
        }
        member = null;
      } else {
        if (buf.length < BLOCK) return;
        const header = buf.subarray(0, BLOCK);
        buf = buf.subarray(BLOCK);
        if (header.every((b) => b === 0)) ended = true;
        else member = openMember(header);
      }
    }
  }

  function finish() {
    if (!ended) throw new Error("earnings-history archive is truncated");
    return files;
  }

  function close() {
    if (member && member.fd !== null) fs.closeSync(member.fd);
    member = null;
  }

  return { push, finish, close };
}

/** Streaming unpack (constant memory). Returns the number of snapshots written. */
export async function unpackArchive({ archivePath, extractBase }) {
  const extractor = createExtractor(extractBase);
  try {
    await pipeline(fs.createReadStream(archivePath), zlib.createBrotliDecompress(DECODE_OPTIONS), async (source) => {
      for await (const chunk of source) extractor.push(chunk);
    });
    return extractor.finish();
  } finally {
    extractor.close();
  }
}

/**
 * Synchronous unpack for earningsHistoryReadDir(), whose callers are all sync.
 * Runs unpackArchive in a child node process so the archive streams through a
 * few MB of memory; inflating it in-process would hold the whole 260+ MB tar
 * (and growing) in the function's 1 GB at once.
 */
// The timeout sits well inside vercel.json's 60 s maxDuration so a hung child
// fails the extract instead of the whole request; a healthy one takes ~0.5 s.
export function unpackArchiveSync({ archivePath, extractBase, timeoutMs = 30_000 }) {
  const out = execFileSync(process.execPath, [MODULE_PATH, "unpack", archivePath, extractBase], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  // Exact match: an empty stdout (a child whose isMain() check missed, so it
  // unpacked nothing) must not read as Number("") === 0.
  const last = out.trim().split("\n").pop();
  if (!/^\d+$/.test(last)) throw new Error(`unexpected unpack output: ${JSON.stringify(out.slice(0, 200))}`);
  return Number(last);
}

/** Fallback when a child process cannot be spawned: inflates the whole tar in memory. */
export function unpackArchiveInProcess({ archivePath, extractBase }) {
  const extractor = createExtractor(extractBase);
  try {
    extractor.push(zlib.brotliDecompressSync(fs.readFileSync(archivePath), DECODE_OPTIONS));
    return extractor.finish();
  } finally {
    extractor.close();
  }
}

async function main(argv) {
  const [cmd, a, b] = argv;
  if (cmd === "pack" && a && b) {
    const { files, bytes } = await packArchive({ srcDir: a, outPath: b });
    console.log(`packed ${files} snapshots -> ${b} (${(bytes / 1e6).toFixed(2)} MB)`);
  } else if (cmd === "unpack" && a && b) {
    // The last stdout line is the count unpackArchiveSync parses.
    console.log(await unpackArchive({ archivePath: a, extractBase: b }));
  } else {
    console.error("usage: earningsHistoryPack.js pack <srcDir> <outPath> | unpack <archivePath> <extractBase>");
    process.exitCode = 2;
  }
}

// realpath both sides: argv[1] keeps a symlinked cwd (/tmp → /private/tmp on
// macOS) while import.meta.url is already resolved, and a mismatch would make
// the CLI silently do nothing.
function isMain() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(MODULE_PATH);
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[earningsHistoryPack] ${err.message}`);
    process.exitCode = 1;
  });
}
