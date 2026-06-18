import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "server.js"), "utf-8");

const readStart = source.indexOf("async function readSectionPerformanceSafe");
assert.notEqual(readStart, -1, "readSectionPerformanceSafe must exist");
const readEnd = source.indexOf("async function snapshotSectionPerformanceSafe", readStart);
assert.ok(readEnd > readStart, "readSectionPerformanceSafe body must be discoverable");
const body = source.slice(readStart, readEnd);

const storedIdx = body.indexOf("readStoredSectionPerformancePayload");
const importIdx = body.indexOf("loadSectionPerformanceModule");
assert.ok(storedIdx >= 0, "section-performance read must check stored snapshot");
assert.ok(importIdx >= 0, "section-performance read should retain compute fallback");
assert.ok(storedIdx > importIdx, "stored snapshot must be checked with the loaded freshness validator");
assert.ok(body.includes("stored?.freshness?.isFresh"), "stored snapshot must be freshness-gated before the fast path");
assert.ok(body.includes("buildLatestSamplePayloadFromPicks"), "stale stored snapshot must rebuild directly from current picks");
assert.ok(body.includes("transient: true"), "stale stored snapshot fallback must be marked transient");
assert.ok(body.includes("fromStoredSnapshot: false"), "stale stored snapshot fallback must not pretend to be stored");
assert.ok(body.includes("transient_fallback"), "stale stored snapshot fallback must expose degraded metadata");
assert.ok(body.includes("stored_snapshot_missing"), "missing stored snapshot must also use transient current-picks fallback");

const routeStart = source.indexOf('app.get("/api/track/section-performance"');
assert.notEqual(routeStart, -1, "section-performance route must exist");
const routeEnd = source.indexOf('app.get("/api/track/sections"', routeStart);
assert.ok(routeEnd > routeStart, "section-performance route body must be discoverable");
const routeBody = source.slice(routeStart, routeEnd);
assert.ok(routeBody.includes("picksScannedAt"), "route cache key must include current picks scanned_at");
assert.ok(routeBody.includes("if (!response.transient) trackCache.set"), "transient fallback responses must not be cached");

console.log("track section-performance stored snapshot is freshness-gated");
