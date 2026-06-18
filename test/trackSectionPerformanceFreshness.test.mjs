/**
 * Section-performance snapshot freshness contract.
 *
 * Run with: node test/trackSectionPerformanceFreshness.test.mjs
 */

import assert from "node:assert/strict";

import { sectionPerformanceSnapshotFreshness } from "../services/trackRecord/sectionPerformance.js";

const scannedAt = "2026-06-18T00:59:44.923Z";

{
  const result = sectionPerformanceSnapshotFreshness(
    { sourceScannedAt: scannedAt, generatedAt: "2026-06-18T01:02:00.000Z" },
    { scanned_at: scannedAt },
  );
  assert.equal(result.isFresh, true);
  assert.equal(result.status, "fresh");
  assert.equal(result.reason, "source_scanned_at_match");
}

{
  const result = sectionPerformanceSnapshotFreshness(
    { sourceScannedAt: "2026-06-10T00:30:55.809Z", generatedAt: "2026-06-10T01:00:00.000Z" },
    { scanned_at: scannedAt },
  );
  assert.equal(result.isFresh, false);
  assert.equal(result.status, "stale");
  assert.equal(result.reason, "source_scanned_at_mismatch");
}

{
  const result = sectionPerformanceSnapshotFreshness(
    { generatedAt: "2026-06-18T01:02:00.000Z" },
    { scanned_at: scannedAt },
  );
  assert.equal(result.isFresh, false);
  assert.equal(result.reason, "missing_source_scanned_at");
}

{
  const result = sectionPerformanceSnapshotFreshness(
    { sourceScannedAt: scannedAt, generatedAt: "2026-06-18T00:00:00.000Z" },
    { scanned_at: scannedAt },
  );
  assert.equal(result.isFresh, false);
  assert.equal(result.reason, "generated_before_source");
}

console.log("section-performance snapshot freshness contract ok");
