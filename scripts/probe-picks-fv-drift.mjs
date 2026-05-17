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
 * This probe is the second telemetry source: it hits the running
 * local server once per scheduled invocation (every 15 min via launchd
 * — see scripts/com.starbhai.picks-fv-drift-probe.plist) and appends
 * one line to data/sws/health/picks-fv-drift-24h.jsonl:
 *
 *   {"ts":"2026-05-18T01:14:00.000Z","fv_drift_count":0,"source":"probe"}
 *
 * scripts/earnings-health-summary.mjs reads the JSONL during the
 * nightly chain, surfaces the 24h max, and pushes a Slack alert when
 * non-zero. The file is trimmed to the last 24h on every append so it
 * doesn't grow without bound.
 *
 * Read-only against the API + append-only on disk. Safe to run on any
 * cadence; failures are silent (probe must never affect the user-
 * facing server) but reported on stderr so launchd's stderr log
 * captures real outages.
 *
 * Usage:
 *   node scripts/probe-picks-fv-drift.mjs                      # localhost:3000
 *   PROBE_BASE_URL=https://stock-platform-gamma.vercel.app \
 *     node scripts/probe-picks-fv-drift.mjs                    # remote (needs auth cookie)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HEALTH_DIR = path.join(ROOT, "data", "sws", "health");
const JSONL_PATH = path.join(HEALTH_DIR, "picks-fv-drift-24h.jsonl");
const BASE_URL = process.env.PROBE_BASE_URL || "http://localhost:3000";
const TIMEOUT_MS = 15_000;

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
  let count;
  try {
    count = await fetchPicksMeta();
  } catch (err) {
    // Probe must never crash the host — but we DO want launchd's stderr
    // log to capture so a sustained outage surfaces.
    console.error(`[probe-picks-fv-drift] fetch failed: ${err.message}`);
    process.exit(0);
  }

  const entry = {
    ts: new Date().toISOString(),
    fv_drift_count: count,
    source: "probe",
    base_url: BASE_URL,
  };

  try {
    fs.mkdirSync(HEALTH_DIR, { recursive: true });
    const existingLines = fs.existsSync(JSONL_PATH)
      ? fs.readFileSync(JSONL_PATH, "utf8").split("\n")
      : [];
    const next = trimAndAppend({ now: new Date(), countObj: entry, existingLines });
    fs.writeFileSync(JSONL_PATH, next);
    console.log(`[probe-picks-fv-drift] ${entry.ts} count=${count}`);
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
