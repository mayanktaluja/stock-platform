import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "check-snapshot-health.mjs");
const NOW = "2026-05-29T12:00:00.000Z";

function writeJson(root, relPath, payload) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(payload, null, 2) + "\n");
}

function seedCritical(root, stamp) {
  writeJson(root, "fundamentals.json", { generatedAt: stamp });
  writeJson(root, "surveillance.json", { fetchedAt: stamp });
  writeJson(root, "fundamentalsHistory.json", { generatedAt: stamp });
  writeJson(root, "data/nse-fo/oi-deltas-latest.json", { fetchedAt: stamp });
  writeJson(root, "data/catalysts/earnings-watch-latest.json", { built_at: stamp });
}

test("check-snapshot-health passes fresh critical fixtures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-health-fresh-"));
  seedCritical(root, "2026-05-29T06:00:00.000Z");

  const out = execFileSync(process.execPath, [
    SCRIPT,
    "--root", root,
    "--now", NOW,
    "--strict",
    "--critical-only",
  ], { encoding: "utf-8" });

  assert.match(out, /all monitored snapshots fresh/);
});

test("check-snapshot-health fails stale critical fixtures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-health-stale-"));
  // 228h old — past every threshold including surveillance's 168h hard-fail band.
  seedCritical(root, "2026-05-20T00:00:00.000Z");

  const res = spawnSync(process.execPath, [
    SCRIPT,
    "--root", root,
    "--now", NOW,
    "--strict",
    "--critical-only",
  ], { encoding: "utf-8" });

  assert.equal(res.status, 1);
  assert.match(res.stdout, /STALE fundamentals:/);
  assert.match(res.stdout, /STALE surveillance:/);
  assert.match(res.stdout, /STALE fundamentals_history:/);
  assert.match(res.stdout, /STALE oi_deltas:/);
  assert.match(res.stdout, /STALE earnings_watch:/);
  assert.match(res.stdout, /staleKeys=fundamentals,surveillance,fundamentals_history,oi_deltas,earnings_watch/);
});

test("check-snapshot-health degrades (not blocks) surveillance inside the 36h-168h band", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-health-degraded-"));
  seedCritical(root, "2026-05-29T06:00:00.000Z");
  // 108h old: past the 36h freshness target, inside the 168h hard-fail band.
  writeJson(root, "surveillance.json", { fetchedAt: "2026-05-25T00:00:00.000Z" });

  const out = execFileSync(process.execPath, [
    SCRIPT,
    "--root", root,
    "--now", NOW,
    "--strict",
    "--critical-only",
  ], { encoding: "utf-8" });

  assert.match(out, /DEGRADED surveillance: 108h \(max 36h, hard-fail 168h/);
  assert.match(out, /degradedKeys=surveillance/);
  assert.doesNotMatch(out, /STALE surveillance:/);
  assert.doesNotMatch(out, /all monitored snapshots fresh/);
});

test("check-snapshot-health hard-fails surveillance past the 168h band", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-health-hardfail-"));
  seedCritical(root, "2026-05-29T06:00:00.000Z");
  // 216h old: past the 168h hard-fail band — blocks like any stale critical.
  writeJson(root, "surveillance.json", { fetchedAt: "2026-05-20T12:00:00.000Z" });

  const res = spawnSync(process.execPath, [
    SCRIPT,
    "--root", root,
    "--now", NOW,
    "--strict",
    "--critical-only",
  ], { encoding: "utf-8" });

  assert.equal(res.status, 1);
  assert.match(res.stdout, /STALE surveillance:/);
  assert.match(res.stdout, /staleKeys=surveillance/);
});

test("check-snapshot-health reports missing critical fixtures as stale", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-health-missing-"));

  const res = spawnSync(process.execPath, [
    SCRIPT,
    "--root", root,
    "--now", NOW,
    "--strict",
    "--critical-only",
  ], { encoding: "utf-8" });

  assert.equal(res.status, 1);
  assert.match(res.stdout, /STALE fundamentals: no data/);
  assert.match(res.stdout, /STALE surveillance: no data/);
  assert.match(res.stdout, /fundamentals.json.generatedAt=null/);
  assert.match(res.stdout, /surveillance.json.fetchedAt=null/);
});

test("check-snapshot-health blocks GSV coverage-gate regressions with candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-health-gsv-"));
  seedCritical(root, "2026-05-29T06:00:00.000Z");
  writeJson(root, "data/sws/picks-latest.json", {
    scanned_at: "2026-05-29T06:00:00.000Z",
    section_audit: {
      growing_sector_value: {
        available: false,
        reason: "sector_mapping_coverage_below_floor",
        base_eligible_count: 275,
        mapped_count: 111,
        selected_count: 26,
        future_growth_candidate_count: 47,
        coverage_ratio: 0.404,
      },
    },
    sections: {
      growing_sector_value: [],
    },
  });

  const res = spawnSync(process.execPath, [
    SCRIPT,
    "--root", root,
    "--now", NOW,
    "--strict",
    "--critical-only",
  ], { encoding: "utf-8" });

  assert.equal(res.status, 1);
  assert.match(res.stdout, /STALE growing_sector_value_gate:/);
  assert.match(res.stdout, /coverage 40% \(111\/275\) withheld 47 candidates/);
  assert.match(res.stdout, /staleKeys=growing_sector_value_gate/);
});

test("check-snapshot-health allows genuinely empty GSV coverage audits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-health-gsv-empty-"));
  seedCritical(root, "2026-05-29T06:00:00.000Z");
  writeJson(root, "data/sws/picks-latest.json", {
    scanned_at: "2026-05-29T06:00:00.000Z",
    section_audit: {
      growing_sector_value: {
        available: false,
        reason: "sector_mapping_coverage_below_floor",
        base_eligible_count: 0,
        mapped_count: 0,
        selected_count: 0,
        future_growth_candidate_count: 0,
        coverage_ratio: 0,
      },
    },
    sections: {
      growing_sector_value: [],
    },
  });

  const out = execFileSync(process.execPath, [
    SCRIPT,
    "--root", root,
    "--now", NOW,
    "--strict",
    "--critical-only",
  ], { encoding: "utf-8" });

  assert.match(out, /OK growing_sector_value_gate:/);
  assert.match(out, /all monitored snapshots fresh/);
});
