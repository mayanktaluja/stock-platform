// Earnings Edge — read-side service. Loads the latest snapshot + paper-trade
// ledger from disk for the API + frontend.

import fs from "node:fs";
import path from "node:path";
import { readLedger } from "../compounder/paperTradeLog.js";

const ROOT = process.cwd();
export const EDGE_LATEST_PATH = path.join(ROOT, "data", "earnings-edge", "latest.json");

export function loadEdgeLatest() {
  if (!fs.existsSync(EDGE_LATEST_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(EDGE_LATEST_PATH, "utf-8"));
  } catch (err) {
    console.warn("[edgeService] read failed:", err.message);
    return null;
  }
}

export function loadEdgePaperTrades() {
  return readLedger("earnings_edge");
}
