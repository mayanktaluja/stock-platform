import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("SWS card and modal UI do not fall back from V4 to legacy score fields", () => {
  const app = read("gated/app.js");
  const forbidden = [
    /s\.v4_score_100\s*!=\s*null\s*\?\s*s\.v4_score_100\s*:\s*\(?s\.v2_score/,
    /s\.v4_score_100\s*!=\s*null\s*\?\s*s\.v4_score_100\s*:\s*s\.score/,
    /card_\.v4_score_100\s*:\s*card_\.score/,
    /modalUseV4\s*\?\s*card_\.v4_score_100\s*:\s*card_\.score/,
  ];
  for (const re of forbidden) assert.doesNotMatch(app, re);
  assert.match(app, /function swsV4ScoreValue/);
});

test("user-facing SWS methodology/audit text names V4, not V2 or V3", () => {
  const visibleFiles = [
    "gated/methodology.html",
    "services/swsReasonNarrator.js",
    "services/swsAuditTrail.js",
  ];
  for (const rel of visibleFiles) {
    const src = read(rel);
    assert.doesNotMatch(src, /SWS\s+v3\s+score/i, rel);
    assert.doesNotMatch(src, /SWS['’]s\s+V3\s+framework/i, rel);
    assert.doesNotMatch(src, /V3\s+100-pt\s+breakdown/i, rel);
  }
});

test("first-party generated sections expose top_ranked_30_v4 before legacy alias", () => {
  const files = [
    "services/swsScoring.js",
    "scripts/sws-scoring.mjs",
    "scripts/sws-scoring-us.mjs",
  ];
  for (const rel of files) {
    const src = read(rel);
    const v4Idx = src.lastIndexOf("top_ranked_30_v4");
    const v3Idx = src.lastIndexOf("top_ranked_30_v3");
    assert.ok(v4Idx >= 0, `${rel} must emit top_ranked_30_v4`);
    assert.ok(v3Idx >= 0, `${rel} should keep temporary top_ranked_30_v3 alias`);
    assert.ok(v4Idx < v3Idx, `${rel} should emit/read V4 before legacy alias`);
  }
});
