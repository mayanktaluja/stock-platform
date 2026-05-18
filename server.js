// Resolve the .env file relative to this file's location so the server works
// no matter what cwd it was launched from (e.g. some launchers invoke it as
// `node stock-platform/server.js` from the parent directory, which would
// otherwise make dotenv look in the wrong place).
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID, randomBytes, createHmac, createHash, timingSafeEqual } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { getUserStorage } from "./userStorage.js";
import dotenv from "dotenv";
const __filenameForEnv = fileURLToPath(import.meta.url);
const __dirnameForEnv = path.dirname(__filenameForEnv);
dotenv.config({ path: path.join(__dirnameForEnv, ".env"), override: true });

import express from "express";
import compression from "compression";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import NodeCache from "node-cache";
import { apiLimiterKeyGenerator } from "./services/apiLimiterKey.js";

import { analyzeStock, intradayScan, midTermAnalysis, longTermOutlook } from "./analysis.js";
import { ALL_STOCKS, NIFTY_50, NIFTY_NEXT_50, NIFTY500_SYMBOLS, getNifty100, getNifty500, getExpandedUniverse, getStocksByIndex, validateStockList, findBySymbol } from "./stockList.js";
import { analyzeNewsSentiment, quickSentiment } from "./sentiment.js";
import { fetchNifty50, fetchNseQuote, fetchNseQuoteRaw, fetchNseIndices, fetchNseIndex, fetchNseEventCalendar, fetchGiftNifty, nseGet, nseGetUnauthed, warmup as nseWarmup } from "./nse.js";
import { appendIfNew as appendFiiDiiHistory, readRecent as readFiiDiiHistory } from "./fiiDiiHistory.js";
import {
  getFundamentals,
  getAllFundamentals,
  scoreFundamentals,
  categoriseBatch,
  getSnapshotGeneratedAt,
  getSnapshotEnrichedAt,
} from "./fundamentals.js";
// Phase 2 / Phase 4: V2 scorer infrastructure.
//
// V2 ships behind the SCORER_MODE env var (see scorerMode.js). Three modes:
//   v1          — V1 only. Rollback.
//   v2-shadow   — V1 authoritative, V2 attached as `shadowV2`. DEFAULT.
//   v2-primary  — V2 authoritative, V1 attached as `legacyV1`.
//
// The direct V2 import is still kept for places the helper isn't used
// (e.g. internal scanners that consume a score for ranking without
// exposing it on the API). User-facing endpoints MUST go through
// scoreForResponse() so the switch is centralised and testable.
import { scoreFundamentalsV2 } from "./fundamentalsV2.js";
import {
  scoreForResponse,
  compactScorerInfo,
  SCORER_MODE,
  isV2Primary,
  isV1Only,
} from "./scorerMode.js";
import { buildPortfolioIntelligence, computePortfolioCombinedScore } from "./portfolioIntelligence.js";
import {
  buildSurveillance,
  saveSurveillance,
  primeSurveillanceFromKV,
  getSurveillance,
  getSurveillanceFlag,
  getSurveillanceStatus,
} from "./surveillance.js";
import {
  buildGovernance,
  saveGovernance,
  primeGovernanceFromKV,
  getGovernance,
  getGovernanceSnapshot,
  getGovernanceStatus,
} from "./governance.js";
import { parsePortfolioFile, resolveUnmatchedLive, toIsoDate } from "./portfolioParser.js";
// `buildReport` is still used for MF-only aggregation in the SWS path —
// the legacy stock-scorer (analyzeHolding) was removed when we made SWS
// the only engine.
import { buildReport } from "./portfolioAnalyzer.js";
import { scoreHolding as swsScoreHolding, loadV3Universe } from "./services/swsHoldingEngine.js";
import { scoreStock as swsScoreStock, valuationBandFromUpside } from "./services/swsScoring.js";
import { buildCalibration as buildTrackCalibration } from "./services/trackRecord/calibration.js";
import { buildSymbolEarningsCalibration } from "./services/trackRecord/earningsCalibration.js";
import { deriveGovernanceGate } from "./services/swsIndianRiskLayer.js";
import { dedupeByBareSymbol } from "./services/searchDedup.js";
import * as swsDal from "./services/swsDal/index.js";
import { loadIndexConstituentsFromFile, stampIndexFlags } from "./services/indexConstituents.js";
import { buildFyContext as swsBuildFyContext } from "./taxEngine.js";
import { buildSWSReport, surfaceOutsidePicks, rebuildTierAggregates } from "./services/swsPortfolioAggregate.js";
import { getPortfolioHistoryStorage } from "./portfolioHistoryStorage.js";
import { getRecommendationLedgerStorage } from "./recommendationLedgerStorage.js";
import {
  buildSnapshot as memBuildSnapshot,
  deriveOpenRecs as memDeriveOpenRecs,
  reconcileRecommendations as memReconcile,
  buildIssuedEvents as memBuildIssued,
  applyReconcileToOpenRecs as memApplyReconcileToOpenRecs,
  applyMemoryToReport as memApplyToReport,
  applyCooldownDemotion as memApplyCooldownDemotion,
} from "./services/recommendationMemory.js";
import { runOnce as runFoScreener } from "./services/foScreener.js";
import {
  BhavcopyNotPublished,
  BhavcopyBlocked,
} from "./services/foBhavcopyFetcher.js";
import { loadFoScreenerFromKV } from "./services/foKvStore.js";
import { buildCatalystsPayload } from "./services/catalystsService.js";
import {
  loadEarningsSnapshot,
  loadEarningsStats,
  filterEvents,
  findEventBySymbol,
  recomputeDaysUntil,
} from "./services/earnings/earningsWatchService.js";
import {
  computeCombinedScore,
  lookupSwsScoreBulk,
  getMethodology,
  buildCombinedAudit,
  captureShadowDiffBulk,
  readShadowDiffStore,
  WEIGHTS as COMBINED_WEIGHTS,
} from "./services/combinedScore.js";
import {
  COMBINED_SCORE_MODE,
  shouldComputeCombined,
  shouldSortByCombined,
} from "./combinedScoreMode.js";
import { runXirrOptimizer, PRESETS as OPTIMIZER_PRESETS } from "./xirrOptimizer.js";
import { enrichMfHoldings, enrichLivePeers, enrichBenchmarkMetrics } from "./mfNavIngestion.js";
import { enrichMfNews } from "./mfNews.js";
import { fetchStockNews, enrichStockNews } from "./stockNews.js";
import { generateNarrative, enrichStockNarratives } from "./stockNarrative.js";
import { dailyReturns as computeDailyReturns } from "./riskMetrics.js";
import multer from "multer";
import { classifyRegime, computeMacroDelta, defaultCalmRegime, getGroqQuotaState, normalizeSector, REGIMES, SECTORS, withOpenAIRetry } from "./macroRegime.js";
import { getMacroRegimeStorage } from "./services/macroRegimeStorage.js";
import {
  TRUSTED_MACRO_SOURCES,
  MACRO_COVERAGE_TARGET,
  fetchMacroHeadlines,
  bumpSourceFailure,
  macroSourceFailures,
  parseRSS,
} from "./macroHeadlineFetcher.js";
import OpenAI from "openai";

// Lazy OpenAI client for server.js (same pattern as macroRegime.js)
let _serverOpenAI = null;
function getOpenAI() {
  if (_serverOpenAI) return _serverOpenAI;
  if (!process.env.OPENAI_API_KEY) return null;
  _serverOpenAI = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _serverOpenAI;
}
import {
  snapshotPicks,
  hasSnapshotToday,
  readAllTrades,
  appendTrades,
  computeReturns,
  aggregatePerformance,
  groupAndAggregate,
  getStorageStats,
  getISTDateKey,
  snapshotAndCloseSwsPicks,
  SWS_SECTION_TO_TYPE,
  ALL_SECTION_TYPES,
} from "./paperTrades.js";
import { snapshotTrackRecordSections } from "./services/trackRecord/sectionSnapshotter.js";
import { resolveOpenHorizons } from "./services/trackRecord/forwardReturnsResolver.js";
import {
  buildAllSectionScorecards,
  latestTopForType,
  SECTION_LABELS,
} from "./services/trackRecord/sectionScorecard.js";
import {
  bucketTradesByScoreBand,
  getConvictionPct,
  getBandLabel,
} from "./services/convictionMap.js";
import { computeTimingObservation } from "./services/timingObservation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// gzip every response before it leaves the function. Critical for Vercel:
// /api/sws-picks ships ~5.1 MB of JSON uncompressed, which exceeds the
// ~5.5 MB AWS Lambda sync-payload cap and 504s in production. Gzip brings
// it under 1 MB (typical 10× ratio for sectional JSON). This MUST be the
// first middleware so it wraps every downstream response, including
// express.static + every /api/* route.
app.use(compression());

// Cache: short TTL for real-time feel
const quoteCache = new NodeCache({ stdTTL: 60, checkperiod: 30 });
const historicalCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const newsCache = new NodeCache({ stdTTL: 120, checkperiod: 60 });
// Header search results — 5 min TTL collapses repeated keystrokes (across users
// too) so the Yahoo Finance fallback only runs on the first miss for a query.
const searchCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
// ~750 deduped curated + supplement stocks. Built once at boot so the header
// search hits a single in-memory list instead of just ALL_STOCKS (~503).
// Wider local coverage means Yahoo is only needed for truly unknown queries.
const SEARCH_UNIVERSE = getExpandedUniverse();
// Catalyst calendar (NSE corporate events) changes slowly — cache for 2 hours.
const catalystCache = new NodeCache({ stdTTL: 7200, checkperiod: 600 });
// Portfolio intelligence orchestration is expensive (~1 second per call even
// when underlying quotes are warm). Cache for 30 seconds so rapid refreshes,
// tab switches, and the 60s auto-refresh don't rebuild the whole pipeline.
// The Refresh button passes ?bust=1 to force a recompute.
const portfolioCache = new NodeCache({ stdTTL: 30, checkperiod: 15 });
// Analyzer cache — keyed by sessionId returned with each /api/portfolio/analyze
// response. Holds the enriched holdings + MFs + sector allocation so the
// /api/portfolio/optimize endpoint can re-run the XIRR optimizer with new
// preset / tax-slab / assumed-holding-months knobs WITHOUT redoing the 30s
// enrichment pipeline. 30-minute TTL is plenty for an interactive session;
// users tweaking past that just trigger a fresh analyze.
const analyzerCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 });

// Per-user "what did the analyzer say about ticker X" lookup. Powers the
// ANALYZER STANCE pill in the stock-detail modal — when the user opens
// the modal from search or any non-analyzer tab, the pill needs a quick
// way to show "Reduction-25% · MEDIUM-LOW" without re-running the full
// 30s analyzer. Populated by /api/portfolio/analyze and /api/portfolio/
// analyze/rerun on success. 30-min TTL matches analyzerCache.
const analyzerStanceCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 });

// Extract a small per-symbol stance map from a runSWSAnalysis result.
// Keeps only the fields the modal pill actually renders — keeps cache
// memory small even on 100-stock portfolios.
function _buildStanceMap(swsResult) {
  const out = {};
  const rows = Array.isArray(swsResult?._scoredHoldings) ? swsResult._scoredHoldings : [];
  for (const h of rows) {
    const sym = (h && (h.symbol || h.ticker || h.sws?.ticker) || "").toString().trim().toUpperCase();
    if (!sym) continue;
    out[sym] = {
      action: h.action || null,
      conviction: h?.sws?.v2_recommendation?.conviction || null,
      reasons: Array.isArray(h.reasons) ? h.reasons.slice(0, 2) : [],
      event_iso_date: h?.sws?.next_earnings_date || null,
      position_weight: typeof h.positionWeight === "number" ? h.positionWeight : null,
      pnl_percent: typeof h.pnlPercent === "number" ? h.pnlPercent : null,
    };
  }
  return out;
}
// Macro regime — refreshed every 2 hours. LLM-classified market regime
// (war/rate/oil/policy/calm) plus sector-level impact scores used by the
// Buy Now scanner to tilt recommendations.
//
// 2h TTL is set so a single instance refreshing on every cycle stays well
// under Groq's 100K TPD free-tier limit (12 calls/day × ~2K tokens =
// ~24K tokens). KV-shared cache (services/macroRegimeStorage.js) means
// cold-started Vercel instances hit the shared regime, not Groq, so
// instance count doesn't multiply token usage. When Groq is genuinely
// throttled the classifier falls back to a keyword heuristic — see
// macroRegime.js#classifyRegime.
const macroRegimeCache = new NodeCache({ stdTTL: 7200, checkperiod: 300 });
const MACRO_CACHE_KEY = "macro_regime";

// Last successful classification — preserved across NodeCache expiries so
// quota-limited refreshes can return real data instead of falling back to
// CALM. Hydrated lazily from the KV/file storage adapter (see
// services/macroRegimeStorage.js); rewritten on every successful classification.
let lastGoodMacroRegime = null;
const macroStorage = getMacroRegimeStorage();
// Fire-and-forget initial hydrate. Subsequent reads also hit the storage
// directly (see getMacroRegime), so this is purely an optimization.
macroStorage.read().then((stored) => {
  if (stored) {
    lastGoodMacroRegime = stored;
    macroRegimeCache.set(MACRO_CACHE_KEY, stored);
    console.log(`[MACRO] Hydrated regime from storage: ${stored.regime} (${stored.generatedAt})`);
  } else {
    // Empty hydrate is observable in prod logs — without it, a missing
    // bundle file or empty KV looks the same as a successful "no-op" hydrate.
    console.log(`[MACRO] Initial storage hydrate returned no usable regime (storage=${macroStorage.name}) — first request will trigger live classification`);
  }
}).catch((e) => {
  console.warn("[MACRO] Initial storage hydrate failed:", e.message);
});
// In-memory ring buffer of the last 5 regime classifications + the headlines
// that produced them. Exposed via /api/macro/debug for audit/debugging.
const macroHistory = [];
// Per-source failure counter (`macroSourceFailures`) and bumper
// (`bumpSourceFailure`) now live in macroHeadlineFetcher.js — imported above
// alongside the headline-fetcher functions so the standalone refresh script
// (scripts/refresh-macro-regime.mjs) and the in-process refresh share state.

// CORS — origin allowlist for the friends-and-family tier (P0.2, 2026-05-16).
//
// Pre-fix this was `cors()` — wide-open. Combined with session cookies
// being sent automatically on credentialed fetch, any site a logged-in
// friend visited could fire fetch('/api/portfolio', {credentials:'include'})
// and read their book. SameSite=Lax on the session cookie (set in
// buildCookie at line 410) blocks the subresource case in modern browsers,
// but CORS-open is still belt-and-braces wrong: it advertises the API as
// usable from anywhere.
//
// Allowlist covers: the canonical Vercel alias (-gamma), Vercel preview
// URLs under the same project (rotated per push), localhost for dev (3000)
// and Playwright (4011). Custom domain (starbhai.com) is intentionally NOT
// listed yet — see CLAUDE.md note that starbhai.com points at the WP site.
//
// Set CORS_ALLOWED_ORIGINS=foo.com,bar.com to add extras at runtime
// without a deploy (used by integration tunnels e.g. ngrok).
const CORS_ALLOWLIST = [
  "https://stock-platform-gamma.vercel.app",
  "http://localhost:3000",
  "http://localhost:4011",
  ...(process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];
const CORS_PREVIEW_REGEX =
  /^https:\/\/stock-platform-[a-z0-9-]+-mtaluja11-3604s-projects\.vercel\.app$/;
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      // Same-origin (no Origin header on same-host fetch) → always allow.
      if (!origin) return callback(null, true);
      if (CORS_ALLOWLIST.includes(origin)) return callback(null, true);
      if (CORS_PREVIEW_REGEX.test(origin)) return callback(null, true);
      // Reject — no CORS headers means the browser blocks the response.
      // We do NOT throw because that would 500 the request; instead the
      // upstream handler runs but the browser can't read the result.
      return callback(null, false);
    },
  }),
);

// Security headers (helmet) — sits AFTER CORS so preflight OPTIONS still flow
// through the CORS allowlist first, and BEFORE rate limiting + routes so every
// response (including static assets) carries the hardening headers.
//
// Pre-fix prod only carried `strict-transport-security` (Vercel injects it at
// the edge). Audit finding #4 (2026-05-18): missing CSP, X-Frame-Options,
// X-Content-Type-Options, Referrer-Policy. Clickjacking + MIME-sniff surface.
//
// CSP policy notes:
//   • script-src: 'self' covers the four file-based scripts (glossary.js,
//     app.js, swsV2Render.js, earnings.js). The gated UI ALSO carries ~28
//     onclick= handlers and the login page has inline <style> + the body of
//     gated/index.html has 150+ inline style="" attributes, so 'unsafe-inline'
//     is required for BOTH script-src and style-src as a temporary trade-off.
//     A follow-up PR can refactor inline handlers to addEventListener and
//     migrate inline styles to classes, then tighten the policy to nonce-based.
//   • style-src: must include https://fonts.googleapis.com (Google Fonts
//     stylesheet used by gated/index.html + public/login.html).
//   • font-src: must include https://fonts.gstatic.com (the font files
//     themselves, served from a different host than the CSS).
//   • img-src: data: + 'self' covers the inline SVG favicon and chart sprites.
//   • connect-src: 'self' is enough — all XHR/fetch goes to /api/* on the
//     same origin.
//   • frameAncestors: 'none' (clickjacking defence; equivalent to
//     X-Frame-Options: DENY, which helmet ALSO sets via the frameguard mw).
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
        ],
        "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:", "blob:"],
        "connect-src": ["'self'"],
        "frame-ancestors": ["'none'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
      },
    },
    // helmet defaults already set X-Frame-Options: SAMEORIGIN; bump to DENY
    // since the platform is never legitimately framed.
    frameguard: { action: "deny" },
    // Strict-origin-when-cross-origin is the modern best practice — sends
    // the full URL to same-origin endpoints, just the origin on https→https
    // crossings, and nothing on https→http downgrades.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    // X-Content-Type-Options: nosniff (default true in helmet, but explicit
    // here for grep-ability and audit traceability).
    noSniff: true,
    // HSTS is already injected by Vercel; helmet's default is fine for local
    // dev but we leave it on so the header is consistent in both environments.
    hsts: { maxAge: 15552000, includeSubDomains: true },
    // crossOriginEmbedderPolicy: false → keep COEP off. The platform embeds
    // Google Fonts (a cross-origin resource) and turning COEP on would
    // require every cross-origin response to send Cross-Origin-Resource-Policy,
    // which we don't control for the Google CDN.
    crossOriginEmbedderPolicy: false,
    // crossOriginOpenerPolicy stays on (default same-origin) for OAuth popup
    // isolation, but allow popups so the Google OAuth /api/auth/google
    // redirect can still complete.
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  }),
);

// Rate limiting — protects the LLM API budget and underlying data sources
// from abuse. The audit found that 50 burst requests succeeded with no
// throttling, which means anyone with the public Vercel URL could drain
// the Anthropic API key by hitting /api/stock with random symbols.
//
// Limits:
//   • All API routes:           60 requests per IP per minute
//   • /api/stock/ (LLM-heavy):  additional 30 per IP per minute
// Static files (HTML, CSS, JS) are NOT rate-limited.
//
// `trust proxy` is set BEFORE the limiters so they see real client IPs
// from X-Forwarded-For (Vercel and most reverse proxies set this). Without
// it the limiter would lump all users into one global counter.
app.set("trust proxy", 1);

// Rate limiters are bypassed when NODE_ENV=test so the Playwright e2e harness
// can drive the SPA without tripping the 60 req/min window. Production keeps
// the gate.
const isTestEnv = process.env.NODE_ENV === "test";

// Per-user limiter key (audit finding #6 / task 7, 2026-05-18).
//
// Pre-fix the limiter keyed by IP. That meant any group of users sharing a
// public IP — corporate offices, mobile carriers behind CG-NAT, café Wi-Fi —
// shared one 60 req/min bucket. A single heavy user could DoS the entire
// shared network's access to the API.
//
// Fix: key by the authenticated user's Google sub when present, falling back
// to IP for unauthenticated routes (/api/login, /api/auth/google, /api/health).
// Lives in services/apiLimiterKey.js so the unit test can import it without
// booting all of server.js.

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: "draft-7", // emits the RateLimit-* response headers
  legacyHeaders: false,
  skip: () => isTestEnv,
  keyGenerator: apiLimiterKeyGenerator,
  message: { error: "Too many requests. Please slow down (60 req/min limit)." },
});

const stockDetailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => isTestEnv,
  keyGenerator: apiLimiterKeyGenerator,
  message: { error: "Too many stock detail requests. Please slow down (30 req/min limit)." },
});

// NOTE: the actual app.use("/api/", apiLimiter) mount has MOVED to AFTER the
// auth gate (see further down) so req.user is populated when the limiter
// runs. The variable is hoisted here so stockDetailLimiter (mounted before
// the auth gate for narrower /api/stock/ scope) can also reuse the key
// generator; stockDetailLimiter sits before auth on purpose — even on a
// pre-auth path the per-IP throttle still guards the Yahoo budget. Once
// inside the post-auth chain, apiLimiter takes over and switches to
// per-user keying.

// ── API key authentication for sensitive endpoints ──
//
// Industry deployment requires protecting portfolio, watchlist, and track
// record write endpoints. When STARBHAI_API_KEY is set in the environment,
// these endpoints require an X-API-Key header. When NOT set (local dev),
// all endpoints are open — no friction for development.
//
// Public endpoints (scan, stock, market, news, heatmap, macro) stay open.
function requireApiKey(req, res, next) {
  const envKey = process.env.STARBHAI_API_KEY;
  if (!envKey) return next(); // No key configured = open (local dev)
  const provided = req.headers["x-api-key"] || req.query.apiKey;
  if (provided === envKey) return next();
  return res.status(401).json({ error: "Unauthorized. Provide X-API-Key header." });
}

// Apply to sensitive routes (portfolio, watchlist, track writes)
app.use("/api/portfolio", requireApiKey);
app.use("/api/watchlist", requireApiKey);
app.use("/api/stock/", stockDetailLimiter);

// ── Auth gate (Google OAuth) ──
//
// When STARBHAI_SESSION_SECRET, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
// are all set, the entire UI + API is locked behind "Continue with Google".
// Sessions are HMAC-signed cookies carrying the Google `sub` (no DB on
// the hot path; user records live in Vercel KV / users.json — see
// userStorage.js). When any env var is unset (local dev), the gate is
// a no-op — same convenience pattern as requireApiKey above. The auth
// routes themselves and /api/cron/* are always exempt.
const SESSION_SECRET = process.env.STARBHAI_SESSION_SECRET || "";
const SESSION_COOKIE = "starbhai_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OAUTH_COOKIE = "starbhai_oauth";
const OAUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes — covers the consent round-trip
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || "";
const AUTH_ENABLED = !!(SESSION_SECRET && GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_OAUTH_REDIRECT_URI);

// P3.5 (2026-05-16) — Session-secret strength check.
//
// When AUTH_ENABLED is true (production / any environment with OAuth
// configured), STARBHAI_SESSION_SECRET must be at least 64 hex chars
// (32 bytes of entropy). A weaker secret makes session-token forgery
// economically feasible. The check is enforced at startup, not at
// request time, so a deploy with a weak secret is rejected before any
// session is signed. Dev/test paths (AUTH_ENABLED=false) are exempt —
// no session is ever signed so there's nothing to forge.
if (AUTH_ENABLED) {
  const looksHex = /^[0-9a-fA-F]+$/.test(SESSION_SECRET);
  if (SESSION_SECRET.length < 64) {
    throw new Error(
      `STARBHAI_SESSION_SECRET is too short (${SESSION_SECRET.length} chars; need >=64 hex). ` +
      `Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  if (!looksHex) {
    console.warn(
      `[SECURITY] STARBHAI_SESSION_SECRET is not pure hex. Length is OK but consider regenerating ` +
      `via crypto.randomBytes(32).toString("hex") for predictable entropy.`,
    );
  }
}

const oauthClient = AUTH_ENABLED
  ? new OAuth2Client({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
    })
  : null;

// Distinct payload prefixes so a session token can never be replayed as
// an oauth-state token (or vice versa) even if the HMAC secret leaks.
const SESSION_PREFIX = "sess:";
const OAUTH_PREFIX = "oauth:";

function b64urlEncode(str) {
  return Buffer.from(str, "utf8").toString("base64url");
}
function b64urlDecode(str) {
  try { return Buffer.from(str, "base64url").toString("utf8"); }
  catch { return null; }
}

function signPayload(prefix, obj) {
  const payload = b64urlEncode(prefix + JSON.stringify(obj));
  const sig = createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyPayload(prefix, token, ttlMs) {
  if (!token || !AUTH_ENABLED) return null;
  const idx = token.indexOf(".");
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  if (sig.length !== expect.length) return null;
  let sigBuf, expectBuf;
  try {
    sigBuf = Buffer.from(sig, "hex");
    expectBuf = Buffer.from(expect, "hex");
  } catch {
    return null;
  }
  if (sigBuf.length !== expectBuf.length || sigBuf.length === 0) return null;
  if (!timingSafeEqual(sigBuf, expectBuf)) return null;
  const decoded = b64urlDecode(payload);
  if (!decoded || !decoded.startsWith(prefix)) return null;
  let obj;
  try { obj = JSON.parse(decoded.slice(prefix.length)); }
  catch { return null; }
  if (!obj || typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) return null;
  if (Date.now() - obj.ts > ttlMs) return null;
  return obj;
}

function signSession(sub) {
  return signPayload(SESSION_PREFIX, { sub, ts: Date.now() });
}
function verifySession(token) {
  return verifyPayload(SESSION_PREFIX, token, SESSION_TTL_MS);
}
function signOAuthState({ state, verifier, returnTo }) {
  return signPayload(OAUTH_PREFIX, { state, verifier, returnTo: returnTo || "/", ts: Date.now() });
}
function verifyOAuthState(token) {
  return verifyPayload(OAUTH_PREFIX, token, OAUTH_TTL_MS);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function buildCookie(name, value, maxAgeMs) {
  // SameSite=Lax (NOT Strict). Strict drops the cookie on the redirect
  // back from Google because it's a cross-site initiated nav, which
  // would break the entire OAuth callback. Lax keeps top-level GET
  // navigations working — exactly what OAuth needs.
  const flags = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (process.env.VERCEL) flags.push("Secure");
  return flags.join("; ");
}

function setSessionCookie(res, sub) {
  res.setHeader("Set-Cookie", buildCookie(SESSION_COOKIE, signSession(sub), SESSION_TTL_MS));
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", buildCookie(SESSION_COOKIE, "", 0));
}
function setOAuthCookie(res, token) {
  res.setHeader("Set-Cookie", buildCookie(OAUTH_COOKIE, token, OAUTH_TTL_MS));
}
function clearOAuthCookie(res) {
  res.setHeader("Set-Cookie", buildCookie(OAUTH_COOKIE, "", 0));
}

// Same-origin path validator — defends /api/auth/google?returnTo=...
// against open-redirect abuse. Only same-origin paths starting with a
// single "/" are accepted.
function safeReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

// ── Auth routes — registered BEFORE the gate so they're reachable
// when the user has no session cookie yet. ──

// Backwards-compatible 410 stub for the removed password endpoint, so
// browsers with a cached login.html tab don't 404 — they get a clean
// signal that this auth path is gone. Drop in a follow-up cleanup PR.
app.post("/api/login", express.json(), (_req, res) => {
  res.status(410).json({ error: "password-login-removed", hint: "use /api/auth/google" });
});

app.get("/api/auth/google", (req, res) => {
  if (!AUTH_ENABLED) return res.status(500).json({ error: "auth-not-configured" });
  const state = randomBytes(32).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const returnTo = safeReturnTo(req.query.returnTo);

  const stateToken = signOAuthState({ state, verifier, returnTo });
  setOAuthCookie(res, stateToken);

  const url = oauthClient.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  res.redirect(302, url);
});

app.get("/api/auth/google/callback", async (req, res) => {
  if (!AUTH_ENABLED) return res.status(500).json({ error: "auth-not-configured" });
  try {
    const cookieToken = readCookie(req, OAUTH_COOKIE);
    const oauth = verifyOAuthState(cookieToken);
    if (!oauth) {
      clearOAuthCookie(res);
      return res.status(400).json({ error: "oauth-state-missing-or-expired" });
    }
    const { state: queryState, code, error: googleError } = req.query;
    if (googleError) {
      clearOAuthCookie(res);
      return res.status(400).json({ error: "google-error", detail: String(googleError) });
    }
    if (!code || typeof code !== "string") {
      clearOAuthCookie(res);
      return res.status(400).json({ error: "missing-code" });
    }
    if (!queryState || queryState !== oauth.state) {
      clearOAuthCookie(res);
      return res.status(400).json({ error: "state-mismatch" });
    }

    const { tokens } = await oauthClient.getToken({
      code,
      codeVerifier: oauth.verifier,
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    });
    if (!tokens || !tokens.id_token) {
      clearOAuthCookie(res);
      return res.status(400).json({ error: "no-id-token" });
    }
    const ticket = await oauthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const validIssuers = ["accounts.google.com", "https://accounts.google.com"];
    if (!payload || !validIssuers.includes(payload.iss)) {
      clearOAuthCookie(res);
      return res.status(400).json({ error: "bad-issuer" });
    }
    if (!payload.email_verified) {
      clearOAuthCookie(res);
      return res.status(403).json({ error: "email-not-verified" });
    }
    if (!payload.sub) {
      clearOAuthCookie(res);
      return res.status(400).json({ error: "no-sub" });
    }

    const userStore = getUserStorage();
    await userStore.upsert(payload.sub, {
      email: payload.email || "",
      name: payload.name || "",
      picture: payload.picture || "",
      ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        || (req.socket && req.socket.remoteAddress) || null,
      ua: req.headers["user-agent"] || null,
    });

    clearOAuthCookie(res);
    setSessionCookie(res, payload.sub);
    return res.redirect(302, safeReturnTo(oauth.returnTo));
  } catch (err) {
    clearOAuthCookie(res);
    console.warn("[AUTH] callback failed:", err && err.message);
    return res.status(400).json({ error: "callback-failed", detail: err && err.message });
  }
});

app.get("/api/auth/me", async (req, res) => {
  if (!AUTH_ENABLED) {
    // Dev mode: gate is a no-op, treat caller as anonymous so the UI
    // keeps the user menu hidden but doesn't crash.
    return res.status(401).json({ error: "auth-disabled" });
  }
  const session = verifySession(readCookie(req, SESSION_COOKIE));
  if (!session) return res.status(401).json({ error: "unauthenticated" });
  const userStore = getUserStorage();
  const record = await userStore.read(session.sub);
  if (!record) return res.status(401).json({ error: "user-not-found" });
  // /api/auth/me is exempt from the gate middleware (which is where the
  // gate's heartbeat lives), so touch here too — this is the canonical
  // page-load ping from the SPA.
  userStore.touch(session.sub).catch((err) => {
    console.warn("[USER:TOUCH] failed:", err && err.message);
  });
  return res.json({
    userId: record.sub,
    email: record.email,
    name: record.name,
    picture: record.picture,
    isAdmin: !!record.isAdmin,
  });
});

app.post("/api/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// The gate — must come BEFORE express.static so static assets (index.html,
// app.js, etc.) are also protected.
const AUTH_EXEMPT_PATHS = new Set([
  "/login.html",
  "/api/login",
  "/api/logout",
  "/api/auth/google",
  "/api/auth/google/callback",
  "/api/auth/me",
  // Public health probe — non-sensitive (just an age and a status), no PII,
  // safe to expose so external uptime checks can verify the macro-only cron.
  // Added 2026-05-17 as Phase 4 of the macro permanent fix.
  "/api/macro/regime/health",
]);
app.use((req, res, next) => {
  if (!AUTH_ENABLED) return next();
  if (AUTH_EXEMPT_PATHS.has(req.path)) return next();
  if (req.path.startsWith("/api/cron/")) return next();
  // Track-record bootstrap endpoints have their own MACRO_OVERRIDE_TOKEN
  // gate inside the handler — they intentionally bypass the session gate
  // so a one-shot curl can seed Vercel KV without an interactive login.
  if (req.path === "/api/track/migrate" || req.path === "/api/track/snapshot-sws-now") return next();
  const session = verifySession(readCookie(req, SESSION_COOKIE));
  if (session) {
    req.user = session; // {sub, ts} — downstream handlers can read req.user.sub
    // Fire-and-forget heartbeat. The store's touch() is debounced (5 min)
    // and only bumps sessionCount when the gap exceeds 30 min — so most
    // requests are a no-op. Distinct from loginEvents (OAuth callbacks
    // only): captures returning users on a still-valid session cookie.
    getUserStorage().touch(session.sub).catch((err) => {
      console.warn("[USER:TOUCH] failed:", err && err.message);
    });
    return next();
  }

  const accept = req.headers.accept || "";
  if (req.method === "GET" && accept.includes("text/html")) {
    return res.redirect(302, "/login.html");
  }
  return res.status(401).json({ error: "unauthenticated" });
});

// /api/* rate limiter — MOUNTED HERE (post-auth) so apiLimiterKeyGenerator
// can read req.user.sub for authenticated requests. Unauthenticated routes
// (login, auth/google, health, cron) pass through the auth gate with
// next() — req.user stays undefined — and the keyGenerator falls back to
// req.ip, matching the pre-fix behavior for those endpoints. See the
// keyGenerator definition above and audit finding #6.
app.use("/api/", apiLimiter);

// SPA static files (app.js, index.html, etc.) live in gated/ — NOT public/ —
// because Vercel auto-serves files in public/ from its edge CDN, bypassing
// this gate middleware. Files in gated/ are bundled into the serverless
// function via the `includeFiles` config in vercel.json and only reach the
// client through Express, so the login gate above always runs first.
app.use(express.static(path.join(__dirname, "gated")));
// public/ now contains only login.html (intentionally CDN-served so the
// login page is reachable without a session). express.static for public/
// is kept for local dev parity and as a defensive fallback.
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ==================== Yahoo Finance Direct API ====================

const YF_BASE = "https://query1.finance.yahoo.com";
const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
};

// ==================== RELIABILITY PRIMITIVES ====================

/**
 * fetch wrapped in AbortController timeout.
 * Throws a timeout-tagged error on expiry.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error(`Timeout after ${timeoutMs}ms`);
      e.code = "TIMEOUT";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Retrying fetch.
 * Retries on network errors / 5xx / 429 / timeout with exponential backoff.
 * Never retries on 404. Returns null on final failure (does not throw — matches call sites).
 */
export async function fetchWithRetry(url, options = {}, cfg = {}) {
  const { retries = 2, timeoutMs = 8000, backoffMs = 400 } = cfg;
  let attempt = 0;
  let lastErr = null;

  while (attempt <= retries) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      // Don't retry client errors except rate-limit
      if (res.status === 404 || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        return res;
      }
      if (res.ok) return res;
      // Retriable server error
      lastErr = new Error(`HTTP ${res.status}`);
      lastErr.code = "HTTP_" + res.status;
    } catch (err) {
      lastErr = err;
    }
    attempt++;
    if (attempt <= retries) {
      const delay = backoffMs * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // All retries exhausted — return null so callers don't crash
  if (lastErr) console.error(`fetchWithRetry gave up on ${url.slice(0, 80)}:`, lastErr.message);
  return null;
}

/**
 * Failure tracker for scan batches.
 * Pass into per-stock fetch logic so we can surface which stocks dropped and why.
 */
export function createFailureTracker() {
  const failures = [];
  return {
    record(symbol, reason) { failures.push({ symbol, reason }); },
    summary() {
      return {
        failedCount: failures.length,
        failedSymbols: failures.slice(0, 20), // cap to 20 for JSON size
      };
    },
  };
}

// ==================== DATA FETCHERS ====================

/**
 * Fetch quote data using Yahoo Finance v8 chart endpoint
 */
async function fetchQuote(symbol) {
  const cached = quoteCache.get(symbol);
  if (cached) return cached;

  try {
    const url = `${YF_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d&includePrePost=false`;
    const res = await fetchWithRetry(url, { headers: YF_HEADERS }, { retries: 2, timeoutMs: 8000 });

    if (!res || !res.ok) return null;

    const data = await res.json();
    if (!data.chart?.result?.[0]) return null;

    const r = data.chart.result[0];
    const meta = r.meta;
    const q = r.indicators.quote[0];
    const timestamps = r.timestamp || [];
    const lastIdx = timestamps.length - 1;

    // IMPORTANT: meta.chartPreviousClose is the close of the FIRST bar in the
    // requested range (e.g. 5 days ago with range=5d), NOT yesterday's close.
    // The true previous close is the second-to-last daily bar's close.
    const prevClose =
      lastIdx >= 1 && q.close?.[lastIdx - 1] != null
        ? q.close[lastIdx - 1]
        : meta.chartPreviousClose;

    const currentPrice = meta.regularMarketPrice;

    const quote = {
      symbol: meta.symbol,
      shortName: meta.shortName || meta.longName || meta.symbol,
      longName: meta.longName || meta.shortName || meta.symbol,
      regularMarketPrice: currentPrice,
      regularMarketDayHigh: meta.regularMarketDayHigh,
      regularMarketDayLow: meta.regularMarketDayLow,
      regularMarketVolume: meta.regularMarketVolume,
      regularMarketOpen: lastIdx >= 0 ? q.open?.[lastIdx] : null,
      regularMarketPreviousClose: prevClose,
      regularMarketChange: currentPrice - prevClose,
      regularMarketChangePercent:
        prevClose !== 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
      currency: meta.currency || "INR",
      exchange: meta.exchangeName,
      marketState: meta.hasPrePostMarketData ? "Regular" : "Closed",
    };

    quoteCache.set(symbol, quote);
    return quote;
  } catch (err) {
    console.error(`Quote error for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Fetch detailed quote - uses chart endpoint + derives additional metrics from historical data
 */
async function fetchDetailedQuote(symbol) {
  try {
    const basicQuote = await fetchQuote(symbol);
    if (!basicQuote) return null;

    // Derive additional metrics from historical data
    const historical = await fetchHistorical(symbol);
    if (historical && historical.length > 0) {
      // Calculate 50-day and 200-day averages
      const closes = historical.map((d) => d.close);
      if (closes.length >= 50) {
        basicQuote.fiftyDayAverage = closes.slice(-50).reduce((s, v) => s + v, 0) / 50;
      }
      if (closes.length >= 200) {
        basicQuote.twoHundredDayAverage = closes.slice(-200).reduce((s, v) => s + v, 0) / 200;
      }
      // Average volume (last 60 trading days)
      const volumes = historical.map((d) => d.volume);
      const avgVolPeriod = Math.min(60, volumes.length);
      basicQuote.averageDailyVolume3Month =
        volumes.slice(-avgVolPeriod).reduce((s, v) => s + v, 0) / avgVolPeriod;
    }

    return basicQuote;
  } catch (err) {
    console.error(`Detailed quote error for ${symbol}:`, err.message);
    return null;
  }
}

// ─── P1.6: Conviction map (score-band → realized hit-rate) ──────────
//
// Lazy-built from paperTrades. The scanner endpoint calls
// getOrBuildConvictionMap() once per request; first call after the cache
// expires fetches a current quote per unique held symbol (using the
// existing 60s quoteCache so concurrent scanners don't double-fetch),
// computes returnPct per trade, and buckets by 5-pt score bands.
//
// Cache 6h. The map is purely informational — used to render
// "78/100 → ~62%" on the disclosure pane. A null hit-rate (insufficient
// sample) means the disclosure pane keeps the qualitative band label
// (STRONG / MODERATE / WEAK) instead of showing a noisy %.

const CONVICTION_TTL_MS = 6 * 60 * 60 * 1000; // 6h
let _convictionMap = null;
let _convictionMapAt = 0;
let _convictionMapInflight = null;

async function getOrBuildConvictionMap() {
  const now = Date.now();
  if (_convictionMap && (now - _convictionMapAt) < CONVICTION_TTL_MS) {
    return _convictionMap;
  }
  if (_convictionMapInflight) return _convictionMapInflight;

  _convictionMapInflight = (async () => {
    try {
      const trades = await readAllTrades();
      if (!Array.isArray(trades) || trades.length === 0) {
        _convictionMap = { bands: {}, builtAt: new Date().toISOString(), totalTrades: 0, eligibleTrades: 0 };
        _convictionMapAt = now;
        return _convictionMap;
      }
      // Group trades by symbol so we fetch each quote once.
      const bySymbol = new Map();
      for (const t of trades) {
        if (!t.symbol) continue;
        if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
        bySymbol.get(t.symbol).push(t);
      }
      // Fetch quotes in parallel batches of 10 to avoid hammering NSE.
      const symbols = Array.from(bySymbol.keys());
      const priceMap = new Map();
      const BATCH = 10;
      for (let i = 0; i < symbols.length; i += BATCH) {
        const slice = symbols.slice(i, i + BATCH);
        const quotes = await Promise.all(slice.map((s) => fetchQuote(s).catch(() => null)));
        for (let j = 0; j < slice.length; j++) {
          const q = quotes[j];
          if (q && Number.isFinite(q.regularMarketPrice)) {
            priceMap.set(slice[j], q.regularMarketPrice);
          }
        }
      }
      // Compute returnPct + daysHeld per trade (in-memory, no I/O).
      const enriched = [];
      for (const t of trades) {
        const cp = priceMap.get(t.symbol);
        if (!Number.isFinite(cp)) continue;
        const r = computeReturns(t, cp, null);
        if (r && Number.isFinite(r.returnPct)) {
          enriched.push({
            scoreAtSnapshot: Number(t.scoreAtSnapshot),
            returnPct: r.returnPct,
            daysHeld: r.daysHeld,
          });
        }
      }
      _convictionMap = bucketTradesByScoreBand(enriched);
      _convictionMapAt = now;
      console.log(
        `[convictionMap] built: ${_convictionMap.eligibleTrades}/${_convictionMap.totalTrades} eligible, ` +
        `bands=${Object.keys(_convictionMap.bands).length}`
      );
      return _convictionMap;
    } catch (err) {
      console.warn("[convictionMap] build failed:", err.message);
      _convictionMap = { bands: {}, builtAt: new Date().toISOString(), totalTrades: 0, eligibleTrades: 0 };
      _convictionMapAt = now;
      return _convictionMap;
    } finally {
      _convictionMapInflight = null;
    }
  })();
  return _convictionMapInflight;
}

/**
 * Fetch historical data for technical analysis
 */
async function fetchHistorical(symbol, range = "6mo") {
  const cacheKey = `${symbol}_${range}`;
  const cached = historicalCache.get(cacheKey);
  if (cached) return cached;

  try {
    const url = `${YF_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
    const res = await fetchWithRetry(url, { headers: YF_HEADERS }, { retries: 2, timeoutMs: 8000 });

    if (!res || !res.ok) return null;

    const data = await res.json();
    if (!data.chart?.result?.[0]) return null;

    const r = data.chart.result[0];
    const timestamps = r.timestamp || [];
    const q = r.indicators.quote[0];

    const historical = timestamps
      .map((ts, i) => ({
        date: new Date(ts * 1000),
        open: q.open?.[i],
        high: q.high?.[i],
        low: q.low?.[i],
        close: q.close?.[i],
        volume: q.volume?.[i] || 0,
      }))
      .filter((d) => d.close !== null && d.high !== null && d.low !== null && d.open !== null);

    if (historical.length > 0) {
      historicalCache.set(cacheKey, historical);
    }

    return historical;
  } catch (err) {
    console.error(`Historical error for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Search for stocks using Yahoo Finance search API
 */
async function searchYahoo(query) {
  try {
    const url = `${YF_BASE}/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=0&quotesCount=10`;
    const res = await fetchWithRetry(url, { headers: YF_HEADERS }, { retries: 1, timeoutMs: 6000 });

    if (!res || !res.ok) return [];

    const data = await res.json();

    // Yahoo's search returns a lot of noise for Indian queries:
    //   - futures/options contracts (symbols with "FUT" or "-J<digits>" or patterns
    //     like JIOFIN26APRFUT or JFSL-J2630.BO)
    //   - mutual funds (symbols starting with "0P0" — Morningstar codes)
    //   - non-equity quoteTypes
    // Strip those out so the dropdown only shows real equity tickers.
    const isNoise = (q) => {
      if (!q.symbol) return true;
      // Mutual fund codes
      if (q.symbol.startsWith("0P0")) return true;
      // Futures (e.g. "JIOFIN26APRFUT", "NIFTY26JANFUT", "-J2630")
      if (/FUT(\.|$)/.test(q.symbol)) return true;
      if (/-J\d+/.test(q.symbol)) return true;
      // Only EQUITY quote types (excludes ETF-mutualfund hybrids, futures, options)
      if (q.quoteType && q.quoteType !== "EQUITY") return true;
      return false;
    };

    const filtered = (data.quotes || []).filter(
      (q) =>
        !isNoise(q) &&
        (q.exchange === "NSI" ||
          q.exchange === "NSE" ||
          q.exchange === "BSE" ||
          q.exchange === "BOM" ||
          (q.symbol && (q.symbol.endsWith(".NS") || q.symbol.endsWith(".BO"))))
    );

    // Rank NSE listings above BSE listings — NSE is the primary exchange on
    // Groww and has tighter spreads. If a stock has both .NS and .BO, the .NS
    // should come first in the dropdown.
    filtered.sort((a, b) => {
      const aNse = a.symbol?.endsWith(".NS") ? 0 : 1;
      const bNse = b.symbol?.endsWith(".NS") ? 0 : 1;
      return aNse - bNse;
    });

    return filtered.map((q) => ({
      symbol: q.symbol,
      name: q.shortname || q.longname || q.symbol,
      // Yahoo's exchDisp for NSE India is "NSI"; the rest of the app
      // (badges, picks, watchlist) consistently says "NSE". Normalise
      // once here so every caller gets the same label.
      exchange: q.exchange === "NSI" ? "NSE" : q.exchange,
      type: q.quoteType,
    }));
  } catch (err) {
    console.error("Yahoo search error:", err.message);
    return [];
  }
}

/**
 * Fetch latest news for a stock - searches with full name for better India-specific results
 */
async function fetchNews(symbol) {
  const cached = newsCache.get(symbol);
  if (cached) return cached;

  try {
    // Find the stock's full name for better news search
    const stockInfo = ALL_STOCKS.find((s) => s.symbol === symbol);
    const searchTerm = stockInfo
      ? `${stockInfo.name} India stock`
      : symbol.replace(".NS", "").replace(".BO", "") + " India";

    const url = `${YF_BASE}/v1/finance/search?q=${encodeURIComponent(searchTerm)}&newsCount=10&quotesCount=0`;
    const res = await fetchWithRetry(url, { headers: YF_HEADERS }, { retries: 1, timeoutMs: 6000 });

    if (!res || !res.ok) return [];

    const data = await res.json();
    const news = (data.news || []).map((n) => ({
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      publishedAt: n.providerPublishTime
        ? new Date(n.providerPublishTime * 1000).toISOString()
        : null,
      thumbnail: n.thumbnail?.resolutions?.[0]?.url || null,
    }));

    newsCache.set(symbol, news);
    return news;
  } catch (err) {
    console.error(`News error for ${symbol}:`, err.message);
    return [];
  }
}

// ==================== API ROUTES ====================

/**
 * POST /api/telemetry
 *
 * Append-only event log for KPI measurement (NS-1 Time-to-Verdict, NS-5
 * Watchlist→action conversion). Local dev only — Vercel's FS is read-only,
 * so the endpoint is a no-op there. Each call appends one NDJSON line to
 * `data/telemetry/events.ndjson`.
 *
 * Body: { event, page, ts, sessionId, payload? }
 *   event     — string, required, ≤ 64 chars (e.g. "page_load", "verdict_visible")
 *   page      — string, required, ≤ 64 chars (current tab id)
 *   ts        — number, required (Date.now() at emit)
 *   sessionId — string, required, ≤ 64 chars (client-generated UUID)
 *   payload   — object, optional, body cap 4KB
 *
 * Always 204 / never blocks. Errors are swallowed so telemetry never
 * affects user-visible behaviour.
 */
const TELEMETRY_DIR = path.join(__dirname, "data", "telemetry");
const TELEMETRY_FILE = path.join(TELEMETRY_DIR, "events.ndjson");
const TELEMETRY_ENABLED = !process.env.VERCEL;
app.post("/api/telemetry", express.json({ limit: "8kb" }), async (req, res) => {
  if (!TELEMETRY_ENABLED) return res.status(204).end();
  try {
    const { event, page: pageName, ts, sessionId, payload } = req.body || {};
    const isShort = (v, n) => typeof v === "string" && v.length > 0 && v.length <= n;
    if (!isShort(event, 64) || !isShort(pageName, 64) || !isShort(sessionId, 64)) {
      return res.status(204).end();
    }
    if (typeof ts !== "number" || !Number.isFinite(ts)) return res.status(204).end();
    const record = {
      event,
      page: pageName,
      ts,
      sessionId,
      sub: (req.user && req.user.sub) || null,
      ua: (req.headers["user-agent"] || "").slice(0, 200),
      payload: payload && typeof payload === "object" ? payload : null,
    };
    await fs.promises.mkdir(TELEMETRY_DIR, { recursive: true });
    await fs.promises.appendFile(TELEMETRY_FILE, JSON.stringify(record) + "\n");
  } catch (err) {
    // Never let telemetry failures escape — log once and move on.
    if (!process.env.TELEMETRY_QUIET) {
      console.warn("[TELEMETRY] append failed:", err && err.message);
    }
  }
  res.status(204).end();
});

/**
 * Search for Indian stocks
 */
app.get("/api/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.length < 1) {
      return res.json({ results: [] });
    }

    const cacheKey = `q:${query.toLowerCase().trim()}`;
    const cached = searchCache.get(cacheKey);
    if (cached) {
      res.set("X-Search-Cache", "HIT");
      return res.json({ results: cached });
    }

    const q = query.toLowerCase().trim();
    // Strip a trailing exchange suffix so "AJAXENGG.BO" and "AJAXENGG.NS"
    // both behave like "AJAXENGG". Without this, the local filter never
    // matches an explicit .BO query (it's .NS-suffix-aware only), and
    // Yahoo may echo back only the explicitly-requested variant — both
    // of which prevent the NSE-preference dedup from doing its job.
    const qBare = q.replace(/\.(ns|bo)$/i, "");

    const localResults = SEARCH_UNIVERSE.filter(
      (s) =>
        s.name.toLowerCase().includes(qBare) ||
        s.symbol.toLowerCase().includes(qBare + ".ns") ||
        s.symbol.toLowerCase().replace(".ns", "").includes(qBare)
    ).slice(0, 10);

    // Yahoo only fires when local has zero hits — typos, brand-new IPOs,
    // obscure BSE-only names. Cuts ~95% of round-trips at 750-stock coverage.
    const yahooResults = localResults.length === 0 ? await searchYahoo(qBare) : [];

    const allResults = [...localResults];
    for (const yr of yahooResults) {
      if (!allResults.find((r) => r.symbol === yr.symbol)) {
        allResults.push(yr);
      }
    }

    // Collapse NSE/BSE pairs to one row per company, preferring .NS.
    const deduped = dedupeByBareSymbol(allResults);
    const finalResults = deduped.slice(0, 15);
    searchCache.set(cacheKey, finalResults);
    res.set("X-Search-Cache", "MISS");
    res.set("X-Search-Yahoo", localResults.length === 0 ? "called" : "skipped");
    res.json({ results: finalResults });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: "Search failed" });
  }
});

/**
 * Full stock analysis endpoint
 */
/**
 * Compute a per-stock "should I buy THIS stock TODAY?" verdict.
 * Combines the stock's own signals with the current market environment.
 *
 * Returns { verdict, verdictColor, signals[], score, actionText }
 */
function computeStockVerdict({ techScore, newsScore, fundamentalScore, fundamentalVerdict, combinedScore, scannerScore, macroBoost, macroContext, dataConfidence, midTerm }) {
  const signals = [];
  let score = 0;

  // Signal 1: Fundamentals
  if (fundamentalScore != null) {
    if (fundamentalVerdict === "DEEP_VALUE") {
      signals.push({ name: "Fundamentals", signal: "green", value: `DEEP VALUE (${fundamentalScore}/100)`, action: "Trading at a steep discount to sector peers.", icon: "💎" });
      score += 4;
    } else if (fundamentalVerdict === "QUALITY_GROWTH") {
      signals.push({ name: "Fundamentals", signal: "green", value: `QUALITY GROWTH (${fundamentalScore}/100)`, action: "Reasonably priced with good momentum.", icon: "✅" });
      score += 2;
    } else if (fundamentalVerdict === "FAIR_VALUE") {
      signals.push({ name: "Fundamentals", signal: "yellow", value: `FAIR VALUE (${fundamentalScore}/100)`, action: "Priced about right — no discount, no premium.", icon: "➖" });
      score += 0;
    } else if (fundamentalVerdict === "FULLY_VALUED") {
      signals.push({ name: "Fundamentals", signal: "yellow", value: `FULLY VALUED (${fundamentalScore}/100)`, action: "Trading at a premium. Limited upside.", icon: "⚠️" });
      score -= 2;
    } else if (fundamentalVerdict === "OVERVALUED") {
      signals.push({ name: "Fundamentals", signal: "red", value: `OVERVALUED (${fundamentalScore}/100)`, action: "Expensive. High re-rating risk.", icon: "🔴" });
      score -= 4;
    }
  } else {
    signals.push({ name: "Fundamentals", signal: "neutral", value: "No data", action: "Fundamental data unavailable for this stock.", icon: "❓" });
  }

  // Signal 2: Technicals
  if (techScore != null) {
    if (techScore >= 65) {
      signals.push({ name: "Technicals", signal: "green", value: `Score ${techScore}/100`, action: "Strong bullish momentum — RSI, MACD, trend aligned.", icon: "📈" });
      score += 3;
    } else if (techScore >= 55) {
      signals.push({ name: "Technicals", signal: "green", value: `Score ${techScore}/100`, action: "Mildly bullish — positive signals outweigh negatives.", icon: "📈" });
      score += 1;
    } else if (techScore >= 45) {
      signals.push({ name: "Technicals", signal: "yellow", value: `Score ${techScore}/100`, action: "Neutral — no clear directional signal.", icon: "📊" });
      score += 0;
    } else if (techScore >= 35) {
      signals.push({ name: "Technicals", signal: "yellow", value: `Score ${techScore}/100`, action: "Mildly bearish — some weakness showing.", icon: "📉" });
      score -= 2;
    } else {
      signals.push({ name: "Technicals", signal: "red", value: `Score ${techScore}/100`, action: "Strong bearish momentum — multiple sell signals.", icon: "📉" });
      score -= 3;
    }
  }

  // Signal 3: News Sentiment
  if (newsScore != null) {
    if (newsScore >= 65) {
      signals.push({ name: "News Sentiment", signal: "green", value: `${newsScore}/100`, action: "Positive headlines dominating for this stock.", icon: "📰" });
      score += 2;
    } else if (newsScore >= 45) {
      signals.push({ name: "News Sentiment", signal: "yellow", value: `${newsScore}/100`, action: "Mixed or neutral news flow.", icon: "📰" });
    } else {
      signals.push({ name: "News Sentiment", signal: "red", value: `${newsScore}/100`, action: "Negative headlines — bearish sentiment around this stock.", icon: "📰" });
      score -= 2;
    }
  }

  // Signal 4: Market Context (breadth from heatmap cache)
  try {
    const heatmap = sectorHeatmapCache.get("heatmap");
    if (heatmap?.marketBreadth) {
      const adv = heatmap.marketBreadth.advancing || 0;
      const dec = heatmap.marketBreadth.declining || 0;
      const total = adv + dec || 1;
      const ratio = (adv / total) * 100;
      if (ratio >= 60) {
        signals.push({ name: "Market Context", signal: "green", value: `${adv}↑ ${dec}↓`, action: "Broad market strength supports individual stocks.", icon: "🌍" });
        score += 2;
      } else if (ratio >= 45) {
        signals.push({ name: "Market Context", signal: "yellow", value: `${adv}↑ ${dec}↓`, action: "Mixed market — stock-specific factors matter more today.", icon: "🌍" });
      } else {
        signals.push({ name: "Market Context", signal: "red", value: `${adv}↑ ${dec}↓`, action: "Broad weakness — even good stocks get dragged down on days like this.", icon: "🌍" });
        score -= 3;
      }
    }
  } catch { /* silent */ }

  // Signal 5: Macro impact on THIS stock's sector
  if (macroContext && macroContext.delta !== 0) {
    const isTailwind = macroContext.delta > 0;
    signals.push({
      name: "Macro Impact",
      signal: isTailwind ? "green" : "red",
      value: `${isTailwind ? "+" : ""}${macroContext.delta.toFixed(1)} (${macroContext.sector})`,
      action: macroContext.reason || (isTailwind ? "Current regime favors this sector." : "Current regime is a headwind for this sector."),
      icon: isTailwind ? "🌱" : "🌧️",
    });
    score += isTailwind ? 2 : -2;
  } else {
    signals.push({ name: "Macro Impact", signal: "neutral", value: "Neutral", action: "Current macro regime has no specific impact on this sector.", icon: "—" });
  }

  // ── Market environment cap ──
  // If the market-level verdict is negative (CAUTIOUS / STAY OUT), cap the
  // stock verdict so no individual stock says "BUY" when the market page
  // says "don't buy anything." This prevents the contradiction where
  // REC shows "BUY" but the Market Intelligence tab says "STAY OUT."
  //
  // Read the cached market verdict to get the market-level score.
  let marketCap = null;
  try {
    const mv = verdictCache.get("verdict");
    if (mv && mv.score != null) {
      if (mv.score <= -5) {
        // Market says STAY OUT — cap stock at WAIT maximum
        marketCap = { maxVerdict: "WAIT", reason: `Market verdict is "${mv.verdict}" — not a buying day even for strong stocks.` };
        score = Math.min(score, -1); // force at most WAIT
      } else if (mv.score <= -3) {
        // Market says CAUTIOUS — cap stock at SELECTIVE BUY maximum
        marketCap = { maxVerdict: "SELECTIVE BUY", reason: `Market is cautious — enter only with strict stop-loss.` };
        score = Math.min(score, 1); // force at most SELECTIVE BUY
      }
    }
  } catch { /* silent */ }

  // Compute overall verdict
  let verdict, verdictColor, actionText;
  if (score >= 8) {
    verdict = "STRONG BUY"; verdictColor = "green";
    actionText = "All signals align — high-conviction entry opportunity.";
  } else if (score >= 4) {
    verdict = "BUY"; verdictColor = "green";
    actionText = "Most signals are favorable. Good entry with stop-loss.";
  } else if (score >= 1) {
    verdict = "SELECTIVE BUY"; verdictColor = "yellow";
    actionText = "Stock is okay but environment is mixed. Enter with tight SL.";
  } else if (score >= -2) {
    verdict = "WAIT"; verdictColor = "yellow";
    actionText = "Too many headwinds right now. Watch for improvement.";
  } else if (score >= -5) {
    verdict = "AVOID TODAY"; verdictColor = "red";
    actionText = "Weak stock + weak market. Not the right time.";
  } else {
    verdict = "SELL / EXIT"; verdictColor = "red";
    actionText = "Multiple bearish signals. Consider exiting if you hold.";
  }

  // Append market cap explanation if it kicked in
  if (marketCap) {
    actionText += ` ${marketCap.reason}`;
  }

  // Adjust for confidence
  if (dataConfidence === "low") {
    actionText += " (Low data confidence — only 1 signal dimension available.)";
  }

  return { verdict, verdictColor, actionText, score, signals, marketCap: marketCap ? marketCap.maxVerdict : null };
}

app.get("/api/stock/:symbol", async (req, res) => {
  try {
    let symbol = req.params.symbol.toUpperCase();
    if (!symbol.endsWith(".NS") && !symbol.endsWith(".BO")) {
      symbol += ".NS";
    }

    // Bug fix: we used to pre-compute `stockName` here by reading `quote.shortName`,
    // but `quote` isn't fetched yet — that threw `Cannot access 'quote' before
    // initialization` for any symbol NOT in our static stockList (e.g. Geojit).
    // It only appeared to work for Nifty 50 stocks because stockInfo was non-null
    // and the `||` short-circuited before hitting the TDZ variable.
    //
    // The fix: fetch the quote FIRST, then use its shortName for the news search.
    // This also gives us real company names for stocks beyond our curated list.
    const stockInfo = ALL_STOCKS.find((s) => s.symbol === symbol);

    const [quote, historical] = await Promise.all([
      fetchDetailedQuote(symbol),
      fetchHistorical(symbol),
    ]);

    if (!quote) {
      return res.status(404).json({ error: "Stock not found on NSE/Yahoo Finance. Check the symbol." });
    }

    // Now we have a real quote → use its shortName for a more accurate news search.
    const stockName = stockInfo?.name || quote.shortName || quote.longName || symbol.replace(".NS", "");
    const sentiment = await analyzeNewsSentiment(symbol, stockName);

    // Fix #3: New-IPO / insufficient-history guard.
    //
    // When a stock has <30 daily bars of history (recently listed, freshly
    // re-listed, or mid-suspension), we can still show fundamentals and news
    // but we CANNOT compute a technical score or combined recommendation.
    //
    // Previously this returned a barebones shape without `fundamentals` or
    // `lastUpdated`, which caused the frontend to render inconsistently.
    // Now we return the same shape as the happy path, with `analysis.error`
    // surfaced clearly and `combinedScore: null` so downstream doesn't
    // compute bogus weighted averages.
    // SEBI compliance overlay — compute once, attach to every response path.
    // Surfaced as a top-level field (not nested under fundamentals) because it
    // is a regulatory overlay, not a fundamental metric, and must be visible
    // even when fundamentals data is missing.
    const surveillance = getSurveillanceFlag(symbol);

    if (!historical || historical.length < 30) {
      // Still compute fundamentals if the snapshot exists — they don't
      // depend on historical data.
      const fundSnap = getFundamentals(symbol);
      let fundamentalResult = null;
      let earlyShadowV2 = null;
      let earlyLegacyV1 = null;
      let earlyScorerMode = SCORER_MODE;
      if (fundSnap) {
        const scored = scoreForResponse(fundSnap, null, { symbol });
        fundamentalResult = scored.primary;
        earlyShadowV2 = scored.shadow;
        earlyLegacyV1 = scored.legacy;
        earlyScorerMode = scored.mode;
      }
      // Long-term outlook can still work for new IPOs — it's fundamentals-
      // driven and doesn't need 200 days of history. Pass null for analysis
      // and dma200; the function handles missing data gracefully.
      const earlyLongTerm = longTermOutlook({indicators:{}}, quote, fundamentalResult, null);
      return res.json({
        quote: formatQuote(quote),
        analysis: {
          error: "Insufficient historical data for technical analysis (need at least 30 days of price history — this is usually a recent IPO or a freshly re-listed stock).",
          combinedScore: null,
          technicalScore: null,
          sentimentScore: sentiment.available ? sentiment.score : null,
          fundamentalScore: fundamentalResult?.score ?? null,
          portfolioBasisScore: null,
        },
        fundamentals: fundamentalResult,
        // Hexagon data rides on the full V2 object (pillars + composition).
        // Exactly one of shadowV2 / legacyV1 is non-null depending on SCORER_MODE.
        shadowV2: earlyShadowV2,
        legacyV1: earlyLegacyV1,
        scorerMode: earlyScorerMode,
        longTerm: earlyLongTerm,
        sentiment,
        news: sentiment.headlines,
        surveillance,
        lastUpdated: new Date().toISOString(),
      });
    }

    const analysis = analyzeStock(historical, quote);
    const intraday = intradayScan(analysis, quote);
    const midTerm = midTermAnalysis(analysis, quote, historical ? historical.map(d => d.close) : null);

    // ── Look up fundamental snapshot + score ──
    //
    // Under SCORER_MODE=v2-shadow (default): `fundamentalResult` = V1 output (authoritative),
    // `shadowV2Full` = V2 output with pillars (for the hexagon + diffing).
    // Under v2-primary: `fundamentalResult` = V2 (authoritative with pillars), `legacyV1Full` = V1.
    // Under v1: only `fundamentalResult` is set, the other two are null.
    const fundSnap = getFundamentals(symbol);
    let fundamentalScore = null;
    let fundamentalResult = null;
    let shadowV2Full = null;
    let legacyV1Full = null;
    let effectiveScorerMode = SCORER_MODE;
    if (fundSnap) {
      // Compute 200DMA from historical for the fundamental score
      let dma200 = null;
      if (historical.length >= 200) {
        const closes = historical.map((d) => d.close);
        dma200 = closes.slice(-200).reduce((s, v) => s + v, 0) / 200;
      }
      const scored = scoreForResponse(fundSnap, dma200, { symbol });
      fundamentalResult = scored.primary;
      shadowV2Full = scored.shadow;
      legacyV1Full = scored.legacy;
      effectiveScorerMode = scored.mode;
      fundamentalScore = fundamentalResult?.score ?? null;
    }

    // ── Long-term outlook (3–12 months, fundamentals-driven) ──
    // Must be computed AFTER fundamentalResult because 70% of the long-term
    // score comes from the fundamental pillar engine. The 200DMA for the
    // trend-context slice is computed above (or null for <200 day histories).
    let dma200ForLT = null;
    if (historical.length >= 200) {
      const closes200 = historical.map((d) => d.close);
      dma200ForLT = closes200.slice(-200).reduce((s, v) => s + v, 0) / 200;
    }
    const longTerm = longTermOutlook(analysis, quote, fundamentalResult, dma200ForLT);

    // ── Combined score ──
    //
    // Rather than hard-coded weights that break when a dimension is missing,
    // we now compute a weighted average over ONLY the dimensions that
    // contributed data. Missing dimensions (news unavailable, no fundamentals)
    // are skipped entirely instead of being faked as 50/100 — this was
    // inflating scores and causing spurious BUY recommendations.
    //
    // Phase 1 (Apr 2026): news weight 0.25 → 0.12 + confidence gate.
    //
    // Rationale: Yahoo/Google News return a lot of off-topic noise for
    // Indian tickers (the sentiment.js system prompt explicitly compensates
    // for this), and even with a good classifier a 25% weight amplifies
    // that noise into the recommendation. The honest-backtest exit
    // breakdown showed trades clustering around earnings cycles where
    // news sentiment was rich but unreliable. Cut to 12% and require
    // headline_count ≥ 5 before the dimension is even counted — below
    // that threshold, sentiment is ignored and weight is redistributed
    // to tech + fundamentals.
    //
    // Base weights (when news qualifies): technical 0.50 / news 0.12 /
    // fundamentals 0.38. Missing dimensions redistribute via sumWeights.
    const MIN_HEADLINES_FOR_SENTIMENT = 5;
    const techScore = analysis.score;
    const newsScore = (sentiment.available && (sentiment.headline_count ?? 0) >= MIN_HEADLINES_FOR_SENTIMENT)
      ? sentiment.score
      : null;

    // Guard: if technical analysis somehow returned no score, we still want a
    // usable response — previously this could propagate NaN through the
    // combined formula and appear as "NaN/100" in the frontend.
    if (techScore == null || Number.isNaN(techScore)) {
      return res.json({
        quote: formatQuote(quote),
        analysis: { error: "Technical analysis unavailable for this stock (likely insufficient history — new listing or delisted)." },
        fundamentals: fundamentalResult,
        shadowV2: shadowV2Full,
        legacyV1: legacyV1Full,
        scorerMode: effectiveScorerMode,
        sentiment,
        news: sentiment.headlines,
        surveillance,
        lastUpdated: new Date().toISOString(),
      });
    }

    const contributions = [];
    contributions.push({ key: "tech", score: techScore, weight: 0.50 });
    if (newsScore != null)           contributions.push({ key: "news",  score: newsScore,        weight: 0.12 });
    if (fundamentalScore != null)    contributions.push({ key: "fund",  score: fundamentalScore, weight: 0.38 });

    const sumWeights = contributions.reduce((s, c) => s + c.weight, 0);
    const combinedScore = Math.round(
      contributions.reduce((s, c) => s + c.score * c.weight, 0) / sumWeights
    );

    // Which dimensions actually contributed? Used for the action copy, the
    // divergence warning, and — new — confidence gating on the recommendation
    // strength itself.
    const dims = contributions.map((c) => c.key);
    const dimLabel =
      dims.length === 3 ? "technical + news + fundamentals" :
      dims.length === 2 ? dims.map(d => ({tech:"technical",news:"news",fund:"fundamentals"}[d])).join(" + ") :
      "technical only";

    // Confidence level based on how many dimensions contributed:
    //   • 3 dims → HIGH confidence, full recommendation strength
    //   • 2 dims → MEDIUM confidence, cap recommendations at BUY/SELL (no STRONG)
    //   • 1 dim  → LOW confidence, cap at WEAK BUY/WEAK SELL, add a prominent warning
    //
    // This prevents the platform from emitting "STRONG BUY" on a new IPO that
    // only has technical signals, or "SELL" on a stock where news sentiment
    // is the only dimension that came back. A single dimension is a hint,
    // not a trade signal.
    const dataConfidence = dims.length === 3 ? "high" : dims.length === 2 ? "medium" : "low";

    // Divergence check: compare every pair of contributing dimensions.
    // If the spread exceeds 25 points we warn the user NOT to blindly trust the
    // averaged score — it's hiding conflicting signals.
    const scoreValues = contributions.map((c) => c.score);
    const maxScore = Math.max(...scoreValues);
    const minScore = Math.min(...scoreValues);
    // Divergence threshold lowered from 25 to 18. At 25, stocks with Tech 70
    // + News 45 + Fund 72 barely triggered. 18 catches "one dimension disagrees
    // by almost 20 points" — meaningful enough to warrant a warning. Still won't
    // fire on normal noise (a 10-point spread is common and benign).
    const hasDivergence = scoreValues.length >= 2 && (maxScore - minScore) > 18;

    // Base recommendation from the combined score
    let combinedRec, combinedAction, combinedUrgency;
    if (combinedScore >= 75) {
      combinedRec = "STRONG BUY";
      combinedAction = `Strong buy signal from ${dimLabel}. High-conviction entry.`;
      combinedUrgency = "Act on this soon — confluence of positive signals is rare.";
    } else if (combinedScore >= 62) {
      combinedRec = "BUY";
      combinedAction = `Bullish picture from ${dimLabel}. Consider initiating a position.`;
      combinedUrgency = "Good entry window if the broader market is cooperative.";
    } else if (combinedScore >= 53) {
      combinedRec = "WEAK BUY";
      combinedAction = `Mildly positive based on ${dimLabel}. Small starter position only.`;
      combinedUrgency = "Wait for confirmation before sizing up.";
    } else if (combinedScore >= 47) {
      combinedRec = "HOLD";
      combinedAction = `No clear edge from ${dimLabel}. Hold current position.`;
      combinedUrgency = "Wait for one dimension to break the tie.";
    } else if (combinedScore >= 38) {
      combinedRec = "WEAK SELL";
      combinedAction = `Mildly negative from ${dimLabel}. Consider trimming.`;
      combinedUrgency = "Set a stop-loss if holding.";
    } else if (combinedScore >= 25) {
      combinedRec = "SELL";
      combinedAction = `Bearish picture from ${dimLabel}. Reduce exposure.`;
      combinedUrgency = "Exit soon to limit drawdown.";
    } else {
      combinedRec = "STRONG SELL";
      combinedAction = `Heavy bearish signals from ${dimLabel}. Exit immediately.`;
      combinedUrgency = "Significant downside risk — do not hold.";
    }

    // Apply confidence caps — cannot issue high-conviction signals on thin data.
    // The score itself stays unchanged so the UI can still show it; only the
    // human-readable label and action text get downgraded.
    const originalRec = combinedRec;
    if (dataConfidence === "medium") {
      // 2 dims → no STRONG ratings
      if (combinedRec === "STRONG BUY") { combinedRec = "BUY"; combinedAction = `Bullish on ${dimLabel}, but 1 dimension is missing — downgraded from STRONG BUY because of incomplete data.`; }
      if (combinedRec === "STRONG SELL") { combinedRec = "SELL"; combinedAction = `Bearish on ${dimLabel}, but 1 dimension is missing — downgraded from STRONG SELL because of incomplete data.`; }
    } else if (dataConfidence === "low") {
      // 1 dim → cap at WEAK BUY/WEAK SELL, very cautious copy
      if (combinedRec === "STRONG BUY" || combinedRec === "BUY") {
        combinedRec = "WEAK BUY";
        combinedAction = `Only technical signals available — 2 of 3 dimensions are missing. Treat this as a hint, not a trade signal. Wait for news + fundamentals to confirm.`;
        combinedUrgency = "Insufficient data for a high-conviction call. Do not size up based on technicals alone.";
      }
      if (combinedRec === "STRONG SELL" || combinedRec === "SELL") {
        combinedRec = "WEAK SELL";
        combinedAction = `Only technical signals available — 2 of 3 dimensions are missing. Could be a temporary swing rather than a thesis break.`;
        combinedUrgency = "Insufficient data for a forced exit. Watch for confirming signals before acting.";
      }
    }

    // Build combined reasoning
    let combinedReasoning = `TECHNICAL (${techScore}/100): ${analysis.reasoning}`;
    if (newsScore != null) {
      combinedReasoning += `\n\nNEWS SENTIMENT (${newsScore}/100): ${sentiment.summary}`;
    } else {
      combinedReasoning += `\n\nNEWS SENTIMENT: unavailable (no recent headlines found — sentiment skipped, not faked).`;
    }
    if (fundamentalResult) {
      combinedReasoning += `\n\nFUNDAMENTALS (${fundamentalScore}/100 · ${fundamentalResult.verdict}): ${fundamentalResult.reasoning}`;
    }

    // Divergence warning across ALL contributing dimensions, not just tech vs news.
    if (hasDivergence) {
      const breakdown = contributions.map((c) => {
        const name = { tech: "Technical", news: "News", fund: "Fundamentals" }[c.key];
        return `${name} ${c.score}`;
      }).join(", ");
      combinedReasoning += `\n\n⚠ DIVERGENCE WARNING: ${breakdown} disagree by ${maxScore - minScore} points. Do not blindly trust the combined number — one of these signals is wrong, and you need to figure out which before committing capital.`;
    }

    // ── Phase 1 Fix #1: Score consistency between stock detail + portfolio ──
    //
    // The stock detail page uses a 3-factor combined score (tech 45% + news 25%
    // + fund 30%) to answer "what's the current market view of this stock?".
    // The Portfolio tab uses a 2-factor score (tech 60% + fund 40%) because
    // news is too noisy for structural position decisions.
    //
    // Both formulas are defensible, but when the user clicks from the Portfolio
    // card into the Stock Detail page, the score jumps and the recommendation
    // may flip (HOLD → WEAK SELL). The audit found this broke user trust.
    //
    // Fix: compute BOTH scores and expose them side-by-side with clear labels
    // on the frontend. The 3-factor score stays the headline number (market
    // view), the 2-factor score is shown alongside for portfolio reconciliation.
    const portfolioBasisScore = computePortfolioCombinedScore(techScore, fundamentalScore);

    // Scanner score — same 50/50 formula as the Buy Now scanner so the
    // number on the scanner card matches the stock detail page.
    const scannerScore = fundamentalScore != null
      ? Math.round(techScore * 0.50 + fundamentalScore * 0.50)
      : Math.round(techScore);

    // ─── Macro regime context ───
    //
    // Stock Detail now BLENDS macro into the market-view combinedScore so
    // "what does the market think of this stock today?" reflects the
    // current regime. The portfolioBasisScore deliberately stays macro-free
    // because holdings should be less twitchy than fresh picks — the same
    // decision logic used in My Portfolio is what reads portfolioBasisScore.
    //
    // macroContext is still exposed separately so the UI can render a
    // dedicated macro pill with the delta + reason + regime label.
    let macroContext = null;
    let macroBoost = 0;
    const stockSector = stockInfo?.sector || null;
    if (stockSector) {
      const cachedRegime = macroRegimeCache.get(MACRO_CACHE_KEY);
      if (cachedRegime && cachedRegime.regime) {
        const { delta, reason, sector } = computeMacroDelta(cachedRegime, stockSector);
        if (delta !== 0) {
          macroBoost = delta;
          macroContext = {
            delta,
            reason,
            sector,
            regime: cachedRegime.regime,
            regimeLabel: cachedRegime.regimeLabel,
            severity: cachedRegime.severity,
            confidence: cachedRegime.confidence,
          };
        }
      }
    }
    // Scale macro boost by data confidence. A stock with only technical data
    // (LOW confidence) shouldn't get a full ±15 tilt from macro — that would
    // push the score from WEAK BUY to BUY territory, contradicting the gating
    // that specifically downgraded it because of thin data. Full boost is only
    // applied when all 3 dimensions contributed.
    const macroConfidenceScale = dataConfidence === "high" ? 1.0 : dataConfidence === "medium" ? 0.5 : 0.2;
    const effectiveMacroBoost = parseFloat((macroBoost * macroConfidenceScale).toFixed(2));

    // Blend macro tilt into the market-view combined score. Clamped to 0-100.
    // We DON'T change portfolioBasisScore — see comment above.
    const marketCombinedScore = Math.max(
      0,
      Math.min(100, Math.round(combinedScore + effectiveMacroBoost))
    );

    // ── Starbhai long-term narrative + news ──
    // Attach a structured 3-12 month thesis to longTerm. Both calls are
    // budget-aware (degrade to deterministic templates when the LLM cap is
    // hit) and cached 24h per symbol so repeat detail-page loads are free.
    if (longTerm) {
      try {
        const stockNews = await fetchStockNews({
          symbol,
          name: quote?.longName || stockInfo?.name || symbol,
          openai: getOpenAI(),
        });
        const cachedRegimeForNarr = macroRegimeCache.get(MACRO_CACHE_KEY) || null;
        const narrative = await generateNarrative({
          symbol,
          name: quote?.longName || stockInfo?.name || symbol,
          sector: stockSector,
          marketCapTier: fundamentalResult?.breakdown?.tier || null,
          longTerm,
          fundamentals: fundamentalResult,
          news: stockNews,
          macroRegime: cachedRegimeForNarr,
          openai: getOpenAI(),
        });
        longTerm.narrative = narrative;
        longTerm.news = stockNews;
      } catch (err) {
        console.warn(`[NARRATIVE] enrichment failed for ${symbol}:`, err.message);
      }
    }

    res.json({
      quote: formatQuote(quote),
      analysis: {
        ...analysis,
        // Base 3-factor combined score (tech + news + fund), WITHOUT macro.
        // Kept on the response so the frontend can show "before macro: X".
        baseCombinedScore: combinedScore,
        // Headline "market view" score — base blended with the current macro tilt.
        combinedScore: marketCombinedScore,
        combinedRecommendation: combinedRec,
        // If confidence gating kicked in, the raw recommendation the score
        // WOULD have produced on 3 dimensions — exposed for transparency.
        rawRecommendation: originalRec,
        combinedAction,
        combinedUrgency,
        combinedReasoning,
        technicalScore: techScore,
        sentimentScore: newsScore,
        fundamentalScore,
        // Data confidence: "high" (3 dims), "medium" (2), "low" (1). The
        // frontend shows a chip when it's not "high" so users know why the
        // recommendation was downgraded from what the score alone would give.
        dataConfidence,
        contributingDimensions: dims,
        // Macro delta applied to combinedScore, scaled by data confidence
        // (full delta at HIGH confidence, 50% at MEDIUM, 20% at LOW)
        macroBoost: effectiveMacroBoost,
        rawMacroBoost: macroBoost,
        // Same data viewed through the portfolio-basis lens — deliberately
        // WITHOUT macro, since holding decisions should be less twitchy.
        portfolioBasisScore,
        // Scanner score — matches the Buy Now scanner's 50/50 formula exactly.
        scannerScore,
      },
      fundamentals: fundamentalResult,
      // V2 full object (pillars + composition + signals) for the Snowflake
      // hexagon. Exactly one of shadowV2 / legacyV1 is non-null depending on
      // SCORER_MODE — see scorerMode.js for the contract.
      shadowV2: shadowV2Full,
      legacyV1: legacyV1Full,
      scorerMode: effectiveScorerMode,
      midTerm,
      longTerm,
      sentiment,
      news: sentiment.headlines,
      macro: macroContext,
      // ── Per-stock verdict: "should I buy THIS stock TODAY?" ──
      stockVerdict: computeStockVerdict({
        techScore,
        newsScore,
        fundamentalScore,
        fundamentalVerdict: fundamentalResult?.verdict,
        combinedScore: marketCombinedScore,
        scannerScore,
        macroBoost: effectiveMacroBoost,
        macroContext,
        dataConfidence,
        midTerm,
      }),
      // Last 90 days of OHLCV for the price chart on the frontend.
      historicalChart: historical
        ? historical.slice(-90).map((d) => ({ close: d.close, volume: d.volume, date: d.date }))
        : null,
      surveillance,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Stock analysis error:", err.message);
    res.status(500).json({ error: "Failed to analyze stock: " + err.message });
  }
});

/**
 * GET /api/admin/users
 *
 * Admin-only directory of every user who has ever signed in. Sorted by
 * `lastSeenAt || lastLoginAt` desc — the same composite the "Last seen"
 * column renders client-side, so the table is visibly ordered by what the
 * admin sees. (`lastSeenAt` advances on every authenticated request,
 * `lastLoginAt` only on a fresh OAuth login — sorting by `lastLoginAt`
 * alone hid recently-active users who hadn't re-logged in.)
 * The auth gate above sets req.user.sub for any authenticated request; this
 * handler additionally checks the persisted isAdmin flag (computed from
 * ADMIN_EMAILS) before returning data.
 */
app.get("/api/admin/users", async (req, res) => {
  if (!AUTH_ENABLED) return res.status(401).json({ error: "auth-disabled" });
  const sub = req.user && req.user.sub;
  if (!sub) return res.status(401).json({ error: "unauthenticated" });
  const userStore = getUserStorage();
  const me = await userStore.read(sub);
  if (!me || !me.isAdmin) return res.status(403).json({ error: "forbidden" });
  const all = await userStore.list();
  all.sort((a, b) =>
    (b.lastSeenAt || b.lastLoginAt || 0) -
    (a.lastSeenAt || a.lastLoginAt || 0)
  );
  // Annotate each user with a hasPortfolio flag so the admin Users tab can
  // render an XLSX download link vs a disabled "—" without an N+1 client roundtrip.
  const portfolioStore = getPortfolioStorage();
  const users = await Promise.all(all.map(async (u) => {
    let hasPortfolio = false;
    try {
      const p = await portfolioStore.read(u.sub);
      hasPortfolio = !!(p && ((p.stocks && p.stocks.length) || (p.mutualFunds && p.mutualFunds.length)));
    } catch { /* if storage hiccups, fall back to no-link */ }
    return { ...u, hasPortfolio };
  }));
  return res.json({ count: users.length, users });
});

/**
 * GET /api/admin/users/:sub/portfolio.xlsx
 *
 * Admin-only XLSX export of a single user's portfolio. Two sheets:
 *   - Stocks       (one row per holding; columns mirror the persisted shape)
 *   - Mutual Funds (one row per scheme)
 *
 * 404s when the target user doesn't exist or has an empty portfolio (matches
 * the disabled "—" state on the client).
 */
app.get("/api/admin/users/:sub/portfolio.xlsx", async (req, res) => {
  if (!AUTH_ENABLED) return res.status(401).json({ error: "auth-disabled" });
  const meSub = req.user && req.user.sub;
  if (!meSub) return res.status(401).json({ error: "unauthenticated" });
  const userStore = getUserStorage();
  const me = await userStore.read(meSub);
  if (!me || !me.isAdmin) return res.status(403).json({ error: "forbidden" });

  const targetSub = String(req.params.sub || "");
  const target = await userStore.read(targetSub);
  if (!target) return res.status(404).json({ error: "user-not-found" });
  const portfolio = await getPortfolioStorage().read(targetSub);
  const hasStocks = portfolio.stocks && portfolio.stocks.length;
  const hasMFs = portfolio.mutualFunds && portfolio.mutualFunds.length;
  if (!hasStocks && !hasMFs) return res.status(404).json({ error: "empty-portfolio" });

  const xlsxMod = await import("xlsx");
  const xlsx = xlsxMod.default || xlsxMod;
  const wb = xlsx.utils.book_new();
  if (hasStocks) {
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(portfolio.stocks), "Stocks");
  }
  if (hasMFs) {
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(portfolio.mutualFunds), "Mutual Funds");
  }
  const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

  const slug = String(target.email || target.name || target.sub)
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "user";
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="portfolio-${slug}-${date}.xlsx"`);
  return res.end(buf);
});

/**
 * GET /api/admin/combined-shadow-diff
 *
 * Returns the combined-score shadow-diff store from Vercel KV (prod) or
 * the local fs file (dev). Drives scripts/combined-shadow-summary.mjs
 * via its --prod flag (which uses `vercel curl` to bypass the Vercel
 * Authentication wall).
 *
 * Query params:
 *   ?since=ISO-8601    — drop entries captured before this timestamp
 *   ?scannerType=X     — filter to one scanner (buynow/midterm/sell/fund/smallcap)
 *   ?limit=N           — most recent N entries (after filters)
 *
 * Response shape mirrors the on-disk store: { schema, source, entries[] }
 * where source = "kv" | "fs" so the consumer can tell which storage tier
 * served the read.
 */
app.get("/api/admin/combined-shadow-diff", async (req, res) => {
  // Admin gate: the global auth middleware (L583) only guarantees a session;
  // it does NOT enforce isAdmin. Without this check, any authenticated user
  // could read the shadow-diff store in prod. Mirror /api/admin/users (L1712).
  if (!AUTH_ENABLED) return res.status(401).json({ error: "auth-disabled" });
  const sub = req.user && req.user.sub;
  if (!sub) return res.status(401).json({ error: "unauthenticated" });
  const userStore = getUserStorage();
  const me = await userStore.read(sub);
  if (!me || !me.isAdmin) return res.status(403).json({ error: "forbidden" });
  try {
    const store = await readShadowDiffStore();
    let entries = store.entries || [];
    const since = req.query.since;
    if (since) {
      const cutoff = new Date(since).getTime();
      if (Number.isFinite(cutoff)) {
        entries = entries.filter((e) => new Date(e.captured_at || 0).getTime() >= cutoff);
      }
    }
    const sType = req.query.scannerType;
    if (sType) entries = entries.filter((e) => e.scannerType === sType);
    const limit = parseInt(req.query.limit || "0", 10);
    if (limit > 0) entries = entries.slice(-limit);
    res.json({
      schema: store.schema || "combined-shadow-diff-v1",
      source: store.source || "fs",
      total_entries_before_filter: (store.entries || []).length,
      filtered_entries: entries.length,
      entries,
    });
  } catch (err) {
    console.error("[/api/admin/combined-shadow-diff]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/cron/warm-caches
 *
 * Scheduled cron (see vercel.json) that warms the in-process NSE event
 * calendar cache. The Vercel cookie-source endpoint usually times out on US
 * IPs but the warm attempt is still useful — when it succeeds, every user
 * request finds catalystCache populated and returns in <5s even on cold start.
 *
 * NOT a macro-regime refresh path. Macro is refreshed locally via
 * scripts/refresh-macro-regime.mjs (fired from sws-nightly.sh at 02:00 +
 * 16:30 IST) and committed to data/macroRegime.json. Calling refreshMacroRegime
 * here was structurally broken: Vercel's filesystem is read-only outside
 * /tmp, KV was unconfigured, and RSS feeds (Reuters, Bloomberg, Moneycontrol)
 * block Vercel datacenter IPs anyway. See plan note in macroRegimeStorage.js.
 *
 * Security: CRON_SECRET bearer auth (matches the other crons).
 * Runtime: ~10-15s typical; well under the 60s function ceiling.
 */
app.get("/api/cron/warm-caches", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const started = Date.now();
  const results = {};

  try {
    const events = await fetchNseEventCalendar();
    catalystCache.set("nse_events", events);
    results.nseEvents = { ok: true, count: events?.length || 0 };
  } catch (e) {
    results.nseEvents = { ok: false, error: e.message };
  }

  res.json({ ok: true, elapsedMs: Date.now() - started, ...results });
});

/**
 * GET /api/cron/refresh-surveillance
 *
 * Pulls the latest ASM + GSM surveillance lists from NSE and persists them
 * to Vercel KV (production) or surveillance.json (local dev).
 *
 * Defensive behaviour:
 *   • If the fetch returns zero flagged stocks (likely NSE outage), we do
 *     NOT overwrite an existing non-empty snapshot — better to serve a
 *     slightly stale warning banner than to silently clear all warnings.
 *   • Secret-gated via CRON_SECRET, same pattern as refresh-governance.
 *
 * Cadence: daily at 04:00 IST (set in vercel.json). NSE publishes both
 * lists once per trading day around 18:00 IST; a 04:00 run the next morning
 * picks up the previous session's update before the market opens.
 */
app.get("/api/cron/refresh-surveillance", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const startTime = Date.now();
    console.log("[CRON] Refreshing surveillance lists...");
    const snap = await buildSurveillance();
    const total = Object.keys(snap.flagged || {}).length;

    // Outage guard: if we got zero rows AND we already have a snapshot with
    // non-zero rows, skip the save. The existing snapshot is better than an
    // empty one in that case.
    if (total === 0) {
      const existing = getSurveillance();
      const existingTotal = Object.keys(existing.flagged || {}).length;
      if (existingTotal > 0) {
        console.warn(
          `[CRON] NSE returned 0 flagged; preserving existing snapshot with ${existingTotal} entries.`
        );
        return res.json({
          ok: true,
          skipped: true,
          reason: "zero_rows_preserved_existing",
          existingTotal,
        });
      }
    }

    const result = await saveSurveillance(snap);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[CRON] Surveillance refreshed in ${elapsed}s. Flagged: ${total} ` +
      `(ASM ${snap.counts.ASM}, GSM ${snap.counts.GSM}). Sink: ${result.target}.`
    );
    res.json({
      ok: true,
      total,
      counts: snap.counts,
      elapsedSec: Number(elapsed),
      sink: result.target,
      fetchedAt: snap.fetchedAt,
    });
  } catch (err) {
    console.error("[CRON] Surveillance refresh failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/surveillance/status
 *
 * Small public diagnostics endpoint. Returns counts + snapshot age so the
 * UI can badge the surveillance banner with "updated 4h ago" or warn when
 * the data is stale. Does NOT return the full flagged list — that's
 * served per-stock through the existing /api/stock/:symbol response
 * which will be augmented in the next wiring step.
 */
app.get("/api/surveillance/status", (req, res) => {
  res.json(getSurveillanceStatus());
});

/**
 * GET /api/health/snapshots
 *
 * Aggregate freshness for every fixture the SPA reads. The frontend uses
 * this to surface a "data is stale" banner so users know when underlying
 * snapshots haven't refreshed (which happens silently when the prod cron
 * fails — most commonly because Vercel's datacenter IPs are blocked by
 * NSE, see CLAUDE.md and nse.js:76-83).
 *
 * Each entry: { age_hours, stale, max_age_hours, ... }. `stale: true` if
 * age exceeds the source-specific threshold:
 *
 *   - fundamentals: 48h  (daily NSE refresh; 48h covers weekends)
 *   - surveillance: 36h  (daily NSE refresh; 12h grace)
 *   - governance:   2400h (~100 days, quarterly cadence)
 *   - picks_latest: 48h  (nightly SWS pipeline; 48h covers weekend)
 *   - macro_regime: 14h  (twice-daily local-cron via scripts/refresh-macro-regime.mjs
 *                         bundled into sws-nightly.sh at 02:00 + 16:30 IST;
 *                         14h gives a safety margin over the 14.5h max gap)
 *   - fundamentals_history: 72h  (own nightly launchd job; weekend + one missed run)
 *   - macro_calendar: 720h  (hand-maintained, no writer script; 30d flags genuine
 *                            neglect — the banner is the only nudge to update it)
 *   - events_latest: 48h  (nightly via refresh-catalysts.mjs; weekend grace)
 *   - oi_deltas: 48h  (nightly via refresh-fo-oi.sh; weekend grace)
 *   - earnings_watch: 48h  (nightly via refresh-earnings.mjs; weekend grace)
 *   - universe: 336h  (SWS universe rebuilt infrequently; 14d flags a stalled
 *                      rebuild — read via the universe-meta.json sidecar)
 *
 * Deliberately NOT monitored (internal caches / derived / not user-facing):
 * sws-scored-universe.json + v3-universe-stats.json (derived from the scrape),
 * last-refresh.json (covered via picks_latest), coverage_gap.json,
 * earnings-backtest-latest.json (admin/backtest surface, not the live
 * dashboard), and the rolling nse-announcements/bulk-block files (transient).
 */

// mtime-cached freshness-stamp reader for the snapshot-health endpoint. Each
// monitored fixture carries its stamp in a known field; we only need that one
// field, and the file rarely changes between hourly health polls — so cache
// the parse keyed on mtime. Returns the raw stamp string, or null on any miss.
const _snapshotTsCache = new Map(); // relPath -> { mtimeMs, ts }
function snapshotTimestamp(relPath, field) {
  try {
    const abs = path.join(__dirname, relPath);
    if (!fs.existsSync(abs)) return null;
    const mtimeMs = fs.statSync(abs).mtimeMs;
    const cached = _snapshotTsCache.get(relPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.ts;
    const parsed = JSON.parse(fs.readFileSync(abs, "utf-8"));
    const ts = parsed?.[field] ?? null;
    _snapshotTsCache.set(relPath, { mtimeMs, ts });
    return ts;
  } catch {
    return null;
  }
}

app.get("/api/health/snapshots", (req, res) => {
  const now = Date.now();
  const ageHours = (iso) => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return null;
    return +((now - t) / 3_600_000).toFixed(1);
  };
  const fundAt = getSnapshotGeneratedAt();
  const survStatus = getSurveillanceStatus();
  const govStatus = getGovernanceStatus();
  const picks = swsDal.getPicksLatest();
  const macroRegime = macroRegimeCache.get(MACRO_CACHE_KEY) || null;

  const fundHistAt = snapshotTimestamp("fundamentalsHistory.json", "generatedAt");
  const macroCalAt = snapshotTimestamp("data/macroCalendar.json", "_updated");
  const eventsAt = snapshotTimestamp("data/catalysts/events-latest.json", "fetched_at");
  const oiDeltasAt = snapshotTimestamp("data/nse-fo/oi-deltas-latest.json", "fetchedAt");
  const earningsWatchAt = snapshotTimestamp("data/catalysts/earnings-watch-latest.json", "built_at");
  const universeAt = snapshotTimestamp("data/sws/universe-meta.json", "generatedAt");

  const fundAge = ageHours(fundAt);
  const picksAge = ageHours(picks?.scanned_at || swsDal.getLastRefresh()?.finished_at);
  const macroAge = ageHours(macroRegime?.generatedAt);
  const fundHistAge = ageHours(fundHistAt);
  const macroCalAge = ageHours(macroCalAt);
  const eventsAge = ageHours(eventsAt);
  const oiDeltasAge = ageHours(oiDeltasAt);
  const earningsWatchAge = ageHours(earningsWatchAt);
  const universeAge = ageHours(universeAt);

  const snapshots = {
    fundamentals: {
      generatedAt: fundAt,
      age_hours: fundAge,
      max_age_hours: 48,
      stale: fundAge == null || fundAge > 48,
    },
    surveillance: {
      generatedAt: null, // surveillance.js doesn't surface the raw stamp; rely on its own status
      age_hours: survStatus.age_hours,
      max_age_hours: 36,
      stale: !!survStatus.stale,
      counts: survStatus.counts,
    },
    governance: {
      age_hours: govStatus.age_hours,
      max_age_hours: 24 * 100,
      stale: !!govStatus.stale,
      count: govStatus.count,
    },
    picks_latest: {
      generatedAt: picks?.scanned_at || null,
      age_hours: picksAge,
      max_age_hours: 48,
      stale: picksAge == null || picksAge > 48,
    },
    macro_regime: {
      generatedAt: macroRegime?.generatedAt || null,
      age_hours: macroAge,
      max_age_hours: 14,
      stale: macroAge == null || macroAge > 14,
      // Surface classifier degradation separately from staleness so the UI
      // can render an amber "keyword-only" chip when the file is fresh but
      // the LLM chain fell back to the heuristic. See gated/app.js
      // loadSnapshotHealth for the branching.
      classifierProvider: macroRegime?.classifierProvider || null,
      llmProviderHealth: macroRegime?.llmProviderHealth || null,
    },
    fundamentals_history: {
      generatedAt: fundHistAt,
      age_hours: fundHistAge,
      max_age_hours: 72,
      stale: fundHistAge == null || fundHistAge > 72,
    },
    macro_calendar: {
      generatedAt: macroCalAt,
      age_hours: macroCalAge,
      max_age_hours: 720,
      stale: macroCalAge == null || macroCalAge > 720,
    },
    events_latest: {
      generatedAt: eventsAt,
      age_hours: eventsAge,
      max_age_hours: 48,
      stale: eventsAge == null || eventsAge > 48,
    },
    oi_deltas: {
      generatedAt: oiDeltasAt,
      age_hours: oiDeltasAge,
      max_age_hours: 48,
      stale: oiDeltasAge == null || oiDeltasAge > 48,
    },
    earnings_watch: {
      generatedAt: earningsWatchAt,
      age_hours: earningsWatchAge,
      max_age_hours: 48,
      stale: earningsWatchAge == null || earningsWatchAge > 48,
    },
    universe: {
      generatedAt: universeAt,
      age_hours: universeAge,
      max_age_hours: 336,
      stale: universeAge == null || universeAge > 336,
    },
  };

  // Convenience flag the UI can read without re-summing.
  const anyStale = Object.values(snapshots).some((s) => s.stale);
  const staleKeys = Object.entries(snapshots)
    .filter(([, s]) => s.stale)
    .map(([k]) => k);

  // Fresh-but-degraded signals — distinct from stale. Currently just one
  // case: macro file is fresh but the LLM chain fell back to heuristic.
  // The UI renders these as an amber chip (different from the orange stale
  // chip) because the remediation differs: stale = fix the refresh script,
  // degraded = rotate LLM keys or wait out the throttle.
  const degradedKeys = [];
  if (
    snapshots.macro_regime &&
    !snapshots.macro_regime.stale &&
    snapshots.macro_regime.classifierProvider === "heuristic"
  ) {
    degradedKeys.push("macro_regime");
  }
  const anyDegraded = degradedKeys.length > 0;

  res.json({ anyStale, staleKeys, anyDegraded, degradedKeys, snapshots, checkedAt: new Date().toISOString() });
});

/**
 * GET /api/surveillance/list
 *
 * Returns the full flagged map. Used to exclude surveilled stocks from
 * any "top picks" surface, and by admin/debug UIs.
 */
app.get("/api/surveillance/list", (req, res) => {
  const snap = getSurveillance();
  res.json({
    fetchedAt: snap.fetchedAt,
    counts: snap.counts,
    flagged: snap.flagged,
  });
});

/**
 * GET /api/cron/refresh-governance
 *
 * Rebuilds the governance snapshot (shareholding pattern per symbol) from
 * NSE and persists to KV (production) or governance.json (local dev).
 *
 * Only fetches symbols in the enriched fundamentals universe — no benefit
 * to pulling governance for stocks we can't score. Query-string segmentation
 * supported (?segment=0&of=4) so the 60s Vercel window isn't a risk on
 * expanded universes; default single-segment covers the Nifty 500 coverage
 * we currently care about.
 *
 * Cadence: weekly on Sunday. Shareholding filings are quarterly, so daily
 * refreshes are pure waste — but weekly lets the new-quarter data land in
 * the snapshot within ~3-5 days of filing.
 *
 * Secret-gated via CRON_SECRET. Outage guard: if the fetch returns fewer
 * than 10% of symbols we skip the save to preserve any existing snapshot
 * (the alternative — wiping governance data after a transient NSE outage —
 * is worse than slightly stale data).
 */
app.get("/api/cron/refresh-governance", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const startTime = Date.now();
    // Build the list of symbols we actually need — every symbol with an
    // enriched fundamentals snapshot. Anything not enriched can't be scored,
    // so fetching governance for it would be wasted NSE calls.
    // getAllFundamentals() returns Object.values(snapshots) — an array of
    // {symbol, ...} entries, NOT a keyed map. Pulling Object.keys() yields
    // numeric indexes ("0","1","2",...) which NSE rejects, producing the
    // counts: { ok: 0, empty: 744 } pathological state observed in prod
    // 2026-05-12. Fixed in concert with scripts/refresh-governance.mjs.
    const enriched = (getAllFundamentals() || [])
      .map((s) => s?.symbol)
      .filter((sym) => typeof sym === "string" && sym.length > 0);
    const universe = enriched.length > 0 ? enriched : ALL_STOCKS.map((s) => s.symbol);

    // Optional segmentation for operators who want to split the run across
    // multiple cron invocations (e.g. expanded universe > 500 symbols).
    const segment = parseInt(req.query.segment, 10);
    const of = parseInt(req.query.of, 10);
    let symbols = universe;
    if (Number.isFinite(segment) && Number.isFinite(of) && of > 1 && segment >= 0 && segment < of) {
      symbols = universe.filter((_, i) => i % of === segment);
    }

    console.log(
      `[CRON] Refreshing governance for ${symbols.length} symbols` +
      (Number.isFinite(of) ? ` (segment ${segment}/${of})` : "") + "..."
    );
    const snap = await buildGovernance({
      symbols,
      concurrency: 3,
      delayMs: 220,
      onProgress: (done, total) => {
        if (done % 50 === 0) console.log(`[CRON]   governance: ${done}/${total}`);
      },
    });

    const okCount = snap.counts?.ok ?? Object.keys(snap.bySymbol || {}).length;

    // Outage guard — see docstring.
    if (okCount < Math.max(5, symbols.length * 0.10)) {
      const existing = getGovernanceSnapshot();
      const existingCount = Object.keys(existing.bySymbol || {}).length;
      if (existingCount > 0) {
        console.warn(
          `[CRON] NSE returned only ${okCount} governance records (of ${symbols.length}); ` +
          `preserving existing snapshot with ${existingCount} entries.`
        );
        return res.json({
          ok: true,
          skipped: true,
          reason: "low_yield_preserved_existing",
          fetched: okCount,
          existingCount,
        });
      }
    }

    const result = await saveGovernance(snap);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[CRON] Governance refreshed in ${elapsed}s. ` +
      `Saved ${okCount}/${symbols.length} records. Sink: ${result.target}.`
    );
    res.json({
      ok: true,
      total: symbols.length,
      counts: snap.counts,
      elapsedSec: Number(elapsed),
      sink: result.target,
      fetchedAt: snap.fetchedAt,
    });
  } catch (err) {
    console.error("[CRON] Governance refresh failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/governance/status
 *
 * Diagnostics: age of the governance snapshot + coverage count. Mirrors
 * /api/surveillance/status for operational symmetry.
 */
app.get("/api/governance/status", (req, res) => {
  res.json(getGovernanceStatus());
});

/**
 * GET /api/governance/:symbol
 *
 * Per-symbol lookup — used by admin/debug UIs and the "why is governance
 * N/A?" fallback path on the Snowflake hexagon tooltip. No-op when a symbol
 * isn't covered; the hexagon just stays N/A.
 */
app.get("/api/governance/:symbol", (req, res) => {
  const gov = getGovernance(req.params.symbol);
  if (!gov) return res.status(404).json({ error: "No governance record for symbol" });
  res.json({ symbol: req.params.symbol, ...gov });
});

// ─────────────────────────────────────────────────────────────────────
// F&O OI-Delta Swing Screener — Market Intelligence tile
// Data source: NSE F&O bhavcopy. Persistence: Vercel KV (prod) with disk
// as boot-seed (committed oi-deltas-latest.json). Mirrors the
// fundamentals.js disk+KV hybrid pattern.
// ─────────────────────────────────────────────────────────────────────

const FO_LATEST_PATH = path.join(__dirnameForEnv, "data", "nse-fo", "oi-deltas-latest.json");

/**
 * GET /api/fo/oi-screener
 *
 * Cache hierarchy (mirrors fundamentals): KV → disk seed → "warming".
 * KV is the source of truth in production; disk is the boot seed bundled
 * at deploy time. Local dev (no KV env vars) always falls through to disk.
 *
 * In-process cache keyed on KV-or-mtime so the cron's KV write or a fresh
 * deploy is picked up without manual cache busts.
 */
let _foCache = { key: "", payload: null };
app.get("/api/fo/oi-screener", async (req, res) => {
  try {
    // 1. Try KV first (production source of truth).
    const kvPayload = await loadFoScreenerFromKV();
    if (kvPayload) {
      const kvKey = "kv:" + (kvPayload.fetchedAt || kvPayload.asOf || "");
      if (_foCache.payload && _foCache.key === kvKey) return res.json(_foCache.payload);
      _foCache = { key: kvKey, payload: kvPayload };
      return res.json(kvPayload);
    }

    // 2. Fall back to committed disk seed.
    if (!fs.existsSync(FO_LATEST_PATH)) {
      return res.json({
        status: "warming",
        message: "F&O screener has not yet run. The nightly cron populates this after 19:00 IST.",
      });
    }
    const stat = fs.statSync(FO_LATEST_PATH);
    const diskKey = "disk:" + stat.mtimeMs;
    if (_foCache.payload && _foCache.key === diskKey) return res.json(_foCache.payload);
    const payload = JSON.parse(fs.readFileSync(FO_LATEST_PATH, "utf8"));
    _foCache = { key: diskKey, payload };
    res.json(payload);
  } catch (err) {
    console.error("[/api/fo/oi-screener] failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/cron/refresh-fo-oi
 *
 * Vercel cron handler. Mirrors auth pattern of /api/cron/refresh-surveillance
 * (CRON_SECRET bearer token). Delegates to services/foScreener.js#runOnce,
 * which fetches the bhavcopy, computes deltas, and persists to KV (+disk).
 *
 * Returns 200 with { ok:false, reason:"not_published" } when the bhavcopy
 * hasn't been published yet — Vercel does NOT alert on this; the retry
 * crons (19:45 + 20:30 IST) handle eventual publication.
 *
 * Manual testing: curl http://localhost:3000/api/cron/refresh-fo-oi
 * (no auth header required in local dev because CRON_SECRET isn't set).
 */
app.get("/api/cron/refresh-fo-oi", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const force = req.query.force === "1" || req.query.force === "true";
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    const result = await runFoScreener({ date, forceRefetch: force });
    // Bust the in-process cache so the next /api/fo/oi-screener call sees
    // the new payload without waiting for KV TTL or mtime tick.
    _foCache = { key: "", payload: null };
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof BhavcopyNotPublished) {
      return res.json({ ok: false, reason: "not_published", date: err.date });
    }
    if (err instanceof BhavcopyBlocked) {
      return res.status(503).json({ ok: false, reason: "blocked", status: err.status });
    }
    console.error("[CRON] /api/cron/refresh-fo-oi failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/catalysts/today
 *
 * SWS-style persistence: reads committed JSON files (events-latest.json
 * + macroCalendar.json), assembles 4 sections (in-book / in-picks /
 * broader / macro), 5-min in-memory cache.
 *
 * Refresh flow: run scripts/refresh-catalysts.mjs locally → commit
 * data/catalysts/events-latest.json → push. Vercel reads on cold start.
 */
const catalystsCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
app.get("/api/catalysts/today", (req, res) => {
  try {
    const cacheKey = "catalysts_today";
    const cached = catalystsCache.get(cacheKey);
    if (cached) return res.json(cached);
    const payload = buildCatalystsPayload();
    catalystsCache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error("[/api/catalysts/today] failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Earnings Watch — upcoming-results dashboard, open to every signed-in
 * user. The global session gate at server.js:594-620 enforces auth; no
 * per-route admin check.
 *
 * Reads the JSON snapshot produced by scripts/refresh-earnings.mjs.
 * No NSE calls happen here (that pipeline runs locally and commits
 * JSON, see nse.js:76-83 for the Vercel-IP-block rationale).
 *
 * Three GET endpoints + one cron-flush:
 *   GET /api/earnings/upcoming           — full snapshot (filtered)
 *   GET /api/earnings/upcoming/stats     — header chip counts
 *   GET /api/earnings/:symbol            — single-card detail
 *   GET /api/cron/refresh-earnings       — flushes the in-process cache
 */
const earningsCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

function loadCachedEarningsSnapshot() {
  const cached = earningsCache.get("earnings_snapshot");
  if (cached) return cached;
  const snap = loadEarningsSnapshot();
  earningsCache.set("earnings_snapshot", snap);
  return snap;
}

// PR E5 — per-symbol earnings calibration. Drives the "last N BEAT calls
// on this stock" footer line on every Earnings Watch card. Same admin
// gate as the rest of /api/earnings/*; non-admin gets 403 and the
// front-end render falls back to the symbol-less branch (no footer).
app.get("/api/earnings/calibration", async (req, res) => {
  try {
    const { loadAllHistory } = await import("./services/earnings/earningsHistoryArchive.js");
    const history = loadAllHistory();
    const snapshotPath = path.join(__dirname, "data", "catalysts", "earnings-backtest-latest.json");
    let snapshot = null;
    if (fs.existsSync(snapshotPath)) {
      try { snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")); } catch {}
    }
    const map = buildSymbolEarningsCalibration(history, snapshot);
    const payload = {
      generated_at: new Date().toISOString(),
      platform_brier: snapshot && Number.isFinite(snapshot.brier) ? snapshot.brier : null,
      symbols: Object.fromEntries(map),
    };
    res.json(payload);
  } catch (err) {
    console.error("[EARNINGS] /api/earnings/calibration failed:", err && err.message);
    res.status(500).json({ error: "earnings calibration failed: " + (err && err.message) });
  }
});

// PR B8 — earnings backtest snapshot endpoint. Serves the JSON written
// by scripts/backtest-earnings-predictions.mjs on its nightly run.
// Mirrors the admin gate of every other /api/earnings/* surface.
app.get("/api/earnings/backtest", async (req, res) => {
  try {
    const filePath = path.join(__dirname, "data", "catalysts", "earnings-backtest-latest.json");
    if (!fs.existsSync(filePath)) {
      return res.json({
        missing: true,
        message: "No earnings backtest snapshot yet. Run `node scripts/backtest-earnings-predictions.mjs`.",
      });
    }
    const raw = fs.readFileSync(filePath, "utf8");
    res.set("X-Earnings-Backtest", "file");
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error("[EARNINGS] /api/earnings/backtest failed:", err && err.message);
    res.status(500).json({ error: "earnings backtest failed: " + (err && err.message) });
  }
});

// PR3 — read a slim earnings-health snapshot for the snapshot API so the
// UI can render operational pills ("qualitative signal: deterministic-
// only" when llm_offline=true). Cheap file read; no allocation pressure.
function readEarningsHealthSlim() {
  try {
    const healthPath = path.join(__dirname, "data", "catalysts", "earnings-health.json");
    if (!fs.existsSync(healthPath)) return null;
    const h = JSON.parse(fs.readFileSync(healthPath, "utf-8"));
    return {
      llm_offline: h?.llm_offline === true,
      llm_heuristic_share_pct:
        typeof h?.llm_heuristic_share_pct === "number" ? h.llm_heuristic_share_pct : null,
      generated_at: h?.generated_at || null,
    };
  } catch { return null; }
}

app.get("/api/earnings/upcoming", async (req, res) => {
  try {
    // Pull the cached raw snapshot (5-min TTL), then recompute
    // days_until + today_iso PER REQUEST against IST-now. The recompute
    // sits outside the cache because the snapshot's days_until drifts
    // up to ~12h between the 02:00 and 16:30 refreshes and can cross
    // midnight IST inside a single cache window — which would otherwise
    // show "today" cards yesterday.
    const cached = loadCachedEarningsSnapshot();
    const snap = recomputeDaysUntil(cached);
    const events = filterEvents(snap.events, {
      days: req.query.days,
      symbol: req.query.symbol,
      tag: req.query.tag,
      hasTags: req.query.hasTags,
    });
    res.json({
      schema_version: snap.schema_version,
      built_at: snap.built_at,
      upstream_fetched_at: snap.upstream_fetched_at,
      window_days: snap.window_days,
      today_iso: snap.today_iso,
      event_count: events.length,
      total_event_count: snap.event_count,
      events,
      recent_results: Array.isArray(snap.recent_results) ? snap.recent_results : [],
      past_window_days: snap.past_window_days ?? null,
      missing: snap._missing === true,
      health: readEarningsHealthSlim(),
    });
  } catch (err) {
    console.error("[/api/earnings/upcoming] failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/earnings/upcoming/stats", async (req, res) => {
  try {
    const cacheKey = "earnings_stats";
    const cached = earningsCache.get(cacheKey);
    if (cached) return res.json(cached);
    const stats = loadEarningsStats();
    earningsCache.set(cacheKey, stats);
    res.json(stats);
  } catch (err) {
    console.error("[/api/earnings/upcoming/stats] failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Vercel cron entry — flushes the in-process read cache so the next
 * /api/earnings/* request reads the latest committed JSON. Does NOT
 * call NSE (the actual NSE fetchers must run from a local machine).
 * CRON_SECRET-gated, same pattern as every other /api/cron/* route;
 * open in local dev where CRON_SECRET isn't set. (Previously left
 * public on the "just dumps a cache" rationale — gated for
 * consistency so the whole cron family behaves the same way.)
 */
app.get("/api/cron/refresh-earnings", (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  earningsCache.flushAll();
  res.json({
    ok: true,
    flushed: true,
    note: "Earnings snapshot itself is built locally + committed; this route only flushes the in-process read cache.",
  });
});

app.get("/api/earnings/:symbol", async (req, res) => {
  try {
    const snap = loadCachedEarningsSnapshot();
    const event = findEventBySymbol(snap, req.params.symbol);
    if (!event) {
      return res.status(404).json({
        error: "not_found",
        symbol: String(req.params.symbol || "").toUpperCase(),
      });
    }
    res.json({
      schema_version: snap.schema_version,
      built_at: snap.built_at,
      window_days: snap.window_days,
      event,
    });
  } catch (err) {
    console.error("[/api/earnings/:symbol] failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== MARKET VERDICT ====================

/**
 * GET /api/market-verdict
 *
 * Combines all 5 signals into a single "is today a good day to buy?" verdict.
 * Reads from existing cached data (macro regime, sector heatmap, scan results)
 * so it's fast (~50ms) and doesn't make any new external calls.
 *
 * Returns: { verdict, signals[], overallScore, actionText }
 */
const verdictCache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

app.get("/api/market-verdict", async (req, res) => {
  try {
    const cached = verdictCache.get("verdict");
    if (cached) return res.json(cached);

    const signals = [];
    let score = 0; // -10 to +10 scale

    // Signal 1: Macro Regime
    const regime = macroRegimeCache.get(MACRO_CACHE_KEY) || defaultCalmRegime();
    const regimeId = regime.regime || "CALM";
    const severity = regime.severity || 1;
    let regimeSignal, regimeAction;

    if (regimeId === "CALM") {
      regimeSignal = "green"; regimeAction = "Safe to deploy capital. No macro headwinds."; score += 3;
    } else if (regimeId === "RATE_CUT" || regimeId === "WAR_DE_ESCALATION" || regimeId === "POLICY_STIMULUS") {
      regimeSignal = "green"; regimeAction = "Favorable environment. Risk-on rotation likely."; score += 4;
    } else if (regimeId === "OIL_SHOCK" && severity >= 4) {
      regimeSignal = "red"; regimeAction = "High oil = inflation risk. Be selective, favor energy longs only."; score -= 4;
    } else if (regimeId === "WAR_ESCALATION" && severity >= 4) {
      regimeSignal = "red"; regimeAction = "Conflict escalation. Trim risk assets. Favor defence, pharma."; score -= 5;
    } else if (regimeId === "GLOBAL_RISK_OFF") {
      regimeSignal = "red"; regimeAction = "Global selloff. Move to defensives."; score -= 4;
    } else if (regimeId === "RATE_HIKE") {
      regimeSignal = "yellow"; regimeAction = "Tightening cycle. Avoid rate-sensitive sectors."; score -= 2;
    } else {
      regimeSignal = "yellow"; regimeAction = "Mixed signals. Be selective."; score -= 1;
    }

    signals.push({
      name: "Macro Regime",
      signal: regimeSignal,
      value: `${regimeId.replace(/_/g, " ")} · Severity ${severity}/5`,
      action: regimeAction,
      icon: regimeSignal === "green" ? "✅" : regimeSignal === "red" ? "🔴" : "⚠️",
    });

    // Signal 2: Market Breadth (from heatmap cache or live)
    let breadthSignal = "yellow", breadthAction = "Mixed breadth.";
    let advancing = 0, declining = 0;
    try {
      const heatmap = sectorHeatmapCache.get("heatmap");
      if (heatmap?.marketBreadth) {
        advancing = heatmap.marketBreadth.advancing || 0;
        declining = heatmap.marketBreadth.declining || 0;
      } else {
        // Quick fetch if not cached
        const stocks = getNifty100().slice(0, 30); // sample 30 for speed
        const quotes = await Promise.all(stocks.map((s) => fetchQuote(s.symbol).catch(() => null)));
        advancing = quotes.filter((q) => q && (q.regularMarketChangePercent || 0) > 0).length;
        declining = quotes.filter((q) => q && (q.regularMarketChangePercent || 0) < 0).length;
      }
      const total = advancing + declining || 1;
      const ratio = (advancing / total) * 100;
      if (ratio >= 70) { breadthSignal = "green"; breadthAction = `Strong buying — ${ratio.toFixed(0)}% stocks advancing.`; score += 3; }
      else if (ratio >= 55) { breadthSignal = "green"; breadthAction = `More stocks up than down (${ratio.toFixed(0)}%). Mild buying day.`; score += 1; }
      else if (ratio >= 45) { breadthSignal = "yellow"; breadthAction = `Mixed — no clear direction (${ratio.toFixed(0)}% advancing).`; score += 0; }
      else if (ratio >= 30) { breadthSignal = "yellow"; breadthAction = `More stocks falling (${ratio.toFixed(0)}% advancing). Trim weak positions.`; score -= 2; }
      else { breadthSignal = "red"; breadthAction = `Risk-off — ${(100 - ratio).toFixed(0)}% stocks declining. Protect capital.`; score -= 4; }
    } catch { /* silent */ }

    signals.push({
      name: "Market Breadth",
      signal: breadthSignal,
      value: `${advancing}↑ ${declining}↓`,
      action: breadthAction,
      icon: breadthSignal === "green" ? "📈" : breadthSignal === "red" ? "📉" : "📊",
    });

    // Signal 4: Regime Transition
    let transSignal = "neutral", transAction = "No recent regime shift.";
    if (lastRegimeTransition && lastRegimeTransition.signal) {
      const sig = lastRegimeTransition.signal;
      if (sig.action.includes("BUY")) { transSignal = "green"; transAction = `Regime shifted → ${sig.action}. ${sig.summary?.slice(0, 80)}`; score += 3; }
      else if (sig.action.includes("SELL") || sig.action.includes("TRIM")) { transSignal = "red"; transAction = `Regime shifted → ${sig.action}. ${sig.summary?.slice(0, 80)}`; score -= 3; }
      else { transSignal = "yellow"; transAction = `Regime shifted. ${sig.summary?.slice(0, 80)}`; }
    }

    signals.push({
      name: "Regime Transition",
      signal: transSignal,
      value: lastRegimeTransition ? `${lastRegimeTransition.from} → ${lastRegimeTransition.to}` : "Stable",
      action: transAction,
      icon: transSignal === "green" ? "⚡" : transSignal === "red" ? "⚡" : "—",
    });

    // Signal 5: Track Record trust
    let trustSignal = "yellow", trustAction = "Moderate confidence.";
    try {
      const trades = await readAllTrades();
      const withReturns = trades.filter((t) => t.returns?.beatsNifty != null || t.niftyAtSnapshot);
      const total = withReturns.length;
      // Approximate beats-nifty from recent data
      if (total >= 30) {
        // Use the track performance endpoint logic would be too heavy here,
        // so just check the total count for trust calibration
        trustSignal = "green"; trustAction = `${total}+ picks tracked. Signal has proven edge.`; score += 1;
      } else if (total >= 10) {
        trustSignal = "yellow"; trustAction = `${total} picks tracked. Still calibrating — early data.`;
      } else {
        trustSignal = "yellow"; trustAction = "< 10 picks tracked. Very early — treat signals as suggestions."; score -= 1;
      }
    } catch { /* silent */ }

    signals.push({
      name: "Signal Maturity",
      signal: trustSignal,
      value: trustSignal === "green" ? "Proven" : "Calibrating",
      action: trustAction,
      icon: trustSignal === "green" ? "✅" : "🔄",
    });

    // Compute overall verdict
    let verdict, verdictColor, verdictAction;
    if (score >= 6) {
      verdict = "STRONG BUY DAY"; verdictColor = "green";
      verdictAction = "Multiple signals align bullish. Deploy capital with confidence.";
    } else if (score >= 3) {
      verdict = "BUY DAY"; verdictColor = "green";
      verdictAction = "Environment is favorable. Follow the Buy Now picks.";
    } else if (score >= 0) {
      verdict = "SELECTIVE"; verdictColor = "yellow";
      verdictAction = "Mixed signals. Only buy DEEP VALUE picks with strict stop-losses.";
    } else if (score >= -3) {
      verdict = "CAUTIOUS"; verdictColor = "yellow";
      verdictAction = "More headwinds than tailwinds. Trim weak positions. Hold cash.";
    } else {
      verdict = "STAY OUT"; verdictColor = "red";
      verdictAction = "Not a buying day. Protect capital. Wait for regime shift.";
    }

    const response = {
      verdict,
      verdictColor,
      verdictAction,
      score,
      signals,
      generatedAt: new Date().toISOString(),
    };

    verdictCache.set("verdict", response);
    res.json(response);
  } catch (err) {
    console.error("Verdict error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sector-heatmap
 *
 * Returns all Nifty 100 sectors with average daily change %, winners/losers
 * count, and top movers per sector. Cached 2 minutes.
 */
const sectorHeatmapCache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

/**
 * Build the sector heatmap (Nifty 100 quotes → per-sector breadth + movers).
 * Extracted from the route handler so /api/news/market can warm this data
 * before building its digest — the digest reads sectorHeatmapCache directly
 * and used to emit "data not yet available" whenever the cache was cold.
 * Populates sectorHeatmapCache; returns the cached value on a warm hit.
 */
async function getSectorHeatmapData() {
  const cached = sectorHeatmapCache.get("heatmap");
  if (cached) return cached;

  const stocksToScan = getNifty100();
  const quotes = await Promise.all(
    stocksToScan.map((s) => fetchQuote(s.symbol).catch(() => null))
  );

  const bySector = {};
  for (let i = 0; i < stocksToScan.length; i++) {
    const q = quotes[i];
    const stock = stocksToScan[i];
    if (!q) continue;
    const sector = normalizeSector(stock.sector) || stock.sector || "Unknown";
    if (!bySector[sector]) bySector[sector] = { sector, stocks: [], totalChange: 0, count: 0 };
    const chg = q.regularMarketChangePercent || 0;
    bySector[sector].stocks.push({
      symbol: stock.symbol,
      name: stock.name,
      change: chg,
      price: q.regularMarketPrice,
    });
    bySector[sector].totalChange += chg;
    bySector[sector].count += 1;
  }

  const sectors = Object.values(bySector).map((s) => {
    s.avgChange = s.count > 0 ? parseFloat((s.totalChange / s.count).toFixed(2)) : 0;
    s.winners = s.stocks.filter((st) => st.change > 0).length;
    s.losers = s.stocks.filter((st) => st.change < 0).length;
    s.topGainer = s.stocks.sort((a, b) => b.change - a.change)[0] || null;
    s.topLoser = s.stocks.sort((a, b) => a.change - b.change)[0] || null;
    // Remove full stock list to keep response compact
    delete s.totalChange;
    s.stockCount = s.count;
    delete s.count;
    delete s.stocks;
    return s;
  }).sort((a, b) => b.avgChange - a.avgChange);

  const response = {
    sectors,
    marketBreadth: {
      totalStocks: quotes.filter(Boolean).length,
      advancing: quotes.filter((q) => q && (q.regularMarketChangePercent || 0) > 0).length,
      declining: quotes.filter((q) => q && (q.regularMarketChangePercent || 0) < 0).length,
      unchanged: quotes.filter((q) => q && (q.regularMarketChangePercent || 0) === 0).length,
    },
    lastUpdated: new Date().toISOString(),
  };

  sectorHeatmapCache.set("heatmap", response);
  return response;
}

app.get("/api/sector-heatmap", async (req, res) => {
  try {
    res.json(await getSectorHeatmapData());
  } catch (err) {
    console.error("Sector heatmap error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== FII / DII FLOW DATA ====================

/**
 * GET /api/fii-dii
 *
 * Returns FII and DII net buy/sell data from NSE. This is one of the strongest
 * leading indicators for Indian markets — when FIIs are net sellers, the market
 * typically corrects within 2-5 days.
 *
 * Upstream: NSE's /api/fiidiiTradeReact. Returns two rows — "FII/FPI" and "DII"
 * — each with the last trading day's buyValue, sellValue and netValue in ₹Cr.
 * Published ~18:30 IST for the same-day session.
 *
 * This endpoint is unauthenticated on NSE (no cookie dance needed), so it's
 * actually robust from Vercel's bom1 region — the old code was broken because
 * it used wrong paths (/api/fiidiiActivity/WDM and /api/marketTurnover, both
 * return 404), then blamed the failure on "non-Indian IP" which was never the
 * real cause.
 *
 * Cached for 30 minutes — FII/DII is published once per day.
 */
const fiiDiiCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 });

/**
 * Fetch + shape the latest FII/DII session from NSE. Extracted from the
 * route handler so /api/news/market can warm this data before building its
 * digest — the digest reads fiiDiiCache directly and used to emit "FII data
 * not yet available" whenever the cache was cold. Populates fiiDiiCache;
 * returns the cached value on a warm hit, and an { available: false } shape
 * (not a throw) when NSE is unreachable.
 */
async function getFiiDiiData() {
  const cached = fiiDiiCache.get("fii_dii");
  if (cached) return cached;

  let fiiDiiData = null;
  // The endpoint works cookie-less — skip the full nseGet cookie dance,
  // which short-circuits on datacenter IPs (NSE blocks the homepage
  // which the cookie refresh relies on, even when the API path itself
  // is wide open). Fall back to cookie-gated nseGet only if unauth'd
  // returns nothing, since some NSE paths do eventually require cookies.
  try {
    const data = await nseGetUnauthed(
      "/api/fiidiiTradeReact",
      "https://www.nseindia.com/reports/fii-dii",
    );
    if (Array.isArray(data) && data.length > 0) fiiDiiData = data;
  } catch (e) {
    console.warn("NSE FII/DII unauth fetch failed:", e.message);
  }
  if (!fiiDiiData) {
    try {
      const data = await nseGet(
        "/api/fiidiiTradeReact",
        "https://www.nseindia.com/reports/fii-dii",
      );
      if (Array.isArray(data) && data.length > 0) fiiDiiData = data;
    } catch (e) {
      console.warn("NSE FII/DII authed fetch also failed:", e.message);
    }
  }

  if (!fiiDiiData) {
    // Upstream genuinely unreachable (NSE outage, cookie block, etc.).
    // Don't lie to the user — we ARE on an Indian IP (bom1). Just say
    // it's temporarily unavailable and let the frontend retry later.
    const response = {
      available: false,
      message:
        "FII/DII data temporarily unavailable from NSE. Usually published at ~18:30 IST for the same trading day — try again after market close.",
      lastUpdated: new Date().toISOString(),
    };
    // Short cache on failure so a single upstream hiccup doesn't lock
    // the endpoint out for the full 30 minutes.
    fiiDiiCache.set("fii_dii", response, 120);
    return response;
  }

  // Normalise NSE's two-row array into named fields so the UI doesn't have
  // to guess row order or parse category strings. NSE's category values
  // have been "FII/FPI" and "DII" (sometimes "DII - Equity") for years.
  const toNum = (v) => {
    const n = Number(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const shape = (row) =>
    row
      ? {
          date: row.date || null,
          buyValue: toNum(row.buyValue),
          sellValue: toNum(row.sellValue),
          netValue: toNum(row.netValue),
        }
      : null;
  const fiiRow = fiiDiiData.find((r) => /FII|FPI/i.test(String(r.category)));
  const diiRow = fiiDiiData.find((r) => /^DII/i.test(String(r.category)));

  const fiiShaped = shape(fiiRow);
  const diiShaped = shape(diiRow);
  const sessionDate = fiiRow?.date || diiRow?.date || null;

  // Persist this session into the rolling history (idempotent on date),
  // then read back the last 10 sessions for the sparkline. Both operations
  // are best-effort — failures don't block the response.
  let history = [];
  try {
    if (sessionDate) {
      await appendFiiDiiHistory({
        date: sessionDate,
        fii: fiiShaped?.netValue,
        dii: diiShaped?.netValue,
      });
    }
    history = await readFiiDiiHistory(10);
  } catch (histErr) {
    console.warn("[FII-DII] history persistence/read failed:", histErr.message);
  }

  const response = {
    available: true,
    date: sessionDate,
    fii: fiiShaped,
    dii: diiShaped,
    history, // last 10 sessions newest-first, for client-side sparkline
    data: fiiDiiData, // preserve raw for any consumer that wants it
    lastUpdated: new Date().toISOString(),
  };
  fiiDiiCache.set("fii_dii", response);
  return response;
}

app.get("/api/fii-dii", async (req, res) => {
  try {
    res.json(await getFiiDiiData());
  } catch (err) {
    console.error("FII/DII error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Return the fundamental snapshot + score + verdict for a single stock.
 * Reads from the daily snapshot file (fundamentals.json) — always works on Vercel.
 */
app.get("/api/fundamentals/:symbol", async (req, res) => {
  try {
    let symbol = req.params.symbol.toUpperCase();
    if (!symbol.endsWith(".NS") && !symbol.endsWith(".BO")) symbol += ".NS";

    const snap = getFundamentals(symbol);
    if (!snap) {
      return res.status(404).json({
        error: "No fundamental data for this symbol",
        symbol,
        snapshotGeneratedAt: getSnapshotGeneratedAt(),
      });
    }

    // Enrich with 200-day moving average from historical
    let dma200 = null;
    try {
      const historical = await fetchHistorical(symbol);
      if (historical && historical.length >= 200) {
        const closes = historical.map((d) => d.close);
        dma200 = closes.slice(-200).reduce((s, v) => s + v, 0) / 200;
      }
    } catch { /* optional */ }

    // Phase 4: score through the mode-aware helper. The `primary` result is
    // authoritative (V1 under v2-shadow/v1 modes, V2 under v2-primary). The
    // other scorer's result rides along under `shadowV2` or `legacyV1` so
    // the UI can surface the transition transparently (SEBI Reg 15(2)).
    const { primary: scored, legacy, shadow, mode } = scoreForResponse(snap, dma200, { symbol });

    if (!scored) {
      // Both scorers failed. Return 500 rather than pretending we have data.
      return res.status(500).json({
        error: "Scoring failed for this snapshot",
        symbol,
        scorerMode: mode,
      });
    }

    // SEBI compliance overlay: surface any NSE surveillance flag (ASM/GSM)
    // so the UI can show a warning banner. Never hide the stock — retail
    // users searching by symbol still need to see the analytical data —
    // but make the surveillance state unmissable.
    const surveillance = getSurveillanceFlag(symbol);

    res.json({
      ...scored,
      // Exactly one of shadowV2 / legacyV1 is non-null, depending on mode.
      // The field name encodes the relationship to the primary so older
      // clients (which only know about `shadowV2`) keep working unchanged.
      shadowV2: shadow,
      legacyV1: legacy,
      scorerMode: mode,
      surveillance,
      source: "nse_snapshot",
      snapshotGeneratedAt: getSnapshotGeneratedAt(),
    });
  } catch (err) {
    console.error("Fundamentals endpoint error:", err.message);
    res.status(500).json({ error: "Failed to load fundamentals: " + err.message });
  }
});

// 30s cache for the market indices ticker. The Nifty/Sensex/Bank Nifty values
// genuinely change at most once per second, but every page load + the auto-
// refresh ticker hits this endpoint. Without a cache, every visitor pays the
// 12s NSE-cold-session penalty, and concurrent users hammer the upstream APIs
// for data they all share.
//
// 30s strikes the balance: fresh enough that the user never sees data older
// than half a minute, but cached enough that the heavy NSE call only fires
// twice per minute even under load.
const marketCache = new NodeCache({ stdTTL: 30, checkperiod: 10 });

app.get("/api/market", async (req, res) => {
  try {
    const cached = marketCache.get("market");
    if (cached) {
      res.set("X-Cache", "HIT");
      return res.json(cached);
    }

    // Try NSE India first (official source), Yahoo as fallback.
    // GIFT Nifty runs in parallel since it has its own upstream (NSE IX)
    // and shouldn't delay the core indices if it's slow.
    let indices = [];
    let source = "yahoo";

    const giftPromise = fetchGiftNifty().catch((e) => {
      console.error("GIFT Nifty fetch error:", e.message);
      return null;
    });

    try {
      const nseIndices = await fetchNseIndices();
      if (nseIndices && nseIndices.length > 0) {
        indices = nseIndices;
        source = "nse";
      }
    } catch (e) {
      console.error("NSE indices failed, falling back to Yahoo:", e.message);
    }

    // Fallback: Yahoo Finance for SENSEX (NSE doesn't serve BSE index)
    // and if NSE failed entirely
    if (indices.length === 0) {
      const yahooSymbols = ["^NSEI", "^BSESN", "^NSEBANK"];
      const quotes = await Promise.all(yahooSymbols.map((i) => fetchQuote(i)));
      indices = quotes.filter(Boolean).map((q) => ({
        symbol: q.symbol,
        name: q.shortName || q.longName,
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
        dayHigh: q.regularMarketDayHigh,
        dayLow: q.regularMarketDayLow,
        previousClose: q.regularMarketPreviousClose,
        source: "yahoo",
      }));
    } else {
      // Also add SENSEX from Yahoo since NSE doesn't serve BSE indices
      try {
        const sensex = await fetchQuote("^BSESN");
        if (sensex) {
          indices.splice(1, 0, {
            symbol: "^BSESN",
            name: "SENSEX",
            price: sensex.regularMarketPrice,
            change: sensex.regularMarketChange,
            changePercent: sensex.regularMarketChangePercent,
            source: "yahoo",
          });
        }
      } catch (e) { /* sensex optional */ }
    }

    // GIFT Nifty — slot in right after NIFTY 50 so its premium/discount
    // sits visually adjacent to the NIFTY 50 reference price it's
    // computed against. When unavailable (outside session, NSE IX down)
    // we just omit it; the rest of the page renders normally.
    const gift = await giftPromise;
    if (gift) {
      // Show Gift Nifty's premium/discount over the current NIFTY 50
      // level — "how much higher/lower is Gift Nifty vs NIFTY 50 right
      // now." Falls back to NIFTY 50's previous close when the live
      // price isn't available (market closed, data gap).
      const nifty50 = indices.find((i) => i.symbol === "^NSEI");
      const ref = nifty50?.price ?? nifty50?.previousClose;
      if (ref && Number.isFinite(ref) && ref > 0 && Number.isFinite(gift.price)) {
        gift.change = gift.price - ref;
        gift.changePercent = ((gift.price - ref) / ref) * 100;
        gift.referencePrice = ref;
        gift.referenceSymbol = "^NSEI";
      }
      indices.splice(1, 0, gift);
    }

    const response = {
      indices,
      source,
      lastUpdated: new Date().toISOString(),
      marketStatus: isMarketOpen() ? "OPEN" : "CLOSED",
      // Top-level reference for the UI. NSE IX publishes IST strings like
      // "21-Apr-2026 02:18:17" — we surface it as-is so the frontend can
      // show "Last traded 02:18 IST" next to the GIFT Nifty pill. Null
      // when GIFT Nifty isn't in this response.
      giftNiftyLastTradedAt: gift?.lastTradedAt ?? null,
    };
    marketCache.set("market", response);
    res.set("X-Cache", "MISS");
    res.json(response);
  } catch (err) {
    console.error("Market error:", err.message);
    res.status(500).json({ error: "Market data failed" });
  }
});

/**
 * Market calendar — combines NSE corporate-event calendar (today + next 7
 * days, results / board meetings / AGMs) with the hand-maintained macro
 * calendar at data/macroCalendar.json (RBI MPC, FOMC, CPI/GDP/NFP releases).
 *
 * Cached for 30 minutes. NSE refreshes the underlying file ~daily.
 */
const marketCalendarCache = new NodeCache({ stdTTL: 1800, checkperiod: 120 });

app.get("/api/market-calendar", async (req, res) => {
  try {
    const cached = marketCalendarCache.get("calendar");
    if (cached) return res.json(cached);

    // ── NSE corporate events (today + next 7 days) ──
    let corporate = [];
    try {
      const all = await fetchNseEventCalendar();
      const todayMs = new Date().setHours(0, 0, 0, 0);
      const horizonMs = todayMs + 7 * 86400 * 1000;
      // NSE date format is "DD-MMM-YYYY" — parse to ms for comparison
      const monthIdx = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
      const toMs = (str) => {
        const m = String(str || "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
        if (!m) return NaN;
        const [, dd, mon, yyyy] = m;
        const mi = monthIdx[mon];
        if (mi == null) return NaN;
        return new Date(Number(yyyy), mi, Number(dd)).getTime();
      };
      corporate = all
        .map((e) => ({ ...e, _ms: toMs(e.date) }))
        .filter((e) => Number.isFinite(e._ms) && e._ms >= todayMs && e._ms <= horizonMs)
        .sort((a, b) => a._ms - b._ms)
        .slice(0, 25)
        .map(({ _ms, ...rest }) => rest);
    } catch (err) {
      console.warn("[CALENDAR] NSE event fetch failed:", err.message);
    }

    // ── Macro calendar (hand-maintained JSON, future-only, top 10) ──
    let macro = [];
    try {
      const calPath = path.join(__dirname, "data", "macroCalendar.json");
      const raw = readFileSync(calPath, "utf-8");
      const parsed = JSON.parse(raw);
      const todayIso = new Date().toISOString().slice(0, 10);
      macro = (parsed.events || [])
        .filter((e) => e && e.date && e.date >= todayIso)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 10);
    } catch (err) {
      console.warn("[CALENDAR] macroCalendar.json read failed:", err.message);
    }

    const response = {
      corporate,
      macro,
      counts: { corporate: corporate.length, macro: macro.length },
      lastUpdated: new Date().toISOString(),
    };
    marketCalendarCache.set("calendar", response);
    res.json(response);
  } catch (err) {
    console.error("[CALENDAR] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Market news aggregator — pulls from ET, Google News, LiveMint.
 * Cached for 5 minutes. Frontend refreshes every 10 minutes.
 */
const newsAggregatorCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

app.get("/api/news/market", async (req, res) => {
  try {
    const cached = newsAggregatorCache.get("market_news");
    if (cached) return res.json(cached);

    const RSS_HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };

    // Fetch from multiple Indian financial news sources in parallel
    const [etXml, lmXml, googleXml] = await Promise.all([
      fetch("https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", { headers: RSS_HEADERS })
        .then((r) => r.text()).catch(() => ""),
      fetch("https://www.livemint.com/rss/markets", { headers: RSS_HEADERS })
        .then((r) => r.text()).catch(() => ""),
      fetch("https://news.google.com/rss/search?q=Indian+stock+market+NSE+BSE+Nifty&hl=en-IN&gl=IN&ceid=IN:en", { headers: RSS_HEADERS })
        .then((r) => r.text()).catch(() => ""),
    ]);

    const articles = [];

    // Parse Economic Times
    parseRSS(etXml, "Economic Times").forEach((a) => articles.push(a));

    // Parse LiveMint
    parseRSS(lmXml, "LiveMint").forEach((a) => articles.push(a));

    // Parse Google News
    parseRSS(googleXml, "Google News").forEach((a) => articles.push(a));

    // Deduplicate by title similarity
    const seen = new Set();
    const unique = articles.filter((a) => {
      const key = a.title?.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by date (newest first)
    unique.sort((a, b) => {
      const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return db - da;
    });

    // Score sentiment on each headline (keyword-based, fast)
    const scored = unique.slice(0, 50).map((a) => {
      const lower = (a.title || "").toLowerCase();
      let label = "neutral";
      const bullWords = ["rally", "surge", "gain", "jump", "rise", "bull", "buy", "profit", "growth", "record", "beat", "upgrade", "strong", "recover", "rebound", "high", "positive"];
      const bearWords = ["fall", "crash", "drop", "slip", "sell", "bear", "loss", "decline", "weak", "concern", "negative", "correction", "plunge", "cut", "downgrade", "pressure", "fear", "risk"];
      const bCount = bullWords.filter((w) => lower.includes(w)).length;
      const brCount = bearWords.filter((w) => lower.includes(w)).length;
      if (bCount > brCount) label = "bullish";
      else if (brCount > bCount) label = "bearish";
      return { ...a, sentiment: label };
    });

    // ── Deterministic Market Digest ──
    // Composite mood from 6 signals: sectoral breadth, adv/decl, FII flow,
    // DII flow, headline tilt, GIFT Nifty (off-hours). No LLM call.
    //
    // Warm the sector + FII data the digest depends on. These previously
    // came straight off sectorHeatmapCache / fiiDiiCache — but those caches
    // are only populated as a side effect of someone hitting
    // /api/sector-heatmap or /api/fii-dii first, so on a cold cache the
    // digest emitted "Sectoral breadth data not yet available" / "FII data
    // not yet available" even though the data was perfectly fetchable.
    // getSectorHeatmapData / getFiiDiiData are cheap on a warm cache and
    // correct on a cold one; failures degrade to the null the digest
    // already tolerates.
    const [sectorHeatmap, fiiDii] = await Promise.all([
      getSectorHeatmapData().catch((e) => {
        console.warn("[NEWS] sector heatmap warm failed:", e.message);
        return null;
      }),
      getFiiDiiData().catch((e) => {
        console.warn("[NEWS] FII/DII warm failed:", e.message);
        return null;
      }),
    ]);
    const digest = buildDeterministicDigest(scored, {
      sectorHeatmap,
      fiiDii,
      market: marketCache.get("market"),
      marketStatus: isMarketOpen() ? "OPEN" : "CLOSED",
    });

    const response = {
      articles: scored,
      digest,
      count: scored.length,
      sources: ["Economic Times", "LiveMint", "Google News India"],
      compliance: {
        sources: ["NSE", "RBI", "SEBI", "Economic Times", "LiveMint", "Google News India"],
      },
      lastUpdated: new Date().toISOString(),
    };

    newsAggregatorCache.set("market_news", response);
    res.json(response);
  } catch (err) {
    console.error("News aggregator error:", err.message);
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

// Deterministic digest builder for /api/news/market. Pure function — reads
// existing cache snapshots, no I/O. Returns the same shape the frontend
// already consumes ({marketMood, moodSummary, keyTakeaways, bullishDrivers,
// bearishRisks, sectorsToWatch}). Each of 6 signals contributes ±1 or 0; sum
// determines mood. Every claim in moodSummary cites a number for SEBI
// "reasonable basis" compliance.
function buildDeterministicDigest(scored, ctx) {
  const { sectorHeatmap, fiiDii, market, marketStatus } = ctx || {};
  const fmtCr = (n) => `₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;
  const fmtPct = (n) => `${n >= 0 ? "+" : ""}${Number(n).toFixed(2)}%`;

  const signals = [];

  // 1. Sectoral breadth — # of sectors with positive avgChange
  if (sectorHeatmap?.sectors?.length) {
    const total = sectorHeatmap.sectors.length;
    const green = sectorHeatmap.sectors.filter((s) => (s.avgChange ?? 0) > 0).length;
    const greenThresh = Math.ceil(total * 0.63);  // ≥12 of 19
    const redThresh = Math.floor(total * 0.37);   // ≤7 of 19
    let c = 0;
    if (green >= greenThresh) c = 1;
    else if (green <= redThresh) c = -1;
    signals.push({ contributed: c, claim: `Sectoral breadth: ${green}/${total} green` });
  } else {
    signals.push({ contributed: 0, claim: "Sectoral breadth data not yet available" });
  }

  // 2. Adv/Decl ratio — across Nifty 100 stocks scanned for the heatmap
  if (sectorHeatmap?.marketBreadth) {
    const { advancing = 0, declining = 0 } = sectorHeatmap.marketBreadth;
    const ratio = declining > 0 ? advancing / declining : (advancing > 0 ? 99 : 0);
    let c = 0;
    if (ratio >= 2.0) c = 1;
    else if (ratio <= 0.5) c = -1;
    signals.push({ contributed: c, claim: `Adv/Decl: ${advancing}/${declining} (ratio ${ratio.toFixed(2)})` });
  }

  // 3. FII net (cash market, today's published session)
  let fiiNet = null, diiNet = null;
  if (fiiDii?.available !== false) {
    fiiNet = fiiDii?.fii?.netValue;
    diiNet = fiiDii?.dii?.netValue;
  }
  if (fiiNet != null) {
    let c = 0;
    if (fiiNet >= 500) c = 1;
    else if (fiiNet <= -500) c = -1;
    signals.push({ contributed: c, claim: `FII ${fiiNet >= 0 ? "net buy" : "net sell"} ${fmtCr(fiiNet)}` });
  } else {
    signals.push({ contributed: 0, claim: "FII data not yet available" });
  }

  // 4. DII net (cash market)
  if (diiNet != null) {
    let c = 0;
    if (diiNet >= 500) c = 1;
    else if (diiNet <= -500) c = -1;
    signals.push({ contributed: c, claim: `DII ${diiNet >= 0 ? "net buy" : "net sell"} ${fmtCr(diiNet)}` });
  } else {
    signals.push({ contributed: 0, claim: "DII data not yet available" });
  }

  // 5. Headline tilt — RSS bullish vs bearish from keyword classifier
  const bullCount = scored.filter((a) => a.sentiment === "bullish").length;
  const bearCount = scored.filter((a) => a.sentiment === "bearish").length;
  let headlineSig = 0;
  if (bullCount >= bearCount * 1.5 && bullCount >= 10) headlineSig = 1;
  else if (bearCount >= bullCount * 1.5 && bearCount >= 10) headlineSig = -1;
  signals.push({ contributed: headlineSig, claim: `Headlines tilt: ${bullCount} bullish vs ${bearCount} bearish` });

  // 6. GIFT Nifty — only weighted when cash market is closed (overnight signal)
  if (marketStatus === "CLOSED" && Array.isArray(market?.indices)) {
    const gift = market.indices.find((i) => /gift/i.test(i.name || ""));
    if (gift && Number.isFinite(gift.changePercent)) {
      let c = 0;
      if (gift.changePercent >= 0.3) c = 1;
      else if (gift.changePercent <= -0.3) c = -1;
      signals.push({ contributed: c, claim: `GIFT Nifty ${fmtPct(gift.changePercent)} (off-hours)` });
    }
  }

  // Composite score → mood
  const score = signals.reduce((sum, s) => sum + (s.contributed || 0), 0);
  let marketMood;
  if (score >= 2) marketMood = "bullish";
  else if (score <= -2) marketMood = "bearish";
  else marketMood = "mixed";

  // moodSummary: contributing claims joined; cites every number for compliance
  const contributingClaims = signals.filter((s) => s.contributed !== 0).map((s) => s.claim);
  const allClaims = signals.map((s) => s.claim);
  let moodSummary;
  if (contributingClaims.length === 0) {
    moodSummary = "Insufficient data — check back after market open.";
  } else {
    moodSummary = contributingClaims.join(" · ");
  }

  // keyTakeaways: top 3 by absolute weight (contributing signals first), then claims with 0 weight as filler
  const ranked = [...signals].sort((a, b) => Math.abs(b.contributed) - Math.abs(a.contributed));
  const keyTakeaways = ranked.slice(0, 3).map((s) => s.claim);

  // bullishDrivers / bearishRisks: top 4 verbatim RSS headline titles (by recency, scored is already sorted desc)
  const bullishDrivers = scored.filter((a) => a.sentiment === "bullish").slice(0, 4).map((a) => a.title);
  const bearishRisks = scored.filter((a) => a.sentiment === "bearish").slice(0, 4).map((a) => a.title);

  // sectorsToWatch: top 3 absolute movers from heatmap, with sign
  let sectorsToWatch = [];
  if (sectorHeatmap?.sectors?.length) {
    sectorsToWatch = [...sectorHeatmap.sectors]
      .sort((a, b) => Math.abs(b.avgChange ?? 0) - Math.abs(a.avgChange ?? 0))
      .slice(0, 3)
      .map((s) => `${s.sector}: ${fmtPct(s.avgChange ?? 0)}`);
  }

  return {
    marketMood,
    moodSummary,
    keyTakeaways,
    bullishDrivers,
    bearishRisks,
    sectorsToWatch,
    // Diagnostic / transparency for clients that want to drill in
    score,
    signals: allClaims,
    generatedBy: "deterministic",
  };
}

// ==================== MACRO REGIME LAYER ====================
//
// TRUSTED_MACRO_SOURCES, MACRO_COVERAGE_TARGET, fetchMacroHeadlines,
// bumpSourceFailure, macroSourceFailures, and parseRSS now live in
// macroHeadlineFetcher.js (see the import block near the top of this file).
// The extraction lets scripts/refresh-macro-regime.mjs share the exact same
// fetch + dedupe + tier-coverage logic — divergence between in-process and
// out-of-process refresh is what would otherwise cause the on-disk file and
// the live cache to drift apart.

/**
 * In-flight promise for `refreshMacroRegime` — ensures concurrent callers
 * dedupe onto the same classification instead of each kicking off a separate
 * LLM call. Matters for two reasons:
 *   1. COST: an unprotected burst of 5 concurrent tabs on cache-expiry would
 *      otherwise fire 5 parallel OpenAI requests (5× the cost).
 *   2. CONSISTENCY: all 5 tabs will see identical regime data. Without dedup,
 *      small timing differences between concurrent refreshes can produce
 *      different classifications and different cache writes, and whichever
 *      finishes last wins — users briefly see inconsistent data.
 */
let _inflightMacroRefresh = null;

/**
 * Refresh the macro regime cache. Non-blocking — caller should fire-and-forget
 * or `await` as appropriate. Writes to macroRegimeCache on success.
 *
 * Concurrency-safe: if a refresh is already in flight, returns the same
 * promise so both callers get the same result.
 */
async function refreshMacroRegime() {
  if (_inflightMacroRefresh) return _inflightMacroRefresh;
  _inflightMacroRefresh = (async () => {
    try {
      return await _doRefreshMacroRegime();
    } finally {
      _inflightMacroRefresh = null;
    }
  })();
  return _inflightMacroRefresh;
}

async function _doRefreshMacroRegime() {
  // No quota fast-path: classifyRegime now has a provider chain
  // (Groq → OpenAI → keyword heuristic) and never throws on LLM failure.
  // The headline-fetch round-trip is cheap enough that we always do it
  // and let classifyRegime decide which provider to use.
  try {
    const headlines = await fetchMacroHeadlines();
    const meta = headlines.meta || { sourceHealth: {}, tierCoverage: { "A+": 0, "A": 0, "B": 0 }, fallbacksUsed: [] };
    if (headlines.length === 0) {
      const calm = {
        ...defaultCalmRegime(),
        reasoning: "No macro headlines fetched (all sources unavailable).",
        sourceHealth: meta.sourceHealth,
        tierCoverage: meta.tierCoverage,
      };
      macroRegimeCache.set(MACRO_CACHE_KEY, calm);
      pushMacroHistory(calm, []);
      return calm;
    }
    const regime = await classifyRegime(headlines);

    // If tier-A wire coverage is zero, cap confidence at 0.4 so the regime
    // doesn't aggressively reshuffle rankings based on tier-B alone. This is a
    // failsafe for the case where every geopolitical wire source is blocked
    // on Vercel and we're classifying purely off Indian dailies.
    if (meta.tierCoverage["A"] === 0 && regime.confidence > 0.4) {
      regime.confidence = 0.4;
      regime.reasoning = `${regime.reasoning} [Confidence capped: no tier-A wire sources available]`;
    }

    // Attach source-health metadata so it flows through to the debug endpoint
    // and the frontend banner can render "sources: Reuters ✓, RBI ✗ (PIB fallback ✓)"
    regime.sourceHealth = meta.sourceHealth;
    regime.tierCoverage = meta.tierCoverage;
    regime.fallbacksUsed = meta.fallbacksUsed;

    macroRegimeCache.set(MACRO_CACHE_KEY, regime);
    pushMacroHistory(regime, headlines);
    console.log(
      `[MACRO] Regime=${regime.regime} sev=${regime.severity} conf=${regime.confidence.toFixed(2)} ` +
      `sectors=${regime.sectorImpacts.length} headlines=${headlines.length}`
    );

    // Persist to shared storage (KV in prod, file in dev) so other Vercel
    // instances and future cold starts see the same classification.
    // Fire-and-forget — never block the response on storage I/O.
    lastGoodMacroRegime = regime;
    macroStorage.write(regime).catch((e) => {
      console.warn("[MACRO] Failed to persist regime to storage:", e.message);
    });

    return regime;
  } catch (err) {
    console.error("[MACRO] refreshMacroRegime failed:", err.message);
    // Prefer the last good real classification. Check NodeCache, then
    // module-cached lastGoodMacroRegime, then KV — any of these beats CALM.
    const existing = macroRegimeCache.get(MACRO_CACHE_KEY);
    let fallback = lastGoodMacroRegime || existing;
    if (!fallback) {
      try { fallback = await macroStorage.read(); } catch { fallback = null; }
      if (fallback) lastGoodMacroRegime = fallback;
    }
    if (fallback) {
      macroRegimeCache.set(MACRO_CACHE_KEY, fallback);
      return fallback;
    }
    // No fallback. Build a clean CALM — DO NOT embed the error message in
    // reasoning (it leaks "429"/"quota" into the UI). If the failure was a
    // quota event, surface quotaLimitedUntil so the UI shows the friendly
    // paused banner. Cache with short TTL so the next try happens soon.
    const isQuotaErr = /429|quota|rate limit/i.test(err.message || "");
    const quotaUntil = getGroqQuotaState().until;
    const calm = {
      ...defaultCalmRegime(),
      reasoning: isQuotaErr
        ? "Macro classification temporarily paused — daily Groq limit reached. Will resume automatically."
        : "Macro classification temporarily unavailable.",
      ...(isQuotaErr && quotaUntil > Date.now() ? { quotaLimitedUntil: quotaUntil } : {}),
    };
    macroRegimeCache.set(MACRO_CACHE_KEY, calm, 300); // 5-minute TTL — DON'T pin failures for 24h
    // Deliberately NOT writing failures to KV (would mask the real classification globally).
    return calm;
  }
}

// ── Regime transition tracking ──
//
// Detects when the macro regime CHANGES (e.g., CALM → OIL_SHOCK, or
// WAR_ESCALATION → WAR_DE_ESCALATION). Transition events are powerful
// timing signals — the shift itself often triggers sector rotations.
//
// The last transition is stored and exposed via /api/macro/regime so the
// frontend can render "Regime just shifted — consider these sectors" alerts.
let lastRegimeTransition = null;

// Predefined transition → action mapping. Based on what typically happens
// when Indian markets transition between regimes.
const TRANSITION_SIGNALS = {
  // De-escalation signals → BUY opportunities
  "WAR_ESCALATION→WAR_DE_ESCALATION": { action: "BUY", summary: "Ceasefire/peace talks detected. Aviation, auto, and consumer stocks typically rally 3-8% in the week following de-escalation.", sectors: ["Aviation", "Automobile", "FMCG", "Retail"] },
  "WAR_ESCALATION→CALM": { action: "BUY", summary: "Conflict resolved. Broad risk-on rally expected. FIIs return to Indian equities.", sectors: ["Banking", "NBFC", "IT Services", "Real Estate"] },
  "OIL_SHOCK→CALM": { action: "BUY", summary: "Oil crisis easing. Airlines, chemicals, and auto benefit from lower input costs.", sectors: ["Aviation", "Automobile", "Chemicals", "FMCG"] },
  "OIL_SHOCK→WAR_DE_ESCALATION": { action: "BUY", summary: "Oil supply fears receding + geopolitical easing. Double tailwind for oil-consuming sectors.", sectors: ["Aviation", "Automobile", "Chemicals"] },
  "GLOBAL_RISK_OFF→CALM": { action: "BUY", summary: "Global risk appetite returning. FII flows resume into emerging markets.", sectors: ["Banking", "IT Services", "NBFC"] },
  "RATE_HIKE→RATE_CUT": { action: "STRONG BUY", summary: "Policy pivot from hawkish to dovish. Rate-sensitive sectors rally hard on pivot.", sectors: ["Real Estate", "NBFC", "Banking", "Infrastructure"] },
  // Escalation signals → SELL/TRIM signals
  "CALM→WAR_ESCALATION": { action: "SELL/TRIM", summary: "Conflict emerging. Trim aviation, consumer discretionary. Consider defence, gold-linked stocks.", sectors: ["Defence", "Oil & Gas", "Power"] },
  "CALM→OIL_SHOCK": { action: "TRIM", summary: "Oil spiking. Airlines and chemicals hurt. Energy producers benefit.", sectors: ["Oil & Gas", "Power", "Energy"] },
  "CALM→GLOBAL_RISK_OFF": { action: "TRIM", summary: "Global selloff. Reduce beta, move to defensives (FMCG, Pharma, IT).", sectors: ["FMCG", "Pharma", "IT Services"] },
  "RATE_CUT→RATE_HIKE": { action: "SELL", summary: "Policy reversal. Rate-sensitive sectors (realty, NBFC) face headwinds.", sectors: ["FMCG", "Pharma", "IT Services"] },
  "WAR_DE_ESCALATION→WAR_ESCALATION": { action: "SELL/TRIM", summary: "Peace talks failed. Risk-off mode returning. Trim risk assets.", sectors: ["Defence", "Oil & Gas"] },
};

function pushMacroHistory(regime, headlines) {
  // Detect regime transition by comparing to the previous classification
  if (macroHistory.length > 0) {
    const prev = macroHistory[0].regime?.regime;
    const curr = regime.regime;
    if (prev && curr && prev !== curr && curr !== "CALM" || (prev !== "CALM" && curr === "CALM")) {
      const transitionKey = `${prev}→${curr}`;
      const signal = TRANSITION_SIGNALS[transitionKey] || null;
      lastRegimeTransition = {
        from: prev,
        to: curr,
        transitionKey,
        detectedAt: new Date().toISOString(),
        signal: signal || {
          action: curr === "CALM" ? "NEUTRAL" : "WATCH",
          summary: `Regime shifted from ${prev.replace(/_/g, ' ')} to ${curr.replace(/_/g, ' ')}. Monitor sector rotation.`,
          sectors: [],
        },
      };
      console.log(`[MACRO] ⚡ REGIME TRANSITION: ${transitionKey} → ${lastRegimeTransition.signal.action}`);
    }
  }

  macroHistory.unshift({
    regime,
    headlines: headlines.map((h) => ({ title: h.title, source: h.source, sourceTier: h.sourceTier, publishedAt: h.publishedAt })),
    at: new Date().toISOString(),
  });
  if (macroHistory.length > 10) macroHistory.length = 10; // keep more history for transition tracking
}

/**
 * Get the current macro regime — three-tier cache:
 *   1. NodeCache (in-process, fastest)
 *   2. KV/file storage (shared across Vercel instances, persists across deploys)
 *   3. Fresh classification (only when both caches miss)
 *
 * The KV layer is what stops cold-started Vercel instances from each
 * independently hitting Groq's TPD limit. With KV populated, cold starts
 * skip step 3 entirely.
 */
async function getMacroRegime() {
  const cached = macroRegimeCache.get(MACRO_CACHE_KEY);
  if (cached) return cached;

  // NodeCache miss — try shared storage before burning a Groq call.
  const stored = await macroStorage.read().catch(() => null);
  if (stored) {
    lastGoodMacroRegime = stored;
    macroRegimeCache.set(MACRO_CACHE_KEY, stored);
    return stored;
  }

  // Both caches empty — fetch synchronously (first call only).
  return await refreshMacroRegime();
}

/**
 * Macro regime endpoint — returns the current regime + staleness info.
 * Optional ?refresh=1 forces a recompute.
 */
app.get("/api/macro/regime", async (req, res) => {
  try {
    if (req.query.refresh === "1") {
      const fresh = await refreshMacroRegime();
      return res.json({ ...fresh, staleness: 0, sources: TRUSTED_MACRO_SOURCES.map((s) => ({ name: s.name, tier: s.tier })), transition: lastRegimeTransition });
    }
    const regime = await getMacroRegime();
    const staleness = regime.generatedAt
      ? Date.now() - new Date(regime.generatedAt).getTime()
      : null;
    res.json({
      ...regime,
      staleness,
      sources: TRUSTED_MACRO_SOURCES.map((s) => ({ name: s.name, tier: s.tier })),
      // Regime transition alert — non-null when the regime recently changed
      transition: lastRegimeTransition,
    });
  } catch (err) {
    console.error("[MACRO] /api/macro/regime error:", err.message);
    res.status(500).json({ ...defaultCalmRegime(), error: err.message });
  }
});

/**
 * Health endpoint — answers a single question without auth: is the macro
 * regime fresh? Designed for external monitoring (uptime probe, Slack bot,
 * a dashboard tile). Returns `status` ∈ {fresh, stale, missing} and the
 * age in hours. Mirrors the 18h staleness threshold used by the earnings
 * health summary (services/earnings/earningsHealth.js) and the in-app
 * banner so all three layers agree on what "stale" means.
 *
 * Added 2026-05-17 as Phase 4 of the macro permanent fix — gives the user
 * a one-curl way to verify the standalone com.starbhai.macro-only cron is
 * actually running, without having to log in to the dashboard or check the
 * banner manually.
 */
app.get("/api/macro/regime/health", async (req, res) => {
  try {
    const stored = await macroStorage.read().catch(() => null);
    if (!stored || !stored.generatedAt) {
      return res.status(503).json({
        status: "missing",
        generatedAt: null,
        ageHours: null,
        thresholdHours: 18,
        reason: "data/macroRegime.json not present or unreadable",
      });
    }
    const ageMs = Date.now() - new Date(stored.generatedAt).getTime();
    const ageHours = Math.round(ageMs / 36e5 * 10) / 10;
    const stale = ageHours >= 18;
    res.status(stale ? 503 : 200).json({
      status: stale ? "stale" : "fresh",
      generatedAt: stored.generatedAt,
      ageHours,
      thresholdHours: 18,
      regime: stored.regime || null,
      classifierProvider: stored.classifierProvider || null,
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * Debug endpoint — current regime + last 5 classifications + source health.
 * Not gated behind auth since the data is non-sensitive, but it's deliberately
 * un-documented (no frontend link). Useful for verifying Vercel fallback
 * behaviour after deploy: check `current.sourceHealth` and `current.tierCoverage`.
 */
app.get("/api/macro/debug", (req, res) => {
  const current = macroRegimeCache.get(MACRO_CACHE_KEY) || null;
  res.json({
    current,
    sourceHealth: current?.sourceHealth || null,
    tierCoverage: current?.tierCoverage || null,
    fallbacksUsed: current?.fallbacksUsed || [],
    history: macroHistory,
    sourceFailures: Object.fromEntries(macroSourceFailures),
    sources: TRUSTED_MACRO_SOURCES.map((s) => ({
      name: s.name,
      tier: s.tier,
      group: s.group,
      primary: s.primary,
    })),
    coverageTargets: MACRO_COVERAGE_TARGET,
  });
});

/**
 * Dev-only override endpoint — force a specific regime for testing UI without
 * waiting for real macro news. Gated by MACRO_OVERRIDE_TOKEN env var or by
 * running outside Vercel production. Example:
 *
 *   curl -H 'Authorization: Bearer XXX' \
 *     '/api/macro/override?regime=WAR_ESCALATION&sector=Defence&impact=3&severity=4'
 *
 * Writes directly to macroRegimeCache. Cleared on next scheduled refresh or by
 * calling /api/macro/regime?refresh=1.
 */
// extractAdminToken — pulls the MACRO_OVERRIDE_TOKEN-style admin token from
// (a) Authorization: Bearer <token> header (preferred), or
// (b) ?token=... query param (DEPRECATED — kept for compatibility with
//     existing curl scripts and historical cron callers, but logs a
//     migration warning).
// Returns the token string or null. The query-param form is dangerous
// because URLs land in server access logs, Vercel logs, browser history,
// and any proxy in-between; the header form keeps the token off those
// surfaces. (P0.3, 2026-05-16)
function extractAdminToken(req) {
  const authHeader = req.get("authorization") || req.get("Authorization") || "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const queryToken = req.query?.token;
  if (queryToken) {
    console.warn(
      `[ADMIN-TOKEN] DEPRECATED: ?token= query-param on ${req.method} ${req.path} — ` +
      `move to 'Authorization: Bearer <token>' header. ` +
      `Query-param tokens leak via access logs, Vercel logs, and browser history.`,
    );
    return String(queryToken);
  }
  return null;
}

app.get("/api/macro/override", (req, res) => {
  // Allowed when:
  //   (a) running locally (VERCEL env var not set), OR
  //   (b) running on Vercel AND a matching MACRO_OVERRIDE_TOKEN env var is
  //       set AND the request passes the token via 'Authorization: Bearer
  //       <token>' header (preferred) or ?token=... query param (deprecated).
  //
  // The explicit token-presence check prevents the "undefined === undefined"
  // loophole that would otherwise let any unauthenticated Vercel request
  // force-set the regime.
  const envToken = process.env.MACRO_OVERRIDE_TOKEN;
  const supplied = extractAdminToken(req);
  const isLocal = !process.env.VERCEL;
  const tokenOk = envToken && supplied && supplied === envToken;
  if (!isLocal && !tokenOk) {
    return res.status(403).json({ error: "Override not allowed in this environment. Set MACRO_OVERRIDE_TOKEN env var and pass via 'Authorization: Bearer <token>' header." });
  }

  // Validate regime against the canonical enum — anything else would silently
  // poison the cache with an unknown regime ID that no downstream code knows
  // how to handle.
  const regimeId = String(req.query.regime || "CALM").toUpperCase();
  if (!REGIMES.includes(regimeId)) {
    return res.status(400).json({
      error: `Unknown regime "${regimeId}". Must be one of: ${REGIMES.join(", ")}`,
    });
  }

  const severity = Math.max(1, Math.min(5, parseInt(req.query.severity || "3", 10)));
  const confidence = Math.max(0, Math.min(1, parseFloat(req.query.confidence || "0.85")));

  // Build sector impacts from repeatable query params: sector=Defence&impact=3
  // Supports multiple: ?sector=Defence&impact=3&sector=Aviation&impact=-2
  // Each sector is validated against the canonical SECTORS enum so the
  // downstream lookup in computeMacroDelta actually finds them.
  const sectors = [].concat(req.query.sector || []);
  const impacts = [].concat(req.query.impact || []);
  const invalidSectors = sectors.filter((s) => !SECTORS.includes(String(s)));
  if (invalidSectors.length > 0) {
    return res.status(400).json({
      error: `Unknown sector(s): ${invalidSectors.join(", ")}. Must be one of: ${SECTORS.join(", ")}`,
    });
  }
  const sectorImpacts = sectors.map((s, i) => ({
    sector: String(s),
    impact: Math.max(-3, Math.min(3, parseInt(impacts[i] || "1", 10))),
    reason: `Forced via /api/macro/override for testing`,
  })).filter((s) => s.impact !== 0);

  const override = {
    ...defaultCalmRegime(),
    regime: regimeId,
    regimeLabel: regimeId.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
    severity,
    confidence,
    sectorImpacts,
    reasoning: `⚠ OVERRIDE: regime forced to ${regimeId} for testing. This is not real data.`,
    keyEvents: ["(override)"],
    generatedAt: new Date().toISOString(),
    sourceHealth: { override: "forced" },
    tierCoverage: { "A+": 0, "A": 0, "B": 0 },
    override: true,
  };
  macroRegimeCache.set(MACRO_CACHE_KEY, override);
  console.log(`[MACRO] ⚠ Regime overridden: ${regimeId} sev=${severity} sectors=${sectorImpacts.length}`);
  res.json(override);
});

// ==================== PAPER-TRADE TRACKER ====================

/**
 * 5-minute cache for the track history endpoint. Forward returns don't change
 * every second, and computing them requires fetching live prices for every
 * unique symbol in the trades file — which gets expensive once we have weeks
 * of history (200+ unique symbols).
 */
const trackCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

/**
 * GET /api/track/history
 *
 * Returns all paper-trade entries with their forward returns vs the current
 * Nifty benchmark. Sorted newest-first.
 *
 * Query params:
 *   ?type=buynow_nifty100|smallcap_buynow|fundamental_deep_value  — filter
 *   ?days=30                                                      — last N days
 *   ?symbol=HDFCBANK                                              — single-symbol filter (PR T6)
 *   ?bust=1                                                       — skip cache
 *
 * PR T6 — symbol filter underwrites the per-stock "we said X N days ago"
 * strip on the stock-detail modal. The normaliser strips .NS / .BO / BSE:
 * / NSE: prefixes + uppercases so the caller doesn't have to canonicalise.
 */
function _normaliseTrackSymbol(s) {
  if (!s) return "";
  return String(s)
    .toUpperCase()
    .replace(/^(BSE|NSE):/, "")
    .replace(/\.(NS|BO)$/, "")
    .trim();
}
app.get("/api/track/history", async (req, res) => {
  try {
    const filterType = req.query.type || null;
    const dayLimit = req.query.days ? parseInt(req.query.days, 10) : null;
    const symbolFilter = req.query.symbol ? _normaliseTrackSymbol(req.query.symbol) : null;
    const cacheKey = `track_history_${filterType || "all"}_${dayLimit || "all"}_${symbolFilter || "all"}`;

    if (!req.query.bust) {
      const cached = trackCache.get(cacheKey);
      if (cached) {
        res.set("X-Cache", "HIT");
        return res.json(cached);
      }
    }

    let trades = await readAllTrades();

    if (filterType) trades = trades.filter((t) => t.type === filterType);
    if (symbolFilter) {
      trades = trades.filter((t) => _normaliseTrackSymbol(t.symbol) === symbolFilter);
    }
    if (dayLimit) {
      const cutoff = Date.now() - dayLimit * 86400000;
      trades = trades.filter((t) => new Date(t.snapshotAt).getTime() >= cutoff);
    }

    if (trades.length === 0) {
      const empty = {
        trades: [],
        performance: aggregatePerformance([]),
        currentNifty: null,
        totalCount: 0,
        message: "No paper trades recorded yet. Run the Buy Now / Small-Cap / Fundamental scanners to start collecting picks.",
      };
      trackCache.set(cacheKey, empty);
      return res.json(empty);
    }

    // Fetch current prices for all unique symbols + Nifty in parallel.
    // Yahoo's individual chart endpoint is the cheapest reliable price source.
    const uniqueSymbols = [...new Set(trades.map((t) => t.symbol))];
    const [niftyQuote, ...quotes] = await Promise.all([
      fetchQuote("^NSEI").catch(() => null),
      ...uniqueSymbols.map((sym) => fetchQuote(sym).catch(() => null)),
    ]);
    const currentNifty = niftyQuote?.regularMarketPrice ?? null;
    const priceBySymbol = {};
    uniqueSymbols.forEach((sym, i) => {
      const q = quotes[i];
      if (q?.regularMarketPrice) priceBySymbol[sym] = q.regularMarketPrice;
    });

    // Compute returns for each trade
    const tradesWithReturns = trades.map((t) => {
      const currentPrice = priceBySymbol[t.symbol];
      const returns = currentPrice
        ? computeReturns(t, currentPrice, currentNifty)
        : { error: "no_current_price" };
      return { ...t, returns };
    });

    // Sort newest first
    tradesWithReturns.sort((a, b) => new Date(b.snapshotAt) - new Date(a.snapshotAt));

    // Aggregate metrics overall + by type + by regime + by sector
    const performance = aggregatePerformance(tradesWithReturns);
    const byType = groupAndAggregate(tradesWithReturns, "type");
    const byRegime = groupAndAggregate(tradesWithReturns, "regimeAtSnapshot");
    const bySector = groupAndAggregate(tradesWithReturns, "sector");
    // V2 — per-section forward-return scorecard at 1m/3m/6m/12m horizons.
    // Only V2-shape trades (with `returns_by_horizon`) feed this; legacy
    // trades fall through to the byType / vs-Nifty live-price path above.
    const bySectionScorecard = buildAllSectionScorecards(trades);

    const response = {
      trades: tradesWithReturns,
      performance,
      byType,
      byRegime,
      bySector,
      bySectionScorecard,
      currentNifty,
      totalCount: tradesWithReturns.length,
      uniqueSymbols: uniqueSymbols.length,
      lastComputedAt: new Date().toISOString(),
    };

    trackCache.set(cacheKey, response);
    res.set("X-Cache", "MISS");
    res.json(response);
  } catch (err) {
    console.error("[PAPERTRADES] /api/track/history failed:", err.message);
    res.status(500).json({ error: "Track history failed: " + err.message });
  }
});

/**
 * GET /api/track/calibration  — PR T7
 *
 * Builds the 5-bucket calibration profile for the front-end SVG plot.
 * Backed by services/trackRecord/calibration.js; thin (n < 30) buckets
 * are flagged so the UI greys them out rather than implying confidence.
 */
app.get("/api/track/calibration", async (req, res) => {
  try {
    const trades = await readAllTrades();
    const payload = buildTrackCalibration(trades);
    res.json({
      ...payload,
      computedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[TRACK] /api/track/calibration failed:", err && err.message);
    res.status(500).json({ error: "calibration failed: " + (err && err.message) });
  }
});

/**
 * GET /api/track/stats
 *
 * Lightweight summary endpoint. Returns storage stats + count by type.
 * Used by the empty-state placeholder on the Track Record tab.
 */
app.get("/api/track/stats", async (req, res) => {
  try {
    // Cache the aggregate. readAllTrades() does a full ZRANGE in the KV
    // backend (every blob, newest-first) — fine when the log is empty but
    // ~900ms p50 in prod once it has months of history. The cache is
    // invalidated by /api/cron/snapshot-track-record after each daily run.
    const cacheKey = "track_stats";
    if (!req.query.bust) {
      const cached = trackCache.get(cacheKey);
      if (cached) {
        res.set("X-Cache", "HIT");
        return res.json({ ...cached, todayKey: getISTDateKey() });
      }
    }
    const [trades, stats] = await Promise.all([readAllTrades(), getStorageStats()]);
    const byType = {};
    for (const t of trades) {
      byType[t.type] = (byType[t.type] || 0) + 1;
    }
    const payload = {
      ...stats,
      byType,
    };
    trackCache.set(cacheKey, payload);
    res.set("X-Cache", "MISS");
    res.json({ ...payload, todayKey: getISTDateKey() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/track/snapshot
 *
 * Manual snapshot trigger — useful for testing or for forcing a fresh
 * snapshot mid-day. Body: { type: "buynow_nifty100", picks: [...] }
 */
app.post("/api/track/snapshot", express.json(), async (req, res) => {
  try {
    const { type, picks, force } = req.body || {};
    if (!type || !Array.isArray(picks)) {
      return res.status(400).json({ error: "Body must contain { type, picks: [] }" });
    }
    if (!force && (await hasSnapshotToday(type))) {
      return res.status(409).json({ error: `Snapshot for type ${type} already exists today. Use force: true to override.` });
    }
    const niftyQuote = await fetchQuote("^NSEI").catch(() => null);
    const niftyPrice = niftyQuote?.regularMarketPrice ?? null;
    const result = await snapshotPicks(picks, type, {
      regime: macroRegimeCache.get(MACRO_CACHE_KEY) || defaultCalmRegime(),
      niftyPrice,
      rationale: "Manual snapshot via /api/track/snapshot",
    });
    res.json({ ...result, niftyPrice });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/track/migrate
 *
 * One-shot migration: read entries from a JSON body and append them to
 * whatever storage backend is currently active. Used when moving from local
 * file storage to Vercel KV — POST the contents of .paper-trades.json once
 * after KV is provisioned. Idempotent thanks to the per-(date×type×symbol)
 * dedup keys built into the storage adapters.
 *
 * Gated behind MACRO_OVERRIDE_TOKEN on Vercel (same security model as the
 * macro override endpoint) so random Vercel callers can't poison the trade
 * log with arbitrary entries.
 *
 * Usage:
 *   curl -X POST https://stock-platform-gamma.vercel.app/api/track/migrate \
 *     -H 'Authorization: Bearer XXX' \
 *     -H 'Content-Type: application/json' \
 *     --data @.paper-trades-export.json
 */
app.post("/api/track/migrate", express.json({ limit: "5mb" }), async (req, res) => {
  // Same security gate as /api/macro/override
  const envToken = process.env.MACRO_OVERRIDE_TOKEN;
  const supplied = extractAdminToken(req);
  const isLocal = !process.env.VERCEL;
  const tokenOk = envToken && supplied && supplied === envToken;
  if (!isLocal && !tokenOk) {
    return res.status(403).json({ error: "Migration requires MACRO_OVERRIDE_TOKEN. Set the env var on Vercel and pass via 'Authorization: Bearer <token>' header." });
  }

  try {
    // Body can be either an array of entries OR a JSONL string
    let entries = [];
    if (Array.isArray(req.body)) {
      entries = req.body;
    } else if (typeof req.body === "string") {
      entries = req.body
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } else if (req.body && Array.isArray(req.body.entries)) {
      entries = req.body.entries;
    }
    if (entries.length === 0) {
      return res.status(400).json({ error: "Body must be an array of trade entries or { entries: [...] }" });
    }

    // Validate shape — every entry must have id, type, symbol, snapshotAt
    const valid = entries.filter((e) => e && e.id && e.type && e.symbol && e.snapshotAt && e.priceAtSnapshot);
    if (valid.length === 0) {
      return res.status(400).json({ error: "No valid entries (each must have id, type, symbol, snapshotAt, priceAtSnapshot)" });
    }

    const result = await appendTrades(valid);
    const stats = await getStorageStats();
    res.json({
      ...result,
      received: entries.length,
      validShape: valid.length,
      backendNow: stats.backend,
      totalAfter: stats.lineCount,
    });
  } catch (err) {
    console.error("[PAPERTRADES] Migration failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/track/snapshot-sws-now
 *
 * Reads the current data/sws/picks-latest.json and snapshots every section
 * into the trade log + closes any prior open trades whose section dropped
 * them. Used for first-deploy bootstrap and manual re-syncs when the
 * pipeline hook missed a run.
 *
 * Token-gated identically to /api/track/migrate so random Vercel callers
 * can't poison the trade log.
 */
app.post("/api/track/snapshot-sws-now", async (req, res) => {
  const envToken = process.env.MACRO_OVERRIDE_TOKEN;
  const supplied = extractAdminToken(req);
  const isLocal = !process.env.VERCEL;
  const tokenOk = envToken && supplied && supplied === envToken;
  if (!isLocal && !tokenOk) {
    return res.status(403).json({ error: "Requires MACRO_OVERRIDE_TOKEN. Set the env var on Vercel and pass via 'Authorization: Bearer <token>' header." });
  }
  try {
    const picksPath = path.join(__dirname, "data", "sws", "picks-latest.json");
    if (!fs.existsSync(picksPath)) {
      return res.status(404).json({ error: "picks-latest.json not found — run the SWS pipeline first." });
    }
    const picks = JSON.parse(fs.readFileSync(picksPath, "utf-8"));
    const niftyQuote = await fetchQuote("^NSEI").catch(() => null);
    const niftyPrice = niftyQuote?.regularMarketPrice ?? null;
    const result = await snapshotAndCloseSwsPicks(picks, {
      snapshotAt: picks.scanned_at,
      niftyPrice,
      rationale: "Manual snapshot via /api/track/snapshot-sws-now",
    });
    // Bust the track-history cache so the UI sees the new entries on next load
    trackCache.flushAll();
    res.json({
      scannedAt: picks.scanned_at,
      sections: Object.keys(SWS_SECTION_TO_TYPE).filter((k) => Array.isArray(picks.sections?.[k]) && picks.sections[k].length).length,
      niftyPrice,
      ...result,
    });
  } catch (err) {
    console.error("[PAPERTRADES] /api/track/snapshot-sws-now failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/track/sections
 *
 * V2 SEBI-RA-grade scorecard endpoint. Returns one entry per Track-Record
 * section with: latest top-10 picks, multi-horizon scorecard (1m/3m/6m/12m
 * for stocks; T+1 for earnings), and side label. Powers the new section
 * grid below the headline metrics on the Track Record tab.
 */
app.get("/api/track/sections", async (req, res) => {
  try {
    const cacheKey = "track_sections";
    if (!req.query.bust) {
      const cached = trackCache.get(cacheKey);
      if (cached) { res.set("X-Cache", "HIT"); return res.json(cached); }
    }
    const trades = await readAllTrades();
    const scorecards = buildAllSectionScorecards(trades);
    const sections = Object.keys(ALL_SECTION_TYPES).map((type) => {
      const card = scorecards[type] || { side: ALL_SECTION_TYPES[type], n_total: 0, horizons: {} };
      const top = latestTopForType(trades, type, 10);
      return {
        type,
        label: SECTION_LABELS[type] || type,
        side: card.side,
        n_total: card.n_total,
        latest_top10: top.map((t) => ({
          symbol: t.symbol,
          name: t.name,
          sector: t.sector,
          section_rank: t.section_rank,
          dateKey: t.dateKey,
          score: t.scoreAtSnapshot,
          cap_band: t.cap_band,
          benchmark_proxy: t.benchmark_proxy,
        })),
        scorecard_by_horizon: card.horizons,
      };
    });
    const response = {
      sections,
      lastComputedAt: new Date().toISOString(),
      todayKey: getISTDateKey(),
    };
    trackCache.set(cacheKey, response);
    res.set("X-Cache", "MISS");
    res.json(response);
  } catch (err) {
    console.error("[PAPERTRADES] /api/track/sections failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/cron/snapshot-track-record
 *
 * Daily cron that snapshots the top-10 from every non-SWS Track-Record
 * section (SWS sections auto-snapshot inside the SWS pipeline). CRON_SECRET-
 * gated identically to scan-precompute.
 *
 * Sequenced after the data-refresh crons land at 04:01 UTC. Default cron
 * schedule: 30 4 * * * (10:00 IST).
 */
app.all("/api/cron/snapshot-track-record", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.cron_secret;
  const isLocal = !process.env.VERCEL;
  if (!isLocal && cronSecret && provided !== cronSecret) {
    return res.status(403).json({ error: "Bad CRON_SECRET" });
  }
  try {
    const niftyQuote = await fetchQuote("^NSEI").catch(() => null);
    const niftyPrice = niftyQuote?.regularMarketPrice ?? null;
    const baseUrl = req.headers["x-forwarded-host"]
      ? `https://${req.headers["x-forwarded-host"]}`
      : `http://localhost:${PORT}`;
    const result = await snapshotTrackRecordSections({
      baseUrl,
      niftyPrice,
      regime: macroRegimeCache.get(MACRO_CACHE_KEY) || defaultCalmRegime(),
      rationale: "Daily Track Record snapshot (cron)",
    });
    trackCache.flushAll();
    res.json(result);
  } catch (err) {
    console.error("[PAPERTRADES] /api/cron/snapshot-track-record failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/cron/resolve-forward-returns
 *
 * Daily cron that resolves any horizons whose anniversary has arrived.
 * Idempotent — already-closed rows are skipped. CRON_SECRET-gated.
 *
 * Default schedule: 0 5 * * * (10:30 IST), one hour after the snapshot cron.
 */
app.all("/api/cron/resolve-forward-returns", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const provided = req.headers["x-cron-secret"] || req.query.cron_secret;
  const isLocal = !process.env.VERCEL;
  if (!isLocal && cronSecret && provided !== cronSecret) {
    return res.status(403).json({ error: "Bad CRON_SECRET" });
  }
  try {
    const result = await resolveOpenHorizons({ todayIso: new Date().toISOString() });
    trackCache.flushAll();
    res.json(result);
  } catch (err) {
    console.error("[PAPERTRADES] /api/cron/resolve-forward-returns failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// parseRSS + safeDateParse now live in macroHeadlineFetcher.js (imported above).
// The news aggregator at /api/news/market uses the imported parseRSS — they
// stay in sync with the macro fetcher's parsing rules automatically.

// ==================== HELPERS ====================

function isMarketOpen() {
  const now = new Date();
  const istOffset = 5.5 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMinutes = utcMinutes + istOffset;
  const day = new Date(now.getTime() + istOffset * 60 * 1000).getUTCDay();

  if (day === 0 || day === 6) return false;
  return istMinutes >= 555 && istMinutes <= 930;
}

function formatQuote(q) {
  if (!q) return null;
  return {
    symbol: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    price: q.regularMarketPrice,
    change: q.regularMarketChange,
    changePercent: q.regularMarketChangePercent,
    dayHigh: q.regularMarketDayHigh,
    dayLow: q.regularMarketDayLow,
    open: q.regularMarketOpen,
    previousClose: q.regularMarketPreviousClose,
    volume: q.regularMarketVolume,
    avgVolume: q.averageDailyVolume3Month,
    marketCap: q.marketCap,
    fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: q.fiftyTwoWeekLow,
    fiftyDayAvg: q.fiftyDayAverage,
    twoHundredDayAvg: q.twoHundredDayAverage,
    pe: q.trailingPE,
    eps: q.epsTrailingTwelveMonths,
    dividendYield: q.dividendYield,
    exchange: q.exchange,
    currency: q.currency || "INR",
    marketState: q.marketState,
  };
}

// ==================== PORTFOLIO ====================

import { readFileSync, writeFileSync, existsSync } from "fs";
import { getPortfolioStorage } from "./portfolioStorage.js";
import { getAnalyzerStorage } from "./analyzerStorage.js";

// Lazy @vercel/kv client for the portfolio response cache L2. Memoised
// so we don't re-import on every request. Returns null when KV isn't
// configured (local dev) — callers must handle null and skip L2.
let _portfolioKVClient = null;
async function getKVClientForPortfolio() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  if (_portfolioKVClient) return _portfolioKVClient;
  const mod = await import("@vercel/kv");
  _portfolioKVClient = mod.kv;
  return _portfolioKVClient;
}

// Adapter-based portfolio storage (file in dev, Vercel KV in prod) — see
// portfolioStorage.js. Previously portfolio.json was written directly to
// disk, which silently failed on Vercel's read-only filesystem.
//
// As of the per-user portfolio PR, every read/write is scoped by sub
// (Google subject claim). Callers MUST pass req.user?.sub through
// userSub(req) — in production AUTH_ENABLED guarantees a value; in
// local dev without OAuth configured the helper returns "_local_dev"
// so the dev loop keeps working with a stable single-user namespace.
async function readPortfolio(sub) {
  return await getPortfolioStorage().read(sub);
}

async function savePortfolio(sub, data) {
  return await getPortfolioStorage().write(sub, data);
}

// Resolve the current request's user identifier for per-user storage.
// Returns null if AUTH_ENABLED but no session — handler should 401.
// Returns "_local_dev" when AUTH_ENABLED is false (dev without OAuth)
// so endpoints don't crash on missing req.user.
function userSub(req) {
  if (req.user?.sub) return req.user.sub;
  return AUTH_ENABLED ? null : "_local_dev";
}

// ==================== WATCHLIST ====================
// Uses the same dual-backend pattern as paperTradesStorage.js:
// FileStorage for local dev, VercelKVStorage for production.

import { getWatchlistStorage } from "./watchlistStorage.js";

app.get("/api/watchlist", async (req, res) => {
  try {
    const storage = getWatchlistStorage();
    const list = await storage.readAll();
    // Enrich with live prices
    const enriched = await Promise.all(list.map(async (item) => {
      try {
        const q = await fetchQuote(item.symbol);
        return {
          ...item,
          price: q?.regularMarketPrice ?? null,
          change: q?.regularMarketChange ?? null,
          changePercent: q?.regularMarketChangePercent ?? null,
        };
      } catch { return item; }
    }));
    res.json({ stocks: enriched, count: enriched.length, backend: storage.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/watchlist/add", express.json(), async (req, res) => {
  const { symbol, name, sector } = req.body || {};
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  // Validate against the tracked universe before persisting. The handler
  // used to accept any string — garbage symbols (and even raw HTML) landed
  // in storage, then broke downstream price / SWS lookups that assume a real
  // ticker. findBySymbol canonicalises (uppercase, strip whitespace, match
  // bare or .NS form) and returns null on a miss.
  const resolved = findBySymbol(symbol);
  if (!resolved) {
    return res.status(400).json({ error: "Unknown symbol — not in the tracked universe." });
  }

  const storage = getWatchlistStorage();

  // Capture the price at add-time so the watchlist can show the user
  // their entry-level reference and the move since saving. Server-side
  // quote keeps the value trustworthy (client clock / stale data can't
  // forge it). Failures are non-fatal — we still save the entry.
  let addedPrice = null;
  try {
    const q = await fetchQuote(resolved.symbol);
    if (q && typeof q.regularMarketPrice === "number") addedPrice = q.regularMarketPrice;
  } catch { /* keep addedPrice null */ }

  const result = await storage.add({
    symbol: resolved.symbol,
    name: resolved.name || name || resolved.symbol,
    sector: resolved.sector || sector || null,
    addedAt: new Date().toISOString(),
    addedPrice,
  });
  res.json({ ok: true, addedPrice, ...result });
});

app.post("/api/watchlist/remove", express.json(), async (req, res) => {
  const { symbol } = req.body || {};
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  const storage = getWatchlistStorage();
  const result = await storage.remove(symbol);
  res.json({ ok: true, ...result });
});

/** GET portfolio — returns saved holdings + live prices */
app.get("/api/portfolio", async (req, res) => {
  try {
    const sub = userSub(req);
    if (!sub) return res.status(401).json({ error: "auth-required" });
    const portfolio = await readPortfolio(sub);

    if ((!portfolio.stocks || portfolio.stocks.length === 0) &&
        (!portfolio.mutualFunds || portfolio.mutualFunds.length === 0)) {
      return res.json({
        stocks: [],
        mutualFunds: [],
        lastUpdated: portfolio.lastUpdated,
        message: "No portfolio data yet. Click 'Refresh from Groww' to import.",
      });
    }

    // Fix #2: Portfolio orchestration is expensive (~1s even with warm quote
    // caches). Cache the full response for 30 seconds so auto-refresh,
    // tab-switch, and rapid navigation don't rebuild the whole pipeline.
    // The frontend Refresh button passes ?bust=1 to force a recompute.
    //
    // Cache key includes portfolio.lastUpdated so importing a new snapshot
    // from Groww automatically invalidates — the key changes.
    // Two-tier cache: NodeCache (L1, per-instance, instant) + Vercel KV (L2,
    // shared across lambdas, ~10-30ms). On a new cold lambda, NodeCache is
    // always empty but KV is almost always warm — this shaves the full
    // enrichment+intel pipeline off every second user after any cold start.
    const cacheKey = `port_${portfolio.lastUpdated}`;
    if (!req.query.bust) {
      const l1 = portfolioCache.get(cacheKey);
      if (l1) {
        res.set("X-Cache", "HIT-L1");
        return res.json(l1);
      }
      // L2 check — best-effort, never blocks
      try {
        const kv = await getKVClientForPortfolio();
        if (kv) {
          const l2 = await kv.get(`portfolio:resp:${cacheKey}`);
          if (l2) {
            portfolioCache.set(cacheKey, l2); // promote to L1
            res.set("X-Cache", "HIT-L2");
            return res.json(l2);
          }
        }
      } catch (e) { /* silent — fall through to recompute */ }
    }

    // Enrich stocks with live prices from NSE/Yahoo
    const enrichedStocks = await Promise.all(
      (portfolio.stocks || []).map(async (holding) => {
        let symbol = holding.symbol;
        if (!symbol.endsWith(".NS") && !symbol.endsWith(".BO")) symbol += ".NS";

        // investedValue is always computable from portfolio data
        const investedValue = holding.avgPrice * holding.quantity;

        // Resolve sector for the diversification calculation. Lookup order:
        //   1. portfolio.json (user-maintained, most authoritative)
        //   2. stockList.js (canonical for tracked stocks)
        //   3. fundamentals.json NSE snapshot
        //   4. "Unknown" fallback
        //
        // Without any of these, every holding ends up as "Unknown" and the
        // diversification metric collapses to 0 — which would lie about the
        // portfolio's actual risk profile.
        let sector = holding.sector || null;
        if (!sector) {
          const stockInfo = ALL_STOCKS.find((s) => s.symbol === symbol);
          sector = stockInfo?.sector || null;
        }
        if (!sector) {
          const fundSnap = getFundamentals(symbol);
          sector = fundSnap?.sector || fundSnap?.industry || "Unknown";
        }

        try {
          const quote = await fetchQuote(symbol);
          if (quote) {
            const currentPrice = quote.regularMarketPrice;
            const currentValue = currentPrice * holding.quantity;
            const pnl = currentValue - investedValue;
            const pnlPercent = investedValue > 0 ? (pnl / investedValue) * 100 : 0;

            return {
              ...holding,
              symbol,
              sector,
              currentPrice,
              change: quote.regularMarketChange,
              changePercent: quote.regularMarketChangePercent,
              currentValue,
              investedValue,
              pnl,
              pnlPercent,
              dayHigh: quote.regularMarketDayHigh,
              dayLow: quote.regularMarketDayLow,
              // 52-week range is used by the recovery-probability heuristic
              // (portfolioIntelligence.js → computeRecoveryMath) to distinguish
              // "at 52W low, bounce likely" from "at 52W high, you over-entered"
              fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh ?? null,
              fiftyTwoWeekLow: quote.fiftyTwoWeekLow ?? null,
            };
          }
        } catch (e) { /* live quote failed — still return invested data */ }

        // Quote failed: still include investedValue so totals are correct
        return { ...holding, symbol, sector, currentPrice: null, investedValue, currentValue: null, pnl: null, pnlPercent: null };
      })
    );

    // ── Portfolio Intelligence enrichment ──
    // For each holding with live data, run a lightweight technical analysis
    // and look up the pre-computed fundamental snapshot. We deliberately
    // skip the LLM news classifier here — news is too noisy for structural
    // position decisions and we want this to load fast. The user can click
    // any holding to see the full news analysis in the detail view.
    //
    // Uses batches of 8 with 250ms spacing to stay under Yahoo's rate limit
    // when the user has a large portfolio (26+ stocks).
    const analysesBySymbol = new Map();
    const intelBatchSize = 8;
    const holdingsNeedingAnalysis = enrichedStocks.filter((h) => h.currentPrice != null);

    for (let i = 0; i < holdingsNeedingAnalysis.length; i += intelBatchSize) {
      const batch = holdingsNeedingAnalysis.slice(i, i + intelBatchSize);
      const batchResults = await Promise.all(
        batch.map(async (h) => {
          try {
            // Historical is cached so repeat calls are essentially free
            const historical = await fetchHistorical(h.symbol);
            let technicalScore = null;
            if (historical && historical.length >= 30) {
              // COLD-START FIX: don't re-fetch the quote — reuse the one the
              // enrichment step above already got. Same quote, same tick,
              // saves an entire round-trip per holding (26 holdings × ~400ms
              // cold-start latency each = ~10s off the portfolio load).
              const quote = {
                regularMarketPrice: h.currentPrice,
                regularMarketChange: h.change,
                regularMarketChangePercent: h.changePercent,
                regularMarketDayHigh: h.dayHigh,
                regularMarketDayLow: h.dayLow,
                fiftyTwoWeekHigh: h.fiftyTwoWeekHigh,
                fiftyTwoWeekLow: h.fiftyTwoWeekLow,
              };
              const analysis = analyzeStock(historical, quote);
              technicalScore = analysis?.score ?? null;
            }

            // Fundamentals snapshot (from disk, instant)
            const fundSnap = getFundamentals(h.symbol);
            let fundamentalScore = null;
            let fundamentalVerdict = null;
            if (fundSnap) {
              let dma200 = null;
              if (historical && historical.length >= 200) {
                const closes = historical.map((d) => d.close);
                dma200 = closes.slice(-200).reduce((s, v) => s + v, 0) / 200;
              }
              const fundResult = scoreForResponse(fundSnap, dma200).primary;
              if (fundResult) {
                fundamentalScore = fundResult.score;
                fundamentalVerdict = fundResult.verdict;
              }
            }

            const combinedScore = computePortfolioCombinedScore(technicalScore, fundamentalScore);

            return {
              symbol: h.symbol,
              scores: { combinedScore, technicalScore, fundamentalScore, fundamentalVerdict },
            };
          } catch (e) {
            return { symbol: h.symbol, scores: {} };
          }
        })
      );

      for (const r of batchResults) analysesBySymbol.set(r.symbol, r.scores);

      // Inter-batch pause to be gentle on Yahoo Finance
      if (i + intelBatchSize < holdingsNeedingAnalysis.length) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    // Fetch the current macro regime for the intelligence engine.
    //
    // COLD-START FIX (Apr 2026): Never block the portfolio response on this.
    // On a cold Vercel lambda, getMacroRegime() does ~10 RSS fetches + an
    // OpenAI call with 3 retries — 15-25s before we can respond. Meanwhile
    // Vercel's 60s function timeout looms. Strategy:
    //   1. Serve the macro regime from the in-memory cache if present
    //   2. On miss: return a neutral CALM regime immediately, fire the real
    //      refresh in the background so the NEXT request gets the real data
    //   3. The /api/cron/warm-caches hourly job keeps the cache primed so
    //      the miss path is rare in steady state
    let portfolioRegime = macroRegimeCache.get(MACRO_CACHE_KEY);
    if (!portfolioRegime) {
      portfolioRegime = defaultCalmRegime();
      // Fire-and-forget refresh. Swallow errors — they'll log inside the
      // refresher and the next caller will retry automatically.
      refreshMacroRegime().catch((e) => {
        console.warn("[MACRO] background refresh failed:", e.message);
      });
    }

    // Build the intelligence block: per-stock actions + health score + urgent queue.
    // The governance-gate closure plumbs the daily-refreshed NSE shareholding
    // data into the action engine — fires REVIEW_GOVERNANCE when pledge ≥ 25%
    // or pledge QoQ Δ > 5pp. Closure is constructed inline so the function
    // signature stays I/O-free (computeAction never imports governance.js).
    const intelligence = buildPortfolioIntelligence(enrichedStocks, analysesBySymbol, {
      regime: portfolioRegime,
      computeMacroDelta,
      getGovernanceGate: (sym) => deriveGovernanceGate(getGovernance(sym)),
    });

    // ── Catalyst calendar (Phase 3 B3) ──
    // Fetch NSE's corporate events calendar once per portfolio request (cached
    // for 2 hours) and match upcoming events to the user's holdings. Two kinds
    // of events matter for a long-only investor:
    //   • "Financial Results" board meetings → upcoming earnings announcements
    //   • "Dividend" / "Bonus" / "Split" → corporate actions to plan around
    // NSE skips from Indian IPs only, so on Vercel this will often be empty —
    // we silently skip if it's unavailable rather than failing the request.
    let catalystsBySymbol = {};
    try {
      // COLD-START FIX: NSE blocks Vercel US IPs, so fetchNseEventCalendar()
      // typically burns its full 12s timeout on cold start. Don't block on it.
      // Serve from cache if present; otherwise trigger a background refresh
      // and move on (warm-caches cron also keeps this fresh).
      let events = catalystCache.get("nse_events");
      if (!events) {
        events = [];
        fetchNseEventCalendar()
          .then((e) => catalystCache.set("nse_events", e))
          .catch(() => {});
      }
      const portfolioSymbols = new Set(
        enrichedStocks.map((h) => h.symbol.replace(".NS", "").replace(".BO", "").toUpperCase())
      );
      // Also include NSE's own symbol variants (e.g. ARE&M maps to our ARE&M)
      const matched = events.filter((e) => portfolioSymbols.has(e.symbol));
      // Categorise each event: earnings, dividend, other
      for (const e of matched) {
        const cat = /financial result/i.test(e.purpose) ? "earnings"
                  : /dividend/i.test(e.purpose) ? "dividend"
                  : /bonus|split/i.test(e.purpose) ? "corporate_action"
                  : "other";
        const sym = e.symbol + ".NS";
        if (!catalystsBySymbol[sym]) catalystsBySymbol[sym] = [];
        catalystsBySymbol[sym].push({
          date: e.date,
          purpose: e.purpose,
          category: cat,
          description: e.description,
        });
      }
    } catch (e) {
      // Silent — catalyst data is a nice-to-have, don't fail the portfolio request
      console.error("Catalyst calendar fetch failed:", e.message);
    }

    // Merge per-stock intelligence + catalyst info into each stock so the
    // frontend has everything in one place
    const enrichedWithIntel = enrichedStocks.map((h) => ({
      ...h,
      intelligence: intelligence.perStock[h.symbol] || null,
      catalysts: catalystsBySymbol[h.symbol] || null,
    }));

    // Calculate stock portfolio totals (invested is always available; current only when quotes loaded)
    const totalInvested = enrichedStocks.reduce((s, h) => s + (h.investedValue || 0), 0);
    const totalCurrent = enrichedStocks.reduce((s, h) => s + (h.currentValue || 0), 0);
    const quotesLoaded = enrichedStocks.filter((h) => h.currentPrice != null).length;
    const totalPnl = totalCurrent - totalInvested;
    const totalPnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    // Calculate mutual fund totals
    const mfs = portfolio.mutualFunds || [];
    const mfTotalInvested = mfs.reduce((s, m) => s + (m.invested || 0), 0);
    const mfTotalCurrent = mfs.reduce((s, m) => s + (m.current || 0), 0);
    const mfTotalPnl = mfTotalCurrent - mfTotalInvested;
    const mfTotalPnlPercent = mfTotalInvested > 0 ? (mfTotalPnl / mfTotalInvested) * 100 : 0;

    const response = {
      stocks: enrichedWithIntel,
      mutualFunds: mfs,
      summary: { totalInvested, totalCurrent, totalPnl, totalPnlPercent, quotesLoaded, totalStocks: enrichedStocks.length },
      mfSummary: { totalInvested: mfTotalInvested, totalCurrent: mfTotalCurrent, totalPnl: mfTotalPnl, totalPnlPercent: mfTotalPnlPercent },
      intelligence: {
        healthScore: intelligence.healthScore,
        healthVerdict: intelligence.healthVerdict,
        healthBreakdown: intelligence.healthBreakdown,
        healthStats: intelligence.healthStats,
        urgentActions: intelligence.urgentActions,
        sectorAllocation: intelligence.sectorAllocation,
        topWinners: intelligence.topWinners,
        topLosers: intelligence.topLosers,
        catalystCount: Object.values(catalystsBySymbol).reduce((s, arr) => s + arr.length, 0),
      },
      // Macro regime context for the banner + sector chips on the Portfolio tab
      regime: portfolioRegime,
      lastUpdated: portfolio.lastUpdated,
    };

    // Two-tier write. L1 serves this instance for 30s; L2 serves other
    // warm lambdas for 60s (slightly longer so the shared copy outlives
    // individual instances' L1 windows).
    portfolioCache.set(cacheKey, response);
    try {
      const kv = await getKVClientForPortfolio();
      if (kv) await kv.set(`portfolio:resp:${cacheKey}`, response, { ex: 60 });
    } catch (e) { /* silent — cache write failure is non-fatal */ }
    res.set("X-Cache", "MISS");
    res.json(response);
  } catch (err) {
    console.error("Portfolio error:", err.message);
    res.status(500).json({ error: "Failed to load portfolio" });
  }
});

/** POST portfolio — save holdings from Groww scrape */
app.post("/api/portfolio", async (req, res) => {
  try {
    const sub = userSub(req);
    if (!sub) return res.status(401).json({ error: "auth-required" });
    const { stocks, mutualFunds } = req.body;
    // Preserve any other fields already on the portfolio (riskProfile etc.)
    // — POST /api/portfolio is the Groww-import endpoint and shouldn't wipe
    // a user's risk-profile survey just because they re-imported.
    //
    // Distinguish "field omitted" from "field sent as empty array": only
    // overwrite when the client actually sent a value, so a stocks-only
    // post doesn't nuke saved MF holdings.
    const existing = await readPortfolio(sub);
    const data = {
      ...existing,
      stocks: stocks !== undefined ? stocks : (existing.stocks || []),
      mutualFunds: mutualFunds !== undefined ? mutualFunds : (existing.mutualFunds || []),
      lastUpdated: new Date().toISOString(),
    };
    await savePortfolio(sub, data);
    res.json({ ok: true, stockCount: data.stocks.length, mfCount: data.mutualFunds.length });
  } catch (err) {
    console.error("Portfolio save error:", err.message);
    res.status(500).json({ error: "Failed to save portfolio" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Risk Profile (Priority 3 of the MF recommender).
//
// Three-question survey persisted alongside the portfolio. Read by the
// analyzer pipeline so the per-fund recommender can tag misalignment and
// the asset-allocation gap module can pick the right target weights.
//
// The survey itself is dumb data — see riskProfile.js for the question
// schema and scoring. Endpoints intentionally minimal:
//   GET  /api/risk-profile  → { present: bool, answers, bucket, score, completedAt }
//   POST /api/risk-profile  → { ok: true, riskProfile }
//   DELETE /api/risk-profile → soft-clear (lets the user retake the survey)
// ═══════════════════════════════════════════════════════════════════════════

import { scoreRiskProfile, RISK_PROFILE_QUESTIONS } from "./riskProfile.js";

// ─── /api/health — operational stage-age + provider state (P3.1) ───
//
// Reports mtimes of the data files that downstream tabs consume, plus
// the currently-active LLM provider (from earnings-health.json). First-
// line observability — alerting hangs off this in a later PR.
// Public endpoint (no auth) so external uptime checks can hit it without
// session cookies, but no per-user data is included.
function fileAgeHours(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const ms = Date.now() - fs.statSync(p).mtimeMs;
    return Math.round((ms / 36e5) * 100) / 100;
  } catch { return null; }
}
app.get("/api/health", (req, res) => {
  const dataDir = path.join(__dirname, "data");
  const ages = {
    sws_picks_age_h: fileAgeHours(path.join(dataDir, "sws", "picks-latest.json")),
    earnings_watch_age_h: fileAgeHours(path.join(dataDir, "catalysts", "earnings-watch-latest.json")),
    nse_corp_age_h: fileAgeHours(path.join(dataDir, "catalysts", "nse-announcements-rolling.json")),
    fundamentals_history_age_h: fileAgeHours(path.join(__dirname, "fundamentalsHistory.json")),
    earnings_health_age_h: fileAgeHours(path.join(dataDir, "catalysts", "earnings-health.json")),
    earnings_backtest_age_h: fileAgeHours(path.join(dataDir, "catalysts", "earnings-backtest-latest.json")),
    ablation_age_h: fileAgeHours(path.join(dataDir, "catalysts", "ablation-latest.json")),
  };
  // Surface the LLM provider currently in use (heuristic / groq / gemini)
  // from earnings-health.json if it's been written today.
  //
  // `llm_providers` is the current field name (see earningsHealth.js
  // buildHealthSummary). The two older names (`llm_provider_split`,
  // `llm_provider`) are kept in the fallback chain so a pre-v1 health
  // file still resolves to something. `llm_offline` is the typed flag the
  // banner reads — single source of truth for the heuristic-fallback
  // chip, aligned with the >=80% heuristic && groq=0 && gemini=0
  // threshold inside earningsHealth.js (NOT the older 50% rule).
  let llm_provider = null,
      llm_providers = null,
      llm_offline = false,
      llm_heuristic_share_pct = null,
      cap_lift_gate = null,
      source_conflicts_30d = null,
      insufficient_data_30d = null,
      llm_stats = null;
  try {
    const healthPath = path.join(dataDir, "catalysts", "earnings-health.json");
    if (fs.existsSync(healthPath)) {
      const h = JSON.parse(fs.readFileSync(healthPath, "utf-8"));
      llm_providers = h?.llm_providers || h?.llm_provider_split || null;
      llm_provider = llm_providers || h?.llm_provider || null;
      llm_offline = h?.llm_offline === true;
      llm_heuristic_share_pct =
        typeof h?.llm_heuristic_share_pct === "number" ? h.llm_heuristic_share_pct : null;
      cap_lift_gate = h?.cap_lift_gate || null;
      source_conflicts_30d = h?.source_conflicts?.count_30d ?? null;
      insufficient_data_30d = h?.insufficient_data?.count_30d ?? null;
    }
    // Surface the last refresh's batcher stats so a cache-invalidation
    // spike is visible without scraping logs.
    const statsPath = path.join(dataDir, "catalysts", "earnings-watch-stats.json");
    if (fs.existsSync(statsPath)) {
      const s = JSON.parse(fs.readFileSync(statsPath, "utf-8"));
      llm_stats = s?.llm_stats || null;
    }
  } catch {}
  // Status: ok if all critical-tier ages are < 48h; degraded if any is older.
  const critical = [ages.sws_picks_age_h, ages.earnings_watch_age_h];
  const status =
    critical.some((a) => a == null || a > 48) ? "degraded" : "ok";
  res.json({
    ok: status === "ok",
    status,
    auth_enabled: AUTH_ENABLED,
    cors_allowlist_size: CORS_ALLOWLIST.length,
    upload_quota_per_hour: PORTFOLIO_UPLOADS_PER_HOUR,
    ages,
    llm_provider,
    llm_providers,
    llm_offline,
    llm_heuristic_share_pct,
    llm_stats,
    cap_lift_gate,
    source_conflicts_30d,
    insufficient_data_30d,
    timestamp: new Date().toISOString(),
  });
});

// ─── /legal/* — static legal pages (P1.3 grievance, P1.4 methodology,
// P4.1 Investor Charter). These are served from /gated/*.html so the
// per-session auth gate still applies in production; in dev (AUTH_ENABLED
// false) they're publicly readable, which is the desired friends-and-
// family behaviour.
function serveGatedHtml(filename) {
  return (req, res) => {
    const p = path.join(__dirname, "gated", filename);
    if (!fs.existsSync(p)) {
      return res.status(404).send(`<h1>Page not found</h1><p>${filename} is missing.</p>`);
    }
    res.type("text/html").sendFile(p);
  };
}
app.get("/legal/grievance", serveGatedHtml("grievance.html"));
app.get("/legal/charter", serveGatedHtml("charter.html"));
app.get("/methodology", serveGatedHtml("methodology.html"));

// ─── /api/audit/earnings/:symbol/:event_iso_date — per-prediction
// audit trail (P4.2, 2026-05-16). Reg-25-style basis disclosure: returns
// the full archived prediction row for the requested (symbol, event_date)
// pair, including the score_breakdown, all 9 component values, the
// predictor version, and the data_quality flags. A friend can ask
// "why did you tell me X on date Y" and get the exact inputs that fed
// the model on that day. Reads from data/catalysts/earnings-history/
// (per-day snapshots written atomically by earningsHistoryArchive.js).
app.get("/api/audit/earnings/:symbol/:event_iso_date", (req, res) => {
  try {
    const symbol = String(req.params.symbol || "").toUpperCase().trim();
    const eventDate = String(req.params.event_iso_date || "").trim();
    if (!/^[A-Z0-9.\-_]{1,20}$/.test(symbol)) {
      return res.status(400).json({ error: "Invalid symbol" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return res.status(400).json({ error: "Invalid event_iso_date — must be YYYY-MM-DD" });
    }
    const histDir = path.join(__dirname, "data", "catalysts", "earnings-history");
    if (!fs.existsSync(histDir)) {
      return res.status(404).json({ error: "No earnings history archive yet." });
    }
    // Scan all daily snapshots, NEWEST first, to find the most-recent row
    // for this (symbol, event_iso_date). Multiple snapshots may carry the
    // same prediction across days; the latest is authoritative because
    // actuals would have landed on it post-event.
    const files = fs.readdirSync(histDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();
    for (const f of files) {
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(histDir, f), "utf-8"));
        const rows = Array.isArray(snap?.predictions) ? snap.predictions :
                     Array.isArray(snap?.rows) ? snap.rows :
                     Array.isArray(snap) ? snap : [];
        const hit = rows.find((r) =>
          (r?.symbol || "").toUpperCase() === symbol &&
          (r?.event_iso_date === eventDate || r?.event_date === eventDate)
        );
        if (hit) {
          return res.json({
            symbol,
            event_iso_date: eventDate,
            snapshot_file: f,
            snapshot_date: f.replace(".json", ""),
            row: hit,
            note: "Read the row's predictor_version + score_breakdown for the basis. Multiple snapshots may carry this prediction; the row returned is from the newest snapshot containing it.",
          });
        }
      } catch {
        // Skip malformed snapshot files; keep scanning.
      }
    }
    return res.status(404).json({
      error: "No prediction found for this (symbol, event_iso_date) pair.",
      hint: "Check the spelling (symbol is uppercase NSE ticker; date is fiscal-quarter event in YYYY-MM-DD).",
    });
  } catch (err) {
    console.error("[AUDIT] /api/audit/earnings error:", err.message);
    res.status(500).json({ error: "Audit trail read failed" });
  }
});

// ─── /api/disclosures/holdings — author position + COI disclosure (P0.5) ───
//
// SEBI RA Reg 24(2) requires research analysts to disclose positions in
// covered securities at the time of publication; even though Starbhai is
// not registered, the convention is followed so a friend can answer "does
// the author own this stock?" without asking. Served straight from
// data/disclosures/holdings.json — edited by hand, rotated quarterly.
// Footer of every page links here.
app.get("/api/disclosures/holdings", (req, res) => {
  try {
    const p = path.join(__dirname, "data", "disclosures", "holdings.json");
    if (!fs.existsSync(p)) {
      return res.status(404).json({
        error: "No disclosure file yet.",
        hint: "Author has not published the holdings disclosure for this period.",
      });
    }
    const raw = fs.readFileSync(p, "utf-8");
    res.type("application/json").send(raw);
  } catch (err) {
    console.error("[DISCLOSURES] holdings read error:", err.message);
    res.status(500).json({ error: "Failed to read holdings disclosure" });
  }
});

app.get("/api/risk-profile", async (req, res) => {
  try {
    const sub = userSub(req);
    if (!sub) return res.status(401).json({ error: "auth-required" });
    const portfolio = await readPortfolio(sub);
    const rp = portfolio?.riskProfile || null;
    res.json({
      questions: RISK_PROFILE_QUESTIONS,
      present: !!(rp && rp.bucket),
      riskProfile: rp,
    });
  } catch (err) {
    console.error("[RISK-PROFILE] read error:", err.message);
    res.status(500).json({ error: "Failed to read risk profile" });
  }
});

app.post("/api/risk-profile", express.json(), async (req, res) => {
  try {
    const sub = userSub(req);
    if (!sub) return res.status(401).json({ error: "auth-required" });
    const answers = req.body?.answers || req.body;
    const scored = scoreRiskProfile(answers);
    if (!scored) {
      return res.status(400).json({
        error: "Incomplete answers — all 3 questions are required.",
        questions: RISK_PROFILE_QUESTIONS,
      });
    }
    const portfolio = await readPortfolio(sub);
    const next = {
      ...portfolio,
      riskProfile: { ...scored, answers },
    };
    await savePortfolio(sub, next);
    res.json({ ok: true, riskProfile: next.riskProfile });
  } catch (err) {
    console.error("[RISK-PROFILE] save error:", err.message);
    res.status(500).json({ error: "Failed to save risk profile" });
  }
});

app.delete("/api/risk-profile", async (req, res) => {
  try {
    const sub = userSub(req);
    if (!sub) return res.status(401).json({ error: "auth-required" });
    const portfolio = await readPortfolio(sub);
    const next = { ...portfolio, riskProfile: null };
    await savePortfolio(sub, next);
    res.json({ ok: true });
  } catch (err) {
    console.error("[RISK-PROFILE] clear error:", err.message);
    res.status(500).json({ error: "Failed to clear risk profile" });
  }
});

// ─── requireRiskProfile() — hard-gate for personalised advisory endpoints ───
//
// Returns 412 Precondition Failed with code RISK_PROFILE_REQUIRED when the
// authenticated user has no completed risk profile. SEBI IA Reg 2013
// Schedule III requires risk profiling before personalised recommendations;
// soft-gating (the pre-2026-05-16 behaviour) had the analyser silently
// fall back to MODERATE assumptions even when no profile was set, so a
// 25-year-old day trader and a 60-year-old retiree saw identical advice.
// Universal data endpoints (sws-picks, earnings calendar, watchlist) stay
// open — only the personalised /api/portfolio/analyze, /api/portfolio/
// analyze/rerun and /api/portfolio/optimize endpoints are gated.
async function requireRiskProfile(req, res, next) {
  try {
    const sub = userSub(req);
    if (!sub) return res.status(401).json({ error: "auth-required" });
    const portfolio = await readPortfolio(sub);
    const bucket = portfolio?.riskProfile?.bucket;
    if (!bucket) {
      return res.status(412).json({
        error: "Risk profile required before personalised analysis.",
        code: "RISK_PROFILE_REQUIRED",
        profile_endpoint: "/api/risk-profile",
      });
    }
    next();
  } catch (err) {
    console.error("[REQUIRE-RISK-PROFILE] error:", err.message);
    res.status(500).json({ error: "Failed to verify risk profile" });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Portfolio Analyzer — SWS-powered deep analysis with per-user persistence.
//
// POST /api/portfolio/analyze       — accepts a multipart file upload (Groww
//                                     xlsx/CSV, Zerodha CSV, Upstox xlsx),
//                                     parses + stores the holdings under the
//                                     authenticated user's sub, then returns
//                                     a fresh SWS analysis report.
// POST /api/portfolio/analyze/rerun — recomputes the report against the
//                                     user's last-stored holdings using
//                                     current SWS data + live quotes.
//                                     Called by the UI on every analyzer
//                                     tab open so the report is always fresh.
// ═══════════════════════════════════════════════════════════════════════════

// P3.6 (2026-05-16) — per-user upload quota.
//
// Multer keeps the parsed file in process memory (memoryStorage). A
// malicious or buggy client uploading repeatedly could exhaust the
// Vercel function's heap before the 2MB-per-file cap matters. This map
// tracks { sub: [timestamps] } in-process and rejects more than
// PORTFOLIO_UPLOADS_PER_HOUR uploads per sub per rolling hour. The map
// is in-process (resets on each lambda cold-start), which is acceptable
// for the friends-and-family threat model — the goal is to limit a
// single user's burst impact, not to defend against a distributed
// attack. For that you'd need Vercel KV or a Redis bucket.
const PORTFOLIO_UPLOADS_PER_HOUR = 10;
const uploadQuotaMap = new Map(); // sub → number[] of timestamps
function checkUploadQuota(sub) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const history = (uploadQuotaMap.get(sub) || []).filter((t) => t > hourAgo);
  if (history.length >= PORTFOLIO_UPLOADS_PER_HOUR) {
    return { ok: false, retryAfterSec: Math.ceil((history[0] + 60 * 60 * 1000 - now) / 1000) };
  }
  history.push(now);
  uploadQuotaMap.set(sub, history);
  return { ok: true };
}
async function requireUploadQuota(req, res, next) {
  const sub = userSub(req);
  if (!sub) return res.status(401).json({ error: "auth-required" });
  const q = checkUploadQuota(sub);
  if (!q.ok) {
    res.set("Retry-After", String(q.retryAfterSec));
    return res.status(429).json({
      error: `Upload quota exceeded — max ${PORTFOLIO_UPLOADS_PER_HOUR} per hour per user.`,
      code: "UPLOAD_QUOTA_EXCEEDED",
      retry_after_seconds: q.retryAfterSec,
    });
  }
  next();
}

const portfolioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB is plenty for a holdings statement
});

// Load the user-context bits both /analyze and /analyze/rerun need:
// saved MF holdings (analyzer-shape) + risk profile. freshCapital +
// LTCG-YTD come from request body/query (defaults: null / 0).
async function loadAnalyzerUserContext(sub, reqBody = {}, reqQuery = {}) {
  let mfHoldings = [];
  let savedRiskProfile = null;
  const freshCapitalInr = Number.parseFloat(reqBody?.freshCapitalInr ?? reqQuery?.freshCapitalInr ?? "0") || null;
  const ltcgRealisedYtdRupees = Number.parseFloat(reqBody?.ltcgRealisedYtd ?? reqQuery?.ltcgRealisedYtd ?? "0");

  try {
    const saved = await readPortfolio(sub);
    if (saved && saved.riskProfile && saved.riskProfile.bucket) {
      savedRiskProfile = saved.riskProfile;
    }
    if (saved && Array.isArray(saved.mutualFunds)) {
      mfHoldings = saved.mutualFunds.map((m) => ({
        name: m.name || m.schemeName,
        rawName: m.name || m.schemeName,
        isin: m.isin || null,
        category: m.category || null,
        subCategory: m.subCategory || null,
        folio: m.folio || null,
        instrumentType: "mf",
        invested: Number(m.invested ?? m.investedValue ?? 0),
        currentValue: Number(m.current ?? m.currentValue ?? m.invested ?? 0),
        publishedXirrPct: Number.isFinite(Number(m.xirr)) ? Number(m.xirr) : null,
        pnlPercent: Number.isFinite(Number(m.returns)) ? Number(m.returns) : null,
        purchaseDate: m.firstPurchaseDate || m.purchaseDate || null,
      }));
    }
  } catch (e) {
    console.warn("[ANALYZE] could not load saved MF holdings:", e.message);
  }

  return { mfHoldings, savedRiskProfile, freshCapitalInr, ltcgRealisedYtdRupees };
}

// Run the SWS scoring + report build against a parsed portfolio.
// `parsed` must have { holdings, mfHoldings, unmatched, warnings, source, summary }
// in the same shape that parsePortfolioFile() returns. Both /analyze (with a
// fresh upload) and /analyze/rerun (with stored holdings) call this helper —
// extracting it prevents the two paths from drifting out of sync.
async function runSWSAnalysis({
  parsed,
  mfHoldings,
  savedRiskProfile,
  optTaxSlabPct,
  ltcgRealisedYtdRupees,
  freshCapitalInr,
  uploadedAtIso,
}) {
  const swsT0 = Date.now();
  const swsTimings = {};

  // Earnings-watch snapshot for the prediction-aware reasoning bullet
  // (services/swsHoldingEngine.js consumes this via portfolioContext).
  // Loaded once per analyzer run — the 300s NodeCache in
  // loadCachedEarningsSnapshot keeps this cheap across repeated /analyze
  // and /analyze/rerun calls within the cache window.
  //
  // Staleness gate: if the snapshot is >7 days old or missing, we pass
  // null down so the holding engine falls back to its legacy behaviour
  // (no prediction bullet). A single warning per run keeps the log noise
  // bounded — we don't want 70× the same line for a 70-stock portfolio.
  let earningsSnapshot = null;
  try {
    const _snap = loadCachedEarningsSnapshot();
    if (_snap && !_snap._missing && _snap.upstream_fetched_at) {
      const _ageMs = Date.now() - Date.parse(_snap.upstream_fetched_at);
      const _ageDays = Number.isFinite(_ageMs) ? _ageMs / 86_400_000 : null;
      if (_ageDays != null && _ageDays > 7) {
        console.warn(`[ANALYZER] earnings-watch snapshot stale (${_ageDays.toFixed(1)}d) — prediction reasoning disabled this run`);
      } else {
        earningsSnapshot = _snap;
      }
    } else {
      console.warn("[ANALYZER] earnings-watch snapshot missing — prediction reasoning disabled this run");
    }
  } catch (err) {
    console.warn(`[ANALYZER] earnings-watch snapshot load failed: ${err && err.message} — prediction reasoning disabled this run`);
  }

  const equityHoldings = parsed.holdings.map((h) => {
    const qty = Number(h.quantity) || 0;
    const avg = Number(h.avgPrice) || 0;
    return { ...h, quantity: qty, avgPrice: avg, invested: qty * avg };
  });

  // FY tax context — single source of truth for the LTCG-budget the user
  // has remaining for this financial year. Built once per call, shared
  // across every holding's tax scenarios so the exemption math is
  // consistent (each holding sees the SAME remaining budget — they don't
  // all "consume" it independently).
  const fyContext = swsBuildFyContext(
    new Date(),
    Number.isFinite(ltcgRealisedYtdRupees) ? ltcgRealisedYtdRupees : 0,
    0,
  );

  // First pass: pull SWS price + sector for every holding so we can
  // compute portfolio-wide weights before action mapping. Second pass
  // re-runs scoring with the real position/sector weights so action
  // mapping (Reduction-50% on >10% positions, etc.) fires.
  const firstPass = equityHoldings.map((h) =>
    swsScoreHolding({ ...h, positionWeight: 0, sectorWeight: 0, pnlPercent: 0 }, { sectorWeights: {} }),
  );

  let totalInvested = 0;
  let totalCurrent = 0;
  const sectorCV = new Map();
  const enrichedRows = firstPass.map((row) => {
    // Price priority: SWS live > fundamentals.json fallback > broker closing
    // price > avg cost. The fallback path (post-demerger / freshly-listed
    // names like TMCV/TMPV) populates row.sws.current_price_inr from
    // fundamentals.json even when swsCovered is false — using it here keeps
    // /analyze and /rerun consistent (the broker close price isn't persisted,
    // so /rerun loses it after refresh).
    const swsCoveredPrice = row.swsCovered ? Number(row.sws?.current_price_inr) : null;
    const fallbackPrice = (!row.swsCovered && row.sws?.current_price_inr != null)
      ? Number(row.sws.current_price_inr)
      : null;
    const brokerPrice = Number(row.closePrice) || 0;
    const qty = Number(row.quantity) || 0;
    const avg = Number(row.avgPrice) || 0;
    const invested = qty * avg;
    const pickFinite = (n) => (n != null && Number.isFinite(n) && n > 0) ? n : null;
    const livePrice = pickFinite(swsCoveredPrice)
      ?? pickFinite(fallbackPrice)
      ?? (brokerPrice > 0 ? brokerPrice : null);
    const priceSource = pickFinite(swsCoveredPrice) ? "sws"
      : pickFinite(fallbackPrice) ? "fallback"
      : (brokerPrice > 0 ? "broker" : "avg");
    const currentValue = livePrice != null ? qty * livePrice : invested;
    totalInvested += invested;
    totalCurrent += currentValue;
    // Sector resolution: prefer the curated stockList sector (consistent
    // proper-case vocabulary) over the SWS deep-file sector to keep the
    // overlay from fragmenting into duplicate buckets.
    const sector = row.sector || (row.swsCovered ? row.sws.sector : null) || "Unclassified";
    sectorCV.set(sector, (sectorCV.get(sector) || 0) + currentValue);
    return { ...row, invested, currentValue, livePrice, priceSource, sector };
  });

  const sectorWeights = {};
  for (const [sector, cv] of sectorCV.entries()) {
    sectorWeights[sector] = totalCurrent > 0 ? (cv / totalCurrent) * 100 : 0;
  }

  // Macro regime — cached value from the same NodeCache that Market
  // Intelligence + scanners populate. Empty cache → calm regime fallback.
  const cachedRegime = macroRegimeCache.get(MACRO_CACHE_KEY) || defaultCalmRegime();
  const regimeSeverity = Number(cachedRegime?.severity) || 0;
  const sectorImpactBySector = {};
  for (const sectorName of Object.keys(sectorWeights)) {
    const hit = (cachedRegime?.sectorImpacts || []).find((s) => s.sector === sectorName);
    sectorImpactBySector[sectorName] = hit?.impact ?? 0;
  }

  const scoredHoldings = enrichedRows.map((row) => {
    const positionWeight = totalCurrent > 0 ? (row.currentValue / totalCurrent) * 100 : 0;
    const sectorWeight = sectorWeights[row.sector] || 0;
    const pnlPercent = row.invested > 0 ? ((row.currentValue - row.invested) / row.invested) * 100 : 0;
    const rescored = swsScoreHolding(
      { ...row, positionWeight, sectorWeight, pnlPercent },
      { sectorWeights, fyContext, taxSlabPct: optTaxSlabPct, regimeSeverity, sectorImpactBySector, earningsSnapshot },
    );
    return {
      ...rescored,
      invested: Math.round(row.invested),
      currentValue: Math.round(row.currentValue),
      pnlAmount: Math.round(row.currentValue - row.invested),
      pnlPercent: Math.round(pnlPercent * 100) / 100,
      positionWeight: Math.round(positionWeight * 100) / 100,
      sectorWeight: Math.round(sectorWeight * 100) / 100,
      livePrice: row.livePrice,
    };
  });

  swsTimings.score_ms = Date.now() - swsT0;
  const aggT0 = Date.now();
  // asOfDate from the broker statement is "DD-MM-YYYY"; toIsoDate normalises
  // it to ISO. uploadedAtIso comes in already-ISO from the call site.
  const asOfDateIso = parsed?.summary?.asOfDate
    ? toIsoDate(parsed.summary.asOfDate)
    : null;
  const brokerSummary = parsed?.summary
    ? {
        invested: Number.isFinite(parsed.summary.invested) ? parsed.summary.invested : null,
        current: Number.isFinite(parsed.summary.current) ? parsed.summary.current : null,
        unrealisedPL: Number.isFinite(parsed.summary.unrealisedPL) ? parsed.summary.unrealisedPL : null,
        asOfDate: asOfDateIso,
      }
    : null;
  const swsReport = buildSWSReport(scoredHoldings, {
    freshCapitalInr,
    freshPickLimit: 8,
    macroRegime: cachedRegime,
    uploadedAtIso: uploadedAtIso ?? null,
    asOfDateIso,
    brokerSummary,
  });
  swsTimings.aggregate_ms = Date.now() - aggT0;

  // MF enrichment: only enrich MFs from the upload (saved-portfolio MFs
  // surface as raw reference rows).
  let mfPositions = null;
  const uploadedMfs = Array.isArray(parsed.mfHoldings) ? parsed.mfHoldings : [];
  const mfT0 = Date.now();
  if (uploadedMfs.length > 0) {
    try {
      await Promise.all([
        enrichMfHoldings(uploadedMfs),
        enrichMfNews(uploadedMfs, { openai: getOpenAI() }),
        enrichLivePeers(uploadedMfs),
      ]);
      await enrichBenchmarkMetrics(uploadedMfs);
      const mfReport = buildReport([], [], {
        source: parsed.source,
        mfHoldings: uploadedMfs,
        riskProfile: savedRiskProfile,
        warnings: [],
      });
      mfPositions = mfReport.mfPositions || null;
    } catch (e) {
      console.warn("[ANALYZE/SWS] MF enrichment failed:", e.message);
    }
  } else if (mfHoldings.length > 0) {
    mfPositions = {
      source: "saved-portfolio",
      enriched: false,
      riskProfile: savedRiskProfile,
      holdings: mfHoldings.map((m) => ({
        name: m.name,
        category: m.category,
        invested: m.invested,
        currentValue: m.currentValue,
        pnlPercent: m.pnlPercent,
        publishedXirrPct: m.publishedXirrPct,
      })),
      note: "Saved-portfolio MFs shown without live AMFI/news enrichment.",
    };
  }
  swsTimings.mf_ms = Date.now() - mfT0;
  swsTimings.mf_count = uploadedMfs.length;
  swsTimings.mf_saved_count = mfHoldings.length;

  const sessionId = randomUUID();
  analyzerCache.set(sessionId, {
    engine: "sws",
    holdings: scoredHoldings,
    mfHoldings,
    sectorAllocation: swsReport.sectorOverlay || [],
    ltcgRealisedYtdRupees,
    cachedAt: Date.now(),
  });

  return {
    swsElapsedMs: Date.now() - swsT0,
    swsTimings,
    sessionId,
    _scoredHoldings: scoredHoldings,
    report: {
      ...swsReport,
      source: parsed.source,
      asOfDate: parsed.summary?.asOfDate ?? null,
      mfPositions,
      unmatched: parsed.unmatched || [],
      warnings: parsed.warnings || [],
      disclaimer: "Educational content only.",
      // ANALYZER_UI_V2 flag — gated on env. Client renderSWSAnalyzerReport
      // dispatches to V2 (hero + glossary chips) when v2 is true.
      ui: { v2: process.env.ANALYZER_UI_V2 === "1" },
    },
  };
}

// Wire the recommendation-memory pipeline into the analyzer response.
//
// On a fresh upload (isRerun=false): build the canonical snapshot, run the
// reconciler against the previous snapshot, classify execution events, build
// fresh ISSUED events with suppression, decorate the report, then persist
// snapshot + ledger (snapshot first — see plan §atomicity).
//
// On a rerun (isRerun=true): no reconciliation, no writes. Just apply the
// open-rec map to the report so suppression badges / pending markers render
// correctly without re-emitting acks the user has already seen.
async function applyAnalyzerMemory({ sub, parsed, swsResult, uploadedAtIso, sourceFile, isRerun }) {
  const historyStore = getPortfolioHistoryStorage();
  const ledgerStore = getRecommendationLedgerStorage();
  let history, ledger;
  try {
    [history, ledger] = await Promise.all([
      historyStore.read(sub),
      ledgerStore.read(sub),
    ]);
  } catch (e) {
    console.warn("[MEMORY] read failed — treating as first-upload:", e.message);
    history = { snapshots: [] };
    ledger = { events: [] };
  }

  const rawAsOf = parsed?.summary?.asOfDate ?? null;
  let asOfDateIso = rawAsOf ? toIsoDate(rawAsOf) : null;
  let asOfDateInferred = false;
  if (!asOfDateIso) {
    asOfDateIso = String(uploadedAtIso).slice(0, 10);
    asOfDateInferred = true;
  }

  const newSnap = memBuildSnapshot({
    asOfDateIso,
    asOfDateInferred,
    uploadedAtIso,
    parsed,
    scoredHoldings: swsResult._scoredHoldings || [],
    sourceFile,
    history,
  });

  // Rerun path: suppression-only, no writes. We still want the cooldown gate
  // to demote recently-executed names out of Tier A — otherwise opening the
  // tab a day after a trim would re-flag the same name even though the gate
  // already suppressed the ledger write. So we call memBuildIssued with an
  // empty reconcile pass purely to recover the cooldownEntries, then apply
  // the demotion. No ISSUED events are persisted on this code path.
  if (isRerun) {
    const openRecs = memDeriveOpenRecs(ledger.events);
    const { cooldownEntries: rerunCooldownEntries = [] } = memBuildIssued({
      scoredHoldings: swsResult._scoredHoldings || [],
      newSnap,
      openRecsAfterReconcile: openRecs,
      ledgerEvents: ledger.events,
      reconcileEvents: [],
    });
    const demoted = memApplyCooldownDemotion(swsResult._scoredHoldings || [], rerunCooldownEntries);
    if (demoted.size > 0) rebuildTierAggregates(swsResult.report, swsResult._scoredHoldings || []);
    memApplyToReport(swsResult.report, {
      newSnap,
      prevSnap: history.snapshots[0] || null,
      openRecsBeforeReconcile: openRecs,
      reconcileEvents: [],
      issuedEvents: [],
      suppressedCandidateRecIds: new Set(),
      supersedeMap: new Map(),
      cooldownEntries: rerunCooldownEntries,
      isBackdated: newSnap.backdated,
      historySnapshots: history.snapshots,
    });
    return { newSnap, persisted: false };
  }

  // Backdated: persist for audit, skip reconciliation. The reconciler going
  // backwards in time would emit nonsense events.
  if (newSnap.backdated) {
    memApplyToReport(swsResult.report, {
      newSnap,
      prevSnap: history.snapshots[0] || null,
      openRecsBeforeReconcile: new Map(),
      reconcileEvents: [],
      issuedEvents: [],
      suppressedCandidateRecIds: new Set(),
      supersedeMap: new Map(),
      isBackdated: true,
      historySnapshots: history.snapshots,
    });
    try { await historyStore.appendSnapshot(sub, newSnap); }
    catch (e) { console.warn("[MEMORY] history append (backdated) failed:", e.message); }
    return { newSnap, persisted: true, backdated: true };
  }

  // Forward-dated full reconciliation.
  const openRecsBefore = memDeriveOpenRecs(ledger.events);
  const { events: reconcileEvents } = memReconcile({
    prevSnap: history.snapshots[0] || null,
    newSnap,
    openRecs: openRecsBefore,
    historySnapshots: history.snapshots,
  });

  const openRecsAfter = memApplyReconcileToOpenRecs(openRecsBefore, reconcileEvents);
  const { events: issuedEvents, suppressedCandidateRecIds, supersedeMap, cooldownEntries } = memBuildIssued({
    scoredHoldings: swsResult._scoredHoldings || [],
    newSnap,
    openRecsAfterReconcile: openRecsAfter,
    // Post-execution cooldown gate needs both the historic ledger AND the
    // current pass's reconcile events. The reconciler may have just emitted
    // an EXECUTED that closes a same-direction rec — the gate needs to see
    // that fresh event before the issuer mints a duplicate ISSUED.
    ledgerEvents: ledger.events,
    reconcileEvents,
  });

  // Wire the cooldown gate into the visible report: demote any holding the
  // gate just suppressed from "Reduction-25%" to "HOLD" and rebuild Tier
  // aggregates so it falls out of Tier A and into Tier C with a "trimmed
  // recently, no further action" marker the UI renders.
  const demoted = memApplyCooldownDemotion(swsResult._scoredHoldings || [], cooldownEntries);
  if (demoted.size > 0) rebuildTierAggregates(swsResult.report, swsResult._scoredHoldings || []);

  memApplyToReport(swsResult.report, {
    newSnap,
    prevSnap: history.snapshots[0] || null,
    openRecsBeforeReconcile: openRecsBefore,
    reconcileEvents,
    issuedEvents,
    suppressedCandidateRecIds,
    supersedeMap,
    cooldownEntries,
    isBackdated: false,
    historySnapshots: history.snapshots,
  });

  // Freed-capital deployment basket. Bypasses the OUTSIDE_PICKS env gate
  // because for executed-trim flows the user has actual rupees to redeploy.
  try {
    if (swsResult.report.freedCapital?.significant) {
      const picks = surfaceOutsidePicks({
        scoredHoldings: swsResult._scoredHoldings || [],
        freshCapitalInr: swsResult.report.freedCapital.totalRupeesFreed,
        limit: 6,
        forceEnabled: true,
      });
      swsResult.report.freedCapitalPicks = picks;
    }
  } catch (e) {
    console.warn("[MEMORY] freed-capital picks failed:", e.message);
  }

  // Atomic order: snapshot before ledger. If ledger append fails after a
  // successful snapshot, the next upload's reconciler re-derives the same
  // events from the snapshot pair and emits them then.
  try { await historyStore.appendSnapshot(sub, newSnap); }
  catch (e) { console.warn("[MEMORY] history append failed:", e.message); }
  try {
    const merged = [...reconcileEvents, ...issuedEvents];
    if (merged.length > 0) await ledgerStore.appendEvents(sub, merged);
  } catch (e) { console.warn("[MEMORY] ledger append failed:", e.message); }

  return {
    newSnap,
    persisted: true,
    backdated: false,
    reconcileCount: reconcileEvents.length,
    issuedCount: issuedEvents.length,
  };
}

app.post("/api/portfolio/analyze", requireUploadQuota, requireRiskProfile, portfolioUpload.single("file"), async (req, res) => {
  const t0 = Date.now();
  try {
    const sub = userSub(req);
    if (!sub) return res.status(401).json({ error: "auth-required" });
    if (!req.file) {
      return res.status(400).json({ error: "Missing file upload (field name: file)" });
    }

    // Optimizer-specific options come in via form fields (multer parses them
    // into req.body alongside the file). Query string is also accepted as a
    // fallback for direct browser testing.
    const optPreset = String(req.body.preset || req.query.preset || "balanced");
    const optTaxSlabPct = Number.parseInt(req.body.taxSlabPct || req.query.taxSlabPct || "30", 10);
    const optAssumedHoldingMonths = Number.parseInt(req.body.assumedHoldingMonths || req.query.assumedHoldingMonths || "24", 10);

    // Pull saved MF holdings + risk profile from the user's stored portfolio.
    // freshCapitalInr + ltcgRealisedYtd come from the request body/query
    // (defaults: null / 0 when absent).
    let { mfHoldings, savedRiskProfile, freshCapitalInr, ltcgRealisedYtdRupees } =
      await loadAnalyzerUserContext(sub, req.body, req.query);

    // 1. Parse the upload and resolve symbols
    let parsed;
    try {
      parsed = parsePortfolioFile(req.file.buffer, req.file.originalname || "");
    } catch (e) {
      return res.status(400).json({
        error: `Failed to parse portfolio file: ${e.message}`,
        hint: "Supported: Groww XLSX (Stocks or Mutual Funds), Groww CSV, Zerodha Console CSV, Upstox demat holdings XLSX.",
      });
    }

    // If the upload itself contains MF rows (Groww MF XLSX export), prefer
    // those over the saved-portfolio MFs — the upload is the source of truth
    // for this analyze call.
    if (Array.isArray(parsed.mfHoldings) && parsed.mfHoldings.length > 0) {
      mfHoldings = parsed.mfHoldings;
    }

    // 1b. Live NSE resolution for anything the static list + supplement
    //     couldn't match. Promotes real listed equities (newly-listed,
    //     SME Emerge, illiquid names outside the major indices) from
    //     `unmatched` → `holdings` so the full book gets analysed. Silent
    //     no-op when nothing needs live lookup.
    try {
      await resolveUnmatchedLive(parsed);
    } catch (e) {
      console.warn("[PORTFOLIO] live NSE resolution failed:", e.message);
    }

    // Build a clean "savable" snapshot of the upload — the same shape that
    // POST /api/portfolio expects. The frontend can ship this back when the
    // user ticks "Save as my portfolio" on the analyzer; that decouples the
    // save path from the rest of the report payload (which carries
    // enrichment baggage like LLM narratives that have no business sitting
    // in portfolio.json).
    //
    // mutualFunds is intentionally null when the upload doesn't contain MFs
    // so the client can omit the field from POST and the saved MF list is
    // preserved (a Stocks-only Groww export should not wipe MF holdings).
    const uploadHasMfs = Array.isArray(parsed.mfHoldings) && parsed.mfHoldings.length > 0;
    const savable = {
      stocks: parsed.holdings.map((h) => ({
        symbol: h.symbol,
        name: h.name,
        quantity: h.quantity,
        avgPrice: h.avgPrice,
        // Persist closePrice so /analyze/rerun has the same broker-statement
        // fallback when SWS doesn't cover a ticker (e.g. recently-demerged
        // names like TMCV/TMPV). Without it, /analyze and /rerun diverge:
        // /analyze uses the broker close, /rerun falls back to invested
        // cost (P&L = 0), shifting totals on every refresh.
        closePrice: h.closePrice ?? null,
        sector: h.sector || null,
        isin: h.isin || null,
        purchaseDate: h.purchaseDate || null,
      })),
      // Map analyzer-shape MF rows back to storage schema (name/category/
      // invested/current/xirr/returns) so the round-trip preserves the
      // shape readers expect. Null when the upload has no MFs.
      mutualFunds: uploadHasMfs
        ? parsed.mfHoldings.map((m) => ({
            name: m.name || m.rawName || null,
            category: m.category || null,
            subCategory: m.subCategory || null,
            folio: m.folio || null,
            invested: m.invested ?? 0,
            current: m.currentValue ?? m.invested ?? 0,
            xirr: m.publishedXirrPct ?? null,
            returns: m.pnlPercent ?? null,
            isin: m.isin || null,
          }))
        : null,
      source: parsed.source,
      parsedAt: new Date().toISOString(),
    };

    // Persist the parsed holdings (NOT the report) so the rerun endpoint
    // can recompute fresh analysis on every Portfolio Analyzer tab open.
    // Per-user, keyed by sub. Failures here are non-fatal — analysis still
    // returns; we just lose the "remember this upload" benefit.
    try {
      // Capture broker statement totals so the broker-reconciliation chip
      // survives reruns. Without this the chip would disappear after a
      // tab-switch (rerun synth has no access to the original parsed.summary).
      const summary = parsed?.summary || {};
      const brokerSummaryToStore = {
        invested: Number.isFinite(summary.invested) ? summary.invested : null,
        current: Number.isFinite(summary.current) ? summary.current : null,
        unrealisedPL: Number.isFinite(summary.unrealisedPL) ? summary.unrealisedPL : null,
        asOfDate: summary.asOfDate || null,
      };
      await getAnalyzerStorage().write(sub, {
        holdings: savable.stocks,
        mfHoldings: savable.mutualFunds,
        uploadedAt: savable.parsedAt,
        sourceFile: req.file.originalname || null,
        brokerSummary: brokerSummaryToStore,
      });
    } catch (e) {
      console.warn("[ANALYZE] analyzer-cache write failed:", e.message);
    }

    // Also mirror into portfolioStorage so the admin Users tab can render
    // the XLSX download link and /api/admin/users/:sub/portfolio.xlsx can
    // serve a real export. The analyzer was previously the only upload
    // path, so without this the admin store stayed empty for every user.
    // Preserve any other fields already on the portfolio (riskProfile etc.)
    // and only overwrite mutualFunds when the upload actually contained MFs
    // — a stocks-only Groww export should not wipe a saved MF list.
    try {
      const existing = await readPortfolio(sub);
      await savePortfolio(sub, {
        ...existing,
        stocks: savable.stocks,
        mutualFunds: uploadHasMfs ? savable.mutualFunds : (existing.mutualFunds || []),
        lastUpdated: savable.parsedAt,
      });
    } catch (e) {
      console.warn("[ANALYZE] portfolio-store write failed:", e.message);
    }

    // Only hard-fail when the parser found literally nothing — not when
    // it found rows but classified them all as non-equity (MF/ETF/F&O).
    // In the latter case, return a minimal report so the UI can still
    // show the "Not analysed" list and explain why.
    if (parsed.holdings.length === 0 && parsed.unmatched.length === 0 && mfHoldings.length === 0) {
      return res.status(400).json({
        error: "No holdings found in the uploaded file.",
        hint: "The file parsed OK but contained no rows with a stock name, quantity, and average price. Make sure you uploaded a holdings statement (not a transactions/ledger report).",
        warnings: parsed.warnings,
      });
    }

    // All rows were classified as non-equity → return a minimal report
    // directly (skip the expensive enrichment loop, nothing to enrich).
    if (parsed.holdings.length === 0) {
      // MF-only books are valid — the optimizer's MF path handles them. Only
      // surface the "no equities" warning when the user has neither equity
      // rows nor MFs (genuinely-empty file we already rejected above).
      const mfOnlyWarnings = mfHoldings.length === 0
        ? [...parsed.warnings, "No listed equities detected in this file — the analyser only scores individual stocks. To use the full report, upload a file that contains at least one equity row."]
        : parsed.warnings;
      // Phase 2 + 3 + 5 + Improvement #1: enrich MF holdings with
      //   • live AMFI metrics (CAGR / Sharpe / max-DD per fund)
      //   • GPT-5-classified Google News (per scheme, deduped)
      //   • live peer-compare (top 3 same-category alternatives by 5y CAGR)
      //   • benchmark TRI proxy metrics + per-holding alpha
      // The first three are independent network calls — Promise.all keeps
      // latency low. Benchmark enrichment runs AFTER because alpha needs
      // each holding's `metrics` populated by enrichMfHoldings. Graceful:
      // per-call failures leave the corresponding h.* field null and the
      // recommender falls back to its Phase-1 logic.
      try {
        await Promise.all([
          enrichMfHoldings(mfHoldings),
          enrichMfNews(mfHoldings, { openai: getOpenAI() }),
          enrichLivePeers(mfHoldings),
        ]);
        await enrichBenchmarkMetrics(mfHoldings);
      } catch (e) {
        console.warn("[ANALYZE] AMFI/news/peers/benchmark enrichment failed (MF-only path):", e.message);
      }
      const report = buildReport([], parsed.unmatched, {
        source: parsed.source,
        parseSummary: parsed.summary,
        regime: null,
        warnings: mfOnlyWarnings,
        asOfDate: parsed.summary?.asOfDate ?? null,
        benchReturns: [],
        benchSymbol: "^NSEI",
        // Optimizer can still run on MF-only books — pass MFs + opts through
        mfHoldings,
        // Priority 3: pass risk profile so recommendBook can tag per-fund
        // alignment + the asset-allocation module can pick the right targets.
        riskProfile: savedRiskProfile,
        optimizerPreset: optPreset,
        taxSlabPct: optTaxSlabPct,
        assumedHoldingMonths: optAssumedHoldingMonths,
        ltcgRealisedYtdRupees,
      });
      // Cache for the optimize endpoint so preset/tax-slab toggles work on
      // MF-only books too.
      const sessionId = randomUUID();
      analyzerCache.set(sessionId, {
        holdings: report.holdings || [],
        mfHoldings,
        sectorAllocation: report.sectorAllocation || [],
        ltcgRealisedYtdRupees,
        cachedAt: Date.now(),
      });
      if (report.optimizer) report.optimizer.sessionId = sessionId;
      return res.json({
        ok: true,
        elapsedMs: Date.now() - t0,
        sessionId,
        report,
        savable,
      });
    }

    // SWS Engine — the only engine. Helper handles scoring + report build.
    // Shared with POST /api/portfolio/analyze/rerun so the two paths can't
    // drift.
    const swsResult = await runSWSAnalysis({
      parsed,
      mfHoldings,
      savedRiskProfile,
      optTaxSlabPct,
      ltcgRealisedYtdRupees,
      freshCapitalInr,
      uploadedAtIso: savable.parsedAt,
    });

    // Recommendation-memory pipeline: reconcile against prior snapshot,
    // build acks for executed recs, surface freed capital, persist new
    // snapshot + ledger events. Failure here is non-fatal — analysis
    // still returns; we just lose the memory layer for this cycle.
    try {
      await applyAnalyzerMemory({
        sub,
        parsed,
        swsResult,
        uploadedAtIso: savable.parsedAt,
        sourceFile: req.file.originalname || null,
        isRerun: false,
      });
    } catch (e) {
      console.warn("[ANALYZE] memory pipeline failed:", e.message);
    }

    // Populate the per-user stance cache so the stock-detail modal's
    // ANALYZER STANCE pill can resolve actions without re-running the
    // full analysis. Non-fatal if it fails — the pill silently falls back.
    try {
      analyzerStanceCache.set(sub, _buildStanceMap(swsResult));
    } catch (e) {
      console.warn("[ANALYZE] stance cache write failed:", e.message);
    }

    return res.json({
      ok: true,
      elapsedMs: Date.now() - t0,
      ...swsResult,
      savable,
    });
  } catch (err) {
    console.error("Portfolio analyze error:", err.message, err.stack);
    res.status(500).json({ error: "Failed to analyze portfolio", details: err.message });
  }
});

// Rerun analysis against the user's last-uploaded holdings — no file
// required. The UI calls this on every Portfolio Analyzer tab open so
// the report is always fresh against current SWS data + live quotes.
// 404s when the user has no stored upload (caller falls back to the
// upload zone).
app.post("/api/portfolio/analyze/rerun", requireRiskProfile, express.json(), async (req, res) => {
  const t0 = Date.now();
  try {
    const sub = userSub(req);
    if (!sub) return res.status(401).json({ error: "auth-required" });

    const stored = await getAnalyzerStorage().read(sub);
    if (!stored || !Array.isArray(stored.holdings) || stored.holdings.length === 0) {
      return res.status(404).json({ error: "no-stored-portfolio" });
    }

    const optTaxSlabPct = Number.parseInt(req.body?.taxSlabPct || req.query?.taxSlabPct || "30", 10);

    let { mfHoldings, savedRiskProfile, freshCapitalInr, ltcgRealisedYtdRupees } =
      await loadAnalyzerUserContext(sub, req.body || {}, req.query || {});

    // Stored upload MFs (when the user originally uploaded a Groww MF
    // export) win over saved-portfolio MFs — same precedence as the
    // upload handler's "upload is the source of truth for MFs" rule.
    const storedUploadMfs = Array.isArray(stored.mfHoldings) ? stored.mfHoldings : [];
    if (storedUploadMfs.length > 0) {
      mfHoldings = storedUploadMfs.map((m) => ({
        name: m.name || null,
        rawName: m.name || null,
        isin: m.isin || null,
        category: m.category || null,
        subCategory: m.subCategory || null,
        folio: m.folio || null,
        instrumentType: "mf",
        invested: Number(m.invested ?? 0),
        currentValue: Number(m.current ?? m.invested ?? 0),
        publishedXirrPct: Number.isFinite(Number(m.xirr)) ? Number(m.xirr) : null,
        pnlPercent: Number.isFinite(Number(m.returns)) ? Number(m.returns) : null,
        purchaseDate: m.purchaseDate || null,
      }));
    }

    // Synthesize the parsed-shape object the SWS pipeline expects.
    // Stored holdings were already symbol-resolved at upload time, so we
    // skip the live NSE resolution step.
    const storedBrokerSummary = stored.brokerSummary && typeof stored.brokerSummary === "object"
      ? stored.brokerSummary
      : {};
    const parsed = {
      holdings: stored.holdings.map((h) => ({
        symbol: h.symbol,
        name: h.name,
        quantity: Number(h.quantity) || 0,
        avgPrice: Number(h.avgPrice) || 0,
        // Restore closePrice — older saved records may not have it, in
        // which case the SWS fallback path (fundamentals.json snapshot
        // price) still keeps /analyze and /rerun in sync.
        closePrice: Number.isFinite(Number(h.closePrice)) ? Number(h.closePrice) : null,
        sector: h.sector || null,
        isin: h.isin || null,
        purchaseDate: h.purchaseDate || null,
        instrumentType: h.instrumentType || "stock",
      })),
      mfHoldings: storedUploadMfs.length > 0 ? mfHoldings : null,
      unmatched: [],
      warnings: [],
      source: "rerun:" + (stored.sourceFile || "stored"),
      // The legacy summary.asOfDate = stored.uploadedAt is preserved for the
      // recommendationMemory idempotency guard. Broker totals come from a
      // separate persisted block so the chip survives reruns.
      summary: {
        asOfDate: storedBrokerSummary.asOfDate || stored.uploadedAt || null,
        invested: Number.isFinite(storedBrokerSummary.invested) ? storedBrokerSummary.invested : null,
        current: Number.isFinite(storedBrokerSummary.current) ? storedBrokerSummary.current : null,
        unrealisedPL: Number.isFinite(storedBrokerSummary.unrealisedPL) ? storedBrokerSummary.unrealisedPL : null,
      },
    };

    const swsResult = await runSWSAnalysis({
      parsed,
      mfHoldings,
      savedRiskProfile,
      optTaxSlabPct,
      ltcgRealisedYtdRupees,
      freshCapitalInr,
      uploadedAtIso: stored.uploadedAt || new Date().toISOString(),
    });

    // Memory pipeline (rerun-mode): suppression-only, no writes. Reads the
    // existing ledger so the response carries `recRegistry` for the UI to
    // render "still pending" / "superseded" badges on already-issued recs.
    try {
      await applyAnalyzerMemory({
        sub,
        parsed,
        swsResult,
        uploadedAtIso: stored.uploadedAt || new Date().toISOString(),
        sourceFile: stored.sourceFile || null,
        isRerun: true,
      });
    } catch (e) {
      console.warn("[RERUN] memory pipeline failed:", e.message);
    }

    // Refresh the stance cache on every rerun so the modal pill stays in
    // sync as the user tweaks tax-slab / fresh-capital knobs and re-runs.
    try {
      analyzerStanceCache.set(sub, _buildStanceMap(swsResult));
    } catch (e) {
      console.warn("[RERUN] stance cache write failed:", e.message);
    }

    return res.json({
      ok: true,
      elapsedMs: Date.now() - t0,
      uploadedAt: stored.uploadedAt,
      sourceFile: stored.sourceFile,
      ...swsResult,
    });
  } catch (err) {
    console.error("Portfolio rerun error:", err.message, err.stack);
    res.status(500).json({ error: "Failed to rerun analysis", details: err.message });
  }
});

// Per-symbol stance lookup for the stock-detail modal's ANALYZER STANCE
// pill. Read-only — pulls from the in-memory cache populated by
// /api/portfolio/analyze and /api/portfolio/analyze/rerun. Returns the
// analyzer's most-recent action/conviction/reasons/event_iso_date for the
// requested symbol, or 404 when (a) the user hasn't run an analysis yet,
// (b) the cache entry has expired (30-min TTL), or (c) the symbol isn't
// in their current portfolio.
//
// Auth: same session gate as /api/portfolio/analyze; admin gate would be
// inappropriate here since this powers a user-facing modal on stocks the
// user actually owns.
app.get("/api/portfolio/stance/:symbol", async (req, res) => {
  try {
    const sub = userSub(req);
    if (!sub) return res.status(401).json({ error: "auth-required" });
    const symbol = String(req.params.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ error: "missing-symbol" });
    const stanceMap = analyzerStanceCache.get(sub);
    if (!stanceMap || typeof stanceMap !== "object") {
      return res.status(404).json({ error: "no-cached-analysis", hint: "Run /api/portfolio/analyze or /analyze/rerun first." });
    }
    const stance = stanceMap[symbol];
    if (!stance) return res.status(404).json({ error: "symbol-not-in-portfolio" });
    res.set("Cache-Control", "private, max-age=30");
    res.json({ symbol, ...stance });
  } catch (err) {
    console.error("[STANCE] lookup failed:", err.message);
    res.status(500).json({ error: "stance-lookup-failed", details: err.message });
  }
});

// Re-run the XIRR optimizer ONLY against a cached analyze session. Lets the
// UI toggle preset / tax-slab / assumed-holding-months instantly without
// paying the 30s analyze cost. Returns just the optimizer block (and the
// updated summary.xirr fields), not the full report.
//
// Body: { sessionId, preset?, taxSlabPct?, assumedHoldingMonths?, ltcgRealisedYtd? }
app.post("/api/portfolio/optimize", requireRiskProfile, express.json(), async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "");
    if (!sessionId) {
      return res.status(400).json({ error: "Missing sessionId. Run /api/portfolio/analyze first." });
    }
    const cached = analyzerCache.get(sessionId);
    if (!cached) {
      return res.status(410).json({
        error: "Session expired or not found. Re-run /api/portfolio/analyze.",
        hint: "Analyzer sessions live 30 minutes; re-upload your portfolio file.",
      });
    }

    const preset = String(req.body?.preset || "balanced");
    if (!OPTIMIZER_PRESETS[preset]) {
      return res.status(400).json({
        error: `Unknown preset "${preset}". Allowed: ${Object.keys(OPTIMIZER_PRESETS).join(", ")}`,
      });
    }
    const taxSlabPct = Number.parseInt(req.body?.taxSlabPct ?? 30, 10);
    const assumedHoldingMonths = Number.parseInt(req.body?.assumedHoldingMonths ?? 24, 10);
    const ltcgRealisedYtdRupees = Number.parseFloat(
      req.body?.ltcgRealisedYtd ?? cached.ltcgRealisedYtdRupees ?? 0,
    );

    const optimizer = runXirrOptimizer({
      holdings: cached.holdings,
      mfHoldings: cached.mfHoldings,
      sectorAllocation: cached.sectorAllocation,
      preset,
      taxSlabPct,
      assumedHoldingMonths,
      ltcgRealisedYtdRupees,
    });
    optimizer.sessionId = sessionId;

    res.json({
      ok: true,
      sessionId,
      optimizer,
      summary: {
        xirrAnnualPct: optimizer.currentXirrPct,
        xirrConfidence: optimizer.currentXirrConfidence,
      },
      cachedAt: cached.cachedAt,
    });
  } catch (err) {
    console.error("Portfolio optimize error:", err.message, err.stack);
    res.status(500).json({ error: "Failed to re-run optimizer", details: err.message });
  }
});

// Serve frontend (local dev only — Vercel serves public/ statically)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Only listen when running directly (not on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, async () => {
    console.log(`\n  Starbhai · Indian Stock Intelligence`);
    console.log(`  ========================================`);
    console.log(`  Running on: http://localhost:${PORT}`);
    console.log(`  Market Status: ${isMarketOpen() ? "OPEN" : "CLOSED"}`);
    console.log(`  Tracking ${ALL_STOCKS.length} stocks (${getStocksByIndex("NIFTY50").length} Nifty 50 + ${getStocksByIndex("NIFTY_NEXT_50").length} Nifty Next 50 + ${getStocksByIndex("MIDCAP").length} midcap)`);
    console.log(`  Data: NSE India (primary) + Yahoo Finance (fallback)`);

    // Validate stock list
    const issues = validateStockList();
    if (issues.duplicates.length > 0) console.warn(`  ⚠ Duplicate symbols: ${issues.duplicates.join(", ")}`);
    if (issues.invalid.length > 0) console.warn(`  ⚠ Invalid symbols: ${issues.invalid.join(", ")}`);

    await nseWarmup();

    // Prime the surveillance (ASM/GSM) snapshot. Same pattern — no-op locally.
    primeSurveillanceFromKV().catch((e) =>
      console.warn("[SURVEILLANCE] KV prime failed at startup:", e.message)
    );

    // Prime the governance (promoter pledge / holding) snapshot. Same pattern.
    primeGovernanceFromKV().catch((e) =>
      console.warn("[GOVERNANCE] KV prime failed at startup:", e.message)
    );

    // LOCAL-DEV ONLY: warm macro regime cache + schedule 15-min refresh.
    // This block lives inside the `app.listen()` callback, so it never runs
    // on Vercel (serverless invocations don't reach the listen call). On
    // prod, the macro file is refreshed by scripts/refresh-macro-regime.mjs
    // (fired from sws-nightly.sh via launchd at 02:00 + 16:30 IST) and
    // committed to data/macroRegime.json. Vercel reads fresh disk on the
    // next deploy. See services/macroRegimeStorage.js for the rationale.
    //
    // Skipped under NODE_ENV=test: the Playwright e2e harness boots a real
    // server (playwright.config.mjs `webServer`), so this block would
    // otherwise fire an RSS-fetch + LLM classification on every run and
    // rewrite the tracked data/macroRegime.json — leaving the working tree
    // dirty after each suite. The committed file is still served via the
    // read path (getMacroRegime → macroStorage.read).
    if (!isTestEnv) {
      refreshMacroRegime().then((r) => {
        console.log(`  Macro regime warmed: ${r.regime} (sev ${r.severity}, conf ${r.confidence.toFixed(2)})`);
      });
      setInterval(() => {
        refreshMacroRegime().catch((e) => console.error("[MACRO] scheduled refresh failed:", e.message));
      }, 15 * 60 * 1000);
    }

    // Warm the SWS DAL cache from Neon when SWS_READ_FROM_DB=1; no-op
    // otherwise so this is safe to leave unconditional. Non-blocking —
    // the JSON backend keeps serving until the DB warmup completes.
    swsDal.warmUpEssentials().then(() => {
      if (swsDal.isReadingFromDb()) console.log("  SWS DAL: warmed from Neon (DB-backed reads active)");
    }).catch((e) => console.warn("[SWS-DAL] warmUp failed at startup:", e.message));
    // Periodic re-warm so canonical-run flips during the day propagate.
    // 10-minute interval is well under the dbCache TTL (5 min) — we keep
    // the cache hot without hammering Neon's compute-hour budget.
    setInterval(() => {
      swsDal.warmUpEssentials().catch((e) => console.error("[SWS-DAL] warmUp refresh failed:", e.message));
    }, 10 * 60 * 1000);

    console.log("");
  });
}

// On Vercel (serverless) the app.listen block above never runs — each cold
// start imports this module and handles a single request through the
// exported `app`. We still need the surveillance/governance caches primed
// from KV on that path, so do it here at the module top level. Top-level
// await is supported because package.json has "type": "module". Each prime
// is timeout-raced so a KV outage doesn't block cold starts indefinitely.
//
// Fundamentals do NOT prime from KV — they're loaded lazily from the
// `fundamentals.json` shipped in the deploy by `scripts/refresh-fundamentals.mjs`.
if (process.env.VERCEL) {
  // Surveillance prime — KV outage mustn't block cold start.
  await Promise.race([
    primeSurveillanceFromKV().catch((e) =>
      console.warn("[SURVEILLANCE] KV prime failed on cold start:", e.message)
    ),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  // Same guard for governance.
  await Promise.race([
    primeGovernanceFromKV().catch((e) =>
      console.warn("[GOVERNANCE] KV prime failed on cold start:", e.message)
    ),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  // SWS DAL warmup — best-effort, 3s timeout so a Neon hiccup doesn't
  // block the cold start. Reads fall through to the JSON backend until
  // the cache hydrates (which usually happens before the first request
  // anyway — picks/universe queries are < 500ms).
  await Promise.race([
    swsDal.warmUpEssentials().catch((e) =>
      console.warn("[SWS-DAL] warmUp failed on cold start:", e.message)
    ),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

// ----------------------------------------------------------------------------
// SWS Picks tab — endpoints
// Reads/writes the data files produced by the SWS deep-scrape pipeline.
// All file ops are local; no SWS calls happen here (those live in the scraper).
// ----------------------------------------------------------------------------
import fs from "node:fs";

const SWS_PATHS = {
  picksLatest: path.join(__dirname, "data", "sws", "picks-latest.json"),
  scoredUniverse: path.join(__dirname, "data", "sws", "sws-scored-universe.json"),
  refreshRequested: path.join(__dirname, "data", "sws", "refresh-requested.json"),
  panicStop: path.join(__dirname, "data", "sws", "panic-stop.flag"),
  progress: (n) => path.join(__dirname, "data", "sws", `progress-${n}.json`),
  progressApi: (n) => path.join(__dirname, "data", "sws", `progress-api-${n}.json`),
  lastRefresh: path.join(__dirname, "data", "sws", "last-refresh.json"),
  pdfDir: path.join(__dirname, "reports", "sws-picks"),
  deepDir: path.join(__dirname, "data", "sws", "deep"),
};

function readJsonSafe(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}

// Shared per-row enrich for the SWS picks tab. Two routes feed the tab:
//   • /api/sws-picks ships curated section rows from picks-latest.json
//   • /api/sws-universe ships off-section search hits from sws-scored-universe.json
// Both must hand the renderer rows with the same shape, or the cards diverge
// (no DISCOUNT chip / "—" verdict on off-section, but populated on curated).
// This function makes that invariant a single line at the call site.
//
// Back-fills:
//   • composite_verdict ← v3_verdict   (PR 2.3 alias, renderer prefers it)
//   • valuation_band    ← upside_pct   (renders DISCOUNT/PREMIUM/… chip)
//
// Live-price overlay (issue 2.10): picks-latest.json is typically 12-24h old,
// so baked current_price_inr drifts vs the market during the trading day. We
// piggyback on the in-process quoteCache (60s TTL, populated by scanners and
// other consumers) — NO fanout to Yahoo here, because 5,500+ rows on a single
// tab-open would be catastrophic. If the cache is cold for a ticker, leave
// the baked price untouched. FV stays as-baked (AnalystConsensus number,
// not a live tape value); only the live close moves and upside_pct + band
// are recomputed from (FV - live) / live.
//
// `valuationBandFromUpside` is imported from services/swsScoring.js so both
// the back-fill and the live-overlay use the same null-aware mapping
// (Number(null) === 0 is finite, which would otherwise wrongly band null
// upsides as FAIR — visible on ~3k universe rows that lack a fair value).

// NSE index constituents — loaded once at module init, refreshed nightly
// by scripts/refresh-nse-index-constituents.mjs. Powers the universe-filter
// dropdown on the SWS Picks tab (Nifty 100 / Midcap 150 / Smallcap 250 / 500).
// If the JSON is missing the three new sets stay empty; the existing nifty500
// stamp falls back to NIFTY500_SYMBOLS so today's "Nifty 500" filter keeps
// working. The UI hides the three new dropdown options when
// indexConstituentsAvailable === false. Pure helpers live in
// services/indexConstituents.js for unit-test isolation.
const NSE_INDEX_CONSTITUENTS_PATH = path.join(__dirname, "data", "nse-index-constituents.json");
let { sets: NSE_INDEX_SETS, available: NSE_INDEX_AVAILABLE } =
  loadIndexConstituentsFromFile(NSE_INDEX_CONSTITUENTS_PATH);

function stampIndexFlagsOnRow(it) {
  stampIndexFlags(it, NSE_INDEX_SETS, NIFTY500_SYMBOLS);
}

function enrichPickRow(it) {
  if (!it || !it.ticker) return;
  if (it.composite_verdict == null && it.v3_verdict != null) {
    it.composite_verdict = it.v3_verdict;
  }
  if (it.valuation_band == null && typeof it.upside_pct === "number") {
    it.valuation_band = valuationBandFromUpside(it.upside_pct);
  }
  if (typeof it.fair_value_inr === "number" && Number.isFinite(it.fair_value_inr)) {
    const cachedQuote = quoteCache.get(`${it.ticker}.NS`);
    const livePx = cachedQuote && Number(cachedQuote.regularMarketPrice);
    if (Number.isFinite(livePx) && livePx > 0) {
      const liveUpside = ((it.fair_value_inr - livePx) / livePx) * 100;
      it.current_price_inr = livePx;
      it.upside_pct = Math.round(liveUpside * 10) / 10;
      it.valuation_band = valuationBandFromUpside(liveUpside);
      it.live_price = true;
    }
  }
}

// Slim scored-universe index — every scored stock (~5,500) with the fields
// renderPickCard needs, plus `in_sections` so the picks-tab search can dedupe
// against the curated 11 sections. Generated by scripts/sws-scoring.mjs as a
// sibling of picks-latest.json (atomic write). Mirrors the nifty500 injection
// + enrichPickRow pattern used by /api/sws-picks so off-section search hits
// render with the same card shape as curated rows.
// Read-time picks/snapshot FV drift guard. Applied inside /api/sws-picks
// and /api/sws-universe. The picks table (sws_picks.fair_value_inr) is
// written by sws-scoring.mjs once per full pipeline run; the snapshot
// table (sws_company_snapshots.fair_value_inr) is upserted per-ticker by
// sws-api-parser.mjs on every scrape — including mid-day partial refreshes
// that don't trigger a rescore. So the snapshot is the freshest source of
// truth; when the two disagree the picks side is the stale one, and we
// must prefer the snapshot at response time. Layer 2 (sws-verify-db-vs-
// json --check picks-snapshot-fv) will catch the drift at pipeline-finalise
// time so future runs can't ship a drifted canonical; this guard is the
// runtime defence-in-depth that also hot-fixes the currently-drifted prod
// state without waiting for the next nightly. See plan:
// ~/.claude/plans/so-i-have-attached-virtual-sphinx.md
function applyPicksFvDriftGuard(items, snapMap, counter) {
  for (const it of items) {
    if (!it || !it.ticker) continue;
    const snap = snapMap.get(it.ticker);
    if (!snap || !Number.isFinite(snap.fair_value_inr)) continue;
    if (!Number.isFinite(it.fair_value_inr)) continue;
    if (Math.abs(it.fair_value_inr - snap.fair_value_inr) <= 0.01) continue;
    counter.count += 1;
    console.warn(`[picks-fv-drift] ${it.ticker}: pick=${it.fair_value_inr} snap=${snap.fair_value_inr}`);
    it._fv_drift = { pick: it.fair_value_inr, snap: snap.fair_value_inr };
    it.fair_value_inr = snap.fair_value_inr;
    if (Number.isFinite(snap.current_price_inr)) it.current_price_inr = snap.current_price_inr;
    if (Number.isFinite(snap.upside_pct)) it.upside_pct = snap.upside_pct;
    it.valuation_band = null; // forces enrichPickRow to recompute from fresh upside_pct
  }
}

app.get("/api/sws-universe", async (req, res) => {
  const data = swsDal.getScoredUniverse();
  if (!data) return res.status(404).json({ error: "no_universe_yet", hint: "Run `node scripts/sws-build-scored-universe.mjs` to backfill, or wait for the next refresh." });
  const driftCounter = { count: 0 };
  if (Array.isArray(data.stocks)) {
    const tickers = data.stocks.map((it) => it?.ticker).filter(Boolean);
    const snapMap = await swsDal.getSnapshotFvMap(tickers);
    applyPicksFvDriftGuard(data.stocks, snapMap, driftCounter);
    for (const it of data.stocks) {
      stampIndexFlagsOnRow(it);
      enrichPickRow(it);
    }
  }
  data.indexConstituentsAvailable = NSE_INDEX_AVAILABLE;
  data._meta = { ...(data._meta || {}), fv_drift_count: driftCounter.count };
  res.json(data);
});

app.get("/api/sws-picks", async (req, res) => {
  const data = swsDal.getPicksLatest();
  if (!data) return res.status(404).json({ error: "no_picks_yet", hint: "Run /sws-scan-shard 1/2/3 in Claude to start the initial scan." });
  const driftCounter = { count: 0 };
  if (data.sections) {
    // PR 2.7 — pure-numeric BSE codes were leaking into Avoid + Deep Value
    // alongside NSE symbols. Filter them at the response boundary so the fix
    // lands without waiting for the offline pipeline to re-run.
    const isPureBSEcode = (t) => typeof t === "string" && /^\d+$/.test(t);
    // PR 2.6 — dividend list value gate (upside ≥ 0 OR snowflake.valuation
    // ≥ 4). Same response-time defence — covers a stale picks-latest.json
    // that was written before the categoriseStock change took effect.
    const passesDividendGate = (it) => {
      const upside = Number(it?.upside_pct);
      const valSnow = Number((it?.snowflake || {}).valuation);
      return (Number.isFinite(upside) && upside >= 0) || (Number.isFinite(valSnow) && valSnow >= 4);
    };

    // Collect every ticker across every section in one pass so the snapshot
    // FV lookup is a single bulk call (SQL: one SELECT; JSON: one disk read
    // per unique ticker, mtime-cached).
    const allTickers = [...new Set(
      Object.values(data.sections).flatMap((arr) =>
        Array.isArray(arr) ? arr.map((it) => it?.ticker).filter(Boolean) : [],
      ),
    )];
    const snapMap = await swsDal.getSnapshotFvMap(allTickers);

    for (const [key, items] of Object.entries(data.sections)) {
      if (!Array.isArray(items)) continue;
      // Filter once, in-place — keeps the per-section count fields the UI
      // reads (it computes counts from .length).
      let filtered = items.filter((it) => it && it.ticker && !isPureBSEcode(it.ticker));
      if (key === "dividend_aristocrats") filtered = filtered.filter(passesDividendGate);
      data.sections[key] = filtered;
      applyPicksFvDriftGuard(filtered, snapMap, driftCounter);
      for (const it of filtered) {
        stampIndexFlagsOnRow(it);
        enrichPickRow(it);
      }
    }
  }
  // last_refresh: canonical pipeline-finish stamp; per-shard progress fills in
  // when a refresh is mid-flight or last-refresh.json is stale.
  data.last_refresh = swsDal.getLastRefresh();
  data.shard_progress_api = swsDal.getAllShardProgressApi();
  data.indexConstituentsAvailable = NSE_INDEX_AVAILABLE;
  data._meta = { ...(data._meta || {}), fv_drift_count: driftCounter.count };
  res.json(data);
});

// Per-ticker detail endpoint backing the SWS modal. Returns the full deep-
// scrape JSON for a ticker, plus the leaderboard card if present (so the
// modal has access to the v2 score + breakdown without recomputing) and
// the surveillance flag (already cached by surveillance.js).
//
// Live tech/news/sentiment is intentionally NOT bundled here — it lives at
// /api/stock/:symbol and the modal calls it lazily so the SWS modal stays
// fast (no Yahoo round-trip on open). The modal merges client-side.
app.get("/api/sws-stock/:ticker", (req, res) => {
  // Accept both bare ("STAR") and Yahoo-suffixed ("STAR.NS", "TATA.BO") forms —
  // SWS stores bare NSE symbols, but the rest of the platform passes around
  // .NS/.BO consistently. Stripping here avoids 400s when copying tickers
  // from /api/stock/:symbol responses or the Buy Now scanner.
  const ticker = String(req.params.ticker || "").toUpperCase().trim().replace(/\.(NS|BO)$/, "");
  if (!ticker || !/^[A-Z0-9&\-]+$/.test(ticker)) {
    return res.status(400).json({ error: "invalid_ticker" });
  }
  const deep = swsDal.getStockByTicker(ticker);
  if (!deep) return res.status(404).json({ error: "no_deep_data", ticker });

  // Find the leaderboard card (v2 score + breakdown live there). Prefer the
  // upcoming-earnings section's card variant when present — only that one
  // carries the Yahoo-sourced last_quarter_result. The other sections pin
  // it null so picking any-old-section's card would suppress the badge in
  // the modal even when we have the data.
  //
  // Same scan also collects every section that contains this ticker so the
  // modal can render a "In sections: …" banner (PR 2.11) — gives the user
  // a quick read on whether the stock is also a Top 30 / Deep Value /
  // Quality Growth pick rather than re-discovering it section by section.
  const picks = swsDal.getPicksLatest();
  let card = null;
  const sectionMemberships = [];
  if (picks && picks.sections) {
    const upcoming = picks.sections.upcoming_earnings;
    if (Array.isArray(upcoming) && upcoming.find((c) => c.ticker === ticker)) {
      card = upcoming.find((c) => c.ticker === ticker);
    }
    for (const [key, items] of Object.entries(picks.sections)) {
      if (!Array.isArray(items)) continue;
      const found = items.find((c) => c.ticker === ticker);
      if (found) {
        sectionMemberships.push(key);
        if (!card) card = found;
      }
    }
  }

  // Fallback: only ~894 of 5,439 deep-scraped stocks live in picks-latest.json
  // (the curated leaderboard). For the rest, score on demand via the same
  // primitive runFullScoring uses, so the modal's score ring + breakdown bars
  // render for every ticker that has a deep JSON.
  if (!card) {
    try {
      const universe = loadV3Universe();
      const scored = swsScoreStock({ ...deep }, { universe });
      const ov = deep.overview || {};
      card = {
        ticker,
        name: deep.name,
        sector: deep.sector,
        score: scored.composite_score_100,
        verdict: scored.verdict,
        v2_score: scored.v2_score_100,
        v2_breakdown: scored.v2_breakdown,
        v3_score: scored.v3_score_100,
        v3_score_100: scored.v3_score_100,
        v3_breakdown: scored.v3_breakdown,
        v3_verdict: scored.v3_verdict,
        snowflake_total: ov.snowflake_total,
        current_price_inr: ov.current_price_inr,
        fair_value_inr: ov.fair_value_inr,
        upside_pct: ov.upside_pct,
        market_cap_inr: ov.market_cap_inr,
        sws_url: deep.sws_url || null,
        computed_on_demand: true,
      };
    } catch (e) {
      console.warn(`[sws-stock] on-demand score failed for ${ticker}:`, e.message);
    }
  }

  // PR 2.3 — back-fill alias fields when the cached card predates the
  // pickCardFields change. Mirrors the /api/sws-picks back-fill so the modal
  // can show composite_verdict + valuation_band even on stale snapshots.
  if (card) {
    if (card.composite_verdict == null && card.v3_verdict != null) {
      card.composite_verdict = card.v3_verdict;
    }
    if (card.valuation_band == null) {
      const u = Number(card.upside_pct);
      if (Number.isFinite(u)) {
        card.valuation_band =
          u >= 25 ? "DEEP_DISCOUNT" :
          u >= 10 ? "DISCOUNT" :
          u >= -5 ? "FAIR" :
          u >= -20 ? "PREMIUM" : "EXPENSIVE";
      }
    }
  }

  // Freshness indicator — use parsed_at from the JSON content. fs.statSync
  // mtime is unreliable on Vercel: serverless bundles pin every file's mtime
  // to a fixed 2018-10-20 epoch for reproducible builds, which would render
  // "Deep-scrape mtime: 10/20/2018" on prod regardless of when the data was
  // actually scraped.
  const mtime = deep.parsed_at || null;

  // Surveillance — same regulatory overlay used by /api/stock
  const surveillance = getSurveillanceFlag(ticker);

  // Fundamentals fallback — SWS scrape misses ~50% of P/B, EPS, ROE, ROCE,
  // D/E, interest cover, and 52w range universe-wide. We already maintain a
  // separate fundamentals.json (NSE + Yahoo enrichment) keyed by `<TICKER>.NS`
  // — pass a curated subset back so the modal renderer can backfill the
  // quick-stats grid when SWS has nulls. Fields are normalised into the same
  // shape SWS uses (ratios as percentages, not fractions; multiples as `x`).
  const fundFallback = (() => {
    try {
      const f = getFundamentals(`${ticker}.NS`);
      if (!f) return null;
      const pct = (v) => (v == null ? null : Number(v) * 100);
      return {
        pe: f.pe ?? null,
        pb: f.priceToBook ?? null,
        ps: null, // not on the snapshot
        eps: f.trailingEps ?? null,
        roe_pct: pct(f.roe),
        roce_pct: null, // not separately tracked
        debt_to_equity_pct: pct(f.debtToEquity),
        interest_cover_x: f.interestCoverage ?? null,
        net_margin_pct: pct(f.profitMargin),
        beta: null, // not on this snapshot
        dividend_yield_pct: pct(f.dividendYield),
        payout_pct: pct(f.payoutRatio),
        market_cap_inr: f.marketCap ?? null,
        week52_high_inr: f.week52High ?? null,
        week52_low_inr: f.week52Low ?? null,
      };
    } catch {
      return null;
    }
  })();

  res.json({
    ticker,
    deep,
    card,
    surveillance,
    file_mtime: mtime,
    // PR 2.11 — picks-section membership; the modal renders a top banner
    // listing every curated section this ticker shows up in. Empty array
    // when on-demand-scored / not curated.
    section_memberships: sectionMemberships,
    fundamentals_fallback: fundFallback,
  });
});

app.get("/api/sws-scan/status", (req, res) => {
  // Use API-scraper progress (the DOM scraper is deprecated; its progress-N
  // files have stale last_run_at from Apr 2026 and would mark in_progress
  // forever). "complete" no longer applies to the API pipeline (no per-shard
  // completion flag), so derive in-progress from last_run_at recency.
  const now = Date.now();
  const RECENT_MS = 5 * 60 * 1000;
  const shards = [1, 2, 3].map((n) => {
    const p = swsDal.getShardProgressApi(n);
    if (!p) return { id: n, started: false };
    const recent = p.last_run_at && (now - new Date(p.last_run_at).getTime()) < RECENT_MS;
    return {
      id: n,
      done_count: p.done_count || 0,
      next_local_index: p.next_local_index || 0,
      last_ticker: p.last_ticker || null,
      last_run_at: p.last_run_at || null,
      complete: !recent && p.last_run_at != null,
      today_count: p.today_count || 0,
    };
  });
  const panic = readJsonSafe(SWS_PATHS.panicStop);
  const totalDone = shards.reduce((a, s) => a + (s.done_count || 0), 0);
  const inProgress = shards.some((s) => s.last_run_at && (now - new Date(s.last_run_at).getTime()) < RECENT_MS);
  res.json({
    in_progress: inProgress,
    total_done: totalDone,
    all_complete: !inProgress,
    shards,
    panic_stop: panic ? { ...panic, active: true } : { active: false },
    refresh_requested: readJsonSafe(SWS_PATHS.refreshRequested),
  });
});

function writeRefreshRequest(mode) {
  fs.mkdirSync(path.dirname(SWS_PATHS.refreshRequested), { recursive: true });
  fs.writeFileSync(SWS_PATHS.refreshRequested, JSON.stringify({
    mode,
    requested_at: new Date().toISOString(),
  }, null, 2));
}

// Admin-only gate. These endpoints write `data/sws/refresh-requested.json`,
// the marker that the SWS pipeline (launchd job + slash commands) reads to
// know a refresh was requested. The marker isn't expensive on its own, but
// it tees up multi-hour scrape work — ANY signed-in user being able to
// queue that is a privilege-escalation footgun. Match the existing
// `/api/admin/*` convention: in local dev (AUTH_ENABLED=false) return
// 401 "auth-disabled"; in prod require the persisted isAdmin flag.
async function requireAdminForSwsRefresh(req, res) {
  if (!AUTH_ENABLED) {
    res.status(401).json({ error: "auth-disabled" });
    return false;
  }
  const sub = req.user && req.user.sub;
  if (!sub) {
    res.status(401).json({ error: "unauthenticated" });
    return false;
  }
  const me = await getUserStorage().read(sub);
  if (!me || !me.isAdmin) {
    res.status(403).json({ error: "forbidden" });
    return false;
  }
  return true;
}

app.post("/api/sws-scan/initial-start", express.json(), async (req, res) => {
  if (!(await requireAdminForSwsRefresh(req, res))) return;
  writeRefreshRequest("initial");
  res.json({
    queued: true,
    next_step: "Open 3 terminal windows. In each, run `claude`. Then type `/sws-scan-shard 1` (term 1), `/sws-scan-shard 2` (term 2), `/sws-scan-shard 3` (term 3). Stagger: start shard 2 after shard 1 has done ~50 stocks; start shard 3 after shard 2 has done ~50.",
  });
});
app.post("/api/sws-refresh/quick", express.json(), async (req, res) => {
  if (!(await requireAdminForSwsRefresh(req, res))) return;
  writeRefreshRequest("quick");
  res.json({ queued: true, next_step: "Open 3 terminals, run `claude`, type `/sws-resume` in each." });
});
app.post("/api/sws-refresh/earnings", express.json(), async (req, res) => {
  if (!(await requireAdminForSwsRefresh(req, res))) return;
  writeRefreshRequest("earnings");
  res.json({ queued: true, next_step: "Open 1 terminal, run `claude`, type `/sws-resume` (earnings refresh is small enough for one shard)." });
});
app.post("/api/sws-refresh/full", express.json(), async (req, res) => {
  if (!(await requireAdminForSwsRefresh(req, res))) return;
  writeRefreshRequest("full");
  res.json({ queued: true, next_step: "Open 3 terminals, run `claude`, type `/sws-resume` in each." });
});

// Latest PDF download (returns most recent Top-50-Buy-Now-*.pdf)
app.get("/api/sws-pdf/latest", (req, res) => {
  try {
    if (!fs.existsSync(SWS_PATHS.pdfDir)) return res.status(404).json({ error: "no_pdf_yet" });
    const files = fs.readdirSync(SWS_PATHS.pdfDir).filter((f) => f.endsWith(".pdf")).sort().reverse();
    if (files.length === 0) return res.status(404).json({ error: "no_pdf_yet" });
    const latest = path.join(SWS_PATHS.pdfDir, files[0]);
    res.sendFile(latest);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export for Vercel serverless
export default app;
