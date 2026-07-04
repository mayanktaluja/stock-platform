#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSwsDiscoveryFeed } from "../services/swsDiscoveryFeed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data", "sws");
const DEEP_DIR = path.join(DATA_DIR, "deep");

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] || fallback : fallback;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function canonicalTicker(value) {
  return String(value || "").trim().replace(/\.(NS|BO|BSE|NSE)$/i, "").toUpperCase();
}

function loadDeepForUniverse(stocks) {
  const deepByTicker = {};
  for (const row of stocks) {
    const ticker = canonicalTicker(row?.ticker || row?.symbol);
    if (!ticker) continue;
    const deep = readJson(path.join(DEEP_DIR, `${ticker}.json`), null);
    if (deep) deepByTicker[ticker] = deep;
  }
  return deepByTicker;
}

const scoredUniverse = readJson(path.join(DATA_DIR, "sws-scored-universe.json"));
if (!scoredUniverse) {
  console.error("[discovery-feed] missing data/sws/sws-scored-universe.json");
  process.exit(1);
}

const stocks = Array.isArray(scoredUniverse) ? scoredUniverse : scoredUniverse.stocks || [];
const picksLatest = readJson(path.join(DATA_DIR, "picks-latest.json"), null);
const keepCuratedUpgradeWatch = process.argv.includes("--keep-curated-upgrades");
const feed = buildSwsDiscoveryFeed({
  scoredUniverse,
  picksLatest,
  deepByTicker: loadDeepForUniverse(stocks),
  inputChanges: readJson(path.join(DATA_DIR, "alerts", "fundamental-changes-latest.json"), null),
  lastRefresh: readJson(path.join(DATA_DIR, "last-refresh.json"), null),
  generatedAt: new Date().toISOString(),
  maxItems: Number(argValue("--max-items", "250")) || 250,
  keepCuratedUpgradeWatch,
});

// Curated dedup depends on picks-latest.json membership. If picks is absent or
// carries no sections, the membership map is empty and the dedup silently
// no-ops — curated names would leak back into the review queue exactly when
// picks is stale. Flag it loudly and on the artifact so it is visible rather
// than a silent correctness hole.
const picksSectionCount = picksLatest && picksLatest.sections ? Object.keys(picksLatest.sections).length : 0;
feed.dedup_degraded = picksSectionCount === 0 || feed.counts.membership_tickers === 0;
if (feed.dedup_degraded) {
  console.warn(`[discovery-feed] WARNING: curated dedup degraded — picks-latest.json ${picksLatest ? "has no sections" : "missing"} (membership_tickers=${feed.counts.membership_tickers}). Curated names may leak into the radar.`);
}

const runId = argValue("--run-id", null);
if (runId) feed.run_id = runId;

const out = path.join(DATA_DIR, "discovery-feed-latest.json");
atomicWriteJson(out, feed);
console.log(`[discovery-feed] wrote ${path.relative(ROOT, out)} items=${feed.counts.items} future=${feed.counts.future_breakout} off_section=${feed.counts.off_section_high_future} momentum_news=${feed.counts.momentum_news_confirmed} upgrade=${feed.counts.upgrade_watch}`);
