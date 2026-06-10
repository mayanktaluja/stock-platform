#!/usr/bin/env node
/**
 * Picks-vs-snapshots Fair-Value drift probe — Layer 3 of the fix planned
 * in ~/.claude/plans/so-i-have-attached-virtual-sphinx.md.
 *
 * The pipeline-time gate (`sws-verify-db-vs-json.mjs --check picks-
 * snapshot-fv` called from sws-refresh-api.sh) blocks a drifted run
 * from ever flipping is_canonical. The read-time guard in /api/sws-
 * picks overwrites drifted FVs with the snapshot value and emits a
 * `_meta.fv_drift_count` on every response so we can quantify any
 * leakage WITHOUT log-scraping.
 *
 * This probe is the second telemetry source. It appends one line to
 * data/sws/health/picks-fv-drift-24h.jsonl every 15 min via launchd
 * (see scripts/com.starbhai.picks-fv-drift-probe.plist):
 *
 *   {"ts":"2026-05-18T01:14:00.000Z","fv_drift_count":0,"source":"probe","mode":"disk"}
 *
 * scripts/earnings-health-summary.mjs reads the JSONL during the
 * nightly chain, surfaces the 24h max, and pushes a Slack alert when
 * non-zero. The file is trimmed to the last 24h on every append so it
 * doesn't grow without bound.
 *
 * ── How fv_drift_count is computed ────────────────────────────────────
 * The drift count is the number of picks rows whose stored Fair Value
 * differs from the value the read-time guard would reconcile against the
 * freshest per-ticker SWS snapshot. The canonical implementation is
 * `applyPicksFvDriftGuard` in server.js, surfaced as `_meta.fv_drift_count`
 * on /api/sws-picks.
 *
 * DEFAULT (disk mode): the probe reproduces that computation IN-PROCESS,
 * straight off disk, via the same shared modules the server uses —
 * `swsDal.getPicksLatest()` + `swsDal.getSnapshotFvMap()` (both disk-only
 * since the Postgres backend was decommissioned 2026-05-19) and
 * `reconcileFairValue()`. No HTTP, no running server. This is what fixed
 * the 2026-06-06 silent outage: the old HTTP-against-localhost:3000 design
 * produced ZERO telemetry for ~4 days whenever the dev server happened to
 * be down, while spewing identical "fetch failed" lines to stderr. A
 * 15-min launchd job must not depend on a hand-started dev server.
 *
 * HTTP mode (opt-in): set PROBE_BASE_URL to hit a live endpoint instead —
 * e.g. a remote deployment with PROBE_COOKIE for the session gate. Kept
 * for the rare case you want to probe the actually-served number rather
 * than recompute it locally.
 *
 *   node scripts/probe-picks-fv-drift.mjs                      # disk (default)
 *   PROBE_BASE_URL=http://localhost:3000 \
 *     node scripts/probe-picks-fv-drift.mjs                    # live local server
 *   PROBE_BASE_URL=https://starbhai-stock-platform.vercel.app \
 *     PROBE_COOKIE='connect.sid=…' \
 *     node scripts/probe-picks-fv-drift.mjs                    # remote (needs auth cookie)
 *
 * Read-only against disk/API + append-only on the JSONL. Safe to run on
 * any cadence; failures are silent (probe must never affect the user-
 * facing server) but reported on stderr so launchd's stderr log captures
 * a real outage.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as swsDal from "../services/swsDal/index.js";
import { reconcileFairValue } from "../services/fvReconciliation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HEALTH_DIR = path.join(ROOT, "data", "sws", "health");
const JSONL_PATH = path.join(HEALTH_DIR, "picks-fv-drift-24h.jsonl");
const BASE_URL = process.env.PROBE_BASE_URL || null; // unset → disk mode
const TIMEOUT_MS = 15_000;

const normaliseTicker = (t) => (t ? String(t).trim().replace(/\.(NS|BO|BSE|NSE)$/i, "") : null);
const isPureBSEcode = (t) => typeof t === "string" && /^\d+$/.test(t);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// In-process reproduction of /api/sws-picks' fv_drift_count, read straight
// off disk. Mirrors the per-section loop in server.js: clone the curated
// sections (minus `avoid`, which the endpoint drops), bulk-load the snapshot
// FV map for every ticker, then count rows whose stored FV/upside/reason
// diverge from reconcileFairValue(snapshot). Kept deliberately close to
// `applyPicksFvDriftGuard` — if that guard's comparison changes, update here
// too. The count can differ from the live endpoint by a small margin: the
// server also applies a dividend value-gate and a missing-deep fail-open
// filter before the guard, which we don't reproduce (they only drop rows,
// so disk mode reads slightly high). The dominant signal — "rows reconciled
// against a fresher snapshot" — is identical.
function computeDriftFromDisk() {
  const raw = swsDal.getPicksLatest();
  if (!raw || !raw.sections) {
    throw new Error("no picks-latest.json on disk (run an SWS refresh first)");
  }
  const { avoid, ...sections } = raw.sections;
  void avoid;

  const allTickers = [
    ...new Set(
      Object.values(sections).flatMap((arr) =>
        Array.isArray(arr) ? arr.map((it) => it && it.ticker).filter(Boolean) : [],
      ),
    ),
  ];

  // getSnapshotFvMap is async only by signature (disk-backed, resolves sync).
  return Promise.resolve(swsDal.getSnapshotFvMap(allTickers)).then((snapMap) => {
    let count = 0;
    for (const items of Object.values(sections)) {
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        if (!it || !it.ticker || isPureBSEcode(it.ticker)) continue;
        const snap = snapMap.get(normaliseTicker(it.ticker));
        if (!snap) continue;
        const fv = reconcileFairValue(snap);
        const fvChanged =
          num(it.fair_value_inr) !== fv.fair_value_inr ||
          num(it.upside_pct) !== fv.upside_pct ||
          (it.fv_reconcile_reason ?? null) !== fv.fv_reconcile_reason;
        if (fvChanged) count += 1;
      }
    }
    return count;
  });
}

async function fetchPicksMeta() {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = {};
    if (process.env.PROBE_COOKIE) headers.cookie = process.env.PROBE_COOKIE;
    const res = await fetch(`${BASE_URL}/api/sws-picks`, { signal: ctrl.signal, headers });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await res.json();
    const count = body && body._meta && Number(body._meta.fv_drift_count);
    if (!Number.isFinite(count)) {
      throw new Error("missing _meta.fv_drift_count in response");
    }
    return count;
  } finally {
    clearTimeout(timeout);
  }
}

// Append the new entry and rewrite the file with only the entries from
// the last 24 hours. Bounded growth without needing a logrotate. Cheap
// because the file should never exceed ~96 lines (24h × 4/hr).
export function trimAndAppend({ now = new Date(), countObj, existingLines }) {
  const cutoffMs = now.getTime() - 24 * 3600 * 1000;
  const kept = [];
  for (const line of existingLines || []) {
    const t = line && line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t);
      const ts = Date.parse(parsed.ts);
      if (Number.isFinite(ts) && ts >= cutoffMs) {
        kept.push(t);
      }
    } catch {
      // drop malformed line on rotation — these are usually partial
      // writes from a crashed prior probe.
    }
  }
  kept.push(JSON.stringify(countObj));
  return kept.join("\n") + "\n";
}

async function main() {
  const mode = BASE_URL ? "http" : "disk";
  let count;
  try {
    count = mode === "http" ? await fetchPicksMeta() : await computeDriftFromDisk();
  } catch (err) {
    // Probe must never crash the host — but we DO want launchd's stderr
    // log to capture so a sustained outage surfaces.
    console.error(`[probe-picks-fv-drift] ${mode} probe failed: ${err.message}`);
    process.exit(0);
  }

  const entry = {
    ts: new Date().toISOString(),
    fv_drift_count: count,
    source: "probe",
    mode,
    base_url: BASE_URL,
  };

  try {
    fs.mkdirSync(HEALTH_DIR, { recursive: true });
    const existingLines = fs.existsSync(JSONL_PATH)
      ? fs.readFileSync(JSONL_PATH, "utf8").split("\n")
      : [];
    const next = trimAndAppend({ now: new Date(), countObj: entry, existingLines });
    fs.writeFileSync(JSONL_PATH, next);
    console.log(`[probe-picks-fv-drift] ${entry.ts} mode=${mode} count=${count}`);
  } catch (err) {
    console.error(`[probe-picks-fv-drift] write failed: ${err.message}`);
    process.exit(0);
  }
}

// Module-load guard so the test file can import trimAndAppend without
// triggering main().
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
