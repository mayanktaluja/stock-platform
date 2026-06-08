#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInputSignatures, diffInputSignatures } from "../services/swsInputSnapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const alertsDir = path.join(ROOT, "data", "sws", "alerts");
const signaturesPath = path.join(alertsDir, "input-signatures-latest.json");
const changesPath = path.join(alertsDir, "fundamental-changes-latest.json");

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`${filePath} is not valid JSON: ${err.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value) + "\n", "utf-8");
  renameSync(tmp, filePath);
}

const generatedAt = new Date().toISOString();
const previous = readJson(signaturesPath);
const current = buildInputSignatures({
  scoredUniversePath: path.join(ROOT, "data", "sws", "sws-scored-universe.json"),
  deepDir: path.join(ROOT, "data", "sws", "deep"),
  lastRefreshPath: path.join(ROOT, "data", "sws", "last-refresh.json"),
  generatedAt,
});
const diff = diffInputSignatures(previous, current, generatedAt);

writeJsonAtomic(changesPath, diff);
writeJsonAtomic(signaturesPath, current);

console.log(
  `input diff built: signatures=${current.signature_count} changes=${diff.change_count} run_id=${current.run_id} previous=${diff.previous_run_id || "none"}`,
);
