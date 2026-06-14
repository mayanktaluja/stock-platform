#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfirmedInputDiff, buildInputSignatures } from "../services/swsInputSnapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const alertsDir = path.join(ROOT, "data", "sws", "alerts");
const signaturesPath = path.join(alertsDir, "input-signatures-latest.json");
const changesPath = path.join(alertsDir, "fundamental-changes-latest.json");
const confirmationStatePath = path.join(alertsDir, "input-alert-confirmation-state.json");

function parseArgs(argv) {
  const out = { runId: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--run-id") out.runId = argv[++i] || null;
    else if (arg.startsWith("--run-id=")) out.runId = arg.slice("--run-id=".length) || null;
  }
  return out;
}

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

const args = parseArgs(process.argv);
const generatedAt = new Date().toISOString();
const previous = readJson(signaturesPath);
const previousState = readJson(confirmationStatePath);
const current = buildInputSignatures({
  scoredUniversePath: path.join(ROOT, "data", "sws", "sws-scored-universe.json"),
  deepDir: path.join(ROOT, "data", "sws", "deep"),
  lastRefreshPath: path.join(ROOT, "data", "sws", "last-refresh.json"),
  generatedAt,
  runId: args.runId,
});
const { diff, state } = buildConfirmedInputDiff({
  previousSnapshot: previous,
  currentSnapshot: current,
  previousState,
  generatedAt,
});

writeJsonAtomic(changesPath, diff);
writeJsonAtomic(confirmationStatePath, state);
writeJsonAtomic(signaturesPath, current);

console.log(
  `input diff built: signatures=${current.signature_count} confirmed_changes=${diff.change_count} pending=${diff.pending_count || 0} raw_changes=${diff.raw_change_count || 0} run_id=${current.run_id} previous=${diff.previous_run_id || "none"}`,
);
