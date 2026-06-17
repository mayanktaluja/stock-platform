#!/usr/bin/env node
/**
 * Snapshot freshness gate for the local data-publish pipeline.
 *
 * Mirrors the timestamp fields and thresholds used by /api/health/snapshots,
 * but runs without starting the Express server. The nightly uses
 * --strict --critical-only before publishing so fresh SWS cards cannot ship
 * while fundamentals, surveillance, F&O, or Earnings Watch inputs remain stale.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..");

const SNAPSHOTS = [
  { key: "fundamentals", label: "Fundamentals", relPath: "fundamentals.json", field: "generatedAt", maxAgeHours: 48, critical: true },
  { key: "surveillance", label: "Surveillance (ASM/GSM)", relPath: "surveillance.json", field: "fetchedAt", maxAgeHours: 36, critical: true },
  { key: "governance", label: "Governance (shareholding)", relPath: "governance.json", field: "fetchedAt", maxAgeHours: 2400, critical: false },
  { key: "picks_latest", label: "SWS picks", relPath: "data/sws/picks-latest.json", field: "scanned_at", maxAgeHours: 48, critical: false },
  { key: "macro_regime", label: "Macro regime", relPath: "data/macroRegime.json", field: "generatedAt", maxAgeHours: 14, critical: false },
  { key: "fundamentals_history", label: "Fundamentals history", relPath: "fundamentalsHistory.json", field: "generatedAt", maxAgeHours: 72, critical: true },
  { key: "macro_calendar", label: "Macro calendar", relPath: "data/macroCalendar.json", field: "_updated", maxAgeHours: 720, critical: false },
  { key: "events_latest", label: "Corporate events", relPath: "data/catalysts/events-latest.json", field: "fetched_at", maxAgeHours: 48, critical: false },
  { key: "oi_deltas", label: "F&O OI deltas", relPath: "data/nse-fo/oi-deltas-latest.json", field: "fetchedAt", maxAgeHours: 48, critical: true },
  { key: "earnings_watch", label: "Earnings watch", relPath: "data/catalysts/earnings-watch-latest.json", field: "built_at", maxAgeHours: 48, critical: true },
  { key: "universe", label: "SWS universe", relPath: "data/sws/universe-meta.json", field: "generatedAt", maxAgeHours: 336, critical: false },
];

function parseArgs(argv) {
  const out = {
    root: process.env.SWS_SNAPSHOT_HEALTH_ROOT || DEFAULT_ROOT,
    strict: false,
    criticalOnly: false,
    json: false,
    now: Date.now(),
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--strict") out.strict = true;
    else if (arg === "--critical-only") out.criticalOnly = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--root") out.root = argv[++i];
    else if (arg.startsWith("--root=")) out.root = arg.slice("--root=".length);
    else if (arg === "--now") out.now = Date.parse(argv[++i]);
    else if (arg.startsWith("--now=")) out.now = Date.parse(arg.slice("--now=".length));
    else {
      console.error(`[snapshot-health] unknown arg: ${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.now)) {
    console.error("[snapshot-health] --now must be an ISO timestamp");
    process.exit(2);
  }
  out.root = path.resolve(out.root);
  return out;
}

function readTimestamp(root, spec) {
  const abs = path.join(root, spec.relPath);
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, "utf-8"));
    return parsed?.[spec.field] ?? null;
  } catch {
    return null;
  }
}

function ageHours(iso, nowMs) {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return +((nowMs - ts) / 3_600_000).toFixed(1);
}

function assess(root, nowMs, criticalOnly) {
  return SNAPSHOTS
    .filter((spec) => !criticalOnly || spec.critical)
    .map((spec) => {
      const generatedAt = readTimestamp(root, spec);
      const age = ageHours(generatedAt, nowMs);
      const stale = age == null || age > spec.maxAgeHours;
      return {
        key: spec.key,
        label: spec.label,
        relPath: spec.relPath,
        field: spec.field,
        generatedAt,
        age_hours: age,
        max_age_hours: spec.maxAgeHours,
        critical: spec.critical,
        stale,
      };
    });
}

const args = parseArgs(process.argv);
const rows = assess(args.root, args.now, args.criticalOnly);
const stale = rows.filter((row) => row.stale);

if (args.json) {
  console.log(JSON.stringify({
    ok: stale.length === 0,
    checkedAt: new Date(args.now).toISOString(),
    root: args.root,
    criticalOnly: args.criticalOnly,
    staleKeys: stale.map((row) => row.key),
    snapshots: Object.fromEntries(rows.map((row) => [row.key, row])),
  }, null, 2));
} else {
  console.log(`[snapshot-health] root=${args.root}`);
  console.log(`[snapshot-health] checkedAt=${new Date(args.now).toISOString()}`);
  for (const row of rows) {
    const age = row.age_hours == null ? "no data" : `${row.age_hours}h`;
    const status = row.stale ? "STALE" : "OK";
    console.log(
      `[snapshot-health] ${status} ${row.key}: ${age} ` +
      `(max ${row.max_age_hours}h, ${row.relPath}.${row.field}=${row.generatedAt || "null"})`,
    );
  }
  if (stale.length > 0) {
    console.log(`[snapshot-health] staleKeys=${stale.map((row) => row.key).join(",")}`);
  } else {
    console.log("[snapshot-health] all monitored snapshots fresh");
  }
}

if (args.strict && stale.length > 0) process.exit(1);
