import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("experimental forecast overlay is not read by scorers or analyzer engines", () => {
  for (const rel of [
    "services/swsScoringV4.js",
    "services/swsHoldingEngine.js",
    "services/swsPortfolioAggregate.js",
  ]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8");
    assert.equal(source.includes("experimental_forecast_overlay"), false, `${rel} must not read forecast overlay`);
    assert.equal(source.includes("chronos"), false, `${rel} must not read Chronos fields`);
  }
});
