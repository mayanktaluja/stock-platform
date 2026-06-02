#!/usr/bin/env node
/**
 * Summarise SWS market modal-enrichment quality from the deployable deep tarball.
 *
 * US/KR/TW production modals read data/sws-<market>/deep-<market>.tar.gz, so
 * the refresh gate must inspect that artifact instead of trusting loose deep/.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SWS_REPO_ROOT_OVERRIDE
  ? path.resolve(process.cwd(), process.env.SWS_REPO_ROOT_OVERRIDE)
  : path.resolve(__dirname, "..");

export const MARKET_CANARIES = {
  us: ["ZVRA", "FSM", "TOYO", "IMPP"],
  kr: ["000660.KS", "071970.KS", "482630.KQ"],
  tw: ["2451.TW", "6669.TW", "3189.TW"],
};

function parseArgs(argv = process.argv.slice(2)) {
  const out = { market: null, pretty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--market") out.market = argv[++i];
    else if (a.startsWith("--market=")) out.market = a.slice("--market=".length);
    else if (a === "--pretty") out.pretty = true;
  }
  if (!out.market || !MARKET_CANARIES[out.market]) {
    throw new Error("usage: sws-market-quality-summary.mjs --market <us|kr|tw> [--pretty]");
  }
  return out;
}

function readTarString(buf, start, len) {
  const raw = buf.subarray(start, start + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul >= 0 ? nul : raw.length).toString("utf8").trim();
}

function readJsonSafe(fp, fallback = null) {
  try {
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return fallback;
  }
}

function listDeepFromTarball(tarballPath) {
  const byTicker = new Map();
  if (!fs.existsSync(tarballPath)) return { source: "missing_tarball", byTicker };
  const tar = zlib.gunzipSync(fs.readFileSync(tarballPath));
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = readTarString(tar, offset, 100);
    if (!name) break;
    const prefix = readTarString(tar, offset + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeRaw = readTarString(tar, offset + 124, 12).replace(/\0/g, "").trim();
    const size = parseInt(sizeRaw || "0", 8) || 0;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (fullName.startsWith("deep/") && fullName.endsWith(".json") && !fullName.includes("..")) {
      try {
        const ticker = fullName.slice("deep/".length, -".json".length).toUpperCase();
        byTicker.set(ticker, JSON.parse(tar.subarray(dataStart, dataEnd).toString("utf8")));
      } catch {}
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return { source: "tarball", byTicker };
}

function listDeepFromLooseDir(deepDir) {
  const byTicker = new Map();
  if (!fs.existsSync(deepDir)) return { source: "missing_deep", byTicker };
  for (const f of fs.readdirSync(deepDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      byTicker.set(f.slice(0, -".json".length).toUpperCase(), JSON.parse(fs.readFileSync(path.join(deepDir, f), "utf8")));
    } catch {}
  }
  return { source: "loose", byTicker };
}

function countDeepRows(byTicker, canaries) {
  let newsPopulatedCount = 0;
  let newsItemsTotal = 0;
  let rewardsPopulatedCount = 0;
  let risksPopulatedCount = 0;
  const canaryResults = {};

  for (const [ticker, d] of byTicker.entries()) {
    const news = Array.isArray(d.news) ? d.news : [];
    const rewards = Array.isArray(d.overview?.rewards) ? d.overview.rewards : [];
    const risks = Array.isArray(d.overview?.risks) ? d.overview.risks : [];
    if (news.length > 0) {
      newsPopulatedCount++;
      newsItemsTotal += news.length;
    }
    if (rewards.length > 0) rewardsPopulatedCount++;
    if (risks.length > 0) risksPopulatedCount++;
  }

  for (const ticker of canaries) {
    const d = byTicker.get(ticker.toUpperCase()) || null;
    const news = Array.isArray(d?.news) ? d.news : [];
    const rewards = Array.isArray(d?.overview?.rewards) ? d.overview.rewards : [];
    const risks = Array.isArray(d?.overview?.risks) ? d.overview.risks : [];
    canaryResults[ticker] = {
      present: Boolean(d),
      news_count: news.length,
      rewards_count: rewards.length,
      risks_count: risks.length,
      has_news: news.length > 0,
      has_rewards: rewards.length > 0,
      has_risks: risks.length > 0,
      latest_news_date: news[0]?.date || null,
      latest_news_title: news[0]?.title || null,
      reward_sample: rewards[0] || null,
    };
  }

  return {
    deep_files_scanned: byTicker.size,
    news_populated_count: newsPopulatedCount,
    news_items_total: newsItemsTotal,
    rewards_populated_count: rewardsPopulatedCount,
    risks_populated_count: risksPopulatedCount,
    canary_results: canaryResults,
  };
}

function newsTimestampMs(progress) {
  const raw = progress?.finished_at || progress?.generated_at || null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function summarizeMarketQuality({ market, root = REPO_ROOT } = {}) {
  if (!MARKET_CANARIES[market]) throw new Error(`unsupported market '${market}'`);
  const dataDir = path.join(root, "data", `sws-${market}`);
  const deepDir = path.join(dataDir, "deep");
  const tarballPath = path.join(dataDir, `deep-${market}.tar.gz`);
  const tarballStat = fs.existsSync(tarballPath) ? fs.statSync(tarballPath) : null;
  const deepRows = tarballStat ? listDeepFromTarball(tarballPath) : listDeepFromLooseDir(deepDir);
  const counts = countDeepRows(deepRows.byTicker, MARKET_CANARIES[market]);
  const newsAggregate = readJsonSafe(path.join(dataDir, "news-latest.json"), null);
  const newsProgress = readJsonSafe(path.join(dataDir, "news-progress.json"), null);
  const sourceProblems = [];
  if (!tarballStat) sourceProblems.push({ code: "missing_tarball", detail: { tarball_path: tarballPath } });
  const newsMs = newsTimestampMs(newsProgress);
  if (tarballStat && newsMs != null && tarballStat.mtimeMs + 1000 < newsMs) {
    sourceProblems.push({
      code: "tarball_older_than_news_progress",
      detail: { tarball_mtime: tarballStat.mtime.toISOString(), news_progress_at: new Date(newsMs).toISOString() },
    });
  }

  return {
    market,
    generated_at: new Date().toISOString(),
    source: deepRows.source,
    data_dir: dataDir,
    tarball_path: tarballPath,
    tarball_exists: Boolean(tarballStat),
    tarball_mtime: tarballStat ? tarballStat.mtime.toISOString() : null,
    source_problems: sourceProblems,
    ...counts,
    news_aggregate: newsAggregate ? {
      exists: true,
      present: true,
      generated_at: newsAggregate.generated_at || null,
      coverage_count: newsAggregate.coverage_count ?? null,
      items_count: newsAggregate.items_count ?? (Array.isArray(newsAggregate.items) ? newsAggregate.items.length : null),
      shard_count: newsAggregate.shard_count ?? null,
    } : { exists: false, present: false },
    news_progress: newsProgress ? {
      exists: true,
      present: true,
      generated_at: newsProgress.generated_at || null,
      finished_at: newsProgress.finished_at || null,
      done_count: newsProgress.done_count ?? null,
      failed_count: newsProgress.failed_count ?? null,
      shard_count: newsProgress.shard_count ?? null,
      aborted: Boolean(newsProgress.aborted),
    } : { exists: false, present: false },
  };
}

export function buildMarketQualitySummary(market) {
  return summarizeMarketQuality({ market });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs();
    const summary = summarizeMarketQuality({ market: args.market });
    process.stdout.write(JSON.stringify(summary, null, args.pretty ? 2 : 0) + "\n");
  } catch (error) {
    console.error(`[market-quality-summary] ${error.message}`);
    process.exit(2);
  }
}
