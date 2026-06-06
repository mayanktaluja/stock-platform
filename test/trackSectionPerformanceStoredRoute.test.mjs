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
assert.ok(storedIdx < importIdx, "stored snapshot must be checked before MFAPI-backed compute module");

console.log("track section-performance stored snapshot is the read fast path");
