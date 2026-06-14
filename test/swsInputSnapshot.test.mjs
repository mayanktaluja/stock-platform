/**
 * Run with: node test/swsInputSnapshot.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildConfirmedInputDiff,
  buildInputSignatures,
  diffInputSignatures,
  isSwsInputArtifactEmailEligible,
  stableHash,
} from "../services/swsInputSnapshot.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sws-input-snapshot-"));
const deepDir = path.join(root, "deep");
fs.mkdirSync(deepDir, { recursive: true });
const scoredPath = path.join(root, "sws-scored-universe.json");
const lastRefreshPath = path.join(root, "last-refresh.json");

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeFixture({ score = 55, upside = 20, total = 12, rewards = ["A", "B"], price = 100, fairValue = 120 } = {}) {
  writeJson(scoredPath, {
    generated_at: "2026-06-08T00:00:00.000Z",
    scored_count: 1,
    stocks: [{
      ticker: "ABC",
      name: "ABC Ltd",
      sector: "Industrials",
      v4_score_100: score,
      v4_verdict: score >= 59 ? "TOP_PICK" : "STRONG",
      snowflake_total: total,
      fair_value_inr: fairValue,
      upside_pct: upside,
      current_price_inr: price,
      fair_value_confidence: "HIGH",
      fair_value_source: "sws_raw_fv",
      fv_reconcile_reason: "ok",
    }],
  });
  writeJson(path.join(deepDir, "ABC.json"), {
    ticker: "ABC",
    overview: {
      snowflake: { value: 4, future: 2, past: 3, health: 4, dividend: 1 },
      snowflake_total: total,
      snowflake_data_quality: { insufficient: false, insufficient_count: 0, checked_count: 30, affected_pillars: [] },
      fair_value_inr: fairValue,
      upside_pct: upside,
      rewards,
      risks: ["Risk A"],
    },
    fiscal: { latest_year: 2026, latest_revenue: 1000 },
  });
  writeJson(lastRefreshPath, { finished_at: "2026-06-08T00:01:00.000Z" });
}

try {
  writeFixture();
  const first = buildInputSignatures({ scoredUniversePath: scoredPath, deepDir, lastRefreshPath, generatedAt: "2026-06-08T00:02:00.000Z" });
  assert.equal(first.signature_count, 1);
  assert.equal(first.run_id, "2026-06-08T00:01:00.000Z", "run_id defaults to last-refresh finished_at");
  assert.equal(diffInputSignatures(null, first).change_count, 0, "first run with no prior snapshot should not alert");

  const explicitRun = buildInputSignatures({
    scoredUniversePath: scoredPath,
    deepDir,
    lastRefreshPath,
    generatedAt: "2026-06-08T00:02:30.000Z",
    runId: "2026-06-08T00:00:00.000Z",
  });
  assert.equal(
    explicitRun.run_id,
    "2026-06-08T00:00:00.000Z",
    "explicit run_id wins when input-diff is built before last-refresh.json is stamped",
  );

  writeFixture({ score: 70, upside: 60, price: 75, rewards: ["B", "A"] });
  const priceOnly = buildInputSignatures({ scoredUniversePath: scoredPath, deepDir, lastRefreshPath, generatedAt: "2026-06-08T00:03:00.000Z" });
  assert.equal(
    diffInputSignatures(first, priceOnly).change_count,
    0,
    "price/momentum score/upside and array ordering alone must not alert",
  );

  writeFixture({ fairValue: 121.2 });
  const tinyFvMove = buildInputSignatures({ scoredUniversePath: scoredPath, deepDir, lastRefreshPath, generatedAt: "2026-06-08T00:03:30.000Z" });
  const tinyFvDiff = diffInputSignatures(first, tinyFvMove);
  assert.equal(tinyFvDiff.change_count, 1, "raw snapshot diff remains exhaustive for sub-2% FV moves");
  assert.ok(
    tinyFvDiff.changes[0].changes.some((c) => c.field === "fair_value.fair_value_inr" && c.previous === 120 && c.current === 121.2),
    "raw diff records the exact FV input movement before portfolio alert filtering",
  );

  writeFixture({ total: 16, score: 66, upside: 60 });
  const fundamental = buildInputSignatures({ scoredUniversePath: scoredPath, deepDir, lastRefreshPath, generatedAt: "2026-06-08T00:04:00.000Z" });
  const diff = diffInputSignatures(first, fundamental);
  assert.equal(diff.change_count, 1);
  assert.ok(diff.changes[0].changes.some((c) => c.field === "snowflake.total"));
  assert.ok(diff.changes[0].changes.some((c) => c.field === "v4_score"), "derived score diagnostic is attached when stable inputs changed");

  assert.equal(stableHash(["A", "B"]), stableHash(["B", "A"]), "array order is stable-hashed");

  const seeded = buildConfirmedInputDiff({
    previousSnapshot: null,
    currentSnapshot: first,
    previousState: null,
    generatedAt: "2026-06-08T00:05:00.000Z",
  });
  assert.equal(seeded.diff.schema_version, 2);
  assert.equal(seeded.diff.confirmation_policy, "two_consecutive_full_runs");
  assert.equal(seeded.diff.state_seeded, true);
  assert.equal(seeded.diff.change_count, 0, "first v2 run seeds state without alerting");
  assert.equal(isSwsInputArtifactEmailEligible(seeded.diff), true);
  assert.equal(isSwsInputArtifactEmailEligible(diffInputSignatures(null, first)), false, "legacy v1 artifacts are not email-eligible");

  writeFixture({ fairValue: 150, price: 100 });
  const bFirst = buildInputSignatures({
    scoredUniversePath: scoredPath,
    deepDir,
    lastRefreshPath,
    generatedAt: "2026-06-08T00:06:00.000Z",
    runId: "run-b-1",
  });
  const pending = buildConfirmedInputDiff({
    previousSnapshot: first,
    currentSnapshot: bFirst,
    previousState: seeded.state,
    generatedAt: "2026-06-08T00:06:30.000Z",
  });
  assert.equal(pending.diff.change_count, 0, "A -> B first observation is pending");
  assert.ok(pending.diff.pending_count >= 1);

  const bSecond = buildInputSignatures({
    scoredUniversePath: scoredPath,
    deepDir,
    lastRefreshPath,
    generatedAt: "2026-06-08T00:07:00.000Z",
    runId: "run-b-2",
  });
  const confirmed = buildConfirmedInputDiff({
    previousSnapshot: bFirst,
    currentSnapshot: bSecond,
    previousState: pending.state,
    generatedAt: "2026-06-08T00:07:30.000Z",
  });
  assert.equal(confirmed.diff.change_count, 1, "B repeated on next full run confirms alert");
  assert.ok(
    confirmed.diff.changes[0].changes.some((c) => c.field === "fair_value.fair_value_inr" && c.previous === 120 && c.current === 150),
  );

  const flapSeed = buildConfirmedInputDiff({
    previousSnapshot: null,
    currentSnapshot: first,
    previousState: null,
    generatedAt: "2026-06-08T00:08:00.000Z",
  });
  const flapPending = buildConfirmedInputDiff({
    previousSnapshot: first,
    currentSnapshot: bFirst,
    previousState: flapSeed.state,
    generatedAt: "2026-06-08T00:08:30.000Z",
  });
  const backToA = buildConfirmedInputDiff({
    previousSnapshot: bFirst,
    currentSnapshot: first,
    previousState: flapPending.state,
    generatedAt: "2026-06-08T00:09:00.000Z",
  });
  assert.equal(backToA.diff.change_count, 0, "B -> A clears pending without alert");
  const bAgain = buildConfirmedInputDiff({
    previousSnapshot: first,
    currentSnapshot: bFirst,
    previousState: backToA.state,
    generatedAt: "2026-06-08T00:09:30.000Z",
  });
  assert.equal(bAgain.diff.change_count, 0, "B after a one-run reversal is pending again, not a repeat alert");

  console.log("swsInputSnapshot tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
