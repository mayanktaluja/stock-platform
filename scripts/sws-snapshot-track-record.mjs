// Snapshot the current India SWS picks into the Track Record ledger.
//
// This runs as its own deterministic pipeline step after scoring/narration/
// section-status stamping. It must not depend on Anthropic narration being
// enabled, because Track Record persistence is part of the data pipeline.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotAndCloseSwsPicks } from "../paperTrades.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PICKS_PATH = path.join(ROOT, "data", "sws", "picks-latest.json");

function readPicks() {
  if (!fs.existsSync(PICKS_PATH)) {
    throw new Error("data/sws/picks-latest.json not found; run SWS scoring first");
  }
  return JSON.parse(fs.readFileSync(PICKS_PATH, "utf-8"));
}

async function main() {
  const picksData = readPicks();
  const result = await snapshotAndCloseSwsPicks(picksData, {
    snapshotAt: picksData.scanned_at,
    rationale: "Auto-snapshot from sws-refresh-api pipeline",
  });
  const ws = result.snapshot || {};
  const wc = result.close || {};
  console.log(`Track-record snapshot: wrote=${ws.written || 0} skipped=${ws.skipped || 0}; closed=${wc.closed || 0} positions`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
