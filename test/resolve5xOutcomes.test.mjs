// Run: node test/resolve5xOutcomes.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildPitSnapshot } from "../services/multibagger/multibaggerPitSnapshot.js";
import {
  loadPitSnapshots,
  main as resolveMain,
  resolve5xOutcomes,
} from "../scripts/resolve-5x-outcomes.mjs";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nresolve5xOutcomes");

function pitSnapshot() {
  return buildPitSnapshot([
    { ticker: "ALPHA", score_0_100: 80, verdict: "5X_CANDIDATE", sector: "EMS", current_price_inr: 100 },
    { ticker: "BETA", score_0_100: 70, verdict: "HIGH_CONVICTION", sector: "Defense", current_price_inr: 200 },
    { ticker: "GAMMA", score_0_100: 60, verdict: "HIGH_CONVICTION", sector: "Renewables", current_price_inr: 300 },
    { ticker: "DELTA", score_0_100: 50, verdict: "HIGH_CONVICTION", sector: "IT", current_price_inr: 400 },
  ], {
    snapshot_iso: "2026-06-17T00:00:00.000Z",
    sources: { scores: { fixture: true } },
  });
}

it("resolves only from explicit outcome input rows", () => {
  const out = resolve5xOutcomes({
    pit_snapshots: [pitSnapshot()],
    outcomes_input: {
      outcomes: [
        { snapshot_id: "2026-06-17T00:00:00.000Z", ticker: "ALPHA", forward_365d_price_inr: 550 },
      ],
    },
    built_at_iso: "2026-06-18T00:00:00.000Z",
  });

  const alpha = out.rows.find((r) => r.ticker === "ALPHA");
  const beta = out.rows.find((r) => r.ticker === "BETA");
  assert.equal(alpha.status, "RESOLVED");
  assert.equal(alpha.realized_multiple, 5.5);
  assert.equal(alpha.forward_return_pct, 450);
  assert.equal(alpha.outcome_match_key, "snapshot_id+ticker");
  assert.equal(beta.status, "UNRESOLVED");
  assert.equal(beta.status_reason, "no_outcome_input");
});

it("retains unresolved, missing-price, and delisted statuses", () => {
  const out = resolve5xOutcomes({
    pit_snapshots: [pitSnapshot()],
    outcomes_input: {
      outcomes: [
        { snapshot_id: "2026-06-17T00:00:00.000Z", ticker: "BETA", status: "UNRESOLVED", reason: "waiting_for_horizon" },
        { snapshot_id: "2026-06-17T00:00:00.000Z", ticker: "GAMMA", status: "MISSING_PRICE" },
        { snapshot_id: "2026-06-17T00:00:00.000Z", ticker: "DELTA", status: "DELISTED", reason: "exchange_delisted" },
      ],
    },
    built_at_iso: "2026-06-18T00:00:00.000Z",
  });

  assert.equal(out.rows.find((r) => r.ticker === "BETA").status, "UNRESOLVED");
  assert.equal(out.rows.find((r) => r.ticker === "BETA").status_reason, "waiting_for_horizon");
  assert.equal(out.rows.find((r) => r.ticker === "GAMMA").status, "MISSING_PRICE");
  assert.equal(out.rows.find((r) => r.ticker === "DELTA").status, "DELISTED");
  assert.equal(out.status_counts.UNRESOLVED, 2); // BETA explicit + ALPHA no input
  assert.equal(out.status_counts.MISSING_PRICE, 1);
  assert.equal(out.status_counts.DELISTED, 1);
});

it("supports date-scoped outcome inputs", () => {
  const out = resolve5xOutcomes({
    pit_snapshots: [pitSnapshot()],
    outcomes_input: {
      rows: [
        { snapshot_date_iso: "2026-06-17", ticker: "ALPHA", outcome_price_inr: 250 },
      ],
    },
  });

  const alpha = out.rows.find((r) => r.ticker === "ALPHA");
  assert.equal(alpha.status, "RESOLVED");
  assert.equal(alpha.outcome_match_key, "snapshot_date+ticker");
  assert.equal(alpha.realized_multiple, 2.5);
});

it("CLI reads PIT snapshots plus outcomes input and writes resolved output", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-5x-"));
  const snapshotsDir = path.join(tmp, "pit");
  fs.mkdirSync(snapshotsDir);
  fs.writeFileSync(path.join(snapshotsDir, "2026-06-17.json"), JSON.stringify(pitSnapshot(), null, 2));
  const input = path.join(tmp, "outcomes-input.json");
  fs.writeFileSync(input, JSON.stringify({
    schema_version: "multibagger-outcomes-input-v1",
    outcomes: [{ snapshot_id: "2026-06-17T00:00:00.000Z", ticker: "ALPHA", forward_365d_price_inr: 500 }],
  }, null, 2));
  const output = path.join(tmp, "out.json");

  const written = resolveMain(["--snapshots-dir", snapshotsDir, "--input", input, "--output", output]);
  const disk = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(loadPitSnapshots(snapshotsDir).length, 1);
  assert.equal(written.resolved_count, 1);
  assert.equal(disk.rows.find((r) => r.ticker === "ALPHA").realized_multiple, 5);
});

it("resolver source does not read current picks or deep briefs", () => {
  const script = fs.readFileSync(new URL("../scripts/resolve-5x-outcomes.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(script, /picks-latest|data\/sws\/deep|deep brief/i);
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
