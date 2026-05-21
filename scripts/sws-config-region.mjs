// Region-parametrized config factory — the generalization of sws-config-us.mjs.
//
// makeRegionConfig(code) returns a config object shaped exactly like the US
// config (PATHS, UNIVERSE, profileDirForShard, plus the region-agnostic knobs)
// so the shared scrape/client/stealth code consumes it unchanged. Everything
// region-AGNOSTIC (timing, rate caps, models, fingerprint, sub-tabs, panic
// signals, humanisation) is re-exported from sws-config.mjs verbatim — the
// SHARED_FINGERPRINT in particular must stay identical across regions because the
// cf_clearance cookie imported from the user's Chrome is bound to it.
//
// Each region writes a fully separate data/sws-<code>/ namespace and uses its own
// .sws-profile-<code>-N Chrome profiles, so KR/TW never collide with India/US or
// with each other.

import { fileURLToPath } from "node:url";
import path from "node:path";
import * as india from "./sws-config.mjs";
import { getRegion } from "./sws-regions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.SWS_REPO_ROOT_OVERRIDE || path.resolve(__dirname, "..");

// Region-agnostic knobs — the same objects India + US use (single source of truth).
const AGNOSTIC_KEYS = [
  "SHARD_COUNT",
  "TIMING",
  "RATE_CAPS",
  "MODELS",
  "TOKEN_BUDGET",
  "SUB_TABS",
  "SUB_TAB_NAV_LABELS",
  "PANIC_SIGNALS",
  "HEALTH_CHECK",
  "HUMANISATION",
  "SHARED_FINGERPRINT",
  "SHARD_FINGERPRINTS",
  "randInt",
  "jitteredMs",
  "shardOwning",
  "indicesForShard",
];

function agnostic() {
  const out = {};
  for (const k of AGNOSTIC_KEYS) out[k] = india[k];
  return out;
}

export function makeRegionConfig(code) {
  const region = getRegion(code);
  const dataDir = path.join(repoRoot, region.dataDir);

  const PATHS = {
    repoRoot,
    dataDir,
    deepDir: path.join(dataDir, "deep"),
    deepApiDir: path.join(dataDir, "deep-api"),
    universe: path.join(dataDir, "universe.json"),
    universeMeta: path.join(dataDir, "universe-meta.json"),
    picksLatest: path.join(dataDir, "picks-latest.json"),
    scoredUniverse: path.join(dataDir, "sws-scored-universe.json"),
    v3Stats: path.join(dataDir, "v3-universe-stats.json"),
    failed: path.join(dataDir, "failed.json"),
    panicStop: path.join(dataDir, "panic-stop.flag"),
    refreshRequested: path.join(dataDir, "refresh-requested.json"),
    progress: (shardId) => path.join(dataDir, `progress-api-${shardId}.json`),
    shardLock: (shardId) => path.join(dataDir, `scan-${shardId}.lock`),
    picksPdfDir: path.join(repoRoot, "reports", `${code}-picks`),
    activeShardsLock: path.join(dataDir, "active-shards.lock"),
    pipelineLock: path.join(dataDir, "pipeline.lock"),
    pipelineStatus: path.join(dataDir, "pipeline-status.json"),
    lastRefresh: path.join(dataDir, "last-refresh.json"),
    captures: path.join(dataDir, "captures"),
    deepTarball: path.join(dataDir, `deep-${code}.tar.gz`),
  };

  const UNIVERSE = {
    sitemapRegion: region.sitemapRegion,
    sitemapIndex: `https://simplywall.st/sitemap/companies/${region.sitemapRegion}.xml`,
    sitemapShardUrl: region.sitemapShardUrl,
    sitemapShardCount: region.sitemapShardCount,
    exchanges: region.exchangeTokens,
    excludedExchanges: region.excludedExchangeTokens || [],
    expectedTotalApprox: region.expectedTotalApprox || null,
  };

  return {
    code,
    region,
    PATHS,
    UNIVERSE,
    ...agnostic(),
    profileDirForShard: (shardId) => path.join(repoRoot, `${region.profilePrefix}-${shardId}`),
  };
}
