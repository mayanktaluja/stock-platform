// US fork of sws-config.mjs — region-coupled overrides ONLY.
//
// Everything region-agnostic (timing, rate caps, models, token budget, sub-tabs,
// panic signals, humanisation, and the browser fingerprint) is RE-EXPORTED from
// the India config so the two pipelines stay in lockstep. In particular the
// SHARED_FINGERPRINT (UA / timezone / locale) is kept identical: the cf_clearance
// cookie imported from the user's Chrome is bound to that fingerprint, and the
// account holder browsing US tickers from an India profile is unremarkable to CF.
//
// Why a separate config at all: the US picks pipeline writes a fully separate
// data/sws-us/ namespace and must never collide with the India data/sws/ tree.

import { fileURLToPath } from "node:url";
import path from "node:path";
import * as india from "./sws-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.SWS_REPO_ROOT_OVERRIDE
  ? path.resolve(process.cwd(), process.env.SWS_REPO_ROOT_OVERRIDE)
  : path.resolve(__dirname, "..");

// Region-agnostic knobs — reuse India's verbatim (single source of truth).
export const {
  SHARD_COUNT,
  TIMING,
  RATE_CAPS,
  MODELS,
  TOKEN_BUDGET,
  SUB_TABS,
  SUB_TAB_NAV_LABELS,
  PANIC_SIGNALS,
  HEALTH_CHECK,
  HUMANISATION,
  SHARED_FINGERPRINT,
  SHARD_FINGERPRINTS,
  randInt,
  jitteredMs,
  shardOwning,
  indicesForShard,
} = india;

// US data namespace — parallel to data/sws/, zero path collision.
export const PATHS = {
  repoRoot,
  dataDir: path.join(repoRoot, "data", "sws-us"),
  deepDir: path.join(repoRoot, "data", "sws-us", "deep"),
  deepApiDir: path.join(repoRoot, "data", "sws-us", "deep-api"),
  universe: path.join(repoRoot, "data", "sws-us", "universe.json"),
  universeMeta: path.join(repoRoot, "data", "sws-us", "universe-meta.json"),
  picksLatest: path.join(repoRoot, "data", "sws-us", "picks-latest.json"),
  scoredUniverse: path.join(repoRoot, "data", "sws-us", "sws-scored-universe.json"),
  v4Stats: path.join(repoRoot, "data", "sws-us", "v4-universe-stats.json"),
  v3Stats: path.join(repoRoot, "data", "sws-us", "v3-universe-stats.json"),
  failed: path.join(repoRoot, "data", "sws-us", "failed.json"),
  panicStop: path.join(repoRoot, "data", "sws-us", "panic-stop.flag"),
  refreshRequested: path.join(repoRoot, "data", "sws-us", "refresh-requested.json"),
  progress: (shardId) => path.join(repoRoot, "data", "sws-us", `progress-api-${shardId}.json`),
  shardLock: (shardId) => path.join(repoRoot, "data", "sws-us", `scan-${shardId}.lock`),
  picksPdfDir: path.join(repoRoot, "reports", "us-picks"),
};
PATHS.activeShardsLock = path.join(PATHS.dataDir, "active-shards.lock");
PATHS.pipelineLock = path.join(PATHS.dataDir, "pipeline.lock");
PATHS.pipelineStatus = path.join(PATHS.dataDir, "pipeline-status.json");
PATHS.lastRefresh = path.join(PATHS.dataDir, "last-refresh.json");
PATHS.captures = path.join(PATHS.dataDir, "captures");

// NOTE on co-running with India: both pipelines share one SWS account +
// cf_clearance, so they must never scrape concurrently. That guard lives in the
// orchestrator (scripts/sws-refresh-us.sh) as a process check (pgrep for the
// India scrape script), not here — a lock-file path is wrong from a worktree.

// US universe construction — SWS publishes the North-America sitemap under
// na-north-america (index + 7 shards 0..6). US stock URLs are
// /stocks/us/<sector>/<exchange>-<id>/<slug>  (note: NO -shares suffix, unlike IN).
export const UNIVERSE = {
  listPageUrl: "https://simplywall.st/stocks/us/market-cap-large",
  sitemapIndex: "https://simplywall.st/sitemap/companies/na-north-america.xml",
  sitemapShardUrl: (i) => `https://simplywall.st/sitemap/companies/na-north-america/${i}.xml`,
  sitemapShardCount: 7,
  // Liquid, analyst-covered exchanges by default. OTC (~12k dark shells with no
  // Snowflake/FV) is excluded unless the builder is run with --include-otc.
  exchanges: ["nasdaq", "nyse", "nysemkt"],
  otcExchange: "otc",
  expectedTotalApprox: 7000,
};

// US per-shard profile dirs (gitignored). Separate from India's .sws-profile-N
// so the two never contend on a Chrome profile lock. The cookie importer seeds
// all three from the same Chrome source.
export function profileDirForShard(shardId) {
  return path.join(repoRoot, `.sws-profile-us-${shardId}`);
}
