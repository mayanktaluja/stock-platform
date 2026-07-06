import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OVERRIDE_ROOT = `.e2e/fixture-isolation-${process.pid}`;
const OVERRIDE_ABS = path.join(REPO_ROOT, OVERRIDE_ROOT);

const PRODUCTION_FILES = [
  "data/sws-us/picks-latest.json",
  "data/sws-us/sws-scored-universe.json",
  "data/sws-us/v3-universe-stats.json",
  "data/sws-us/v4-universe-stats.json",
  "data/sws-us/fundamentals-latest.json",
  "data/sws-us/deep-us.tar.gz",
];

function hashFile(relPath) {
  const filePath = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(filePath)) return null;
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function runFixture(args) {
  execFileSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, SWS_REPO_ROOT_OVERRIDE: OVERRIDE_ROOT },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("US e2e market fixtures write only to SWS_REPO_ROOT_OVERRIDE", () => {
  fs.rmSync(OVERRIDE_ABS, { recursive: true, force: true });
  const before = new Map(PRODUCTION_FILES.map((relPath) => [relPath, hashFile(relPath)]));

  try {
    runFixture(["test/e2e/helpers/build-us-picks-fixture.mjs"]);

    for (const relPath of PRODUCTION_FILES) {
      assert.equal(hashFile(relPath), before.get(relPath), `${relPath} changed while building e2e fixtures`);
    }

    for (const relPath of [
      "data/sws-us/picks-latest.json",
      "data/sws-us/deep-us.tar.gz",
    ]) {
      assert.ok(fs.existsSync(path.join(OVERRIDE_ABS, relPath)), `missing isolated fixture output ${relPath}`);
    }
  } finally {
    fs.rmSync(OVERRIDE_ABS, { recursive: true, force: true });
  }
});
