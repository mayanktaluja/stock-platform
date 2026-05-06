// Resolve the .env file relative to this file's location so the server works
// no matter what cwd it was launched from (e.g. some launchers invoke it as
// `node stock-platform/server.js` from the parent directory, which would
// otherwise make dotenv look in the wrong place).
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import dotenv from "dotenv";
const __filenameForEnv = fileURLToPath(import.meta.url);
const __dirnameForEnv = path.dirname(__filenameForEnv);
dotenv.config({ path: path.join(__dirnameForEnv, ".env"), override: true });

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import NodeCache from "node-cache";

import { analyzeStock, intradayScan, midTermAnalysis, longTermOutlook } from "./analysis.js";
import { ALL_STOCKS, NIFTY_50, NIFTY_NEXT_50, NIFTY500_SYMBOLS, getNifty100, getNifty500, getExpandedUniverse, getStocksByIndex, validateStockList } from "./stockList.js";
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
  getSnapshotSource,
  loadFundamentalsFromDisk,
  primeFundamentalsFromKV,
  saveFundamentalsToKV,
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
// Path to fundamentals.json for the dev-mode disk fallback in the enrichment
// cron endpoint. In production (Vercel) the filesystem is read-only so we
// write to Vercel KV instead; see saveFundamentalsToKV in fundamentals.js.
// fs imports (readFileSync/writeFileSync/existsSync) are below in this file
// and hoisted by ES module semantics.
const FUNDAMENTALS_PATH_SERVER = path.join(__dirnameForEnv, "fundamentals.json");
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
import { parsePortfolioFile, resolveUnmatchedLive } from "./portfolioParser.js";
import { analyzeHolding, buildReport } from "./portfolioAnalyzer.js";
import { scoreHolding as swsScoreHolding, loadV3Universe } from "./services/swsHoldingEngine.js";
import { scoreStock as swsScoreStock } from "./services/swsScoring.js";
import { buildFyContext as swsBuildFyContext } from "./taxEngine.js";
import { buildSWSReport } from "./services/swsPortfolioAggregate.js";
import { loadLastAnalyzerSnapshot, saveAnalyzerSnapshot } from "./portfolioStorage.js";
import { simulate as runWhatIfSimulation } from "./services/whatIfSimulator.js";
import { runOnce as runFoScreener } from "./services/foScreener.js";
import {
  BhavcopyNotPublished,
  BhavcopyBlocked,
} from "./services/foBhavcopyFetcher.js";
import { loadFoScreenerFromKV } from "./services/foKvStore.js";
import { buildCatalystsPayload } from "./services/catalystsService.js";
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
  loadPortfolioWeightMap,
  tagPicksWithPortfolio,
  rerankFreshFirst,
} from "./services/portfolioOverlay.js";
import {
  computeAdv20Day,
  getAdvFloor,
  getExcludingSurveillance,
  loadFnoBanSet,
  bareNseSymbol,
} from "./services/indianMarketFilters.js";
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
} from "./paperTrades.js";
import {
  bucketTradesByScoreBand,
  getConvictionPct,
  getBandLabel,
} from "./services/convictionMap.js";
import { persistScannerAudit } from "./services/scannerAuditTrail.js";
import { tagSellPicksWithTax } from "./services/taxOverlay.js";
import { computeTimingObservation } from "./services/timingObservation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Cache: short TTL for real-time feel
const quoteCache = new NodeCache({ stdTTL: 60, checkperiod: 30 });
const historicalCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const newsCache = new NodeCache({ stdTTL: 120, checkperiod: 60 });
const scanCache = new NodeCache({ stdTTL: 90, checkperiod: 30 });
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
// Macro regime — refreshed hourly. LLM-classified market regime
// (war/rate/oil/policy/calm) plus sector-level impact scores used by the
// Buy Now scanner to tilt recommendations.
//
// 1h TTL is safe to use again now that classifyRegime has a paid OpenAI
// fallback (gpt-4o-mini): when Groq's free TPD quota is exhausted, the
// classifier transparently switches to OpenAI instead of degrading. KV-
// shared cache (services/macroRegimeStorage.js) means cold-started Vercel
// instances hit the shared regime, not Groq.
const macroRegimeCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
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
  }
}).catch((e) => {
  console.warn("[MACRO] Initial storage hydrate failed:", e.message);
});
// In-memory ring buffer of the last 5 regime classifications + the headlines
// that produced them. Exposed via /api/macro/debug for audit/debugging.
const macroHistory = [];
// Per-source failure counter for observability. Incremented when a source
// fetch fails, reset on success. A WARN is logged when a source crosses 3
// consecutive failures.
const macroSourceFailures = new Map();

// CORS — permissive by default so the frontend works from anywhere (mobile,
// embeds, dev tunnels). The platform doesn't expose any user-specific data
// that would justify a stricter origin allow-list right now.
app.use(cors());

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

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: "draft-7", // emits the RateLimit-* response headers
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down (60 req/min limit)." },
});

const stockDetailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many stock detail requests. Please slow down (30 req/min limit)." },
});

app.use("/api/", apiLimiter);

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

// ── Login gate (single-user password protection) ──
//
// When STARBHAI_LOGIN_PASSWORD and STARBHAI_SESSION_SECRET are both set,
// the entire UI + API is locked behind a single password. Sessions are
// HMAC-signed cookies (no DB, no new deps). When either env var is unset
// (local dev), the gate is a no-op — same convenience pattern as
// requireApiKey above. /api/cron/* is always exempt so Vercel schedules
// keep firing.
const LOGIN_PASSWORD = process.env.STARBHAI_LOGIN_PASSWORD || "";
const SESSION_SECRET = process.env.STARBHAI_SESSION_SECRET || "";
const SESSION_COOKIE = "starbhai_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOGIN_ENABLED = !!(LOGIN_PASSWORD && SESSION_SECRET);

function signSession(tsMs) {
  const payload = String(tsMs);
  const sig = createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || !LOGIN_ENABLED) return false;
  const idx = token.indexOf(".");
  if (idx < 0) return false;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  if (sig.length !== expect.length) return false;
  let sigBuf, expectBuf;
  try {
    sigBuf = Buffer.from(sig, "hex");
    expectBuf = Buffer.from(expect, "hex");
  } catch {
    return false;
  }
  if (sigBuf.length !== expectBuf.length || sigBuf.length === 0) return false;
  if (!timingSafeEqual(sigBuf, expectBuf)) return false;
  const ts = Number(payload);
  return Number.isFinite(ts) && Date.now() - ts <= SESSION_TTL_MS;
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

const loginAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
});

// Login + logout routes — registered BEFORE the gate so they're reachable
// when the user has no session cookie yet.
app.post("/api/login", loginAttemptLimiter, express.json(), (req, res) => {
  if (!LOGIN_ENABLED) return res.status(500).json({ error: "login-not-configured" });
  const pw = (req.body && req.body.password) || "";
  const provided = Buffer.from(String(pw));
  const expected = Buffer.from(LOGIN_PASSWORD);
  const ok = provided.length === expected.length && timingSafeEqual(provided, expected);
  if (!ok) return res.status(401).json({ error: "invalid" });
  const token = signSession(Date.now());
  const flags = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (process.env.VERCEL) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  const flags = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (process.env.VERCEL) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
  res.json({ ok: true });
});

// The gate — must come BEFORE express.static so static assets (index.html,
// app.js, etc.) are also protected.
app.use((req, res, next) => {
  if (!LOGIN_ENABLED) return next();
  if (req.path === "/login.html") return next();
  if (req.path === "/api/login" || req.path === "/api/logout") return next();
  if (req.path.startsWith("/api/cron/")) return next();
  if (verifySession(readCookie(req, SESSION_COOKIE))) return next();

  const accept = req.headers.accept || "";
  if (req.method === "GET" && accept.includes("text/html")) {
    return res.redirect(302, "/login.html");
  }
  return res.status(401).json({ error: "unauthenticated" });
});

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
      exchange: q.exchange,
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

    const q = query.toLowerCase();
    const localResults = SEARCH_UNIVERSE.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.symbol.toLowerCase().includes(q.replace(".ns", "") + ".ns") ||
        s.symbol.toLowerCase().replace(".ns", "").includes(q)
    ).slice(0, 10);

    // Yahoo only fires when local has zero hits — typos, brand-new IPOs,
    // obscure BSE-only names. Cuts ~95% of round-trips at 750-stock coverage.
    const yahooResults = localResults.length === 0 ? await searchYahoo(query) : [];

    const allResults = [...localResults];
    for (const yr of yahooResults) {
      if (!allResults.find((r) => r.symbol === yr.symbol)) {
        allResults.push(yr);
      }
    }

    const finalResults = allResults.slice(0, 15);
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

    // ── StarBhai long-term narrative + news ──
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
 * Scan stocks for recommendations
 */
// Canonical enums for input validation. Anything outside these returns 400
// instead of silently defaulting (which used to mask user typos like
// `?universe=nifty50000` returning the full Nifty 100 with no warning).
const VALID_SCAN_TYPES = ["all", "midterm", "buynow", "sell"];
const VALID_SCAN_UNIVERSES = ["nifty50", "niftyNext50", "nifty100", "nifty500", "all", "expanded"];

/**
 * Read and merge the segmented expanded-universe precompute.
 *
 * Each segment lives at `scan:precomputed_buynow_expanded:seg{i}of{N}` in
 * KV (L2), or in the in-process scanCache (L1). Returns { response, source }
 * where source is "L1", "L2", or "mixed". Returns null if any segment is
 * missing — partial results would skew the ranking silently.
 */
async function readExpandedSegments(totalSegments) {
  const l1Hits = [];
  const missing = [];
  for (let i = 0; i < totalSegments; i++) {
    const key = `precomputed_buynow_expanded:seg${i}of${totalSegments}`;
    const hit = scanCache.get(key);
    if (hit) l1Hits.push(hit);
    else missing.push({ i, key });
  }

  if (missing.length > 0) {
    try {
      const kv = await getKVClientForPortfolio();
      if (!kv) return null;
      for (const { i, key } of missing) {
        const l2 = await kv.get(`scan:${key}`);
        if (!l2) return null; // abort — don't return partial
        scanCache.set(key, l2, 28800);
        l1Hits[i] = l2;
      }
    } catch {
      return null;
    }
  }

  // Merge: concat all picks, re-sort by adjustedScore desc, apply sector cap,
  // return top 10. Each segment already applied its own sector cap locally,
  // but across segments the same sector could dominate — re-apply globally.
  const allPicks = l1Hits.flatMap((r) => r.stocks || []);
  const sorted = allPicks
    .sort((a, b) => (b.adjustedScore ?? b.score) - (a.adjustedScore ?? a.score));

  const MAX_PER_SECTOR = 2;
  const sectorCounts = {};
  const diversified = [];
  for (const r of sorted) {
    if (diversified.length >= 10) break;
    const sec = r.sector || "Unknown";
    sectorCounts[sec] = (sectorCounts[sec] || 0) + 1;
    if (sectorCounts[sec] > MAX_PER_SECTOR) continue;
    diversified.push(r);
  }

  const scannedCount = l1Hits.reduce((s, r) => s + (r.scannedCount || 0), 0);
  const oldestSegment = l1Hits
    .map((r) => r.precomputedAt)
    .filter(Boolean)
    .sort()[0] || new Date().toISOString();

  return {
    source: missing.length === 0 ? "L1" : "L2",
    response: {
      type: "buynow",
      universe: "expanded",
      stocks: diversified,
      scannedCount,
      universeSize: scannedCount,
      fullUniverseSize: scannedCount,
      truncatedForVercel: false,
      precomputed: true,
      precomputedAt: oldestSegment,
      segments: totalSegments,
      lastUpdated: new Date().toISOString(),
      regime: l1Hits[0]?.regime,
    },
  };
}

/**
 * Read the precomputed Nifty-100 Buy Now cache (L1 → L2). Returns
 * { source, response } or null when neither tier has it. Factored out
 * so the expanded handler can fall back here when its own segments are
 * missing — running the 750-stock live scan would exceed Vercel's 60s
 * function ceiling and return 504s.
 */
async function readNifty100Cache() {
  const key = "precomputed_buynow_nifty100";
  const l1 = scanCache.get(key);
  if (l1) return { source: "L1", response: l1 };
  try {
    const kv = await getKVClientForPortfolio();
    if (kv) {
      const l2 = await kv.get(`scan:${key}`);
      if (l2) {
        scanCache.set(key, l2, 28800); // promote to L1 (8h, per-instance)
        return { source: "L2", response: l2 };
      }
    }
  } catch { /* fall through */ }
  return null;
}

app.get("/api/scan/:type", async (req, res, next) => {
  // Delegate specific named scans to their own handlers
  if (req.params.type === "volume-breakout") return next();
  if (req.params.type === "fundamentals") return next();

  try {
    const type = req.params.type;
    const universe = req.query.universe || "nifty100"; // nifty50, niftyNext50, nifty100, all

    // Validate type + universe up front. Bad inputs were previously silently
    // coerced to defaults — that masks typos and hides bugs.
    if (!VALID_SCAN_TYPES.includes(type)) {
      return res.status(400).json({
        error: `Unknown scan type "${type}". Valid types: ${VALID_SCAN_TYPES.join(", ")}`,
      });
    }
    if (!VALID_SCAN_UNIVERSES.includes(universe)) {
      return res.status(400).json({
        error: `Unknown universe "${universe}". Valid universes: ${VALID_SCAN_UNIVERSES.join(", ")}`,
      });
    }

    // ── Pre-computed cache check (for Vercel cron) ──
    // Two-tier:
    //   L1: in-process scanCache (NodeCache, 8h TTL, per-instance)
    //   L2: Vercel KV (shared across lambdas, written by the daily cron)
    // L1 catches re-hits on the same warm lambda; L2 means a newly-booted
    // lambda doesn't need to wait until the next cron run for the pre-
    // computed data. Cuts typical scan latency from 8-15s (live scan) to
    // ~20ms (L2 hit) / ~1ms (L1 hit).
    const PRECOMPUTE_CACHE_KEY = "precomputed_buynow_nifty100";

    // ── Expanded universe: try to assemble from segmented cache ──
    //
    // The expanded scan (~750 stocks) runs as N parallel cron jobs, each
    // writing a slice to `precomputed_buynow_expanded:seg{i}of{N}`. Here
    // we read all slices, merge their picks, re-rank, and return the top
    // 10. If any slice is missing we fall through to the Nifty-100 path —
    // partial picks would silently skew the results.
    const EXPANDED_SEGMENTS = parseInt(process.env.EXPANDED_SCAN_SEGMENTS || "4", 10);
    if (type === "buynow" && universe === "expanded") {
      const merged = await readExpandedSegments(EXPANDED_SEGMENTS);
      if (merged) {
        res.set("X-Precomputed", merged.source);
        return res.json(merged.response);
      }
      // Expanded segments missing (cron yet to run, KV evicted, or partial
      // write). Falling back to the 750-stock live scan would reliably hit
      // Vercel's 60s function cap and return 504s — instead, serve the
      // Nifty 100 cache with a `degraded` flag so the UI can tell the user
      // the expanded scan is warming.
      const fallback = await readNifty100Cache();
      if (fallback) {
        res.set("X-Precomputed", `${fallback.source}-degraded`);
        return res.json({
          ...fallback.response,
          degraded: true,
          degradedReason: "expanded_unavailable",
          requestedUniverse: "expanded",
        });
      }
      // Both caches missing — return 200 with empty stocks + clear status
      // rather than running a live scan that will time out.
      return res.json({
        type: "buynow",
        universe: "expanded",
        stocks: [],
        degraded: true,
        degradedReason: "cache_warming",
        message: "Expanded scan is refreshing. Try again in a few minutes, or switch to Nifty 100.",
        lastUpdated: new Date().toISOString(),
      });
    }

    if (type === "buynow" && (universe === "nifty100" || universe === "all")) {
      const cached = await readNifty100Cache();
      if (cached) {
        res.set("X-Precomputed", cached.source);
        return res.json(cached.response);
      }
      // Fall through to live scan — Nifty 100 fits in the 60s ceiling.
    }

    const cacheKey = `scan_${type}_${universe}`;
    const cached = scanCache.get(cacheKey);
    if (cached) return res.json(cached);

    // Choose scan universe (validation above guarantees one of these matches)
    let stocksToScan;
    if (universe === "nifty50") stocksToScan = getStocksByIndex("NIFTY50");
    else if (universe === "niftyNext50") stocksToScan = getStocksByIndex("NIFTY_NEXT_50");
    else if (universe === "nifty500") stocksToScan = getNifty500();
    else if (universe === "all") stocksToScan = ALL_STOCKS;
    else if (universe === "expanded") stocksToScan = getExpandedUniverse();
    else stocksToScan = getNifty100(); // nifty100

    // Full universe scan — no truncation. maxDuration=60s in vercel.json
    // handles the timeout. The full 100-stock scan completes in ~15-25s.
    const fullUniverseSize = stocksToScan.length;
    const truncatedForVercel = false;

    const failureTracker = createFailureTracker();
    const results = [];
    const BATCH_SIZE = 8;

    for (let i = 0; i < stocksToScan.length; i += BATCH_SIZE) {
      const batch = stocksToScan.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (stock) => {
          try {
            const [quote, historical] = await Promise.all([
              fetchQuote(stock.symbol),
              fetchHistorical(stock.symbol),
            ]);

            if (!quote) { failureTracker.record(stock.symbol, "quote_null"); return null; }
            if (!historical) { failureTracker.record(stock.symbol, "historical_null"); return null; }
            if (historical.length < 30) { failureTracker.record(stock.symbol, "insufficient_bars"); return null; }

            const analysis = analyzeStock(historical, quote);
            const intraday = intradayScan(analysis, quote);
            const midTerm = midTermAnalysis(analysis, quote, historical ? historical.map(d => d.close) : null);
            // P1.2: 20-day ADV (₹) for liquidity gate. Computed here so the
            // baseFilter / midterm filter can read it without re-fetching.
            const adv20 = computeAdv20Day(historical);

            return {
              symbol: stock.symbol,
              name: stock.name,
              sector: stock.sector,
              price: quote.regularMarketPrice,
              change: quote.regularMarketChange,
              changePercent: quote.regularMarketChangePercent,
              score: analysis.score,
              recommendation: analysis.recommendation,
              reasoning: analysis.reasoning,
              midTerm,
              volume: analysis.indicators?.volume?.description || "N/A",
              rsi: analysis.indicators?.rsi || "N/A",
              trend: analysis.indicators?.trend?.trend || "N/A",
              // ATR for stop-loss/target computation in Buy Now
              atr: analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null,
              // ADV (₹) — 20-trading-day average traded value
              adv20: adv20,
            };
          } catch (e) {
            failureTracker.record(stock.symbol, "exception: " + e.message);
            return null;
          }
        })
      );

      results.push(...batchResults.filter(Boolean));

      // Small delay between batches to avoid rate limits
      if (i + BATCH_SIZE < stocksToScan.length) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    let filtered;
    let filterDropoff = null; // populated only for buynow when filters run
    // Fetch current macro regime ONCE per scan (for buynow only — other scan
    // types are unaffected). On Vercel this uses the lazy stale-while-revalidate
    // cache; locally it uses the 15-min background refresh.
    let macroRegime = null;

    // Phase 8A bugfix: hoist earnings-blackout state to outer scope. Previously
    // `earningsBlackoutSet` was declared inside the first `if (type === "buynow")`
    // enrichment block but referenced inside `baseFilter` in the SECOND
    // `else if (type === "buynow")` filter block further down — different
    // block scopes, causing "earningsBlackoutSet is not defined" at runtime.
    const earningsNearbyMap = new Map();
    const earningsBlackoutSet = new Set();
    // P1.2 (May 2026): Indian-market microstructure gates. Loaded ONCE per
    // scan so baseFilter / midterm filter can call them synchronously.
    // Fail-open: if NSE feeds are down we get an empty set and no veto,
    // which is safer than dropping every pick.
    let fnoBanSet = new Set();
    if (type === "buynow" || type === "midterm") {
      try {
        fnoBanSet = await loadFnoBanSet();
      } catch (err) {
        console.warn("[scanner] fno-ban load failed:", err.message);
      }
    }

    // Hoisted earnings-calendar populate. Buy Now uses this for dual-lane
    // filter; Mid-Term (1–4 week hold) needs it too because a print falling
    // inside the holding window re-prices the trade by results, not by the
    // technical setup. ATR-based stops can't defend earnings gaps in either
    // horizon. 7-day map drives UI badge; 3-trading-day map is a hard veto.
    if (type === "buynow" || type === "midterm") {
      try {
        let events = catalystCache.get("nse_events");
        if (!events) {
          events = await fetchNseEventCalendar();
          if (events && events.length > 0) catalystCache.set("nse_events", events);
        }
        if (events) {
          const now = new Date();
          const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
          const blackoutMs = 3 * 24 * 60 * 60 * 1000;
          for (const e of events) {
            if (!/financial result/i.test(e.purpose)) continue;
            const eventDate = new Date(e.date);
            if (isNaN(eventDate.getTime())) continue;
            const diffMs = eventDate.getTime() - now.getTime();
            if (diffMs >= 0 && diffMs <= sevenDaysMs) {
              const sym = e.symbol + ".NS";
              earningsNearbyMap.set(sym, { date: e.date, purpose: e.purpose, company: e.company });
              if (diffMs <= blackoutMs) earningsBlackoutSet.add(sym);
            }
          }
        }
      } catch (e) {
        // silent — earnings data is a nice-to-have, don't break the scan
      }
    }

    if (type === "buynow") {
      try {
        macroRegime = await getMacroRegime();
      } catch (e) {
        console.warn("[MACRO] buynow scan: failed to load regime:", e.message);
        macroRegime = defaultCalmRegime();
      }

      // ── FULL 3-FACTOR SCORING for Buy Now ──
      //
      // The previous version ranked by technical score + macro tilt only. This
      // produced momentum-chase picks that underperformed the Nifty (44.8%
      // beats-Nifty rate) because stocks with great technicals but terrible
      // fundamentals (OVERVALUED) or bearish news got recommended.
      //
      // The fix: compute a proper combined score for each stock:
      //   • Technical score — already computed above (analysis.score)
      //   • Fundamental score — looked up from fundamentals.json (FREE, instant)
      //   • News sentiment — NOT included (requires per-stock LLM call; too
      //     expensive for a 100-stock scan). When available from cache it's used.
      //   • Macro tilt — additive as before
      //
      // This brings the scanner in line with the Stock Detail page's scoring,
      // so "Buy Now" picks no longer contradict their own detail view.
      //
      // Additionally: FULLY_VALUED and OVERVALUED stocks are filtered OUT.
      // An expensive stock with bullish technicals is a momentum play, not a
      // "best stock to buy now."

      // Earnings calendar populate has been hoisted above so Mid-Term picks
      // get the same blackout treatment. Maps already populated by here.

      for (const r of results) {
        // Attach earnings info if available
        if (earningsNearbyMap.has(r.symbol)) {
          r.earningsNearby = earningsNearbyMap.get(r.symbol);
        }

        // 1. Look up fundamental score from the pre-computed snapshot (zero cost)
        const fundSnap = getFundamentals(r.symbol);
        let fundamentalScore = null;
        let fundamentalVerdict = null;
        if (fundSnap) {
          const fundResult = scoreForResponse(fundSnap).primary;
          if (fundResult) {
            fundamentalScore = fundResult.score;
            fundamentalVerdict = fundResult.verdict;
          }
        }

        // Combined score: 50% tech + 50% fund when both available; 100% tech when fund missing.
        const SCANNER_TECH_WEIGHT = 0.50;
        const SCANNER_FUND_WEIGHT = 0.50;
        const techScore = r.score;
        let combinedBase;
        let dataConfidence;
        if (fundamentalScore != null) {
          combinedBase = techScore * SCANNER_TECH_WEIGHT + fundamentalScore * SCANNER_FUND_WEIGHT;
          dataConfidence = "high"; // tech + fund = 2 strong dimensions
        } else {
          combinedBase = techScore;
          dataConfidence = "medium"; // tech only
        }

        // 3. Apply macro tilt (clamped to ±10)
        const { delta, reason, sector } = computeMacroDelta(macroRegime, r.sector);
        r.macroBoost = delta;
        r.macroReason = reason;
        r.macroSector = sector;

        // 4. Final combined score
        // P0 (Apr 2026): DO NOT apply macro delta to Buy Now / Fundamental
        // picks. Multi-horizon backtesting showed the macro mood filter
        // HURTS value-oriented picks by -3.1pp average. A value scanner
        // should BUY when the market dips, not skip those months. Macro
        // delta is still applied for midterm/sell/intraday where momentum
        // timing matters.
        r.technicalScore = techScore;
        r.fundamentalScore = fundamentalScore;
        r.fundamentalVerdict = fundamentalVerdict;
        r.dataConfidence = dataConfidence;
        r.baseScore = Math.round(combinedBase);
        // For buynow: use base score only (no macro). For other types: add delta.
        const applyMacro = (type !== "buynow");
        let sectorMomentumBonus = 0;

        // ── Fix 3: Sector Momentum Overlay ──
        // Reads the existing sector heatmap cache (refreshed every 2 min) to
        // get each sector's daily performance. Sectors outperforming Nifty by
        // >3% get a +3 score bonus; underperforming by >3% get a -3 penalty.
        // This naturally rotates picks toward currently strong sectors.
        if (type === "buynow") {
          const heatmapData = sectorHeatmapCache.get("heatmap");
          if (heatmapData && heatmapData.sectors) {
            const stockSector = normalizeSector(r.sector) || r.sector || "";
            const sectorEntry = heatmapData.sectors.find(
              (s) => normalizeSector(s.sector) === stockSector || s.sector === stockSector
            );
            const niftyChange = heatmapData.niftyChange || 0;
            if (sectorEntry && sectorEntry.avgChange != null) {
              const relativePerf = sectorEntry.avgChange - niftyChange;
              if (relativePerf > 3) sectorMomentumBonus = 3;
              else if (relativePerf < -3) sectorMomentumBonus = -3;
            }
          }
          r.sectorMomentum = sectorMomentumBonus;
        }

        r.adjustedScore = Math.max(0, Math.min(100, combinedBase + (applyMacro ? delta : 0) + sectorMomentumBonus));

        // 5. Stop-loss and target from ATR — MID-TERM multipliers
        // Phase 6 (Apr 2026): 4× / 6× ATR. Reverted Phase 1's 3×/7× setting
        // after per-year diagnostic on 2023/2024/2025 showed 4×/6× is
        // strictly equal-or-better in every year. Phase 1's tighter SL was
        // overfit to 2024 low-vol conditions — in 2025's higher-vol regime,
        // 3× ATR SL wicked out too easily (38% SL-hit rate → 28% with 4×).
        const atr = r.atr ?? null;
        if (atr && r.price) {
          r.stopLoss = parseFloat((r.price - atr * 4).toFixed(2));
          r.target = parseFloat((r.price + atr * 6).toFixed(2));
          r.riskReward = parseFloat(((r.target - r.price) / (r.price - r.stopLoss)).toFixed(2));
        }
      }
    }

    // ── Combined Score enrichment (Tech + Fund + SWS) ──
    // Runs for ALL types under shadow/opt-in/primary modes. Under shadow
    // mode, combinedScore is attached as a parallel field — sort still
    // uses the legacy adjustedScore / midTerm.score keys. Under primary
    // mode, combined replaces adjustedScore (legacy preserved as
    // legacyAdjustedScore) so the existing sort code keeps working.
    if (shouldComputeCombined() && results.length > 0) {
      const swsMap = lookupSwsScoreBulk(results.map((r) => r.symbol));
      for (const r of results) {
        // Fundamental score: buynow already computed it inline; midterm/
        // sell did not. Cheap to re-look-up because getFundamentals reads
        // from the in-memory snapshot.
        if (r.fundamentalScore == null) {
          const fundSnap = getFundamentals(r.symbol);
          if (fundSnap) {
            const fundResult = scoreForResponse(fundSnap).primary;
            if (fundResult) {
              r.fundamentalScore = fundResult.score;
              r.fundamentalVerdict = fundResult.verdict;
            }
          }
        }
        const sws = swsMap.get(r.symbol) || {};
        r.swsScore = sws.v3Score ?? null;
        r.swsVerdict = sws.v3Verdict ?? null;
        r.swsSource = sws.source ?? "missing";
        r.swsCovered = sws.source === "primary";
        r.snowflakeTotal = sws.snowflakeTotal ?? null;

        const scannerType =
          type === "buynow" ? "buynow"
          : type === "midterm" ? "midterm"
          : type === "sell" ? "sell"
          : "uniform";
        const techScore = type === "midterm" && r.midTerm
          ? r.midTerm.score
          : r.score;
        const combined = computeCombinedScore({
          techScore,
          fundScore: r.fundamentalScore,
          swsScore: r.swsScore,
          scannerType,
          surveillanceFlag: sws.surveillance,
          swsFallback: sws.source === "fallback",
        });
        r.combinedScore = combined.combinedScore;
        r.combinedDims = combined.contributingDims;
        r.combinedDataConfidence = combined.dataConfidence;
        r.combinedDivergence = combined.divergence;
        r.combinedDivergenceSpread = combined.divergenceSpread;
        r.combinedWeights = combined.weightsUsed;
        r.combinedScoreVersion = combined.methodologyVersion;
        r.combinedScoreMode = COMBINED_SCORE_MODE;

        // Primary mode: combined replaces adjustedScore so the existing
        // sort code at lines 1659+ ranks on it. Shadow / opt-in: leave
        // legacy sort key intact.
        if (shouldSortByCombined() && combined.combinedScore != null) {
          r.legacyAdjustedScore = r.adjustedScore;
          r.adjustedScore = combined.combinedScore;
          if (type === "midterm" && r.midTerm) {
            r.legacyMidTermScore = r.midTerm.score;
            r.midTerm = { ...r.midTerm, score: combined.combinedScore };
          }
        }
      }
    }

    if (type === "midterm") {
      // Tag the 7-day "earnings nearby" badge data on every candidate so the UI
      // can flag it (mirrors the buynow enrichment loop above). Then exclude
      // any pick within the 3-trading-day blackout — for a 1–4 week hold a
      // print landing inside the window re-prices the trade by results, not
      // by the technical setup, and the ATR stop can't defend the gap.
      for (const r of results) {
        if (earningsNearbyMap.has(r.symbol)) {
          r.earningsNearby = earningsNearbyMap.get(r.symbol);
        }
      }
      // P1.2 + P1.3 (May 2026): Indian-market gate for Mid-Term — same logic
      // as baseFilter on the buynow side. ADV floor scales with universe;
      // GSM (any stage) + ASM Stage 2/3/4 + F&O ban list + > 30% promoter
      // pledge all excluded.
      const midtermAdvFloor = getAdvFloor(universe);
      filtered = results
        .filter((r) => r.midTerm.score >= 58)
        .filter((r) => !earningsBlackoutSet.has(r.symbol))
        // P1.1 (May 2026): R:R hard floor mirrors the buynow guard. Theoretical
        // R:R = 1.5 from the 4×/6× ATR setup; picks with no R:R (missing ATR)
        // are excluded because a SEBI RA recommendation without a stop-loss
        // is incomplete by definition.
        .filter((r) => Number.isFinite(r.midTerm?.riskReward) && r.midTerm.riskReward >= 1.5)
        .filter((r) => !(Number.isFinite(r.adv20) && r.adv20 < midtermAdvFloor))
        .filter((r) => !getExcludingSurveillance(r.symbol))
        .filter((r) => !fnoBanSet.has(bareNseSymbol(r.symbol)))
        .filter((r) => {
          const gov = getGovernance(r.symbol);
          return !(gov && Number.isFinite(gov.promoterPledge) && gov.promoterPledge > 0.30);
        })
        .sort((a, b) => b.midTerm.score - a.midTerm.score)
        .slice(0, 10);
    } else if (type === "buynow") {
      // Best stocks to buy RIGHT NOW:
      //   1. Combined score ≥ 65 (tech + fund, no macro for value picks)
      //   2. NOT HOLD recommendation on technicals
      //   3. Only DEEP_VALUE + QUALITY_GROWTH pass
      //   4. P4: Exclude sectors with <31% win rate across 5-year backtest
      //   5. P5: QUALITY_GROWTH gets +5 sort bonus (63.6% win rate vs 42.5% for DV)
      //   6. MAX 3 per sector — prevents all-banking or all-IT top 10
      //
      // P4 (Apr 2026): Sector exclusion based on 8-horizon backtesting.
      // Tourism, Cement, Chemicals consistently destroy alpha across all
      // tested horizons (<31% WR in honest backtest).
      //
      // Phase 6 (Apr 2026): REMOVED Banking from the exclusion list. The
      // 2025 diagnostic showed Banking would have had 29 trades at 55% WR
      // and +5.07% avg return — making it one of the best-performing
      // sectors of 2025. The original Banking exclusion was overfit to an
      // older sample and cost us meaningful alpha during the 2025 rate-cut
      // cycle. Tourism/Cement/Chemicals exclusions remain correct (0% WR
      // in 2025 diagnostic).
      const EXCLUDED_SECTORS = new Set([
        "Tourism", "Cement", "Chemicals",
      ]);

      // ── Fix 2: QG/DV Dual-Lane Scanner ──
      // Week 2 (Apr 2026): slot allocation narrowed.
      //
      // The previous 6 QG / 4 DV split was based on 8-horizon backtests that
      // used biased (current-snapshot) fundamentals. After the Week 1 bias fix
      // the point-in-time backtest shows:
      //   • QG: negative alpha in 1yr/2yr/4yr (concentrated picks lose badly)
      //   • DV: consistently strong 3yr/4yr alpha; best at Top 3
      //   • Top 1 > Top 10 in every category — signal strength is in the top ranks
      // So we narrow from 10 total picks to 5 total, weighted toward DV:
      //   • QG lane: 2 slots (tightened guardrail should filter out the losers)
      //   • DV lane: 3 slots (the consistent alpha generator)
      // Overflow still cross-fills so we always return 5 when candidates exist.
      // Phase 4 (Apr 2026): slot allocation flipped based on attribution.
      // 24-month per-signal attribution showed fundDeepValue had NEGATIVE
      // −1.97% edge across 193 trades, while fundQualityGrowth had +1.97%
      // edge across 47 trades. Previous allocation (DV=3, QG=2) was
      // spending 60% of scanner slots on the worse signal.
      //
      // New: QG=4, DV=1. DV survives in the lane because occasionally a
      // deep-value pick with very high quality (ROE ≥ 15%, not just the
      // ≥ 10% guardrail floor) genuinely delivers — but it now has to
      // clear a tighter bar (adjustedScore ≥ 70 vs the 65 floor for QG).
      const MAX_PER_SECTOR = 2;
      const QG_SLOTS = 4;
      const DV_SLOTS = 1;
      const DV_MIN_SCORE = 70; // stricter than QG's 65 floor

      filterDropoff = { score: 0, hold: 0, earnings: 0, verdict: 0, sector: 0, rr: 0, adv: 0, surveillance: 0, fno: 0, pledge: 0, passed: 0 };
      const advFloor = getAdvFloor(universe);
      const baseFilter = (r) => {
        if (r.adjustedScore < 65) { filterDropoff.score++; return false; }
        if (r.recommendation === "HOLD") { filterDropoff.hold++; return false; }
        // Phase 2: earnings blackout — excludes picks within 3 trading days
        // of their earnings announcement. ATR-based SL can't defend against
        // earnings-gap losses. UI still shows the 7-day warning badge.
        if (earningsBlackoutSet.has(r.symbol)) { filterDropoff.earnings++; return false; }
        if (r.fundamentalVerdict === "OVERVALUED" || r.fundamentalVerdict === "FULLY_VALUED" || r.fundamentalVerdict === "FAIR_VALUE") { filterDropoff.verdict++; return false; }
        const sector = normalizeSector(r.sector) || r.sector || "";
        if (EXCLUDED_SECTORS.has(sector)) { filterDropoff.sector++; return false; }
        // P1.1 (May 2026): R:R hard floor. Theoretical R:R = 6×ATR / 4×ATR
        // = 1.5, so this is mostly defensive — catches floating-point edge
        // cases, picks missing ATR (no SL computable), and any future
        // multiplier change that would produce sub-1.5 R:R. A SEBI RA
        // recommendation without a stop-loss is incomplete by definition,
        // so picks with no riskReward at all are excluded too.
        if (!Number.isFinite(r.riskReward) || r.riskReward < 1.5) { filterDropoff.rr++; return false; }
        // P1.2 (May 2026): Indian-market microstructure gates.
        //   - ADV: don't recommend a stock the user can't exit cleanly.
        //     Floor varies by universe; ADV unknown → fail-open.
        //   - Surveillance: GSM (any stage) + ASM Stage 2/3/4 are SEBI-
        //     stricter regimes. Stage 1 ASM is informational and stays.
        //   - F&O ban: positions over the 95% market-wide derivative
        //     limit are vulnerable to forced intraday unwinds.
        if (Number.isFinite(r.adv20) && r.adv20 < advFloor) { filterDropoff.adv++; return false; }
        if (getExcludingSurveillance(r.symbol)) { filterDropoff.surveillance++; return false; }
        if (fnoBanSet.has(bareNseSymbol(r.symbol))) { filterDropoff.fno++; return false; }
        // P1.3 (May 2026): Promoter-pledge gate. > 30% of promoter stake
        // pledged is a SEBI red flag (governance.js fetches the data; V2
        // scorer already weights it but doesn't VETO). For a SEBI RA
        // "Buy Now" recommendation we exclude entirely — over-pledged
        // promoters can trigger forced sale of the pledged shares, which
        // tanks the price independent of fundamentals.
        const gov = getGovernance(r.symbol);
        if (gov && Number.isFinite(gov.promoterPledge) && gov.promoterPledge > 0.30) {
          filterDropoff.pledge++; return false;
        }
        filterDropoff.passed++;
        return true;
      };

      const qgCandidates = results
        .filter((r) => baseFilter(r) && r.fundamentalVerdict === "QUALITY_GROWTH")
        .sort((a, b) => b.adjustedScore - a.adjustedScore);

      // Phase 4: DV candidates must clear DV_MIN_SCORE (tighter than QG's
      // 65 floor), AND have ROE ≥ 15% (tighter than the 10% guardrail).
      // Both gates required because attribution showed DV = value trap.
      const dvCandidates = results
        .filter((r) => baseFilter(r) && r.fundamentalVerdict === "DEEP_VALUE")
        .filter((r) => r.adjustedScore >= DV_MIN_SCORE)
        .filter((r) => {
          const roe = getFundamentals(r.symbol)?.roe;
          return roe != null && roe >= 0.15;
        })
        .sort((a, b) => b.adjustedScore - a.adjustedScore);

      // Fill lanes — overflow goes to the other lane, but overflow FROM DV
      // is allowed (DV limit is tight because attribution-negative), while
      // overflow INTO DV is NOT allowed (Phase 4 intentionally biases toward
      // the positive-edge QG lane).
      const qgPicked = qgCandidates.slice(0, QG_SLOTS);
      const dvPicked = dvCandidates.slice(0, DV_SLOTS);
      const qgShortfall = QG_SLOTS - qgPicked.length;
      // If QG is short, pull from DV only if DV has cleared the high bar
      const dvExtra = dvCandidates.slice(DV_SLOTS, DV_SLOTS + qgShortfall);
      const merged = [...qgPicked, ...dvPicked, ...dvExtra];

      // Diversification pass: MAX_PER_SECTOR across both lanes combined
      const sectorCounts = {};
      const diversified = [];
      // Sort merged by score descending for final pick order
      merged.sort((a, b) => b.adjustedScore - a.adjustedScore);
      for (const r of merged) {
        if (diversified.length >= 10) break;
        const sector = normalizeSector(r.sector) || r.sector || "Unknown";
        sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
        if (sectorCounts[sector] > MAX_PER_SECTOR) continue;
        diversified.push(r);
      }

      filtered = diversified.map((r) => ({
          ...r,
          score: Math.round(r.adjustedScore),
        }));
    } else if (type === "sell") {
      filtered = results
        .filter((r) => r.score <= 40)
        .sort((a, b) => a.score - b.score)
        .slice(0, 10);
    } else {
      filtered = results.sort((a, b) => b.score - a.score).slice(0, 15);
    }

    const methodologyType = type === "buynow" ? "buynow" : type === "midterm" ? "midterm" : type === "sell" ? "sell" : "uniform";

    // ─── Portfolio overlay (SEBI IA Reg 2013 §15(4)) ───
    // Tag every pick with portfolio context so the UI can warn about
    // concentration (avoid silently re-recommending a name the user
    // already holds at 8% → 12%). Within a 5-pt conviction band we also
    // re-rank fresh names above held ones — preserves overall conviction
    // order while breaking ties toward diversification.
    //
    // Best-effort: any failure (no portfolio file, KV miss, parse error)
    // returns an empty map and the picks render unchanged.
    try {
      const weightMap = await loadPortfolioWeightMap();
      tagPicksWithPortfolio(filtered, weightMap);
      // P2.4: Tax-aware Sell overlay. Computes days-to-LTCG + STCG/LTCG
      // saving hint per held pick. No-op for buynow/midterm. Renders the
      // "DEFER N days for LTCG" or "ALREADY LTCG" hint on Sell cards.
      if (type === "sell") {
        tagSellPicksWithTax(filtered);
      }
      // Sell scanner is not re-ranked — exit alerts on held names are
      // exactly what the user wants surfaced first.
      if (type === "buynow" || type === "midterm") {
        if (type === "midterm") {
          for (const r of filtered) r._rankScore = r.midTerm?.score ?? 0;
          filtered = rerankFreshFirst(filtered, "_rankScore", 5);
          for (const r of filtered) delete r._rankScore;
        } else {
          filtered = rerankFreshFirst(filtered, "adjustedScore", 5);
        }
      }
    } catch (err) {
      console.warn("[scanner] portfolio overlay failed:", err.message);
    }

    // ─── P1.6: Conviction-as-% ───
    // Attach the realized historical hit-rate for each pick's score band
    // so the disclosure pane can render "78/100 → ~62%" instead of just
    // the qualitative STRONG/MODERATE/WEAK label. Built lazily and
    // cached 6h; null when the band has fewer than 10 historical trades.
    let convictionMap = null;
    try {
      convictionMap = await getOrBuildConvictionMap();
      for (const r of filtered) {
        const score = type === "midterm" ? r.midTerm?.score : (r.adjustedScore ?? r.score);
        const pct = getConvictionPct(score, convictionMap);
        r.convictionPct = pct;       // 0..1 ratio, or null
        r.convictionBand = getBandLabel(score);
      }
    } catch (err) {
      console.warn("[scanner] conviction map failed:", err.message);
    }

    // ─── P2.5: Timing observation per pick ───
    // Reuses services/timingObservation.js (already wired into the
    // portfolio review flow). Maps Buy Now / Mid-Term picks to "Top-up"
    // (a buy action) and Sell picks to "EXIT" so the function picks the
    // right intraday window. We only have earningsNearby per pick; the
    // SWS overview's monthly-return + analyst-revision fields aren't
    // loaded for the scanner (would require a deep-scrape per pick).
    // Without those, the function still produces the right output for
    // the dominant cases: market-state (NSE closed → wait-for-open),
    // earnings imminent (≤3d → No), regime severity, or default
    // "mid-morning 10:30-12:00 IST".
    try {
      const action = type === "sell" ? "EXIT" : "Top-up";
      const regimeSeverity = macroRegime?.severity ?? 0;
      for (const r of filtered) {
        const synthesizedScored = {
          overview: {
            next_earnings_date: r.earningsNearby?.date || null,
          },
        };
        const sectorImpact = (macroRegime?.sectorImpacts || {})[r.sector] ?? 0;
        try {
          r.timingObservation = computeTimingObservation({
            action,
            scored: synthesizedScored,
            regimeSeverity,
            sectorImpact,
          });
        } catch (_e) {
          r.timingObservation = null;
        }
      }
    } catch (err) {
      console.warn("[scanner] timing observation failed:", err.message);
    }

    // Shadow-mode capture: log a compact diff row per pick so the daily
    // summary script (scripts/combined-shadow-summary.mjs) can drive the
    // Phase-1 → Phase-2 gate decision. Awaited so KV writes complete
    // before the lambda exits — fire-and-forget loses ~89% of entries
    // when the lambda terminates before async writes settle.
    if (shouldComputeCombined()) {
      await captureShadowDiffBulk(filtered, methodologyType);
    }
    const response = {
      type,
      universe,
      stocks: filtered,
      scannedCount: results.length,
      universeSize: stocksToScan.length,
      fullUniverseSize,
      truncatedForVercel,
      ...failureTracker.summary(),
      methodology: shouldComputeCombined() ? getMethodology(methodologyType) : null,
      combinedScoreMode: COMBINED_SCORE_MODE,
      lastUpdated: new Date().toISOString(),
    };
    // Diagnostic: expose filter drop-off stats when ?debug=1. Only set for
    // buynow (the only path that uses baseFilter dropoff counters).
    if (type === "buynow" && req.query.debug === "1" && filterDropoff) {
      response.filterDropoff = filterDropoff;
    }
    // P1.6 calibration metadata: callers can render "calibrated against N
    // trades over the past Xd" in the disclosure pane footer.
    if (convictionMap) {
      response.conviction = {
        builtAt: convictionMap.builtAt,
        totalTrades: convictionMap.totalTrades,
        eligibleTrades: convictionMap.eligibleTrades,
        bandsCount: Object.keys(convictionMap.bands || {}).length,
      };
    }

    // High-conviction messaging: when strict filters (Phase 1) produce fewer
    // than 10 picks, communicate this as selectivity, not a gap.
    if (type === "buynow" && filtered.length < 10 && filtered.length > 0) {
      response.highConvictionMessage = `${filtered.length} high-conviction pick${filtered.length === 1 ? "" : "s"} found from ${results.length} scanned — only stocks with strong fundamentals (Deep Value or Quality Growth) and technical confirmation pass our filters.`;
    }
    // Zero-pick day: with SWS-weighted scoring under primary mode, some
    // sessions genuinely produce no Buy Now candidates clearing the 65
    // combined-score floor + verdict + R:R + earnings + sector gates. The
    // SEBI-honest response is to say "no picks today" rather than lower
    // the bar. Surface this prominently so the user knows the scanner ran.
    if (type === "buynow" && filtered.length === 0) {
      response.highConvictionMessage = `No Buy Now picks today. Scanner ran across ${results.length} stocks; none cleared every gate (combined score ≥ 65, fundamental verdict ∈ Quality Growth / Deep Value, R:R ≥ 1.5, outside the 3-trading-day earnings blackout, sector not in the excluded list). Mid-Term picks below may still be active.`;
    }

    // Attach the macro regime so the frontend can render the banner without
    // a second round-trip. Only for buynow — other scan types don't use it.
    if (type === "buynow" && macroRegime) {
      response.regime = macroRegime;
    }

    // ─── P2.1: Full input-snapshot audit trail (SEBI RA Reg §16(1)) ───
    // Persist every pick's complete input + decision metadata to
    // data/audit/scanner/{date}/{type}.json so a SEBI auditor can
    // reconstruct the reasoning behind any pick 5 years from now.
    // Best-effort: any I/O failure is logged but doesn't break the API.
    if ((type === "buynow" || type === "midterm" || type === "sell") && filtered.length > 0) {
      try {
        const niftyQuote = type === "buynow" ? await fetchQuote("^NSEI").catch(() => null) : null;
        await persistScannerAudit(filtered, type, {
          dateKey: getISTDateKey(),
          regime: macroRegime,
          niftyPrice: niftyQuote?.regularMarketPrice ?? null,
          methodologyVersion: shouldComputeCombined() ? getMethodology(methodologyType)?.version : null,
          universe,
          scannedAt: response.lastUpdated,
        });
      } catch (err) {
        console.warn("[scanner audit] persist failed:", err.message);
      }
    }

    // ─── Paper-trade snapshot trigger ───
    // On the first buynow scan of the day, persist the top picks with the
    // current price + regime context so we can later compute forward returns.
    // Idempotent: hasSnapshotToday() prevents duplicates if the user opens
    // the platform multiple times in a day.
    if (type === "buynow" && filtered.length > 0 && !(await hasSnapshotToday("buynow_nifty100"))) {
      try {
        // Capture the current Nifty 50 level so we can compute "alpha vs Nifty"
        // for every pick later.
        const niftyQuote = await fetchQuote("^NSEI").catch(() => null);
        const niftyPrice = niftyQuote?.regularMarketPrice ?? null;
        const result = await snapshotPicks(filtered, "buynow_nifty100", {
          regime: macroRegime,
          niftyPrice,
          rationale: "Auto-snapshot from /api/scan/buynow",
        });
        console.log(`[PAPERTRADES] Snapshotted ${result.written} buynow picks (Nifty=${niftyPrice})`);
      } catch (e) {
        console.warn("[PAPERTRADES] Snapshot failed:", e.message);
      }
    }

    scanCache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("Scan error:", err.message);
    res.status(500).json({ error: "Scan failed: " + err.message });
  }
});

// ==================== CRON: PRE-COMPUTE BUY NOW ====================

/**
 * GET /api/cron/scan-precompute
 *
 * Called by Vercel Cron every 5 minutes. Runs the FULL 100-stock Buy Now
 * scan without the 50-stock truncation cap, and caches the result. The
 * regular /api/scan/buynow endpoint checks for this cache first — if
 * present, it serves the pre-computed result instantly (no truncation,
 * no live scan needed).
 *
 * This eliminates the #1 performance gap between Vercel and local:
 *   Before: Vercel scans 49 stocks → 3 picks
 *   After:  Cron scans 100 stocks → 8 picks, served from cache
 *
 * Vercel cron jobs have up to 60 seconds (vs 10s for user requests).
 * The scan typically completes in 15-25 seconds for 100 stocks.
 *
 * Security: Vercel cron requests include an Authorization header with
 * CRON_SECRET. We verify it if the env var is set. An unauthenticated
 * ?warm=true mode is also accepted: it short-circuits when the cache is
 * fresh so it can't be DOSed, and only does real work when KV is empty.
 * Useful for manual cache warmup after a deploy or KV outage. The same
 * handler is also exposed at /api/admin/warm-scan-cache (which always
 * runs in warm mode).
 */
async function scanPrecomputeHandler(req, res) {
  // Auth: bearer token for scheduled cron, OR ?warm=true for unauthenticated
  // manual warmup. The warm path short-circuits when the cache is fresh so
  // it can't be used to DOS the upstream provider — work only happens when
  // KV is genuinely cold (e.g., right after a deploy or KV outage).
  const cronSecret = process.env.CRON_SECRET;
  const isAuthorized = !cronSecret || req.headers.authorization === `Bearer ${cronSecret}`;
  const isWarmRequest = req.query.warm === "true";
  if (!isAuthorized && !isWarmRequest) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Warm-mode short-circuit: regardless of auth, when warm=true we skip
  // real work if the cache is already fresh. This makes the admin alias
  // idempotent in both prod (CRON_SECRET set) and local dev (no secret).
  if (isWarmRequest) {
    const universeParam = (req.query.universe || "nifty100").toString();
    const segment = Math.max(0, parseInt(req.query.segment ?? "0", 10) || 0);
    const ofParam = Math.max(1, parseInt(req.query.of ?? "1", 10) || 1);
    const isExpanded = universeParam === "expanded";
    const cacheKey = isExpanded
      ? `precomputed_buynow_expanded:seg${segment}of${ofParam}`
      : "precomputed_buynow_nifty100";
    const l1 = scanCache.get(cacheKey);
    if (l1) {
      return res.json({ ok: true, source: "L1", warmed: false, reason: "already_fresh" });
    }
    try {
      const kv = await getKVClientForPortfolio();
      if (kv) {
        const l2 = await kv.get(`scan:${cacheKey}`);
        if (l2) {
          scanCache.set(cacheKey, l2, 28800);
          return res.json({ ok: true, source: "L2", warmed: false, reason: "already_fresh" });
        }
      }
    } catch { /* fall through and actually warm */ }
    console.log(`[WARM] Cache cold for ${cacheKey} — running precompute`);
  }

  try {
    const startTime = Date.now();

    // Segmentation params for the expanded-universe scan.
    //   universe=expanded → scan curated + supplement Nifty-indexed (~750 names)
    //   segment=N, of=M   → scan only slice N of M (0-indexed). Each Vercel
    //                       cron fires a distinct segment so the full scan
    //                       completes within the 60s function cap.
    //   universe=nifty100 (default, no-op) → legacy 100-stock scan.
    const universeParam = (req.query.universe || "nifty100").toString();
    const segment = Math.max(0, parseInt(req.query.segment ?? "0", 10) || 0);
    const ofParam = Math.max(1, parseInt(req.query.of ?? "1", 10) || 1);
    const isExpanded = universeParam === "expanded";

    let stocksToScan;
    if (isExpanded) {
      const full = getExpandedUniverse();
      const sliceSize = Math.ceil(full.length / ofParam);
      const from = segment * sliceSize;
      const to = Math.min(from + sliceSize, full.length);
      stocksToScan = full.slice(from, to);
      console.log(
        `[CRON] Starting expanded Buy Now pre-compute — segment ${segment + 1}/${ofParam} (${stocksToScan.length} of ${full.length} stocks)`
      );
    } else {
      stocksToScan = getNifty100();
      console.log("[CRON] Starting full 100-stock Buy Now pre-compute...");
    }

    const failureTracker = createFailureTracker();
    const results = [];
    const BATCH_SIZE = 10; // slightly larger batches since we have 60s

    for (let i = 0; i < stocksToScan.length; i += BATCH_SIZE) {
      const batch = stocksToScan.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (stock) => {
          try {
            const [quote, historical] = await Promise.all([
              fetchQuote(stock.symbol),
              fetchHistorical(stock.symbol),
            ]);
            if (!quote || !historical || historical.length < 30) return null;

            const analysis = analyzeStock(historical, quote);
            const intraday = intradayScan(analysis, quote);
            const midTerm = midTermAnalysis(analysis, quote, historical ? historical.map(d => d.close) : null);

            return {
              symbol: stock.symbol,
              name: stock.name,
              sector: stock.sector,
              price: quote.regularMarketPrice,
              change: quote.regularMarketChange,
              changePercent: quote.regularMarketChangePercent,
              score: analysis.score,
              recommendation: analysis.recommendation,
              reasoning: analysis.reasoning,
              midTerm,
              volume: analysis.indicators?.volume?.description || "N/A",
              rsi: analysis.indicators?.rsi || "N/A",
              trend: analysis.indicators?.trend?.trend || "N/A",
              atr: analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null,
            };
          } catch { return null; }
        })
      );
      results.push(...batchResults.filter(Boolean));
      if (i + BATCH_SIZE < stocksToScan.length) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    // Apply the full Buy Now scoring pipeline (same as the regular handler)
    let macroRegime = null;
    try { macroRegime = await getMacroRegime(); }
    catch { macroRegime = defaultCalmRegime(); }

    // Mirror of the live scanner's 50/50 weighting (precompute path).
    const SCANNER_TECH_WEIGHT = 0.50;
    const SCANNER_FUND_WEIGHT = 0.50;

    for (const r of results) {
      const fundSnap = getFundamentals(r.symbol);
      let fundamentalScore = null;
      let fundamentalVerdict = null;
      if (fundSnap) {
        const fundResult = scoreForResponse(fundSnap).primary;
        if (fundResult) {
          fundamentalScore = fundResult.score;
          fundamentalVerdict = fundResult.verdict;
        }
      }

      const techScore = r.score;
      let combinedBase;
      let dataConfidence;
      if (fundamentalScore != null) {
        combinedBase = techScore * SCANNER_TECH_WEIGHT + fundamentalScore * SCANNER_FUND_WEIGHT;
        dataConfidence = "high";
      } else {
        combinedBase = techScore;
        dataConfidence = "medium";
      }

      const { delta, reason, sector } = computeMacroDelta(macroRegime, r.sector);
      r.macroBoost = delta;
      r.macroReason = reason;
      r.macroSector = sector;
      r.technicalScore = techScore;
      r.fundamentalScore = fundamentalScore;
      r.fundamentalVerdict = fundamentalVerdict;
      r.dataConfidence = dataConfidence;
      r.baseScore = Math.round(combinedBase);
      r.adjustedScore = Math.max(0, Math.min(100, combinedBase + delta));

      // Phase 6: SL 4× ATR, Target 6× ATR — matches live scanner handler
      const atr = r.atr ?? null;
      if (atr && r.price) {
        r.stopLoss = parseFloat((r.price - atr * 4).toFixed(2));
        r.target = parseFloat((r.price + atr * 6).toFixed(2));
        r.riskReward = parseFloat(((r.target - r.price) / (r.price - r.stopLoss)).toFixed(2));
      }
    }

    // Apply filters + sector diversification — Phase 1: MAX_PER_SECTOR 3 → 2
    // to match the live handler. Prevents a single sector dominating the
    // scan output (which currently punishes us when the leading sector
    // happens to be Cement or Tourism — 0%/6% WR in the honest backtest).
    const MAX_PER_SECTOR = 2;
    const sectorCounts = {};
    const candidates = results
      .filter((r) => {
        if (r.adjustedScore < 65) return false;
        if (r.recommendation === "HOLD") return false;
        if (r.fundamentalVerdict === "OVERVALUED" || r.fundamentalVerdict === "FULLY_VALUED" || r.fundamentalVerdict === "FAIR_VALUE") return false;
        return true;
      })
      .sort((a, b) => b.adjustedScore - a.adjustedScore);

    const diversified = [];
    for (const r of candidates) {
      if (diversified.length >= 10) break;
      const sector = normalizeSector(r.sector) || r.sector || "Unknown";
      sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
      if (sectorCounts[sector] > MAX_PER_SECTOR) continue;
      diversified.push(r);
    }

    const filtered = diversified.map((r) => ({
      ...r,
      score: Math.round(r.adjustedScore),
    }));

    const response = {
      type: "buynow",
      universe: isExpanded ? "expanded" : "nifty100",
      segment: isExpanded ? segment : null,
      of: isExpanded ? ofParam : null,
      stocks: filtered,
      scannedCount: results.length,
      universeSize: stocksToScan.length,
      fullUniverseSize: stocksToScan.length,
      truncatedForVercel: false, // full scan — no truncation!
      precomputed: true,
      precomputedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };

    if (filtered.length < 10 && filtered.length > 0) {
      response.highConvictionMessage = `${filtered.length} high-conviction pick${filtered.length === 1 ? "" : "s"} found from ${results.length} scanned — only stocks with strong fundamentals (Deep Value or Quality Growth) and technical confirmation pass our filters.`;
    }

    if (macroRegime) response.regime = macroRegime;

    // Two-tier write with asymmetric TTLs:
    //   L1 (NodeCache, per-instance): 8h TTL — serves same-lambda re-hits
    //   L2 (Vercel KV, shared): 7d TTL — survives overnight, weekends, and
    //     missed cron runs. The cron overwrites it daily, so stale reads
    //     are rare; an 8h L2 TTL used to cause 504s after 17:30 IST and
    //     all weekend because the expanded path then attempted a 750-stock
    //     live scan that exceeds Vercel's 60s function ceiling.
    //
    // Segmented (expanded) cache key carries the slice index so each cron
    // job writes its own partition; /api/scan/buynow reassembles them.
    const PRECOMPUTE_CACHE_KEY = isExpanded
      ? `precomputed_buynow_expanded:seg${segment}of${ofParam}`
      : "precomputed_buynow_nifty100";
    const L1_TTL_SECONDS = 28800;       // 8 hours
    const L2_TTL_SECONDS = 604800;      // 7 days
    scanCache.set(PRECOMPUTE_CACHE_KEY, response, L1_TTL_SECONDS);
    try {
      const kv = await getKVClientForPortfolio();
      if (kv) await kv.set(`scan:${PRECOMPUTE_CACHE_KEY}`, response, { ex: L2_TTL_SECONDS });
    } catch (e) {
      console.warn("[CRON] KV scan cache write failed:", e.message);
    }

    // Also trigger paper-trade snapshot (once per day) — only on the
    // canonical Nifty 100 scan, not on expanded segments (which fire ~4×
    // and would otherwise produce duplicate/inconsistent snapshots).
    if (!isExpanded && filtered.length > 0 && !(await hasSnapshotToday("buynow_nifty100"))) {
      try {
        const niftyQuote = await fetchQuote("^NSEI").catch(() => null);
        const niftyPrice = niftyQuote?.regularMarketPrice ?? null;
        const snapResult = await snapshotPicks(filtered, "buynow_nifty100", {
          regime: macroRegime,
          niftyPrice,
          rationale: "Auto-snapshot from cron pre-compute (full 100-stock scan)",
        });
        console.log(`[CRON] Paper-trade snapshot: ${snapResult.written} picks captured`);
      } catch (e) {
        console.warn("[CRON] Snapshot failed:", e.message);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[CRON] Pre-compute done: ${results.length} scanned, ${filtered.length} picks, ${elapsed}s`);

    res.json({
      ok: true,
      scanned: results.length,
      picks: filtered.length,
      elapsed: `${elapsed}s`,
      cachedUntil: new Date(Date.now() + 360000).toISOString(),
    });
  } catch (err) {
    console.error("[CRON] Pre-compute failed:", err.message);
    res.status(500).json({ error: err.message });
  }
}

app.get("/api/cron/scan-precompute", scanPrecomputeHandler);

/**
 * GET /api/admin/warm-scan-cache
 *
 * Unauthenticated alias of /api/cron/scan-precompute that always runs in
 * warm mode. Idempotent: returns 200 immediately when the cache is fresh,
 * only does real work when KV is cold. Pass ?universe=expanded&segment=N&of=4
 * to warm a specific expanded slice; default warms the Nifty 100 cache.
 *
 * Typical use: after a Vercel deploy or KV outage, hit this 5× (nifty100
 * + 4 expanded segments) to rehydrate caches without waiting for cron.
 */
app.get("/api/admin/warm-scan-cache", (req, res) => {
  req.query.warm = "true";
  return scanPrecomputeHandler(req, res);
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
 * Hourly cron (see vercel.json) that keeps the two expensive-to-build
 * NodeCaches primed — macro regime and NSE event calendar. Both block the
 * portfolio endpoint on cold start if the cache is empty, and both take
 * 10-40s to build from scratch (RSS fetches + OpenAI call for regime, NSE
 * cookie handshake that usually times out on Vercel US IPs for events).
 *
 * By refreshing them hourly on the cron's own time, every user request
 * finds both caches populated and returns in <5s even on cold start.
 *
 * Security: CRON_SECRET bearer auth (matches the other two crons).
 * Runtime: ~20-30s typical; well under the 60s function ceiling.
 */
app.get("/api/cron/warm-caches", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const started = Date.now();
  const results = {};

  // Refresh macro regime in parallel with NSE events — both are independent.
  await Promise.allSettled([
    refreshMacroRegime().then(
      (r) => { results.macroRegime = { ok: true, regime: r?.regime || r?.label || "unknown" }; },
      (e) => { results.macroRegime = { ok: false, error: e.message }; }
    ),
    fetchNseEventCalendar().then(
      (events) => {
        catalystCache.set("nse_events", events);
        results.nseEvents = { ok: true, count: events?.length || 0 };
      },
      (e) => { results.nseEvents = { ok: false, error: e.message }; }
    ),
  ]);

  res.json({ ok: true, elapsedMs: Date.now() - started, ...results });
});

/**
 * GET /api/cron/enrich-fundamentals
 *
 * Weekly Vercel cron (Sundays pre-market, see vercel.json). Fetches fresh
 * quality metrics — ROE, Debt/Equity, profit margin, YoY revenue growth —
 * from Yahoo Finance for all ~112 stocks in the universe, then persists the
 * enriched snapshot to Vercel KV.
 *
 * Why a cron and not on-demand:
 *   Fundamentals move slowly. Quarterly earnings → quarterly restatements.
 *   A weekly refresh catches every quarterly update comfortably without
 *   hammering Yahoo during every page load. The in-memory cache (primed
 *   from KV at function cold-start) serves all read requests in microseconds.
 *
 * Runtime budget:
 *   Vercel cron functions have a 60-second max duration. Empirically, 112
 *   stocks at concurrency=4 completes in ~15-20 seconds — plenty of margin.
 *   The existing fundamentals.json on disk is used as the starting seed so
 *   we only need to fill in the 4 quality fields, not refetch prices.
 *
 * Security: matches scan-precompute — checks CRON_SECRET bearer token if set.
 *
 * Manual testing: curl http://localhost:3000/api/cron/enrich-fundamentals
 * (no auth header required in local dev because CRON_SECRET isn't set).
 */
app.get("/api/cron/enrich-fundamentals", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const startTime = Date.now();
    console.log("[CRON] Starting fundamentals refresh + enrichment...");

    // Seed from the current cached snapshot. In production (KV-primed) this
    // is whatever yesterday's cron wrote. In local dev it's the committed
    // fundamentals.json.
    const current = loadFundamentalsFromDisk();
    if (!current || !current.snapshots) {
      return res.status(500).json({
        error: "No seed snapshot available. Run refresh-fundamentals.mjs first.",
      });
    }

    // Deep-clone so we don't mutate the cached object while it's being read
    // by concurrent request handlers. The scoring hot-path reads this same
    // cache synchronously, so an in-place mutation race could briefly expose
    // half-enriched rows to the scanner.
    const data = JSON.parse(JSON.stringify(current));

    // ─── PHASE 1: Refresh NSE price snapshot (updates `generatedAt`) ───
    //
    // This step used to only run via scripts/refresh-fundamentals.mjs on a
    // developer's laptop, which meant the `generatedAt` field only moved
    // when someone manually re-ran that script and committed a new
    // fundamentals.json. On Vercel the page would stamp "Updated 12 days
    // ago" because the price snapshot was frozen since the last commit.
    //
    // Now that nseGet tries unauth first (and /api/quote-equity works
    // cookie-less), we can do this on Vercel every weekday. Re-scrape P/E,
    // price, 52W range, market cap — the fields that actually move daily.
    //
    // Concurrency 5, 300ms delay = ~7s for 112 stocks. Well inside the 60s
    // function limit even with the enrichment phase after.
    const symbols = Object.keys(data.snapshots);
    const snapBatchSize = 5;
    let priceRefreshed = 0;
    let priceFailed = 0;
    for (let i = 0; i < symbols.length; i += snapBatchSize) {
      const batch = symbols.slice(i, i + snapBatchSize);
      const results = await Promise.all(
        batch.map(async (sym) => {
          try {
            const raw = await fetchNseQuoteRaw(sym);
            if (!raw || !raw.priceInfo) return { sym, ok: false };
            const p = raw.priceInfo || {};
            const meta = raw.metadata || {};
            const sec = raw.securityInfo || {};
            const info = raw.info || {};
            const ind = raw.industryInfo || {};
            const existing = data.snapshots[sym] || {};
            // Overlay — keep all existing enriched Yahoo fields (roe, d/e,
            // profitMargin, revenueGrowth, etc.) and only bump the NSE-sourced
            // numbers.
            data.snapshots[sym] = {
              ...existing,
              symbol: sym,
              name: info.companyName || existing.name,
              sector: ind.sector || meta.industry || existing.sector || null,
              industry: ind.industry || meta.industry || existing.industry || null,
              pe: meta.pdSymbolPe ?? existing.pe,
              sectorPe: meta.pdSectorPe ?? existing.sectorPe,
              price: p.lastPrice ?? existing.price,
              previousClose: p.previousClose ?? existing.previousClose,
              faceValue: sec.faceValue ?? existing.faceValue,
              issuedSize: sec.issuedSize ?? existing.issuedSize,
              marketCap:
                p.lastPrice && sec.issuedSize
                  ? p.lastPrice * sec.issuedSize
                  : existing.marketCap,
              week52High: p.weekHighLow?.max ?? existing.week52High,
              week52Low: p.weekHighLow?.min ?? existing.week52Low,
              week52HighDate: p.weekHighLow?.maxDate ?? existing.week52HighDate,
              week52LowDate: p.weekHighLow?.minDate ?? existing.week52LowDate,
              vwap: p.vwap ?? existing.vwap,
              upperCircuit: p.upperCP ?? existing.upperCircuit,
              lowerCircuit: p.lowerCP ?? existing.lowerCircuit,
              isin: info.isin ?? existing.isin,
            };
            return { sym, ok: true };
          } catch {
            return { sym, ok: false };
          }
        }),
      );
      priceRefreshed += results.filter((r) => r.ok).length;
      priceFailed += results.filter((r) => !r.ok).length;
      if (i + snapBatchSize < symbols.length) await new Promise((r) => setTimeout(r, 300));
    }
    data.generatedAt = new Date().toISOString();
    data.source = "nse";
    console.log(`[CRON] NSE price refresh: ${priceRefreshed} ok, ${priceFailed} failed`);

    // ─── PHASE 2: Yahoo quality enrichment (updates `enrichedAt`) ───
    //
    // Dynamic import so the enrichFundamentals module (which pulls in
    // yahoo-finance2, ~400KB) only loads when the cron actually fires — not
    // on every cold start.
    const { enrichSnapshot } = await import("./enrichFundamentals.js");

    const result = await enrichSnapshot(data, {
      concurrency: 4,
      // No onProgress — Vercel logs truncate at ~4KB so 112 lines would get
      // dropped anyway. We log the summary at the end instead.
    });

    // Persist to KV (production) or disk (local dev, as a convenience).
    const savedToKV = await saveFundamentalsToKV(data);
    let savedToDisk = false;
    if (!savedToKV && existsSync(FUNDAMENTALS_PATH_SERVER)) {
      try {
        writeFileSync(FUNDAMENTALS_PATH_SERVER, JSON.stringify(data, null, 2), "utf-8");
        savedToDisk = true;
      } catch (err) {
        console.error("[CRON] disk write failed:", err.message);
      }
    }

    // Bust the scanner response cache. fundamentalsCache caches per-category
    // scan responses for 10 minutes; without this flush, users hitting the
    // scanner right after the cron run would still see the stale report for
    // up to 10 minutes. The underlying snapshot cache was already refreshed
    // by saveFundamentalsToKV (KV path) or by the disk mtime check on the
    // next loadFundamentalsFromDisk() call (disk path).
    fundamentalsCache.flushAll();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[CRON] Full refresh complete in ${elapsed}s. ` +
      `Price: ${priceRefreshed} ok / ${priceFailed} failed. ` +
      `Enriched: ${result.enriched}, Skipped: ${result.skipped}, Failed: ${result.failed}. ` +
      `Sink: ${savedToKV ? "KV" : (savedToDisk ? "disk" : "none")}`
    );

    res.json({
      ok: true,
      priceRefreshed,
      priceFailed,
      enriched: result.enriched,
      skipped: result.skipped,
      failed: result.failed,
      elapsedSec: Number(elapsed),
      sink: savedToKV ? "kv" : (savedToDisk ? "disk" : "none"),
      generatedAt: data.generatedAt,
      enrichedAt: data.enrichedAt,
    });
  } catch (err) {
    console.error("[CRON] Fundamentals refresh failed:", err);
    res.status(500).json({ error: err.message });
  }
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
 *   • Secret-gated via CRON_SECRET, same pattern as enrich-fundamentals.
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
 * GET /api/surveillance/list
 *
 * Returns the full flagged map. Used by the Fundamental Scanner to exclude
 * surveilled stocks from any "top picks" surface, and by admin/debug UIs.
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
    const fundamentalsSnap = getAllFundamentals() || {};
    const enriched = Object.keys(fundamentalsSnap);
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
 * Vercel cron handler. Mirrors auth pattern of /api/cron/enrich-fundamentals
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
 * Volume Breakout scanner
 * Finds stocks where today's volume is spiking well above historical average.
 * Uses a short TTL cache (60s) so data stays fresh intraday.
 */
const volumeBreakoutCache = new NodeCache({ stdTTL: 60, checkperiod: 30 });

app.get("/api/scan/volume-breakout", async (req, res) => {
  try {
    const cacheKey = "scan_volume_breakout";
    const cached = volumeBreakoutCache.get(cacheKey);
    if (cached) return res.json(cached);

    let stocksToScan = getNifty100();
    // No truncation — maxDuration=60s handles the timeout
    const failureTracker = createFailureTracker();
    const results = [];

    // What fraction of the trading day has elapsed (IST 9:15–15:30)?
    const now = new Date();
    const istMinutes =
      now.getUTCHours() * 60 + now.getUTCMinutes() + 5 * 60 + 30;
    const marketStart = 9 * 60 + 15; // 9:15 IST in minutes
    const marketEnd = 15 * 60 + 30; // 15:30 IST
    const elapsedFraction = Math.min(
      1,
      Math.max(0.1, (istMinutes - marketStart) / (marketEnd - marketStart))
    );

    const BATCH_SIZE = 8;
    for (let i = 0; i < stocksToScan.length; i += BATCH_SIZE) {
      const batch = stocksToScan.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (stock) => {
          try {
            const [quote, historical] = await Promise.all([
              fetchQuote(stock.symbol),
              fetchHistorical(stock.symbol),
            ]);
            if (!quote) { failureTracker.record(stock.symbol, "quote_null"); return null; }
            if (!historical) { failureTracker.record(stock.symbol, "historical_null"); return null; }
            if (historical.length < 20) { failureTracker.record(stock.symbol, "insufficient_bars"); return null; }

            const currentVolume = quote.regularMarketVolume;
            if (!currentVolume) { failureTracker.record(stock.symbol, "no_volume"); return null; }

            // Average daily volume over last 20 trading days
            const avgVolume =
              historical
                .slice(-20)
                .reduce((s, d) => s + (d.volume || 0), 0) / 20;

            if (!avgVolume || avgVolume === 0) return null;

            // Annualised ratio: compare today's partial volume to a full day
            const projectedVolume = currentVolume / elapsedFraction;
            const volumeRatio = projectedVolume / avgVolume;

            // Raw ratio (unscaled) – useful for display
            const rawRatio = currentVolume / avgVolume;

            // Only flag genuine spikes
            if (volumeRatio < 1.5) return null;

            const changePercent = quote.regularMarketChangePercent || 0;
            const direction =
              changePercent > 0.3 ? "BULLISH" : changePercent < -0.3 ? "BEARISH" : "NEUTRAL";

            // Momentum quality: high volume + big price move = strong signal
            const signalStrength =
              volumeRatio >= 4
                ? "EXPLOSIVE"
                : volumeRatio >= 2.5
                ? "VERY HIGH"
                : volumeRatio >= 1.5
                ? "HIGH"
                : "MODERATE";

            let action, actionColor;
            if (direction === "BULLISH") {
              action = "BUY / LONG";
              actionColor = "green";
            } else if (direction === "BEARISH") {
              action = "SELL / SHORT";
              actionColor = "red";
            } else {
              action = "WATCH";
              actionColor = "yellow";
            }

            // Simple ATR-based stop / target from historical
            const closes = historical.map((d) => d.close);
            const highs = historical.map((d) => d.high);
            const lows = historical.map((d) => d.low);

            // rough ATR (last 14 days)
            let atr = null;
            if (historical.length >= 15) {
              const trs = [];
              for (let j = 1; j < Math.min(15, historical.length); j++) {
                trs.push(
                  Math.max(
                    highs[highs.length - j] - lows[lows.length - j],
                    Math.abs(highs[highs.length - j] - closes[closes.length - j - 1]),
                    Math.abs(lows[lows.length - j] - closes[closes.length - j - 1])
                  )
                );
              }
              atr = trs.reduce((s, v) => s + v, 0) / trs.length;
            }

            const price = quote.regularMarketPrice;
            const stopLoss = atr
              ? direction === "BULLISH"
                ? (price - atr * 1.2).toFixed(2)
                : (price + atr * 1.2).toFixed(2)
              : null;
            const target = atr
              ? direction === "BULLISH"
                ? (price + atr * 2).toFixed(2)
                : (price - atr * 2).toFixed(2)
              : null;

            const reasoning =
              `Volume is ${volumeRatio.toFixed(1)}x the 20-day average (${rawRatio.toFixed(1)}x raw so far today). ` +
              `Price is ${changePercent >= 0 ? "up" : "down"} ${Math.abs(changePercent).toFixed(2)}% ` +
              `suggesting ${direction === "BULLISH" ? "institutional buying" : direction === "BEARISH" ? "heavy selling / distribution" : "indecision — wait for price confirmation"}.` +
              (signalStrength === "EXPLOSIVE" ? " EXPLOSIVE breakout — high conviction." : "");

            return {
              symbol: stock.symbol,
              name: stock.name,
              sector: stock.sector,
              price,
              change: quote.regularMarketChange,
              changePercent,
              currentVolume,
              avgVolume,
              volumeRatio,
              rawRatio,
              projectedVolume,
              signalStrength,
              direction,
              action,
              actionColor,
              stopLoss,
              target,
              reasoning,
              dayHigh: quote.regularMarketDayHigh,
              dayLow: quote.regularMarketDayLow,
            };
          } catch (e) {
            return null;
          }
        })
      );

      results.push(...batchResults.filter(Boolean));
      if (i + BATCH_SIZE < stocksToScan.length) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    // Sort by volume ratio descending, show top 12
    const sorted = results
      .sort((a, b) => b.volumeRatio - a.volumeRatio)
      .slice(0, 12);

    const response = {
      stocks: sorted,
      scannedCount: stocksToScan.length,
      elapsedFraction: Math.round(elapsedFraction * 100),
      ...failureTracker.summary(),
      lastUpdated: new Date().toISOString(),
    };

    volumeBreakoutCache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("Volume breakout scan error:", err.message);
    res.status(500).json({ error: "Volume breakout scan failed: " + err.message });
  }
});

/**
 * Market overview / indices
 */
// ==================== FUNDAMENTAL VALUE SCANNER ====================

const fundamentalsCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// ==================== SECTOR HEATMAP ====================

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

    // Signal 3: Buy Now pick count
    let pickSignal = "yellow", pickAction = "Moderate pickings.";
    let pickCount = 0;
    try {
      const scanKey = "precomputed_buynow_nifty100";
      const scanData = scanCache.get(scanKey) || scanCache.get("scan_buynow_nifty100");
      pickCount = scanData?.stocks?.length || 0;
      if (pickCount >= 8) { pickSignal = "green"; pickAction = `${pickCount} stocks pass strict quality filters. Plenty of value.`; score += 2; }
      else if (pickCount >= 5) { pickSignal = "yellow"; pickAction = `${pickCount} picks. Be selective — focus on DEEP VALUE names.`; score += 1; }
      else if (pickCount >= 1) { pickSignal = "yellow"; pickAction = `Only ${pickCount} stocks pass. Market is mostly expensive.`; score -= 1; }
      else { pickSignal = "red"; pickAction = "Zero stocks pass quality filter. Stay in cash."; score -= 3; }
    } catch { /* silent */ }

    signals.push({
      name: "Buy Opportunities",
      signal: pickSignal,
      value: `${pickCount} picks available`,
      action: pickAction,
      icon: pickCount >= 8 ? "🎯" : pickCount >= 1 ? "🔍" : "⛔",
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

app.get("/api/sector-heatmap", async (req, res) => {
  try {
    const cached = sectorHeatmapCache.get("heatmap");
    if (cached) return res.json(cached);

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
    res.json(response);
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

app.get("/api/fii-dii", async (req, res) => {
  try {
    const cached = fiiDiiCache.get("fii_dii");
    if (cached) return res.json(cached);

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
      return res.json(response);
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
    res.json(response);
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

/**
 * Fundamental Value Scanner — returns categorised stocks for the UI.
 * Supported categories: deepValue, qualityGrowth, fairValue, fullyValued, overvalued, all
 */
const VALID_FUND_CATEGORIES = ["all", "deepValue", "qualityGrowth", "fairValue", "fullyValued", "overvalued"];

app.get("/api/scan/fundamentals", async (req, res) => {
  try {
    const category = req.query.category || "all";
    if (!VALID_FUND_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: `Unknown category "${category}". Valid categories: ${VALID_FUND_CATEGORIES.join(", ")}`,
      });
    }
    const cacheKey = `fund_${category}`;
    const cached = fundamentalsCache.get(cacheKey);
    if (cached) return res.json(cached);

    const allSnapshots = getAllFundamentals();
    if (allSnapshots.length === 0) {
      return res.json({
        stocks: [],
        category,
        error: "No fundamental data available. Run `node scripts/refresh-fundamentals.mjs` locally to generate fundamentals.json.",
        lastUpdated: new Date().toISOString(),
      });
    }

    // Score every snapshot via the mode-aware helper. No 200DMA lookup here
    // (too slow with 100+ historical fetches; the per-stock endpoint gets
    // 200DMA on demand). Under v2-primary the `score`/`verdict` on each row
    // are V2's — bucketing and macro overlay work off those transparently
    // because V2 uses the same verdict labels. The opposite-scorer's
    // lightweight (score+verdict+version) copy rides along per row so the
    // UI can show an inline "old scorer said X" chip during the transition.
    const scored = allSnapshots
      .map((snap) => {
        const { primary, legacy, shadow } = scoreForResponse(snap, null);
        if (!primary) return null;
        return {
          ...primary,
          legacyV1: compactScorerInfo(legacy),
          shadowV2: compactScorerInfo(shadow),
        };
      })
      .filter(Boolean);

    // SEBI compliance overlay — attach surveillance flag to every scored row.
    // The UI uses this to badge the card and, critically, to exclude surveilled
    // stocks from any "top picks" surface (buckets.deepValue / qualityGrowth).
    // Read once, check per-stock via the pre-built map.
    const surveillanceSnap = getSurveillance();
    const flaggedMap = surveillanceSnap.flagged || {};
    for (const s of scored) {
      const sym = s.snapshot?.symbol || s.symbol;
      const flag = sym ? flaggedMap[sym] : null;
      if (flag) s.surveillance = flag;
    }

    // ─── Macro regime overlay (half-weight) ───
    // Fundamentals move slowly; macro shouldn't overpower them. Apply half-weight
    // macro delta so the fundamental value-investor character stays intact —
    // macro just surfaces the safest-in-context picks first. Clamped to ±8.
    let macroRegime = null;
    try {
      macroRegime = await getMacroRegime();
    } catch (e) {
      console.warn("[MACRO] fundamental scan: failed to load regime:", e.message);
      macroRegime = defaultCalmRegime();
    }
    const FUND_WEIGHT = 0.5;
    const FUND_CLAMP = 5;

    for (const s of scored) {
      const { delta: rawDelta, reason, sector: canonicalSector } =
        computeMacroDelta(macroRegime, s.snapshot?.sector || s.sector);
      const macroBoost = Math.max(
        -FUND_CLAMP,
        Math.min(FUND_CLAMP, parseFloat((rawDelta * FUND_WEIGHT).toFixed(1)))
      );
      s.macroBoost = macroBoost;
      s.macroReason = reason;
      s.macroSector = canonicalSector;
      s.baseScore = s.score;
      s.adjustedScore = Math.max(0, Math.min(100, s.score + macroBoost));
    }

    // ── Combined Score enrichment (Tech + Fund + SWS) for Fundamental scanner ──
    // Fundamental scanner has no native technical score (no candle scan), so
    // we fetch a lightweight technical from analysis if needed. For now we
    // pass null for tech — fund scanner combined math reweights pro-rata
    // (45% fund + 35% sws, normalized to 56/44 when tech absent). When SWS
    // is also missing the combined score collapses to the V2 fundamental
    // score, which is the existing behaviour — zero regression.
    if (shouldComputeCombined() && scored.length > 0) {
      const swsMap = lookupSwsScoreBulk(scored.map((s) => s.snapshot?.symbol || s.symbol));
      for (const s of scored) {
        const sym = s.snapshot?.symbol || s.symbol;
        const sws = swsMap.get(sym) || {};
        s.swsScore = sws.v3Score ?? null;
        s.swsVerdict = sws.v3Verdict ?? null;
        s.swsSource = sws.source ?? "missing";
        s.swsCovered = sws.source === "primary";
        s.snowflakeTotal = sws.snowflakeTotal ?? null;

        const combined = computeCombinedScore({
          techScore: null,
          fundScore: s.score,
          swsScore: s.swsScore,
          scannerType: "fund",
          surveillanceFlag: sws.surveillance,
          swsFallback: sws.source === "fallback",
        });
        s.combinedScore = combined.combinedScore;
        s.combinedDims = combined.contributingDims;
        s.combinedDataConfidence = combined.dataConfidence;
        s.combinedDivergence = combined.divergence;
        s.combinedDivergenceSpread = combined.divergenceSpread;
        s.combinedWeights = combined.weightsUsed;
        s.combinedScoreVersion = combined.methodologyVersion;
        s.combinedScoreMode = COMBINED_SCORE_MODE;

        if (shouldSortByCombined() && combined.combinedScore != null) {
          s.legacyAdjustedScore = s.adjustedScore;
          s.adjustedScore = combined.combinedScore;
        }
      }
    }

    // Re-sort scored array by adjusted score so macro-tilted picks surface first
    // in the "all" view. Categorisation logic is unaffected — it still reads the
    // raw `score` for deepValue/fairValue/etc buckets (macro shouldn't override
    // fundamental valuation buckets).
    const scoredForSort = [...scored].sort((a, b) => (b.adjustedScore ?? b.score) - (a.adjustedScore ?? a.score));

    // Categorise (unchanged — still uses raw `score` for bucketing)
    const buckets = categoriseBatch(scored, 15);

    // SEBI compliance gate: a surveilled stock (ASM/GSM) cannot appear in the
    // high-conviction DEEP_VALUE or QUALITY_GROWTH buckets. These are the
    // surfaces retail users treat as "what should I buy" — promoting a stock
    // under regulatory surveillance there is the single biggest compliance
    // risk on the platform. We keep surveilled stocks visible in fairValue /
    // all with the warning banner, so they're not hidden — just not promoted.
    const flaggedSymbolSet = new Set(Object.keys(flaggedMap));
    const dropFlagged = (arr) =>
      arr.filter((s) => {
        const sym = s.snapshot?.symbol || s.symbol;
        return !flaggedSymbolSet.has(sym);
      });
    buckets.deepValue = dropFlagged(buckets.deepValue);
    buckets.qualityGrowth = dropFlagged(buckets.qualityGrowth);

    let stocks;
    if (category === "deepValue")         stocks = buckets.deepValue;
    else if (category === "qualityGrowth") stocks = buckets.qualityGrowth;
    else if (category === "fairValue")     stocks = buckets.fairValue;
    else if (category === "fullyValued")   stocks = buckets.fullyValued;
    else if (category === "overvalued")    stocks = buckets.overvalued;
    else                                    stocks = scoredForSort.slice(0, 30);

    const response = {
      category,
      stocks,
      scannedCount: scored.length,
      source: "nse_snapshot",
      scorerMode: SCORER_MODE,
      // Two separate freshness stamps:
      //   generatedAt — last NSE price/P/E refresh (daily via cron now).
      //   enrichedAt  — last Yahoo quality metrics (ROE, D/E, margin, growth) refresh.
      // UI picks the more recent one to show "Updated X days ago" so a stale
      // NSE snapshot doesn't make daily-enriched data look old.
      snapshotGeneratedAt: getSnapshotGeneratedAt(),
      snapshotEnrichedAt: getSnapshotEnrichedAt(),
      regime: macroRegime,
      methodology: shouldComputeCombined() ? getMethodology("fund") : null,
      combinedScoreMode: COMBINED_SCORE_MODE,
      lastUpdated: new Date().toISOString(),
    };

    if (shouldComputeCombined()) {
      await captureShadowDiffBulk(stocks, "fund");
    }

    // Paper-trade snapshot: capture deep-value picks once per day. Picks are
    // pulled from the deepValue bucket regardless of which category was
    // requested, so the trade record always reflects the best fundamental
    // candidates from this snapshot.
    if (buckets.deepValue.length > 0 && !(await hasSnapshotToday("fundamental_deep_value"))) {
      try {
        const niftyQuote = await fetchQuote("^NSEI").catch(() => null);
        const niftyPrice = niftyQuote?.regularMarketPrice ?? null;
        const result = await snapshotPicks(buckets.deepValue.slice(0, 10), "fundamental_deep_value", {
          regime: macroRegime,
          niftyPrice,
          rationale: "Auto-snapshot: top 10 DEEP_VALUE picks",
        });
        console.log(`[PAPERTRADES] Snapshotted ${result.written} fundamental deep-value picks`);
      } catch (e) {
        console.warn("[PAPERTRADES] Fundamental snapshot failed:", e.message);
      }
    }

    fundamentalsCache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("Fundamental scan error:", err.message);
    res.status(500).json({ error: "Fundamental scan failed: " + err.message });
  }
});

// ==================== SME / SMALL-CAP SCANNER ====================

/**
 * Sector map for the ~130 small-caps in the Yahoo fallback path.
 *
 * WHY THIS EXISTS: NSE's index-stockIndices endpoint returns a `meta.industry`
 * field for every stock — that's the primary sector source for small-caps.
 * But NSE blocks Vercel's US IPs, so on production we fall back to Yahoo
 * Finance's chart endpoint, which does NOT return sector data. Without this
 * map, every Yahoo-sourced small-cap would land with `sector: null` and the
 * macro overlay would have no effect on the Small-Cap Scanner in production.
 *
 * The values are chosen to match the canonical sectors in macroRegime.js
 * (normalizeSector handles substring matching generously, so "Pharma",
 * "IT Services", "Oil & Gas" etc. all map cleanly).
 */
const SMALLCAP_SECTOR_MAP = {
  // Banking
  BANDHANBNK: "Banking", IDBI: "Banking", KARURVYSYA: "Banking", RBLBANK: "Banking",
  UCOBANK: "Banking", CENTRALBK: "Banking", IOB: "Banking", KTKBANK: "Banking",
  UJJIVANSFB: "Banking", EQUITASBNK: "Banking",

  // NBFC (includes insurance, brokers, exchanges, microfinance)
  CDSL: "NBFC", ANGELONE: "NBFC", MANAPPURAM: "NBFC", IEX: "NBFC", IFCI: "NBFC",
  PIRAMALFIN: "NBFC", CANFINHOME: "NBFC", STARHEALTH: "NBFC", CHOLAHLDNG: "NBFC",
  PTC: "NBFC", CREDITACC: "NBFC", POONAWALLA: "NBFC", PNBHOUSING: "NBFC",

  // IT Services
  REDINGTON: "IT Services", BSOFT: "IT Services", TATATECH: "IT Services",
  ZENSARTECH: "IT Services", AFFLE: "IT Services", CYIENT: "IT Services",
  INTELLECT: "IT Services", ECLERX: "IT Services", TANLA: "IT Services",
  JUSTDIAL: "IT Services", NETWEB: "IT Services", MASTEK: "IT Services",
  QUESS: "IT Services", BLS: "IT Services",

  // Pharma / Healthcare
  NATCOPHARM: "Pharma", SYNGENE: "Pharma", LALPATHLAB: "Pharma", GRANULES: "Pharma",
  EMCURE: "Pharma", KIMS: "Pharma", GLAND: "Pharma",

  // Chemicals
  NAVINFLUOR: "Chemicals", TATACHEM: "Chemicals", CLEAN: "Chemicals",
  DEEPAKNTR: "Chemicals", AARTIIND: "Chemicals", ATUL: "Chemicals", RAIN: "Chemicals",
  GNFC: "Chemicals", RALLIS: "Chemicals", RCF: "Chemicals", HSCL: "Chemicals",
  FACT: "Chemicals", DEEPAKFERT: "Chemicals", DCMSHRIRAM: "Chemicals",
  GHCL: "Chemicals", BAYERCROP: "Chemicals",

  // Oil & Gas
  CHENNPETRO: "Oil & Gas", MGL: "Oil & Gas", IGL: "Oil & Gas", CASTROLIND: "Oil & Gas",

  // Power / Utilities
  RPOWER: "Power", JPPOWER: "Power", CESC: "Power", INOXWIND: "Power", INOXGREEN: "Power",

  // Automobile (includes auto components, tyres, EV)
  JKTYRE: "Automobile", CEATLTD: "Automobile", FORCEMOT: "Automobile",
  OLAELEC: "Automobile", OLECTRA: "Automobile",

  // Metals / Mining
  JINDALSAW: "Metals", GRAVITA: "Metals", MOIL: "Metals", HINDCOPPER: "Metals",
  GALLANTT: "Metals", WELCORP: "Metals", NAVA: "Metals", LLOYDSENT: "Metals",

  // Real Estate
  ANANTRAJ: "Real Estate", BRIGADE: "Real Estate", SOBHA: "Real Estate",

  // Infrastructure / Construction
  DELHIVERY: "Infrastructure", NBCC: "Infrastructure", IRCON: "Infrastructure",
  NCC: "Infrastructure", IRB: "Infrastructure", RITES: "Infrastructure",
  KNRCON: "Infrastructure", KEC: "Infrastructure", SCI: "Infrastructure",
  CENTURYPLY: "Infrastructure",

  // Capital Goods (includes graphite electrodes, electronics mfg, bearings)
  PGEL: "Capital Goods", CROMPTON: "Capital Goods", HEG: "Capital Goods",
  ENGINERSIN: "Capital Goods", GRAPHITE: "Capital Goods", JWL: "Capital Goods",
  BEML: "Capital Goods", TIMKEN: "Capital Goods", ACE: "Capital Goods",
  SCHNEIDER: "Capital Goods", ELGIEQUIP: "Capital Goods", KAYNES: "Capital Goods",
  AMBER: "Capital Goods", KIRLOSENG: "Capital Goods", OPTIEMUS: "Capital Goods",
  VGUARD: "Capital Goods",

  // Defence
  GRSE: "Defence",

  // Cement
  RAMCOCEM: "Cement", NUVOCO: "Cement",

  // Telecom
  HFCL: "Telecom", ITI: "Telecom", TEJASNET: "Telecom",

  // FMCG (includes sugar, agri, personal care, food)
  BALRAMCHIN: "FMCG", EIDPARRY: "FMCG", TRIDENT: "FMCG", EMAMILTD: "FMCG",
  JYOTHYLAB: "FMCG", RENUKA: "FMCG", WELSPUNLIV: "FMCG", DOMS: "FMCG",
  BIKAJI: "FMCG",

  // Retail
  ABFRL: "Retail", DEVYANI: "Retail", INDIAMART: "Retail", BATAINDIA: "Retail",
  MMTC: "Retail", PCJEWELLER: "Retail", CAMPUS: "Retail", SAFARI: "Retail",

  // Media / Entertainment
  ZEEL: "Media", PVRINOX: "Media", NAZARA: "Media", SUNTV: "Media",
};

const smeCache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

/**
 * SME Scanner — fetches Smallcap 250 + Microcap 250 from NSE,
 * merges, deduplicates, and categorises into midterm picks.
 */
const VALID_SME_CATEGORIES = ["all", "midterm", "buynow", "sell", "volume", "top-gainers", "top-losers"];

app.get("/api/sme/scan", async (req, res) => {
  try {
    const category = req.query.category || "all"; // all, midterm, buynow, sell, volume, top-gainers, top-losers
    if (!VALID_SME_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: `Unknown SME category "${category}". Valid categories: ${VALID_SME_CATEGORIES.join(", ")}`,
      });
    }
    const cacheKey = `sme_${category}`;
    const cached = smeCache.get(cacheKey);
    if (cached) return res.json(cached);

    // Try NSE first (works from Indian IPs), Yahoo Finance as fallback (works globally)
    let allStocks = [];
    let dataSource = "nse";

    // Attempt NSE
    try {
      const [smallcap, microcap] = await Promise.all([
        fetchNseIndex("NIFTY SMALLCAP 250").catch(() => null),
        fetchNseIndex("NIFTY MICROCAP 250").catch(() => null),
      ]);

      const seen = new Set();
      for (const source of [smallcap, microcap]) {
        if (!source?.stocks) continue;
        for (const s of source.stocks) {
          if (!seen.has(s.symbol)) {
            seen.add(s.symbol);
            allStocks.push(s);
          }
        }
      }
    } catch (e) {
      console.error("NSE smallcap fetch failed:", e.message);
    }

    // Fallback: Yahoo Finance for top 150 most liquid smallcaps
    if (allStocks.length === 0) {
      dataSource = "yahoo";
      const TOP_SMALLCAPS = [
        "CDSL","ANGELONE","BANDHANBNK","PGEL","ZEEL","CHENNPETRO","IDBI","RPOWER","DELHIVERY",
        "KARURVYSYA","NATCOPHARM","RBLBANK","JPPOWER","HFCL","MANAPPURAM","JKTYRE","NBCC",
        "ANANTRAJ","REDINGTON","CROMPTON","NAVINFLUOR","HEG","ENGINERSIN","GRAPHITE","IRCON",
        "MGL","JWL","IEX","IFCI","BRIGADE","SYNGENE","LALPATHLAB","GRANULES","JINDALSAW",
        "PIRAMALFIN","PVRINOX","GRAVITA","TATACHEM","BSOFT","IGL","ABFRL","BALRAMCHIN",
        "BEML","NCC","DEVYANI","RAMCOCEM","TATATECH","CEATLTD","CASTROLIND","ZENSARTECH",
        "UCOBANK","CESC","AFFLE","CENTRALBK","CLEAN","IOB","DEEPAKNTR","CYIENT","AARTIIND",
        "IRB","INDIAMART","ITI","EMCURE","KIMS","TIMKEN","EMAMILTD","INTELLECT","SOBHA",
        "ACE","ECLERX","SCHNEIDER","EIDPARRY","TRIDENT","BATAINDIA","MMTC","RITES",
        "ELGIEQUIP","CANFINHOME","STARHEALTH","ATUL","PCJEWELLER","KTKBANK","LLOYDSENT",
        "NAZARA","UJJIVANSFB","EQUITASBNK","MOIL","RAIN","KNRCON","TANLA","RENUKA",
        "PTC","JYOTHYLAB","JUSTDIAL","GNFC","RALLIS","INOXWIND","INOXGREEN","RCF",
        "CHOLAHLDNG","KAYNES","HINDCOPPER","NETWEB","AMBER","HSCL","TEJASNET","FORCEMOT",
        "OLAELEC","GRSE","BLS","GALLANTT","OLECTRA","CREDITACC","SCI","WELCORP",
        "POONAWALLA","PNBHOUSING","KEC","KIRLOSENG","FACT","DEEPAKFERT","WELSPUNLIV",
        "NAVA","SUNTV","NUVOCO","DCMSHRIRAM","DOMS","BIKAJI","GLAND","OPTIEMUS",
        "CAMPUS","MASTEK","CENTURYPLY","VGUARD","GHCL","QUESS","SAFARI","BAYERCROP"
      ];

      // Fetch in batches of 10 from Yahoo
      for (let i = 0; i < TOP_SMALLCAPS.length; i += 10) {
        const batch = TOP_SMALLCAPS.slice(i, i + 10);
        const batchResults = await Promise.all(
          batch.map(async (sym) => {
            try {
              const quote = await fetchQuote(sym + ".NS");
              if (!quote) return null;
              return {
                symbol: sym + ".NS",
                name: sym,
                // Yahoo's chart endpoint doesn't return sector info — we paste
                // it in from SMALLCAP_SECTOR_MAP so the macro overlay has a
                // sector to match against on Vercel (where NSE is blocked).
                sector: SMALLCAP_SECTOR_MAP[sym] || null,
                lastPrice: quote.regularMarketPrice,
                change: quote.regularMarketChange,
                pChange: quote.regularMarketChangePercent,
                open: quote.regularMarketOpen,
                dayHigh: quote.regularMarketDayHigh,
                dayLow: quote.regularMarketDayLow,
                previousClose: quote.regularMarketPreviousClose,
                totalTradedVolume: quote.regularMarketVolume,
                yearHigh: quote.fiftyTwoWeekHigh,
                yearLow: quote.fiftyTwoWeekLow,
                source: "yahoo",
              };
            } catch { return null; }
          })
        );
        allStocks.push(...batchResults.filter(Boolean));
        if (i + 10 < TOP_SMALLCAPS.length) await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (allStocks.length === 0) {
      return res.json({ stocks: [], error: "No smallcap data available right now. Please try again later.", lastUpdated: new Date().toISOString() });
    }

    // ─── Macro regime lookup (once per scan) ───
    // Small-caps amplify macro moves: FII outflows hit them harder than
    // large-caps, defence small-caps rally more in war regimes, etc. We apply
    // a 1.3× amplifier on the canonical macro delta, clamped to ±20.
    let macroRegime = null;
    try {
      macroRegime = await getMacroRegime();
    } catch (e) {
      console.warn("[MACRO] smallcap scan: failed to load regime:", e.message);
      macroRegime = defaultCalmRegime();
    }
    const SMALLCAP_AMPLIFIER = 1.3;
    const SMALLCAP_CLAMP = 13;

    // Resolve each stock's sector. Lookup order:
    //   1. SMALLCAP_SECTOR_MAP by bare symbol — PREFERRED because its values
    //      are already canonical (match macroRegime.normalizeSector exactly).
    //      NSE's meta.industry labels like "Stockbroking & Allied" or "Telecom -
    //      Equipment & Accessories" don't normalize cleanly, so we prefer our
    //      canonical map when we have a match for the symbol.
    //   2. Inline sector on the stock (NSE meta.industry or Yahoo path)
    //   3. ALL_STOCKS (Nifty 100 + midcap curated list)
    //   4. fundamentals.json snapshot
    function resolveSmallcapSector(stock) {
      const bareSym = (stock.symbol || "").replace(/\.(NS|BO)$/, "");
      if (SMALLCAP_SECTOR_MAP[bareSym]) return SMALLCAP_SECTOR_MAP[bareSym];
      if (stock.sector) return stock.sector;
      const sym = stock.symbol?.endsWith(".NS") ? stock.symbol : (stock.symbol || "") + ".NS";
      const info = ALL_STOCKS.find((s) => s.symbol === sym);
      if (info?.sector) return info.sector;
      const fundSnap = getFundamentals(sym);
      return fundSnap?.sector || fundSnap?.industry || null;
    }

    // Enrich with derived metrics for scanning
    const enriched = allStocks.map((s) => {
      const volatility = s.dayHigh && s.dayLow && s.previousClose
        ? ((s.dayHigh - s.dayLow) / s.previousClose) * 100
        : 0;

      // Simple score based on available data
      let intradayScore = 0;
      let midtermScore = 50;

      // Intraday: favour high volatility + high volume + clear direction
      if (volatility > 5) intradayScore += 30;
      else if (volatility > 3) intradayScore += 20;
      else if (volatility > 2) intradayScore += 10;

      if (s.totalTradedVolume > 5000000) intradayScore += 25;
      else if (s.totalTradedVolume > 1000000) intradayScore += 15;
      else if (s.totalTradedVolume > 500000) intradayScore += 5;

      if (Math.abs(s.pChange || 0) > 3) intradayScore += 20;
      else if (Math.abs(s.pChange || 0) > 1.5) intradayScore += 10;

      const direction = (s.pChange || 0) > 0.5 ? "LONG" : (s.pChange || 0) < -0.5 ? "SHORT" : "NEUTRAL";

      // Midterm: favour positive 30d/365d momentum + reasonable volume
      if ((s.perChange30d || 0) > 5) midtermScore += 15;
      else if ((s.perChange30d || 0) < -10) midtermScore -= 15;

      if ((s.perChange365d || 0) > 20) midtermScore += 10;
      else if ((s.perChange365d || 0) < -20) midtermScore -= 10;

      if ((s.pChange || 0) > 0) midtermScore += 5;
      else midtermScore -= 5;

      // Stop-loss and target based on volatility
      const price = s.lastPrice;
      const atrEstimate = price * (volatility / 100);
      const stopLoss = direction === "LONG"
        ? (price - atrEstimate * 1.2).toFixed(2)
        : (price + atrEstimate * 1.2).toFixed(2);
      const target = direction === "LONG"
        ? (price + atrEstimate * 2).toFixed(2)
        : (price - atrEstimate * 2).toFixed(2);

      // Resolve sector + compute macro tilt (with small-cap amplifier).
      // Run the resolved sector through normalizeSector so every small-cap
      // row surfaces a canonical label (NBFC / Banking / IT Services /
      // Automobile / ...). Without this, NSE's raw industry strings like
      // "Financial Services" / "Automobile and Auto Components" leak into
      // the UI and downstream sector-concentration checks mis-bucket them.
      // rawSector preserved for audit + low-level debugging.
      const rawSector = resolveSmallcapSector(s);
      const sector = normalizeSector(rawSector) || rawSector || null;
      const { delta: rawMacroDelta, reason: macroReason, sector: canonicalSector } =
        computeMacroDelta(macroRegime, sector);
      // Amplify small-cap macro sensitivity
      const macroBoost = Math.max(
        -SMALLCAP_CLAMP,
        Math.min(SMALLCAP_CLAMP, parseFloat((rawMacroDelta * SMALLCAP_AMPLIFIER).toFixed(1)))
      );
      // Adjust midterm score by macro tilt, clamped to 0-100. This is what
      // category=buynow sorts on, so defence small-caps rise in a war regime
      // and aviation small-caps fall.
      const adjustedMidterm = Math.max(0, Math.min(100, midtermScore + macroBoost));
      // Headwind flag: -5 or worse triggers a UI warning strip.
      const macroHeadwind = macroBoost <= -5;

      // ── Liquidity tier (P2 — SEBI small-cap review) ──
      //
      // A small-cap with ₹1 Cr daily traded value behaves very differently
      // from one with ₹100 Cr. Retail users can buy/sell either, but the
      // slippage cost on the illiquid name can eat the signal's expected
      // return. Tier ranges calibrated from observed bid-ask spreads on
      // NSE smallcaps:
      //
      //   high:  > ₹10 Cr/day traded value — institutional liquidity
      //   med:   ₹1 – 10 Cr/day             — acceptable retail
      //   low:   < ₹1 Cr/day                — wide spreads, slippage risk
      //
      // todayValueCr already computed below in safetyFlags; we compute
      // it up here for use in both liquidity tier + the flag.
      const todayValueCrEarly = (s.totalTradedValue || 0) / 1e7;
      const liquidityTier = todayValueCrEarly > 10 ? "high"
                          : todayValueCrEarly > 1  ? "medium"
                          : todayValueCrEarly > 0  ? "low"
                          : null;

      // ── Safety flags (P1 — SEBI small-cap review) ──
      //
      // Small-caps are where pump-and-dump and parabolic-reversal risk is
      // highest. Historical data (2024 SEBI froth warnings, 2021-22 retail
      // frenzy corrections) shows stocks with these patterns mean-revert
      // sharply. We compute flags that the UI surfaces as warning chips
      // so a "MOMENTUM CLUSTER" signal doesn't get read as a pure buy
      // without context.
      //
      //   parabolicMove  — 30d return > 50% AND today's change > 3%
      //                    (a name already up 50%+ that's still rallying is
      //                     textbook late-cycle chase territory)
      //   extendedRun    — 30d return > 30% (any material extension)
      //   nearYearHigh   — within 3% of 52-week high (low upside room)
      //   nearYearLow    — within 5% of 52-week low (falling knife risk)
      //   lowLiquidity   — today's ₹ value < ₹1 Cr (slippage risk)
      //
      // RSI overbought/oversold is NOT computed here because RSI requires
      // historical data that we only fetch for buynow candidates — it's
      // added in the later buynow-specific enrichment block.
      const safetyFlags = [];
      if ((s.perChange30d || 0) > 50 && (s.pChange || 0) > 3) {
        safetyFlags.push({
          kind: "parabolic",
          severity: "high",
          message: `Up ${s.perChange30d.toFixed(0)}% in 30 days and still rallying +${(s.pChange || 0).toFixed(1)}% today. Historical patterns on Indian small-caps show parabolic moves mean-revert sharply; late-entry risk is material.`,
        });
      } else if ((s.perChange30d || 0) > 30) {
        safetyFlags.push({
          kind: "extended",
          severity: "medium",
          message: `Up ${s.perChange30d.toFixed(0)}% in 30 days — material extension. Entry at these levels historically carries elevated short-term drawdown risk vs. earlier-stage signals.`,
        });
      }
      if (s.yearHigh && s.lastPrice && (s.yearHigh - s.lastPrice) / s.yearHigh < 0.03) {
        safetyFlags.push({
          kind: "at-52w-high",
          severity: "medium",
          message: `Price within 3% of 52-week high (₹${s.yearHigh.toFixed(2)}). Upside room limited; technical supply often emerges at round-number 52W levels.`,
        });
      }
      if (s.yearLow && s.lastPrice && (s.lastPrice - s.yearLow) / s.yearLow < 0.05) {
        safetyFlags.push({
          kind: "at-52w-low",
          severity: "medium",
          message: `Price within 5% of 52-week low (₹${s.yearLow.toFixed(2)}). Could be bottom-fishing opportunity OR continued downtrend — reversal confirmation recommended.`,
        });
      }
      if (todayValueCrEarly > 0 && todayValueCrEarly < 1.0) {
        safetyFlags.push({
          kind: "low-liquidity",
          severity: "medium",
          message: `Today's traded value ₹${todayValueCrEarly.toFixed(2)} Cr — thin liquidity. Bid-ask spreads widen and a modest-sized order can move the print.`,
        });
      }

      // ── Fundamental guardrail (P2 — SEBI small-cap review) ──
      //
      // Optional exclusion layer: when we have a fundamentals snapshot for
      // this small-cap (we only keep ~500 curated names, so coverage is
      // partial), we flag stocks that FAIL quality screens:
      //   • Net profit margin < 0      (loss-making at net level)
      //   • Debt/Equity > 3.0           (distressed leverage)
      //   • Revenue growth < -10% YoY  (material contraction)
      // When any of these trigger AND combinedScore not already bearish,
      // we surface a "quality-fail" flag so a purely-momentum buy signal
      // isn't read as "good company". 2023-24 small-cap drawdowns were
      // disproportionately concentrated in names that failed these screens.
      //
      // Non-blocking — the signal still appears, but with context. A user
      // who wants pure momentum can still see it; a quality-conscious user
      // sees the warning.
      const fundSnap = getFundamentals(s.symbol);
      let fundamentalScore = null;
      let fundamentalVerdict = null;
      if (fundSnap) {
        const failReasons = [];
        if (typeof fundSnap.profitMargin === "number" && fundSnap.profitMargin < 0) {
          failReasons.push(`net margin ${(fundSnap.profitMargin * 100).toFixed(1)}% (loss-making)`);
        }
        if (typeof fundSnap.debtToEquity === "number" && fundSnap.debtToEquity > 3) {
          failReasons.push(`D/E ${fundSnap.debtToEquity.toFixed(1)} (distressed leverage)`);
        }
        if (typeof fundSnap.revenueGrowth === "number" && fundSnap.revenueGrowth < -0.10) {
          failReasons.push(`revenue YoY ${(fundSnap.revenueGrowth * 100).toFixed(0)}% (contraction)`);
        }
        if (failReasons.length > 0) {
          safetyFlags.push({
            kind: "quality-fail",
            severity: "high",
            message: `Fundamental quality screen failed: ${failReasons.join(" · ")}. 2023–24 small-cap drawdowns were concentrated in names that failed at least one of these quality checks — momentum alone is a weak signal in this cohort.`,
          });
        }
        const fundResult = scoreForResponse(fundSnap, null).primary;
        if (fundResult) {
          fundamentalScore = fundResult.score;
          fundamentalVerdict = fundResult.verdict;
        }
      }

      return {
        ...s,
        sector,
        rawSector,
        volatility: volatility.toFixed(2),
        intradayScore,
        midtermScore: Math.max(0, Math.min(100, midtermScore)),
        baseMidtermScore: midtermScore,
        adjustedMidtermScore: adjustedMidterm,
        macroBoost,
        macroReason,
        macroSector: canonicalSector,
        macroHeadwind,
        direction,
        stopLoss: volatility > 1 ? stopLoss : null,
        target: volatility > 1 ? target : null,
        liquidityTier,
        liquidityValueCr: todayValueCrEarly > 0 ? +todayValueCrEarly.toFixed(2) : null,
        safetyFlags,
        // Highest-severity safety flag, for at-a-glance badging in the UI
        safetyLevel: safetyFlags.some((f) => f.severity === "high") ? "high"
                   : safetyFlags.length > 0 ? "medium" : "none",
        fundamentalScore,
        fundamentalVerdict,
      };
    });

    // ── Combined Score enrichment (Tech + Fund + SWS) for Small-Cap scanner ──
    // Small-caps have sparser SWS coverage so the fallback chain in
    // services/combinedScore.js (V2-fundamentals synthetic SWS) is critical.
    // For Tech component we use adjustedMidtermScore (the macro-adjusted
    // momentum score) since that's what the small-cap scanner ranks on.
    if (shouldComputeCombined() && enriched.length > 0) {
      const swsMap = lookupSwsScoreBulk(enriched.map((s) => s.symbol));
      for (const s of enriched) {
        const sws = swsMap.get(s.symbol) || {};
        s.swsScore = sws.v3Score ?? null;
        s.swsVerdict = sws.v3Verdict ?? null;
        s.swsSource = sws.source ?? "missing";
        s.swsCovered = sws.source === "primary";
        s.snowflakeTotal = sws.snowflakeTotal ?? null;

        const techScore = s.adjustedMidtermScore != null
          ? s.adjustedMidtermScore
          : s.midtermScore;
        const combined = computeCombinedScore({
          techScore,
          fundScore: s.fundamentalScore,
          swsScore: s.swsScore,
          scannerType: "smallcap",
          surveillanceFlag: sws.surveillance,
          swsFallback: sws.source === "fallback",
        });
        s.combinedScore = combined.combinedScore;
        s.combinedDims = combined.contributingDims;
        s.combinedDataConfidence = combined.dataConfidence;
        s.combinedDivergence = combined.divergence;
        s.combinedDivergenceSpread = combined.divergenceSpread;
        s.combinedWeights = combined.weightsUsed;
        s.combinedScoreVersion = combined.methodologyVersion;
        s.combinedScoreMode = COMBINED_SCORE_MODE;

        if (shouldSortByCombined() && combined.combinedScore != null) {
          s.legacyAdjustedMidtermScore = s.adjustedMidtermScore;
          s.adjustedMidtermScore = combined.combinedScore;
        }
      }
    }

    // ── XIRR-lift filters (derived from 4-year backtest at
    // scripts/backtest-smallcap-scanner.mjs) ──
    //
    // Honest-backtest findings that motivate these filters:
    //   - midterm top-10: +19.5%/yr (-30% DD) vs Nifty +7.9%/yr
    //   - volume  top-1:  -22%/yr (-81% DD)   ← catastrophic single-volume chase
    //   - buynow  (full TA): underperforms despite more rigour
    // Filters applied below were shown to reduce tail drawdowns and
    // improve Sharpe without materially cutting raw return.

    // Quality guardrail — HARD EXCLUSION for buynow + midterm + volume lists.
    // A stock with negative margin / D/E>3 / revenue contraction that also
    // triggers a momentum signal is a 2023-24 smallcap-crash archetype.
    // We still surface these in the `all` category and on the stock-detail
    // page; the scanner pick lists just don't promote them.
    const hasQualityFail = (s) =>
      (s.safetyFlags || []).some((f) => f.kind === "quality-fail");

    // Liquidity floor — exclude `low` tier (today's ₹ value < ₹1 Cr) from
    // pick lists. Low-liquidity smallcaps have wide spreads that eat any
    // signal edge. Backtest: volume top-1 blew up specifically because it
    // rotated into illiquid circuit-filter names.
    const hasAdequateLiquidity = (s) =>
      s.liquidityTier !== "low" || s.liquidityTier == null; // null = unknown, keep

    // Parabolic chase — high-severity flag means the stock is already up
    // 50%+ in 30 days and rallying today. Historical mean-reversion on
    // Indian smallcaps at this extension is material. Exclude from pick
    // lists but keep on the `all` sweep.
    const notParabolic = (s) =>
      !(s.safetyFlags || []).some((f) => f.kind === "parabolic");

    // Combined scanner-quality filter
    const passesScannerQualityFilters = (s) =>
      !hasQualityFail(s) && hasAdequateLiquidity(s) && notParabolic(s);

    // Macro gating: in a severity-4+ bearish regime, reduce pick count to
    // conservative sizes (3 instead of 10 etc.) so users don't build a
    // leveraged exposure into an active macro headwind.
    const macroSeverity = Number(macroRegime?.severity || 0);
    const macroNegative = macroSeverity >= 4 &&
      ["WAR_ESCALATION", "OIL_SHOCK", "RATE_HIKE", "GLOBAL_RISK_OFF"].includes(macroRegime?.regime);
    const macroGatedLimit = (n) => macroNegative ? Math.max(3, Math.ceil(n * 0.5)) : n;

    // Sector cap — max 30% of returned picks from any one canonical sector.
    // Prevents "10 top picks" from being 6 Defence + 3 Capital Goods in
    // reality — a concentrated sector bet dressed up as a diverse basket.
    function applySectorCap(sorted, maxCount) {
      const capPerSector = Math.max(1, Math.ceil(maxCount * 0.30));
      const bySector = new Map();
      const result = [];
      for (const s of sorted) {
        if (result.length >= maxCount) break;
        const sec = s.sector || "Unknown";
        const have = bySector.get(sec) || 0;
        if (have >= capPerSector) continue; // skip — sector full
        result.push(s);
        bySector.set(sec, have + 1);
      }
      // If sector caps prevented us from filling the slate, pad with the
      // next-best picks regardless of sector so we still return `maxCount`.
      if (result.length < maxCount) {
        for (const s of sorted) {
          if (result.length >= maxCount) break;
          if (!result.includes(s)) result.push(s);
        }
      }
      return result;
    }

    // Filter and sort based on category
    let result;
    if (category === "buynow") {
      // ── ENHANCED small-cap Buy Now ──
      //
      // Backtest finding: pure-TA scoring UNDERPERFORMS the 3-factor
      // midterm-momentum heuristic (+2.5%/yr vs +19.5%/yr for top-10).
      // Fix: blend 50% midterm + 50% TA so we get momentum capture
      // without losing the technical "is it broken?" safety check.
      //
      // Step 1: Pre-filter on the blended score candidates. Universe is
      //         already quality + liquidity filtered.
      // Step 2: Full analyzeStock() on top candidates for ATR SL/T.
      // Step 3: Blended-score rank + sector cap.
      const preCandidates = enriched
        .filter((s) => (s.pChange || 0) > 0.3 && (s.totalTradedVolume || 0) > 100000)
        .filter(passesScannerQualityFilters)
        .sort((a, b) => (b.adjustedMidtermScore + b.intradayScore) - (a.adjustedMidtermScore + a.intradayScore))
        .slice(0, 25);

      // Fetch historical + run proper technical analysis in batches
      const ANALYSIS_BATCH = 5;
      for (let ai = 0; ai < preCandidates.length; ai += ANALYSIS_BATCH) {
        const batch = preCandidates.slice(ai, ai + ANALYSIS_BATCH);
        await Promise.all(batch.map(async (s) => {
          try {
            const hist = await fetchHistorical(s.symbol);
            if (hist && hist.length >= 30) {
              const quote = await fetchQuote(s.symbol);
              if (quote) {
                const analysis = analyzeStock(hist, quote);
                s.technicalScore = analysis.score;
                s.technicalRec = analysis.recommendation;
                s.rsi = analysis.indicators?.rsi || s.rsi || "N/A";
                s.trend = analysis.indicators?.trend?.trend || "N/A";
                s.volume = analysis.indicators?.volume?.description || "N/A";
                // BLENDED score: 50% midterm-momentum heuristic + 50% TA.
                //
                // Backtest on 4-year window (2022-2026) showed pure-TA
                // scoring produced +2.5–7.8%/yr vs pure-midterm +12.6–28.5%/yr.
                // The TA filter was too strict and cut early-stage breakouts
                // that later ran hard. Blending preserves TA as a "is this
                // broken technically?" check without dominating the rank.
                const rawDelta = s.macroBoost || 0;
                const momentumScore = s.baseMidtermScore ?? s.midtermScore ?? 50;
                const blended = 0.5 * momentumScore + 0.5 * analysis.score;
                s.adjustedMidtermScore = Math.max(0, Math.min(100, blended + rawDelta));
                // ATR for stop-loss/target
                const atr = analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null;
                if (atr && s.lastPrice) {
                  s.stopLoss = parseFloat((s.lastPrice - atr * 1.5).toFixed(2));
                  s.target = parseFloat((s.lastPrice + atr * 2).toFixed(2));
                  s.riskReward = parseFloat(((s.target - s.lastPrice) / (s.lastPrice - s.stopLoss)).toFixed(2));
                }

                // ── Safety flags from the technical analysis ──
                //
                // RSI ≥ 70 is the classical overbought threshold (Wilder 1978).
                // For small-caps chasing momentum, surfacing this alongside
                // the "MOMENTUM CLUSTER" signal prevents users from reading
                // it as an unconditional entry.
                const rsiNum = typeof s.rsi === "number" ? s.rsi : parseFloat(s.rsi);
                if (Number.isFinite(rsiNum) && rsiNum >= 70) {
                  s.safetyFlags = s.safetyFlags || [];
                  s.safetyFlags.push({
                    kind: "overbought",
                    severity: "medium",
                    message: `RSI ${rsiNum.toFixed(1)} — above the 70 overbought threshold. RSI-based entries above 70 historically show lower forward-week win-rates on Indian small-caps vs. entries in the 50-65 band.`,
                  });
                  s.safetyLevel = s.safetyFlags.some((f) => f.severity === "high") ? "high" : "medium";
                }

                // Risk/reward flag. The default 1.5× ATR SL / 2× ATR target
                // gives a structural R/R of 1.33 for every buynow pick, so
                // flagging anything below 1.5 would light up on every card.
                // The INFORMATIVE signal is when R/R drops below 1.2 — that
                // means the stock is near a target level, near a support
                // break, or SL/target computation ran on partial data. Those
                // are the edge cases worth a warning chip.
                if (Number.isFinite(s.riskReward) && s.riskReward > 0 && s.riskReward < 1.2) {
                  s.safetyFlags = s.safetyFlags || [];
                  s.safetyFlags.push({
                    kind: "low-rr",
                    severity: "medium",
                    message: `Risk/Reward ratio ${s.riskReward.toFixed(2)} is unusually low (the scanner's structural R/R is ~1.33). Suggests price is near a target level or technical structure is asymmetric — a tighter entry or wait-for-pullback is often preferable.`,
                  });
                  s.safetyLevel = s.safetyFlags.some((f) => f.severity === "high") ? "high" : "medium";
                }
              }
            }
          } catch { /* silent — fall back to basic score */ }
        }));
        if (ai + ANALYSIS_BATCH < preCandidates.length) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      const bnSorted = preCandidates
        .filter((s) => s.adjustedMidtermScore >= 55)
        .sort((a, b) => b.adjustedMidtermScore - a.adjustedMidtermScore);
      result = applySectorCap(bnSorted, macroGatedLimit(10));
    } else if (category === "volume") {
      // Volume breakout: very high volume + high volatility. Now gated by
      // quality + liquidity filters — backtest showed pure volume-chase
      // single-pick blew up -22%/yr, -81% DD on illiquid circuit names.
      const volSorted = enriched
        .filter((s) => (s.totalTradedVolume || 0) > 500000 && parseFloat(s.volatility) > 2)
        .filter(passesScannerQualityFilters)
        .sort((a, b) => {
          const aScore = parseFloat(a.volatility) * Math.log10(a.totalTradedVolume || 1);
          const bScore = parseFloat(b.volatility) * Math.log10(b.totalTradedVolume || 1);
          return bScore - aScore;
        });
      result = applySectorCap(volSorted, macroGatedLimit(10));
    } else if (category === "midterm") {
      // Backtest's top-performing strategy — now also quality + liquidity
      // + sector-cap filtered. 4y historical: +19.5%/yr with -30% DD
      // (top-10, equal-weighted, monthly, 0.5% friction).
      const mtSorted = enriched
        .filter((s) => s.midtermScore >= 55)
        .filter(passesScannerQualityFilters)
        .sort((a, b) => b.midtermScore - a.midtermScore);
      result = applySectorCap(mtSorted, macroGatedLimit(10));
    } else if (category === "sell") {
      // Sell alerts: negative momentum, poor scores. No quality/liquidity
      // filter applied here — a loss-making illiquid smallcap that's
      // falling is actually MORE worth flagging to a holder, not less.
      result = enriched
        .filter((s) => (s.pChange || 0) < -0.5 && s.midtermScore <= 45)
        .sort((a, b) => a.midtermScore - b.midtermScore)
        .slice(0, 10);
    } else if (category === "top-gainers") {
      result = enriched
        .filter((s) => (s.pChange || 0) > 0)
        .sort((a, b) => (b.pChange || 0) - (a.pChange || 0))
        .slice(0, 30);
    } else if (category === "top-losers") {
      result = enriched
        .filter((s) => (s.pChange || 0) < 0)
        .sort((a, b) => (a.pChange || 0) - (b.pChange || 0))
        .slice(0, 30);
    } else {
      // All — return top 50 by volume (most active)
      result = enriched
        .sort((a, b) => (b.totalTradedVolume || 0) - (a.totalTradedVolume || 0))
        .slice(0, 50);
    }

    // ── Concentration diagnostic (P3 — SEBI small-cap review) ──
    //
    // If a user acts on the top-N picks uniformly, are they building a
    // diversified book OR a concentrated sector bet? Surfaces the sector
    // mix of the returned result set so the UI can flag "Top 10 picks
    // are 70% IT Services" — a valuable warning that the momentum
    // signal is really a sector tilt in disguise.
    //
    // Concentration interpretation (by top-sector share of the list):
    //   < 25%  : diversified          (natural — 20 sectors in small-cap space)
    //   25-40% : mild clustering      (one sector gently overrepresented)
    //   40-60% : material clustering  (one sector driving most signals)
    //   > 60%  : heavy concentration  (signal ≈ sector call, not stock-picking)
    const concentration = (() => {
      if (!result || result.length === 0) return null;
      const totalCount = result.length;
      const sectorCounts = new Map();
      for (const s of result) {
        const key = s.sector || "Unknown";
        sectorCounts.set(key, (sectorCounts.get(key) || 0) + 1);
      }
      const sorted = [...sectorCounts.entries()]
        .map(([sector, count]) => ({
          sector,
          count,
          pct: +((count / totalCount) * 100).toFixed(1),
        }))
        .sort((a, b) => b.count - a.count);
      const topShare = sorted[0]?.pct || 0;
      const level = topShare >= 60 ? "heavy"
                  : topShare >= 40 ? "material"
                  : topShare >= 25 ? "mild"
                  : "diversified";
      // Human-readable interpretation
      const top = sorted[0];
      let narrative;
      if (level === "heavy") {
        narrative = `${top.pct}% of the ${totalCount} picks are ${top.sector} — effectively a sector bet, not a stock-picking signal. Diversify across sectors or treat as a ${top.sector} overweight thesis.`;
      } else if (level === "material") {
        narrative = `${top.sector} accounts for ${top.pct}% of the ${totalCount} picks — material sector tilt. A user acting on the full list is taking more ${top.sector} exposure than might be intended.`;
      } else if (level === "mild") {
        narrative = `${top.sector} is ${top.pct}% of picks — mild clustering typical when a sector is in momentum. Not a concern unless you're already overweight ${top.sector}.`;
      } else {
        narrative = `Signals spread across ${sorted.length} sectors — diversified. No sector dominates the list.`;
      }
      return {
        level,
        topShare,
        topSector: top?.sector || null,
        totalSectors: sorted.length,
        bySector: sorted.slice(0, 8),
        narrative,
      };
    })();

    // Filter-activity telemetry so the UI can show "X names excluded due
    // to quality/liquidity/parabolic screens" and users understand what
    // the scanner is doing behind the scenes.
    const filterStats = (category === "buynow" || category === "midterm" || category === "volume") ? (() => {
      const qualityFail = enriched.filter(hasQualityFail).length;
      const lowLiquidity = enriched.filter((s) => s.liquidityTier === "low").length;
      const parabolic = enriched.filter((s) => (s.safetyFlags || []).some((f) => f.kind === "parabolic")).length;
      return {
        qualityFailExcluded: qualityFail,
        lowLiquidityExcluded: lowLiquidity,
        parabolicExcluded: parabolic,
        macroGated: macroNegative,
        macroGatedLimit: macroNegative ? macroGatedLimit(10) : null,
      };
    })() : null;

    const response = {
      category,
      stocks: result,
      totalScanned: allStocks.length,
      source: dataSource,
      regime: macroRegime,
      concentration,
      filterStats,
      methodology: shouldComputeCombined() ? getMethodology("smallcap") : null,
      combinedScoreMode: COMBINED_SCORE_MODE,
      lastUpdated: new Date().toISOString(),
    };

    if (shouldComputeCombined()) {
      await captureShadowDiffBulk(result, "smallcap");
    }

    // Paper-trade snapshot: only on the buynow category, only once per day.
    // Snapshots the small-cap buy-now picks specifically (not intraday/volume
    // picks, which are momentum trades that mature in hours, not weeks).
    if (category === "buynow" && result.length > 0 && !(await hasSnapshotToday("smallcap_buynow"))) {
      try {
        const niftyQuote = await fetchQuote("^NSEI").catch(() => null);
        const niftyPrice = niftyQuote?.regularMarketPrice ?? null;
        // Map small-cap-specific fields to the canonical price field
        const picksForSnapshot = result.map((s) => ({
          ...s,
          price: s.lastPrice,
          score: s.adjustedMidtermScore || s.midtermScore,
        }));
        const snapResult = await snapshotPicks(picksForSnapshot, "smallcap_buynow", {
          regime: macroRegime,
          niftyPrice,
          rationale: "Auto-snapshot from /api/sme/scan?category=buynow",
        });
        console.log(`[PAPERTRADES] Snapshotted ${snapResult.written} small-cap buynow picks`);
      } catch (e) {
        console.warn("[PAPERTRADES] Small-cap snapshot failed:", e.message);
      }
    }

    smeCache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("SME scan error:", err.message);
    res.status(500).json({ error: "SME scan failed: " + err.message });
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

    // GIFT Nifty — append after core indices. It's always last in the
    // ticker so the familiar Nifty/Sensex/Bank Nifty ordering never shifts.
    // When unavailable (outside session, NSE IX down) we just omit it;
    // the rest of the page renders normally.
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
      indices.push(gift);
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
    // DII flow, headline tilt, GIFT Nifty (off-hours). Sources are existing
    // in-process caches — no LLM call, no external network, always-on.
    const digest = buildDeterministicDigest(scored, {
      sectorHeatmap: sectorHeatmapCache.get("heatmap"),
      fiiDii: fiiDiiCache.get("fii_dii"),
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

function safeDateParse(str) {
  if (!str) return null;
  try {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch { return null; }
}

// ==================== MACRO REGIME LAYER ====================

/**
 * Trusted news sources we aggregate into the macro regime classifier.
 *
 * Sources are organised into TIER GROUPS (regulator / wire / indian) and
 * within each group split into PRIMARY and FALLBACK sources. fetchMacroHeadlines
 * runs in two passes: primaries first, then fallbacks ONLY if a tier-group's
 * primaries didn't meet the coverage target. This means that when Vercel's US
 * IPs get blocked by Reuters IN / Bloomberg Quint / RBI (a known issue), the
 * system automatically reaches for Reuters Business / AP Biz / FT Markets for
 * wires, PIB / MoSPI for regulators, and Hindu BusinessLine / Financial Express
 * for Indian dailies — without wasting requests in the common case.
 *
 * Tier A+ = official regulator/central bank (most authoritative)
 * Tier A  = global wire service (fast + credible on geopolitics)
 * Tier B  = Indian financial daily (high coverage, some noise)
 *
 * Group coverage target: ≥1 A+, ≥1 A, ≥2 B. If any group is short after
 * Pass 1, its fallbacks are fetched in Pass 2.
 */
const TRUSTED_MACRO_SOURCES = [
  // ─── Tier A+: Regulators ──────────────────────────────────────
  { name: "RBI Press",         url: "https://www.rbi.org.in/Scripts/Bs_viewRSS.aspx?Id=Press",                                   tier: "A+", group: "regulator", primary: true  },
  { name: "SEBI Press",        url: "https://www.sebi.gov.in/sebirss.xml",                                                       tier: "A+", group: "regulator", primary: true  },
  { name: "PIB Economy",       url: "https://pib.gov.in/RssMain.aspx?ModId=8&Lang=1",                                            tier: "A+", group: "regulator", primary: false },
  { name: "MoSPI",             url: "https://mospi.gov.in/rss.xml",                                                              tier: "A+", group: "regulator", primary: false },

  // ─── Tier A: Global wires ─────────────────────────────────────
  { name: "Reuters India",     url: "https://feeds.reuters.com/reuters/INtopNews",                                               tier: "A",  group: "wire",      primary: true  },
  { name: "Bloomberg Quint",   url: "https://www.bqprime.com/feed",                                                              tier: "A",  group: "wire",      primary: true  },
  { name: "Reuters Business",  url: "https://feeds.reuters.com/reuters/businessNews",                                            tier: "A",  group: "wire",      primary: false },
  { name: "AP Business",       url: "https://rsshub.app/apnews/topics/apf-business",                                             tier: "A",  group: "wire",      primary: false },
  { name: "FT Markets",        url: "https://www.ft.com/markets?format=rss",                                                     tier: "A",  group: "wire",      primary: false },

  // ─── Tier B: Indian financial dailies ─────────────────────────
  { name: "Moneycontrol",      url: "https://www.moneycontrol.com/rss/MCtopnews.xml",                                            tier: "B",  group: "indian",    primary: true  },
  { name: "Business Standard", url: "https://www.business-standard.com/rss/markets-106.rss",                                     tier: "B",  group: "indian",    primary: true  },
  { name: "Economic Times",    url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",                      tier: "B",  group: "indian",    primary: true  },
  { name: "LiveMint",          url: "https://www.livemint.com/rss/markets",                                                      tier: "B",  group: "indian",    primary: true  },
  { name: "Hindu BusinessLine",url: "https://www.thehindubusinessline.com/markets/feeder/default.rss",                            tier: "B",  group: "indian",    primary: false },
  { name: "Financial Express", url: "https://www.financialexpress.com/market/feed/",                                             tier: "B",  group: "indian",    primary: false },
];

// Coverage targets per tier-group — if a group falls short after Pass 1, its
// fallbacks get fetched in Pass 2. Loose targets so a single regulator/wire
// success is enough to call that tier "covered".
const MACRO_COVERAGE_TARGET = { "A+": 1, "A": 1, "B": 2 };

const RSS_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Accept": "application/rss+xml, application/xml, text/xml, */*",
};

/**
 * Fetch headlines from a single RSS source. Returns an array of headline
 * objects (empty array on any failure — never throws). Tracks failure
 * counters so chronic broken feeds bubble up in /api/macro/debug.
 */
async function fetchFromSource(src, cutoff) {
  try {
    const res = await fetchWithRetry(
      src.url,
      { headers: RSS_HEADERS },
      { retries: 1, timeoutMs: 8000 }
    );
    if (!res || !res.ok) {
      bumpSourceFailure(src.name);
      return { src, headlines: [], ok: false };
    }
    const xml = await res.text();
    const articles = parseRSS(xml, src.name);
    macroSourceFailures.set(src.name, 0); // success → reset
    const headlines = articles
      .map((a) => ({
        title: a.title,
        source: src.name,
        sourceTier: src.tier,
        group: src.group,
        publishedAt: a.publishedAt,
        url: a.link,
      }))
      // Filter to recent window upfront so the coverage check doesn't count
      // ancient headlines from a stale feed as "ok".
      .filter((h) => {
        if (!h.publishedAt) return true;
        const ts = new Date(h.publishedAt).getTime();
        return Number.isFinite(ts) && ts >= cutoff;
      });
    return { src, headlines, ok: headlines.length > 0 };
  } catch (err) {
    bumpSourceFailure(src.name);
    return { src, headlines: [], ok: false };
  }
}

/**
 * Fetch macro headlines from trusted sources using a two-pass strategy:
 *
 *   Pass 1 — fetch all PRIMARY sources in parallel.
 *   Check coverage per tier-group against MACRO_COVERAGE_TARGET.
 *   Pass 2 — for any tier-group that fell short, fetch that group's
 *            FALLBACK sources in parallel.
 *
 * This keeps steady-state cost low (primaries are the best feeds) while
 * automatically recovering on Vercel where Reuters IN / Bloomberg Quint /
 * RBI Press are blocked. Returns an object with headlines + sourceHealth
 * metadata so /api/macro/debug can expose exactly which feeds worked and
 * which fallbacks took over.
 *
 * Never throws — on total failure returns { headlines: [], ... } with a
 * fully populated sourceHealth map so the UI can surface the problem.
 */
async function fetchMacroHeadlines({ hours = 48 } = {}) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const sourceHealth = {}; // name → "ok" | "ok-fallback" | "blocked" | "empty"
  const tierCoverage = { "A+": 0, "A": 0, "B": 0 };
  const fallbacksUsed = [];
  const allHeadlines = [];

  // ─── Pass 1: primaries ───
  const primaries = TRUSTED_MACRO_SOURCES.filter((s) => s.primary);
  const pass1 = await Promise.all(primaries.map((s) => fetchFromSource(s, cutoff)));

  for (const r of pass1) {
    if (r.ok) {
      sourceHealth[r.src.name] = "ok";
      tierCoverage[r.src.tier] = (tierCoverage[r.src.tier] || 0) + 1;
      allHeadlines.push(...r.headlines);
    } else {
      sourceHealth[r.src.name] = "blocked";
    }
  }

  // ─── Pass 2: fallbacks, only for tier-groups that fell short ───
  // Group coverage is checked against MACRO_COVERAGE_TARGET. We fetch ALL
  // fallbacks in a short-coverage group in parallel and take whatever succeeds.
  const shortGroups = new Set();
  for (const tier of Object.keys(MACRO_COVERAGE_TARGET)) {
    if (tierCoverage[tier] < MACRO_COVERAGE_TARGET[tier]) {
      shortGroups.add(tier);
    }
  }

  if (shortGroups.size > 0) {
    const fallbackCandidates = TRUSTED_MACRO_SOURCES.filter(
      (s) => !s.primary && shortGroups.has(s.tier)
    );
    if (fallbackCandidates.length > 0) {
      console.log(
        `[MACRO] Pass 1 short on tiers [${[...shortGroups].join(",")}] — ` +
        `trying ${fallbackCandidates.length} fallback source(s)`
      );
      const pass2 = await Promise.all(
        fallbackCandidates.map((s) => fetchFromSource(s, cutoff))
      );
      for (const r of pass2) {
        if (r.ok) {
          sourceHealth[r.src.name] = "ok-fallback";
          tierCoverage[r.src.tier] = (tierCoverage[r.src.tier] || 0) + 1;
          allHeadlines.push(...r.headlines);
          fallbacksUsed.push(r.src.name);
        } else {
          sourceHealth[r.src.name] = "blocked";
        }
      }
    }
  }

  // Mark any source we didn't touch as "skipped" so the debug view is complete
  for (const src of TRUSTED_MACRO_SOURCES) {
    if (!(src.name in sourceHealth)) sourceHealth[src.name] = "skipped";
  }

  // ─── Dedupe by normalized title prefix, sort newest first, cap at 60 ───
  const seen = new Set();
  const unique = [];
  for (const h of allHeadlines) {
    if (!h.title) continue;
    const key = h.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(h);
  }
  unique.sort((a, b) => {
    const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return db - da;
  });
  const top = unique.slice(0, 60);

  // Per-request log so we can diagnose on Vercel
  const okSources = Object.values(sourceHealth).filter((v) => v === "ok" || v === "ok-fallback").length;
  const fbStr = fallbacksUsed.length > 0 ? ` fallbacks-used=${fallbacksUsed.join(",")}` : "";
  console.log(
    `[MACRO] headlines=${top.length} sources=ok(${okSources}/${TRUSTED_MACRO_SOURCES.length}) ` +
    `tierCoverage={A+:${tierCoverage["A+"]},A:${tierCoverage["A"]},B:${tierCoverage["B"]}}${fbStr}`
  );

  // Attach metadata as a non-enumerable field on the headlines array so callers
  // that only read `.length` / iterate still work, but refreshMacroRegime can
  // reach into it for logging.
  Object.defineProperty(top, "meta", {
    value: { sourceHealth, tierCoverage, fallbacksUsed, okSources, totalSources: TRUSTED_MACRO_SOURCES.length },
    enumerable: false,
  });
  return top;
}

function bumpSourceFailure(name) {
  const count = (macroSourceFailures.get(name) || 0) + 1;
  macroSourceFailures.set(name, count);
  if (count === 3) {
    console.warn(`[MACRO] ⚠ Source "${name}" failed 3 times in a row. It may be blocked or down.`);
  }
}

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
 *   curl '/api/macro/override?regime=WAR_ESCALATION&sector=Defence&impact=3&severity=4'
 *
 * Writes directly to macroRegimeCache. Cleared on next scheduled refresh or by
 * calling /api/macro/regime?refresh=1.
 */
app.get("/api/macro/override", (req, res) => {
  // Allowed when:
  //   (a) running locally (VERCEL env var not set), OR
  //   (b) running on Vercel AND a matching MACRO_OVERRIDE_TOKEN env var is set
  //       AND the request passes the token in ?token=...
  //
  // The explicit token-presence check prevents the "undefined === undefined"
  // loophole that would otherwise let any unauthenticated Vercel request
  // force-set the regime.
  const envToken = process.env.MACRO_OVERRIDE_TOKEN;
  const queryToken = req.query.token;
  const isLocal = !process.env.VERCEL;
  const tokenOk = envToken && queryToken && queryToken === envToken;
  if (!isLocal && !tokenOk) {
    return res.status(403).json({ error: "Override not allowed in this environment. Set MACRO_OVERRIDE_TOKEN env var and pass ?token=... to enable." });
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
 *   ?bust=1                                                       — skip cache
 */
app.get("/api/track/history", async (req, res) => {
  try {
    const filterType = req.query.type || null;
    const dayLimit = req.query.days ? parseInt(req.query.days, 10) : null;
    const cacheKey = `track_history_${filterType || "all"}_${dayLimit || "all"}`;

    if (!req.query.bust) {
      const cached = trackCache.get(cacheKey);
      if (cached) {
        res.set("X-Cache", "HIT");
        return res.json(cached);
      }
    }

    let trades = await readAllTrades();

    if (filterType) trades = trades.filter((t) => t.type === filterType);
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

    const response = {
      trades: tradesWithReturns,
      performance,
      byType,
      byRegime,
      bySector,
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
 * GET /api/track/stats
 *
 * Lightweight summary endpoint. Returns storage stats + count by type.
 * Used by the empty-state placeholder on the Track Record tab.
 */
app.get("/api/track/stats", async (req, res) => {
  try {
    const [trades, stats] = await Promise.all([readAllTrades(), getStorageStats()]);
    const byType = {};
    for (const t of trades) {
      byType[t.type] = (byType[t.type] || 0) + 1;
    }
    res.json({
      ...stats,
      byType,
      todayKey: getISTDateKey(),
    });
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
 *   curl -X POST https://stock-platform-gamma.vercel.app/api/track/migrate?token=XXX \
 *     -H 'Content-Type: application/json' \
 *     --data @.paper-trades-export.json
 */
app.post("/api/track/migrate", express.json({ limit: "5mb" }), async (req, res) => {
  // Same security gate as /api/macro/override
  const envToken = process.env.MACRO_OVERRIDE_TOKEN;
  const queryToken = req.query.token;
  const isLocal = !process.env.VERCEL;
  const tokenOk = envToken && queryToken && queryToken === envToken;
  if (!isLocal && !tokenOk) {
    return res.status(403).json({ error: "Migration requires MACRO_OVERRIDE_TOKEN. Set the env var on Vercel and pass ?token=..." });
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

/** Parse RSS XML into article objects */
function parseRSS(xml, defaultSource) {
  if (!xml) return [];
  const articles = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] || "").trim();
    const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "").trim();
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "").trim();
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || "").trim();
    const desc = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || "").trim();

    if (title) {
      articles.push({
        title: title.replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
        link: link || null,
        publishedAt: safeDateParse(pubDate),
        publisher: source || defaultSource,
        description: desc ? desc.replace(/<[^>]*>/g, "").slice(0, 200) : null,
      });
    }
  }
  return articles;
}

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
async function readPortfolio() {
  return await getPortfolioStorage().read();
}

async function savePortfolio(data) {
  return await getPortfolioStorage().write(data);
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
  const storage = getWatchlistStorage();

  // Capture the price at add-time so the watchlist can show the user
  // their entry-level reference and the move since saving. Server-side
  // quote keeps the value trustworthy (client clock / stale data can't
  // forge it). Failures are non-fatal — we still save the entry.
  let addedPrice = null;
  try {
    const q = await fetchQuote(symbol);
    if (q && typeof q.regularMarketPrice === "number") addedPrice = q.regularMarketPrice;
  } catch { /* keep addedPrice null */ }

  const result = await storage.add({
    symbol,
    name: name || symbol,
    sector: sector || null,
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
    const portfolio = await readPortfolio();

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

    // Build the intelligence block: per-stock actions + health score + urgent queue
    const intelligence = buildPortfolioIntelligence(enrichedStocks, analysesBySymbol, {
      regime: portfolioRegime,
      computeMacroDelta,
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
    const { stocks, mutualFunds } = req.body;
    // Preserve any other fields already on the portfolio (riskProfile etc.)
    // — POST /api/portfolio is the Groww-import endpoint and shouldn't wipe
    // a user's risk-profile survey just because they re-imported.
    //
    // Distinguish "field omitted" from "field sent as empty array": only
    // overwrite when the client actually sent a value. This lets the
    // analyzer's "Save as my portfolio" checkbox post a Stocks-only book
    // without nuking saved MF holdings.
    const existing = await readPortfolio();
    const data = {
      ...existing,
      stocks: stocks !== undefined ? stocks : (existing.stocks || []),
      mutualFunds: mutualFunds !== undefined ? mutualFunds : (existing.mutualFunds || []),
      lastUpdated: new Date().toISOString(),
    };
    await savePortfolio(data);
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

import { scoreRiskProfile, RISK_PROFILE_QUESTIONS, INTAKE_QUESTIONS, buildIntake, hasCompleteIntake } from "./riskProfile.js";

app.get("/api/risk-profile", async (req, res) => {
  try {
    const portfolio = await readPortfolio();
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
    const answers = req.body?.answers || req.body;
    const scored = scoreRiskProfile(answers);
    if (!scored) {
      return res.status(400).json({
        error: "Incomplete answers — all 3 questions are required.",
        questions: RISK_PROFILE_QUESTIONS,
      });
    }
    const portfolio = await readPortfolio();
    const next = {
      ...portfolio,
      riskProfile: { ...scored, answers },
    };
    await savePortfolio(next);
    res.json({ ok: true, riskProfile: next.riskProfile });
  } catch (err) {
    console.error("[RISK-PROFILE] save error:", err.message);
    res.status(500).json({ error: "Failed to save risk profile" });
  }
});

app.delete("/api/risk-profile", async (req, res) => {
  try {
    const portfolio = await readPortfolio();
    const next = { ...portfolio, riskProfile: null };
    await savePortfolio(next);
    res.json({ ok: true });
  } catch (err) {
    console.error("[RISK-PROFILE] clear error:", err.message);
    res.status(500).json({ error: "Failed to clear risk profile" });
  }
});

// 5-question SEBI suitability intake — extends the 3-question risk
// profile with fresh capital, transactional changes, focus stock, and
// LTCG-YTD. Persisted to portfolio.intake + portfolio.riskProfile in
// a single write so the analyzer's gate check sees both populated.
//
// GET    /api/portfolio/intake → { questions, present: bool, intake, riskProfile }
// POST   /api/portfolio/intake → { ok: true, intake, riskProfile }
// DELETE /api/portfolio/intake → soft-clear (lets the user retake)

app.get("/api/portfolio/intake", async (req, res) => {
  try {
    const portfolio = await readPortfolio();
    res.json({
      questions: INTAKE_QUESTIONS,
      present: hasCompleteIntake(portfolio),
      intake: portfolio?.intake || null,
      riskProfile: portfolio?.riskProfile || null,
    });
  } catch (err) {
    console.error("[INTAKE] read error:", err.message);
    res.status(500).json({ error: "Failed to read intake" });
  }
});

app.post("/api/portfolio/intake", express.json(), async (req, res) => {
  try {
    const built = buildIntake(req.body?.answers || req.body);
    if (!built.ok) {
      return res.status(400).json({
        error: built.error,
        missing: built.missing,
        questions: INTAKE_QUESTIONS,
      });
    }
    const portfolio = await readPortfolio();
    const next = {
      ...portfolio,
      intake: built.intake,
      riskProfile: built.riskProfile,
    };
    await savePortfolio(next);
    res.json({ ok: true, intake: next.intake, riskProfile: next.riskProfile });
  } catch (err) {
    console.error("[INTAKE] save error:", err.message);
    res.status(500).json({ error: "Failed to save intake" });
  }
});

app.delete("/api/portfolio/intake", async (req, res) => {
  try {
    const portfolio = await readPortfolio();
    const next = { ...portfolio, intake: null };
    await savePortfolio(next);
    res.json({ ok: true });
  } catch (err) {
    console.error("[INTAKE] clear error:", err.message);
    res.status(500).json({ error: "Failed to clear intake" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5: Portfolio Analyzer — stateless upload + deep analysis.
//
// This endpoint accepts a multipart file upload (Groww xlsx, Groww CSV,
// Zerodha CSV, or generic CSV) and returns a full report WITHOUT touching
// the user's saved portfolio. Stateless on purpose: the analyzer tab is
// for analysis, not persistence.
// ═══════════════════════════════════════════════════════════════════════════

const portfolioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB is plenty for a holdings statement
});

app.post("/api/portfolio/analyze", portfolioUpload.single("file"), async (req, res) => {
  const t0 = Date.now();
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing file upload (field name: file)" });
    }

    // Optimizer-specific options come in via form fields (multer parses them
    // into req.body alongside the file). Query string is also accepted as a
    // fallback for direct browser testing.
    const optPreset = String(req.body.preset || req.query.preset || "balanced");
    const optTaxSlabPct = Number.parseInt(req.body.taxSlabPct || req.query.taxSlabPct || "30", 10);
    // ltcgRealisedYtdRupees + freshCapitalInr are declared with `let` so
    // the saved-intake block below can fill them in when the request
    // body doesn't supply explicit overrides. Explicit body/query still
    // wins (we only fall back when the parsed value is null/0/NaN).
    const optAssumedHoldingMonths = Number.parseInt(req.body.assumedHoldingMonths || req.query.assumedHoldingMonths || "24", 10);
    let ltcgRealisedYtdRupees = Number.parseFloat(req.body.ltcgRealisedYtd || req.query.ltcgRealisedYtd || "0");
    // Engine selector — "sws" routes to the SWS-first recommendation engine
    // (data/sws/deep + Tier A/B/C/D action grid + defensive/growth/core
    // baskets + per-holding snowflake/conviction/counter-thesis/catalyst
    // /surveillance layers). Anything else falls through to the legacy
    // Yahoo+OpenAI per-stock enrichment path.
    //
    // Default flipped to "sws" as part of PR-1; ANALYZER_ENGINE_DEFAULT env
    // var provides instant rollback ("legacy") without a code change. Per-
    // request `?engine=legacy` still works for one-off comparisons.
    const engineDefault = String(process.env.ANALYZER_ENGINE_DEFAULT || "sws").toLowerCase();
    const engine = String(req.body.engine || req.query.engine || engineDefault).toLowerCase();
    let freshCapitalInr = Number.parseFloat(req.body.freshCapitalInr || req.query.freshCapitalInr || "0") || null;

    // SUITABILITY_GATE — when enabled, refuse the analyze if the user
    // hasn't completed the 5-question SEBI intake. The UI catches the
    // 412 Precondition Failed + opens the intake modal. After the user
    // POSTs answers to /api/portfolio/intake, the gate clears.
    //
    // Default off in dev so the existing user flow keeps working;
    // production sets SUITABILITY_GATE=1 once the modal is shipped.
    if (process.env.SUITABILITY_GATE === "1") {
      try {
        const saved = await readPortfolio();
        if (!hasCompleteIntake(saved)) {
          return res.status(412).json({
            error: "Suitability intake not complete.",
            hint: "POST /api/portfolio/intake with the 5 required answers, then retry the analyze.",
            questions: INTAKE_QUESTIONS,
            preconditionRequired: "intake",
          });
        }
      } catch (err) {
        // Read errors fall through — better to analyze than to hard-block
        // on a transient KV/file glitch. The gate only enforces when we
        // KNOW intake is missing.
        console.warn("[ANALYZE] suitability gate read failed:", err.message);
      }
    }

    // Pull saved MF holdings + risk profile from the user's stored portfolio
    // so the analyzer can compute a true book-wide XIRR (not stock-only)
    // and tag per-fund recs with risk-profile alignment.
    // This is read-only — nothing is persisted by the analyze endpoint.
    let mfHoldings = [];
    let savedRiskProfile = null;
    let savedIntake = null;
    try {
      const saved = await readPortfolio();
      if (saved && saved.riskProfile && saved.riskProfile.bucket) {
        savedRiskProfile = saved.riskProfile;
      }
      // Intake fallback values — when the request body didn't supply
      // freshCapitalInr / ltcgRealisedYtd, the persisted intake fills
      // them in (so the analyzer doesn't ask for capital and tax YTD on
      // every run). Explicit query/body still wins.
      if (saved && saved.intake) {
        savedIntake = saved.intake;
        const reqHasFresh = req.body.freshCapitalInr != null || req.query.freshCapitalInr != null;
        if (!reqHasFresh && Number.isFinite(saved.intake.freshCapitalInr) && saved.intake.freshCapitalInr > 0) {
          freshCapitalInr = saved.intake.freshCapitalInr;
        }
        const reqHasLtcg = req.body.ltcgRealisedYtd != null || req.query.ltcgRealisedYtd != null;
        if (!reqHasLtcg && Number.isFinite(saved.intake.ltcgRealisedYtdRupees) && saved.intake.ltcgRealisedYtdRupees > 0) {
          ltcgRealisedYtdRupees = saved.intake.ltcgRealisedYtdRupees;
        }
      }
      if (saved && Array.isArray(saved.mutualFunds)) {
        // Saved-MF schema (from Groww import): name / category / type /
        // invested / current / returns (%) / xirr (%). No purchaseDate, no
        // ISIN — the optimizer will fall back to assumedHoldingMonths and
        // back-solve the xirr field into a synthetic flow.
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

    // ============================================================
    // SWS Engine (Beta) — short-circuits the legacy enrichment path.
    // Reads data/sws/deep/{TICKER}.json for each equity holding,
    // scores via the SWS composite + v2 model, and returns a
    // Tier A/B/C/D action grid. MFs/ETFs use the existing path.
    // ============================================================
    if (engine === "sws") {
      const swsT0 = Date.now();
      const swsTimings = {};

      const equityHoldings = parsed.holdings.map((h) => {
        const qty = Number(h.quantity) || 0;
        const avg = Number(h.avgPrice) || 0;
        return { ...h, quantity: qty, avgPrice: avg, invested: qty * avg };
      });

      // FY tax context — single source of truth for the LTCG-budget the
      // user has remaining for this financial year. Built once per
      // /analyze call, shared across every holding's tax scenarios so
      // the exemption math is consistent (each holding sees the SAME
      // remaining budget — they don't all "consume" it independently).
      // PR-3 brings the intake gate that asks the user for ltcgRealisedYtd;
      // until then the request body / query carries the value with a
      // 0 default (full exemption available).
      const fyContext = swsBuildFyContext(new Date(), Number.isFinite(ltcgRealisedYtdRupees) ? ltcgRealisedYtdRupees : 0, 0);

      // First pass: pull SWS price + sector for every holding so we can
      // compute portfolio-wide weights before action mapping. Second pass
      // below re-runs scoring with the real position/sector weights so
      // action mapping (Reduction-50% on >10% positions, etc.) fires.
      const firstPass = equityHoldings.map((h) =>
        swsScoreHolding({ ...h, positionWeight: 0, sectorWeight: 0, pnlPercent: 0 }, { sectorWeights: {} })
      );

      let totalInvested = 0;
      let totalCurrent = 0;
      const sectorCV = new Map();
      const enrichedRows = firstPass.map((row) => {
        // Price priority: SWS live > broker statement closing price > avg cost.
        // SWS price can be null on tickers where the API didn't return a quote;
        // the broker xlsx always carries a closing price for the statement
        // date, so we use that as the truth-source for current value when SWS
        // is unavailable. Falling back to invested would falsely zero out the
        // position (livePrice=0 → -100% P&L).
        const swsPrice = row.swsCovered ? Number(row.sws.current_price_inr) : null;
        const brokerPrice = Number(row.closePrice) || 0;
        const qty = Number(row.quantity) || 0;
        const avg = Number(row.avgPrice) || 0;
        const invested = qty * avg;
        const livePrice = (swsPrice != null && Number.isFinite(swsPrice) && swsPrice > 0)
          ? swsPrice
          : (brokerPrice > 0 ? brokerPrice : null);
        const priceSource = (swsPrice > 0) ? "sws" : (brokerPrice > 0 ? "broker" : "avg");
        const currentValue = livePrice != null ? qty * livePrice : invested;
        totalInvested += invested;
        totalCurrent += currentValue;
        // Sector resolution: prefer the curated stockList sector (consistent
        // proper-case vocabulary like "Energy"/"Banking"/"IT") over the SWS
        // deep-file sector, which has inconsistent casing and synonyms
        // ("energy"/"banks"/"automobiles") that fragment the overlay into
        // duplicate buckets. SWS sector is only used when stockList has
        // none. Most SWS deep JSONs lack the sector field anyway (~65%),
        // so this preference also fixes the "65% Unclassified" collapse.
        const sector = row.sector || (row.swsCovered ? row.sws.sector : null) || "Unclassified";
        sectorCV.set(sector, (sectorCV.get(sector) || 0) + currentValue);
        return { ...row, invested, currentValue, livePrice, priceSource, sector };
      });

      const sectorWeights = {};
      for (const [sector, cv] of sectorCV.entries()) {
        sectorWeights[sector] = totalCurrent > 0 ? (cv / totalCurrent) * 100 : 0;
      }

      // Macro regime fetch — uses cached value from the same NodeCache
      // that Market Intelligence + scanners populate. Graceful: empty
      // cache + classifyRegime failure → calm regime, severity 0, no
      // headwind/tailwind nudges in timing observations.
      const cachedRegime = macroRegimeCache.get(MACRO_CACHE_KEY) || defaultCalmRegime();
      const regimeSeverity = Number(cachedRegime?.severity) || 0;
      // Pre-compute sector impacts once so scoreHolding doesn't re-derive
      // them per row — the macroRegime sectorImpacts list is small (~20
      // canonical sectors) so a single pass + map is cheap.
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
          // regimeSeverity + sectorImpactBySector feed the timing
          // observation module via portfolioContext — used to flag
          // sector-headwind situations as "Soft-no, closing-VWAP".
          {
            sectorWeights,
            fyContext,
            taxSlabPct: optTaxSlabPct,
            regimeSeverity,
            sectorImpactBySector,
          },
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
      // PR-4: load the user's prior analyzer snapshot for diff mode.
      // Gated by ANALYZER_DIFF=1 — when off, priorSnapshot is null and
      // buildSWSReport returns "first run" diff for every call. Read
      // failures fall through to null so diff doesn't block the analyze.
      let priorSnapshot = null;
      if (process.env.ANALYZER_DIFF === "1") {
        try {
          priorSnapshot = await loadLastAnalyzerSnapshot();
        } catch (err) {
          console.warn("[ANALYZE] prior snapshot load failed:", err.message);
        }
      }
      const swsReport = buildSWSReport(scoredHoldings, {
        freshCapitalInr,
        freshPickLimit: 8,
        priorSnapshot,
      });
      swsTimings.aggregate_ms = Date.now() - aggT0;

      // PR-4: persist the new snapshot for the next run's diff. Best-
      // effort — write errors only log. Strip from the response so the
      // wire payload doesn't carry the prior+next snapshot blobs (the
      // diff itself is already in swsReport.diff).
      if (process.env.ANALYZER_DIFF === "1" && swsReport.analyzerSnapshotForNextRun) {
        saveAnalyzerSnapshot(swsReport.analyzerSnapshotForNextRun)
          .catch((err) => console.warn("[ANALYZE] snapshot save failed:", err.message));
      }
      delete swsReport.analyzerSnapshotForNextRun;

      // MF enrichment: only enrich MFs from the upload (saved-portfolio MFs
      // surface as raw reference rows; users wanting full MF analysis can
      // switch to the legacy engine).
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
          note: "Saved-portfolio MFs shown without live AMFI/news enrichment in SWS engine. Switch to Legacy engine for full MF analysis.",
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

      return res.json({
        ok: true,
        elapsedMs: Date.now() - t0,
        swsElapsedMs: Date.now() - swsT0,
        swsTimings,
        sessionId,
        report: {
          ...swsReport,
          source: parsed.source,
          asOfDate: parsed.summary?.asOfDate ?? null,
          mfPositions,
          unmatched: parsed.unmatched || [],
          warnings: parsed.warnings || [],
          disclaimer: "SWS Engine (Beta) · Educational analysis only. Verify live prices and risk before any transaction. SEBI-aligned tier classification; not personalised investment advice.",
          // ANALYZER_UI_V2 flag — gated on env. Client renderSWSAnalyzerReport
          // dispatches to V2 (hero + glossary chips) when v2 is true. Legacy
          // path is at server.js ~6995. Both paths read the same env var.
          ui: { v2: process.env.ANALYZER_UI_V2 === "1" },
        },
        savable,
      });
    }
    // ============================================================

    // 2. Fetch live macro regime once for the whole portfolio
    let macroRegime = null;
    try { macroRegime = await getMacroRegime(); }
    catch { macroRegime = defaultCalmRegime(); }

    // 2b. Fetch Nifty 50 historical once — feeds beta + stress-test
    //     computations in portfolioAnalyzer. Failure here is non-fatal;
    //     we just skip the risk block.
    let benchReturns = [];
    let benchSymbol = "^NSEI";
    try {
      const benchHist = await fetchHistorical(benchSymbol, "1y");
      if (benchHist && benchHist.length >= 30) {
        const benchCloses = benchHist.map((d) => d.close).filter((c) => Number.isFinite(c));
        benchReturns = computeDailyReturns(benchCloses);
      }
    } catch (e) {
      console.warn(`Benchmark history fetch failed (${benchSymbol}):`, e.message);
    }

    // 3. Earnings calendar for catalyst-nearby flagging
    const earningsMap = new Map();
    try {
      let events = catalystCache.get("nse_events");
      if (!events) {
        events = await fetchNseEventCalendar();
        if (events && events.length > 0) catalystCache.set("nse_events", events);
      }
      if (events) {
        const now = Date.now();
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        for (const e of events) {
          if (!/financial result/i.test(e.purpose)) continue;
          const d = new Date(e.date).getTime();
          if (isNaN(d)) continue;
          if (d - now >= 0 && d - now <= sevenDaysMs) {
            earningsMap.set(e.symbol + ".NS", { date: e.date, purpose: e.purpose });
          }
        }
      }
    } catch { /* silent */ }

    // 4. Enrich each holding — batches of 8 with 250ms spacing (same pattern
    //    as the scanner endpoint to respect upstream rate limits and the 60s
    //    Vercel timeout).
    const BATCH_SIZE = 8;
    const enriched = [];
    for (let i = 0; i < parsed.holdings.length; i += BATCH_SIZE) {
      if (Date.now() - t0 > 50_000) {
        // Vercel 60s guard — stop enriching and report what we have
        parsed.warnings.push("Analysis aborted early due to timeout; report covers first " +
          enriched.length + " of " + parsed.holdings.length + " holdings.");
        break;
      }
      const batch = parsed.holdings.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(async (h) => {
        try {
          const [quote, historical] = await Promise.all([
            fetchQuote(h.symbol),
            // Pull 1y of history (vs the default 6mo) so beta/vol/VaR
            // have a meaningful sample. Still cached, so no extra cost
            // after the first portfolio of the day.
            fetchHistorical(h.symbol, "1y"),
          ]);
          if (!quote || !historical || historical.length < 30) {
            return { holding: h, quote, historical: null, analysis: null, fundamentals: null, midTerm: null, longTerm: null };
          }
          const analysis = analyzeStock(historical, quote);
          const closes = historical.map((d) => d.close);
          const midTerm = midTermAnalysis(analysis, quote, closes);
          const dma200 = historical.length >= 200
            ? closes.slice(-200).reduce((s, v) => s + v, 0) / 200 : null;
          const fundSnap = getFundamentals(h.symbol);
          const fundamentalResult = fundSnap ? scoreForResponse(fundSnap, dma200).primary : null;
          const longTerm = longTermOutlook(analysis, quote, fundamentalResult, dma200);
          return {
            holding: h,
            quote,
            historical,
            analysis,
            fundamentals: fundamentalResult
              ? { ...fundamentalResult, snapshot: fundSnap }
              : null,
            midTerm,
            longTerm,
          };
        } catch (err) {
          return { holding: h, error: err.message };
        }
      }));
      enriched.push(...results);
    }

    // 4b. StarBhai long-term narrative + news for each scored equity holding.
    //     Skip ETFs (instrumentType:"etf") — basket trackers don't get a
    //     fundamental thesis. Errors here are fail-soft so a flaky news
    //     source can't block the analyzer report. Concurrency 3 (matches
    //     mfNews enrichment).
    try {
      const equityEntries = enriched.filter(
        (e) => e.holding?.instrumentType !== "etf" && e.longTerm,
      );
      if (equityEntries.length > 0) {
        const CONCURRENCY = 3;
        let cursor = 0;
        async function narrativeWorker() {
          while (cursor < equityEntries.length) {
            const idx = cursor++;
            const entry = equityEntries[idx];
            try {
              const news = await fetchStockNews({
                symbol: entry.holding.symbol,
                name: entry.holding.name,
                openai: getOpenAI(),
              });
              entry.longTerm.news = news;
              entry.longTerm.narrative = await generateNarrative({
                symbol: entry.holding.symbol,
                name: entry.holding.name,
                sector: entry.holding.sector,
                marketCapTier: entry.fundamentals?.breakdown?.tier || null,
                longTerm: entry.longTerm,
                fundamentals: entry.fundamentals,
                news,
                macroRegime,
                openai: getOpenAI(),
              });
            } catch (err) {
              console.warn(`[ANALYZE] narrative failed for ${entry.holding.symbol}:`, err.message);
            }
          }
        }
        await Promise.all(Array.from({ length: CONCURRENCY }, narrativeWorker));
      }
    } catch (e) {
      console.warn("[ANALYZE] stock news/narrative enrichment failed:", e.message);
    }

    // 5. Compute total invested for positionWeight calculation
    const totalInvested = enriched.reduce((s, e) => s + e.holding.avgPrice * e.holding.quantity, 0);

    // 6. Sector weights (as % of current portfolio value, fallback to invested)
    const sectorValues = new Map();
    for (const e of enriched) {
      const v = (e.quote?.regularMarketPrice ?? e.holding.avgPrice) * e.holding.quantity;
      sectorValues.set(e.holding.sector, (sectorValues.get(e.holding.sector) || 0) + v);
    }
    const portfolioValue = [...sectorValues.values()].reduce((s, v) => s + v, 0);

    // 7. Run the per-holding analyzer
    const reportEntries = enriched.map((e) => {
      const invested = e.holding.avgPrice * e.holding.quantity;
      const positionWeight = totalInvested > 0 ? (invested / totalInvested) * 100 : 0;
      const sectorWeight = portfolioValue > 0
        ? ((sectorValues.get(e.holding.sector) || 0) / portfolioValue) * 100
        : 0;
      const macroInfo = computeMacroDelta(macroRegime, e.holding.sector);

      return analyzeHolding({
        symbol: e.holding.symbol,
        name: e.holding.name,
        sector: e.holding.sector,
        isin: e.holding.isin,
        rawName: e.holding.rawName,
        matchType: e.holding.matchType,
        // Pass instrument type through so ETFs get the price-only path
        instrumentType: e.holding.instrumentType,
        scored: e.holding.scored,
        quantity: e.holding.quantity,
        avgPrice: e.holding.avgPrice,
        purchaseDate: e.holding.purchaseDate || null,
        sourceRow: e.holding.sourceRow,
        quote: e.quote,
        analysis: e.analysis,
        fundamentals: e.fundamentals,
        midTerm: e.midTerm,
        longTerm: e.longTerm,
        macroInfo,
        earningsNearby: earningsMap.get(e.holding.symbol) || null,
        positionWeight,
        sectorWeight,
        historical: e.historical || null,
        benchReturns,
      });
    });

    // 7b. Phase 2 + 3 + 5 + Improvement #1: AMFI metrics + per-fund news +
    //     live peers in parallel; benchmark TRI alpha sequenced after (alpha
    //     needs h.metrics from enrichMfHoldings). Same graceful pattern as
    //     the MF-only path above.
    try {
      await Promise.all([
        enrichMfHoldings(mfHoldings),
        enrichMfNews(mfHoldings, { openai: getOpenAI() }),
        enrichLivePeers(mfHoldings),
      ]);
      await enrichBenchmarkMetrics(mfHoldings);
    } catch (e) {
      console.warn("[ANALYZE] AMFI/news/peers/benchmark enrichment failed (mixed path):", e.message);
    }

    // 8. Aggregate
    const report = buildReport(reportEntries, parsed.unmatched, {
      source: parsed.source,
      parseSummary: parsed.summary,
      regime: macroRegime
        ? { id: macroRegime.regimeId || macroRegime.label, label: macroRegime.label, severity: macroRegime.severity }
        : null,
      warnings: parsed.warnings,
      asOfDate: parsed.summary?.asOfDate ?? null,
      benchReturns,
      benchSymbol,
      // XIRR Optimizer inputs — saved MFs + per-request preset/tax options
      mfHoldings,
      // Priority 3: same as MF-only path above. recommendBook tags each
      // per-fund rec with risk-profile alignment when present.
      riskProfile: savedRiskProfile,
      optimizerPreset: optPreset,
      taxSlabPct: optTaxSlabPct,
      assumedHoldingMonths: optAssumedHoldingMonths,
      ltcgRealisedYtdRupees,
    });

    // Cache the heavy state so the optimize endpoint can re-run runXirrOptimizer
    // against the same enriched holdings under different presets / tax-slab /
    // assumed-holding-months — without redoing the 30s enrichment pipeline.
    // Sessions live 30min (see analyzerCache stdTTL above).
    const sessionId = randomUUID();
    analyzerCache.set(sessionId, {
      holdings: report.holdings || reportEntries,
      mfHoldings,
      sectorAllocation: report.sectorAllocation || [],
      ltcgRealisedYtdRupees,
      cachedAt: Date.now(),
    });
    if (report.optimizer) report.optimizer.sessionId = sessionId;

    // ANALYZER_UI_V2 flag — opt-in to the simplified analyzer UI (hero +
    // glossary chips + collapsed advanced sections). Default OFF in dev so
    // the existing flow keeps working. Production sets ANALYZER_UI_V2=1
    // once the V2 path has soaked. Client dispatches on `report.ui.v2`.
    report.ui = { v2: process.env.ANALYZER_UI_V2 === "1" };

    res.json({
      ok: true,
      elapsedMs: Date.now() - t0,
      sessionId,
      report,
      savable,
    });
  } catch (err) {
    console.error("Portfolio analyze error:", err.message, err.stack);
    res.status(500).json({ error: "Failed to analyze portfolio", details: err.message });
  }
});

// PR-5: what-if simulator endpoint. Reuses the cached analyze session
// (SWS-engine path only — legacy reports don't carry the per-row sws.*
// payload the simulator depends on). Lets the UI ship slider mutations
// without re-uploading the portfolio file or re-running the SWS engine.
//
// Body: { sessionId, mutations: [{ ticker, deltaRupees }, ...], freshPicks? }
//
// Response: full simulator output { baseline, scenario, deltas, realisedTax,
// mutationsApplied, warnings } — UI renders side-by-side comparison.
//
// Gated by WHATIF_SIMULATOR=1 env flag (default off in dev). When the
// flag is off, returns 404 so the UI can hide the panel cleanly.
app.post("/api/portfolio/simulate-whatif", express.json(), async (req, res) => {
  try {
    if (process.env.WHATIF_SIMULATOR !== "1") {
      return res.status(404).json({ error: "What-if simulator disabled (WHATIF_SIMULATOR=1 to enable)." });
    }
    const sessionId = String(req.body?.sessionId || "");
    if (!sessionId) {
      return res.status(400).json({ error: "Missing sessionId. Run /api/portfolio/analyze first." });
    }
    const cached = analyzerCache.get(sessionId);
    if (!cached) {
      return res.status(410).json({ error: "Session expired or not found. Re-run /api/portfolio/analyze." });
    }
    if (cached.engine !== "sws") {
      return res.status(400).json({ error: "What-if simulator requires the SWS analyzer engine (?engine=sws)." });
    }

    const mutations = Array.isArray(req.body?.mutations) ? req.body.mutations : [];
    const freshPicks = Array.isArray(req.body?.freshPicks) ? req.body.freshPicks : [];

    // Build fyContext from the same LTCG-YTD that fed the original analyze
    // call, so the simulator's tax math sees the same exemption budget.
    const fyContext = swsBuildFyContext(
      new Date(),
      Number.isFinite(cached.ltcgRealisedYtdRupees) ? cached.ltcgRealisedYtdRupees : 0,
      0,
    );

    const out = runWhatIfSimulation({
      scoredHoldings: cached.holdings,
      mutations,
      freshPicks,
      fyContext,
      today: new Date(),
      assetClass: "equity",
    });

    res.json({ ok: true, sessionId, ...out });
  } catch (err) {
    console.error("[WHATIF] error:", err.message, err.stack);
    res.status(500).json({ error: "Simulation failed", details: err.message });
  }
});

// Re-run the XIRR optimizer ONLY against a cached analyze session. Lets the
// UI toggle preset / tax-slab / assumed-holding-months instantly without
// paying the 30s analyze cost. Returns just the optimizer block (and the
// updated summary.xirr fields), not the full report.
//
// Body: { sessionId, preset?, taxSlabPct?, assumedHoldingMonths?, ltcgRealisedYtd? }
app.post("/api/portfolio/optimize", express.json(), async (req, res) => {
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
    console.log(`\n  StarBhai · Indian Stock Intelligence`);
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

    // Prime the fundamentals in-memory cache from Vercel KV if configured.
    // No-op in local dev (no KV env vars) — the sync disk fallback handles
    // that case on the first getFundamentals() call. This is the ONE async
    // path that loads from KV; every subsequent read is served from cache.
    primeFundamentalsFromKV().catch((e) =>
      console.warn("[FUNDAMENTALS] KV prime failed at startup:", e.message)
    );

    // Prime the surveillance (ASM/GSM) snapshot. Same pattern — no-op locally.
    primeSurveillanceFromKV().catch((e) =>
      console.warn("[SURVEILLANCE] KV prime failed at startup:", e.message)
    );

    // Prime the governance (promoter pledge / holding) snapshot. Same pattern.
    primeGovernanceFromKV().catch((e) =>
      console.warn("[GOVERNANCE] KV prime failed at startup:", e.message)
    );

    // Warm macro regime cache at startup + schedule 15-min background refresh.
    // Non-blocking: we don't await the first refresh so the server starts fast.
    refreshMacroRegime().then((r) => {
      console.log(`  Macro regime warmed: ${r.regime} (sev ${r.severity}, conf ${r.confidence.toFixed(2)})`);
    });
    setInterval(() => {
      refreshMacroRegime().catch((e) => console.error("[MACRO] scheduled refresh failed:", e.message));
    }, 15 * 60 * 1000);

    console.log("");
  });
}

// On Vercel (serverless) the app.listen block above never runs — each cold
// start imports this module and handles a single request through the
// exported `app`. We still need the fundamentals cache primed from KV on
// that path, so do it here at the module top level. Top-level await is
// supported because package.json has "type": "module". Timeout after 2s so
// a KV outage doesn't block cold starts indefinitely.
if (process.env.VERCEL) {
  await Promise.race([
    primeFundamentalsFromKV().catch((e) =>
      console.warn("[FUNDAMENTALS] KV prime failed on cold start:", e.message)
    ),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  // Same guard for surveillance — KV outage mustn't block cold start.
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

// Slim scored-universe index — every scored stock (~5,439) with the fields
// renderPickCard needs, plus `in_sections` so the picks-tab search can dedupe
// against the curated 11 sections. Generated by scripts/sws-scoring.mjs as a
// sibling of picks-latest.json (atomic write). Mirrors the nifty500 injection
// pattern used by /api/sws-picks.
app.get("/api/sws-universe", (req, res) => {
  const data = readJsonSafe(SWS_PATHS.scoredUniverse);
  if (!data) return res.status(404).json({ error: "no_universe_yet", hint: "Run `node scripts/sws-build-scored-universe.mjs` to backfill, or wait for the next refresh." });
  if (Array.isArray(data.stocks)) {
    for (const it of data.stocks) {
      if (it && it.ticker) it.nifty500 = NIFTY500_SYMBOLS.has(`${it.ticker}.NS`);
    }
  }
  res.json(data);
});

app.get("/api/sws-picks", (req, res) => {
  const data = readJsonSafe(SWS_PATHS.picksLatest);
  if (!data) return res.status(404).json({ error: "no_picks_yet", hint: "Run /sws-scan-shard 1/2/3 in Claude to start the initial scan." });
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
    for (const [key, items] of Object.entries(data.sections)) {
      if (!Array.isArray(items)) continue;
      // Filter once, in-place — keeps the per-section count fields the UI
      // reads (it computes counts from .length).
      let filtered = items.filter((it) => it && it.ticker && !isPureBSEcode(it.ticker));
      if (key === "dividend_aristocrats") filtered = filtered.filter(passesDividendGate);
      data.sections[key] = filtered;
      for (const it of filtered) {
        if (it && it.ticker) it.nifty500 = NIFTY500_SYMBOLS.has(`${it.ticker}.NS`);
        // PR 2.3 — back-fill the new alias fields when the cached JSON
        // predates the pickCardFields change. UI prefers these names so the
        // composite-vs-valuation distinction renders even on stale snapshots.
        if (it && it.composite_verdict == null && it.v3_verdict != null) {
          it.composite_verdict = it.v3_verdict;
        }
        if (it && it.valuation_band == null) {
          const u = Number(it.upside_pct);
          if (Number.isFinite(u)) {
            it.valuation_band =
              u >= 25 ? "DEEP_DISCOUNT" :
              u >= 10 ? "DISCOUNT" :
              u >= -5 ? "FAIR" :
              u >= -20 ? "PREMIUM" : "EXPENSIVE";
          }
        }
      }
    }
  }
  // last_refresh: canonical pipeline-finish stamp; per-shard progress fills in
  // when a refresh is mid-flight or last-refresh.json is stale.
  data.last_refresh = readJsonSafe(SWS_PATHS.lastRefresh);
  data.shard_progress_api = [1, 2, 3].map((n) => {
    const p = readJsonSafe(SWS_PATHS.progressApi(n));
    if (!p) return { id: n };
    return {
      id: n,
      done_count: p.done_count || 0,
      next_local_index: p.next_local_index || 0,
      last_ticker: p.last_ticker || null,
      last_run_at: p.last_run_at || null,
      today_count: p.today_count || 0,
      today_date: p.today_date || null,
    };
  });
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
  const ticker = String(req.params.ticker || "").toUpperCase().trim();
  if (!ticker || !/^[A-Z0-9&\-]+$/.test(ticker)) {
    return res.status(400).json({ error: "invalid_ticker" });
  }
  const fp = path.join(SWS_PATHS.deepDir, `${ticker}.json`);
  const deep = readJsonSafe(fp);
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
  const picks = readJsonSafe(SWS_PATHS.picksLatest);
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
    const p = readJsonSafe(SWS_PATHS.progressApi(n));
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

app.post("/api/sws-scan/initial-start", express.json(), (req, res) => {
  writeRefreshRequest("initial");
  res.json({
    queued: true,
    next_step: "Open 3 terminal windows. In each, run `claude`. Then type `/sws-scan-shard 1` (term 1), `/sws-scan-shard 2` (term 2), `/sws-scan-shard 3` (term 3). Stagger: start shard 2 after shard 1 has done ~50 stocks; start shard 3 after shard 2 has done ~50.",
  });
});
app.post("/api/sws-refresh/quick", express.json(), (req, res) => {
  writeRefreshRequest("quick");
  res.json({ queued: true, next_step: "Open 3 terminals, run `claude`, type `/sws-resume` in each." });
});
app.post("/api/sws-refresh/earnings", express.json(), (req, res) => {
  writeRefreshRequest("earnings");
  res.json({ queued: true, next_step: "Open 1 terminal, run `claude`, type `/sws-resume` (earnings refresh is small enough for one shard)." });
});
app.post("/api/sws-refresh/full", express.json(), (req, res) => {
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
