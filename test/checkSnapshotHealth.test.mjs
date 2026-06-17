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
  seedCritical(root, "2026-05-25T00:00:00.000Z");

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
