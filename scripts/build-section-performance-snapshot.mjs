#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLatestSamplePayloadFromPicks,
  sectionPerformanceSnapshotFreshness,
} from "../services/trackRecord/sectionPerformance.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PICKS_PATH = path.join(ROOT, "data", "sws", "picks-latest.json");
const OUT_PATH = path.join(ROOT, "data", "track-record", "section-performance-latest.json");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeAtomic(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, p);
}

async function main() {
  if (!fs.existsSync(PICKS_PATH)) {
    console.error(`[section-performance] missing ${PICKS_PATH}`);
    process.exit(2);
  }
  const picksData = readJson(PICKS_PATH);
  const payload = await buildLatestSamplePayloadFromPicks(picksData, {
    windows: ["7d", "30d", "3m", "1y", "3y", "5y"],
    cohorts: [3, 5, 10, 20],
  });
  const output = {
    ...payload,
    generatedBy: "scripts/build-section-performance-snapshot.mjs",
    sourceScannedAt: picksData.scanned_at || null,
  };
  const freshness = sectionPerformanceSnapshotFreshness(output, picksData);
  if (!freshness.isFresh) {
    console.error(`[section-performance] refusing to write stale snapshot: ${freshness.reason}`);
    console.error(`[section-performance] sourceScannedAt=${freshness.sourceScannedAt || "null"} picks.scanned_at=${freshness.picksScannedAt || "null"}`);
    process.exit(3);
  }
  writeAtomic(OUT_PATH, { ...output, freshness });
  console.log(`[section-performance] wrote ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch((err) => {
  console.error("[section-performance] failed:", err && err.message);
  process.exit(1);
});
