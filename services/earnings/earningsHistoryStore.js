// Resolves the directory the per-day earnings-prediction archive is READ from.
//
// The archive is one JSON snapshot per day and grows by roughly 5 MB/day.
// Shipping it loose put 63.8 MB of highly-redundant JSON into the Vercel
// function and, on 2026-07-25, pushed the bundle past Vercel's 250 MB
// uncompressed limit — every production and preview deploy failed for two days.
// Prod now ships `data/catalysts/earnings-history.tar.br` (a brotli tar, see
// earningsHistoryPack.js for why not gzip) and expands it into /tmp on first read.
//
// This mirrors the deep-brief contract in services/swsDal/jsonBackend.js: loose
// directory wins when it exists (local dev + the nightly, which must keep
// writing there), the archive is the cold-start fallback that only Vercel takes.
//
// WRITES still go to the repo directory — see earningsHistoryArchive.js. Only
// reads are redirected, because nothing writes the archive on Vercel.

import fs from "node:fs";
import path from "node:path";

import { unpackArchiveSync, unpackArchiveInProcess } from "./earningsHistoryPack.js";

// cwd-relative, NOT module-relative — this deliberately mirrors the
// `const ROOT = process.cwd()` capture in earningsHistoryArchive.js. Resolving
// from import.meta.url instead would pin every lookup to the real repo, which
// breaks the archive tests: they run each case in a child node process whose cwd
// is a tempdir precisely because that capture is the module's contract.
const ROOT = process.cwd();

export const HISTORY_DIR = path.join(ROOT, "data", "catalysts", "earnings-history");
export const HISTORY_TARBALL = path.join(ROOT, "data", "catalysts", "earnings-history.tar.br");

// Vercel's /tmp is the only writable path in the function (~500 MB cap). The
// override exists for tests, so concurrent suites don't share one extract dir.
const EXTRACT_BASE = process.env.EARNINGS_HISTORY_EXTRACT_BASE || "/tmp/earnings-history";

// A successful extraction is memoised, and so is a failed one: callers such as
// predictionFreeze run per request and would otherwise re-inflate 260+ MB each
// time. A new deploy is a new container, so a failure never outlives the
// archive that caused it. The loose-directory check is re-run every call (a
// single readdir) so a directory created after first read — which the archiver
// does on a fresh checkout — is picked up instead of being cached away.
let _extracted = null;
let _extractFailed = false;

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
 * Resolved once per container: the extract inflates 260+ MB and every
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

  if (!_extractFailed && fs.existsSync(HISTORY_TARBALL)) {
    const extracted = path.join(EXTRACT_BASE, "earnings-history");
    const opts = { archivePath: HISTORY_TARBALL, extractBase: EXTRACT_BASE };
    let how = null;
    try {
      resetExtractBase();
      unpackArchiveSync(opts); // streams through a child node process
      how = "";
    } catch (err) {
      console.warn(`[earningsHistoryStore] archive extract failed: ${err.message}`);
      // In-process only when the child never ran. A child that ran and failed
      // (corrupt archive, ENOSPC, timeout) has a status or signal, and inflating
      // the same archive in-process would fail the same way while holding the
      // whole tar in memory.
      if (err.status == null && err.signal == null) {
        try {
          resetExtractBase();
          unpackArchiveInProcess(opts);
          how = " in-process";
        } catch (fallbackErr) {
          console.warn(`[earningsHistoryStore] in-process extract failed: ${fallbackErr.message}`);
        }
      }
    }
    // `how` gates on the unpack returning, not on files being present: a failed
    // attempt can leave a partial extract that would otherwise pass for history.
    if (how !== null && hasSnapshots(extracted)) {
      console.log(`[earningsHistoryStore] extracted archive${how} to ${extracted}`);
      _extracted = extracted;
      return _extracted;
    }
    _extractFailed = true;
    // Drop any partial extract rather than leave it holding /tmp space the
    // deep-brief extracts share.
    try {
      fs.rmSync(EXTRACT_BASE, { recursive: true, force: true });
    } catch {}
  }

  return HISTORY_DIR;
}

// rm + mkdir before every attempt: a recycled Vercel container can carry a
// previous deploy's extract, and a failed attempt can leave a partial one.
function resetExtractBase() {
  fs.rmSync(EXTRACT_BASE, { recursive: true, force: true });
  fs.mkdirSync(EXTRACT_BASE, { recursive: true });
}

// Test-only: drops the memoised extract (or failure) so a spec can stage a
// different fixture.
export function _resetEarningsHistoryDirCache() {
  _extracted = null;
  _extractFailed = false;
}
