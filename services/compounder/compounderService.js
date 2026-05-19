// Compounder Lab — read-side service. Loads the latest snapshot and the
// paper-trade ledger from disk so the API can serve them without touching
// the refresh pipeline.

import fs from "node:fs";
import path from "node:path";
import { readLedger } from "./paperTradeLog.js";

const ROOT = process.cwd();
export const COMPOUNDER_LATEST_PATH = path.join(
  ROOT,
  "data",
  "compounder",
  "latest.json",
);

export function loadCompounderLatest() {
  if (!fs.existsSync(COMPOUNDER_LATEST_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(COMPOUNDER_LATEST_PATH, "utf-8"));
  } catch (err) {
    console.warn("[compounderService] read failed:", err.message);
    return null;
  }
}

export function loadCompounderPaperTrades() {
  return readLedger("compounder");
}
