// Shared config for the SWS deep-scrape pipeline.
// Single source of truth for timing, rate caps, models, paths.
// Read-only at runtime; bump values here to retune.

import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.SWS_REPO_ROOT_OVERRIDE || path.resolve(__dirname, "..");

export const PATHS = {
  repoRoot,
  dataDir: path.join(repoRoot, "data", "sws"),
  deepDir: path.join(repoRoot, "data", "sws", "deep"),
  universe: path.join(repoRoot, "data", "sws", "universe.json"),
  universeMeta: path.join(repoRoot, "data", "sws", "universe-meta.json"),
  picksLatest: path.join(repoRoot, "data", "sws", "picks-latest.json"),
  failed: path.join(repoRoot, "data", "sws", "failed.json"),
  panicStop: path.join(repoRoot, "data", "sws", "panic-stop.flag"),
  refreshRequested: path.join(repoRoot, "data", "sws", "refresh-requested.json"),
  progress: (shardId) => path.join(repoRoot, "data", "sws", `progress-${shardId}.json`),
  shardLock: (shardId) => path.join(repoRoot, "data", "sws", `scan-${shardId}.lock`),
  picksPdfDir: path.join(repoRoot, "reports", "sws-picks"),
};

export const SHARD_COUNT = 3;

// Timing — every wait is randInt(min, max). Conservative because subscription protection > scan speed.
export const TIMING = {
  overviewWaitMs: { min: 5000, max: 9000 },
  subTabWaitMs: { min: 3500, max: 7500 },
  interStockCooldownMs: { min: 20000, max: 45000 },
  longPauseEveryStocks: { min: 20, max: 30 },
  longPauseDurationMs: { min: 120000, max: 300000 },
  shardStartStaggerMs: 45000, // wait this long after starting one shard before the next
  resumeAfterTokenBudgetSec: 30,
  resumeAfterRateLimitSec: 900, // 15 min
  resumeAfterPanicStopSec: 0, // never auto-resume; manual only
};

// Rate caps — hard limits enforced by the orchestrator before each request.
export const RATE_CAPS = {
  maxStocksPerMinutePerShard: 2, // = 6/min combined across 3 shards
};

// Model assignments per phase.
// `scrape` is only used by the legacy Chrome-MCP slash command driver and the Tier-2
// fallback. The Playwright driver (sws-scrape-playwright.mjs) uses no model at all.
export const MODELS = {
  scrape: "claude-sonnet-4-6",
  score: "claude-opus-4-7",
  // Narrate is structured summarisation of computed metrics — Sonnet 4.6 is
  // ~5× cheaper and ~3× faster than Opus, with quality plenty for short
  // factual prose. Switch to Opus only if quality on the Avoid list slips.
  narrate: "claude-sonnet-4-6",
  pdf: "claude-opus-4-7",
};

// Token budget per Claude session before clean exit + chain-to-next.
// Tuned for 200K standard context (the default; 1M requires /extra-usage).
// If running with /extra-usage enabled, you can bump perSessionLimit + maxStocksPerSession
// in this file to take advantage of the extra context.
export const TOKEN_BUDGET = {
  perStockApprox: 4_000,  // 8 find queries × ~500 tokens each (find-only, no get_page_text)
  perSessionLimit: 160_000, // 80% of 200K context
  maxStocksPerSession: 50, // find-only approach; shard 1 validates ~60/session is achievable
  // For 1M context: bump perSessionLimit to 600_000 and maxStocksPerSession to 150
};

// SWS sub-tabs we visit, in order. Used by the scraper and parser.
export const SUB_TABS = [
  "valuation",
  "future",
  "past",
  "health",
  "dividend",
  "management",
  "ownership",
];

// Sidebar nav text on the SWS stock page (for `find` queries).
export const SUB_TAB_NAV_LABELS = {
  valuation: "Valuation",
  future: "Future Growth",
  past: "Past Performance",
  health: "Financial Health",
  dividend: "Dividend",
  management: "Management",
  ownership: "Ownership",
};

// Patterns the active-detection layer checks for. Any positive → panic-stop.
export const PANIC_SIGNALS = {
  pageTextRedFlags: [
    /cf-challenge/i,
    /verify\s+you\s+are\s+human/i,
    /captcha/i,
    /rate\s+limited/i,
    /too\s+many\s+requests/i,
    /unusual\s+activity/i,
    /suspended/i,
    /access\s+denied/i,
  ],
  urlRedFlags: [/\/login(\?|$)/i, /\/pricing/i, /\/blocked/i],
  minPageTextLength: 150,
  slowLoadThresholdMs: 30000,
  slowLoadStreakLimit: 5,
};

// Account health check — runs every N stocks per shard.
export const HEALTH_CHECK = {
  everyNStocks: 50,
  homeUrl: "https://simplywall.st/dashboard",
  loggedInIndicatorQuery: "user avatar in top-right showing initials", // for `find`
};

// Universe construction — SWS list page that shows all Indian listings.
export const UNIVERSE = {
  listPageUrl: "https://simplywall.st/stocks/in/market-cap-large",
  expectedTotalApprox: 5478,
  preferNseOverBse: true,
};

// Helper: integer in [min, max] inclusive.
export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper: jittered sleep using TIMING values.
export function jitteredMs(timingKey) {
  const { min, max } = TIMING[timingKey];
  return randInt(min, max);
}

// Compute shard ownership for a global universe index.
export function shardOwning(globalIndex) {
  return (globalIndex % SHARD_COUNT) + 1; // 1, 2, or 3
}

// All global indices owned by a given shard.
export function indicesForShard(shardId, totalCount) {
  const out = [];
  const offset = shardId - 1;
  for (let i = offset; i < totalCount; i += SHARD_COUNT) out.push(i);
  return out;
}

// Humanisation knobs for the Playwright driver. Defaults are conservative.
// Tighten any value here if SWS pushes back.
export const HUMANISATION = {
  // Sleep distribution. "gaussian" centres on the mean of TIMING ranges with
  // sigma = (max-min)/4, clamped to [min,max]. "uniform" reuses randInt.
  sleepDistribution: "gaussian",

  // Shuffle the 7 sub-tab visit order per stock (Fisher-Yates).
  shuffleTabs: true,

  // Probability of revisiting one already-seen tab a second time per stock.
  // Adds one extra request that's hard for a bot detector to flag.
  tabRevisitProbability: 0.07,

  // Per-tab micro-actions before parse.
  microActions: {
    scroll: true,
    scrollYRange: [200, 1500],
    dwellMsRange: [200, 600],
    mouseMove: true,
  },

  // Variable session length (stocks per Playwright launch).
  sessionStockCountRange: [30, 60],

  // Closing ritual: navigate to /dashboard for a few seconds before exit
  // ("user finishes browsing, closes tab"). Range is dwell ms.
  closingDwellMsRange: [3000, 8000],

  // Circadian schedule. Hours are local IST (Asia/Kolkata).
  circadianWindow: { startHour: 8, startMinute: 30, endHour: 23, endMinute: 30 },
  circadianStartJitterMinutes: 45, // ± offset re-rolled daily

  // Weekly rest day. Each shard skips one ISO-week-day, derived from
  // crypto.randomInt seeded by ISO week + shard id (deterministic per week,
  // unpredictable across weeks). Set to null to disable.
  weeklyRest: { enabled: true },

  // Concurrency cap. 3 shards in parallel triples daily throughput
  // (3 × 400 = 1,200 stocks/day combined) while each shard stays within its
  // own per-shard rate cap. Each shard uses its own profile dir + cookie set
  // (cookie-import seeds all three from one Chrome source).
  maxActiveShardsConcurrent: 3,
};

// Single browser fingerprint shared across all shards (sequential, single
// profile). Match the user's actual Chrome UA so the cf_clearance cookie
// imported from the real Chrome profile remains valid (CF binds clearance
// to fingerprint).
//
// Detected from the user's Chrome 147 install — bump this when you update
// Chrome and run sws-import-chrome-cookies.mjs again.
export const SHARED_FINGERPRINT = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  viewport: { width: 1440, height: 900 },
  timezoneId: "Asia/Kolkata",
  locale: "en-IN",
};

// Backwards-compat shim — old code paths that still reference SHARD_FINGERPRINTS
// resolve to the shared fingerprint regardless of shard id.
export const SHARD_FINGERPRINTS = new Proxy({}, {
  get: (_t, _k) => SHARED_FINGERPRINT,
  has: () => true,
});

// Per-shard browser-profile directory. Gitignored. The cookie importer
// seeds all 3 dirs from one Chrome source profile (Mayank), so each shard
// runs as the same SWS user with the same auth + cf_clearance. Separate
// dirs are required only because Chrome's profile lock blocks two
// processes from sharing one userDataDir.
export function profileDirForShard(shardId) {
  return path.join(repoRoot, `.sws-profile-${shardId}`);
}

// Pipeline-wide lock + active-shards counter file (used by sws-refresh.sh
// and sws-anti-detect.mjs). Augments PATHS without breaking older callers.
PATHS.activeShardsLock = path.join(PATHS.dataDir, "active-shards.lock");
PATHS.pipelineLock = path.join(PATHS.dataDir, "pipeline.lock");
PATHS.pipelineStatus = path.join(PATHS.dataDir, "pipeline-status.json");
PATHS.lastRefresh = path.join(PATHS.dataDir, "last-refresh.json");
PATHS.captures = path.join(PATHS.dataDir, "captures");
PATHS.playwrightComparison = path.join(PATHS.dataDir, "playwright-comparison");
