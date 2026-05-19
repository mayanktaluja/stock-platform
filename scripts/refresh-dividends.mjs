#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAllUpcomingDividends } from "../services/dividends/swsDividendsExtractor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEEP_DIR = path.join(ROOT, "data", "sws", "deep");
const OUT_PATH = path.join(ROOT, "data", "catalysts", "dividends-upcoming.json");

function todayIstIso() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

function writeAtomic(target, payload) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, target);
}

async function main() {
  const today = todayIstIso();
  console.log(`[dividends] scanning ${DEEP_DIR} for upcoming dividends (today=${today})...`);

  if (!fs.existsSync(DEEP_DIR)) {
    console.error(`[dividends] deep dir missing: ${DEEP_DIR}`);
    process.exitCode = 75;
    return;
  }

  const dividends = extractAllUpcomingDividends({ deepDir: DEEP_DIR, todayIso: today });
  console.log(`[dividends] extracted ${dividends.length} upcoming dividends`);

  if (dividends.length === 0) {
    console.warn(`[dividends] fetched 0 dividends — possible SWS data staleness; preserving prior cache if present`);
  }

  const payload = {
    schema_version: "dividends-upcoming-v1",
    built_at: new Date().toISOString(),
    today_iso: today,
    dividend_count: dividends.length,
    dividends,
  };

  writeAtomic(OUT_PATH, payload);
  console.log(`[dividends] wrote ${OUT_PATH}`);
  process.exitCode = 0;
}

try {
  await main();
} catch (err) {
  console.error(`[dividends] FATAL:`, err.stack || err.message);
  process.exitCode = 1;
}
