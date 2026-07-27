// Resolves the directory the per-day earnings-prediction archive is READ from.
//
// The archive is ~59 daily snapshots and grows by roughly 5 MB/day. Shipping it
// loose put 63.8 MB of highly-redundant JSON into the Vercel function and, on
// 2026-07-25, pushed the bundle past Vercel's 250 MB uncompressed limit — every
// production and preview deploy failed for two days. The same JSON packs to
// ~5 MB, so prod now ships `data/catalysts/earnings-history.tar.gz` and expands
// it into /tmp on first read.
//
// This mirrors the deep-brief contract in services/swsDal/jsonBackend.js: loose
// directory wins when it exists (local dev + the nightly, which must keep
// writing there), tarball is the cold-start fallback that only Vercel takes.
//
// WRITES still go to the repo directory — see earningsHistoryArchive.js. Only
// reads are redirected, because nothing writes the archive on Vercel.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { extractTarballWithNode } from "../swsDal/deepTarball.js";

// cwd-relative, NOT module-relative — this deliberately mirrors the
// `const ROOT = process.cwd()` capture in earningsHistoryArchive.js. Resolving
// from import.meta.url instead would pin every lookup to the real repo, which
// breaks the archive tests: they run each case in a child node process whose cwd
// is a tempdir precisely because that capture is the module's contract.
const ROOT = process.cwd();

export const HISTORY_DIR = path.join(ROOT, "data", "catalysts", "earnings-history");
export const HISTORY_TARBALL = path.join(ROOT, "data", "catalysts", "earnings-history.tar.gz");

// Vercel's /tmp is the only writable path in the function (~500 MB cap).
const EXTRACT_BASE = "/tmp/earnings-history";
const MEMBER_PREFIX = "earnings-history/";

// Only a successful extraction is memoised. The loose-directory check is re-run
// every call (a single readdir) so a directory created after first read — which
// the archiver does on a fresh checkout — is picked up instead of being cached
// away behind a stale answer.
let _extracted = null;

function hasSnapshots(dir) {
  try {
    return fs.readdirSync(dir).some((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return false;
  }
}

/**
 * The directory to read daily archive snapshots from.
 *
 * Resolved once per container: the extract costs ~5 MB of gunzip and every
 * caller (hit-rate summary, prediction freeze, the audit route, forward-return
 * resolution) would otherwise repeat it.
 *
 * Always returns a path. When neither the loose directory nor the tarball is
 * present it returns HISTORY_DIR, which every caller already guards with an
 * existsSync check — a missing archive degrades to "no history", never a throw.
 */
export function earningsHistoryReadDir() {
  // Loose directory always wins: local dev and the nightly write there, and it
  // is the only copy guaranteed fresh.
  if (hasSnapshots(HISTORY_DIR)) return HISTORY_DIR;

  if (_extracted && hasSnapshots(_extracted)) return _extracted;

  if (fs.existsSync(HISTORY_TARBALL)) {
    const extracted = path.join(EXTRACT_BASE, "earnings-history");
    // rm + mkdir is idempotent and cheap: a recycled Vercel container can carry
    // a previous deploy's extract, which would otherwise serve stale snapshots.
    try {
      fs.rmSync(EXTRACT_BASE, { recursive: true, force: true });
      fs.mkdirSync(EXTRACT_BASE, { recursive: true });
      execFileSync("tar", ["-xzf", HISTORY_TARBALL, "-C", EXTRACT_BASE], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      if (hasSnapshots(extracted)) {
        console.log(`[earningsHistoryStore] extracted archive to ${extracted}`);
        _extracted = extracted;
        return _extracted;
      }
    } catch (err) {
      try {
        if (
          extractTarballWithNode({
            tarballPath: HISTORY_TARBALL,
            extractBase: EXTRACT_BASE,
            memberPrefix: MEMBER_PREFIX,
          }) &&
          hasSnapshots(extracted)
        ) {
          console.log(`[earningsHistoryStore] extracted archive with Node fallback to ${extracted}`);
          _resolved = extracted;
          return _resolved;
        }
        console.warn(`[earningsHistoryStore] archive extract failed: ${err.message}`);
      } catch (fallbackErr) {
        console.warn(
          `[earningsHistoryStore] archive extract failed: ${err.message}; Node fallback failed: ${fallbackErr.message}`,
        );
      }
    }
  }

  return HISTORY_DIR;
}

// Test-only: drops the memoised extract so a spec can stage a different fixture.
export function _resetEarningsHistoryDirCache() {
  _extracted = null;
}
