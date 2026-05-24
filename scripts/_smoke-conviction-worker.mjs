// Worker for smoke-sws-conviction.mjs — runs scoreHolding over the sample
// portfolio in whatever RECOMMENDER_VERSION is set in the environment, then
// emits one JSON blob to stdout. The parent script spawns one of these per
// mode so the recommender-mode module reads the env fresh.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreHolding } from "../services/swsHoldingEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTFOLIO_PATH = path.resolve(__dirname, "..", "portfolio.json");
const portfolio = JSON.parse(fs.readFileSync(PORTFOLIO_PATH, "utf-8"));

const out = [];
for (const h of portfolio.stocks || []) {
  const r = scoreHolding({
    symbol: h.symbol, name: h.name, sector: h.sector,
    quantity: h.quantity, avgPrice: h.avgPrice,
    positionWeight: 0, sectorWeight: 0, pnlPercent: 0,
  }, { sectorWeights: {} });
  out.push({
    symbol: r.sws?.ticker || h.symbol,
    action: r.action,
    v3: r.sws?.v4_score,
    v2rec: r.sws?.v2_recommendation,
  });
}
process.stdout.write(JSON.stringify(out));
