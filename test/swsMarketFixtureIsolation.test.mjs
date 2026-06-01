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
  "data/sws-us/fundamentals-latest.json",
  "data/sws-us/deep-us.tar.gz",
  "data/sws-kr/picks-latest.json",
  "data/sws-kr/sws-scored-universe.json",
  "data/sws-kr/v3-universe-stats.json",
  "data/sws-kr/fundamentals-latest.json",
  "data/sws-kr/deep-kr.tar.gz",
  "data/sws-tw/picks-latest.json",
  "data/sws-tw/sws-scored-universe.json",
  "data/sws-tw/v3-universe-stats.json",
  "data/sws-tw/fundamentals-latest.json",
  "data/sws-tw/deep-tw.tar.gz",
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

test("US/KR/TW e2e market fixtures write only to SWS_REPO_ROOT_OVERRIDE", () => {
  fs.rmSync(OVERRIDE_ABS, { recursive: true, force: true });
  const before = new Map(PRODUCTION_FILES.map((relPath) => [relPath, hashFile(relPath)]));

  try {
    runFixture(["test/e2e/helpers/build-us-picks-fixture.mjs"]);
    runFixture(["test/e2e/helpers/build-region-picks-fixture.mjs", "--region", "kr"]);
    runFixture(["test/e2e/helpers/build-region-picks-fixture.mjs", "--region", "tw"]);

    for (const relPath of PRODUCTION_FILES) {
      assert.equal(hashFile(relPath), before.get(relPath), `${relPath} changed while building e2e fixtures`);
    }

    for (const relPath of [
      "data/sws-us/picks-latest.json",
      "data/sws-us/deep-us.tar.gz",
      "data/sws-kr/picks-latest.json",
      "data/sws-kr/deep-kr.tar.gz",
      "data/sws-tw/picks-latest.json",
      "data/sws-tw/deep-tw.tar.gz",
    ]) {
      assert.ok(fs.existsSync(path.join(OVERRIDE_ABS, relPath)), `missing isolated fixture output ${relPath}`);
    }
  } finally {
    fs.rmSync(OVERRIDE_ABS, { recursive: true, force: true });
  }
});
